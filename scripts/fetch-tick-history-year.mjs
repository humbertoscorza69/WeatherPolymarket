#!/usr/bin/env node
/**
 * Fetch tick history for ALL weather markets in the 1-year catalog
 * (data/weather-markets-catalog/weather-markets-<DAYS>d.json).
 *
 * Same endpoint as fetch-tick-history-all.mjs: data-api/trades?market=<cid>.
 *
 * Usage:
 *   node scripts/fetch-tick-history-year.mjs [--days=365] [--refresh]
 *
 * Runtime estimate: 1 year ≈ 5000-8000 weather markets × ~1 sec each = 2-3 hours.
 * Can be resumed (skips already-fetched files unless --refresh).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));
const DAYS = Number(argv.days ?? "365");
const REFRESH = argv.refresh === "true";

const DATA_API = "https://data-api.polymarket.com";
const PAGE = 500;
const MAX_OFFSET = Number(argv.maxOffset ?? "5000");  // up to 10k trades per market

const CATALOG_FILE = path.resolve(`data/weather-markets-catalog/weather-markets-${DAYS}d.json`);
const OUT_DIR = path.resolve("data/tick-history");
await fs.mkdir(OUT_DIR, { recursive: true });

async function fetchJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) {
        if (i === retries) throw new Error(`HTTP ${r.status}`);
        await new Promise(x => setTimeout(x, 1000 * (i + 1)));
        continue;
      }
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(x => setTimeout(x, 1000 * (i + 1)));
    }
  }
}

async function fetchMarketTrades(conditionId) {
  const out = [];
  let hitCap = false;
  for (let offset = 0; offset < MAX_OFFSET; offset += PAGE) {
    const url = `${DATA_API}/trades?market=${conditionId}&limit=${PAGE}&offset=${offset}`;
    let page;
    try { page = await fetchJson(url); }
    catch (e) { return { trades: out, error: e.message, hitCap }; }
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < PAGE) break;
    if (offset + PAGE >= MAX_OFFSET) { hitCap = true; break; }
    await new Promise(r => setTimeout(r, 40));
  }
  return { trades: out, hitCap };
}

if (!existsSync(CATALOG_FILE)) {
  console.error(`Catalog not found: ${CATALOG_FILE}`);
  console.error(`Run first: node scripts/fetch-yearly-weather-markets.mjs --days=${DAYS}`);
  process.exit(1);
}
const catalog = JSON.parse(await fs.readFile(CATALOG_FILE, "utf8"));
console.log(`Catalog: ${catalog.count} markets over last ${catalog.windowDays} days`);

const needFetch = [];
for (const m of catalog.markets) {
  const out = path.join(OUT_DIR, `${m.conditionId}.jsonl`);
  if (!REFRESH && existsSync(out)) {
    const st = await fs.stat(out);
    if (st.size > 50) continue;  // already fetched
  }
  needFetch.push(m);
}
console.log(`Already cached: ${catalog.count - needFetch.length}  |  To fetch: ${needFetch.length}\n`);

const startedAt = Date.now();
let fetched = 0, failed = 0, capped = 0, totalTicks = 0;
for (let i = 0; i < needFetch.length; i++) {
  const m = needFetch[i];
  const tag = `[${i + 1}/${needFetch.length}]`;
  process.stdout.write(`${tag} ${m.conditionId.slice(0, 12)} "${(m.title || "").slice(0, 50)}" `);
  const { trades, hitCap, error } = await fetchMarketTrades(m.conditionId);
  if (error) {
    console.log(`ERR: ${error.slice(0, 60)}`);
    failed++;
    continue;
  }
  trades.sort((a, b) => a.timestamp - b.timestamp);
  const body = trades.map(t => JSON.stringify(t)).join("\n");
  await fs.writeFile(path.join(OUT_DIR, `${m.conditionId}.jsonl`), body + (body ? "\n" : ""));
  console.log(`${trades.length} ticks${hitCap ? " (CAP)" : ""}`);
  if (hitCap) capped++;
  fetched++;
  totalTicks += trades.length;
  if ((i + 1) % 25 === 0) await new Promise(r => setTimeout(r, 300));
}
const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
const summary = {
  fetchedAt: new Date().toISOString(),
  catalogCount: catalog.count,
  newlyFetched: fetched,
  failed, capped,
  totalTicks,
  elapsedMin: Number(elapsedMin),
};
await fs.writeFile(path.join(OUT_DIR, "_summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nDone. fetched=${fetched} failed=${failed} capped=${capped} ticks=${totalTicks} elapsed=${elapsedMin}min`);
