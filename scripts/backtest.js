#!/usr/bin/env node
// scripts/backtest.js — rule-based historical backtest
// ─────────────────────────────────────────────────────────────────────
// Fetches 90 days of OHLCV for the watchlist, then replays each trading
// day using rule-based heuristics that approximate what a disciplined
// analyst would flag (gap + volume surge setups).
//
// Why rule-based and not LLM replay?
//   • LLM replay over 90 days × 30 tickers would burn ~90 API calls and
//     take 30+ minutes. Rule-based runs in ~2 minutes.
//   • The rules encode the same selection criteria the analyst uses:
//     gap-with-volume, relative strength, minimum R:R.
//   • Results are reproducible and not dependent on LLM randomness.
//
// Usage:  node scripts/backtest.js [--days 60] [--tickers AAPL,TSLA,...]
// Output: summary to stdout + data/backtest.json

import '../src/config.js';
import { fetchOHLCV }       from '../src/data.js';
import { sizePosition, markToMarket } from '../src/store.js';
import { config }           from '../src/config.js';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve }          from 'path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CLI flags ─────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const DAYS  = parseInt(args[args.indexOf('--days')  + 1] || '90');
const COST  = parseFloat(args[args.indexOf('--cost') + 1] || '10');   // £ round-trip
const TICKERS = args.includes('--tickers')
  ? args[args.indexOf('--tickers') + 1].split(',').map(s => s.trim())
  : config.watchlist.slice(0, 20);   // cap at 20 for speed

