// tests/math.test.js — unit tests for sizing and mark-to-market math
// Run: npm test
//
// Uses Node's built-in test runner (no extra deps required).
// node --test tests/math.test.js

import { test } from 'node:test';
import assert   from 'node:assert/strict';

// ── Import the functions under test ───────────────────────────────────
// We import directly; config defaults apply (no .env needed).
import { sizePosition, markToMarket } from '../src/store.js';

// ── sizePosition tests ────────────────────────────────────────────────

test('sizePosition: standard long setup', () => {
  // Account £10k, 1% risk = £100 risk. |entry-stop| = £2. Shares = floor(100/2) = 50
  const shares = sizePosition(102, 100, 10_000, 1);
  assert.equal(shares, 50);
});

test('sizePosition: tight stop = more shares (correct risk scaling)', () => {
  // |entry-stop| = £0.50. Shares = floor(100/0.50) = 200
  const shares = sizePosition(10.50, 10.00, 10_000, 1);
  assert.equal(shares, 200);
});

test('sizePosition: wider stop = fewer shares', () => {
  // |entry-stop| = £5. Shares = floor(100/5) = 20
  const shares = sizePosition(50, 45, 10_000, 1);
  assert.equal(shares, 20);
});

test('sizePosition: zero risk (entry = stop) returns 0', () => {
  const shares = sizePosition(100, 100, 10_000, 1);
  assert.equal(shares, 0);
});

test('sizePosition: short position (stop above entry)', () => {
  // entry=50, stop=55 → |entry-stop|=5 → floor(100/5)=20
  const shares = sizePosition(50, 55, 10_000, 1);
  assert.equal(shares, 20);
});

test('sizePosition: higher risk% = more shares', () => {
  const at1pct = sizePosition(100, 98, 10_000, 1);   // floor(100/2)=50
  const at2pct = sizePosition(100, 98, 10_000, 2);   // floor(200/2)=100
  assert.equal(at2pct, at1pct * 2);
});

test('sizePosition: floors (does not round up)', () => {
  // risk=£100, riskPerShare=£3 → 33.33 → floor = 33
  const shares = sizePosition(103, 100, 10_000, 1);
  assert.equal(shares, 33);
});

// ── markToMarket tests ────────────────────────────────────────────────

const baseLong = {
  ticker: 'TEST',
  id:     'test-001',
  date:   '2025-01-15',
  side:   'long',
  entry:  100,
  stop:   95,
  target: 112,
  shares: 20,
  riskAmount: 100,
  status: 'pending',
};

const baseShort = {
  ...baseLong,
  id:     'test-002',
  side:   'short',
  entry:  100,
  stop:   106,
  target: 88,
};

test('markToMarket: long hits target', () => {
  const ohlc = { date: '2025-01-15', open: 101, high: 115, low: 99, close: 113 };
  const res  = markToMarket(baseLong, ohlc);
  assert.equal(res.status,    'resolved');
  assert.equal(res.outcome,   'target');
  assert.equal(res.exitPrice, 112);
  assert.ok(res.pnl > 0, 'P&L should be positive on target hit');
  assert.ok(res.r > 0,   'R should be positive');
});

test('markToMarket: long stopped out intraday', () => {
  const ohlc = { date: '2025-01-15', open: 101, high: 104, low: 94, close: 96 };
  const res  = markToMarket(baseLong, ohlc);
  assert.equal(res.status,    'resolved');
  assert.equal(res.outcome,   'stopped');
  assert.equal(res.exitPrice, 95);
  assert.ok(res.pnl < 0, 'P&L should be negative on stop');
  assert.ok(res.r < 0,   'R should be negative');
});

test('markToMarket: long gap below stop → fill at open', () => {
  const ohlc = { date: '2025-01-15', open: 93, high: 95, low: 90, close: 91 };
  const res  = markToMarket(baseLong, ohlc);
  assert.equal(res.outcome,   'stopped_gap');
  assert.equal(res.exitPrice, 93);   // gap fill at open (worse than stop)
  assert.ok(res.pnl < 0);
});

test('markToMarket: long expires at close (no stop or target hit)', () => {
  const ohlc = { date: '2025-01-15', open: 100, high: 108, low: 97, close: 106 };
  const res  = markToMarket(baseLong, ohlc);
  assert.equal(res.outcome,   'expired_at_close');
  assert.equal(res.exitPrice, 106);
  assert.ok(res.pnl > 0, 'Expired above entry still shows paper gain');
});

test('markToMarket: short hits target', () => {
  const ohlc = { date: '2025-01-15', open: 99, high: 102, low: 86, close: 88 };
  const res  = markToMarket(baseShort, ohlc);
  assert.equal(res.outcome,   'target');
  assert.equal(res.exitPrice, 88);
  assert.ok(res.pnl > 0);
});

test('markToMarket: short stopped out', () => {
  const ohlc = { date: '2025-01-15', open: 99, high: 107, low: 97, close: 103 };
  const res  = markToMarket(baseShort, ohlc);
  assert.equal(res.outcome,   'stopped');
  assert.equal(res.exitPrice, 106);
  assert.ok(res.pnl < 0);
});

test('markToMarket: short gap above stop → fill at open', () => {
  const ohlc = { date: '2025-01-15', open: 110, high: 112, low: 108, close: 109 };
  const res  = markToMarket(baseShort, ohlc);
  assert.equal(res.outcome,   'stopped_gap');
  assert.equal(res.exitPrice, 110);
  assert.ok(res.pnl < 0);
});

test('markToMarket: null ohlc → status stays pending', () => {
  const res = markToMarket(baseLong, null);
  assert.equal(res.status, 'pending');
});

// ── R calculation sanity ──────────────────────────────────────────────

test('R calculation: stop hit should be approximately -1R', () => {
  // entry=100, stop=95 → riskPerShare=5. shares=20. riskAmount=100.
  // P&L on stop = (95-100)×20 = -100. R = -100/100 = -1.
  const ohlc = { date: '2025-01-15', open: 101, high: 104, low: 94, close: 96 };
  const res  = markToMarket(baseLong, ohlc);
  assert.ok(Math.abs(res.r - (-1)) < 0.01, `Expected R≈-1, got ${res.r}`);
});

test('R calculation: target hit should be approximately +2.4R', () => {
  // entry=100, stop=95, target=112. riskPerShare=5. reward=12. shares=20.
  // P&L = (112-100)×20 = 240. R = 240/100 = 2.4.
  const ohlc = { date: '2025-01-15', open: 101, high: 115, low: 99, close: 113 };
  const res  = markToMarket(baseLong, ohlc);
  assert.ok(Math.abs(res.r - 2.4) < 0.05, `Expected R≈2.4, got ${res.r}`);
});
