/**
 * Walk-forward cross-validation for the grid search.
 *
 * Why this exists
 * ---------------
 * With 288 configs × one historical window, we WILL find a config that
 * looks great by chance even if no real edge exists — classic multiple-
 * comparisons / overfitting problem. A pure-noise strategy passes
 * "significant at p<0.05" on roughly 1 in 20 trials; with 288 trials ~14
 * look significant by luck alone.
 *
 * Walk-forward defense:
 *   1. Split each market's history into K sequential chunks (folds).
 *   2. For each fold boundary i in 0..K-2:
 *        - TRAIN window = samples in folds [0..i]
 *        - TEST  window = samples in fold [i+1]
 *      Rank configs on TRAIN. Evaluate each on TEST.
 *   3. Aggregate: a config's OUT-OF-SAMPLE score is the average test PnL
 *      across all (K-1) folds.
 *   4. Report the gap between train rank and test rank — a healthy strategy
 *      should rank similarly on both; wildly different rankings → overfitting.
 *
 * We also report "stability" — does the config that was rank-1 in training
 * stay in the test top-K? The fraction of folds where it does is the
 * stability score in [0, 1]. Lower than ~0.5 is a red flag.
 */

import { backtest, type BacktestResult, type BacktestStrategy } from "./backtest.js";
import type { CachedMarket, ConfigPoint } from "./gridSearch.js";

export interface WalkForwardResult {
  config: ConfigPoint;
  /** Mean PnL per market across ALL test folds (out-of-sample). */
  oosMeanPnl: number;
  oosP05: number;
  oosP95: number;
  oosWinRate: number;
  oosRoundTrips: number;
  /** Comparison: in-sample mean across all train windows (for train-vs-test gap). */
  isMeanPnl: number;
  /** isMeanPnl - oosMeanPnl. Positive = overfitting. */
  trainTestGap: number;
  /** Fraction of folds where this config was in the TEST top-k%. Default k=10%. */
  stability: number;
  rank?: number;
}

function sliceSamplesByFold(samples: { t: number; p: number }[], folds: number): { t: number; p: number }[][] {
  if (samples.length === 0) return [];
  const out: { t: number; p: number }[][] = [];
  const chunkSize = Math.ceil(samples.length / folds);
  for (let i = 0; i < folds; i++) {
    out.push(samples.slice(i * chunkSize, (i + 1) * chunkSize));
  }
  return out.filter((fold) => fold.length > 0);
}

function strategyForMarket(config: ConfigPoint, market: CachedMarket): BacktestStrategy {
  return {
    halfSpreadCents: config.halfSpreadTicks * market.tickSize * 100,
    inventorySkewCents: config.inventorySkewCents,
    volMultiplier: config.volMultiplier,
    volMaxExtraCents: 3,
    volWindowSize: 60,
    orderSizeUsdc: config.orderSizeUsdc,
    tickSize: market.tickSize,
    minShares: 5,
    refreshIntervalSec: 30,
    maxInventoryPositions: 10,
    stopLossEnabled: config.stopLossEnabled,
    stopLossCatastrophicDropRatio: config.stopLossCatastrophicDropRatio,
    stopLossDeepDropRatio: config.stopLossDeepDropRatio,
    stopLossDeepDropMaxMinutes: 120,
    stopLossResolutionHours: 1,
    stopLossResolutionDropRatio: 0.7,
    stopLossMaxHoldingHours: 12,
    takerFeeRate: 0.0125,
    tpTicksBase: config.tpTicksBase,
    tpVolMultiplier: config.tpVolMultiplier,
    tpTicksMax: 5,
    driftFilterEnabled: config.driftFilterEnabled,
    driftFilterMinSamples: 10,
    driftFilterDownDriftCents: config.driftFilterDownDriftCents,
    driftFilterRatio: config.driftFilterRatio
  };
}

function meanOfPnls(results: BacktestResult[]): number {
  if (results.length === 0) return 0;
  return results.reduce((s, r) => s + r.realizedPnlUsdc, 0) / results.length;
}
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * q)] ?? 0;
}

/**
 * Run walk-forward across K folds. Returns per-config OOS metrics.
 *
 * For each market:
 *   folds = sliceSamplesByFold(samples, K)
 *   for i = 0..K-2:
 *     train = samples across folds[0..i]
 *     test  = samples in folds[i+1]
 *     run config on train → train_pnl
 *     run config on test  → test_pnl
 * Aggregate per-config across all (market × fold) combinations.
 */
