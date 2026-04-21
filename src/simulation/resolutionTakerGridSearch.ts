/**
 * Grid search over ResolutionTakerConfig.
 *
 * Mirrors gridSearch.ts but for the resolution-taker strategy. We keep
 * them separate because the param sets don't overlap (the MM strategy has
 * half-spread / inventory skew; the taker has entry band / hold window).
 *
 * Ranking is the same composite as the MM sweep: 0.5×mean_rank + 0.5×p05_rank.
 * This penalises both low expected return and bad tails, which matters a lot
 * for a strategy whose occasional losers can be 20× the avg winner.
 */

import type { ResolvedMarketSamples, ResolutionTakerConfig } from "./resolutionTakerBacktest.js";
import { runResolutionTakerBacktest } from "./resolutionTakerBacktest.js";

export interface ResolutionTakerGrid {
  entryPriceMin: number[];
  entryPriceMax: number[];
  maxHoldHours: number[];
  minTimeToResolutionHours: number[];
  orderSizeUsdc: number[];
  takerFeeRate: number[];
  fillProbability: number[];
  maxConcurrentPositions: number[];
  minShares: number[];
  allowMultipleEntries: boolean[];
}

export interface ResolutionTakerConfigResult {
  config: ResolutionTakerConfig;
  trades: number;
  marketsEntered: number;
  totalPnl: number;
  meanPnl: number;
  medianPnl: number;
  p05: number;
  p95: number;
  winRate: number;
  totalFees: number;
  rank?: number;
}

export function expandTakerGrid(grid: ResolutionTakerGrid): ResolutionTakerConfig[] {
  const configs: ResolutionTakerConfig[] = [];
  for (const entryMin of grid.entryPriceMin) {
    for (const entryMax of grid.entryPriceMax) {
      if (entryMax <= entryMin) continue; // skip invalid bands
      for (const maxHold of grid.maxHoldHours) {
        for (const minTime of grid.minTimeToResolutionHours) {
          if (minTime >= maxHold) continue;
          for (const sizeUsdc of grid.orderSizeUsdc) {
            for (const fee of grid.takerFeeRate) {
              for (const fillProb of grid.fillProbability) {
                for (const maxConc of grid.maxConcurrentPositions) {
                  for (const minShares of grid.minShares) {
                    for (const multi of grid.allowMultipleEntries) {
                      configs.push({
                        entryPriceMin: entryMin,
                        entryPriceMax: entryMax,
                        maxHoldHours: maxHold,
                        minTimeToResolutionHours: minTime,
                        orderSizeUsdc: sizeUsdc,
                        takerFeeRate: fee,
                        fillProbability: fillProb,
                        maxConcurrentPositions: maxConc,
                        minShares,
                        allowMultipleEntries: multi
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return configs;
}

export function runTakerGridSearch(
  grid: ResolutionTakerGrid,
  markets: ResolvedMarketSamples[]
): ResolutionTakerConfigResult[] {
  const configs = expandTakerGrid(grid);
  const results: ResolutionTakerConfigResult[] = [];
  for (const config of configs) {
    const r = runResolutionTakerBacktest(markets, config);
    results.push({
      config,
      trades: r.trades.length,
      marketsEntered: r.marketsEntered,
      totalPnl: r.totalPnlUsdc,
      meanPnl: r.meanPnl,
      medianPnl: r.medianPnl,
      p05: r.p05,
      p95: r.p95,
      winRate: r.winRate,
      totalFees: r.totalFeesUsdc
    });
  }
  return rankTakerResults(results);
}

export function rankTakerResults(results: ResolutionTakerConfigResult[]): ResolutionTakerConfigResult[] {
  const byMean = [...results].sort((a, b) => b.meanPnl - a.meanPnl);
  const byP05 = [...results].sort((a, b) => b.p05 - a.p05);
  const meanRank = new Map<ResolutionTakerConfigResult, number>();
  byMean.forEach((r, i) => meanRank.set(r, i));
  const p05Rank = new Map<ResolutionTakerConfigResult, number>();
  byP05.forEach((r, i) => p05Rank.set(r, i));
  const composite = results.map((r) => ({
    r,
    score: 0.5 * (meanRank.get(r) ?? 0) + 0.5 * (p05Rank.get(r) ?? 0)
  }));
  composite.sort((a, b) => a.score - b.score);
  composite.forEach((c, i) => (c.r.rank = i + 1));
  return composite.map((c) => c.r);
}

/** Neighbourhood refinement: for each numeric param, keep the winner's value
 *  plus one lower and one higher value from the original grid. Booleans are
 *  pinned to the winner. */
export function refineTakerGrid(winner: ResolutionTakerConfig, original: ResolutionTakerGrid): ResolutionTakerGrid {
  const neighbours = <T extends number>(arr: T[], value: T): T[] => {
    const sorted = [...new Set(arr)].sort((a, b) => a - b);
    const i = sorted.indexOf(value);
    if (i === -1) return [value];
    const out = new Set<T>([value]);
    if (i > 0) out.add(sorted[i - 1]!);
    if (i < sorted.length - 1) out.add(sorted[i + 1]!);
    return [...out];
  };

  return {
    entryPriceMin: neighbours(original.entryPriceMin, winner.entryPriceMin),
    entryPriceMax: neighbours(original.entryPriceMax, winner.entryPriceMax),
    maxHoldHours: neighbours(original.maxHoldHours, winner.maxHoldHours),
    minTimeToResolutionHours: neighbours(original.minTimeToResolutionHours, winner.minTimeToResolutionHours),
    orderSizeUsdc: neighbours(original.orderSizeUsdc, winner.orderSizeUsdc),
    takerFeeRate: neighbours(original.takerFeeRate, winner.takerFeeRate),
    fillProbability: neighbours(original.fillProbability, winner.fillProbability),
    maxConcurrentPositions: neighbours(original.maxConcurrentPositions, winner.maxConcurrentPositions),
    minShares: neighbours(original.minShares, winner.minShares),
    allowMultipleEntries: [winner.allowMultipleEntries]
  };
}
