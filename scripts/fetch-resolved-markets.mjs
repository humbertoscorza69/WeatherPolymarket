#!/usr/bin/env node
/**
 * Build the resolved-market cache used by the resolution-taker backtest.
 *
 * For each RESOLVED market found on Gamma (within the lookback window), we:
 *   1. Record which side (YES / NO) paid out $1.
 *   2. Fetch the full minute-level YES-token price history via getPricesHistory
 *      (we treat a market as two virtual tokens; only one of them pays $1).
 *   3. Persist to data/resolved-market-cache/<conditionId>-<side>.json.
 *
 * Designed to be resumable — existing cache files are skipped unless
 * --refresh is passed. The slow part is the per-token fidelity-1 history
 * fetch; even at 200 markets this is ~10 minutes round-trip.
 *
 * Usage
 * -----
 *   npm run fetch-resolved-markets
 *   npm run fetch-resolved-markets -- --preset=all --lookback-days=60
 *   npm run fetch-resolved-markets -- --max-events=500 --fidelity=1 --refresh
 *   npm run fetch-resolved-markets -- --preset=weather --min-volume=500
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import {
  findResolvedMarkets,
  RESOLVED_PRESETS
} from "../dist/src/adapters/resolvedMarketDiscovery.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const preset = args.preset ?? "all";
const lookbackDays = Number(args["lookback-days"] ?? "60");
const maxEvents = Number(args["max-events"] ?? "300");
const gammaLimit = Number(args["gamma-limit"] ?? "500");
const fidelity = Number(args.fidelity ?? "1");
const minVolume = Number(args["min-volume"] ?? "200");
const refresh = args.refresh === "true";
const categoryFilter = args.category; // optional: only cache markets in this category

const host = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  console.error("POLYMARKET_PRIVATE_KEY is required in .env");
  process.exit(1);
}
const signer = new Wallet(privateKey);
const client = new ClobClient(
  host, 137, signer,
  {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE
  },
  Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1"),
  process.env.POLYMARKET_FUNDER_ADDRESS
);

const CACHE_DIR = resolve("data/resolved-market-cache");
await mkdir(CACHE_DIR, { recursive: true });

async function tickSize(tokenId) {
  try {
    const result = await client.getTickSize(tokenId);
    const n = Number(result);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) { /* noop */ }
  return 0.01;
}

async function fetchPriceHistory(tokenId, endTs, lookbackSec) {
  const startTs = endTs - lookbackSec;
  try {
    const raw = await client.getPricesHistory({
      market: tokenId,
      startTs,
      endTs,
      fidelity
    });
    const history = Array.isArray(raw) ? raw : raw?.history ?? raw?.data ?? [];
    return history
      .map((p) => ({ t: Number(p.t), p: Number(p.p) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p) && p.p > 0 && p.p < 1);
  } catch (e) {
    console.error(`    price history failed for ${tokenId.slice(0, 10)}: ${e?.message ?? e}`);
    return [];
  }
}

function cacheKey(market) {
  return `${market.conditionId}-${market.side}.json`;
}

async function isCached(market) {
  if (refresh) return false;
  try {
    const s = await stat(join(CACHE_DIR, cacheKey(market)));
    return s.size > 100;
  } catch (_) { return false; }
}

async function main() {
  console.log(`\nFetching resolved markets from Gamma...`);
  console.log(`  preset=${preset}  lookback=${lookbackDays}d  max-events=${maxEvents}  fidelity=${fidelity}min  min-volume=$${minVolume}\n`);

  const urlBuilder = RESOLVED_PRESETS[preset];
  if (!urlBuilder) {
    console.error(`unknown preset: ${preset}. choose from: ${Object.keys(RESOLVED_PRESETS).join(", ")}`);
    process.exit(1);
  }
  const url = urlBuilder(lookbackDays, gammaLimit);

  const resolved = await findResolvedMarkets({
    gammaUrl: url,
    minVolumeUsdc: minVolume,
    maxEvents
  });
  let filtered = resolved;
  if (categoryFilter) {
    filtered = resolved.filter((m) => (m.category ?? "").toLowerCase() === categoryFilter.toLowerCase());
  }
  console.log(`  Gamma returned ${resolved.length} virtual markets (${filtered.length} after category filter)\n`);

  const maxLookbackSec = lookbackDays * 86400;
  let fetched = 0, skipped = 0, failed = 0;
  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];
    const progress = `[${i + 1}/${filtered.length}]`;
    if (await isCached(m)) {
      skipped++;
      if (i % 10 === 0) process.stdout.write(`  ${progress} cached, skipping batch... \r`);
      continue;
    }
    process.stdout.write(`  ${progress} ${m.conditionId.slice(0, 12)} ${m.side} (${m.category ?? "?"}) ${m.title.slice(0, 50)}... `);
    const tick = await tickSize(m.tokenId);
    const samples = await fetchPriceHistory(m.tokenId, m.resolutionTs, maxLookbackSec);
    if (samples.length < 10) {
      console.log(`skipped (${samples.length} samples)`);
      failed++;
      continue;
    }
    const payload = {
      id: m.id,
      conditionId: m.conditionId,
      tokenId: m.tokenId,
      side: m.side,
      tokenResolutionValue: m.tokenResolutionValue,
      resolutionTs: m.resolutionTs,
      tickSize: tick,
      title: m.title,
      question: m.question,
      slug: m.slug,
      eventSlug: m.eventSlug,
      category: m.category ?? "other",
      volumeUsdc: m.volumeUsdc,
      samples,
      fetchedAt: Date.now(),
      fidelity
    };
    await writeFile(join(CACHE_DIR, cacheKey(m)), JSON.stringify(payload), "utf8");
    console.log(`${samples.length} samples cached`);
    fetched++;
    // brief courtesy delay to not hammer Polymarket
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 500));
  }

  const files = await readdir(CACHE_DIR);
  console.log(`\n  Done. Fetched ${fetched}, skipped ${skipped} cached, failed ${failed}.`);
  console.log(`  Cache directory holds ${files.length} markets total.\n`);
}

main().catch((e) => {
  console.error("\nfetch-resolved-markets failed:", e);
  process.exit(1);
});
