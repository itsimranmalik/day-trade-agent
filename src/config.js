// src/config.js — all configuration from environment variables
// Load .env in development; GitHub Actions injects secrets directly.
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadDotenv() {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return;
  const lines = readFileSync(p, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotenv();

function reqEnv(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Required env var ${key} is not set`);
  return v;
}

export const config = {
  // ── LLM ──────────────────────────────────────────────────────────────
  // Primary: Gemini Flash (free, no card, ~1500 req/day)
  // Fallback: Groq Llama 3.3 (free, no card, ~1000 req/day)
  llmProvider:  process.env.LLM_PROVIDER  || 'gemini',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel:  process.env.GEMINI_MODEL   || 'gemini-2.0-flash',
  groqApiKey:   process.env.GROQ_API_KEY   || '',
  groqModel:    process.env.GROQ_MODEL     || 'llama-3.3-70b-versatile',

  // ── Account ───────────────────────────────────────────────────────────
  accountSize: parseFloat(process.env.ACCOUNT_SIZE || '10000'),   // £
  riskPct:     parseFloat(process.env.RISK_PCT     || '1'),        // % per trade
  maxIdeas:    parseInt(  process.env.MAX_IDEAS    || '2'),

  // ── Universe ──────────────────────────────────────────────────────────
  // UK tickers use .L suffix; India use .NS; US are plain.
  watchlist: (process.env.WATCHLIST ||
    // US large-caps
    'AAPL,TSLA,NVDA,SPY,QQQ,AMZN,MSFT,META,AMD,JPM,GS,BA,' +
    // UK (LSE)
    'BP.L,HSBA.L,AZN.L,GLEN.L,SHEL.L,VOD.L,LLOY.L,BARC.L,RIO.L,ULVR.L,' +
    // India (NSE)
    'RELIANCE.NS,TCS.NS,INFY.NS,HDFCBANK.NS,ICICIBANK.NS,WIPRO.NS,SBIN.NS,HINDUNILVR.NS,ITC.NS,BHARTIARTL.NS'
  ).split(',').map(s => s.trim()).filter(Boolean),

  universeSize: parseInt(process.env.UNIVERSE_SIZE || '30'),
  newsCount:    parseInt(process.env.NEWS_COUNT    || '3'),
  reqDelayMs:   parseInt(process.env.REQ_DELAY_MS  || '1200'),   // ~50 req/min floor
  maxRetries:   parseInt(process.env.MAX_RETRIES   || '3'),

  // ── Telegram (optional) ───────────────────────────────────────────────
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId:   process.env.TELEGRAM_CHAT_ID   || '',

  // ── Storage ───────────────────────────────────────────────────────────
  stateFile: process.env.STATE_FILE || './data/state.json',
};
