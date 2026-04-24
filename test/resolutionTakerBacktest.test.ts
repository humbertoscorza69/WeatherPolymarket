import assert from "node:assert/strict";
import test from "node:test";
import {
  runResolutionTakerBacktest,
  runResolutionTakerOnMarket,
  type ResolutionTakerConfig,
  type ResolvedMarketSamples
} from "../src/simulation/resolutionTakerBacktest.js";

const baseConfig: ResolutionTakerConfig = {
  entryPriceMin: 0.93,
  entryPriceMax: 0.99,
  maxHoldHours: 24,
  minTimeToResolutionHours: 0.5,
  orderSizeUsdc: 10,
  takerFeeRate: 0,
  fillProbability: 1.0,
  maxConcurrentPositions: 10,
  minShares: 1,
  allowMultipleEntries: false
};

function priceSeries(startTs: number, prices: number[], stepSec: number) {
  return prices.map((p, i) => ({ t: startTs + i * stepSec, p }));
}

function marketResolvingYes(id: string, samples: { t: number; p: number }[]): ResolvedMarketSamples {
  const resolutionTs = samples[samples.length - 1]!.t + 3600; // resolve 1h after last sample
  return { id, label: id, tickSize: 0.01, samples, resolutionTs, tokenResolutionValue: 1 };
}

function marketResolvingNo(id: string, samples: { t: number; p: number }[]): ResolvedMarketSamples {
  const resolutionTs = samples[samples.length - 1]!.t + 3600;
  return { id, label: id, tickSize: 0.01, samples, resolutionTs, tokenResolutionValue: 0 };
}

const detRng = () => 0.5; // deterministic: always passes Bernoulli

test("runResolutionTakerOnMarket: enters on first in-band sample and wins when market resolves YES", () => {
  const samples = priceSeries(0, [0.80, 0.94, 0.96, 0.99, 0.995], 900);
  const market = marketResolvingYes("m1", samples);
  const trades = runResolutionTakerOnMarket(market, baseConfig, detRng);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]!.entryPrice, 0.94, "should enter at first in-band sample");
  assert.equal(trades[0]!.resolutionValue, 1);
  const expectedShares = 10 / 0.94;
  assert.ok(Math.abs(trades[0]!.shares - expectedShares) < 1e-9);
  const expectedPnl = expectedShares * (1 - 0.94);
  assert.ok(Math.abs(trades[0]!.pnlUsdc - expectedPnl) < 1e-9);
  assert.equal(trades[0]!.won, true);
});

test("runResolutionTakerOnMarket: records loss when market resolves NO", () => {
  const samples = priceSeries(0, [0.95, 0.95, 0.95], 900);
  const market = marketResolvingNo("m2", samples);
  const trades = runResolutionTakerOnMarket(market, baseConfig, detRng);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]!.resolutionValue, 0);
  const expectedShares = 10 / 0.95;
  const expectedPnl = expectedShares * (0 - 0.95);
  assert.ok(Math.abs(trades[0]!.pnlUsdc - expectedPnl) < 1e-9, `got ${trades[0]!.pnlUsdc}, expected ${expectedPnl}`);
  assert.equal(trades[0]!.won, false);
});

test("runResolutionTakerOnMarket: skips sample below entryMin", () => {
  const samples = priceSeries(0, [0.5, 0.7, 0.92], 900);
  const market = marketResolvingYes("m3", samples);
  const trades = runResolutionTakerOnMarket(market, baseConfig, detRng);
  assert.equal(trades.length, 0, "no sample reached 0.93+");
});

