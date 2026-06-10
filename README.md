# Day-Trade Research Agent

> **NOT financial advice.** This tool generates paper research ideas from public, delayed market data using a free LLM. It never places real orders. The scorecard shows honest paper results — use those results to decide whether the logic is worth trusting before risking any real money.

A fully serverless, £0/month research agent that runs on GitHub Actions, publishes a dashboard to GitHub Pages, and optionally sends daily updates to Telegram.

---

## 10-Minute Setup

### 1. Fork / clone this repo

```bash
git clone https://github.com/YOUR_USERNAME/day-trade-agent.git
cd day-trade-agent
```

### 2. Get your free API keys

| Key | Where | Cost | Limit (free tier) |
|-----|-------|------|-------------------|
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | £0, no card | 15 RPM · 1,500 RPD |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | £0, no card | 30 RPM · 1,000 RPD |

You only need **one** key. Groq auto-activates as fallback if Gemini fails.

### 3. Add GitHub Secrets & Variables

In your repo → **Settings → Secrets and variables → Actions**:

**Secrets** (sensitive, never logged):
| Name | Value |
|------|-------|
| `GEMINI_API_KEY` | your Gemini key |
| `GROQ_API_KEY` | your Groq key (optional) |
| `TELEGRAM_BOT_TOKEN` | optional — see `.env.example` |
| `TELEGRAM_CHAT_ID` | optional |

