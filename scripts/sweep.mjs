#!/usr/bin/env node
/**
 * Multi-city, multi-parameter grid search for the weather market maker.
 *
 * Flow
 * ----
 * 1. Discover every active weather event (all cities Polymarket is running).
 * 2. For each outcome, resolve tickSize and fetch price history via
 *    client.getPricesHistory (cached to data/backtest-cache/*.json so
 *    re-runs don't re-hit the API).
 * 3. Stage 1: coarse grid of parameters × all markets.
 * 4. Rank configs by composite metric (mean rank + p05 rank).
 * 5. Stage 2: refine around the top-3 winners.
 * 6. Print the top-10 final leaderboard.
 *
 * Usage
 * -----
 *   npm run sweep                        # defaults: 3 days, 15-min samples
 *   npm run sweep -- --days=7 --fidelity=30
 *   npm run sweep -- --refresh-cache     # ignore cached history, re-fetch
 *   npm run sweep -- --top=10            # refine around top-10 (default: 3)
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { expandGrid, rankResults, refineAround, runGridSearch } from "../dist/src/simulation/gridSearch.js";
import { walkForward } from "../dist/src/simulation/walkForward.js";
import { findActiveWeatherEvents } from "../dist/src/adapters/weatherDiscovery.js";
import { findGenericEvents, GAMMA_PRESETS } from "../dist/src/adapters/genericDiscovery.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const days = Number(args.days ?? "3");
// fidelity = minutes between samples. Default 5 min is a compromise:
//   - 15 min was what Polymarket returns by default; too coarse vs live 30s refresh
//   - 1 min is ideal but Polymarket truncates long windows at fine fidelities
//   - 5 min gives 288 samples/day/market which matches the live 30s cadence
//     reasonably for a slow market like weather
const fidelity = Number(args.fidelity ?? "5");
const topN = Number(args.top ?? "3");
const refreshCache = args["refresh-cache"] === "true";
const maxEvents = Number(args["max-events"] ?? args.events ?? "50");
const maxOutcomesPerEvent = Number(args["max-outcomes"] ?? "15");

const host = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  console.error("POLYMARKET_PRIVATE_KEY is required in .env");
  process.exit(1);
}
const signer = new Wallet(privateKey);
const client = new ClobClient(
  host,
  137,
  signer,
  {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE
  },
  Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1"),
  process.env.POLYMARKET_FUNDER_ADDRESS
);

const CACHE_DIR = resolve("data/backtest-cache");

async function readCache(tokenId) {
  try {
    const path = join(CACHE_DIR, `${tokenId}-${days}d-${fidelity}m.json`);
    const s = await stat(path).catch(() => null);
    if (!s) return null;
    // cache is valid for 6 hours
    if (Date.now() - s.mtimeMs > 6 * 3600_000) return null;
    const body = await readFile(path, "utf-8");
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function writeToCache(tokenId, payload) {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, `${tokenId}-${days}d-${fidelity}m.json`);
  await writeFile(path, JSON.stringify(payload), "utf-8");
}

async function fetchHistoryRaw(tokenId) {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - days * 86400;
  const raw = await client.getPricesHistory({
    market: tokenId,
    startTs,
    endTs,
    fidelity
  });
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.history)) return raw.history;
    if (Array.isArray(raw.data)) return raw.data;
  }
  return [];
}

async function loadMarketData(tokenId, label) {
  if (!refreshCache) {
    const cached = await readCache(tokenId);
    if (cached) return cached;
  }
  let tickSize = 0.01;
  try {
    const raw = await client.getTickSize(tokenId);
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) tickSize = parsed;
  } catch {
    /* default */
  }
  const history = await fetchHistoryRaw(tokenId);
  const samples = history
    .filter((p) => typeof p.t === "number" && typeof p.p === "number")
    .map((p) => ({ t: p.t, p: p.p }));
  const sortedPrices = [...samples.map((s) => s.p)].sort((a, b) => a - b);
  const medianPrice = sortedPrices.length ? sortedPrices[Math.floor(sortedPrices.length / 2)] : 0;
  const market = { tokenId, label, tickSize, samples, medianPrice };
  await writeToCache(tokenId, market);
  return market;
}

