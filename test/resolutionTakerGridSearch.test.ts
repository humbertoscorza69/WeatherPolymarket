import assert from "node:assert/strict";
import test from "node:test";
import {
  expandTakerGrid,
  rankTakerResults,
  refineTakerGrid,
  runTakerGridSearch,
  type ResolutionTakerGrid
} from "../src/simulation/resolutionTakerGridSearch.js";
import type { ResolutionTakerConfig, ResolvedMarketSamples } from "../src/simulation/resolutionTakerBacktest.js";

const tinyGrid: ResolutionTakerGrid = {
  entryPriceMin: [0.90, 0.93],
  entryPriceMax: [0.99, 0.998],
  maxHoldHours: [4, 24],
  minTimeToResolutionHours: [0.5],
  orderSizeUsdc: [10],
  takerFeeRate: [0],
  fillProbability: [0.8],
  maxConcurrentPositions: [10],
  minShares: [1],
  allowMultipleEntries: [false]
};

function market(id: string, value: 0 | 1): ResolvedMarketSamples {
  return {
    id, label: id, tickSize: 0.01,
    samples: [{ t: 0, p: 0.95 }, { t: 3600, p: 0.96 }, { t: 7200, p: 0.97 }],
    resolutionTs: 7200 + 3600,
    tokenResolutionValue: value
  };
}

test("expandTakerGrid: produces cartesian product and skips invalid bands", () => {
  const configs = expandTakerGrid(tinyGrid);
  // 2 × 2 × 2 × 1 × 1 × 1 × 1 × 1 × 1 × 1 = 8
  assert.equal(configs.length, 8);
});

test("expandTakerGrid: skips entryMax <= entryMin", () => {
  // 1 entryMin × 2 entryMax (but 1 skipped for invalid band) × 2 maxHold × rest = 2 configs
  const grid: ResolutionTakerGrid = { ...tinyGrid, entryPriceMin: [0.95], entryPriceMax: [0.94, 0.99] };
  const configs = expandTakerGrid(grid);
  assert.equal(configs.length, 2);
  assert.ok(configs.every((c) => c.entryPriceMax === 0.99));
});

test("runTakerGridSearch: ranks results and assigns ranks", () => {
  const markets = [market("a", 1), market("b", 1), market("c", 0)];
  const results = runTakerGridSearch(tinyGrid, markets);
  assert.ok(results.length > 0);
  assert.equal(results[0]!.rank, 1);
  assert.equal(results[results.length - 1]!.rank, results.length);
});

test("rankTakerResults: rank-1 dominates rank-N on both mean and p05", () => {
  const stub = { trades: 10, marketsEntered: 10, totalFees: 0, winRate: 0.9 };
  const results = [
    { config: {} as ResolutionTakerConfig, meanPnl: 0.1, medianPnl: 0.05, p05: -0.05, p95: 0.20, totalPnl: 1, ...stub },
    { config: {} as ResolutionTakerConfig, meanPnl: 1.0, medianPnl: 0.5, p05: 0.50, p95: 2.0, totalPnl: 10, ...stub },
    { config: {} as ResolutionTakerConfig, meanPnl: -0.5, medianPnl: -0.3, p05: -2.0, p95: 0.1, totalPnl: -5, ...stub }
  ];
  const ranked = rankTakerResults(results);
  assert.equal(ranked[0]!.meanPnl, 1.0, "winner should be first");
  assert.equal(ranked[2]!.meanPnl, -0.5, "loser should be last");
});

test("refineTakerGrid: keeps winner value and neighbours for numeric params", () => {
  const winner: ResolutionTakerConfig = {
    entryPriceMin: 0.93,
    entryPriceMax: 0.99,
    maxHoldHours: 4,
    minTimeToResolutionHours: 0.5,
    orderSizeUsdc: 10,
    takerFeeRate: 0,
    fillProbability: 0.8,
    maxConcurrentPositions: 10,
    minShares: 1,
    allowMultipleEntries: false
  };
  const refined = refineTakerGrid(winner, tinyGrid);
  assert.ok(refined.entryPriceMin.includes(0.93));
  assert.ok(refined.entryPriceMax.includes(0.99));
  assert.deepEqual(refined.allowMultipleEntries, [false]);
});
