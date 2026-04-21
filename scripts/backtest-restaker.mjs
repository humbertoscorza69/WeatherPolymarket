#!/usr/bin/env node
/**
 * End-to-end quant procedure for the resolution-taker strategy.
 *
 *   1. Load resolved-market cache (previously built with fetch-resolved-markets).
 *   2. Stage 1: coarse grid search over entry band / hold window / fill prob /
 *      concurrency. Composite rank across markets; keep top-N winners.
 *   3. Stage 2: refine around each winner (neighbourhood grid) and re-rank.
 *   4. Stage 3: walk-forward cross-validation on the top stage-2 configs.
 *      Sorts by OOS mean and reports overfitting stats.
 *   5. Stage 4: Monte Carlo the best walk-forward config over perturbed fill
 *      probability / slippage / fee. Emits distribution of total PnL and
 *      daily-per-$100 numbers.
 *   6. Stage 5: Decision report (DEPLOY / DRY_RUN / REJECT) with expected
 *      monthly PnL at several capital tiers.
 *
 * Usage
 * -----
 *   npm run backtest-restaker
 *   npm run backtest-restaker -- --category=sports --top=5 --replays=200
 *   npm run backtest-restaker -- --out=data/restaker-report.json
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  runResolutionTakerBacktest
} from "../dist/src/simulation/resolutionTakerBacktest.js";
import {
  expandTakerGrid,
  rankTakerResults,
  refineTakerGrid,
  runTakerGridSearch
} from "../dist/src/simulation/resolutionTakerGridSearch.js";
import { walkForwardTaker } from "../dist/src/simulation/resolutionTakerWalkForward.js";
import { runMonteCarlo } from "../dist/src/simulation/monteCarloAnalysis.js";
import {
  formatReport,
  generateDecisionReport,
  DEFAULT_THRESHOLDS
} from "../dist/src/simulation/decisionReport.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const category = args.category; // optional filter: weather | sports | crypto | ...
const topN = Number(args.top ?? "3");
const replays = Number(args.replays ?? "200");
const bootstrapSamples = Number(args["bootstrap-samples"] ?? "100");
const walkFolds = Number(args["walk-folds"] ?? "4");
const outPath = args.out;

const CACHE_DIR = resolve("data/resolved-market-cache");

async function loadMarkets() {
  let files;
  try {
    files = await readdir(CACHE_DIR);
  } catch (e) {
    console.error(`Cache directory not found: ${CACHE_DIR}`);
    console.error(`Run 'npm run fetch-resolved-markets' first.`);
    process.exit(1);
  }
  const markets = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(CACHE_DIR, f), "utf8"));
      if (!raw.samples || raw.samples.length < 10) continue;
      if (category && (raw.category ?? "").toLowerCase() !== category.toLowerCase()) continue;
      markets.push({
        id: raw.id ?? raw.conditionId,
        label: raw.title ?? raw.question ?? raw.conditionId,
        tickSize: raw.tickSize ?? 0.01,
        samples: raw.samples,
        resolutionTs: raw.resolutionTs,
        tokenResolutionValue: raw.tokenResolutionValue,
        category: raw.category
      });
    } catch (_) { /* ignore malformed */ }
  }
  return markets;
}

function formatPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function formatCfg(c) {
  return (
    `entry=[${c.entryPriceMin}, ${c.entryPriceMax}]  ` +
    `hold=${c.minTimeToResolutionHours}-${c.maxHoldHours}h  ` +
    `sz=$${c.orderSizeUsdc}  ` +
    `fillProb=${formatPct(c.fillProbability)}  ` +
    `maxConc=${c.maxConcurrentPositions}  ` +
    `multi=${c.allowMultipleEntries}`
  );
}

