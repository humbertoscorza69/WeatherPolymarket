#!/usr/bin/env node
/**
 * Market characterization report.
 *
 * Answers: "which active Polymarket markets fit our strategy?" by scoring
 * every discovered outcome on spread / volume / volatility / expected
 * fill frequency, and ranking by a composite "tradability" score.
 *
 * Output: a table like
 *   rank  outcome                 tick   mid    spread(¢)  vol24h   n_samples  vol_cents  score
 *   1     Chicago 36-37°F         0.001  0.14   0.3        $450     288        2.1        7.4
 *   2     Miami 78-79°F           0.01   0.35   2.0        $900     96         4.5        6.8
 *   ...
 *
 * Usage:
 *   npm run analyze-markets                        # defaults: 3 days, 5-min samples
 *   npm run analyze-markets -- --days=1 --fidelity=1
 *   npm run analyze-markets -- --top=30
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { findActiveWeatherEvents } from "../dist/src/adapters/weatherDiscovery.js";
import { findGenericEvents, GAMMA_PRESETS } from "../dist/src/adapters/genericDiscovery.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);
const days = Number(args.days ?? "3");
const fidelity = Number(args.fidelity ?? "5");
const topN = Number(args.top ?? "30");
const refreshCache = args["refresh-cache"] === "true";
const maxEvents = Number(args["max-events"] ?? "50");
const maxOutcomesPerEvent = Number(args["max-outcomes"] ?? "15");

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

const CACHE_DIR = resolve("data/backtest-cache");
async function readCache(tokenId) {
  try {
    const s = await stat(join(CACHE_DIR, `${tokenId}-${days}d-${fidelity}m.json`)).catch(() => null);
    if (!s || Date.now() - s.mtimeMs > 6 * 3600_000) return null;
    return JSON.parse(await readFile(join(CACHE_DIR, `${tokenId}-${days}d-${fidelity}m.json`), "utf-8"));
  } catch {
    return null;
  }
}
async function writeToCache(tokenId, payload) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${tokenId}-${days}d-${fidelity}m.json`), JSON.stringify(payload), "utf-8");
}

async function fetchHistory(tokenId) {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - days * 86400;
  const raw = await client.getPricesHistory({ market: tokenId, startTs, endTs, fidelity });
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.history)) return raw.history;
    if (Array.isArray(raw.data)) return raw.data;
  }
  return [];
}

function computeMetrics(samples) {
  if (samples.length < 3) return { medianPrice: 0, volCents: 0, priceRange: 0 };
  const prices = samples.map((s) => s.p);
  const sorted = [...prices].sort((a, b) => a - b);
  const medianPrice = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const diffs = [];
  for (let i = 1; i < prices.length; i++) diffs.push((prices[i] - prices[i - 1]) * 100);
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const variance = diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / diffs.length;
  const volCents = Math.sqrt(variance);
  const priceRange = Math.max(...prices) - Math.min(...prices);
  return { medianPrice, volCents, priceRange };
}

async function characterizeMarket(tokenId, label) {
  if (!refreshCache) {
    const cached = await readCache(tokenId);
    if (cached) {
      return { ...cached, label };
    }
  }
  let tickSize = 0.01;
  try {
    const raw = await client.getTickSize(tokenId);
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) tickSize = parsed;
  } catch {
    /* default */
  }
  const history = await fetchHistory(tokenId);
  const samples = history.filter((p) => typeof p.t === "number" && typeof p.p === "number").map((p) => ({ t: p.t, p: p.p }));
  const { medianPrice, volCents, priceRange } = computeMetrics(samples);
  // Fetch current book for real spread + volume
  let spreadCents = 0;
  let bidDepth = 0;
  let askDepth = 0;
  try {
    const ob = await client.getOrderBook(tokenId);
    const bestBid = Math.max(...(ob.bids ?? []).map((b) => Number(b.price)).filter(Number.isFinite), 0);
    const bestAsk = (ob.asks ?? []).length > 0 ? Math.min(...(ob.asks ?? []).map((a) => Number(a.price)).filter(Number.isFinite)) : 1;
    spreadCents = (bestAsk - bestBid) * 100;
    bidDepth = (ob.bids ?? []).reduce((s, b) => s + Number(b.size), 0);
    askDepth = (ob.asks ?? []).reduce((s, b) => s + Number(b.size), 0);
  } catch {
    /* no book — leave zeros */
  }
  const market = { tokenId, label, tickSize, samples, medianPrice, volCents, priceRange, spreadCents, bidDepth, askDepth };
  await writeToCache(tokenId, market);
  return market;
}

