#!/usr/bin/env node
/**
 * Fetch full per-trade history for the four flagship winning wallets and
 * emit structured JSONL files used by validate-backtest.mjs.
 *
 * Wallets (set here, not CLI):
 *   fc25…  — "buy 0.999 across all categories, hold to resolution"   ($2,543 / 604 closed)
 *   2785…  — "buy YES at 0.99 in 20 markets, hold ~2 days"           ($11,532)
 *   2d99…  — "buy NO at 0.90-0.99, hold ~2 days"                     ($22,066)
 *   937…   — "weather NO scalper at 0.95-0.99, minutes hold"         ($2,374 / 604 closed)
 *
 * For each wallet we:
 *   1. Pull every /activity event up to the API's 3000-offset cap.
 *   2. Pull current /positions for unrealized mark-to-market sanity check.
 *   3. FIFO-match BUY lots → SELL / REDEEM events per (conditionId, outcomeIndex).
 *   4. Emit one JSONL line per closed trade with enough fields for
 *      validate-backtest.mjs to cross-reference against the resolved-market
 *      cache.
 *
 * Usage:
 *   npm run fetch-wallet-trades
 *
 * Output:
 *   data/wallet-trades/<address>.jsonl   (one closed trade per line)
 *   data/wallet-trades/<address>.summary.json  (per-wallet totals)
 */

import fs from "node:fs/promises";
import path from "node:path";

const WALLETS = {
  fc25: "0xfc25f141ed27bb1787338d2c4e7f51e3a15e1f7f",
  "2785": "0x2785e7022dc20757108204b13c08cea8613b70ae",
  "2d99": "0x2d99e29c4f066ba32098c65e4c7454b277d94ca3",
  "937":  "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab"
};

const DATA_API = "https://data-api.polymarket.com";
const MAX_OFFSET = 2500;
const OUT_DIR = path.resolve("data/wallet-trades");

const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${url}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchAllActivity(user) {
  const all = [];
  let offset = 0;
  const limit = 500;
  let truncated = false;
  while (offset <= MAX_OFFSET) {
    const url = `${DATA_API}/activity?user=${user}&limit=${limit}&offset=${offset}`;
    let batch;
    try { batch = await fetchJson(url); } catch (e) {
      console.error(`    fetch failed at offset=${offset}: ${e.message}`);
      break;
    }
    if (!Array.isArray(batch)) batch = batch?.data ?? batch?.activity ?? [];
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset > MAX_OFFSET) { truncated = true; break; }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { events: all, truncated };
}

async function fetchPositions(user) {
  try {
    const data = await fetchJson(`${DATA_API}/positions?user=${user}`);
    return Array.isArray(data) ? data : data?.data ?? [];
  } catch (_) { return []; }
}

/**
 * FIFO-match closed trades per (conditionId, outcomeIndex).
 * Returns an array of structured per-trade records suitable for JSONL.
 */
