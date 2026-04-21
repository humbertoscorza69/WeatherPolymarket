import assert from "node:assert/strict";
import test from "node:test";
import {
  expandGrid,
  rankResults,
  refineAround,
  runConfig,
  runGridSearch,
  type CachedMarket,
  type ConfigPoint,
  type ParamGrid
} from "../src/simulation/gridSearch.js";

function oscillator(startT: number, values: number[], stepSec = 60) {
  return values.map((p, i) => ({ t: startT + i * stepSec, p }));
}

function market(label: string, tickSize: number, samples: { t: number; p: number }[]): CachedMarket {
  const sorted = [...samples.map((s) => s.p)].sort((a, b) => a - b);
  return { tokenId: label, label, tickSize, samples, medianPrice: sorted[Math.floor(sorted.length / 2)]! };
}

const tinyGrid: ParamGrid = {
  halfSpreadTicks: [1, 2],
  inventorySkewCents: [0],
  volMultiplier: [0],
  minOutcomeMid: [0.05],
  maxOutcomeMid: [0.95],
  maxForecastDivergence: [0.3],
  stopLossEnabled: [true],
  stopLossCatastrophicDropRatio: [0.3],
  stopLossDeepDropRatio: [0.6],
  orderSizeUsdc: [2],
  tpTicksBase: [1],
  tpVolMultiplier: [0]
};

test("expandGrid produces the full cartesian product", () => {
  const grid: ParamGrid = { ...tinyGrid, halfSpreadTicks: [1, 2, 3], orderSizeUsdc: [2, 3] };
  const configs = expandGrid(grid);
  assert.equal(configs.length, 3 * 2);
});

test("runConfig excludes markets outside the config's outcome band", () => {
  const inBand = market("mid", 0.01, oscillator(0, [0.30, 0.29, 0.30, 0.29, 0.30], 60));
  const outOfBandHigh = market("hi", 0.01, oscillator(0, [0.99, 0.99, 0.99, 0.99, 0.99], 60));
  const outOfBandLow = market("lo", 0.01, oscillator(0, [0.01, 0.01, 0.01, 0.01, 0.01], 60));

  const cfg: ConfigPoint = {
    halfSpreadTicks: 1,
    inventorySkewCents: 0,
    volMultiplier: 0,
    minOutcomeMid: 0.05,
    maxOutcomeMid: 0.95,
    maxForecastDivergence: 0.3,
    stopLossEnabled: true,
    stopLossCatastrophicDropRatio: 0.3,
    stopLossDeepDropRatio: 0.6,
    orderSizeUsdc: 2,
    tpTicksBase: 1,
    tpVolMultiplier: 0
  };
  const r = runConfig(cfg, [inBand, outOfBandHigh, outOfBandLow]);
  assert.equal(r.marketsUsed, 1);
});

test("runGridSearch returns results ranked by composite metric", () => {
  const markets = [market("m1", 0.01, oscillator(0, [0.30, 0.29, 0.30, 0.29, 0.30, 0.29, 0.30], 60))];
  const ranked = runGridSearch(tinyGrid, markets);
  assert.equal(ranked.length, 2);
  // Every result should have a rank
  assert.ok(ranked.every((r) => typeof r.rank === "number"));
  assert.equal(ranked[0]!.rank, 1);
  assert.equal(ranked[1]!.rank, 2);
});

test("rankResults: best-by-mean + best-by-p05 outranks worst on both axes", () => {
  const cfg: ConfigPoint = {
    halfSpreadTicks: 1, inventorySkewCents: 0, volMultiplier: 0, minOutcomeMid: 0.05,
    maxOutcomeMid: 0.95, maxForecastDivergence: 0.3, stopLossEnabled: true,
    stopLossCatastrophicDropRatio: 0.3, stopLossDeepDropRatio: 0.6, orderSizeUsdc: 2,
    tpTicksBase: 1, tpVolMultiplier: 0
  };
  // Winner dominates on both axes, loser loses on both. Middle is middle.
  const winner = { config: { ...cfg }, marketsUsed: 10, totalRoundTrips: 0, totalStopLosses: 0, meanPnl: 1.0, medianPnl: 0, stdPnl: 1, p05: 0.5, p95: 2, winRate: 0.9, totalPnl: 10, sharpe: 1 };
  const middle = { config: { ...cfg }, marketsUsed: 10, totalRoundTrips: 0, totalStopLosses: 0, meanPnl: 0.5, medianPnl: 0, stdPnl: 0.5, p05: 0.1, p95: 1, winRate: 0.6, totalPnl: 5, sharpe: 1 };
  const loser = { config: { ...cfg }, marketsUsed: 10, totalRoundTrips: 0, totalStopLosses: 0, meanPnl: -0.1, medianPnl: 0, stdPnl: 0.1, p05: -0.5, p95: 0, winRate: 0.3, totalPnl: -1, sharpe: 1 };
  const ranked = rankResults([loser, middle, winner]);
  assert.equal(ranked[0]!.meanPnl, 1.0, "winner should be first");
  assert.equal(ranked[2]!.meanPnl, -0.1, "loser should be last");
});

test("refineAround: produces neighbourhood grid pinned at the winner", () => {
  const broadGrid: ParamGrid = {
    halfSpreadTicks: [1, 2, 3, 4, 5],
    inventorySkewCents: [0, 1, 2, 3],
    volMultiplier: [0, 0.5, 1.0, 2.0],
    minOutcomeMid: [0.05, 0.10, 0.15],
    maxOutcomeMid: [0.85, 0.90, 0.95],
    maxForecastDivergence: [0.1, 0.2, 0.3],
    stopLossEnabled: [true, false],
    stopLossCatastrophicDropRatio: [0.2, 0.3, 0.4],
    stopLossDeepDropRatio: [0.5, 0.6, 0.7],
    orderSizeUsdc: [2, 3, 5],
    tpTicksBase: [1, 2, 3],
    tpVolMultiplier: [0, 0.5, 1.0]
  };
  const winner: ConfigPoint = {
    halfSpreadTicks: 3, inventorySkewCents: 2, volMultiplier: 1.0, minOutcomeMid: 0.10,
    maxOutcomeMid: 0.90, maxForecastDivergence: 0.2, stopLossEnabled: true,
    stopLossCatastrophicDropRatio: 0.3, stopLossDeepDropRatio: 0.6, orderSizeUsdc: 3,
    tpTicksBase: 2, tpVolMultiplier: 0.5
  };
  const refined = refineAround(winner, broadGrid);
  // Winner's value is inside every returned neighbourhood
  assert.ok(refined.halfSpreadTicks.includes(3));
  assert.ok(refined.inventorySkewCents.includes(2));
  assert.ok(refined.volMultiplier.includes(1.0));
  // Neighbourhoods are small (≤ 3 values each)
  assert.ok(refined.halfSpreadTicks.length <= 3);
  assert.ok(refined.orderSizeUsdc.length <= 3);
  // Stop-loss flag is pinned
  assert.deepEqual(refined.stopLossEnabled, [true]);
});
