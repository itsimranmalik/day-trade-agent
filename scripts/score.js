#!/usr/bin/env node
// scripts/score.js — evening mark-to-market scoring entrypoint
// Usage: node scripts/score.js  |  npm run score

import '../src/config.js';
import { fetchOHLCV }                 from '../src/data.js';
import { loadState, saveState, markToMarket, computeScorecard } from '../src/store.js';
import { sendTelegram, formatScoreMessage } from '../src/notify.js';
import { config } from '../src/config.js';

async function main() {
  const startMs = Date.now();
  console.log(`\n[score] ═══════ Evening scoring ${new Date().toISOString()} ═══════`);

  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);

  // Find pending ideas that should be scored today
  const toScore = state.ideas.filter(i => i.status === 'pending' && i.date <= today);
  console.log(`[score] Ideas to score: ${toScore.length}`);

  if (toScore.length === 0) {
    console.log('[score] Nothing to score. Exiting.');
    process.exit(0);
  }

  const resolvedToday = [];

  for (const idea of toScore) {
    try {
      const ohlcData = await fetchOHLCV(idea.ticker, 10);
      if (!ohlcData.length) {
        console.warn(`[score] No OHLC returned for ${idea.ticker}`);
        continue;
      }

      // Find the matching date or the latest available
      const targetDate = idea.date;
      const ohlc = ohlcData.find(d => d.date === targetDate) || ohlcData[ohlcData.length - 1];

      if (!ohlc) {
        console.warn(`[score] No OHLC for ${idea.ticker} on ${targetDate}`);
        continue;
      }

      const resolved = markToMarket(idea, ohlc);
      const idx = state.ideas.findIndex(i => i.id === idea.id);
      if (idx >= 0) state.ideas[idx] = resolved;

      if (resolved.status === 'resolved') {
        resolvedToday.push(resolved);
        const rStr = resolved.r >= 0 ? `+${resolved.r}R` : `${resolved.r}R`;
        console.log(`[score] ${idea.ticker} (${idea.side}): ${resolved.outcome} | exit=${resolved.exitPrice} | ${rStr} | £${resolved.pnl}`);
      }
    } catch (err) {
      console.warn(`[score] Error scoring ${idea.ticker}: ${err.message}`);
    }
  }

  // Recompute scorecard
  const scorecard = computeScorecard(state.ideas);
  state.scorecard  = scorecard;
  state.meta = {
    ...(state.meta || {}),
    lastScore:   new Date().toISOString(),
    disclaimer:  'NOT financial advice. Delayed/unofficial data. Paper trading only.',
  };
  saveState(state);

  // Telegram
  await sendTelegram(formatScoreMessage(resolvedToday, scorecard));

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[score] Done in ${elapsed}s. Resolved: ${resolvedToday.length}.`);
  console.log('[score] Scorecard:', JSON.stringify(scorecard, null, 2));
}

main().catch(err => {
  console.error('[score] Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
