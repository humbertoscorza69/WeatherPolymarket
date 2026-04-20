#!/usr/bin/env node
/**
 * Monte Carlo parameter sweep for the weather market maker.
 *
 * Usage:
 *   npm run build && node scripts/simulate.mjs [episodes=1000]
 *
 * Output: a table comparing strategy variants across meanPnL, winRate,
 * drawdown, and round-trip count. Used to tune defaults before live trading.
 */

import { runBatch } from "../dist/src/simulation/marketMakerSim.js";

const EPISODES = Number(process.argv[2] ?? "1000");

function scenarioFactory() {
  // Mixed-regime scenario generator. Each episode samples one of:
  //   (A) friendly  — mid drifts toward p_true, modest vol
  //   (B) stale     — mid is wrong and barely moves
  //   (C) adverse   — mid drifts AWAY from p_true for a while, then corrects.
  //       This is the regime where market makers get stuck with inventory
  //       that converges below entry. Rare in weather markets but important
  //       to model for the stop-loss comparison.
  return () => {
    const regimeRoll = Math.random();
    const pTrue = Math.random();

    let initialMid;
    let midDriftBiasPerHour;
    let midVolPerHour;

    if (regimeRoll < 0.6) {
      // A: Friendly — 60% of episodes
      initialMid = clamp(pTrue + (Math.random() - 0.5) * 0.1, 0.03, 0.97);
      midDriftBiasPerHour = 0.3 + Math.random() * 0.4;
      midVolPerHour = 0.015 + Math.random() * 0.015;
    } else if (regimeRoll < 0.85) {
      // B: Stale — 25% of episodes
      initialMid = clamp(pTrue + (Math.random() - 0.5) * 0.25, 0.03, 0.97);
      midDriftBiasPerHour = 0.02 + Math.random() * 0.05;
      midVolPerHour = 0.02 + Math.random() * 0.02;
    } else {
      // C: Adverse — 15% of episodes. Initial mid is far from p_true, market
      // reverts toward p_true quickly. Our BUY near initial_mid gets stuck
      // above the corrected price. This is the classic MM inventory trap
      // that the stop-loss exists to protect against.
      const awayDir = Math.random() < 0.5 ? -1 : 1;
      initialMid = clamp(pTrue + awayDir * (0.15 + Math.random() * 0.15), 0.03, 0.97);
      midDriftBiasPerHour = 0.6 + Math.random() * 0.6; // fast convergence
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
      timeStepSec: 30
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
  maxHoldingHours: 12
};

const variants = [
  {
    name: "baseline (1¢, no skew, no SL)",
    params: {
      halfSpreadCents: 1,
      inventorySkewCents: 0,
      orderSizeUsdc: 2,
      tickSize: 0.01,
      minShares: 5,
      refreshIntervalSec: 30,
      maxInventoryPositions: 10,
      stopLoss: { ...baseStopLoss, enabled: false },
      takerFeeRate: 0.0125,
      makerRebateRate: 0.003125
    }
  },
  {
    name: "stop-loss ON",
    params: {
      halfSpreadCents: 1,
      inventorySkewCents: 0,
      orderSizeUsdc: 2,
      tickSize: 0.01,
      minShares: 5,
      refreshIntervalSec: 30,
      maxInventoryPositions: 10,
      stopLoss: { ...baseStopLoss, enabled: true },
      takerFeeRate: 0.0125,
      makerRebateRate: 0.003125
    }
  },
  {
    name: "inventory skew 2¢",
    params: {
      halfSpreadCents: 1,
      inventorySkewCents: 2,
      orderSizeUsdc: 2,
      tickSize: 0.01,
      minShares: 5,
      refreshIntervalSec: 30,
      maxInventoryPositions: 10,
      stopLoss: { ...baseStopLoss, enabled: true },
      takerFeeRate: 0.0125,
      makerRebateRate: 0.003125
    }
  },
  {
    name: "wider 2¢ spread",
    params: {
      halfSpreadCents: 2,
      inventorySkewCents: 0,
      orderSizeUsdc: 2,
      tickSize: 0.01,
      minShares: 5,
      refreshIntervalSec: 30,
      maxInventoryPositions: 10,
      stopLoss: { ...baseStopLoss, enabled: true },
      takerFeeRate: 0.0125,
      makerRebateRate: 0.003125
    }
  },
  {
    name: "combo (1¢ + skew 2¢ + SL)",
    params: {
      halfSpreadCents: 1,
      inventorySkewCents: 2,
      orderSizeUsdc: 2,
      tickSize: 0.01,
      minShares: 5,
      refreshIntervalSec: 30,
      maxInventoryPositions: 10,
      stopLoss: { ...baseStopLoss, enabled: true },
      takerFeeRate: 0.0125,
      makerRebateRate: 0.003125
    }
  },
  {
    name: "aggressive (0-cent, no SL)",
    params: {
      halfSpreadCents: 0,
      inventorySkewCents: 0,
      orderSizeUsdc: 2,
      tickSize: 0.01,
      minShares: 5,
      refreshIntervalSec: 30,
      maxInventoryPositions: 10,
      stopLoss: { ...baseStopLoss, enabled: false },
      takerFeeRate: 0.0125,
      makerRebateRate: 0.003125
    }
  },
  {
    name: "conservative (3¢ + skew 3¢ + SL + 5 max)",
    params: {
      halfSpreadCents: 3,
      inventorySkewCents: 3,
      orderSizeUsdc: 2,
      tickSize: 0.01,
      minShares: 5,
      refreshIntervalSec: 30,
      maxInventoryPositions: 5,
      stopLoss: { ...baseStopLoss, enabled: true },
      takerFeeRate: 0.0125,
      makerRebateRate: 0.003125
    }
  }
];

console.log(
  `Running ${EPISODES} episodes per strategy across ${variants.length} variants...\n`
);
console.log(
  "Regime mix: 60% friendly, 25% stale, 15% adverse (mid starts far from p_true and reverts)."
);
console.log(
  "Adverse is where stop-loss + inventory skew earn their keep.\n"
);

const results = variants.map((v) => runBatch(v.name, v.params, scenarioFactory(), EPISODES));

function fmt(n, digits = 3) {
  return Number(n).toFixed(digits).padStart(8);
}

console.log(
  "strategy".padEnd(38),
  "mean".padStart(8),
  "median".padStart(8),
  "std".padStart(8),
  "win%".padStart(7),
  "p05".padStart(8),
  "p95".padStart(8),
  "rtrips".padStart(7),
  "stops".padStart(6),
  "lp$".padStart(7)
);
console.log("-".repeat(110));
for (const r of results) {
  console.log(
    r.strategy.padEnd(38),
    fmt(r.meanPnl),
    fmt(r.medianPnl),
    fmt(r.stdPnl),
    fmt(r.winRate * 100, 1).padStart(7),
    fmt(r.percentile5),
    fmt(r.percentile95),
    fmt(r.meanRoundTrips, 2).padStart(7),
    fmt(r.meanStopLosses, 2).padStart(6),
    fmt(r.meanLpRewards, 3).padStart(7)
  );
}

// Pick the winner by mean PnL
const best = [...results].sort((a, b) => b.meanPnl - a.meanPnl)[0];
console.log(
  `\nBest strategy by mean P&L: ${best.strategy} → $${best.meanPnl.toFixed(3)} per session`
);

// Also report best by Sharpe-like ratio (mean / std)
const bestBySharpe = [...results].sort(
  (a, b) => b.meanPnl / (b.stdPnl || 1) - a.meanPnl / (a.stdPnl || 1)
)[0];
console.log(
  `Best strategy by mean/std:   ${bestBySharpe.strategy} → Sharpe=${(
    bestBySharpe.meanPnl / (bestBySharpe.stdPnl || 1)
  ).toFixed(3)}`
);

// Pure-adverse sweep so stop-loss impact is visible
console.log("\n\nPURE-ADVERSE stress test (initialMid far from p_true, fast convergence):");
const adverseFactory = () => () => {
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
    timeStepSec: 30
  };
};

const adverseResults = variants.map((v) =>
  runBatch(v.name, v.params, adverseFactory(), Math.min(EPISODES, 2000))
);
console.log(
  "strategy".padEnd(38),
  "mean".padStart(8),
  "std".padStart(8),
  "win%".padStart(7),
  "p05".padStart(8),
  "stops".padStart(7)
);
console.log("-".repeat(85));
for (const r of adverseResults) {
  console.log(
    r.strategy.padEnd(38),
    fmt(r.meanPnl),
    fmt(r.stdPnl),
    fmt(r.winRate * 100, 1).padStart(7),
    fmt(r.percentile5),
    fmt(r.meanStopLosses, 2).padStart(7)
  );
}
