#!/usr/bin/env node
/**
 * COMPREHENSIVE WALLET DATA FETCH
 *
 * Fetches EVERYTHING public about each winning wallet:
 *   1. /activity?user=<wallet>  — TRADE events + REDEEM/MERGE/CONVERT events
 *      (up to 3000 most recent — API hard limit per call;
 *       we page via offset)
 *   2. /trades?user=<wallet>    — individual fills (every taker/maker fill
 *      with maker-vs-taker flag if exposed, fees, etc.)
 *   3. /positions?user=<wallet> — current open positions (shares held)
 *   4. /value?user=<wallet>     — cumulative PnL snapshot
 *
 * Output per wallet (data/wallet-complete/<address>/):
 *   - activity.jsonl     — all activity events
 *   - trades.jsonl       — all individual fills
 *   - positions.json     — current open positions
 *   - value.json         — cumulative PnL/value snapshot
 *   - summary.json       — aggregated stats
 *
 * Also writes data/wallet-complete/_all-winners.json with top-level stats.
 *
 * NOTE: Polymarket does NOT expose other users' UNFILLED open orders
 * publicly. Only the wallet owner can see their own pending orders via
 * authenticated CLOB API. So we can see every FILL but not resting orders.
 *
 * Usage:
 *   node scripts/fetch-wallet-complete.mjs                  # all 30 wallets
 *   node scripts/fetch-wallet-complete.mjs --wallet=0x...   # single
 *   node scripts/fetch-wallet-complete.mjs --refresh        # re-fetch existing
 *
 * Runtime: ~20-30 min for 30 wallets (3 API calls each × pagination).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));
const REFRESH = argv.refresh === "true";
const SINGLE_WALLET = argv.wallet || null;

const DATA_API = "https://data-api.polymarket.com";
const OUT_DIR = path.resolve("data/wallet-complete");
await fs.mkdir(OUT_DIR, { recursive: true });

// All 30 winning wallets from our earlier research + 937
const ALL_WALLETS = [
  "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab",  // 937 — fast scalper reference
  "0x900e2ba4b715e8e5088899948355d74c796ff6bf",  // 900e — directional (YES+NO)
  "0xd391d4c98709f61f72472cbd8e8126fc1e3c093f",  // d391 — patient scalper
  "0xeb258a5ba5cec11981a2619894824103e1a12fde",  // eb258 — specialist
  "0x087832036d877284a544d4b4d45bc0ce27a97b50",  // 087832 — rebate farmer
  "0x261cd61ce457d51085d1eabe618207dcdb8a8b76",
  "0x38cc1d1f95d12039324809d8bb6ca6da6cbef88e",
  "0x63a1cf54908c86c480fec05eed11675a17d4d974",
  "0x7bd9019211677f5db6e221d6a6da030ebcd0bd75",
  "0x881713021866ab84467b2b552b6cd7a51ac9cda8",
  "0x8967942026fc0e64ff83c2366e056c632e53d7da",
  "0x9177fe8603e6be18b9857d8fb08b9cb0e4bf0491",
  "0xa1782a357ec27ad78ef58394953184fa52522112",
  "0xa9074534c918f9bb59ea8be72319f85f4ba0ba96",
  "0xbc8405b2c4149332c835ebb7e29e68e53eaba0d2",
  "0xbe0a1b8db5e4b6e3cc80a307b3e794541cc7eed1",
  "0xd28021317c1be36239e8d930dee7d6c3a40082b3",
  "0xd83cf89fa4ce75d1557c75657c9c9cb703ea798c",
  "0xdcd28b399f1643df577ed313d1ff6ba4ef2187c9",
  "0xea25d55fdfbf9bda6a629ba0f2f52adbf0e3885f",
  "0xece5634ace7b052a5757d88ea394e9ce8bf843cf",
  "0xf6f1282b3e2ae0e1560d16be3ea9ccd079897da3",
  "0xf9151529abce6aa8357b99707ec06607cf238720",
  "0xfc25f141ed27bb1787338d2c4e7f51e3a15e1f7f",
  "0x104171232971a6db8cf938f76fdbebbb81c5f452",
  "0x6049761986af66cd8e78997c940766bd69c7f14f",
  "0x2785e7022dc20757108204b13c08cea8613b70ae",
  "0x2d99e29c4f066ba32098c65e4c7454b277d94ca3",
  "0x8796b01a723066063eba805833778c276162eb9f",
  "0xd83cf89fa4ce75d1557c75657c9c9cb703ea798c",
];

const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

async function fetchJson(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        if (i === retries) throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
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

// 1. Activity: paged via offset, up to API's 3000 limit.
// The API returns HTTP 400 "max historical activity offset of 3000 exceeded"
// when offset reaches 3000 — that's a NORMAL STOP, not a failure.
async function fetchActivity(wallet, maxOffset = 5000, pageSize = 500) {
  const all = [];
  for (let offset = 0; offset < maxOffset; offset += pageSize) {
    const url = `${DATA_API}/activity?user=${wallet}&limit=${pageSize}&offset=${offset}`;
    let page;
    try { page = await fetchJson(url); }
    catch (e) {
      // API hard cap reached — treat as end-of-data, not error
      if (/max historical activity offset/i.test(e.message)) {
        return { events: all, truncated: true, reachedApiCap: true };
      }
      return { events: all, error: e.message };
    }
    if (!Array.isArray(page) || !page.length) break;
    all.push(...page);
    if (page.length < pageSize) break;
    await new Promise(r => setTimeout(r, 50));
  }
  return { events: all, truncated: all.length >= maxOffset };
}

// 2. Individual trade fills (separate endpoint — may give different info than activity)
// Also has offset cap — same "normal stop" handling.
async function fetchTrades(wallet, maxOffset = 10000, pageSize = 500) {
  const all = [];
  for (let offset = 0; offset < maxOffset; offset += pageSize) {
    const url = `${DATA_API}/trades?user=${wallet}&limit=${pageSize}&offset=${offset}`;
    let page;
    try { page = await fetchJson(url); }
    catch (e) {
      if (/max historical|offset of \d+ exceeded/i.test(e.message)) {
        return { trades: all, truncated: true, reachedApiCap: true };
      }
      return { trades: all, error: e.message };
    }
    if (!Array.isArray(page) || !page.length) break;
    all.push(...page);
    if (page.length < pageSize) break;
    await new Promise(r => setTimeout(r, 50));
  }
  return { trades: all, truncated: all.length >= maxOffset };
}

async function fetchPositions(wallet) {
  try {
    const url = `${DATA_API}/positions?user=${wallet}&limit=2000`;
    const j = await fetchJson(url);
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

async function fetchValue(wallet) {
  try {
    const url = `${DATA_API}/value?user=${wallet}`;
    return await fetchJson(url);
  } catch { return null; }
}

/**
 * FIFO matcher: reconstructs closed round-trips per (conditionId, outcomeIndex).
 * Same logic as fetch-wallet-trades.mjs but emits MORE fields (including
 * maker-vs-taker inferred from activity).
 */
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
      book.lots.push({
        shares: num(ev.size), price: num(ev.price),
        usdc: num(ev.usdcSize || ev.size * ev.price),
        ts, fee: num(ev.fee, 0), maker: ev.maker || false,
      });
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
          fifoLots: lotsUsed,
          exitFee: num(ev.fee, 0),
          exitMaker: ev.maker || false,
        });
      }
    } else if (type === "REDEEM") {
      let remaining = book.lots.reduce((s, l) => s + l.shares, 0);
      if (remaining < 1e-9) continue;
      // REDEEM events have price=0 in the API (meaningless).  Compute the
      // actual per-share payout from usdcSize / size. Winning redemption
      // pays $1/share; losing redemption pays $0/share.
      const size = num(ev.size, 0);
      const usdc = num(ev.usdcSize, 0);
      const redemptionPrice = size > 0 ? usdc / size : 0;
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
        fifoLots: lotsUsed,
        redemptionWon: redemptionPrice > 0.5,
      });
      book.lots = [];
    }
  }
  return { closed, openBooks: books };
}

