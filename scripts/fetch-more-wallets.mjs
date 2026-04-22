#!/usr/bin/env node
/**
 * Fetch activity + positions for every wallet in the profitable-weather list
 * and emit the same JSONL format as fetch-wallet-trades.mjs, so the
 * classifier training pipeline picks them up automatically.
 *
 * Usage:
 *   npm run fetch-more-wallets        # all 26 wallets
 *   node scripts/fetch-more-wallets.mjs -- --refresh
 *
 * Output: data/wallet-trades/<address>.jsonl + .summary.json
 * Runtime: ~15-25 min for 26 wallets (3000 events × 26 = 78k events max).
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));
const REFRESH = args.refresh === "true";

// User-provided profitable weather scalpers (≥95% win rate).
// 937 already fetched (data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl).
const WALLETS = [
  "0x38cc1d1f95d12039324809d8bb6ca6da6cbef88e",
  "0xa1782a357ec27ad78ef58394953184fa52522112",
  "0x900e2ba4b715e8e5088899948355d74c796ff6bf",
  "0xd28021317c1be36239e8d930dee7d6c3a40082b3",
  "0xeb258a5ba5cec11981a2619894824103e1a12fde",
  "0xd391d4c98709f61f72472cbd8e8126fc1e3c093f",
  "0x095704be156ec4e353110a82cc584b1173a25db6",
  "0x104171232971a6db8cf938f76fdbebbb81c5f452",
  "0x7bd9019211677f5db6e221d6a6da030ebcd0bd75",
  "0xf9151529abce6aa8357b99707ec06607cf238720",
  "0x8796b01a723066063eba805833778c276162eb9f",
  "0x261cd61ce457d51085d1eabe618207dcdb8a8b76",
  "0xd83cf89fa4ce75d1557c75657c9c9cb703ea798c",
  "0x8967942026fc0e64ff83c2366e056c632e53d7da",
  "0x881713021866ab84467b2b552b6cd7a51ac9cda8",
  "0x6049761986af66cd8e78997c940766bd69c7f14f",
  "0x087832036d877284a544d4b4d45bc0ce27a97b50",
  "0xea25d55fdfbf9bda6a629ba0f2f52adbf0e3885f",
  "0xdcd28b399f1643df577ed313d1ff6ba4ef2187c9",
  "0xf6f1282b3e2ae0e1560d16be3ea9ccd079897da3",
  "0x9177fe8603e6be18b9857d8fb08b9cb0e4bf0491",
  "0x63a1cf54908c86c480fec05eed11675a17d4d974",
  "0xece5634ace7b052a5757d88ea394e9ce8bf843cf",
  "0xa9074534c918f9bb59ea8be72319f85f4ba0ba96",
  "0xbe0a1b8db5e4b6e3cc80a307b3e794541cc7eed1",
  "0xbc8405b2c4149332c835ebb7e29e68e53eaba0d2"
];

const DATA_API = "https://data-api.polymarket.com";
const MAX_OFFSET = 2500;
const PAGE = 500;
const OUT_DIR = path.resolve("data/wallet-trades");
await fs.mkdir(OUT_DIR, { recursive: true });

const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${url.split("?")[0]}: ${t.slice(0, 140)}`);
  }
  return r.json();
}

async function fetchActivity(wallet) {
  const events = [];
  for (let offset = 0; offset < MAX_OFFSET; offset += PAGE) {
    const url = `${DATA_API}/activity?user=${wallet}&limit=${PAGE}&offset=${offset}`;
    let page;
    try { page = await fetchJson(url); } catch (e) { return { events, error: e.message }; }
    if (!Array.isArray(page) || !page.length) break;
    events.push(...page);
    if (page.length < PAGE) break;
    await new Promise(r => setTimeout(r, 40));
  }
  return { events };
}

async function fetchPositions(wallet) {
  try {
    const url = `${DATA_API}/positions?user=${wallet}&limit=500`;
    const j = await fetchJson(url);
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

/** FIFO matcher: reconstructs closed round-trips per (conditionId, outcomeIndex). */
function matchFifo(events, wallet) {
  const books = new Map();
  const closed = [];
  events.sort((a, b) => num(a.timestamp) - num(b.timestamp));
  for (const ev of events) {
    const ts = num(ev.timestamp);
    const cid = ev.conditionId;
    if (!cid) continue;
    const outcomeIdx = ev.outcomeIndex !== undefined ? num(ev.outcomeIndex) :
                       (String(ev.outcome || "").toLowerCase() === "yes" ? 0 : 1);
    const side = outcomeIdx === 0 ? "YES" : "NO";
    const key = `${cid}-${outcomeIdx}`;
    if (!books.has(key)) books.set(key, { lots: [], title: ev.title, asset: ev.asset });

    const book = books.get(key);
    if (!book.title && ev.title) book.title = ev.title;
    if (!book.asset && ev.asset) book.asset = ev.asset;

    const type = String(ev.type || "").toUpperCase();
    const action = String(ev.side || "").toUpperCase();

    if (type === "TRADE" && action === "BUY") {
      book.lots.push({ shares: num(ev.size), price: num(ev.price), usdc: num(ev.usdcSize || ev.size * ev.price), ts });
    } else if (type === "TRADE" && action === "SELL") {
      let remaining = num(ev.size);
      const exitPrice = num(ev.price);
      const lotsUsed = [];
      let costBasis = 0;
      while (remaining > 1e-9 && book.lots.length) {
        const lot = book.lots[0];
        const taken = Math.min(remaining, lot.shares);
        costBasis += taken * lot.price;
        lotsUsed.push({ shares: taken, price: lot.price, ts: lot.ts });
        lot.shares -= taken;
        remaining -= taken;
        if (lot.shares < 1e-9) book.lots.shift();
      }
      const matched = lotsUsed.reduce((s, l) => s + l.shares, 0);
      if (matched > 0) {
        const entryAvg = costBasis / matched;
        const pnlUsdc = matched * (exitPrice - entryAvg);
        const openTs = lotsUsed[0].ts;
        closed.push({
          wallet, conditionId: cid, outcomeIndex: outcomeIdx, side, asset: book.asset,
          title: book.title, type: "sell",
          openTs, closeTs: ts, holdMinutes: (ts - openTs) / 60,
          shares: matched, entryAvg, exitPrice,
          entryUsdc: costBasis, exitUsdc: matched * exitPrice,
          pnlUsdc, pnlPerShare: exitPrice - entryAvg,
          fifoLots: lotsUsed
        });
      }
    } else if (type === "REDEEM") {
      let remaining = book.lots.reduce((s, l) => s + l.shares, 0);
      if (remaining < 1e-9) continue;
      const redemptionPrice = num(ev.price, 1.0);
      const lotsUsed = [...book.lots];
      const costBasis = lotsUsed.reduce((s, l) => s + l.shares * l.price, 0);
      const entryAvg = costBasis / remaining;
      const pnlUsdc = remaining * (redemptionPrice - entryAvg);
      const openTs = lotsUsed[0]?.ts ?? ts;
      closed.push({
        wallet, conditionId: cid, outcomeIndex: outcomeIdx, side, asset: book.asset,
        title: book.title, type: "redeem",
        openTs, closeTs: ts, holdMinutes: (ts - openTs) / 60,
        shares: remaining, entryAvg, exitPrice: redemptionPrice,
        entryUsdc: costBasis, exitUsdc: remaining * redemptionPrice,
        pnlUsdc, pnlPerShare: redemptionPrice - entryAvg,
        fifoLots: lotsUsed
      });
      book.lots = [];
    }
  }
  return { closed, books };
}

