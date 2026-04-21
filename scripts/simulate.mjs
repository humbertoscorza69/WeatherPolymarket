#!/usr/bin/env node
/**
 * Monte Carlo parameter sweep for the weather market maker.
 *
 * Usage:
 *   npm run simulate [episodes=1000]
 *
 * Runs a grid of strategy variants across mixed-regime and pure-adverse
 * scenarios. Prints a comparison table and the MC-best default picks.
 */

import { runBatch } from "../dist/src/simulation/marketMakerSim.js";

const EPISODES = Number(process.argv[2] ?? "1000");

function mixedScenarioFactory() {
  return () => {
    const regimeRoll = Math.random();
    const pTrue = Math.random();
    let initialMid, midDriftBiasPerHour, midVolPerHour;

    if (regimeRoll < 0.6) {
      // Friendly
      initialMid = clamp(pTrue + (Math.random() - 0.5) * 0.1, 0.03, 0.97);
      midDriftBiasPerHour = 0.3 + Math.random() * 0.4;
      midVolPerHour = 0.015 + Math.random() * 0.015;
    } else if (regimeRoll < 0.85) {
      // Stale
      initialMid = clamp(pTrue + (Math.random() - 0.5) * 0.25, 0.03, 0.97);
      midDriftBiasPerHour = 0.02 + Math.random() * 0.05;
      midVolPerHour = 0.02 + Math.random() * 0.02;
    } else {
      // Adverse: start far, mid reverts fast
      const awayDir = Math.random() < 0.5 ? -1 : 1;
      initialMid = clamp(pTrue + awayDir * (0.15 + Math.random() * 0.15), 0.03, 0.97);
      midDriftBiasPerHour = 0.6 + Math.random() * 0.6;
      midVolPerHour = 0.02 + Math.random() * 0.025;
    }

    return {
      pTrue,
      initialMid,
      midDriftBiasPerHour,
      midVolPerHour,
      spreadCentsBid: 2 + Math.random() * 2,
      bookQueueDepth: 5 + Math.random() * 20,
      orderArrivalsPerMinute: 0.5 + Math.random() * 2.5,
      sessionHours: 10,
      timeStepSec: 30,
      volClustering: true,
      informedFraction: 0.1 + Math.random() * 0.15 // 10-25% of flow is informed
    };
  };
}

