#!/usr/bin/env node
/**
 * Weather-NO scalper backtest — the 0x937bcac3a8 pattern.
 *
 * Strategy: Place a maker BID at ~0.99 on weather markets approaching
 * resolution where NO is already priced 0.95+. If filled, post an ASK at
 * 0.999 to flip out. If not filled, the position resolves NO at $1 anyway.
 *
 * This script REUSES the existing MM backtest engine (src/simulation/backtest.ts)
 * by configuring it with weather-specific, high-price-band presets:
 *   - halfSpreadTicks small (1-2 ticks = 0.01-0.02 from the 0.99 mid)
 *   - tpTicksBase=1 (flip at bid+1tick)
 *   - outcome band 0.95-0.998
 *   - stop-loss enabled (catastrophic) so a market that genuinely surprises
 *     exits before eating the full 0.95 drawdown
 *
 * Data source: the resolved-market cache (same as backtest-restaker).
 * We pre-filter to weather category and NO-side tokens only.
 *
 * Usage
 * -----
 *   npm run backtest-scalper
 *   npm run backtest-scalper -- --top=5 --walk-folds=4
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  expandGrid,
  rankResults,
  refineAround,
  runGridSearch
} from "../dist/src/simulation/gridSearch.js";
import { walkForward } from "../dist/src/simulation/walkForward.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const topN = Number(args.top ?? "3");
const walkFolds = Number(args["walk-folds"] ?? "4");
const sideFilter = args.side ?? "NO"; // 937 is 96% BUY NO; default NO side
const outPath = args.out;

const CACHE_DIR = resolve("data/resolved-market-cache");

async function loadScalperMarkets() {
  let files;
  try {
    files = await readdir(CACHE_DIR);
  } catch (e) {
    console.error(`Cache directory not found: ${CACHE_DIR}`);
    console.error(`Run 'npm run fetch-resolved-markets -- --preset=weather' first.`);
    process.exit(1);
  }

  const markets = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(CACHE_DIR, f), "utf8"));
      if (!raw.samples || raw.samples.length < 30) continue;
      if ((raw.category ?? "").toLowerCase() !== "weather") continue;
      if (sideFilter !== "any" && raw.side !== sideFilter) continue;
      // Median price filter: the 937 strategy only quotes on markets whose
      // NO price has stabilised in the 0.90+ band. If median < 0.80 the
      // market wasn't in the scalping regime often enough.
      const sorted = [...raw.samples.map((s) => s.p)].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median < 0.80 || median > 0.999) continue;
      markets.push({
        tokenId: raw.tokenId,
        label: `${raw.title ?? raw.question ?? raw.conditionId} [${raw.side}]`,
        tickSize: raw.tickSize ?? 0.01,
        samples: raw.samples,
        medianPrice: median,
        resolutionOutcome: raw.tokenResolutionValue
      });
    } catch (_) { /* ignore malformed */ }
  }
  return markets;
}

function formatPct(x) { return `${(x * 100).toFixed(1)}%`; }

function formatCfg(c) {
  return (
    `ts=${c.halfSpreadTicks} sk=${c.inventorySkewCents} ` +
    `vol=${c.volMultiplier} band=${c.minOutcomeMid}-${c.maxOutcomeMid} ` +
    `sl=${c.stopLossEnabled ? "on" : "off"} drop=${c.stopLossCatastrophicDropRatio} ` +
    `$${c.orderSizeUsdc} tp=${c.tpTicksBase}`
  );
}

