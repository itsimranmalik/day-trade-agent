#!/usr/bin/env node
// scripts/scan.js — pre-market scan entrypoint
// Usage: node scripts/scan.js  |  npm run scan

import '../src/config.js';   // loads .env side-effect
import { buildUniverse }           from '../src/data.js';
import { analyse }                  from '../src/analyst.js';
import { loadState, saveState, recordScan, computeScorecard } from '../src/store.js';
import { sendTelegram, formatScanMessage } from '../src/notify.js';

async function main() {
  const startMs = Date.now();
  console.log(`\n[scan] ═══════ Pre-market scan ${new Date().toISOString()} ═══════`);

  // 1. Build trading universe
  const universe = await buildUniverse();
  const quoted = Object.keys(universe.quotes).length;
  console.log(`[scan] Universe built: ${quoted} quotes, ${Object.keys(universe.news).length} tickers with news`);

  if (quoted === 0) {
    console.warn('[scan] No quotes received — market may be closed or data is unavailable. Exiting.');
    process.exit(0);
  }

  // 2. LLM analysis
  const analysis = await analyse(universe);
  console.log(`[scan] Provider: ${analysis.provider} | Ideas: ${analysis.ideas.length} | No-trade: ${!!analysis.no_trade_reason}`);

  // 3. Record in ledger
  const state = loadState();
  recordScan(state, analysis);

  const today = new Date().toISOString().slice(0, 10);
  const todayIdeas = state.ideas.filter(i => i.date === today);
  const scorecard  = computeScorecard(state.ideas);

  state.scorecard = scorecard;
  state.today = {
    date:           today,
    market_context: analysis.market_context,
    no_trade_reason: analysis.no_trade_reason,
    ideas:          todayIdeas,
    provider:       analysis.provider,
    scannedAt:      new Date().toISOString(),
  };
  state.meta = {
    ...(state.meta || {}),
    lastScan:    new Date().toISOString(),
    disclaimer:  'NOT financial advice. Delayed/unofficial data. Confirm in your broker. Paper trading only.',
  };

  saveState(state);

  // 4. Telegram (no-op if tokens not set)
  const message = formatScanMessage(analysis, todayIdeas, scorecard);
  await sendTelegram(message);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[scan] Done in ${elapsed}s. Ideas recorded: ${todayIdeas.length}`);
  if (analysis.no_trade_reason) console.log(`[scan] No-trade reason: ${analysis.no_trade_reason}`);
}

main().catch(err => {
  console.error('[scan] Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
