/**
 * Walk-forward cross-validation for the resolution-taker grid search.
 *
 * Same defence as walkForward.ts (against overfitting via multiple-
 * comparisons). We split the UNIVERSE OF MARKETS (not the samples inside
 * one market, because taker trades open and close within the life of a
 * single market — there's no continuous time series across markets).
 *
 * Procedure
 * ---------
 *   1. Sort markets by resolutionTs ascending.
 *   2. Slice into K equal sequential folds.
 *   3. For each split i ∈ [0, K-2]:
 *        - TRAIN = folds[0..i]      (older markets)
 *        - TEST  = fold[i+1]        (next newer chunk)
 *      Rank configs on TRAIN. Evaluate the same configs on TEST.
 *   4. A config's OOS score = mean of its TEST PnL across all (K-1) splits.
 *   5. Stability = fraction of splits where the train-rank-1 config landed
 *      in the test top-10%.
 *
 * Interpretation: large OOS/IS gap OR stability < 0.5 → overfitting red flag.
 */

import type { ResolvedMarketSamples, ResolutionTakerConfig } from "./resolutionTakerBacktest.js";
import { runResolutionTakerBacktest } from "./resolutionTakerBacktest.js";
import { rankTakerResults, type ResolutionTakerConfigResult } from "./resolutionTakerGridSearch.js";

export interface TakerWalkForwardResult {
  config: ResolutionTakerConfig;
  oosMeanPnl: number;
  oosP05: number;
  oosP95: number;
  oosWinRate: number;
  oosTrades: number;
  isMeanPnl: number;
  trainTestGap: number;
  stability: number;
  rank?: number;
}

export function walkForwardTaker(
  configs: ResolutionTakerConfig[],
  markets: ResolvedMarketSamples[],
  folds = 4,
  topKPct = 0.10
): TakerWalkForwardResult[] {
  if (markets.length < folds + 1) {
    throw new Error(`walkForwardTaker: need ≥ ${folds + 1} markets, got ${markets.length}`);
  }

  const sorted = [...markets].sort((a, b) => a.resolutionTs - b.resolutionTs);
  const foldSize = Math.floor(sorted.length / folds);
  const foldChunks: ResolvedMarketSamples[][] = [];
  for (let i = 0; i < folds; i++) {
    const start = i * foldSize;
    const end = i === folds - 1 ? sorted.length : (i + 1) * foldSize;
    foldChunks.push(sorted.slice(start, end));
  }

  const perConfig = new Map<ResolutionTakerConfig, { oosPnls: number[]; oosWins: number; oosTrades: number; isPnls: number[]; trainRank1Id: string | null; inTestTopK: number[] }>();
  for (const c of configs) {
    perConfig.set(c, { oosPnls: [], oosWins: 0, oosTrades: 0, isPnls: [], trainRank1Id: null, inTestTopK: [] });
  }

  for (let split = 0; split < folds - 1; split++) {
    const train = foldChunks.slice(0, split + 1).flat();
    const test = foldChunks[split + 1]!;
    if (train.length === 0 || test.length === 0) continue;

    const trainResults: ResolutionTakerConfigResult[] = configs.map((config) => {
      const r = runResolutionTakerBacktest(train, config);
      return {
        config, trades: r.trades.length, marketsEntered: r.marketsEntered,
        totalPnl: r.totalPnlUsdc, meanPnl: r.meanPnl, medianPnl: r.medianPnl,
        p05: r.p05, p95: r.p95, winRate: r.winRate, totalFees: r.totalFeesUsdc
      };
    });
    const rankedTrain = rankTakerResults(trainResults);
    const trainRank1 = rankedTrain[0]?.config;

    const testResults: { config: ResolutionTakerConfig; meanPnl: number; p05: number; trades: number; wins: number }[] = [];
    for (const config of configs) {
      const r = runResolutionTakerBacktest(test, config);
      const wins = r.trades.filter((t) => t.won).length;
      testResults.push({ config, meanPnl: r.meanPnl, p05: r.p05, trades: r.trades.length, wins });
      const state = perConfig.get(config)!;
      state.oosPnls.push(r.meanPnl);
      state.oosTrades += r.trades.length;
      state.oosWins += wins;

      const isResult = trainResults.find((t) => t.config === config);
      if (isResult) state.isPnls.push(isResult.meanPnl);
    }

    // Stability check: did the train-winner land in the test top-K%?
    if (trainRank1) {
      const testSortedByMean = [...testResults].sort((a, b) => b.meanPnl - a.meanPnl);
      const topKCount = Math.max(1, Math.floor(testSortedByMean.length * topKPct));
      const topKConfigs = new Set(testSortedByMean.slice(0, topKCount).map((r) => r.config));
      const state = perConfig.get(trainRank1)!;
      state.inTestTopK.push(topKConfigs.has(trainRank1) ? 1 : 0);
    }
  }

  const mean = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);
  const pick = (a: number[], q: number): number => {
    if (a.length === 0) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * q)))]!;
  };

  const out: TakerWalkForwardResult[] = [];
  for (const config of configs) {
    const state = perConfig.get(config)!;
    const oosMean = mean(state.oosPnls);
    const isMean = mean(state.isPnls);
    out.push({
      config,
      oosMeanPnl: oosMean,
      oosP05: pick(state.oosPnls, 0.05),
      oosP95: pick(state.oosPnls, 0.95),
      oosWinRate: state.oosTrades > 0 ? state.oosWins / state.oosTrades : 0,
      oosTrades: state.oosTrades,
      isMeanPnl: isMean,
      trainTestGap: isMean - oosMean,
      stability: state.inTestTopK.length === 0 ? 0 : mean(state.inTestTopK)
    });
  }
  out.sort((a, b) => b.oosMeanPnl - a.oosMeanPnl);
  out.forEach((r, i) => (r.rank = i + 1));
  return out;
}
