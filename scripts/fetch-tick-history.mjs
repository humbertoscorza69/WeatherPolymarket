#!/usr/bin/env node
/**
 * Tick-level trade fetcher for markets traded by a wallet.
 *
 * Pulls every TRADE event from data-api.polymarket.com/activity?market=<cid>
 * for each unique (conditionId, outcomeIndex) in the wallet's JSONL. This
 * gives true tick-level data (every execution: price, size, side, taker,
 * timestamp) versus the minute-sampled mid prices from /prices-history.
 *
 * We restrict the time window to [earliestEntry - 3h, marketEnd] per market
 * to stay within the 3000-offset API cap per query.
 *
 * Output:
 *   data/tick-history/<conditionId>-<outcomeIndex>.jsonl
 *     one line per trade:
 *     { ts, price, size, side, type, user, condition, outcomeIndex, ... }
 *   data/tick-history/_summary.json
 *     { markets, trades, coverage, elapsed }
 *
 * Usage:
 *   npm run fetch-tick-history
 *   node scripts/fetch-tick-history.mjs -- --wallet=0x937... --maxMarkets=50
 *
 * Runtime: ~10-25 min for 261 markets at ~50 req/market.
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
    throw new Error(`HTTP ${r.status} ${url}: ${t.slice(0, 160)}`);
  }
  return r.json();
}

/** Fetch all TRADE activity for a market (conditionId), paginated by offset.
 *  Filters to [startTs, endTs] client-side since the API sorts newest-first
 *  and we need to stop when we pass startTs. */
async function fetchMarketTrades(conditionId, startTs, endTs) {
  const trades = [];
  let schemaLogged = false;
  let hitCap = false;
  for (let offset = 0; offset < MAX_OFFSET; offset += PAGE_SIZE) {
    const url = `${DATA_API}/activity?market=${conditionId}&type=TRADE&limit=${PAGE_SIZE}&offset=${offset}`;
    let page;
    try {
      page = await fetchJson(url);
    } catch (e) {
      return { trades, error: e.message, hitCap };
    }
    if (!Array.isArray(page) || !page.length) break;
    if (!schemaLogged) { schemaLogged = true; /* first-page schema captured silently */ }
    let walkedPastStart = false;
    for (const ev of page) {
      const ts = Number(ev.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (ts < startTs) { walkedPastStart = true; continue; }
      if (ts > endTs) continue;
      trades.push(ev);
    }
    // If the oldest item on this page is already before startTs, we're done.
    const oldest = Number(page[page.length - 1]?.timestamp);
    if (Number.isFinite(oldest) && oldest < startTs) break;
    if (walkedPastStart && offset + PAGE_SIZE >= MAX_OFFSET) hitCap = true;
    // Courtesy delay
    await new Promise(r => setTimeout(r, 40));
  }
  return { trades, hitCap };
}

async function main() {
  if (!existsSync(TRADE_FILE)) { console.error(`Missing ${TRADE_FILE}`); process.exit(1); }
  const lines = (await fs.readFile(TRADE_FILE, "utf8")).trim().split("\n").filter(Boolean);
  const trades = lines.map(l => JSON.parse(l));
  console.log(`Loaded ${trades.length} wallet trades for ${WALLET}`);

  // Group by conditionId: figure out each market's fetch window
  const groups = new Map();
  for (const t of trades) {
    if (!groups.has(t.conditionId)) {
      groups.set(t.conditionId, {
        conditionId: t.conditionId,
        outcomeIndex: t.outcomeIndex,
        tokenId: t.asset,
        side: t.side,
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
  let totalFetched = 0, skipped = 0, failed = 0, coveragePartial = 0;

  for (let i = 0; i < targets.length; i++) {
    const m = targets[i];
    const tag = `[${i + 1}/${targets.length}]`;
    const outFile = path.join(OUT_DIR, `${m.conditionId}-${m.outcomeIndex}.jsonl`);
    if (!REFRESH && existsSync(outFile)) {
      const sz = (await fs.stat(outFile)).size;
      if (sz > 100) { skipped++; continue; }
    }
    const startTs = m.minTs - PAD_SEC_PRE;
    const endTs   = m.maxTs + PAD_SEC_POST;
    process.stdout.write(`${tag} ${m.conditionId.slice(0, 12)} side=${m.side} "${(m.title||"").slice(0,55)}" `);
    const { trades: ticks, hitCap, error } = await fetchMarketTrades(m.conditionId, startTs, endTs);
    if (error) {
      console.log(`ERR: ${error.slice(0,80)}`);
      failed++;
      continue;
    }
    // Sort ascending
    ticks.sort((a, b) => a.timestamp - b.timestamp);
    const body = ticks.map(t => JSON.stringify(t)).join("\n");
    await fs.writeFile(outFile, body + (body ? "\n" : ""));
    const span = ticks.length ? ((ticks[ticks.length-1].timestamp - ticks[0].timestamp)/3600).toFixed(1) + "h" : "-";
    console.log(`${ticks.length} ticks ${span}${hitCap ? " (CAP)" : ""}`);
    if (hitCap) coveragePartial++;
    totalFetched++;
    // Gentle global delay every 10 markets
    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 400));
  }

  const elapsed = ((Date.now() - startedAt) / 60000).toFixed(1);
  const summary = {
    wallet: WALLET,
    fetchedAt: new Date().toISOString(),
    marketsTotal: targets.length,
    marketsFetched: totalFetched,
    marketsSkipped: skipped,
    marketsFailed: failed,
    marketsCapped: coveragePartial,
    elapsedMin: elapsed
  };
  await fs.writeFile(path.join(OUT_DIR, "_summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nDone. fetched=${totalFetched} skipped=${skipped} failed=${failed} capped=${coveragePartial} elapsed=${elapsed}min`);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