function adverseScenarioFactory() {
  return () => {
    const pTrue = Math.random() * 0.4;
    const away = 0.15 + Math.random() * 0.15;
    return {
      pTrue,
      initialMid: clamp(pTrue + away, 0.03, 0.97),
      midDriftBiasPerHour: 0.8 + Math.random() * 0.6,
      midVolPerHour: 0.02 + Math.random() * 0.02,
      spreadCentsBid: 2 + Math.random() * 2,
      bookQueueDepth: 5 + Math.random() * 10,
      orderArrivalsPerMinute: 1 + Math.random() * 2,
      sessionHours: 10,
      timeStepSec: 30,
      volClustering: true,
      informedFraction: 0.25 + Math.random() * 0.25 // adverse regimes: 25-50% informed flow
    };
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

const baseStopLoss = {
  enabled: true,
  catastrophicDropRatio: 0.3,
  deepDropRatio: 0.6,
  deepDropMaxMinutes: 120,
  resolutionStopHours: 1,
  resolutionDropRatio: 0.7,
  maxHoldingHours: 12,
  makerExitWaitSeconds: 90
};

const baseParams = {
  halfSpreadCents: 1,
  inventorySkewCents: 2,
  volMultiplier: 0,
  volMaxExtraCents: 3,
  volWindowSize: 60,
  orderSizeUsdc: 2,
  tickSize: 0.01,
  minShares: 5,
  refreshIntervalSec: 30,
  maxInventoryPositions: 10,
  stopLoss: baseStopLoss,
  takerFeeRate: 0.0125,
  makerRebateRate: 0.003125
};

const variants = [
  { name: "baseline (1¢, no features)", params: { ...baseParams, inventorySkewCents: 0, stopLoss: { ...baseStopLoss, enabled: false } } },
  { name: "SL only (taker)", params: { ...baseParams, inventorySkewCents: 0 } },
  { name: "SL hybrid (maker→taker)", params: { ...baseParams, inventorySkewCents: 0, stopLoss: { ...baseStopLoss, makerExitWaitSeconds: 90 } } },
  { name: "skew 2¢ + SL hybrid", params: { ...baseParams } },
  { name: "skew 2¢ + SL + vol×0.5", params: { ...baseParams, volMultiplier: 0.5 } },
  { name: "skew 2¢ + SL + vol×1.0", params: { ...baseParams, volMultiplier: 1.0 } },
  { name: "skew 2¢ + SL + vol×2.0", params: { ...baseParams, volMultiplier: 2.0 } },
  { name: "wider 2¢ + SL + vol×0.5", params: { ...baseParams, halfSpreadCents: 2, volMultiplier: 0.5 } },
  { name: "aggressive 0¢ + SL", params: { ...baseParams, halfSpreadCents: 0, inventorySkewCents: 0 } }
];

function printHeader() {
  console.log(
    "strategy".padEnd(32),
    "mean".padStart(7),
    "median".padStart(7),
    "std".padStart(6),
    "win%".padStart(6),
    "p05".padStart(7),
    "p95".padStart(6),
    "rtrips".padStart(7),
    "stops".padStart(6),
    "mkrSL".padStart(5),
    "takSL".padStart(5),
    "lp$".padStart(6)
  );
  console.log("-".repeat(115));
}

function printRow(r) {
  console.log(
    r.strategy.padEnd(32),
    fmt(r.meanPnl).padStart(7),
    fmt(r.medianPnl).padStart(7),
    fmt(r.stdPnl).padStart(6),
    fmt(r.winRate * 100, 1).padStart(6),
    fmt(r.percentile5).padStart(7),
    fmt(r.percentile95).padStart(6),
    fmt(r.meanRoundTrips, 2).padStart(7),
    fmt(r.meanStopLosses, 2).padStart(6),
    fmt(r.meanStopLossMaker, 2).padStart(5),
    fmt(r.meanStopLossTaker, 2).padStart(5),
    fmt(r.meanLpRewards, 3).padStart(6)
  );
}

function fmt(n, d = 3) {
  return Number(n).toFixed(d);
}

console.log(
  `\nRunning ${EPISODES} episodes per strategy across ${variants.length} variants.\n`
);
console.log("Mixed regime: 60% friendly / 25% stale / 15% adverse + informed traders + vol clustering.\n");

printHeader();
const mixedResults = variants.map((v) => runBatch(v.name, v.params, mixedScenarioFactory(), EPISODES));
mixedResults.forEach(printRow);

console.log(
  "\nPure-adverse stress (where stop-loss earns its keep):\n"
);
printHeader();
const adverseResults = variants.map((v) =>
  runBatch(v.name, v.params, adverseScenarioFactory(), Math.min(EPISODES, 3000))
);
adverseResults.forEach(printRow);

// Recommendation logic: pick best Sharpe-ish (mean / std) from adverse batch
// (because that's where downside protection matters and mixed batches look similar).
const scored = adverseResults
  .map((r) => ({
    name: r.strategy,
    mean: r.meanPnl,
    sharpe: r.meanPnl / Math.max(0.01, r.stdPnl),
    p05: r.percentile5
  }))
  .sort((a, b) => b.sharpe - a.sharpe);

console.log("\nTop 3 by adverse-regime Sharpe (mean/std):");
for (let i = 0; i < Math.min(3, scored.length); i++) {
  console.log(
    `  ${i + 1}. ${scored[i].name.padEnd(32)} Sharpe=${scored[i].sharpe.toFixed(3)}  mean=$${scored[i].mean.toFixed(3)}  p05=$${scored[i].p05.toFixed(3)}`
  );
}

const topByP05 = [...adverseResults].sort((a, b) => b.percentile5 - a.percentile5);
console.log("\nTop 3 by adverse p05 (downside protection):");
for (let i = 0; i < Math.min(3, topByP05.length); i++) {
  console.log(
    `  ${i + 1}. ${topByP05[i].strategy.padEnd(32)} p05=$${topByP05[i].percentile5.toFixed(3)}  mean=$${topByP05[i].meanPnl.toFixed(3)}`
  );
}