function matchClosedTrades(events, wallet) {
  // oldest first so FIFO works correctly
  const sorted = events
    .filter((e) => {
      const t = e?.type ?? "TRADE";
      return t === "TRADE" || t === "REDEEM";
    })
    .sort((a, b) => num(a.timestamp) - num(b.timestamp));

  const books = new Map(); // key → { lots, meta }
  const closed = [];

  for (const ev of sorted) {
    const conditionId = ev.conditionId ?? ev.market ?? null;
    // Polymarket activity reports `outcomeIndex` (0 = YES, 1 = NO) on TRADE
    // events; `outcome` is the human label ("Yes", "No", "Team A", ...).
    // Some newer markets use "YES"/"NO" text in `outcome` only — treat those
    // as 0/1 based on lowercase match.
    let outcomeIndex = ev.outcomeIndex;
    if (outcomeIndex === undefined || outcomeIndex === null) {
      const o = String(ev.outcome ?? "").toLowerCase();
      if (o === "yes") outcomeIndex = 0;
      else if (o === "no") outcomeIndex = 1;
      else outcomeIndex = 0; // multi-outcome markets: keep stable at 0
    }
    if (!conditionId) continue;

    const key = `${conditionId}:${outcomeIndex}`;
    if (!books.has(key)) {
      books.set(key, {
        lots: [],
        conditionId,
        outcomeIndex,
        asset: ev.asset ?? ev.tokenId ?? null,
        title: ev.title ?? ev.eventTitle ?? ev.slug ?? key,
        side: outcomeIndex === 0 ? "YES" : "NO"
      });
    }
    const book = books.get(key);
    const type = ev.type ?? "TRADE";

    if (type === "TRADE" && ev.side === "BUY") {
      const shares = num(ev.size);
      const price = num(ev.price);
      if (shares <= 0 || price <= 0) continue;
      book.lots.push({
        shares,
        price,
        usdc: num(ev.usdcSize) || shares * price,
        ts: num(ev.timestamp)
      });
      if (!book.asset) book.asset = ev.asset ?? ev.tokenId ?? null;
    } else if (type === "TRADE" && ev.side === "SELL") {
      let remaining = num(ev.size);
      let cost = 0;
      let matched = 0;
      let openTs = book.lots[0]?.ts ?? num(ev.timestamp);
      const entryPrices = [];
      while (remaining > 1e-9 && book.lots.length > 0) {
        const lot = book.lots[0];
        const m = Math.min(lot.shares, remaining);
        cost += m * lot.price;
        matched += m;
        entryPrices.push({ shares: m, price: lot.price, ts: lot.ts });
        lot.shares -= m;
        remaining -= m;
        if (lot.shares < 1e-9) book.lots.shift();
      }
      if (matched > 0) {
        const exitPrice = num(ev.price);
        const entryAvg = cost / matched;
        const pnl = matched * exitPrice - cost;
        closed.push({
          wallet,
          conditionId: book.conditionId,
          outcomeIndex: book.outcomeIndex,
          side: book.side,
          asset: book.asset,
          title: book.title,
          type: "sell",
          openTs,
          closeTs: num(ev.timestamp),
          holdMinutes: (num(ev.timestamp) - openTs) / 60,
          shares: matched,
          entryAvg,
          exitPrice,
          entryUsdc: cost,
          exitUsdc: matched * exitPrice,
          pnlUsdc: pnl,
          pnlPerShare: pnl / matched,
          fifoLots: entryPrices
        });
      }
    } else if (type === "REDEEM") {
      const totalShares = book.lots.reduce((s, l) => s + l.shares, 0);
      if (totalShares < 1e-9) continue;
      const totalCost = book.lots.reduce((s, l) => s + l.shares * l.price, 0);
      const payout = num(ev.usdcSize) || totalShares; // assume $1 per winning share if missing
      const entryAvg = totalCost / totalShares;
      const pnl = payout - totalCost;
      closed.push({
        wallet,
        conditionId: book.conditionId,
        outcomeIndex: book.outcomeIndex,
        side: book.side,
        asset: book.asset,
        title: book.title,
        type: "redeem",
        openTs: book.lots[0]?.ts ?? null,
        closeTs: num(ev.timestamp),
        holdMinutes: book.lots[0]?.ts ? (num(ev.timestamp) - book.lots[0].ts) / 60 : null,
        shares: totalShares,
        entryAvg,
        exitPrice: payout / totalShares,
        entryUsdc: totalCost,
        exitUsdc: payout,
        pnlUsdc: pnl,
        pnlPerShare: pnl / totalShares,
        fifoLots: book.lots.map((l) => ({ shares: l.shares, price: l.price, ts: l.ts }))
      });
      book.lots = [];
    }
  }

  // Open positions (still-unsettled shares) — emit for debugging but mark clearly
  const openPositions = [];
  for (const [key, book] of books.entries()) {
    const shares = book.lots.reduce((s, l) => s + l.shares, 0);
    if (shares > 1e-6) {
      const cost = book.lots.reduce((s, l) => s + l.shares * l.price, 0);
      openPositions.push({
        wallet,
        conditionId: book.conditionId,
        outcomeIndex: book.outcomeIndex,
        side: book.side,
        asset: book.asset,
        title: book.title,
        shares,
        entryAvg: cost / shares,
        entryUsdc: cost,
        openTs: book.lots[0]?.ts
      });
    }
  }

  return { closed, openPositions };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const summaryByName = {};

  for (const [name, addr] of Object.entries(WALLETS)) {
    console.log(`\n${name} (${addr})`);
    process.stdout.write(`  fetching activity... `);
    const t0 = Date.now();
    const { events, truncated } = await fetchAllActivity(addr);
    process.stdout.write(`${events.length} events${truncated ? " [hit 3000 cap]" : ""} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    process.stdout.write(`  fetching positions... `);
    const positions = await fetchPositions(addr);
    process.stdout.write(`${positions.length} positions\n`);

    process.stdout.write(`  FIFO-matching... `);
    const { closed, openPositions } = matchClosedTrades(events, addr);
    const realizedPnl = closed.reduce((s, c) => s + c.pnlUsdc, 0);
    const unrealizedPnl = positions.reduce((s, p) => s + num(p.cashPnl), 0);
    const wins = closed.filter((c) => c.pnlUsdc > 0).length;
    const losses = closed.filter((c) => c.pnlUsdc < 0).length;
    const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
    process.stdout.write(`${closed.length} closed, ${openPositions.length} open, realized=$${realizedPnl.toFixed(2)}\n`);

    const jsonlPath = path.join(OUT_DIR, `${addr}.jsonl`);
    const jsonlBody = closed.map((c) => JSON.stringify(c)).join("\n") + "\n";
    await fs.writeFile(jsonlPath, jsonlBody, "utf8");

    const summary = {
      name,
      wallet: addr,
      fetchedAt: new Date().toISOString(),
      activityEventCount: events.length,
      truncated,
      closedTradeCount: closed.length,
      openPositionCount: openPositions.length,
      realizedPnlUsdc: realizedPnl,
      unrealizedPnlUsdc: unrealizedPnl,
      winRate,
      closedWins: wins,
      closedLosses: losses,
      openPositions
    };
    await fs.writeFile(
      path.join(OUT_DIR, `${addr}.summary.json`),
      JSON.stringify(summary, null, 2),
      "utf8"
    );
    summaryByName[name] = summary;

    console.log(`  → ${jsonlPath}`);
  }

  console.log(`\n=== Per-wallet summary ===\n`);
  console.log(
    "name".padEnd(6),
    "wallet".padEnd(12),
    "events".padStart(7),
    "closed".padStart(7),
    "realized".padStart(10),
    "unrlzd".padStart(9),
    "win%".padStart(6)
  );
  console.log("-".repeat(70));
  for (const [name, s] of Object.entries(summaryByName)) {
    console.log(
      name.padEnd(6),
      s.wallet.slice(0, 10).padEnd(12),
      String(s.activityEventCount).padStart(7),
      String(s.closedTradeCount).padStart(7),
      `$${s.realizedPnlUsdc.toFixed(0)}`.padStart(10),
      `$${s.unrealizedPnlUsdc.toFixed(0)}`.padStart(9),
      `${(s.winRate * 100).toFixed(0)}%`.padStart(6)
    );
  }
  console.log(`\nJSONL files ready in ${OUT_DIR}`);
  console.log(`Next: npm run validate-backtest`);
}

main().catch((e) => { console.error("\nfetch-wallet-trades failed:", e); process.exit(1); });
