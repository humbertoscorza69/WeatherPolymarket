import assert from "node:assert/strict";
import test from "node:test";
import { runMonteCarlo, type MonteCarloAssumptions } from "../src/simulation/monteCarloAnalysis.js";
import type { ResolutionTakerConfig, ResolvedMarketSamples } from "../src/simulation/resolutionTakerBacktest.js";

function market(id: string, samples: { t: number; p: number }[], value: 0 | 1): ResolvedMarketSamples {
  const resolutionTs = samples[samples.length - 1]!.t + 3600;
  return { id, label: id, tickSize: 0.01, samples, resolutionTs, tokenResolutionValue: value };
}

const baseConfig: ResolutionTakerConfig = {
  entryPriceMin: 0.93,
  entryPriceMax: 0.99,
  maxHoldHours: 24,
  minTimeToResolutionHours: 0.5,
  orderSizeUsdc: 10,
  takerFeeRate: 0,
  fillProbability: 0.8,
  maxConcurrentPositions: 10,
  minShares: 1,
  allowMultipleEntries: false
};

const assumptions: MonteCarloAssumptions = {
  fillProbabilityRange: [0.5, 0.9],
  entrySlippageRange: [0, 0.005],
  takerFeeRateRange: [0, 0.005],
  replays: 50,
  bootstrapSamples: 20,
  seed: 42
};

test("runMonteCarlo: produces valid distribution structure", () => {
  const markets = Array.from({ length: 10 }, (_, i) =>
    market(`m${i}`, Array.from({ length: 5 }, (_, j) => ({ t: j * 3600, p: 0.95 })), (i % 10 < 9 ? 1 : 0) as 0 | 1)
  );
  const report = runMonteCarlo(markets, baseConfig, assumptions);
  assert.ok(typeof report.totalPnl.mean === "number");
  assert.ok(report.totalPnl.p05 <= report.totalPnl.p50);
  assert.ok(report.totalPnl.p50 <= report.totalPnl.p95);
  assert.ok(report.totalPnl.probPositive >= 0 && report.totalPnl.probPositive <= 1);
  assert.equal(report.replays.length, assumptions.replays);
});

test("runMonteCarlo: all-YES markets gives probPositive near 1", () => {
  // At entry 0.95 on a binary market, ONE loser wipes ~19 winners. So
  // test with 100% YES resolution to verify the engine registers the
  // high win rate correctly.
  const markets = Array.from({ length: 10 }, (_, i) =>
    market(`m${i}`, [{ t: 0, p: 0.95 }, { t: 3600, p: 0.95 }], 1)
  );
  const report = runMonteCarlo(markets, baseConfig, assumptions);
  assert.ok(report.totalPnl.probPositive > 0.8, `expected >0.8 probPositive, got ${report.totalPnl.probPositive}`);
  assert.ok(report.totalPnl.mean > 0);
});

test("runMonteCarlo: all-losers case gives probPositive near 0", () => {
  const markets = Array.from({ length: 10 }, (_, i) =>
    market(`m${i}`, [{ t: 0, p: 0.95 }, { t: 3600, p: 0.95 }], 0)
  );
  const report = runMonteCarlo(markets, baseConfig, assumptions);
  assert.ok(report.totalPnl.probPositive < 0.2, `expected <0.2 probPositive, got ${report.totalPnl.probPositive}`);
  assert.ok(report.totalPnl.mean < 0);
});

test("runMonteCarlo: deterministic with same seed", () => {
  const markets = Array.from({ length: 10 }, (_, i) =>
    market(`m${i}`, [{ t: 0, p: 0.95 }, { t: 3600, p: 0.95 }], (i < 9 ? 1 : 0) as 0 | 1)
  );
  const a = runMonteCarlo(markets, baseConfig, assumptions);
  const b = runMonteCarlo(markets, baseConfig, assumptions);
  assert.equal(a.totalPnl.mean, b.totalPnl.mean);
  assert.equal(a.totalPnl.p05, b.totalPnl.p05);
});

test("runMonteCarlo: expectedDailyByCapital scales linearly with capital", () => {
  const markets = Array.from({ length: 10 }, (_, i) =>
    market(`m${i}`, [{ t: 0, p: 0.95 }, { t: 3600, p: 0.95 }], (i < 9 ? 1 : 0) as 0 | 1)
  );
  const report = runMonteCarlo(markets, baseConfig, assumptions, [100, 1000]);
  const tier100 = report.expectedDailyByCapital[0]!;
  const tier1000 = report.expectedDailyByCapital[1]!;
  // 10× capital should give 10× expected daily (within float noise)
  assert.ok(Math.abs(tier1000.meanDaily / tier100.meanDaily - 10) < 1e-6);
});
