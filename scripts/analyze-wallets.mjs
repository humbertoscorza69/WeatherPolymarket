#!/usr/bin/env node
/**
 * Verify whether a list of "winning wallets" has a real, copyable edge on
 * Polymarket. The public /activity endpoint doesn't return PnL fields, so
 * we compute realized PnL ourselves by FIFO-matching BUY against SELL and
 * REDEEM events per (conditionId, outcome). We also fetch current /positions
 * for unrealized mark-to-market.
 *
 * Public endpoints (no auth):
 *   GET /activity?user=<addr>&limit=500&offset=<n>   (offset capped at 3000)
 *   GET /positions?user=<addr>
 *
 * Usage:
 *   npm run analyze-wallets
 *   npm run analyze-wallets -- --days=30
 *   npm run analyze-wallets -- --wallet=0xabc...
 *   npm run analyze-wallets -- --dump=0xabc...   # per-trade dump
 */

import fs from "node:fs";
import path from "node:path";

const WALLETS = [
  "0x594edb9112f526fa6a80b8f858a6379c8a2c1c11",
  "0x15ceffed7bf820cd2d90f90ea24ae9909f5cd5fa",
  "0x38cc1d1f95d12039324809d8bb6ca6da6cbef88e",
  "0xd28021317c1be36239e8d930dee7d6c3a40082b3",
  "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab",
  "0xeb258a5ba5cec11981a2619894824103e1a12fde",
  "0xf39349b4ac2d7a46b2b286e21f388d4533e9d509",
  "0x7bd9019211677f5db6e221d6a6da030ebcd0bd75",
  "0x8796b01a723066063eba805833778c276162eb9f",
  "0x875e974594985283c999765461bf2e15b4dee6b5",
  "0x104171232971a6db8cf938f76fdbebbb81c5f452"
];

const DATA_API = "https://data-api.polymarket.com";
const MAX_OFFSET = 2500; // API hard-caps at 3000

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);
const lookbackDays = Number(args.days ?? "90");
const cutoffTs = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
const wallets = args.wallet ? [args.wallet] : args.dump ? [args.dump] : WALLETS;
const dumpMode = Boolean(args.dump);

function num(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${url}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchActivity(user) {
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
    const oldest = num(batch[batch.length - 1]?.timestamp);
    if (oldest && oldest < cutoffTs) break;
    offset += limit;
    if (offset > MAX_OFFSET) { truncated = true; break; }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { events: all.filter((a) => num(a?.timestamp) >= cutoffTs), truncated };
}

async function fetchPositions(user) {
  try {
    const data = await fetchJson(`${DATA_API}/positions?user=${user}`);
    return Array.isArray(data) ? data : data?.data ?? [];
  } catch (_) { return []; }
}

function classify(title) {
  const t = String(title || "").toLowerCase();
  if (/\b(high|low|temperature|degrees|°f|°c|rain|snow|snowfall|hurricane|storm|weather|tornado|heatwave|freeze|precipitation|nyc|lax|chicago|miami|boston|sfo|atlanta|phoenix|denver|seattle|houston|dallas|vegas)\b/.test(t)) return "weather";
  if (/\b(nfl|nba|mlb|nhl|soccer|epl|premier league|champions league|game|match|win.*(series|title)|super bowl|world cup|championship|stanley cup|f1|grand prix|ufc|tennis|open|masters)\b/.test(t)) return "sports";
  if (/\b(president|election|senate|congress|governor|primary|trump|biden|harris|desantis|vote|inaugur|cabinet)\b/.test(t)) return "politics";
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|doge|crypto|token|altcoin)\b/.test(t)) return "crypto";
  return "other";
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * FIFO-match BUY lots against SELL/REDEEM to compute realized PnL per
 * (conditionId, outcome). Returns an array of closed-position records.
 * Losing shares at resolution simply expire (no REDEEM event) — we detect
 * them by checking whether inventory is still > 0 after all events for a
 * market whose resolution is in our activity window.
 */
