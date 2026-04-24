#!/usr/bin/env node
/**
 * Build the resolved-market cache used by the resolution-taker backtest.
 *
 * For each RESOLVED market found on Gamma (within the lookback window), we:
 *   1. Record which side (YES / NO) paid out $1.
 *   2. Fetch price history for the final `--window-hours` leading up to
 *      resolution (default 72h — the taker only ever enters in that window
 *      anyway, so there's no reason to pull weeks of useless early-market
 *      data).
 *   3. Persist to data/resolved-market-cache/<conditionId>-<side>.json.
 *
 * Fidelity + API truncation
 * -------------------------
 * Polymarket's getPricesHistory truncates long windows at fine fidelity —
 * asking for 60 days at fidelity=1 returns 0 samples. The fix is either
 * a coarser fidelity (5-min is safe up to ~7 days) or chunking the window
 * into smaller pieces. We do both:
 *   - Default fidelity = 5 (minutes), default window-hours = 72 → one call
 *   - --fidelity=1 works by auto-chunking into 24h pieces
 *
 * Diagnosis
 * ---------
 *   npm run fetch-resolved-markets -- --probe       # dump raw response
 *                                                    # for one market
 *
 * Usage
 * -----
 *   npm run fetch-resolved-markets
 *   npm run fetch-resolved-markets -- --preset=sports --window-hours=48
 *   npm run fetch-resolved-markets -- --fidelity=1 --window-hours=24
 *   npm run fetch-resolved-markets -- --preset=weather --min-volume=500
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
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
const fidelity = Number(args.fidelity ?? "5"); // safe default; see module header
const windowHours = Number(args["window-hours"] ?? "72"); // pre-resolution window we care about
const minVolume = Number(args["min-volume"] ?? "200");
const refresh = args.refresh === "true";
const probe = args.probe === "true";
const categoryFilter = args.category;

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

/** Single price-history call. Returns parsed samples or [] on failure. */
async function fetchChunk(tokenId, startTs, endTs) {
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
    return { error: e?.message ?? String(e) };
  }
}

/** Auto-chunk the window so fine-fidelity fetches don't trigger API truncation.
 *  Chunk size: 7 days at fidelity ≥ 5, 24h at fidelity < 5. */
