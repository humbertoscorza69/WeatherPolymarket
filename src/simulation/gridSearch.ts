/**
 * Cartesian grid search over backtest strategy parameters.
 *
 * Given:
 *  - a set of cached historical price series (one per market)
 *  - a grid of candidate parameter values
 *
 * Runs every (config × market) combination through the backtest and ranks
 * configs by a composite metric (default: 0.5 × mean_rank + 0.5 × p05_rank
 * — balances expected return with tail protection).
 *
 * Design notes
 * ------------
 * - Each market has its own tickSize. The grid's halfSpreadTicks parameter
 *   therefore produces a *different* halfSpreadCents per market. We compute
 *   the per-market strategy inside runConfig().
 * - The outcome-band filter (minOutcomeMid / maxOutcomeMid) is part of the
 *   config grid. Markets whose median price falls outside a config's band
 *   are excluded from THAT config's universe. Different configs evaluate
 *   different slices of the market set — that's intentional; a tighter band
 *   is a real design choice, not a free lunch.
 * - Rankings are computed within the set of configs, so absolute PnL numbers
 *   matter less than the relative ordering.
 *
 * Typical sizes: 500 markets × 32 configs × ~1ms per backtest = ~16 seconds.
 */

import { backtest, type BacktestResult, type BacktestStrategy } from "./backtest.js";

export interface CachedMarket {
  tokenId: string;
  label: string;
  tickSize: number;
  samples: { t: number; p: number }[];
  medianPrice: number;
}

export interface ParamGrid {
  halfSpreadTicks: number[];
  inventorySkewCents: number[];
  volMultiplier: number[];
  minOutcomeMid: number[];
  maxOutcomeMid: number[];
  maxForecastDivergence: number[];
  stopLossEnabled: boolean[];
  stopLossCatastrophicDropRatio: number[];
  stopLossDeepDropRatio: number[];
  orderSizeUsdc: number[];
  tpTicksBase: number[];
  tpVolMultiplier: number[];
}

export interface ConfigPoint {
  halfSpreadTicks: number;
  inventorySkewCents: number;
  volMultiplier: number;
  minOutcomeMid: number;
  maxOutcomeMid: number;
  maxForecastDivergence: number;
  stopLossEnabled: boolean;
  stopLossCatastrophicDropRatio: number;
  stopLossDeepDropRatio: number;
  orderSizeUsdc: number;
  tpTicksBase: number;
  tpVolMultiplier: number;
}

export interface ConfigResult {
  config: ConfigPoint;
  marketsUsed: number;
  totalRoundTrips: number;
  totalStopLosses: number;
  meanPnl: number;
  medianPnl: number;
  stdPnl: number;
  p05: number;
  p95: number;
  winRate: number;
  totalPnl: number;
  sharpe: number;
  /** Composite rank score (lower = better). Fills in during ranking. */
  rankScore?: number;
  rank?: number;
}

/** Build the cartesian product of every field in the grid. */
export function expandGrid(grid: ParamGrid): ConfigPoint[] {
  const out: ConfigPoint[] = [];
  for (const halfSpreadTicks of grid.halfSpreadTicks)
    for (const inventorySkewCents of grid.inventorySkewCents)
      for (const volMultiplier of grid.volMultiplier)
        for (const minOutcomeMid of grid.minOutcomeMid)
          for (const maxOutcomeMid of grid.maxOutcomeMid)
            for (const maxForecastDivergence of grid.maxForecastDivergence)
              for (const stopLossEnabled of grid.stopLossEnabled)
                for (const stopLossCatastrophicDropRatio of grid.stopLossCatastrophicDropRatio)
                  for (const stopLossDeepDropRatio of grid.stopLossDeepDropRatio)
                    for (const orderSizeUsdc of grid.orderSizeUsdc)
                      for (const tpTicksBase of grid.tpTicksBase)
                        for (const tpVolMultiplier of grid.tpVolMultiplier)
                          out.push({
                            halfSpreadTicks,
                            inventorySkewCents,
                            volMultiplier,
                            minOutcomeMid,
                            maxOutcomeMid,
                            maxForecastDivergence,
                            stopLossEnabled,
                            stopLossCatastrophicDropRatio,
                            stopLossDeepDropRatio,
                            orderSizeUsdc,
                            tpTicksBase,
                            tpVolMultiplier
                          });
  return out;
}

/**
 * Evaluate a single config across all markets in the universe.
 * Markets with median outside the config's band are excluded.
 */