function formatCfg(c) {
  return [
    `tk=${c.halfSpreadTicks}`,
    `sk=${c.inventorySkewCents}`,
    `vol=${c.volMultiplier}`,
    `band=${c.minOutcomeMid}-${c.maxOutcomeMid}`,
    `div=${c.maxForecastDivergence === Infinity ? "∞" : c.maxForecastDivergence}`,
    `tp=${c.tpTicksBase}${c.tpVolMultiplier ? `+${c.tpVolMultiplier}v` : ""}`,
    `drf=${c.driftFilterEnabled ? `${c.driftFilterDownDriftCents}¢@${c.driftFilterRatio}` : "off"}`,
    `sl=${c.stopLossEnabled ? "on" : "off"}`,
    `drop=${c.stopLossCatastrophicDropRatio}`,
    `$${c.orderSizeUsdc}`
  ].join(" ");
}

function printLeaderboard(ranked, title, limit = 10) {
  console.log(`\n${title}`);
  console.log(
    "rank".padEnd(5),
    "config".padEnd(70),
    "mean".padStart(8),
    "p05".padStart(8),
    "p95".padStart(8),
    "sharpe".padStart(7),
    "win%".padStart(6),
    "n_mkts".padStart(7),
    "rtrips".padStart(7),
    "stops".padStart(6)
  );
  console.log("-".repeat(135));
  for (const r of ranked.slice(0, limit)) {
    console.log(
      String(r.rank).padEnd(5),
      formatCfg(r.config).padEnd(70),
      r.meanPnl.toFixed(3).padStart(8),
      r.p05.toFixed(3).padStart(8),
      r.p95.toFixed(3).padStart(8),
      r.sharpe === Infinity ? "   ∞" : r.sharpe.toFixed(3).padStart(7),
      (r.winRate * 100).toFixed(1).padStart(6),
      String(r.marketsUsed).padStart(7),
      String(r.totalRoundTrips).padStart(7),
      String(r.totalStopLosses).padStart(6)
    );
  }
}

