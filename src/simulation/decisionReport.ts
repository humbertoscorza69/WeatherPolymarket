/**
 * Go/no-go decision report for the resolution-taker backtest pipeline.
 *
 * Consumes:
 *   - Deterministic backtest result (totalPnl, winRate, trade count, etc.)
 *   - Walk-forward result for the chosen config (OOS mean, gap, stability)
 *   - Monte Carlo distribution (confidence bands, prob_positive, per-capital)
 *
 * Produces a structured verdict (data + prose) covering:
 *   - Expected daily PnL with 90% CI at several capital tiers
 *   - Overfitting risk (walk-forward gap + stability)
 *   - Capital floor (below which expected daily < transaction cost)
 *   - Recommendation: DEPLOY / DRY_RUN / REJECT with reasons
 *
 * The thresholds are documented here, not hidden as magic numbers, because
 * the whole point of this procedure is to make the go/no-go legible and
 * reproducible.
 */

import type { ResolutionTakerConfig, ResolutionTakerBacktestResult } from "./resolutionTakerBacktest.js";
import type { MonteCarloReport } from "./monteCarloAnalysis.js";
import type { TakerWalkForwardResult } from "./resolutionTakerWalkForward.js";

export type Verdict = "DEPLOY" | "DRY_RUN" | "REJECT";

export interface DecisionThresholds {
  /** Minimum MC prob(totalPnl > 0) to be eligible for DEPLOY. */
  minProbPositive: number;
  /** Maximum walk-forward train-test gap (in per-trade PnL). Larger = more
   *  overfitting risk. */
  maxTrainTestGap: number;
  /** Minimum walk-forward stability (0–1). Below this = unstable winner. */
  minStability: number;
  /** Minimum p05 of daily PnL per $100 at the user's target capital. If
   *  the 5th percentile is deeply negative, the tail risk is not acceptable. */
  minDailyP05Per100Usdc: number;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  minProbPositive: 0.65,
  maxTrainTestGap: 0.50,
  minStability: 0.50,
  minDailyP05Per100Usdc: -0.05
};

export interface DecisionReport {
  verdict: Verdict;
  reasons: string[];
  warnings: string[];
  config: ResolutionTakerConfig;
  backtest: {
    trades: number;
    marketsEntered: number;
    totalPnl: number;
    meanPnl: number;
    winRate: number;
  };
  walkForward: {
    oosMeanPnl: number;
    isMeanPnl: number;
    trainTestGap: number;
    stability: number;
    oosTrades: number;
  };
  monteCarlo: {
    totalPnlMean: number;
    totalPnlP05: number;
    totalPnlP95: number;
    probPositive: number;
    dailyPnlPer100Mean: number;
    dailyPnlPer100P05: number;
    dailyPnlPer100P95: number;
  };
  expectedByCapital: { capital: number; meanMonthly: number; p05Monthly: number; p95Monthly: number }[];
  capitalFloor: number | null;
}

