// src/notify.js — Telegram notification (optional)
// If TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set, all calls are no-ops.

import { config } from './config.js';

export async function sendTelegram(message) {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:                  config.telegramChatId,
        text:                     message,
        parse_mode:               'Markdown',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[notify] Telegram error ${res.status}: ${body.slice(0, 200)}`);
    } else {
      console.log('[notify] Telegram message sent');
    }
  } catch (err) {
    console.warn(`[notify] Telegram failed: ${err.message}`);
  }
}

// ── Format helpers ────────────────────────────────────────────────────

export function formatScanMessage(analysisResult, todayIdeas, scorecard) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `📊 *Day-Trade Research — ${date}*`,
    `_⚠️ NOT financial advice · Delayed/unofficial data · Confirm in your broker_\n`,
    `*Market Context:* ${analysisResult.market_context}`,
  ];

  if (analysisResult.no_trade_reason || todayIdeas.length === 0) {
    lines.push(`\n🚫 *No Trade Today*`);
    lines.push(analysisResult.no_trade_reason || 'No qualifying setups found.');
  } else {
    for (const idea of todayIdeas) {
      const dir  = idea.side === 'long' ? '🟢 LONG' : '🔴 SHORT';
      const conf = `${(idea.confidence * 100).toFixed(0)}%`;
      lines.push(`\n${dir} *${idea.ticker}* | Confidence: ${conf} | R:R ${idea.rr}:1`);
      lines.push(`Entry: \`${idea.entry}\` | Stop: \`${idea.stop}\` | Target: \`${idea.target}\``);
      lines.push(`Shares: ${idea.shares} | Risk: £${idea.riskAmount}`);
      lines.push(`📌 *Catalyst:* ${idea.catalyst}`);
      lines.push(`📖 *Thesis:* ${idea.thesis}`);
      lines.push(`❌ *Invalidation:* ${idea.invalidation}`);
    }
  }

  if (scorecard && scorecard.count > 0) {
    const wr = scorecard.winRate != null ? `${(scorecard.winRate * 100).toFixed(1)}%` : 'N/A';
    lines.push(
      `\n📈 *Running Scorecard* (${scorecard.count} resolved)\n` +
      `Win rate: ${wr} | Avg R: ${scorecard.avgR ?? 'N/A'} | P&L: £${scorecard.totalPnl}`
    );
  }

  return lines.join('\n');
}

export function formatScoreMessage(resolvedToday, scorecard) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `📈 *Evening Score — ${date}*`,
    `_Paper results only · NOT financial advice_\n`,
  ];

  if (resolvedToday.length === 0) {
    lines.push('No ideas to score today (none were recorded, or market was closed).');
  } else {
    for (const idea of resolvedToday) {
      const emoji = idea.r > 0 ? '✅' : idea.r < 0 ? '❌' : '➖';
      const rStr  = idea.r > 0 ? `+${idea.r}R` : `${idea.r}R`;
      const pStr  = idea.pnl >= 0 ? `+£${idea.pnl}` : `-£${Math.abs(idea.pnl)}`;
      lines.push(`${emoji} *${idea.ticker}* (${idea.side}) → _${idea.outcome}_`);
      lines.push(`Exit: \`${idea.exitPrice}\` | ${rStr} | ${pStr}`);
    }
  }

  const wr = scorecard.winRate != null ? `${(scorecard.winRate * 100).toFixed(1)}%` : 'N/A';
  lines.push(
    `\n*Overall Scorecard* (${scorecard.count} resolved)\n` +
    `Win rate: ${wr} | Avg R: ${scorecard.avgR ?? 'N/A'}\n` +
    `Total P&L: £${scorecard.totalPnl} | Max Drawdown: £${scorecard.maxDrawdown}`
  );

  return lines.join('\n');
}
