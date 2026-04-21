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
import { findActiveWeatherEvents } from "../dist/src/adapters/weatherDiscovery.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const days = Number(args.days ?? "3");
const fidelity = Number(args.fidelity ?? "15");
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

  // 1) Discover events
  console.log("Discovering active weather events...");
  const events = await findActiveWeatherEvents({
    maxEvents,
    maxOutcomesPerEvent,
    minMarketVolumeUsdc: 0
  });
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
  const coarseGrid = {
    halfSpreadTicks: [1, 2, 3],
    inventorySkewCents: [0, 2],
    volMultiplier: [0, 0.5, 1.0],
    minOutcomeMid: [0.05, 0.10],
    maxOutcomeMid: [0.90, 0.95],
    maxForecastDivergence: [0.15, 0.30],
    stopLossEnabled: [true],
    stopLossCatastrophicDropRatio: [0.30],
    stopLossDeepDropRatio: [0.60],
    orderSizeUsdc: [2, 3]
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

  const best = stage2Ranked[0];
  if (best) {
    console.log(`\n=== RECOMMENDED CONFIG ===`);
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
    console.log(`  Expected: mean $${best.meanPnl.toFixed(3)}/market, p05 $${best.p05.toFixed(3)}, ${best.marketsUsed} markets passed the filter`);
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