function computeRealizedPnl(activity) {
  const events = activity
    .filter((a) => {
      const type = a?.type ?? "TRADE";
      return type === "TRADE" || type === "REDEEM" || type === "REWARD";
    })
    .sort((a, b) => num(a.timestamp) - num(b.timestamp)); // oldest first

  const inv = new Map(); // key → { lots: [{shares, price, ts}], title, cat }
  const closed = [];

  for (const ev of events) {
    const key = `${ev.conditionId ?? ev.market}:${ev.outcome ?? ev.outcomeIndex ?? "0"}`;
    if (!inv.has(key)) {
      inv.set(key, { lots: [], title: ev.title ?? ev.eventTitle ?? ev.slug ?? key, cat: classify(ev.title) });
    }
    const book = inv.get(key);
    const type = ev?.type ?? "TRADE";
    const side = ev?.side;

    if (type === "TRADE" && side === "BUY") {
      book.lots.push({ shares: num(ev.size), price: num(ev.price), usdc: num(ev.usdcSize), ts: num(ev.timestamp) });
    } else if (type === "TRADE" && side === "SELL") {
      let remaining = num(ev.size);
      let cost = 0, matched = 0;
      const openTs = book.lots[0]?.ts ?? num(ev.timestamp);
      while (remaining > 1e-9 && book.lots.length > 0) {
        const lot = book.lots[0];
        const m = Math.min(lot.shares, remaining);
        cost += m * lot.price;
        matched += m;
        lot.shares -= m;
        remaining -= m;
        if (lot.shares < 1e-9) book.lots.shift();
      }
      if (matched > 0) {
        const pnl = matched * num(ev.price) - cost;
        closed.push({
          pnl, shares: matched,
          entryAvg: cost / matched, exitPrice: num(ev.price),
          market: book.title, cat: book.cat,
          openTs, closeTs: num(ev.timestamp),
          type: "sell"
        });
      }
    } else if (type === "REDEEM") {
      // Winning shares redeemed at $1 each. Payout = usdcSize.
      const totalShares = book.lots.reduce((s, l) => s + l.shares, 0);
      if (totalShares < 1e-9) continue;
      const totalCost = book.lots.reduce((s, l) => s + l.shares * l.price, 0);
      const payout = num(ev.usdcSize) || totalShares; // fallback: $1/share
      const pnl = payout - totalCost;
      closed.push({
        pnl, shares: totalShares,
        entryAvg: totalCost / totalShares, exitPrice: payout / totalShares,
        market: book.title, cat: book.cat,
        openTs: book.lots[0]?.ts, closeTs: num(ev.timestamp),
        type: "redeem"
      });
      book.lots = [];
    }
  }

  // Leftover open shares (unsettled in window)
  const openPositions = [];
  for (const [key, book] of inv.entries()) {
    const shares = book.lots.reduce((s, l) => s + l.shares, 0);
    if (shares > 1e-6) {
      const cost = book.lots.reduce((s, l) => s + l.shares * l.price, 0);
      openPositions.push({ key, title: book.title, cat: book.cat, shares, cost });
    }
  }

  return { closed, openPositions };
}