async function main() {
  console.log(`\nLoading resolved-market cache from ${CACHE_DIR}...`);
  const markets = await loadMarkets();
  if (markets.length < 20) {
    console.error(`\nNot enough cached markets (${markets.length}). Need at least 20 — run fetch-resolved-markets with more coverage.`);
    process.exit(1);
  }
  const byCategory = markets.reduce((m, x) => {
    m[x.category ?? "other"] = (m[x.category ?? "other"] ?? 0) + 1;
    return m;
  }, {});
  console.log(`  loaded ${markets.length} markets:`, byCategory);
  console.log(`  walk-forward folds=${walkFolds}  MC replays=${replays}  bootstrap=${bootstrapSamples}\n`);

  // ---------------------------------------------------------------- Stage 1
  const stage1Grid = {
    entryPriceMin: [0.85, 0.90, 0.93, 0.95, 0.97],
    entryPriceMax: [0.98, 0.99, 0.998],
    maxHoldHours: [1, 4, 12, 24, 72],
    minTimeToResolutionHours: [0.1, 0.5, 1.0],
    orderSizeUsdc: [5, 10, 20],
    takerFeeRate: [0.0],
    fillProbability: [0.3, 0.5, 0.8],
    maxConcurrentPositions: [5, 10, 20],
    minShares: [5],
    allowMultipleEntries: [false, true]
  };
  const stage1Configs = expandTakerGrid(stage1Grid);
  console.log(`Stage 1: ${stage1Configs.length} configs × ${markets.length} markets = ${stage1Configs.length * markets.length} backtests`);
  const t1 = Date.now();
  const stage1 = runTakerGridSearch(stage1Grid, markets);
  console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(1)}s\n`);

  console.log(`Stage 1 top 10 (by composite = 0.5·mean + 0.5·p05):\n`);
  console.log(
    "rank".padEnd(5),
    "config".padEnd(95),
    "trades".padStart(7),
    "winRate".padStart(8),
    "mean".padStart(9),
    "p05".padStart(9),
    "total".padStart(10)
  );
  console.log("-".repeat(145));
  for (let i = 0; i < Math.min(10, stage1.length); i++) {
    const r = stage1[i];
    console.log(
      String(r.rank).padEnd(5),
      formatCfg(r.config).padEnd(95),
      String(r.trades).padStart(7),
      formatPct(r.winRate).padStart(8),
      `$${r.meanPnl.toFixed(4)}`.padStart(9),
      `$${r.p05.toFixed(2)}`.padStart(9),
      `$${r.totalPnl.toFixed(0)}`.padStart(10)
    );
  }

  // ---------------------------------------------------------------- Stage 2
  console.log(`\nStage 2: refining around top ${topN} winners...`);
  const refined = [];
  for (let i = 0; i < Math.min(topN, stage1.length); i++) {
    const seed = stage1[i];
    const refinedGrid = refineTakerGrid(seed.config, stage1Grid);
    const neighbours = expandTakerGrid(refinedGrid);
    console.log(`  seed #${i + 1} → ${neighbours.length} neighbour configs`);
    const subResults = runTakerGridSearch(refinedGrid, markets);
    for (const r of subResults) refined.push(r);
  }
  const stage2 = rankTakerResults(refined);
  const stage2Top = stage2.slice(0, 20);

  console.log(`\nStage 2 top 10 (after refinement):\n`);
  console.log(
    "rank".padEnd(5),
    "config".padEnd(95),
    "trades".padStart(7),
    "winRate".padStart(8),
    "mean".padStart(9),
    "p05".padStart(9),
    "total".padStart(10)
  );
  console.log("-".repeat(145));
  for (let i = 0; i < 10; i++) {
    const r = stage2[i];
    if (!r) break;
    console.log(
      String(r.rank).padEnd(5),
      formatCfg(r.config).padEnd(95),
      String(r.trades).padStart(7),
      formatPct(r.winRate).padStart(8),
      `$${r.meanPnl.toFixed(4)}`.padStart(9),
      `$${r.p05.toFixed(2)}`.padStart(9),
      `$${r.totalPnl.toFixed(0)}`.padStart(10)
    );
  }

  // ---------------------------------------------------------------- Stage 3
  console.log(`\nStage 3: walk-forward cross-validation on top ${stage2Top.length} stage-2 configs...\n`);
  const wfResults = walkForwardTaker(
    stage2Top.map((r) => r.config),
    markets,
    walkFolds
  );

  console.log(
    "rank".padEnd(5),
    "config".padEnd(95),
    "OOS mean".padStart(10),
    "IS mean".padStart(10),
    "gap".padStart(8),
    "stab".padStart(6),
    "OOS trades".padStart(11)
  );
  console.log("-".repeat(160));
  for (let i = 0; i < Math.min(10, wfResults.length); i++) {
    const r = wfResults[i];
    console.log(
      String(r.rank).padEnd(5),
      formatCfg(r.config).padEnd(95),
      `$${r.oosMeanPnl.toFixed(4)}`.padStart(10),
      `$${r.isMeanPnl.toFixed(4)}`.padStart(10),
      `$${r.trainTestGap.toFixed(4)}`.padStart(8),
      `${(r.stability * 100).toFixed(0)}%`.padStart(6),
      String(r.oosTrades).padStart(11)
    );
  }

  // ---------------------------------------------------------------- Stage 4
  const bestWf = wfResults[0];
  if (!bestWf) {
    console.error(`\nNo walk-forward results produced — aborting.`);
    process.exit(1);
  }
  console.log(`\nStage 4: Monte Carlo on best walk-forward config`);
  console.log(`  ${formatCfg(bestWf.config)}`);

  const deterministic = runResolutionTakerBacktest(markets, bestWf.config);
  const mcReport = runMonteCarlo(
    markets,
    bestWf.config,
    {
      fillProbabilityRange: [Math.max(0.1, bestWf.config.fillProbability - 0.2), Math.min(1.0, bestWf.config.fillProbability + 0.1)],
      entrySlippageRange: [0.0, 0.005],
      takerFeeRateRange: [0.0, 0.01],
      replays,
      bootstrapSamples,
      seed: 0x5a17f00d
    }
  );
  console.log(`  ran ${replays} replays × ${bootstrapSamples} bootstraps`);

  // ---------------------------------------------------------------- Stage 5
  const report = generateDecisionReport(bestWf.config, deterministic, bestWf, mcReport, DEFAULT_THRESHOLDS);
  process.stdout.write(formatReport(report));

  if (outPath) {
    await writeFile(
      resolve(outPath),
      JSON.stringify({ report, stage1Top: stage1.slice(0, 10), stage2Top: stage2.slice(0, 10), walkForward: wfResults }, null, 2),
      "utf8"
    );
    console.log(`\nFull detail → ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
