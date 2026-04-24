#!/usr/bin/env node
/**
 * Fetch 1 year (or N days) of historical weather markets from Polymarket.
 *
 * Strategy:
 *   1. Query Polymarket Gamma API for events in "Weather" category,
 *      status=closed, within the requested date range.
 *   2. Extract conditionId + title for every market in those events.
 *   3. Filter to weather-temperature markets (exact pattern we scalp).
 *   4. Save a list of conditionIds + titles.
 *
 * After this, run:
 *   node scripts/fetch-tick-history-all.mjs
 * ... which will pick up the new markets alongside wallet-trade markets.
 * (We also update data/market-titles.json so the backtest can find them.)
 *
 * Usage:
 *   node scripts/fetch-yearly-weather-markets.mjs           # last 365 days
 *   node scripts/fetch-yearly-weather-markets.mjs --days=365
 *   node scripts/fetch-yearly-weather-markets.mjs --refresh # re-query all
 *
 * Runtime: ~2-5 min for 365 days (Gamma is fast, one paginated GET per page).
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

const GAMMA = "https://gamma-api.polymarket.com";
const OUT_DIR = path.resolve("data/weather-markets-catalog");
const MARKET_LIST_FILE = path.join(OUT_DIR, `weather-markets-${DAYS}d.json`);
const TITLES_FILE = path.resolve("data/market-titles.json");
await fs.mkdir(OUT_DIR, { recursive: true });

async function fetchJson(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        if (i === retries) throw new Error(`HTTP ${r.status}: ${body.slice(0, 120)}`);
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

// ----- 1. Query Gamma API for weather events in date range -----
const now = Math.floor(Date.now() / 1000);
const start = now - DAYS * 86400;
console.log(`Fetching weather markets from last ${DAYS} days (since ${new Date(start*1000).toISOString().slice(0,10)})...`);

const markets = new Map(); // conditionId -> { title, slug, endDate, tokenId }
const pageSize = 500;
let offset = 0;
let pageCount = 0;

// Gamma /markets endpoint supports: closed=true, tag=Weather OR tag_id=,
// startDateMin= (ISO), endDateMax=. We paginate.
while (true) {
  const url = `${GAMMA}/markets?` + new URLSearchParams({
    closed: "true",
    limit: String(pageSize),
    offset: String(offset),
    end_date_min: new Date(start * 1000).toISOString(),
    order: "endDate",
    ascending: "false",
    tag_slug: "weather"
  });
  let page;
  try { page = await fetchJson(url); }
  catch (e) {
    console.log(`page fetch failed at offset ${offset}: ${e.message}`);
    break;
  }
  if (!Array.isArray(page) || page.length === 0) break;
  pageCount++;
  for (const m of page) {
    const cid = m.conditionId;
    if (!cid) continue;
    const title = m.question || m.title || "";
    if (!/temperature/i.test(title)) continue;
    if (markets.has(cid)) continue;
    markets.set(cid, {
      conditionId: cid,
      title,
      slug: m.slug,
      endDate: m.endDate,
      eventId: m.events?.[0]?.id,
      clobTokenIds: m.clobTokenIds,
      resolved: m.closed,
      tokenId: null,
    });
  }
  process.stdout.write(`\r  page ${pageCount}: ${page.length} markets, running total ${markets.size} weather-temp`);
  if (page.length < pageSize) break;
  offset += pageSize;
  await new Promise(r => setTimeout(r, 100));
}
console.log(`\nGamma returned ${markets.size} unique weather-temperature markets in last ${DAYS} days`);

// ----- 2. Merge into title index -----
let titleIndex = {};
if (existsSync(TITLES_FILE)) {
  try { titleIndex = JSON.parse(await fs.readFile(TITLES_FILE, "utf8")); } catch {}
}
let newTitles = 0;
for (const [cid, m] of markets) {
  if (!titleIndex[cid]) { titleIndex[cid] = m.title; newTitles++; }
}
await fs.writeFile(TITLES_FILE, JSON.stringify(titleIndex));
console.log(`Merged into data/market-titles.json: +${newTitles} new, ${Object.keys(titleIndex).length} total`);

// ----- 3. Save market list for fetch-tick-history-all.mjs -----
const listOut = {
  fetchedAt: new Date().toISOString(),
  windowDays: DAYS,
  count: markets.size,
  markets: [...markets.values()],
};
await fs.writeFile(MARKET_LIST_FILE, JSON.stringify(listOut, null, 2));
console.log(`Saved: ${MARKET_LIST_FILE}`);

// ----- 4. Also write just the conditionIds for fetch-tick-history-all.mjs -----
const CIDS_FILE = path.join(OUT_DIR, "conditionIds-for-fetch.txt");
await fs.writeFile(CIDS_FILE, [...markets.keys()].join("\n") + "\n");
console.log(`Saved conditionIds list: ${CIDS_FILE}`);

console.log(`
Next steps:
  1. Fetch tick history for all these markets:
       node scripts/fetch-tick-history-year.mjs
  2. Fetch resolved-market cache (with samples) for price history:
       node scripts/fetch-resolved-markets-year.mjs
  3. Fetch historical weather (if extending past April 2026):
       node scripts/fetch-historical-weather.mjs
  4. Re-train classifier on 8-month / 4-month split:
       node scripts/train-classifier-v4-yearly.mjs
`);