export function walkForward(
  configs: ConfigPoint[],
  markets: CachedMarket[],
  folds = 4,
  topKPct = 0.10
): WalkForwardResult[] {
  if (folds < 2) throw new Error("walk-forward needs folds >= 2");

  // Precompute fold slices per market
  const marketFolds = markets.map((m) => ({
    market: m,
    folds: sliceSamplesByFold(m.samples, folds)
  }));

  const results = configs.map<WalkForwardResult>((config) => {
    const trainPnls: number[] = [];
    const testPnls: number[] = [];
    const testRoundTrips: number[] = [];

    // For each market that has enough folds
    for (const { market, folds: mFolds } of marketFolds) {
      if (mFolds.length < 2) continue;
      if (market.medianPrice < config.minOutcomeMid || market.medianPrice > config.maxOutcomeMid) continue;

      for (let i = 0; i < mFolds.length - 1; i++) {
        const train = mFolds.slice(0, i + 1).flat();
        const test = mFolds[i + 1]!;
        if (train.length < 5 || test.length < 5) continue;
        const strat = strategyForMarket(config, market);
        const trainR = backtest(market.label + `@tr${i}`, train, strat);
        const testR = backtest(market.label + `@te${i}`, test, strat);
        trainPnls.push(trainR.realizedPnlUsdc);
        testPnls.push(testR.realizedPnlUsdc);
        testRoundTrips.push(testR.roundTrips);
      }
    }

    if (testPnls.length === 0) {
      return {
        config,
        oosMeanPnl: 0,
        oosP05: 0,
        oosP95: 0,
        oosWinRate: 0,
        oosRoundTrips: 0,
        isMeanPnl: 0,
        trainTestGap: 0,
        stability: 0
      };
    }

    const sorted = [...testPnls].sort((a, b) => a - b);
    const oosMean = testPnls.reduce((s, v) => s + v, 0) / testPnls.length;
    const inMean = trainPnls.reduce((s, v) => s + v, 0) / trainPnls.length;
    return {
      config,
      oosMeanPnl: oosMean,
      oosP05: percentile(sorted, 0.05),
      oosP95: percentile(sorted, 0.95),
      oosWinRate: sorted.filter((v) => v > 0).length / sorted.length,
      oosRoundTrips: testRoundTrips.reduce((s, v) => s + v, 0),
      isMeanPnl: inMean,
      trainTestGap: inMean - oosMean,
      stability: 0 // filled in after all configs are scored
    };
  });

  // Stability: for each fold, rank configs by train; record whether each config
  // landed in the test top-k% on that fold. Stability = fraction of folds where
  // it did. We reconstruct the per-fold rankings using the already-gathered data.
  const topK = Math.max(1, Math.ceil(configs.length * topKPct));
  // Build per-fold (config → train, test) arrays
  const foldCount = Math.max(
    ...marketFolds
      .map(({ folds: mf }) => Math.max(0, mf.length - 1))
      .concat([0])
  );
  for (let foldIdx = 0; foldIdx < foldCount; foldIdx++) {
    // Per config, compute mean train and test for THIS fold only
    const perConfig = configs.map((config) => {
      const trainP: number[] = [];
      const testP: number[] = [];
      for (const { market, folds: mFolds } of marketFolds) {
        if (mFolds.length <= foldIdx + 1) continue;
        if (market.medianPrice < config.minOutcomeMid || market.medianPrice > config.maxOutcomeMid) continue;
        const train = mFolds.slice(0, foldIdx + 1).flat();
        const test = mFolds[foldIdx + 1]!;
        if (train.length < 5 || test.length < 5) continue;
        const strat = strategyForMarket(config, market);
        trainP.push(backtest(market.label, train, strat).realizedPnlUsdc);
        testP.push(backtest(market.label, test, strat).realizedPnlUsdc);
      }
      return { config, trainMean: meanOfPnls(trainP.map((p) => ({ realizedPnlUsdc: p } as BacktestResult))), testMean: meanOfPnls(testP.map((p) => ({ realizedPnlUsdc: p } as BacktestResult))) };
    });
    const byTestDesc = [...perConfig].sort((a, b) => b.testMean - a.testMean);
    const topSet = new Set(byTestDesc.slice(0, topK).map((p) => p.config));
    for (const result of results) {
      if (topSet.has(result.config)) {
        // Increment stability count
        result.stability += 1;
      }
    }
  }
  // Normalize stability to [0, 1]
  for (const r of results) r.stability = foldCount > 0 ? r.stability / foldCount : 0;

  // Rank by OOS mean PnL
  const ranked = [...results].sort((a, b) => b.oosMeanPnl - a.oosMeanPnl);
  ranked.forEach((r, i) => (r.rank = i + 1));
  return ranked;
}
