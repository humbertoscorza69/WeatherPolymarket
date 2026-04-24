/**
 * Monte Carlo uncertainty analysis for the resolution-taker backtest.
 *
 * The deterministic backtest produces a single PnL number. That number is
 * near-useless for a go/no-go decision because:
 *
 *   - The fill-probability assumption is uncertain (we don't actually know
 *     what fraction of in-band samples we'd have captured live).
 *   - Entry slippage is uncertain (the sample tells us the mid, not the
 *     best ask, which is what we'd actually pay).
 *   - The fee regime can change.
 *   - The 90-day backtest is itself a single draw from the market's
 *     joint distribution.
 *
 * Two MC techniques, chained:
 *
 *   (1) PARAMETER PERTURBATION — for each replay, draw fillProbability,
 *       entry slippage, and fee from user-provided ranges. This spreads
 *       the deterministic PnL across the plausible range of live conditions.
 *
 *   (2) TRADE BOOTSTRAP — resample the (perturbed) trade list with
 *       replacement to measure the distributional uncertainty around the
 *       mean daily PnL. This is the classical bootstrap; it tells us
 *       "if I ran this strategy on a different 90-day window drawn from
 *       the same distribution, what's the plausible range of outcomes?"
 *
 * Output: PnL distribution + prob(positive) + daily expected at several
 * capital tiers. That's the data the go/no-go report consumes.
 */

import type {
  ResolvedMarketSamples,
  ResolutionTakerConfig,
  ResolutionTakerTrade
} from "./resolutionTakerBacktest.js";
import { runResolutionTakerBacktest } from "./resolutionTakerBacktest.js";

export interface MonteCarloAssumptions {
  /** [min, max] range for the fill-probability knob per replay. */
  fillProbabilityRange: [number, number];
  /** [min, max] additive ticks of slippage on every entry price. Positive =
   *  we pay more than the sample's mid. Expressed in PRICE units (e.g. 0.005
   *  = half a cent). */
  entrySlippageRange: [number, number];
  /** [min, max] taker fee rate (fraction). */
  takerFeeRateRange: [number, number];
  /** Number of parameter-perturbation replays. */
  replays: number;
  /** Number of bootstrap resamples PER replay of the accepted trade list. */
  bootstrapSamples: number;
  /** Master RNG seed so results are reproducible. */
  seed: number;
}

export interface MonteCarloDistribution {
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
  std: number;
  probPositive: number;
}

export interface MonteCarloReport {
  /** Distribution of TOTAL PnL (USDC) over the backtest window across all replays × bootstraps. */
  totalPnl: MonteCarloDistribution;
  /** Distribution of MEAN per-trade PnL across replays. */
  perTradePnl: MonteCarloDistribution;
  /** Daily PnL distribution expressed per $100 of capital. Useful for scaling. */
  dailyPnlPer100Usdc: MonteCarloDistribution;
  /** Expected daily PnL at specific capital tiers (linear scaling assumption). */
  expectedDailyByCapital: { capital: number; meanDaily: number; p05Daily: number; p95Daily: number }[];
  /** Summary of replay-level stats — useful for diagnostic and plotting. */
  replays: ReplaySummary[];
}

export interface ReplaySummary {
  fillProbability: number;
  entrySlippage: number;
  takerFeeRate: number;
  trades: number;
  totalPnl: number;
  winRate: number;
  meanPnl: number;
}

function xorshift32(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function uniform(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function percentiles(values: number[]): MonteCarloDistribution {
  if (values.length === 0) {
    return { p05: 0, p25: 0, p50: 0, p75: 0, p95: 0, mean: 0, std: 0, probPositive: 0 };
  }
  const s = [...values].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * q)))]!;
  const mean = values.reduce((sum, x) => sum + x, 0) / values.length;
  const variance = values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / values.length;
  const probPositive = values.filter((x) => x > 0).length / values.length;
  return {
    p05: pick(0.05),
    p25: pick(0.25),
    p50: pick(0.5),
    p75: pick(0.75),
    p95: pick(0.95),
    mean,
    std: Math.sqrt(variance),
    probPositive
  };
}

/**
 * Apply per-replay perturbations to the strategy config + produced trades.
 * Slippage is applied by reducing each trade's effective entry-to-exit gap
 * by `slippage × shares` (we paid slippage more per share than the mid).
 * Fee perturbation scales the fee component.
 */