export function generateDecisionReport(
  config: ResolutionTakerConfig,
  backtest: ResolutionTakerBacktestResult,
  walkForward: TakerWalkForwardResult,
  monteCarlo: MonteCarloReport,
  thresholds: DecisionThresholds = DEFAULT_THRESHOLDS
): DecisionReport {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const expectedByCapital = monteCarlo.expectedDailyByCapital.map((tier) => ({
    capital: tier.capital,
    meanMonthly: tier.meanDaily * 30,
    p05Monthly: tier.p05Daily * 30,
    p95Monthly: tier.p95Daily * 30
  }));

  const capitalFloor = (() => {
    // Find the smallest capital tier where mean daily > estimated gas cost
    // proxy ($0.30/day in maker activity). If none, return null.
    const target = 0.30;
    for (const tier of monteCarlo.expectedDailyByCapital) {
      if (tier.meanDaily > target) return tier.capital;
    }
    return null;
  })();

  // Rule 1 — probPositive gate
  if (monteCarlo.totalPnl.probPositive < thresholds.minProbPositive) {
    reasons.push(
      `MC prob(total PnL > 0) = ${(monteCarlo.totalPnl.probPositive * 100).toFixed(0)}% < ${(thresholds.minProbPositive * 100).toFixed(0)}%`
    );
  }

  // Rule 2 — walk-forward gap gate
  if (walkForward.trainTestGap > thresholds.maxTrainTestGap) {
    reasons.push(
      `walk-forward train-test gap = $${walkForward.trainTestGap.toFixed(2)}/trade > $${thresholds.maxTrainTestGap.toFixed(2)} — overfitting risk`
    );
  }

  // Rule 3 — walk-forward stability gate
  if (walkForward.stability < thresholds.minStability) {
    reasons.push(
      `walk-forward stability = ${(walkForward.stability * 100).toFixed(0)}% < ${(thresholds.minStability * 100).toFixed(0)}% — unstable winner`
    );
  }

  // Rule 4 — daily p05 tail gate
  if (monteCarlo.dailyPnlPer100Usdc.p05 < thresholds.minDailyP05Per100Usdc) {
    reasons.push(
      `MC daily p05 per $100 = $${monteCarlo.dailyPnlPer100Usdc.p05.toFixed(3)} < $${thresholds.minDailyP05Per100Usdc.toFixed(3)} — unacceptable tail`
    );
  }

  // Soft warnings (don't block deploy but surface them)
  if (backtest.trades.length < 50) {
    warnings.push(`only ${backtest.trades.length} trades — sample too small for confident statistics`);
  }
  if (monteCarlo.dailyPnlPer100Usdc.mean < 0.02) {
    warnings.push(
      `mean daily per $100 = $${monteCarlo.dailyPnlPer100Usdc.mean.toFixed(3)} — will be dwarfed by fees on small capital`
    );
  }
  if (walkForward.oosTrades < 20) {
    warnings.push(`walk-forward OOS trades = ${walkForward.oosTrades} — stability estimate unreliable`);
  }

  const verdict: Verdict = reasons.length === 0 ? "DEPLOY" : reasons.length <= 1 ? "DRY_RUN" : "REJECT";

  return {
    verdict,
    reasons,
    warnings,
    config,
    backtest: {
      trades: backtest.trades.length,
      marketsEntered: backtest.marketsEntered,
      totalPnl: backtest.totalPnlUsdc,
      meanPnl: backtest.meanPnl,
      winRate: backtest.winRate
    },
    walkForward: {
      oosMeanPnl: walkForward.oosMeanPnl,
      isMeanPnl: walkForward.isMeanPnl,
      trainTestGap: walkForward.trainTestGap,
      stability: walkForward.stability,
      oosTrades: walkForward.oosTrades
    },
    monteCarlo: {
      totalPnlMean: monteCarlo.totalPnl.mean,
      totalPnlP05: monteCarlo.totalPnl.p05,
      totalPnlP95: monteCarlo.totalPnl.p95,
      probPositive: monteCarlo.totalPnl.probPositive,
      dailyPnlPer100Mean: monteCarlo.dailyPnlPer100Usdc.mean,
      dailyPnlPer100P05: monteCarlo.dailyPnlPer100Usdc.p05,
      dailyPnlPer100P95: monteCarlo.dailyPnlPer100Usdc.p95
    },
    expectedByCapital,
    capitalFloor
  };
}

