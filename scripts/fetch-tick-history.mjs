#!/usr/bin/env node
/**
 * Tick-level trade fetcher for markets traded by a wallet.
 *
 * v2: probes multiple Polymarket endpoints since data-api /activity?market=
 *     returns HTTP 400 without a user filter. Tries in order:
 *       1. data-api.polymarket.com/trades?market=<cid>  (preferred)
 *       2. data-api.polymarket.com/trades?market=<tokenId>
 *       3. gamma-api.polymarket.com/trades?market=<cid>
 *       4. clob.polymarket.com/trades?market=<tokenId>
 *       5. Goldsky subgraph GraphQL (fallback)
 *     First endpoint that returns a non-empty array on a test market wins.
 *
 * Output:
 *   data/tick-history/<conditionId>-<outcomeIndex>.jsonl
 *     one line per trade
 *   data/tick-history/_summary.json
 *
 * Usage:
 *   npm run fetch-tick-history
 *   node scripts/fetch-tick-history.mjs -- --probe     # only probe endpoints, no fetch
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const WALLET     = argv.wallet ?? "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";
const MAX_OFFSET = Number(argv.maxOffset ?? "2500");
const MAX_MARKETS= Number(argv.maxMarkets ?? "1000");
const PAD_SEC_PRE  = Number(argv.padpre ?? String(3 * 3600));
const PAD_SEC_POST = Number(argv.padpost?? String(1 * 3600));
const REFRESH    = argv.refresh === "true";
const PROBE_ONLY = argv.probe === "true";

const TRADE_FILE = path.resolve(`data/wallet-trades/${WALLET}.jsonl`);
const OUT_DIR    = path.resolve("data/tick-history");
await fs.mkdir(OUT_DIR, { recursive: true });

// ----------- endpoint probe strategies -----------

/** Each returns { ticks, done } where ticks is array of normalized {ts, price, size, side, taker}
 *  and done=true means no more data. null ticks => endpoint not usable. */

async function tryJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { err: `HTTP ${r.status}` };
    const j = await r.json();
    return { j };
  } catch (e) { return { err: e.message }; }
}

async function probeEndpoint(testMarket) {
  const { conditionId, tokenId } = testMarket;
  const candidates = [
    { name: "data-api/trades?market=cid",     url: `https://data-api.polymarket.com/trades?market=${conditionId}&limit=10` },
    { name: "data-api/trades?market=tokenId", url: `https://data-api.polymarket.com/trades?market=${tokenId}&limit=10` },
    { name: "gamma/trades?market=cid",        url: `https://gamma-api.polymarket.com/trades?market=${conditionId}&limit=10` },
    { name: "gamma/trades?condition_id=cid",  url: `https://gamma-api.polymarket.com/trades?condition_id=${conditionId}&limit=10` },
    { name: "clob/trades?market=tokenId",     url: `https://clob.polymarket.com/trades?market=${tokenId}&limit=10` },
    { name: "clob/price-history?market=tokenId", url: `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=max&fidelity=1` },
    { name: "data-api/activity?market=cid&limit=1 (needs user; reference)", url: `https://data-api.polymarket.com/activity?market=${conditionId}&limit=1` }
  ];
  console.log(`\nPROBING endpoints with market: ${conditionId.slice(0, 12)}... tokenId: ${tokenId.slice(0, 15)}...\n`);
  const results = [];
  for (const c of candidates) {
    const { j, err } = await tryJson(c.url);
    if (err) {
      console.log(`  [FAIL] ${c.name.padEnd(45)} ${err}`);
      results.push({ ...c, ok: false, err });
      continue;
    }
    const arr = Array.isArray(j) ? j : j?.trades ?? j?.data ?? j?.history ?? [];
    const n = Array.isArray(arr) ? arr.length : 0;
    console.log(`  [${n > 0 ? " OK " : "EMPTY"}] ${c.name.padEnd(45)} returned ${n} items`);
    if (n > 0) {
      console.log(`        keys:`, Object.keys(arr[0]).join(","));
      console.log(`        sample:`, JSON.stringify(arr[0]).slice(0, 260));
    }
    results.push({ ...c, ok: n > 0, n, sample: n > 0 ? arr[0] : null });
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

// ----------- subgraph (fallback) -----------
// Polymarket migrated from The Graph to Goldsky. Public orderbook subgraph URL
// has changed over time; we try a couple.
const SUBGRAPHS = [
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn",
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket-orderbook/prod/gn",
  "https://api.thegraph.com/subgraphs/name/polymarket/matic-markets"
];

async function probeSubgraph() {
  console.log(`\n-- probing subgraph endpoints --`);
  const query = `{ _meta { block { number } } }`;
  for (const url of SUBGRAPHS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ query })
      });
      const j = await r.json();
      if (j?.data?._meta) console.log(`  [ OK ] ${url} (block ${j.data._meta.block.number})`);
      else console.log(`  [FAIL] ${url} ${JSON.stringify(j).slice(0, 100)}`);
    } catch (e) { console.log(`  [FAIL] ${url} ${e.message}`); }
  }
}

// ----------- main -----------
async function main() {
  if (!existsSync(TRADE_FILE)) { console.error(`Missing ${TRADE_FILE}`); process.exit(1); }
  const lines = (await fs.readFile(TRADE_FILE, "utf8")).trim().split("\n").filter(Boolean);
  const trades = lines.map(l => JSON.parse(l));
  // Grab one market we know has liquidity for probe
  const firstTrade = trades[0];
  const testMarket = {
    conditionId: firstTrade.conditionId,
    tokenId: firstTrade.asset,
    title: firstTrade.title
  };

  const results = await probeEndpoint(testMarket);
  await probeSubgraph();
  const winner = results.find(r => r.ok);
  if (!winner) {
    console.log(`\nNO endpoint returned usable data. Options:`);
    console.log(`  1. Paste the network request made by the Polymarket UI trade-history tab.`);
    console.log(`  2. If tick data is not accessible, we pivot to the classifier on 1-min features.`);
    process.exit(2);
  }
  console.log(`\nWINNER: ${winner.name}  -> ${winner.url.split("?")[0]}`);
  if (PROBE_ONLY) {
    console.log(`(probe-only mode; not fetching)`);
    return;
  }

  console.log(`\nFull fetch not implemented for this endpoint yet — re-run with the winning endpoint after inspecting the sample above.`);
  console.log(`(Once we know the response schema & pagination, I'll plug it into this script and push v3.)`);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