test("runResolutionTakerOnMarket: respects minTimeToResolutionHours (don't enter too close)", () => {
  // Resolution at ts=10000; samples at ts 9000, 9500, 9900 (<0.5h = <1800sec)
  const samples = [
    { t: 9000, p: 0.95 },
    { t: 9500, p: 0.95 },
    { t: 9900, p: 0.95 }
  ];
  const market: ResolvedMarketSamples = {
    id: "m4", label: "m4", tickSize: 0.01, samples, resolutionTs: 10_000, tokenResolutionValue: 1
  };
  const tradesNoBuffer = runResolutionTakerOnMarket(market, { ...baseConfig, minTimeToResolutionHours: 0 }, detRng);
  assert.equal(tradesNoBuffer.length, 1, "with no buffer, should enter");

  const tradesWithBuffer = runResolutionTakerOnMarket(market, baseConfig, detRng);
  assert.equal(tradesWithBuffer.length, 0, "with 0.5h buffer, all samples are <0.5h to resolution → skip");
});

test("runResolutionTakerOnMarket: respects maxHoldHours (don't enter too early)", () => {
  const samples = priceSeries(0, [0.95, 0.95, 0.95], 3600);
  // Resolution is 30 days out; first sample 30d before resolution
  const market: ResolvedMarketSamples = {
    id: "m5", label: "m5", tickSize: 0.01, samples,
    resolutionTs: samples[samples.length - 1]!.t + 30 * 86400,
    tokenResolutionValue: 1
  };
  const trades = runResolutionTakerOnMarket(market, { ...baseConfig, maxHoldHours: 24 }, detRng);
  assert.equal(trades.length, 0, "all samples are >24h from resolution → skip");
});

test("runResolutionTakerOnMarket: allowMultipleEntries=true creates multiple trades", () => {
  const samples = priceSeries(0, [0.95, 0.85, 0.95, 0.85, 0.96], 900);
  const market = marketResolvingYes("m6", samples);
  const trades = runResolutionTakerOnMarket(
    market,
    { ...baseConfig, allowMultipleEntries: true },
    detRng
  );
  assert.ok(trades.length >= 2, `expected multiple entries, got ${trades.length}`);
});

test("runResolutionTakerBacktest: aggregates trades across markets and caps concurrent positions", () => {
  const markets = [
    marketResolvingYes("a", priceSeries(0, [0.95], 0)),
    marketResolvingYes("b", priceSeries(0, [0.95], 0)),
    marketResolvingYes("c", priceSeries(0, [0.95], 0))
  ];
  const result = runResolutionTakerBacktest(markets, { ...baseConfig, maxConcurrentPositions: 2 });
  assert.equal(result.trades.length, 2, "max concurrent cap should drop one trade");
});

test("runResolutionTakerBacktest: totalPnl matches sum of accepted trades", () => {
  const markets = [
    marketResolvingYes("a", priceSeries(0, [0.95], 900)),
    marketResolvingNo("b", priceSeries(0, [0.95], 900))
  ];
  const result = runResolutionTakerBacktest(markets, baseConfig);
  const sum = result.trades.reduce((s, t) => s + t.pnlUsdc, 0);
  assert.ok(Math.abs(result.totalPnlUsdc - sum) < 1e-9);
});

test("runResolutionTakerBacktest: fillProbability=0 produces no trades", () => {
  const markets = [marketResolvingYes("a", priceSeries(0, [0.95, 0.95, 0.95], 900))];
  const result = runResolutionTakerBacktest(markets, { ...baseConfig, fillProbability: 0 });
  assert.equal(result.trades.length, 0);
});

test("runResolutionTakerBacktest: deterministic with same seed", () => {
  const markets = [marketResolvingYes("a", priceSeries(0, [0.95, 0.96, 0.97], 900))];
  const cfg = { ...baseConfig, fillProbability: 0.5 };
  const a = runResolutionTakerBacktest(markets, cfg, 123);
  const b = runResolutionTakerBacktest(markets, cfg, 123);
  assert.equal(a.trades.length, b.trades.length);
});

test("runResolutionTakerBacktest: min_shares guard drops tiny fills", () => {
  const markets = [marketResolvingYes("a", priceSeries(0, [0.95], 900))];
  const cfg = { ...baseConfig, orderSizeUsdc: 2, minShares: 100 };
  const result = runResolutionTakerBacktest(markets, cfg);
  assert.equal(result.trades.length, 0, "2 USDC at $0.95 → 2.1 shares < 100 min");
});
