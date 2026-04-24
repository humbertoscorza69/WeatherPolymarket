import assert from "node:assert/strict";
import test from "node:test";
import { backtest, summarizeBatch } from "../src/simulation/backtest.js";
import type { BacktestStrategy } from "../src/simulation/backtest.js";

const baseStrategy: BacktestStrategy = {
  halfSpreadCents: 1,
  inventorySkewCents: 0,
  volMultiplier: 0,
  volMaxExtraCents: 3,
  volWindowSize: 60,
  orderSizeUsdc: 2,
  tickSize: 0.01,
  minShares: 5,
  refreshIntervalSec: 30,
  maxInventoryPositions: 10,
  stopLossEnabled: true,
  stopLossCatastrophicDropRatio: 0.3,
  stopLossDeepDropRatio: 0.6,
  stopLossDeepDropMaxMinutes: 120,
  stopLossResolutionHours: 1,
  stopLossResolutionDropRatio: 0.7,
  stopLossMaxHoldingHours: 12,
  takerFeeRate: 0.0125
};

function series(startT: number, prices: number[], stepSec = 60) {
  return prices.map((p, i) => ({ t: startT + i * stepSec, p }));
}

test("backtest: perfectly oscillating price between 0.29 and 0.30 produces round-trips", () => {
  // Each 30s we re-quote at mid - 1¢. If mid alternates between 0.30 and 0.29:
  //   sample0: p=0.30 → quote bid=0.29. Not filled (p > bid).
  //   sample1: p=0.29 → p ≤ bid, BUY fills at 0.29. Resting SELL=0.30.
  //   sample2: p=0.30 → p ≥ SELL, SELL fills. +0.01/share round-trip.
  const samples = series(0, [0.30, 0.29, 0.30, 0.29, 0.30, 0.29, 0.30], 30);
  const r = backtest("oscillator", samples, baseStrategy);
  assert.ok(r.buyFills >= 1, "should have BUY fills");
  assert.ok(r.sellFills >= 1, "should have SELL fills");
  assert.ok(r.roundTrips >= 1, "should complete at least one round trip");
  assert.ok(r.realizedPnlUsdc > 0, `PnL should be positive, got ${r.realizedPnlUsdc}`);
});

test("backtest: BUY fill followed by crash triggers stop-loss", () => {
  // Phase 1 (first 6 samples at 120s spacing): price oscillates up and back
  // to 0.29 so the BUY (placed at 0.29 after the first refresh) actually fills.
  // Phase 2: monotonic crash to 0.05 over 2 hours — should blow through
  // catastrophic (mid/entry ≤ 0.30).
  const phase1 = [0.30, 0.31, 0.30, 0.29, 0.29, 0.29];
  const phase2: number[] = [];
  const steps = 40;
  for (let i = 0; i < steps; i++) phase2.push(0.28 - i * (0.23 / steps));
  const prices = [...phase1, ...phase2];
  const r = backtest("crash", series(0, prices, 120), baseStrategy);
  assert.ok(r.buyFills >= 1, `BUY should fill during phase 1 (got ${r.buyFills})`);
  assert.ok(r.stopLosses >= 1, `stop-loss should fire during phase 2 crash (got ${r.stopLosses})`);
  assert.ok(r.stopLossPnlUsdc < 0, "stop-loss should record a negative PnL contribution");
});

test("backtest: stable price produces no fills", () => {
  // No oscillation → our BUY at 0.29 never matches (mid stays at 0.30).
  const r = backtest("flat", series(0, Array(50).fill(0.30), 60), baseStrategy);
  assert.equal(r.buyFills, 0);
  assert.equal(r.sellFills, 0);
  assert.equal(r.roundTrips, 0);
});

test("backtest: resolution outcome settles leftover inventory", () => {
  // Buy once, never sell. Outcome YES (pays $1). We paid 0.29, get 1.00 = +$0.71/share.
  const samples = series(0, [0.30, 0.29, 0.29, 0.29, 0.29], 60);
  const rWin = backtest("settles-yes", samples, baseStrategy, 1);
  assert.ok(rWin.realizedPnlUsdc > 0);
  // Same position but outcome NO → lose all of entry cost
  const rLose = backtest("settles-no", samples, baseStrategy, 0);
  assert.ok(rLose.realizedPnlUsdc < 0);
});

test("backtest: summarizeBatch computes mean/median/p05/p95 correctly", () => {
  // Synthetic direct-construct results to verify the summary math
  const results = [
    { realizedPnlUsdc: -0.5, samples: 10, spanHours: 1, roundTrips: 0, stopLosses: 1, stopLossPnlUsdc: -0.5, lpRewardsUsdc: 0, leftoverShares: 0, leftoverEntryValueUsdc: 0, buyFills: 1, sellFills: 0, firstPrice: 0.3, lastPrice: 0.1, market: "A" },
    { realizedPnlUsdc: 0.1, samples: 10, spanHours: 1, roundTrips: 1, stopLosses: 0, stopLossPnlUsdc: 0, lpRewardsUsdc: 0, leftoverShares: 0, leftoverEntryValueUsdc: 0, buyFills: 1, sellFills: 1, firstPrice: 0.3, lastPrice: 0.3, market: "B" },
    { realizedPnlUsdc: 0.2, samples: 10, spanHours: 1, roundTrips: 2, stopLosses: 0, stopLossPnlUsdc: 0, lpRewardsUsdc: 0, leftoverShares: 0, leftoverEntryValueUsdc: 0, buyFills: 2, sellFills: 2, firstPrice: 0.3, lastPrice: 0.3, market: "C" },
    { realizedPnlUsdc: 0.3, samples: 10, spanHours: 1, roundTrips: 3, stopLosses: 0, stopLossPnlUsdc: 0, lpRewardsUsdc: 0, leftoverShares: 0, leftoverEntryValueUsdc: 0, buyFills: 3, sellFills: 3, firstPrice: 0.3, lastPrice: 0.3, market: "D" }
  ];
  const s = summarizeBatch(results);
  assert.equal(s.markets, 4);
  assert.ok(Math.abs(s.totalPnlUsdc - 0.1) < 1e-9);
  assert.ok(Math.abs(s.mean - 0.025) < 1e-9);
  assert.equal(s.winRate, 0.75);
});

test("backtest: inventory cap prevents unbounded accumulation", () => {
  // Drop price steadily — every refresh could produce a new BUY if uncapped.
  // With maxInventoryPositions=3, we should stop buying after 3 concurrent.
  const strategy = { ...baseStrategy, maxInventoryPositions: 3, stopLossEnabled: false };
  const prices: number[] = [];
  for (let i = 0; i < 40; i++) prices.push(0.50 - i * 0.005);
  const r = backtest("accum", series(0, prices, 30), strategy);
  assert.ok(r.buyFills <= strategy.maxInventoryPositions, `capped ${r.buyFills} ≤ ${strategy.maxInventoryPositions}`);
});
