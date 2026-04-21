#!/usr/bin/env node
/**
 * Tick-level trade fetcher v3.
 *
 * Winner (from v2 probe): data-api.polymarket.com/trades?market=<conditionId>
 *   Returns array of trades with both YES and NO sides, fields:
 *     proxyWallet, side ("BUY"|"SELL" = taker aggressor), asset (tokenId),
 *     conditionId, size, price, timestamp, outcomeIndex, transactionHash, ...
 *
 * Pagination: offset=, max 2500 based on /activity pattern. Order: newest first.
 *
 * Output:
 *   data/tick-history/<conditionId>.jsonl    one line per trade (both sides)
 *   data/tick-history/_summary.json
 *
 * Usage:
 *   npm run fetch-tick-history
 *   node scripts/fetch-tick-history.mjs -- --maxMarkets=50   (partial test)
 *
 * Runtime estimate: 10-25 min for 261 markets.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const WALLET     = argv.wallet ?? "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";
const DATA_API   = "https://data-api.polymarket.com";
const PAGE_SIZE  = 500;
const MAX_OFFSET = Number(argv.maxOffset ?? "2500");
const MAX_MARKETS= Number(argv.maxMarkets ?? "1000");
const PAD_SEC_PRE  = Number(argv.padpre ?? String(3 * 3600));
const PAD_SEC_POST = Number(argv.padpost?? String(1 * 3600));
const REFRESH    = argv.refresh === "true";

const TRADE_FILE = path.resolve(`data/wallet-trades/${WALLET}.jsonl`);
const OUT_DIR    = path.resolve("data/tick-history");
await fs.mkdir(OUT_DIR, { recursive: true });

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${url.split("?")[0]}: ${t.slice(0, 100)}`);
  }
  return r.json();
}

/** Paginates /trades for a market, returning everything in [startTs, endTs]. */
async function fetchMarketTrades(conditionId, startTs, endTs) {
  const out = [];
  let hitCap = false;
  for (let offset = 0; offset < MAX_OFFSET; offset += PAGE_SIZE) {
    const url = `${DATA_API}/trades?market=${conditionId}&limit=${PAGE_SIZE}&offset=${offset}`;
    let page;
    try { page = await fetchJson(url); }
    catch (e) { return { trades: out, error: e.message, hitCap }; }
    if (!Array.isArray(page) || !page.length) break;

    let sawInWindow = false;
    for (const ev of page) {
      const ts = Number(ev.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (ts >= startTs && ts <= endTs) { out.push(ev); sawInWindow = true; }
    }
    const oldest = Number(page[page.length - 1]?.timestamp);
    // Newest-first: if the oldest item on this page is already before startTs,
    // the next page will be even older — stop.
    if (Number.isFinite(oldest) && oldest < startTs) break;
    if (offset + PAGE_SIZE >= MAX_OFFSET) { hitCap = true; break; }
    await new Promise(r => setTimeout(r, 40));
  }
  return { trades: out, hitCap };
}

async function main() {
  if (!existsSync(TRADE_FILE)) { console.error(`Missing ${TRADE_FILE}`); process.exit(1); }
  const lines = (await fs.readFile(TRADE_FILE, "utf8")).trim().split("\n").filter(Boolean);
  const walletTrades = lines.map(l => JSON.parse(l));
  console.log(`Loaded ${walletTrades.length} wallet trades for ${WALLET}`);

  // Group by conditionId only (one query covers both sides)
  const groups = new Map();
  for (const t of walletTrades) {
    if (!groups.has(t.conditionId)) {
      groups.set(t.conditionId, {
        conditionId: t.conditionId,
        title: t.title,
        minTs: t.openTs,
        maxTs: t.closeTs ?? t.openTs
      });
    } else {
      const g = groups.get(t.conditionId);
      if (t.openTs < g.minTs) g.minTs = t.openTs;
      if ((t.closeTs ?? t.openTs) > g.maxTs) g.maxTs = t.closeTs ?? t.openTs;
    }
  }
  const targets = [...groups.values()].slice(0, MAX_MARKETS);
  console.log(`Unique conditionIds: ${groups.size} (fetching ${targets.length})\n`);

  const startedAt = Date.now();
  let fetched = 0, skipped = 0, failed = 0, capped = 0, totalTicks = 0;

  for (let i = 0; i < targets.length; i++) {
    const m = targets[i];
    const tag = `[${i + 1}/${targets.length}]`;
    const outFile = path.join(OUT_DIR, `${m.conditionId}.jsonl`);
    if (!REFRESH && existsSync(outFile)) {
      const sz = (await fs.stat(outFile)).size;
      if (sz > 50) { skipped++; continue; }
    }
    const startTs = m.minTs - PAD_SEC_PRE;
    const endTs   = m.maxTs + PAD_SEC_POST;
    process.stdout.write(`${tag} ${m.conditionId.slice(0, 12)} "${(m.title||"").slice(0,55)}" `);
    const { trades: ticks, hitCap, error } = await fetchMarketTrades(m.conditionId, startTs, endTs);
    if (error) {
      console.log(`ERR: ${error.slice(0,80)}`);
      failed++;
      continue;
    }
    ticks.sort((a, b) => a.timestamp - b.timestamp);
    const body = ticks.map(t => JSON.stringify(t)).join("\n");
    await fs.writeFile(outFile, body + (body ? "\n" : ""));
    const span = ticks.length
      ? ((ticks[ticks.length-1].timestamp - ticks[0].timestamp)/3600).toFixed(1) + "h"
      : "-";
    console.log(`${ticks.length} ticks ${span}${hitCap ? " (CAP)" : ""}`);
    if (hitCap) capped++;
    fetched++;
    totalTicks += ticks.length;
    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 400));
  }

  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  const summary = {
    wallet: WALLET,
    fetchedAt: new Date().toISOString(),
    marketsTotal: targets.length,
    marketsFetched: fetched,
    marketsSkipped: skipped,
    marketsFailed: failed,
    marketsCapped: capped,
    totalTicks,
    elapsedMin: Number(elapsedMin)
  };
  await fs.writeFile(path.join(OUT_DIR, "_summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nDone. fetched=${fetched} skipped=${skipped} failed=${failed} capped=${capped} ticks=${totalTicks} elapsed=${elapsedMin}min`);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