function perturbTrades(
  baseTrades: ResolutionTakerTrade[],
  slippage: number,
  feeRate: number
): ResolutionTakerTrade[] {
  return baseTrades.map((t) => {
    const adjustedEntryPrice = Math.min(0.9999, t.entryPrice + slippage);
    const notional = t.shares * adjustedEntryPrice;
    const fee = notional * feeRate;
    const grossPnl = t.shares * (t.resolutionValue - adjustedEntryPrice);
    return {
      ...t,
      entryPrice: adjustedEntryPrice,
      notionalUsdc: notional,
      feeUsdc: fee,
      pnlUsdc: grossPnl - fee,
      won: grossPnl - fee > 0
    };
  });
}

function bootstrap(trades: ResolutionTakerTrade[], samples: number, rng: () => number): number[] {
  if (trades.length === 0) return Array(samples).fill(0);
  const totals: number[] = [];
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let j = 0; j < trades.length; j++) {
      const idx = Math.floor(rng() * trades.length);
      sum += trades[idx]!.pnlUsdc;
    }
    totals.push(sum);
  }
  return totals;
}

function spanDays(trades: ResolutionTakerTrade[]): number {
  if (trades.length === 0) return 1;
  const ts = trades.map((t) => t.entryTs);
  const span = (Math.max(...ts) - Math.min(...ts)) / 86400;
  return Math.max(1, span);
}

export function runMonteCarlo(
  markets: ResolvedMarketSamples[],
  baseConfig: ResolutionTakerConfig,
  assumptions: MonteCarloAssumptions,
  capitalTiers: number[] = [100, 500, 1_000, 5_000, 10_000]
): MonteCarloReport {
  const rng = xorshift32(assumptions.seed);
  const allTotalPnls: number[] = [];
  const allPerTradePnls: number[] = [];
  const dailyPer100: number[] = [];
  const replays: ReplaySummary[] = [];

  for (let r = 0; r < assumptions.replays; r++) {
    const fillProb = uniform(rng, assumptions.fillProbabilityRange[0], assumptions.fillProbabilityRange[1]);
    const slip = uniform(rng, assumptions.entrySlippageRange[0], assumptions.entrySlippageRange[1]);
    const feeRate = uniform(rng, assumptions.takerFeeRateRange[0], assumptions.takerFeeRateRange[1]);

    const cfg: ResolutionTakerConfig = {
      ...baseConfig,
      fillProbability: fillProb,
      takerFeeRate: feeRate
    };

    const result = runResolutionTakerBacktest(markets, cfg, (assumptions.seed * 31 + r) | 0);
    const perturbed = perturbTrades(result.trades, slip, feeRate);
    const totalPnl = perturbed.reduce((s, t) => s + t.pnlUsdc, 0);
    const wins = perturbed.filter((t) => t.won).length;
    const meanPnl = perturbed.length > 0 ? totalPnl / perturbed.length : 0;
    const days = spanDays(perturbed);
    const capitalDeployedUsdc = Math.max(1, baseConfig.orderSizeUsdc * baseConfig.maxConcurrentPositions);
    const dailyPerUsdc = totalPnl / days / capitalDeployedUsdc;
    dailyPer100.push(dailyPerUsdc * 100);

    const bootstrapped = bootstrap(perturbed, assumptions.bootstrapSamples, rng);
    allTotalPnls.push(...bootstrapped);
    for (const t of perturbed) allPerTradePnls.push(t.pnlUsdc);

    replays.push({
      fillProbability: fillProb,
      entrySlippage: slip,
      takerFeeRate: feeRate,
      trades: perturbed.length,
      totalPnl,
      winRate: perturbed.length > 0 ? wins / perturbed.length : 0,
      meanPnl
    });
  }

  const totalDist = percentiles(allTotalPnls);
  const perTradeDist = percentiles(allPerTradePnls);
  const dailyDist = percentiles(dailyPer100);

  const expectedDailyByCapital = capitalTiers.map((cap) => ({
    capital: cap,
    meanDaily: (dailyDist.mean * cap) / 100,
    p05Daily: (dailyDist.p05 * cap) / 100,
    p95Daily: (dailyDist.p95 * cap) / 100
  }));

  return {
    totalPnl: totalDist,
    perTradePnl: perTradeDist,
    dailyPnlPer100Usdc: dailyDist,
    expectedDailyByCapital,
    replays
  };
}
