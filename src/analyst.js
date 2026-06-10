// src/analyst.js — LLM reasoning layer
// Primary: Gemini Flash (free tier). Auto-fallback to Groq on error/rate-limit.

import { config } from './config.js';

// ── System prompt encodes all non-negotiable principles ───────────────
const SYSTEM_PROMPT = `You are a disciplined, quantitative day-trade research analyst covering US, UK (LSE), and Indian (NSE) equity markets. Your role is to identify 0–${/* injected at call time */'N'} high-quality intraday setups each day from the provided market snapshot.

NON-NEGOTIABLE PRINCIPLES — violating any of these invalidates your output:

1. RESEARCH TOOL, NOT A SIGNAL SERVICE. Never say a price "will" move. Every claim is probabilistic. Frame theses as "if X then Y", not "X will do Y."
2. NO LIVE ORDERS. This analysis is for paper trading and research only. Never imply anyone should place a real trade.
3. EVERY IDEA HAS A STOP. Entry, stop, and target are all required. Stop placement must be technically justified (prior structure, ATR, key level).
4. "NO TRADE" IS VALID AND COMMON. If conditions are choppy, unclear, or no setup meets your criteria, return an empty ideas array. Do not manufacture setups to fill a quota.
5. CALIBRATED CONFIDENCE. Most sound setups score 0.40–0.60. Reserve 0.65+ only for unusually confluent setups. Never exceed 0.75. If you feel very confident, that is usually a sign of overconfidence — reconsider.
6. MINIMUM REWARD:RISK IS 1.5:1. Reject any setup where |target − entry| / |entry − stop| < 1.5.
7. CURRENCY AWARENESS. UK tickers (e.g., BP.L) are priced in pence (GBX) not pounds. Indian tickers (.NS) are in INR. US tickers are in USD. State currency in the thesis.

OUTPUT FORMAT — respond with ONLY valid JSON, no markdown, no code fences, no commentary:
{
  "market_context": "2–3 sentence overview of today's overall conditions across the markets in the universe",
  "no_trade_reason": "string explaining why you are not proposing ideas, or null if you have ideas",
  "ideas": [
    {
      "ticker": "string (exact Yahoo symbol)",
      "side": "long | short",
      "entry": number,
      "stop": number,
      "target": number,
      "confidence": number (0.00–0.75),
      "catalyst": "string: specific event or data driving the move",
      "thesis": "string: 2–3 sentences — setup type, key level, what needs to happen",
      "invalidation": "string: specific price action that proves this thesis wrong"
    }
  ]
}

VALIDATION RULES (enforce yourself before responding):
- long:  stop < entry < target, (target − entry) / (entry − stop) ≥ 1.5
- short: target < entry < stop, (entry − target) / (stop − entry) ≥ 1.5
- ideas array length ≤ MAX_IDEAS (will be injected into the user prompt)
- This output is NOT financial advice. Data is delayed and unofficial.`;

// ── Gemini call ───────────────────────────────────────────────────────
async function callGemini(prompt) {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY not set');
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent` +
    `?key=${config.geminiApiKey}`;

  const body = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT.replace('N', config.maxIdeas) }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:       0.25,
      maxOutputTokens:   2048,
      responseMimeType:  'application/json',
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });

  if (res.status === 429) throw new Error('Gemini rate-limited (429)');
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty content');
  return text;
}

// ── Groq call ────────────────────────────────────────────────────────
async function callGroq(prompt) {
  if (!config.groqApiKey) throw new Error('GROQ_API_KEY not set');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.groqApiKey}`,
    },
    body: JSON.stringify({
      model: config.groqModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT.replace('N', config.maxIdeas) },
        { role: 'user',   content: prompt },
      ],
      temperature:     0.25,
      max_tokens:      2048,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (res.status === 429) throw new Error('Groq rate-limited (429)');
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned empty content');
  return text;
}

