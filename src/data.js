// src/data.js — Yahoo Finance data layer (keyless, paced, retried)
// ─────────────────────────────────────────────────────────────────────
// SWAP POINT: replace fetchWithRetry targets here to use Finnhub/Twelve Data.
// Everything above buildUniverse() is pure infrastructure; nothing else changes.

import { config } from './config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Yahoo session (crumb + cookies for authenticated endpoints) ────────
let _crumb = null;
let _cookieHeader = '';

async function ensureYahooSession() {
  if (_crumb) return;
  try {
    // Step 1: get cookies from finance.yahoo.com
    const r1 = await fetch('https://finance.yahoo.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    // Collect Set-Cookie headers
    const raw = r1.headers.getSetCookie?.() ?? [];
    _cookieHeader = raw.map(c => c.split(';')[0]).join('; ');

    // Step 2: get crumb
    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Cookie: _cookieHeader,
      },
      signal: AbortSignal.timeout(8000),
    });
    _crumb = (await r2.text()).trim();
    console.log('[data] Yahoo session established');
  } catch (err) {
    console.warn(`[data] Yahoo session init failed (continuing without crumb): ${err.message}`);
    _crumb = '';
  }
}

// ── Core fetch with exponential backoff ──────────────────────────────
async function fetchWithRetry(url, opts = {}, retries = config.maxRetries, baseDelay = 600) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    Accept: 'application/json,text/plain,*/*',
    ...(_cookieHeader ? { Cookie: _cookieHeader } : {}),
    ...(opts.headers || {}),
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers,
        signal: AbortSignal.timeout(12000),
      });

      if (res.status === 429 || res.status >= 500) {
        const wait = baseDelay * Math.pow(2, attempt) + Math.random() * 300;
        console.warn(`[data] HTTP ${res.status} on attempt ${attempt + 1}, retrying in ${wait.toFixed(0)}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = baseDelay * Math.pow(2, attempt) + Math.random() * 200;
      console.warn(`[data] Fetch error (${err.message}), retry ${attempt + 1} in ${wait.toFixed(0)}ms`);
      await sleep(wait);
    }
  }
}

// ── OHLCV history for a single ticker ────────────────────────────────
// Returns array of { date, open, high, low, close, adjclose, volume }
export async function fetchOHLCV(ticker, days = 5) {
  await ensureYahooSession();
  const crumbParam = _crumb ? `&crumb=${encodeURIComponent(_crumb)}` : '';
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=1d&range=${days}d${crumbParam}`;

  let data;
  try {
    data = await fetchWithRetry(url);
  } catch (err) {
    // Fallback: try query2 without crumb
    const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${days}d`;
    data = await fetchWithRetry(url2);
  }

  const result = data?.chart?.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || q.close || [];
  const meta = result.meta || {};

  return timestamps
    .map((ts, i) => ({
      date:     new Date(ts * 1000).toISOString().slice(0, 10),
      open:     q.open?.[i]  ?? null,
      high:     q.high?.[i]  ?? null,
      low:      q.low?.[i]   ?? null,
      close:    q.close?.[i] ?? null,
      adjclose: adj[i]       ?? null,
      volume:   q.volume?.[i] ?? null,
      currency: meta.currency,
    }))
    .filter(d => d.close != null);
}

// ── Per-ticker quote via chart endpoint ───────────────────────────────
// The v7/finance/quote bulk endpoint returns 401 from datacenter IPs (GitHub Actions).
// The v8/finance/chart endpoint works reliably without auth — we use 30d range
// so we can compute avg volume from history ourselves.
export async function fetchQuotes(tickers) {
  await ensureYahooSession();
  const results = {};

  for (const ticker of tickers) {
    try {
      const crumbParam = _crumb ? `&crumb=${encodeURIComponent(_crumb)}` : '';
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
        `?interval=1d&range=30d${crumbParam}`;

      let data;
      try {
        data = await fetchWithRetry(url);
      } catch {
        // fallback: query2, no crumb
        data = await fetchWithRetry(
          `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=30d`
        );
      }

      const result = data?.chart?.result?.[0];
      if (!result) continue;

      const meta       = result.meta || {};
      const q          = result.indicators?.quote?.[0] || {};
      const timestamps = result.timestamp || [];
      if (!timestamps.length) continue;

      const lastIdx    = timestamps.length - 1;
      const prevIdx    = lastIdx - 1;

      const currentPrice = meta.regularMarketPrice ?? q.close?.[lastIdx];
      const prevClose    = meta.chartPreviousClose  ?? meta.previousClose ?? q.close?.[prevIdx];
      const changeAmt    = (prevClose && currentPrice) ? currentPrice - prevClose : 0;
      const changePct    = (prevClose && prevClose !== 0) ? (changeAmt / prevClose) * 100 : 0;

      // Average daily volume from prior bars (exclude today's partial bar)
      const historicVols = (q.volume || []).slice(0, lastIdx).filter(v => v != null && v > 0);
      const avgVol = historicVols.length
        ? Math.round(historicVols.reduce((a, b) => a + b, 0) / historicVols.length)
        : null;

      results[ticker] = {
        symbol:                      ticker,
        shortName:                   meta.shortName || meta.longName || ticker,
        currency:                    meta.currency  || '',
        regularMarketPrice:          currentPrice,
        regularMarketChange:         parseFloat(changeAmt.toFixed(4)),
        regularMarketChangePercent:  parseFloat(changePct.toFixed(4)),
        regularMarketVolume:         q.volume?.[lastIdx] ?? meta.regularMarketVolume ?? null,
        averageDailyVolume3Month:    avgVol,
        regularMarketDayHigh:        q.high?.[lastIdx]   ?? meta.regularMarketDayHigh  ?? null,
        regularMarketDayLow:         q.low?.[lastIdx]    ?? meta.regularMarketDayLow   ?? null,
        regularMarketPreviousClose:  prevClose            ?? null,
        regularMarketOpen:           q.open?.[lastIdx]   ?? meta.regularMarketOpen     ?? null,
        fiftyTwoWeekHigh:            meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow:             meta.fiftyTwoWeekLow  ?? null,
        marketCap:                   meta.marketCap        ?? null,
      };
    } catch (err) {
      console.warn(`[data] Quote failed for ${ticker}: ${err.message}`);
    }
    await sleep(config.reqDelayMs);
  }

  return results;
}

// ── Pre-defined screener movers ───────────────────────────────────────
export async function fetchMovers() {
  await ensureYahooSession();
  const screeners = ['day_gainers', 'most_actives', 'day_losers'];
  const tickers = new Set();

  for (const scrId of screeners) {
    try {
      const url =
        `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved` +
        `?scrIds=${scrId}&count=10&region=US&lang=en-US`;
      const data = await fetchWithRetry(url);
      const quotes = data?.finance?.result?.[0]?.quotes || [];
      quotes.forEach(q => q.symbol && tickers.add(q.symbol));
      await sleep(config.reqDelayMs);
    } catch (err) {
      console.warn(`[data] Screener ${scrId} failed: ${err.message}`);
    }
  }
  return [...tickers];
}

// ── News headlines for a ticker (Yahoo RSS, no key) ───────────────────
export async function fetchHeadlines(ticker, count = config.newsCount) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/rss+xml,text/xml' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    // Extract CDATA titles, skip the feed-level title
    const titles = [...text.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)]
      .map(m => m[1].trim())
      .filter(t => !t.toLowerCase().includes('yahoo finance'))
      .slice(0, count);
    return titles;
  } catch {
    return [];
  }
}

// ── Build the full trading universe ───────────────────────────────────
// Merges watchlist + movers, dedupes, caps, fetches quotes + selective news.
export async function buildUniverse() {
  console.log('[data] Building trading universe...');

  // Start with watchlist, then append movers (graceful degradation)
  let candidates = [...config.watchlist];
  try {
    const movers = await fetchMovers();
    const before = candidates.length;
    candidates = [...new Set([...candidates, ...movers])];
    console.log(`[data] Added ${candidates.length - before} movers to universe`);
  } catch (err) {
    console.warn(`[data] Movers unavailable, running off watchlist only: ${err.message}`);
  }

  candidates = candidates.slice(0, config.universeSize);
  console.log(`[data] Universe capped at ${candidates.length} tickers`);

  // Bulk real-time quotes
  const quotes = await fetchQuotes(candidates);
  const quoted = Object.keys(quotes).length;
  console.log(`[data] Quotes received: ${quoted}/${candidates.length}`);

  // Headlines only for top 5 movers (by absolute % change) — saves requests
  const topMovers = Object.values(quotes)
    .sort((a, b) => Math.abs(b.regularMarketChangePercent || 0) - Math.abs(a.regularMarketChangePercent || 0))
    .slice(0, 5);

  const news = {};
  for (const q of topMovers) {
    news[q.symbol] = await fetchHeadlines(q.symbol);
    await sleep(config.reqDelayMs);
  }

  return { quotes, news, tickers: candidates };
}