async function fetchPriceHistory(tokenId, endTs, windowSec) {
  const startTs = endTs - windowSec;
  const chunkSec = fidelity < 5 ? 24 * 3600 : 7 * 24 * 3600;

  if (windowSec <= chunkSec) {
    const result = await fetchChunk(tokenId, startTs, endTs);
    if (result && result.error) return { samples: [], error: result.error };
    return { samples: result };
  }

  const allSamples = [];
  let cursor = startTs;
  let lastError = null;
  while (cursor < endTs) {
    const chunkEnd = Math.min(cursor + chunkSec, endTs);
    const result = await fetchChunk(tokenId, cursor, chunkEnd);
    if (result && result.error) {
      lastError = result.error;
    } else if (Array.isArray(result)) {
      allSamples.push(...result);
    }
    cursor = chunkEnd;
    await new Promise((r) => setTimeout(r, 50)); // courtesy delay between chunks
  }
  // Dedup on timestamp
  const seen = new Set();
  const deduped = allSamples
    .sort((a, b) => a.t - b.t)
    .filter((s) => (seen.has(s.t) ? false : (seen.add(s.t), true)));
  return { samples: deduped, error: lastError && deduped.length === 0 ? lastError : null };
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

async function probeOne(market) {
  console.log(`\nPROBE MODE — diagnosing one market\n`);
  console.log(`  conditionId: ${market.conditionId}`);
  console.log(`  side:        ${market.side}`);
  console.log(`  tokenId:     ${market.tokenId}`);
  console.log(`  resolutionTs: ${market.resolutionTs} (${new Date(market.resolutionTs * 1000).toISOString()})`);
  console.log(`  category:    ${market.category}`);
  console.log(`  title:       ${market.title}\n`);

  const windowSec = windowHours * 3600;
  const startTs = market.resolutionTs - windowSec;
  console.log(`  requesting: market=${market.tokenId.slice(0, 20)}... startTs=${startTs} endTs=${market.resolutionTs} fidelity=${fidelity}min`);

  try {
    const raw = await client.getPricesHistory({
      market: market.tokenId,
      startTs,
      endTs: market.resolutionTs,
      fidelity
    });
    console.log(`\n  raw response keys:`, Object.keys(raw ?? {}));
    console.log(`  is array:`, Array.isArray(raw));
    const history = Array.isArray(raw) ? raw : raw?.history ?? raw?.data ?? [];
    console.log(`  history length:`, history.length);
    if (history.length > 0) {
      console.log(`  first:`, history[0]);
      console.log(`  last: `, history[history.length - 1]);
      console.log(`  sample of 5:`, history.slice(0, 5));
    } else {
      console.log(`  NO SAMPLES. Raw:`, JSON.stringify(raw).slice(0, 300));
    }
  } catch (e) {
    console.log(`  EXCEPTION: ${e?.message ?? e}`);
  }

  console.log(`\n  Now trying with a SMALLER window (24h) at SAME fidelity...`);
  try {
    const raw = await client.getPricesHistory({
      market: market.tokenId,
      startTs: market.resolutionTs - 24 * 3600,
      endTs: market.resolutionTs,
      fidelity
    });
    const history = Array.isArray(raw) ? raw : raw?.history ?? raw?.data ?? [];
    console.log(`  24h window returned ${history.length} samples`);
  } catch (e) {
    console.log(`  EXCEPTION: ${e?.message ?? e}`);
  }

  console.log(`\n  Now trying fidelity=15 at the original 72h window...`);
  try {
    const raw = await client.getPricesHistory({
      market: market.tokenId,
      startTs: market.resolutionTs - windowSec,
      endTs: market.resolutionTs,
      fidelity: 15
    });
    const history = Array.isArray(raw) ? raw : raw?.history ?? raw?.data ?? [];
    console.log(`  fidelity=15 returned ${history.length} samples`);
    if (history.length > 0) console.log(`  first:`, history[0], `last:`, history[history.length - 1]);
  } catch (e) {
    console.log(`  EXCEPTION: ${e?.message ?? e}`);
  }

  console.log(`\n  Now trying interval=1m (string param) at 72h window...`);
  try {
    const raw = await client.getPricesHistory({
      market: market.tokenId,
      startTs: market.resolutionTs - windowSec,
      endTs: market.resolutionTs,
      interval: "1m"
    });
    const history = Array.isArray(raw) ? raw : raw?.history ?? raw?.data ?? [];
    console.log(`  interval=1m returned ${history.length} samples`);
  } catch (e) {
    console.log(`  EXCEPTION: ${e?.message ?? e}`);
  }
}

async function main() {
  console.log(`\nFetching resolved markets from Gamma...`);
  console.log(`  preset=${preset}  lookback=${lookbackDays}d  max-events=${maxEvents}  fidelity=${fidelity}min  window=${windowHours}h  min-volume=$${minVolume}\n`);

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

  if (probe) {
    if (filtered.length === 0) {
      console.error(`No markets to probe`);
      process.exit(1);
    }
    await probeOne(filtered[0]);
    return;
  }

  const windowSec = windowHours * 3600;
  let fetched = 0, skipped = 0, failed = 0;
  let recentErrors = [];
  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];
    const progress = `[${i + 1}/${filtered.length}]`;
    if (await isCached(m)) {
      skipped++;
      if (i % 50 === 0) process.stdout.write(`  ${progress} ${skipped} cached, continuing... \r`);
      continue;
    }
    process.stdout.write(`  ${progress} ${m.conditionId.slice(0, 12)} ${m.side} (${m.category ?? "?"}) ${m.title.slice(0, 50)}... `);
    const tick = await tickSize(m.tokenId);
    const { samples, error } = await fetchPriceHistory(m.tokenId, m.resolutionTs, windowSec);
    if (samples.length < 10) {
      console.log(`skipped (${samples.length} samples${error ? `, err: ${error.slice(0, 60)}` : ""})`);
      if (error) recentErrors.push(error);
      failed++;
      // If 20 markets in a row all fail with 0 samples, the API is misconfigured;
      // bail out so the user doesn't wait for 1000 pointless iterations.
      if (failed >= 20 && fetched === 0) {
        console.error(`\n  BAILING: 20 fetches in a row returned 0 samples. Run with --probe for diagnostics.`);
        if (recentErrors.length) console.error(`  recent errors:`, [...new Set(recentErrors)].slice(0, 3));
        process.exit(1);
      }
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
      fidelity,
      windowHours
    };
    await writeFile(join(CACHE_DIR, cacheKey(m)), JSON.stringify(payload), "utf8");
    console.log(`${samples.length} samples cached`);
    fetched++;
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