// ── Parse and validate LLM JSON ──────────────────────────────────────
function parseAnalysis(raw, provider) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to extract JSON block from messy response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${provider} returned non-JSON: ${raw.slice(0, 300)}`);
    parsed = JSON.parse(match[0]);
  }

  const ideas = (parsed.ideas || [])
    .slice(0, config.maxIdeas)
    .map(idea => {
      const { entry, stop, target, side } = idea;
      const risk   = Math.abs(entry - stop);
      const reward = Math.abs(target - entry);
      const rr     = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;
      return { ...idea, rr };
    })
    .filter(idea => {
      if (!idea.ticker || !idea.entry || !idea.stop || !idea.target) {
        console.warn(`[analyst] Dropped incomplete idea: ${idea.ticker}`);
        return false;
      }
      if (idea.rr < 1.5) {
        console.warn(`[analyst] Dropped low R:R idea ${idea.ticker}: ${idea.rr}`);
        return false;
      }
      if (idea.side === 'long'  && !(idea.stop < idea.entry && idea.entry < idea.target)) {
        console.warn(`[analyst] Dropped long with bad price order: ${idea.ticker}`);
        return false;
      }
      if (idea.side === 'short' && !(idea.target < idea.entry && idea.entry < idea.stop)) {
        console.warn(`[analyst] Dropped short with bad price order: ${idea.ticker}`);
        return false;
      }
      return true;
    });

  return {
    market_context:  parsed.market_context  || '',
    no_trade_reason: ideas.length === 0
      ? (parsed.no_trade_reason || 'No qualifying setups found after validation')
      : null,
    ideas,
    provider,
  };
}

// ── Main analyse entry point ─────────────────────────────────────────
export async function analyse(universe) {
  const { quotes, news } = universe;

  // Build the market snapshot prompt
  const lines = Object.values(quotes).map(q => {
    const pct = (q.regularMarketChangePercent || 0).toFixed(2);
    const sign = parseFloat(pct) >= 0 ? '+' : '';
    const vol    = q.regularMarketVolume          ? `vol=${(q.regularMarketVolume / 1e6).toFixed(1)}M`           : '';
    const avgvol = q.averageDailyVolume3Month      ? `avg_vol=${(q.averageDailyVolume3Month / 1e6).toFixed(1)}M` : '';
    const relVol = (q.regularMarketVolume && q.averageDailyVolume3Month)
      ? `rel_vol=${(q.regularMarketVolume / q.averageDailyVolume3Month).toFixed(1)}x`
      : '';
    const cap = q.marketCap ? `mktcap=${(q.marketCap / 1e9).toFixed(1)}B` : '';
    const range52 = (q.fiftyTwoWeekLow && q.fiftyTwoWeekHigh)
      ? `52wk=${q.fiftyTwoWeekLow?.toFixed(2)}-${q.fiftyTwoWeekHigh?.toFixed(2)}`
      : '';

    const headlines = (news[q.symbol] || []).slice(0, 2).map(h => `    • ${h}`).join('\n');
    return [
      `${q.symbol} (${q.shortName || ''}) [${q.currency || '?'}]`,
      `  price=${q.regularMarketPrice?.toFixed(2)} chg=${sign}${pct}% ${vol} ${avgvol} ${relVol} ${cap}`,
      `  day=${q.regularMarketDayLow?.toFixed(2)}-${q.regularMarketDayHigh?.toFixed(2)}  prev_close=${q.regularMarketPreviousClose?.toFixed(2)}  open=${q.regularMarketOpen?.toFixed(2)}  ${range52}`,
      headlines ? `  news:\n${headlines}` : '',
    ].filter(Boolean).join('\n');
  });

  const prompt =
    `Date: ${new Date().toISOString().slice(0, 10)}\n` +
    `MAX_IDEAS: ${config.maxIdeas}\n` +
    `Account: £${config.accountSize}, risk per trade: ${config.riskPct}%\n\n` +
    `MARKET UNIVERSE — ${lines.length} instruments:\n\n` +
    lines.join('\n\n') +
    `\n\nAnalyse and return your JSON research output. Remember: no-trade is the right call more often than not.`;

  // Try primary → auto-fallback
  let raw = '';
  let provider = '';
  let lastError = null;

  if (config.llmProvider !== 'groq' && config.geminiApiKey) {
    try {
      raw = await callGemini(prompt);
      provider = 'gemini';
    } catch (err) {
      lastError = err;
      console.warn(`[analyst] Gemini failed (${err.message}), falling back to Groq...`);
    }
  }

  if (!raw && config.groqApiKey) {
    try {
      raw = await callGroq(prompt);
      provider = 'groq';
    } catch (err) {
      lastError = err;
    }
  }

  if (!raw) {
    const hint = !config.geminiApiKey && !config.groqApiKey
      ? 'Set GEMINI_API_KEY or GROQ_API_KEY in your .env'
      : `Last error: ${lastError?.message}`;
    throw new Error(`All LLM providers failed. ${hint}`);
  }

  console.log(`[analyst] Response received from ${provider}`);
  return parseAnalysis(raw, provider);
}
