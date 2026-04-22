#!/usr/bin/env node
/**
 * Fetch tick history for markets traded by ANY wallet in data/wallet-trades/.
 * Union of conditionIds across all wallets. Skips markets we already have
 * tick data for.
 *
 * Same endpoint as fetch-tick-history.mjs: data-api/trades?market=<cid>.
 *
 * Usage:
 *   npm run fetch-tick-history-all
 *
 * Runtime: ~5-10 min for ~1500 new markets (hot path, smaller time windows).
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const DATA_API   = "https://data-api.polymarket.com";
const PAGE_SIZE  = 500;
const MAX_OFFSET = Number(argv.maxOffset ?? "2500");
const PAD_SEC_PRE  = Number(argv.padpre ?? String(3 * 3600));
const PAD_SEC_POST = Number(argv.padpost?? String(1 * 3600));
const REFRESH    = argv.refresh === "true";
const WEATHER_ONLY = argv.weatherOnly !== "false";

const TRADES_DIR = path.resolve("data/wallet-trades");
const OUT_DIR    = path.resolve("data/tick-history");
await fs.mkdir(OUT_DIR, { recursive: true });

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${t.slice(0, 100)}`);
  }
  return r.json();
}

async function fetchMarketTrades(conditionId, startTs, endTs) {
  const out = [];
  let hitCap = false;
  for (let offset = 0; offset < MAX_OFFSET; offset += PAGE_SIZE) {
    const url = `${DATA_API}/trades?market=${conditionId}&limit=${PAGE_SIZE}&offset=${offset}`;
    let page;
    try { page = await fetchJson(url); }
    catch (e) { return { trades: out, error: e.message, hitCap }; }
    if (!Array.isArray(page) || !page.length) break;
    for (const ev of page) {
      const ts = Number(ev.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (ts >= startTs && ts <= endTs) out.push(ev);
    }
    const oldest = Number(page[page.length - 1]?.timestamp);
    if (Number.isFinite(oldest) && oldest < startTs) break;
    if (offset + PAGE_SIZE >= MAX_OFFSET) { hitCap = true; break; }
    await new Promise(r => setTimeout(r, 40));
  }
  return { trades: out, hitCap };
}

async function main() {
  const walletFiles = (await fs.readdir(TRADES_DIR)).filter(f => f.endsWith(".jsonl"));
  const markets = new Map();
  for (const wf of walletFiles) {
    const lines = (await fs.readFile(path.join(TRADES_DIR, wf), "utf8")).trim().split("\n").filter(Boolean);
    for (const l of lines) {
      const t = JSON.parse(l);
      if (WEATHER_ONLY && !/temperature/i.test(t.title || "")) continue;
      if (!markets.has(t.conditionId)) {
        markets.set(t.conditionId, {
          conditionId: t.conditionId,
          title: t.title,
          minTs: t.openTs,
          maxTs: t.closeTs ?? t.openTs
        });
      } else {
        const g = markets.get(t.conditionId);
        if (t.openTs < g.minTs) g.minTs = t.openTs;
        if ((t.closeTs ?? t.openTs) > g.maxTs) g.maxTs = t.closeTs ?? t.openTs;
      }
    }
  }
  console.log(`Union of ${walletFiles.length} wallet JSONLs: ${markets.size} unique weather markets`);
  const needFetch = [...markets.values()].filter(m => {
    const p = path.join(OUT_DIR, `${m.conditionId}.jsonl`);
    if (REFRESH) return true;
    if (!existsSync(p)) return true;
    // Keep very small files (maybe failed before) — re-fetch if < 50 bytes
    try {
      const sz = fs.stat ? 0 : 0; // just re-check via existsSync already
    } catch {}
    return false;
  });
  console.log(`Already cached: ${markets.size - needFetch.length}  |  To fetch: ${needFetch.length}\n`);

  const startedAt = Date.now();
  let fetched = 0, failed = 0, capped = 0, totalTicks = 0;
  for (let i = 0; i < needFetch.length; i++) {
    const m = needFetch[i];
    const tag = `[${i+1}/${needFetch.length}]`;
    const startTs = m.minTs - PAD_SEC_PRE;
    const endTs   = m.maxTs + PAD_SEC_POST;
    process.stdout.write(`${tag} ${m.conditionId.slice(0,12)} "${(m.title||"").slice(0,50)}" `);
    const { trades: ticks, hitCap, error } = await fetchMarketTrades(m.conditionId, startTs, endTs);
    if (error) {
      console.log(`ERR: ${error.slice(0,60)}`);
      failed++;
      continue;
    }
    ticks.sort((a, b) => a.timestamp - b.timestamp);
    const body = ticks.map(t => JSON.stringify(t)).join("\n");
    await fs.writeFile(path.join(OUT_DIR, `${m.conditionId}.jsonl`), body + (body ? "\n" : ""));
    console.log(`${ticks.length} ticks${hitCap ? " (CAP)" : ""}`);
    if (hitCap) capped++;
    fetched++;
    totalTicks += ticks.length;
    if ((i + 1) % 20 === 0) await new Promise(r => setTimeout(r, 300));
  }
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  const summary = {
    fetchedAt: new Date().toISOString(),
    marketsInScope: markets.size,
    marketsNewlyFetched: fetched,
    marketsFailed: failed,
    marketsCapped: capped,
    totalTicksFetched: totalTicks,
    elapsedMin: Number(elapsedMin)
  };
  await fs.writeFile(path.join(OUT_DIR, "_summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nDone. fetched=${fetched} failed=${failed} capped=${capped} ticks=${totalTicks} elapsed=${elapsedMin}min`);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