// ── Technical helpers ─────────────────────────────────────────────────
function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function atr(ohlcArr, n = 5) {
  const trs = ohlcArr.slice(-n).map(d =>
    Math.max(d.high - d.low, Math.abs(d.high - (d.close ?? d.high)), Math.abs(d.low - (d.close ?? d.low)))
  );
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ── Setup selection rules ─────────────────────────────────────────────
// Returns { side, entry, stop, target, confidence, catalyst } or null.
function selectSetup(current, history) {
  if (history.length < 10) return null;

  const prev    = history[history.length - 1];   // prior session
  const prevVol = history.slice(-20).map(d => d.volume).filter(Boolean);
  const avgVol  = prevVol.length ? prevVol.reduce((a, b) => a + b, 0) / prevVol.length : null;
  const relVol  = avgVol && current.volume ? current.volume / avgVol : null;
  const atrVal  = atr(history, 5);

  if (!prev.close || !current.open || !atrVal) return null;

  const gap    = (current.open - prev.close) / prev.close;   // fractional
  const gapAbs = Math.abs(gap);

  // Minimum thresholds
  if (gapAbs < 0.015) return null;        // gap must be at least 1.5%
  if (relVol && relVol < 1.3) return null; // volume must be elevated

  // Determine side
  const side = gap > 0 ? 'long' : 'short';

  // Price levels
  let entry, stop, target;
  const buffer = atrVal * 0.1;

  if (side === 'long') {
    entry  = parseFloat((current.open + buffer).toFixed(4));      // slightly above open
    stop   = parseFloat((Math.min(current.low, prev.close - atrVal * 0.5)).toFixed(4));
    target = parseFloat((entry + 2.0 * (entry - stop)).toFixed(4)); // 2:1 R:R
  } else {
    entry  = parseFloat((current.open - buffer).toFixed(4));
    stop   = parseFloat((Math.max(current.high, prev.close + atrVal * 0.5)).toFixed(4));
    target = parseFloat((entry - 2.0 * (stop - entry)).toFixed(4)); // 2:1 R:R
  }

  // Sanity: stop must be on right side
  if (side === 'long'  && !(stop < entry && entry < target)) return null;
  if (side === 'short' && !(target < entry && entry < stop))  return null;

  const risk   = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr     = risk > 0 ? reward / risk : 0;
  if (rr < 1.5) return null;

  // Confidence: calibrated to signal strength, capped at 0.65
  const conf = Math.min(0.65,
    0.35
    + (gapAbs > 0.03 ? 0.10 : 0.05)
    + (relVol && relVol > 2 ? 0.10 : relVol && relVol > 1.5 ? 0.05 : 0)
  );

  return {
    side,
    entry,
    stop,
    target,
    rr: parseFloat(rr.toFixed(2)),
    confidence: parseFloat(conf.toFixed(2)),
    catalyst: `${side === 'long' ? 'Gap up' : 'Gap down'} ${(gap * 100).toFixed(1)}% with relative volume ${relVol?.toFixed(1) ?? '?'}x`,
  };
}

// ── Main backtest loop ────────────────────────────────────────────────
async function main() {
  console.log(`\n[backtest] ═══ Backtest over ${DAYS} days, ${TICKERS.length} tickers, £${COST} cost/trade ═══\n`);

  const allIdeas = [];
  let   fetchErrors = 0;

  for (const ticker of TICKERS) {
    process.stdout.write(`[backtest] Fetching ${ticker}...`);
    let ohlcAll;
    try {
      ohlcAll = await fetchOHLCV(ticker, DAYS + 30);   // extra buffer for lookback
    } catch (err) {
      console.log(` ✗ (${err.message})`);
      fetchErrors++;
      await sleep(config.reqDelayMs);
      continue;
    }
    console.log(` ✓ ${ohlcAll.length} days`);

    if (ohlcAll.length < 15) {
      await sleep(config.reqDelayMs);
      continue;
    }

    // Replay each day (need at least 10 history bars)
    for (let i = 10; i < ohlcAll.length - 1; i++) {
      const history = ohlcAll.slice(0, i);      // everything up to (not including) today
      const current = ohlcAll[i];               // today's bar (the one we'd trade)

      const setup = selectSetup(current, history);
      if (!setup) continue;

      const shares     = sizePosition(setup.entry, setup.stop, config.accountSize, config.riskPct);
      if (shares <= 0) continue;

      const riskAmount = config.accountSize * config.riskPct / 100;

      // Score: mark to market against today's OHLC
      const idea = {
        id:         `${current.date}-${ticker}-${setup.side}`,
        ticker,
        date:       current.date,
        status:     'pending',
        ...setup,
        shares,
        riskAmount: parseFloat(riskAmount.toFixed(2)),
      };

      const resolved = markToMarket(idea, current);

      // Apply round-trip cost
      const afterCost = parseFloat((resolved.pnl - COST).toFixed(2));
      const rAfterCost = riskAmount > 0 ? parseFloat(((afterCost) / riskAmount).toFixed(2)) : 0;

      allIdeas.push({
        ...resolved,
        pnlBeforeCost: resolved.pnl,
        pnl:           afterCost,
        r:             rAfterCost,
      });
    }

    await sleep(config.reqDelayMs);
  }

  if (allIdeas.length === 0) {
    console.log('\n[backtest] No setups found. Check your tickers/thresholds.');
    process.exit(0);
  }

  // ── Metrics ───────────────────────────────────────────────────────
  const resolved  = allIdeas.filter(i => i.status === 'resolved');
  const wins      = resolved.filter(i => i.r > 0);
  const losses    = resolved.filter(i => i.r < 0);
  const winRate   = wins.length / resolved.length;
  const avgR      = resolved.reduce((s, i) => s + i.r, 0) / resolved.length;
  const totalPnl  = resolved.reduce((s, i) => s + i.pnl, 0);
  const totalPnlBefore = resolved.reduce((s, i) => s + (i.pnlBeforeCost || 0), 0);

  // Max drawdown on running P&L
  const sorted    = [...resolved].sort((a, b) => a.date.localeCompare(b.date));
  let peak = 0, running = 0, maxDD = 0;
  const equityCurve = [0];
  for (const idea of sorted) {
    running += idea.pnl;
    equityCurve.push(parseFloat(running.toFixed(2)));
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }

  // By-outcome breakdown
  const byOutcome = {};
  for (const i of resolved) byOutcome[i.outcome] = (byOutcome[i.outcome] || 0) + 1;

  // Per-ticker summary
  const byTicker = {};
  for (const i of resolved) {
    if (!byTicker[i.ticker]) byTicker[i.ticker] = { count: 0, wins: 0, pnl: 0 };
    byTicker[i.ticker].count++;
    if (i.r > 0) byTicker[i.ticker].wins++;
    byTicker[i.ticker].pnl += i.pnl;
  }

  // ── Print report ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  BACKTEST SUMMARY (after £10 round-trip cost per trade)');
  console.log('═'.repeat(60));
  console.log(`  Period:          last ${DAYS} days`);
  console.log(`  Tickers:         ${TICKERS.length} (${fetchErrors} fetch errors)`);
  console.log(`  Total setups:    ${resolved.length}`);
  console.log(`  Win rate:        ${(winRate * 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Avg R:           ${avgR.toFixed(2)}R`);
  console.log(`  Total P&L:       £${totalPnl.toFixed(2)}  (before costs: £${totalPnlBefore.toFixed(2)})`);
  console.log(`  Max drawdown:    £${maxDD.toFixed(2)}`);
  console.log(`  Cost drag:       £${(totalPnlBefore - totalPnl).toFixed(2)} (${resolved.length} × £${COST})`);
  console.log('');
  console.log('  By outcome:');
  for (const [k, v] of Object.entries(byOutcome)) {
    console.log(`    ${k.padEnd(20)} ${v}`);
  }
  console.log('');

  // ── Honest interpretation ─────────────────────────────────────────
  console.log('  ─── HONEST INTERPRETATION ───────────────────────────');
  if (winRate < 0.40) {
    console.log('  ⚠  Win rate below 40%. The gap+volume rule alone shows no edge here.');
    console.log('     Do NOT use this in live trading. Investigate conditions that work.');
  } else if (avgR < 0.1) {
    console.log('  ⚠  Win rate is acceptable but avg R is near zero.');
    console.log('     Costs dominate. A larger account or different cost structure is needed.');
  } else if (winRate >= 0.40 && avgR >= 0.2) {
    console.log('  ✓  Results look plausible, but this is a rule-based approximation.');
    console.log('     The live agent uses LLM judgment which may filter better or worse.');
    console.log('     Wait for 30+ live paper trades before drawing any conclusions.');
  }
  console.log('');
  console.log('  ⚠  All results are on PAPER, use delayed data, and assume fills');
  console.log('     at exact stop/target prices — reality will be worse.');
  console.log('  ⚠  Past performance of a backtest tells you very little about');
  console.log('     future live performance. The ledger IS the source of truth.');
  console.log('═'.repeat(60) + '\n');

  // ── Save to data/backtest.json ────────────────────────────────────
  const output = {
    generatedAt:   new Date().toISOString(),
    params:        { days: DAYS, tickers: TICKERS, costPerTrade: COST },
    summary: {
      totalSetups: resolved.length,
      wins:        wins.length,
      losses:      losses.length,
      winRate:     parseFloat(winRate.toFixed(3)),
      avgR:        parseFloat(avgR.toFixed(2)),
      totalPnl:    parseFloat(totalPnl.toFixed(2)),
      totalPnlBeforeCosts: parseFloat(totalPnlBefore.toFixed(2)),
      maxDrawdown: parseFloat(maxDD.toFixed(2)),
      byOutcome,
    },
    byTicker: Object.fromEntries(
      Object.entries(byTicker)
        .sort((a, b) => b[1].pnl - a[1].pnl)
        .map(([t, v]) => [t, {
          ...v,
          winRate: parseFloat((v.wins / v.count).toFixed(2)),
          pnl:     parseFloat(v.pnl.toFixed(2)),
        }])
    ),
    equityCurve,
    ideas: resolved.slice(-100),   // last 100 for debugging
    disclaimer: 'NOT financial advice. Paper backtest only. Delayed/unofficial data.',
  };

  mkdirSync(resolve('./data'), { recursive: true });
  writeFileSync(resolve('./data/backtest.json'), JSON.stringify(output, null, 2));
  console.log('[backtest] Results saved to data/backtest.json');
}

main().catch(err => {
  console.error('[backtest] Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