async function processWallet(wallet, tag) {
  const walletDir = path.join(OUT_DIR, wallet);
  await fs.mkdir(walletDir, { recursive: true });
  const summaryFile = path.join(walletDir, "summary.json");
  if (!REFRESH && existsSync(summaryFile)) {
    const sz = (await fs.stat(summaryFile)).size;
    if (sz > 100) { console.log(`${tag} ${wallet.slice(0,10)}... cached, skipping`); return "skip"; }
  }
  process.stdout.write(`${tag} ${wallet.slice(0, 10)}... `);

  // 1. Activity
  const { events: activity, error: aerr, truncated: atrunc, reachedApiCap: aCap } = await fetchActivity(wallet);
  // Only fail if we got ZERO events AND there was an error (not a cap stop)
  if (aerr && activity.length === 0) {
    console.log(`ERR activity: ${aerr.slice(0,60)}`);
    return "fail";
  }

  // 2. Trades
  const { trades, error: terr, truncated: ttrunc, reachedApiCap: tCap } = await fetchTrades(wallet);

  // 3. Positions
  const positions = await fetchPositions(wallet);

  // 4. Value snapshot
  const value = await fetchValue(wallet);

  // Write raw data
  await fs.writeFile(path.join(walletDir, "activity.jsonl"), activity.map(e => JSON.stringify(e)).join("\n") + (activity.length ? "\n" : ""));
  await fs.writeFile(path.join(walletDir, "trades.jsonl"), trades.map(e => JSON.stringify(e)).join("\n") + (trades.length ? "\n" : ""));
  await fs.writeFile(path.join(walletDir, "positions.json"), JSON.stringify(positions, null, 2));
  if (value) await fs.writeFile(path.join(walletDir, "value.json"), JSON.stringify(value, null, 2));

  // FIFO-matched round trips
  const { closed, openBooks } = matchFifo(activity, wallet);
  await fs.writeFile(path.join(walletDir, "closed-trades.jsonl"),
    closed.map(c => JSON.stringify(c)).join("\n") + (closed.length ? "\n" : ""));

  // Open lots (not yet closed)
  const openLots = [];
  for (const [key, book] of openBooks) {
    if (book.lots.length) {
      openLots.push({ key, title: book.title, lots: book.lots, totalShares: book.lots.reduce((s,l)=>s+l.shares,0) });
    }
  }
  await fs.writeFile(path.join(walletDir, "open-lots.json"), JSON.stringify(openLots, null, 2));

  // Summary
  const realized = closed.reduce((s, c) => s + (c.pnlUsdc || 0), 0);
  const wins = closed.filter(c => c.pnlUsdc > 0).length;
  const losses = closed.filter(c => c.pnlUsdc < 0).length;
  const weatherClosed = closed.filter(c => /temperature/i.test(c.title || ""));
  const weatherRealized = weatherClosed.reduce((s, c) => s + (c.pnlUsdc || 0), 0);
  const weatherWins = weatherClosed.filter(c => c.pnlUsdc > 0.01).length;

  const summary = {
    wallet, fetchedAt: new Date().toISOString(),
    activityEventCount: activity.length,
    activityTruncated: atrunc,
    activityHitApiCap: !!aCap,
    tradeEventCount: trades.length,
    tradesTruncated: ttrunc,
    tradesHitApiCap: !!tCap,
    positionCount: positions.length,
    closedTradeCount: closed.length,
    openLotCount: openLots.length,
    realizedPnlUsdc: realized,
    winRateStrict: closed.length ? wins / closed.length : 0,
    wins, losses,
    // Weather-specific stats
    weatherClosedCount: weatherClosed.length,
    weatherRealizedPnl: weatherRealized,
    weatherWinRate: weatherClosed.length ? weatherWins / weatherClosed.length : 0,
    // Raw value from API
    valueSnapshot: value,
  };
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));

  console.log(`act=${activity.length} tr=${trades.length} pos=${positions.length} closed=${closed.length} openLots=${openLots.length} realized=\$${realized.toFixed(2)} weatherWR=${(summary.weatherWinRate*100).toFixed(0)}%`);
  return "ok";
}