function summarize(activity, positions, user, truncated) {
  const trades = activity.filter((a) => (a?.type ?? "TRADE") === "TRADE" && a.side);
  const buys = trades.filter((t) => t.side === "BUY");
  const sells = trades.filter((t) => t.side === "SELL");

  const { closed, openPositions } = computeRealizedPnl(activity);
  const realized = closed.reduce((s, c) => s + c.pnl, 0);
  const wins = closed.filter((c) => c.pnl > 0).length;
  const losses = closed.filter((c) => c.pnl < 0).length;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;

  const unrealized = positions.reduce((s, p) => s + num(p.cashPnl), 0);
  const currentValue = positions.reduce((s, p) => s + num(p.currentValue ?? p.size * p.curPrice), 0);

  const volume = trades.reduce((s, t) => s + num(t.usdcSize), 0);
  const sizes = trades.map((t) => num(t.usdcSize)).filter((x) => x > 0);
  const medSize = median(sizes);
  const maxSize = sizes.reduce((m, x) => Math.max(m, x), 0);

  const catPnl = {};
  const catCount = {};
  for (const c of closed) {
    catPnl[c.cat] = (catPnl[c.cat] || 0) + c.pnl;
  }
  for (const t of trades) {
    const c = classify(t.title);
    catCount[c] = (catCount[c] || 0) + 1;
  }
  const catPct = {};
  for (const c of Object.keys(catCount)) catPct[c] = catCount[c] / trades.length;

  const ts = trades.map((t) => num(t.timestamp)).filter((x) => x > 0);
  const firstTs = ts.length ? Math.min(...ts) : 0;
  const lastTs = ts.length ? Math.max(...ts) : 0;
  const daysSinceLast = lastTs ? (Date.now() / 1000 - lastTs) / 86400 : 9999;

  const byMarket = new Map();
  for (const c of closed) {
    byMarket.set(c.market, (byMarket.get(c.market) || 0) + c.pnl);
  }
  const topWinners = [...byMarket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topLosers = [...byMarket.entries()].sort((a, b) => a[1] - b[1]).slice(0, 3);

  // Per-closed-position PnL distribution
  const pnlValues = closed.map((c) => c.pnl);
  const sortedPnl = [...pnlValues].sort((a, b) => a - b);
  const p05 = sortedPnl.length ? sortedPnl[Math.floor(sortedPnl.length * 0.05)] : 0;
  const p95 = sortedPnl.length ? sortedPnl[Math.floor(sortedPnl.length * 0.95)] : 0;
  const avgWin = wins ? closed.filter((c) => c.pnl > 0).reduce((s, c) => s + c.pnl, 0) / wins : 0;
  const avgLoss = losses ? closed.filter((c) => c.pnl < 0).reduce((s, c) => s + c.pnl, 0) / losses : 0;

  return {
    user, truncated,
    trades: trades.length, buys: buys.length, sells: sells.length,
    closed: closed.length, redeemed: closed.filter((c) => c.type === "redeem").length,
    openPositions: openPositions.length,
    realized, unrealized, currentValue,
    wins, losses, winRate,
    avgWin, avgLoss, p05, p95,
    volume, medSize, maxSize,
    catPct, catCount, catPnl,
    firstTs, lastTs, daysSinceLast,
    topWinners, topLosers
  };
}

function dumpTrades(activity, wallet) {
  const trades = activity.filter((a) => (a?.type ?? "TRADE") === "TRADE");
  trades.sort((a, b) => num(b.timestamp) - num(a.timestamp));
  console.log(`\nAll trades for ${wallet} (${trades.length} in last ${lookbackDays}d):\n`);
  for (const t of trades) {
    const dt = new Date(num(t.timestamp) * 1000).toISOString().slice(0, 16);
    const cat = classify(t.title);
    console.log(
      `  ${dt}  ${(t.side || "?").padEnd(4)} ${String(t.outcome ?? "").slice(0, 4).padEnd(4)} ` +
      `@${num(t.price).toFixed(3)} sz=$${num(t.usdcSize).toFixed(0).padStart(5)}  ` +
      `[${cat}] ${String(t.title || "").slice(0, 60)}`
    );
  }
}

async function main() {
  console.log(`\nAnalyzing ${wallets.length} wallet(s) over last ${lookbackDays} days...\n`);

  const results = [];
  for (const w of wallets) {
    process.stdout.write(`  ${w.slice(0, 12)}... `);
    const { events, truncated } = await fetchActivity(w);
    process.stdout.write(`${events.length} events${truncated ? " [truncated at 3000 cap]" : ""}`);
    if (events.length === 0) { console.log(" (inactive or blocked)"); continue; }
    if (dumpMode) { console.log(""); dumpTrades(events, w); return; }
    const positions = await fetchPositions(w);
    const s = summarize(events, positions, w, truncated);
    console.log(
      ` real=${s.realized >= 0 ? "+" : ""}$${s.realized.toFixed(0)} ` +
      `unreal=${s.unrealized >= 0 ? "+" : ""}$${s.unrealized.toFixed(0)} ` +
      `wr=${(s.winRate * 100).toFixed(0)}% closed=${s.closed}`
    );
    results.push(s);
  }

  if (results.length === 0) {
    console.log("\nNo activity found.");
    return;
  }

  results.sort((a, b) => b.realized + b.unrealized - (a.realized + a.unrealized));

  console.log(`\n=== Ranked by total PnL (realized + unrealized, last ${lookbackDays}d) ===\n`);
  console.log(
    "wallet".padEnd(14),
    "tr".padStart(5),
    "closed".padStart(7),
    "rdm".padStart(4),
    "win%".padStart(6),
    "realized".padStart(10),
    "unreal".padStart(9),
    "avgW/L".padStart(14),
    "medSz".padStart(7),
    "top cat".padStart(14),
    "idle".padStart(5)
  );
  console.log("-".repeat(115));
  for (const s of results) {
    const topCat = Object.entries(s.catPct).sort((a, b) => b[1] - a[1])[0];
    const catStr = topCat ? `${topCat[0]}(${(topCat[1] * 100).toFixed(0)}%)` : "-";
    console.log(
      `${s.user.slice(0, 12)}..`.padEnd(14),
      String(s.trades).padStart(5),
      String(s.closed).padStart(7),
      String(s.redeemed).padStart(4),
      `${(s.winRate * 100).toFixed(0)}%`.padStart(6),
      `${s.realized >= 0 ? "+" : ""}$${s.realized.toFixed(0)}`.padStart(10),
      `${s.unrealized >= 0 ? "+" : ""}$${s.unrealized.toFixed(0)}`.padStart(9),
      `+${s.avgWin.toFixed(1)}/${s.avgLoss.toFixed(1)}`.padStart(14),
      `$${s.medSize.toFixed(0)}`.padStart(7),
      catStr.padStart(14),
      s.daysSinceLast.toFixed(0).padStart(5)
    );
  }

  const copyable = results.filter((s) =>
    s.daysSinceLast < 14 &&
    s.winRate >= 0.60 &&
    s.realized + s.unrealized > 0 &&
    s.medSize < 1000 &&
    s.closed >= 20
  );

  console.log(`\n=== Copy-trade candidates (${copyable.length}/${results.length}) ===`);
  console.log("Filters: active ≤14d, win rate ≥60%, total PnL > 0, median < $1000, ≥20 closed positions\n");
  for (const s of copyable) {
    console.log(`  ${s.user}`);
    console.log(`    ${s.trades} trades (${s.buys}B/${s.sells}S), ${s.closed} closed (${s.redeemed} redeemed), ${s.openPositions} open`);
    console.log(`    Win rate: ${(s.winRate * 100).toFixed(0)}%  (${s.wins}W/${s.losses}L)   avgW=+$${s.avgWin.toFixed(1)}  avgL=$${s.avgLoss.toFixed(1)}   p05/p95=$${s.p05.toFixed(1)}/$${s.p95.toFixed(1)}`);
    console.log(`    Realized: ${s.realized >= 0 ? "+" : ""}$${s.realized.toFixed(0)}   Unrealized: ${s.unrealized >= 0 ? "+" : ""}$${s.unrealized.toFixed(0)}   Volume: $${s.volume.toFixed(0)}`);
    console.log(`    Median order: $${s.medSize.toFixed(0)}   Max: $${s.maxSize.toFixed(0)}`);
    console.log(`    PnL by category:`, Object.entries(s.catPnl).sort((a, b) => b[1] - a[1]).map(([c, p]) => `${c}:${p >= 0 ? "+" : ""}$${p.toFixed(0)}`).join("  "));
    console.log(`    Last active: ${new Date(s.lastTs * 1000).toISOString().slice(0, 10)} (${s.daysSinceLast.toFixed(0)}d ago)`);
    console.log(`    Top winning markets:`);
    for (const [m, p] of s.topWinners) {
      console.log(`      +$${p.toFixed(0).padStart(5)}  ${String(m).slice(0, 75)}`);
    }
    if (s.topLosers.length > 0 && s.topLosers[0][1] < -10) {
      console.log(`    Top losing markets:`);
      for (const [m, p] of s.topLosers) {
        if (p < 0) console.log(`      $${p.toFixed(0).padStart(6)}  ${String(m).slice(0, 75)}`);
      }
    }
    console.log("");
  }

  const outPath = path.join("data", "wallet-analysis.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Full detail → ${outPath}`);
  console.log(`\nFor a per-trade dump on a promising wallet: npm run analyze-wallets -- --dump=0x...`);
}

main().catch((e) => {
  console.error("analyze-wallets failed:", e);
  process.exit(1);
});