async function main() {
  console.log(`\nLoading weather-${sideFilter} markets from resolved cache...`);
  const markets = await loadScalperMarkets();
  if (markets.length < 10) {
    console.error(`Not enough markets (${markets.length}). Fetch more with:`);
    console.error(`  npm run fetch-resolved-markets -- --preset=weather --lookback-days=60 --max-events=500`);
    process.exit(1);
  }
  console.log(`  loaded ${markets.length} weather ${sideFilter}-side markets (median price in [0.80, 0.999])\n`);

  // Stage 1: coarse grid tuned for the top-of-book scalper. Small spreads,
  // tight TP, outcome band pinned to 0.90+.
  const grid = {
    halfSpreadTicks: [1, 2, 3],
    inventorySkewCents: [0, 1],
    volMultiplier: [0, 0.5],
    minOutcomeMid: [0.90, 0.93, 0.95],
    maxOutcomeMid: [0.998],
    maxForecastDivergence: [1.0], // effectively disabled; no forecast in scalper
    stopLossEnabled: [true],
    stopLossCatastrophicDropRatio: [0.3, 0.5],
    stopLossDeepDropRatio: [0.6],
    orderSizeUsdc: [5, 10, 20],
    tpTicksBase: [1, 2],
    tpVolMultiplier: [0],
    driftFilterEnabled: [false],
    driftFilterDownDriftCents: [2],
    driftFilterRatio: [1.2]
  };
  const configs = expandGrid(grid);
  console.log(`Stage 1: ${configs.length} configs × ${markets.length} markets = ${configs.length * markets.length} backtests`);
  const t1 = Date.now();
  const stage1 = runGridSearch(grid, markets);
  console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(1)}s\n`);

  console.log(`Stage 1 top 10:\n`);
  console.log(
    "rank".padEnd(5),
    "config".padEnd(75),
    "mean".padStart(9),
    "p05".padStart(9),
    "winRate".padStart(9),
    "rtrips".padStart(7),
    "n_mkts".padStart(7)
  );
  console.log("-".repeat(125));
  for (let i = 0; i < Math.min(10, stage1.length); i++) {
    const r = stage1[i];
    console.log(
      String(r.rank).padEnd(5),
      formatCfg(r.config).padEnd(75),
      `$${r.meanPnl.toFixed(4)}`.padStart(9),
      `$${r.p05.toFixed(2)}`.padStart(9),
      formatPct(r.winRate).padStart(9),
      String(r.totalRoundTrips).padStart(7),
      String(r.marketsUsed).padStart(7)
    );
  }

  // Stage 2: refine around top-N
  console.log(`\nStage 2: refining around top ${topN}...`);
  const refined = [];
  for (let i = 0; i < Math.min(topN, stage1.length); i++) {
    const refinedGrid = refineAround(stage1[i].config, grid);
    const subResults = runGridSearch(refinedGrid, markets);
    for (const r of subResults) refined.push(r);
  }
  const stage2 = rankResults(refined);
  console.log(`  ${refined.length} refined configs → top 10:\n`);
  console.log(
    "rank".padEnd(5),
    "config".padEnd(75),
    "mean".padStart(9),
    "p05".padStart(9),
    "winRate".padStart(9),
    "rtrips".padStart(7)
  );
  console.log("-".repeat(125));
  for (let i = 0; i < Math.min(10, stage2.length); i++) {
    const r = stage2[i];
    console.log(
      String(r.rank).padEnd(5),
      formatCfg(r.config).padEnd(75),
      `$${r.meanPnl.toFixed(4)}`.padStart(9),
      `$${r.p05.toFixed(2)}`.padStart(9),
      formatPct(r.winRate).padStart(9),
      String(r.totalRoundTrips).padStart(7)
    );
  }

  // Stage 3: walk-forward
  console.log(`\nStage 3: walk-forward (${walkFolds} folds) on top 20 stage-2 configs...\n`);
  const wfConfigs = stage2.slice(0, 20).map((r) => r.config);
  const wfResults = walkForward(wfConfigs, markets, walkFolds);
  console.log(
    "rank".padEnd(5),
    "config".padEnd(75),
    "OOS mean".padStart(10),
    "IS mean".padStart(10),
    "gap".padStart(9),
    "stab".padStart(6),
    "rtrips".padStart(7)
  );
  console.log("-".repeat(140));
  for (let i = 0; i < Math.min(10, wfResults.length); i++) {
    const r = wfResults[i];
    console.log(
      String(r.rank).padEnd(5),
      formatCfg(r.config).padEnd(75),
      `$${r.oosMeanPnl.toFixed(4)}`.padStart(10),
      `$${r.isMeanPnl.toFixed(4)}`.padStart(10),
      `$${r.trainTestGap.toFixed(4)}`.padStart(9),
      formatPct(r.stability).padStart(6),
      String(r.oosRoundTrips).padStart(7)
    );
  }

  const bestWf = wfResults[0];
  console.log(`\n=== SCALPER VERDICT ===`);
  console.log(`  best OOS config: ${formatCfg(bestWf.config)}`);
  console.log(`  OOS mean per market: $${bestWf.oosMeanPnl.toFixed(4)}`);
  console.log(`  OOS p05: $${bestWf.oosP05.toFixed(4)}`);
  console.log(`  train-test gap: $${bestWf.trainTestGap.toFixed(4)} (positive = overfitting)`);
  console.log(`  stability: ${formatPct(bestWf.stability)}`);
  console.log(`  OOS round-trips: ${bestWf.oosRoundTrips}`);

  // Rough extrapolation to daily PnL at $100. Assumes the best config trades
  // all markets in the sample over its window; scale by markets-per-day.
  const totalDailyMarkets = markets.length / 30; // proxy: 30-day window
  const expectedDailyAt100 = bestWf.oosMeanPnl * totalDailyMarkets * (100 / (bestWf.config.orderSizeUsdc || 10));
  console.log(`  rough expected daily at $100 capital: $${expectedDailyAt100.toFixed(2)}`);

  if (outPath) {
    await writeFile(
      resolve(outPath),
      JSON.stringify({ stage1Top: stage1.slice(0, 10), stage2Top: stage2.slice(0, 10), walkForward: wfResults, best: bestWf }, null, 2),
      "utf8"
    );
    console.log(`\nFull detail → ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
