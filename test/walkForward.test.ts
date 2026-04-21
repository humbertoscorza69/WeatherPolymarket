import assert from "node:assert/strict";
import test from "node:test";
import { walkForward } from "../src/simulation/walkForward.js";
import type { CachedMarket, ConfigPoint } from "../src/simulation/gridSearch.js";

function oscillator(startT: number, values: number[], stepSec = 60) {
  return values.map((p, i) => ({ t: startT + i * stepSec, p }));
}
function market(label: string, tickSize: number, samples: { t: number; p: number }[]): CachedMarket {
  const sorted = [...samples.map((s) => s.p)].sort((a, b) => a - b);
  return { tokenId: label, label, tickSize, samples, medianPrice: sorted[Math.floor(sorted.length / 2)]! };
}
function cfg(overrides: Partial<ConfigPoint> = {}): ConfigPoint {
  return {
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
    ...overrides
  };
}

test("walkForward throws when folds < 2", () => {
  assert.throws(() => walkForward([cfg()], [], 1), /folds >= 2/);
});

test("walkForward handles empty market universe gracefully", () => {
  const res = walkForward([cfg()], [], 3);
  assert.equal(res.length, 1);
  assert.equal(res[0]!.oosMeanPnl, 0);
  assert.equal(res[0]!.stability, 0);
});

test("walkForward produces non-zero OOS metrics on oscillating market", () => {
  // 40 samples, price oscillating 0.29 <-> 0.30 every sample
  const osc: number[] = [];
  for (let i = 0; i < 40; i++) osc.push(i % 2 === 0 ? 0.30 : 0.29);
  const m = market("osc", 0.01, oscillator(0, osc, 60));
  const res = walkForward([cfg()], [m], 4);
  assert.equal(res.length, 1);
  assert.ok(res[0]!.oosRoundTrips >= 1, "should produce round-trips on the test folds");
});

test("walkForward ranks results by OOS mean PnL descending", () => {
  const samples = Array.from({ length: 32 }, (_, i) => ({ t: i * 60, p: i % 2 === 0 ? 0.30 : 0.29 }));
  const m = market("osc", 0.01, samples);
  const a = cfg({ halfSpreadTicks: 1 });
  const b = cfg({ halfSpreadTicks: 3 }); // wider — fewer fills
  const res = walkForward([a, b], [m], 4);
  assert.equal(res[0]!.rank, 1);
  assert.equal(res[1]!.rank, 2);
  // The config with more fills (tighter spread) should generally rank higher on OOS PnL
});

test("walkForward excludes markets outside a config's band", () => {
  const tailMarket = market("tail", 0.01, oscillator(0, Array(20).fill(0.02), 60));
  const res = walkForward([cfg({ minOutcomeMid: 0.05 })], [tailMarket], 4);
  // With no market qualifying, all metrics are zero
  assert.equal(res[0]!.oosMeanPnl, 0);
  assert.equal(res[0]!.oosRoundTrips, 0);
});