async function main() {
  console.log(`\nSweep parameters: days=${days}  fidelity=${fidelity}min  topN=${topN}  maxEvents=${maxEvents}`);
  console.log(`Cache: ${CACHE_DIR}  refresh=${refreshCache}\n`);

  // 1) Discover events (routes by DISCOVERY_MODE env)
  const discoveryMode = process.env.DISCOVERY_MODE ?? "weather";
  const discoveryPreset = process.env.DISCOVERY_PRESET ?? "weather";
  console.log(`Discovering events... (mode=${discoveryMode}, preset=${discoveryPreset})`);
  let events;
  if (discoveryMode === "generic") {
    const url = process.env.GAMMA_EVENTS_URL || GAMMA_PRESETS[discoveryPreset];
    if (!url) {
      console.error(`DISCOVERY_MODE=generic requires DISCOVERY_PRESET (${Object.keys(GAMMA_PRESETS).join(", ")}) or GAMMA_EVENTS_URL`);
      process.exit(1);
    }
    events = await findGenericEvents({ gammaUrl: url, maxEvents, maxOutcomesPerEvent, minMarketVolumeUsdc: 0 });
  } else {
    events = await findActiveWeatherEvents({ maxEvents, maxOutcomesPerEvent, minMarketVolumeUsdc: 0 });
  }
  console.log(`  found ${events.length} events, ${events.reduce((s, e) => s + e.markets.length, 0)} outcomes total`);

  // 2) Fetch / cache history for every outcome
  console.log("\nLoading market data (cache first, then API)...");
  const markets = [];
  let fetched = 0;
  let loaded = 0;
  for (const event of events) {
    for (const m of event.markets) {
      const label = `${event.city} ${m.outcomeLabel}`.slice(0, 40);
      try {
        const market = await loadMarketData(m.yesTokenId, label);
        if (market.samples.length < 10) continue;
        markets.push(market);
        loaded++;
        if (market === null) {
          // placeholder
        }
      } catch (err) {
        // don't stop the sweep on one bad market
      }
      fetched++;
      if (fetched % 25 === 0) process.stdout.write(`  processed ${fetched}\r`);
    }
  }
  console.log(`  loaded ${loaded} markets with ≥10 samples (${fetched} attempted)`);

  if (markets.length === 0) {
    console.error("No markets usable for backtest — try increasing --days or --fidelity.");
    process.exit(1);
  }

  // 3) Stage 1: coarse grid
  // Stage 1 coarse grid
  //
  // halfSpreadTicks: 1-3 is classic tight MM. 5-12 tests "wide-spread LP"
  // behaviour on markets with naturally big spreads (entertainment markets
  // routinely show 10-50¢ spreads). On a 0.01-tick market, 10 ticks = 10¢.
  // Wider = fewer fills but bigger profit per fill; the product may be
  // bigger on spread-rich markets.
  const coarseGrid = {
    halfSpreadTicks: [1, 2, 3, 5, 8, 12],
    inventorySkewCents: [0, 2],
    volMultiplier: [0, 1.0],
    minOutcomeMid: [0.1],
    maxOutcomeMid: [0.9, 0.95],
    maxForecastDivergence: [0.15, 0.30],
    stopLossEnabled: [true],
    stopLossCatastrophicDropRatio: [0.30],
    stopLossDeepDropRatio: [0.60],
    orderSizeUsdc: [2, 3],
    tpTicksBase: [1, 2, 3, 5],
    tpVolMultiplier: [0, 0.5],
    driftFilterEnabled: [false, true],
    driftFilterDownDriftCents: [1, 3],
    driftFilterRatio: [1.0]
  };
  const stage1Configs = expandGrid(coarseGrid);
  console.log(`\nStage 1: ${stage1Configs.length} configs × ${markets.length} markets = ${stage1Configs.length * markets.length} backtests`);
  const started = Date.now();
  const stage1 = runGridSearch(coarseGrid, markets);
  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  printLeaderboard(stage1, `Stage 1 top 10 (by composite rank = 0.5·mean + 0.5·p05)`, 10);

  // 4) Stage 2: refine around top-N
  const seeds = stage1.slice(0, topN);
  console.log(`\nStage 2: refining around top ${topN} winners`);
  const stage2Results = [];
  for (const seed of seeds) {
    const refined = refineAround(seed.config, coarseGrid);
    const refinedConfigs = expandGrid(refined);
    process.stdout.write(`  seed #${seed.rank} → ${refinedConfigs.length} neighbour configs\r`);
    const results = runGridSearch(refined, markets);
    stage2Results.push(...results);
  }
  const stage2Ranked = rankResults(stage2Results);
  printLeaderboard(stage2Ranked, `Stage 2 top 10 (after refinement)`, 10);

  // Stage 3: walk-forward cross-validation on the stage-2 top 20
  // Defend against overfitting: rank by OUT-OF-SAMPLE PnL, not in-sample.
  console.log(`\nStage 3: walk-forward cross-validation (${Number(args.folds ?? "4")} folds) on stage-2 top 20`);
  const folds = Number(args.folds ?? "4");
  const wfCandidates = stage2Ranked.slice(0, 20).map((r) => r.config);
  const wf = walkForward(wfCandidates, markets, folds, 0.10);
  console.log(
    "\nrank".padEnd(5),
    "config".padEnd(70),
    "OOS mean".padStart(10),
    "IS mean".padStart(10),
    "gap".padStart(8),
    "OOS p05".padStart(9),
    "stability".padStart(10),
    "rtrips".padStart(7)
  );
  console.log("-".repeat(140));
  for (const r of wf.slice(0, 10)) {
    console.log(
      String(r.rank).padEnd(5),
      formatCfg(r.config).padEnd(70),
      r.oosMeanPnl.toFixed(4).padStart(10),
      r.isMeanPnl.toFixed(4).padStart(10),
      r.trainTestGap.toFixed(4).padStart(8),
      r.oosP05.toFixed(4).padStart(9),
      (r.stability * 100).toFixed(0).padStart(9) + "%",
      String(r.oosRoundTrips).padStart(7)
    );
  }

  const best = wf[0];
  const overfit = best && best.trainTestGap > 0.10;
  if (overfit) {
    console.log(`\n⚠️  OVERFITTING WARNING: rank-1 config's in-sample mean ($${best.isMeanPnl.toFixed(3)}) exceeds OOS mean ($${best.oosMeanPnl.toFixed(3)}) by $${best.trainTestGap.toFixed(3)}.`);
    console.log(`    Trust the OOS number (the lower one). Consider wider fold count or more data.`);
  }
  if (best && best.stability < 0.5) {
    console.log(`\n⚠️  LOW STABILITY: rank-1 stayed in the test top-10% only ${(best.stability * 100).toFixed(0)}% of folds.`);
    console.log(`    Could be noise-fit rather than real edge. Prefer a lower-ranked config with higher stability.`);
  }

  if (best) {
    console.log(`\n=== RECOMMENDED CONFIG (out-of-sample validated) ===`);
    console.log(`  HALF_SPREAD_TICKS=${best.config.halfSpreadTicks}`);
    console.log(`  INVENTORY_SKEW_CENTS=${best.config.inventorySkewCents}`);
    console.log(`  VOL_MULTIPLIER=${best.config.volMultiplier}`);
    console.log(`  MIN_OUTCOME_MID=${best.config.minOutcomeMid}`);
    console.log(`  MAX_OUTCOME_MID=${best.config.maxOutcomeMid}`);
    console.log(`  MAX_FORECAST_DIVERGENCE=${best.config.maxForecastDivergence}`);
    console.log(`  STOP_LOSS_ENABLED=${best.config.stopLossEnabled}`);
    console.log(`  STOP_LOSS_CATASTROPHIC_DROP=${best.config.stopLossCatastrophicDropRatio}`);
    console.log(`  STOP_LOSS_DEEP_DROP=${best.config.stopLossDeepDropRatio}`);
    console.log(`  ORDER_SIZE_USDC=${best.config.orderSizeUsdc}`);
    console.log(`  TP_TICKS_BASE=${best.config.tpTicksBase}`);
    console.log(`  TP_VOL_MULTIPLIER=${best.config.tpVolMultiplier}`);
    console.log(`  DRIFT_FILTER_ENABLED=${best.config.driftFilterEnabled}`);
    console.log(`  DRIFT_FILTER_DOWN_DRIFT_CENTS=${best.config.driftFilterDownDriftCents}`);
    console.log(`  DRIFT_FILTER_RATIO=${best.config.driftFilterRatio}`);
    console.log(`  Expected (out-of-sample): mean $${best.oosMeanPnl.toFixed(3)}/market, p05 $${best.oosP05.toFixed(3)}`);
    console.log(`  Stability: ${(best.stability * 100).toFixed(0)}% of folds landed in test top-10%. Train-test gap: $${best.trainTestGap.toFixed(3)}.`);
  }
  console.log(
    `\nNOTE: backtest is an OPTIMISTIC upper bound (queue position not modeled).`
  );
  console.log(
    `      Treat "RECOMMENDED" as a starting point, validate with a live dry-run, iterate.\n`
  );
}

main().catch((err) => {
  console.error("Sweep failed:", err);
  process.exit(1);
});
