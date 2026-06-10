// src/store.js — JSON ledger: sizing, recording, mark-to-market, scorecard
// State lives in data/state.json and is committed to the repo after each run.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { config } from './config.js';

// ── Position sizing ───────────────────────────────────────────────────
// Floor(accountSize × riskPct% ÷ |entry − stop|)
// This ensures you never risk more than riskPct% of account on one idea.
export function sizePosition(
  entry,
  stop,
  accountSize = config.accountSize,
  riskPct     = config.riskPct,
) {
  const riskPerShare = Math.abs(entry - stop);
  if (riskPerShare <= 0) return 0;
  const riskAmount = accountSize * (riskPct / 100);
  return Math.floor(riskAmount / riskPerShare);
}

// ── Mark-to-market ────────────────────────────────────────────────────
// Determines outcome from the day's OHLC using "same-day-close assumption":
//   - If open gaps through stop  → fill at open (worst case)
//   - If intraday touches stop   → fill at stop
//   - If intraday touches target → fill at target
//   - Otherwise                 → fill at close (idea expires)
//
// Returns enhanced idea object with status='resolved', outcome, exitPrice, pnl, r.
export function markToMarket(idea, ohlc) {
  if (!ohlc) return { ...idea, status: 'pending' };

  const { entry, stop, target, side, shares } = idea;
  const { open, high, low, close, date } = ohlc;

  let exitPrice = null;
  let outcome   = null;

  if (side === 'long') {
    if (open !== null && open <= stop) {
      exitPrice = open;    // gap below stop — fill at open
      outcome   = 'stopped_gap';
    } else if (low !== null && low <= stop) {
      exitPrice = stop;
      outcome   = 'stopped';
    } else if (high !== null && high >= target) {
      exitPrice = target;
      outcome   = 'target';
    } else {
      exitPrice = close;
      outcome   = 'expired_at_close';
    }
  } else {
    // short
    if (open !== null && open >= stop) {
      exitPrice = open;    // gap above stop
      outcome   = 'stopped_gap';
    } else if (high !== null && high >= stop) {
      exitPrice = stop;
      outcome   = 'stopped';
    } else if (low !== null && low <= target) {
      exitPrice = target;
      outcome   = 'target';
    } else {
      exitPrice = close;
      outcome   = 'expired_at_close';
    }
  }

  const direction  = side === 'long' ? 1 : -1;
  const pnlPerShare = direction * (exitPrice - entry);
  const shareCount  = shares ?? sizePosition(entry, stop);
  const pnl         = parseFloat((pnlPerShare * shareCount).toFixed(2));
  const riskAmount  = config.accountSize * (config.riskPct / 100);
  const r           = riskAmount > 0 ? parseFloat((pnl / riskAmount).toFixed(2)) : 0;

  return {
    ...idea,
    shares:      shareCount,
    status:      'resolved',
    outcome,
    exitPrice:   parseFloat(exitPrice?.toFixed(4) ?? 0),
    pnl,
    r,
    resolvedDate: date,
    resolvedAt:   new Date().toISOString(),
  };
}

// ── State I/O ─────────────────────────────────────────────────────────
export function loadState() {
  const filePath = resolve(config.stateFile);
  if (!existsSync(filePath)) {
    return {
      ideas:        [],
      scan_history: [],
      scorecard:    null,
      today:        null,
      meta: {
        created:   new Date().toISOString(),
        version:   1,
        disclaimer: 'NOT financial advice. Delayed/unofficial data. Confirm in your broker.',
      },
    };
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('[store] Corrupt state.json, starting fresh:', err.message);
    return { ideas: [], scan_history: [], scorecard: null, today: null };
  }
}

export function saveState(state) {
  const filePath = resolve(config.stateFile);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2));
  console.log(`[store] state.json saved (${state.ideas.length} ideas total)`);
}

// ── Record today's scan ───────────────────────────────────────────────
// Idempotent: re-running scan on the same day replaces that day's ideas.
export function recordScan(state, analysisResult) {
  const today = new Date().toISOString().slice(0, 10);

  const newIdeas = analysisResult.ideas.map(idea => {
    const shares     = sizePosition(idea.entry, idea.stop);
    const riskAmount = parseFloat((config.accountSize * config.riskPct / 100).toFixed(2));
    return {
      id:          `${today}-${idea.ticker}-${idea.side}`,
      date:        today,
      status:      'pending',
      ...idea,
      shares,
      riskAmount,
      recordedAt:  new Date().toISOString(),
    };
  });

  // Remove prior pending ideas for today (idempotent re-run)
  state.ideas = state.ideas.filter(i => !(i.date === today && i.status === 'pending'));
  state.ideas.push(...newIdeas);

  state.scan_history = state.scan_history || [];
  state.scan_history.push({
    date:           today,
    provider:       analysisResult.provider,
    market_context: analysisResult.market_context,
    no_trade_reason: analysisResult.no_trade_reason,
    idea_count:     newIdeas.length,
    recordedAt:     new Date().toISOString(),
  });

  return state;
}

// ── Scorecard ─────────────────────────────────────────────────────────
// Computes summary stats from all resolved ideas.
// This is the source of truth for paper performance — shown honestly.
export function computeScorecard(ideas) {
  const resolved = ideas.filter(i => i.status === 'resolved');
  if (resolved.length === 0) {
    return {
      count: 0, wins: 0, losses: 0, winRate: null,
      avgR: null, totalPnl: 0, maxDrawdown: 0,
      byOutcome: {},
    };
  }

  const wins   = resolved.filter(i => i.r > 0).length;
  const losses = resolved.filter(i => i.r < 0).length;
  const even   = resolved.length - wins - losses;

  const winRate = parseFloat((wins / resolved.length).toFixed(3));
  const avgR    = parseFloat((resolved.reduce((s, i) => s + (i.r || 0), 0) / resolved.length).toFixed(2));
  const totalPnl = parseFloat(resolved.reduce((s, i) => s + (i.pnl || 0), 0).toFixed(2));

  // By-outcome breakdown
  const byOutcome = {};
  for (const idea of resolved) {
    byOutcome[idea.outcome] = (byOutcome[idea.outcome] || 0) + 1;
  }

  // Max drawdown (on chronological running P&L)
  let peak = 0, runningPnl = 0, maxDrawdown = 0;
  const sortedResolved = [...resolved].sort(
    (a, b) => (a.resolvedDate || '').localeCompare(b.resolvedDate || '')
  );
  for (const idea of sortedResolved) {
    runningPnl += idea.pnl || 0;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Last 10 resolved (for dashboard recent-trades panel)
  const recent = sortedResolved.slice(-10).reverse();

  return {
    count:       resolved.length,
    wins,
    losses,
    even,
    winRate,
    avgR,
    totalPnl,
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    byOutcome,
    recent,
    asOf:        new Date().toISOString(),
  };
}