**Variables** (non-sensitive configuration — set under *Variables* tab):
| Name | Default | Notes |
|------|---------|-------|
| `ACCOUNT_SIZE` | `10000` | Paper account size in £ |
| `RISK_PCT` | `1` | % of account risked per trade |
| `MAX_IDEAS` | `2` | Max ideas per scan |
| `WATCHLIST` | *(built-in)* | Comma-separated tickers; blank = default UK+US+India list |
| `UNIVERSE_SIZE` | `30` | Max tickers analysed |
| `LLM_PROVIDER` | `gemini` | `gemini` or `groq` |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Check [AI Studio](https://aistudio.google.com) for current model strings |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Check [console.groq.com/docs/models](https://console.groq.com/docs/models) |

### 4. Enable GitHub Pages

Repo → **Settings → Pages → Source: Deploy from branch → Branch: main, Folder: /docs** → Save.

Your dashboard will be live at `https://YOUR_USERNAME.github.io/day-trade-agent/`.

### 5. Trigger a manual test run

Repo → **Actions → Pre-market Scan → Run workflow** → watch the logs.  
Then **Actions → Evening Score → Run workflow** to score it.

Check your Pages URL — you should see today's ideas and scorecard.

### 6. Local development

```bash
cp .env.example .env
# Fill in GEMINI_API_KEY (and optionally GROQ_API_KEY)
npm run scan      # runs pre-market scan
npm run score     # runs evening scoring
npm run backtest  # runs rule-based historical backtest
npm test          # runs unit tests for math
```

---

## Free-Tier Limits

| Resource | Free allowance | Agent usage per day | Headroom |
|----------|---------------|---------------------|---------|
| Gemini 2.0 Flash | 1,500 req/day | 1 req (scan) | 99.9% |
| Groq Llama 3.3 70B | 1,000 req/day | 1 req (fallback only) | 99.9% |
| Yahoo Finance | Unmetered* | ~50–80 req/day | Large |
| GitHub Actions | 2,000 min/month | ~5 min/day × 22 days = 110 min | 94% |
| GitHub Pages | 1 GB bandwidth | Negligible | Large |

\* Yahoo Finance is a public endpoint, not an API. Paced at ≈50 req/min to avoid blocks. If you add many tickers, the delay accumulates — `REQ_DELAY_MS` is a safety floor, not a speed dial.

---

## Three Honest Constraints

**1. Public page.** Your GitHub Pages dashboard is publicly accessible. It contains paper research, not personal financial data, but be aware anyone can view the URL. If you want privacy, set the repo to Private — Pages still works.

**2. UTC scheduling is approximate.** GitHub Actions cron is UTC and can run up to 15 minutes late under load. The scan runs at 08:00 UTC (pre-market UK, pre-pre-market US). If you want US pre-market specifically, change the cron to `25 13 * * 1-5` (13:25 UTC = 09:25 ET). Market holidays are not detected — the agent will run but may receive thin/stale data; the LLM will typically output "no trade" in that case.

**3. Unofficial, delayed data.** Yahoo Finance data is not real-time and is not guaranteed accurate. Prices, volumes, and headlines may be delayed or incorrect. **Always confirm any idea against your broker's live feed before considering any action.** This tool is for learning and idea generation, not execution.

---

## How to Read the Scorecard Honestly

The scorecard is the only thing that matters. Here is how to read it:

- **Win rate alone is meaningless.** A system that wins 30% of the time but has avg R of +2.5 makes money. One that wins 70% with avg R of -1.5 blows up. Look at **avg R first**, win rate second.

- **Sample size is everything.** Fewer than 30 resolved trades is noise, not signal. Do not draw any conclusions from a 10-trade scorecard.

- **The "expired at close" outcome is important.** If most trades expire without hitting stop or target, your stop/target levels are too wide for intraday. This is data — act on it.

- **Max drawdown is your stress test.** If the max drawdown exceeds your real-money risk tolerance, the system isn't ready for live money regardless of win rate.

- **A losing scorecard is the most valuable output.** If the ledger shows losses after 30+ trades, you have learned — for free, on paper — that this approach doesn't have edge. That is exactly what this tool is for.

---

## Architecture

```
GitHub Actions (cron)
  │
  ├─ scan.yml (08:00 UTC Mon–Fri)
  │   ├─ buildUniverse()     ← Yahoo Finance: quotes, movers, headlines
  │   ├─ analyse()           ← Gemini Flash → Groq fallback
  │   ├─ recordScan()        ← sizes positions, writes state.json
  │   └─ sendTelegram()      ← optional notification
  │
  └─ score.yml (21:30 UTC Mon–Fri)
      ├─ fetchOHLCV()        ← Yahoo Finance: day's OHLC
      ├─ markToMarket()      ← stop/target/close logic
      ├─ computeScorecard()  ← win rate, avg R, drawdown
      └─ sendTelegram()      ← optional notification

data/state.json  ← source of truth, committed to repo
docs/state.json  ← copy served by GitHub Pages
docs/index.html  ← static dashboard (no server needed)
```

## Backtest

```bash
npm run backtest
# Optional flags:
node scripts/backtest.js --days 90 --tickers AAPL,TSLA,NVDA --cost 10
```

The backtest uses **rule-based heuristics** (gap + volume surge) that approximate the analyst's selection criteria. It does not replay LLM calls (that would burn ~90 API calls and take 30 minutes). The rules:

- Gap ≥ 1.5% on open vs. prior close
- Relative volume ≥ 1.3× 20-day average
- Entry: slightly above/below open, stop at prior-day structure ± ATR buffer
- Target: 2:1 R:R minimum

Output: win rate, avg R, max drawdown, before/after cost P&L, per-ticker breakdown, and an `data/backtest.json` file.

**What the backtest tells you:** whether the mechanical signal generation has a statistical tendency. What it cannot tell you: whether the LLM's qualitative judgment adds or removes edge. Only the live paper ledger can answer that — which is why `data/state.json` is the actual source of truth.

---

## File Reference

| File | Purpose |
|------|---------|
| `src/config.js` | All config from env vars; loads `.env` in dev |
| `src/data.js` | Yahoo Finance data layer — **swap this file to change data source** |
| `src/analyst.js` | LLM calls (Gemini + Groq fallback) + JSON validation |
| `src/store.js` | Position sizing, mark-to-market, ledger I/O, scorecard |
| `src/notify.js` | Telegram notifications |
| `scripts/scan.js` | Pre-market entrypoint |
| `scripts/score.js` | Evening scoring entrypoint |
| `scripts/backtest.js` | Historical rule-based backtest |
| `tests/math.test.js` | Unit tests for sizing + MTM math |
| `docs/index.html` | GitHub Pages dashboard |
| `data/state.json` | Live paper ledger |
| `.github/workflows/scan.yml` | Pre-market Action |
| `.github/workflows/score.yml` | Evening scoring Action |

---

*NOT financial advice. Delayed/unofficial data. Confirm in your broker. Paper trading only.*