async function processWallet(addr, tag) {
  const outFile = path.join(OUT_DIR, `${addr}.jsonl`);
  const sumFile = path.join(OUT_DIR, `${addr}.summary.json`);
  if (!REFRESH && existsSync(outFile)) {
    const sz = (await fs.stat(outFile)).size;
    if (sz > 100) { console.log(`${tag} ${addr.slice(0,10)}... cached, skipping`); return "skip"; }
  }
  process.stdout.write(`${tag} ${addr.slice(0, 10)}... `);
  const { events, error } = await fetchActivity(addr);
  if (error) { console.log(`ERR activity: ${error.slice(0,80)}`); return "fail"; }
  const positions = await fetchPositions(addr);
  const { closed } = matchFifo(events, addr);
  const body = closed.map(c => JSON.stringify(c)).join("\n");
  await fs.writeFile(outFile, body + (body ? "\n" : ""));
  const realized = closed.reduce((s, c) => s + (c.pnlUsdc || 0), 0);
  const wins = closed.filter(c => c.pnlUsdc > 0).length;
  const losses = closed.filter(c => c.pnlUsdc < 0).length;
  const summary = {
    wallet: addr, fetchedAt: new Date().toISOString(),
    activityEventCount: events.length,
    truncated: events.length >= MAX_OFFSET,
    closedTradeCount: closed.length,
    openPositionCount: positions.length,
    realizedPnlUsdc: realized,
    winRate: closed.length ? wins / closed.length : 0,
    closedWins: wins, closedLosses: losses,
    openPositions: positions
  };
  await fs.writeFile(sumFile, JSON.stringify(summary, null, 2));
  console.log(`${closed.length} closed trades, realized=$${realized.toFixed(2)}, wr=${closed.length ? (100*wins/closed.length).toFixed(0)+"%" : "-"}`);
  return "ok";
}

async function main() {
  console.log(`Fetching ${WALLETS.length} wallets (refresh=${REFRESH})\n`);
  let ok = 0, skip = 0, fail = 0;
  const startedAt = Date.now();
  for (let i = 0; i < WALLETS.length; i++) {
    const tag = `[${i + 1}/${WALLETS.length}]`;
    const res = await processWallet(WALLETS[i], tag);
    if (res === "ok") ok++;
    else if (res === "skip") skip++;
    else fail++;
    await new Promise(r => setTimeout(r, 100));
  }
  const elapsed = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\nDone. ok=${ok} skip=${skip} fail=${fail} elapsed=${elapsed}min`);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