/**
 * Tradability score (0-10). Rewards markets with:
 *   - mid in tradable band (0.1..0.9 preferred)
 *   - spread ≥ 2 ticks
 *   - vol high enough that our quote gets hit (cents of stddev ≥ 1)
 *   - depth on both sides
 * Penalizes:
 *   - mids in tails
 *   - zero-bid markets (one-sided books we can't MM)
 *   - ultra-calm markets (our quote never fills)
 */
function tradabilityScore(m) {
  if (m.samples.length < 10) return 0;
  if (m.bidDepth === 0 || m.askDepth === 0) return 0;
  if (m.medianPrice < 0.05 || m.medianPrice > 0.95) return 0;

  // mid-band score: triangular peak at 0.5
  const midScore = 1 - Math.abs(m.medianPrice - 0.5) / 0.45; // 1 at 0.5, 0 at 0.05/0.95

  // spread score: 2+ ticks in absolute cents ≥ 0.2 at 0.001 tick or 2 at 0.01 tick
  const minSpread = 2 * m.tickSize * 100;
  const spreadScore = m.spreadCents >= minSpread ? Math.min(1, m.spreadCents / 5) : 0;

  // vol score: we want some movement so fills happen
  const volScore = Math.min(1, m.volCents / 1.5);

  // depth score: prefer balanced books
  const depthScore = Math.min(1, (Math.min(m.bidDepth, m.askDepth) || 1) / 200);

  return 2.5 * midScore + 3.0 * spreadScore + 2.5 * volScore + 2.0 * depthScore;
}

async function main() {
  const discoveryMode = process.env.DISCOVERY_MODE ?? "weather";
  const discoveryPreset = process.env.DISCOVERY_PRESET ?? "weather";
  console.log(`\nAnalyzing active markets (mode=${discoveryMode}, preset=${discoveryPreset}, days=${days} fidelity=${fidelity}min)\n`);

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
  const outcomes = events.flatMap((e) => e.markets.map((m) => ({ city: e.city, outcomeLabel: m.outcomeLabel, yesTokenId: m.yesTokenId })));
  console.log(`  ${events.length} events, ${outcomes.length} outcomes`);

  const markets = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    const label = `${o.city} ${o.outcomeLabel}`.slice(0, 32);
    try {
      const m = await characterizeMarket(o.yesTokenId, label);
      m.score = tradabilityScore(m);
      markets.push(m);
    } catch (err) {
      /* skip */
    }
    if ((i + 1) % 20 === 0) process.stdout.write(`  processed ${i + 1}/${outcomes.length}\r`);
  }
  console.log(`  processed ${markets.length}`);

  markets.sort((a, b) => b.score - a.score);

  console.log(
    "\nrank".padEnd(5),
    "outcome".padEnd(34),
    "tick".padStart(6),
    "mid".padStart(6),
    "spr¢".padStart(6),
    "vol¢".padStart(6),
    "bidDep".padStart(8),
    "askDep".padStart(8),
    "n_smp".padStart(6),
    "score".padStart(6)
  );
  console.log("-".repeat(100));
  for (let i = 0; i < Math.min(topN, markets.length); i++) {
    const m = markets[i];
    console.log(
      String(i + 1).padEnd(5),
      m.label.padEnd(34),
      String(m.tickSize).padStart(6),
      m.medianPrice.toFixed(3).padStart(6),
      m.spreadCents.toFixed(1).padStart(6),
      m.volCents.toFixed(2).padStart(6),
      m.bidDepth.toFixed(0).padStart(8),
      m.askDepth.toFixed(0).padStart(8),
      String(m.samples.length).padStart(6),
      m.score.toFixed(2).padStart(6)
    );
  }

  const tradable = markets.filter((m) => m.score >= 4);
  const marginal = markets.filter((m) => m.score >= 2 && m.score < 4);
  const dead = markets.length - tradable.length - marginal.length;
  console.log(`\nSummary: ${tradable.length} tradable (score ≥ 4), ${marginal.length} marginal (2-4), ${dead} dead (< 2).`);
  if (tradable.length === 0) {
    console.log(`\nNo tradable weather markets right now. Try again after events refresh, or retarget the discovery`);
    console.log(`to a different tag_id in src/adapters/weatherDiscovery.ts (sports, entertainment, politics).`);
  }
}

main().catch((err) => {
  console.error("Analysis failed:", err);
  process.exit(1);
});