export function formatReport(report: DecisionReport): string {
  const lines: string[] = [];
  const verdictBadge = report.verdict === "DEPLOY" ? "✓ DEPLOY" : report.verdict === "DRY_RUN" ? "~ DRY-RUN" : "✗ REJECT";
  lines.push(`\n========================================================`);
  lines.push(`  RESOLUTION TAKER — DECISION: ${verdictBadge}`);
  lines.push(`========================================================\n`);
  lines.push(`CONFIG`);
  lines.push(`  entry band:    [${report.config.entryPriceMin}, ${report.config.entryPriceMax}]`);
  lines.push(`  hold window:   ${report.config.minTimeToResolutionHours}h — ${report.config.maxHoldHours}h before resolution`);
  lines.push(`  order size:    $${report.config.orderSizeUsdc}`);
  lines.push(`  fill prob:     ${(report.config.fillProbability * 100).toFixed(0)}%`);
  lines.push(`  taker fee:     ${(report.config.takerFeeRate * 100).toFixed(2)}%`);
  lines.push(`  max concurrent: ${report.config.maxConcurrentPositions}`);
  lines.push("");
  lines.push(`DETERMINISTIC BACKTEST`);
  lines.push(`  trades:        ${report.backtest.trades}`);
  lines.push(`  markets entered: ${report.backtest.marketsEntered}`);
  lines.push(`  total PnL:     $${report.backtest.totalPnl.toFixed(2)}`);
  lines.push(`  mean per trade: $${report.backtest.meanPnl.toFixed(4)}`);
  lines.push(`  win rate:      ${(report.backtest.winRate * 100).toFixed(1)}%`);
  lines.push("");
  lines.push(`WALK-FORWARD CROSS-VALIDATION`);
  lines.push(`  IS mean/trade: $${report.walkForward.isMeanPnl.toFixed(4)}`);
  lines.push(`  OOS mean/trade: $${report.walkForward.oosMeanPnl.toFixed(4)}`);
  lines.push(`  train-test gap: $${report.walkForward.trainTestGap.toFixed(4)} (positive = overfitting)`);
  lines.push(`  stability:     ${(report.walkForward.stability * 100).toFixed(0)}% (rank-1 lands in test top-10%)`);
  lines.push(`  OOS trades:    ${report.walkForward.oosTrades}`);
  lines.push("");
  lines.push(`MONTE CARLO (${report.monteCarlo.probPositive >= 0 ? "uncertainty-weighted" : ""})`);
  lines.push(`  prob(total PnL > 0): ${(report.monteCarlo.probPositive * 100).toFixed(1)}%`);
  lines.push(`  total PnL mean:   $${report.monteCarlo.totalPnlMean.toFixed(2)}  [p05=$${report.monteCarlo.totalPnlP05.toFixed(2)}  p95=$${report.monteCarlo.totalPnlP95.toFixed(2)}]`);
  lines.push(`  daily per $100: mean=$${report.monteCarlo.dailyPnlPer100Mean.toFixed(3)}  [p05=$${report.monteCarlo.dailyPnlPer100P05.toFixed(3)}  p95=$${report.monteCarlo.dailyPnlPer100P95.toFixed(3)}]`);
  lines.push("");
  lines.push(`EXPECTED MONTHLY PnL BY CAPITAL TIER`);
  lines.push(`  ${"capital".padStart(10)} ${"p05/mo".padStart(10)} ${"mean/mo".padStart(10)} ${"p95/mo".padStart(10)}`);
  for (const tier of report.expectedByCapital) {
    lines.push(
      `  ${("$" + tier.capital).padStart(10)} ${("$" + tier.p05Monthly.toFixed(0)).padStart(10)} ${("$" + tier.meanMonthly.toFixed(0)).padStart(10)} ${("$" + tier.p95Monthly.toFixed(0)).padStart(10)}`
    );
  }
  if (report.capitalFloor) {
    lines.push(`\n  Capital floor (above which mean daily > $0.30): $${report.capitalFloor}`);
  } else {
    lines.push(`\n  Capital floor: never clears $0.30/day — strategy uneconomical at any bankroll`);
  }
  lines.push("");
  if (report.reasons.length > 0) {
    lines.push(`BLOCKING REASONS (${report.reasons.length})`);
    for (const r of report.reasons) lines.push(`  ✗ ${r}`);
    lines.push("");
  }
  if (report.warnings.length > 0) {
    lines.push(`WARNINGS (${report.warnings.length})`);
    for (const w of report.warnings) lines.push(`  ⚠ ${w}`);
    lines.push("");
  }
  lines.push(`========================================================\n`);
  return lines.join("\n");
}