async function main() {
  const list = SINGLE_WALLET ? [SINGLE_WALLET] : ALL_WALLETS;
  console.log(`Fetching ${list.length} wallets (refresh=${REFRESH})\n`);
  let ok = 0, skip = 0, fail = 0;
  const startedAt = Date.now();

  const superSummary = [];
  for (let i = 0; i < list.length; i++) {
    const tag = `[${i + 1}/${list.length}]`;
    const res = await processWallet(list[i], tag);
    if (res === "ok") ok++;
    else if (res === "skip") skip++;
    else fail++;
    await new Promise(r => setTimeout(r, 150));

    // Collect per-wallet summary for mega-summary
    const sumFile = path.join(OUT_DIR, list[i], "summary.json");
    if (existsSync(sumFile)) {
      try {
        const s = JSON.parse(await fs.readFile(sumFile, "utf8"));
        superSummary.push(s);
      } catch {}
    }
  }

  // Super summary across all wallets
  superSummary.sort((a, b) => (b.weatherRealizedPnl || 0) - (a.weatherRealizedPnl || 0));
  await fs.writeFile(path.join(OUT_DIR, "_all-winners.json"), JSON.stringify(superSummary, null, 2));

  const elapsed = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\nDone. ok=${ok} skip=${skip} fail=${fail} elapsed=${elapsed}min`);
  console.log(`\nTop 10 wallets by weather-trade realized PnL:`);
  for (const s of superSummary.slice(0, 10)) {
    console.log(`  ${s.wallet.slice(0,10)}...  weather_n=${s.weatherClosedCount}  WR=${(s.weatherWinRate*100).toFixed(0)}%  PnL=\$${(s.weatherRealizedPnl||0).toFixed(0)}  trunc=${s.activityTruncated?"YES":"no"}`);
  }
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