export function runConfig(config: ConfigPoint, markets: CachedMarket[]): ConfigResult {
  const perMarket: BacktestResult[] = [];
  for (const market of markets) {
    if (market.medianPrice < config.minOutcomeMid) continue;
    if (market.medianPrice > config.maxOutcomeMid) continue;
    const strategy: BacktestStrategy = {
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
      tpTicksMax: 5
    };
    perMarket.push(backtest(market.label, market.samples, strategy));
  }

  if (perMarket.length === 0) {
    return {
      config,
      marketsUsed: 0,
      totalRoundTrips: 0,
      totalStopLosses: 0,
      meanPnl: 0,
      medianPnl: 0,
      stdPnl: 0,
      p05: 0,
      p95: 0,
      winRate: 0,
      totalPnl: 0,
      sharpe: 0
    };
  }

  const pnls = perMarket.map((r) => r.realizedPnlUsdc).sort((a, b) => a - b);
  const total = pnls.reduce((s, v) => s + v, 0);
  const mean = total / pnls.length;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
  const std = Math.sqrt(variance);
  return {
    config,
    marketsUsed: perMarket.length,
    totalRoundTrips: perMarket.reduce((s, r) => s + r.roundTrips, 0),
    totalStopLosses: perMarket.reduce((s, r) => s + r.stopLosses, 0),
    meanPnl: mean,
    medianPnl: pnls[Math.floor(pnls.length / 2)]!,
    stdPnl: std,
    p05: pnls[Math.floor(pnls.length * 0.05)]!,
    p95: pnls[Math.floor(pnls.length * 0.95)]!,
    winRate: pnls.filter((v) => v > 0).length / pnls.length,
    totalPnl: total,
    sharpe: std > 0 ? mean / std : mean > 0 ? Infinity : 0
  };
}

/** Rank results by composite metric: 0.5 × mean_rank + 0.5 × p05_rank (lower = better). */
export function rankResults(results: ConfigResult[]): ConfigResult[] {
  if (results.length === 0) return [];
  const byMean = [...results].sort((a, b) => b.meanPnl - a.meanPnl);
  const byP05 = [...results].sort((a, b) => b.p05 - a.p05);
  const meanRank = new Map(byMean.map((r, i) => [r, i]));
  const p05Rank = new Map(byP05.map((r, i) => [r, i]));
  for (const r of results) {
    r.rankScore = 0.5 * (meanRank.get(r) ?? 0) + 0.5 * (p05Rank.get(r) ?? 0);
  }
  const ranked = [...results].sort((a, b) => (a.rankScore ?? 0) - (b.rankScore ?? 0));
  ranked.forEach((r, i) => (r.rank = i + 1));
  return ranked;
}

/**
 * Run a full grid search. Returns configs ranked by the composite metric.
 */
export function runGridSearch(grid: ParamGrid, markets: CachedMarket[]): ConfigResult[] {
  const configs = expandGrid(grid);
  const results = configs.map((cfg) => runConfig(cfg, markets));
  return rankResults(results);
}

/**
 * Build a refinement grid around a winning config. For each numeric
 * parameter, includes the winner's value and a neighbourhood of alternatives.
 */
export function refineAround(winner: ConfigPoint, grid: ParamGrid): ParamGrid {
  const neighbours = <T>(field: T[], val: T): T[] => {
    const idx = field.indexOf(val);
    if (idx < 0) return [val, ...field].slice(0, 3);
    return Array.from(new Set([field[Math.max(0, idx - 1)]!, val, field[Math.min(field.length - 1, idx + 1)]!]));
  };
  return {
    halfSpreadTicks: neighbours(grid.halfSpreadTicks, winner.halfSpreadTicks),
    inventorySkewCents: neighbours(grid.inventorySkewCents, winner.inventorySkewCents),
    volMultiplier: neighbours(grid.volMultiplier, winner.volMultiplier),
    minOutcomeMid: neighbours(grid.minOutcomeMid, winner.minOutcomeMid),
    maxOutcomeMid: neighbours(grid.maxOutcomeMid, winner.maxOutcomeMid),
    maxForecastDivergence: neighbours(grid.maxForecastDivergence, winner.maxForecastDivergence),
    stopLossEnabled: [winner.stopLossEnabled],
    stopLossCatastrophicDropRatio: neighbours(grid.stopLossCatastrophicDropRatio, winner.stopLossCatastrophicDropRatio),
    stopLossDeepDropRatio: neighbours(grid.stopLossDeepDropRatio, winner.stopLossDeepDropRatio),
    orderSizeUsdc: neighbours(grid.orderSizeUsdc, winner.orderSizeUsdc),
    tpTicksBase: neighbours(grid.tpTicksBase, winner.tpTicksBase),
    tpVolMultiplier: neighbours(grid.tpVolMultiplier, winner.tpVolMultiplier)
  };
}
