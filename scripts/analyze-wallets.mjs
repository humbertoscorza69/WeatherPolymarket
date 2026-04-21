#!/usr/bin/env node
/**
 * Verify whether a list of "winning wallets" has a real, copyable edge on
 * Polymarket. For each wallet we pull public trade activity, aggregate
 * realized PnL + win rate + category mix + recency, and flag the ones that
 * pass all copy-trade filters (active, high win rate, small-enough median
 * order size that we won't move the book following them).
 *
 * Uses https://data-api.polymarket.com/activity (public, no auth).
 *
 * Usage:
 *   npm run analyze-wallets
 *   npm run analyze-wallets -- --days=30           # narrower lookback
 *   npm run analyze-wallets -- --wallet=0xabc...   # drill down one wallet
 *   npm run analyze-wallets -- --dump=0xabc...     # dump every trade for wallet
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

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${url}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

/** Paginate /activity until we hit the lookback cutoff or exhaust results. */
async function fetchActivity(user) {
  const all = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const url = `${DATA_API}/activity?user=${user}&limit=${limit}&offset=${offset}`;
    let batch;
    try {
      batch = await fetchJson(url);
    } catch (e) {
      console.error(`    fetch failed at offset=${offset}: ${e.message}`);
      break;
    }
    // Response shape tolerance: some endpoints wrap under { data: [...] }
    if (!Array.isArray(batch)) {
      batch = batch?.data ?? batch?.activity ?? [];
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    const oldest = Number(batch[batch.length - 1]?.timestamp ?? 0);
    if (oldest && oldest < cutoffTs) break;
    offset += limit;
    if (offset > 20000) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return all.filter((a) => Number(a?.timestamp ?? 0) >= cutoffTs);
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

function num(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

function summarize(activity, user) {
  const trades = activity.filter((a) => (a?.type ?? "TRADE") === "TRADE" || a?.side);
  const buys = trades.filter((t) => t.side === "BUY");
  const sells = trades.filter((t) => t.side === "SELL");

  // Polymarket activity emits pnl on SELL rows when a position closes.
  const pnlSells = sells.filter((s) => typeof s.pnl === "number" || typeof s.realizedPnl === "number");
  const realized = pnlSells.reduce((s, t) => s + num(t.pnl ?? t.realizedPnl), 0);
  const wins = pnlSells.filter((t) => num(t.pnl ?? t.realizedPnl) > 0).length;
  const losses = pnlSells.filter((t) => num(t.pnl ?? t.realizedPnl) < 0).length;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;

  const volume = trades.reduce((s, t) => s + num(t.usdcSize ?? t.size * t.price), 0);
  const sizes = trades.map((t) => num(t.usdcSize ?? t.size * t.price)).filter((x) => x > 0);
  const medSize = median(sizes);
  const maxSize = sizes.reduce((m, x) => Math.max(m, x), 0);

  const catCount = {};
  for (const t of trades) {
    const c = classify(t.title ?? t.eventTitle ?? t.slug);
    catCount[c] = (catCount[c] || 0) + 1;
  }
  const catPct = {};
  for (const c of Object.keys(catCount)) catPct[c] = catCount[c] / trades.length;

  const ts = trades.map((t) => num(t.timestamp)).filter((x) => x > 0);
  const firstTs = ts.length ? Math.min(...ts) : 0;
  const lastTs = ts.length ? Math.max(...ts) : 0;
  const daysSinceLast = lastTs ? (Date.now() / 1000 - lastTs) / 86400 : 9999;

  const byMarket = new Map();
  for (const t of pnlSells) {
    const key = t.title ?? t.slug ?? t.conditionId ?? "unknown";
    byMarket.set(key, (byMarket.get(key) || 0) + num(t.pnl ?? t.realizedPnl));
  }
  const topWinners = [...byMarket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topLosers = [...byMarket.entries()].sort((a, b) => a[1] - b[1]).slice(0, 3);

  return {
    user,
    trades: trades.length,
    buys: buys.length,
    sells: sells.length,
    closed: pnlSells.length,
    realized,
    wins, losses, winRate,
    volume, medSize, maxSize,
    catPct, catCount,
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
    const pnl = typeof t.pnl === "number" ? ` pnl=${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "";
    const cat = classify(t.title);
    console.log(
      `  ${dt}  ${(t.side || "?").padEnd(4)} ${(t.outcome || "?").padEnd(4)} ` +
      `@${num(t.price).toFixed(3)} sz=$${num(t.usdcSize).toFixed(0).padStart(5)}${pnl}  [${cat}] ${String(t.title || "").slice(0, 60)}`
    );
  }
}

async function main() {
  console.log(`\nAnalyzing ${wallets.length} wallet(s) over last ${lookbackDays} days...\n`);

  const results = [];
  for (const w of wallets) {
    process.stdout.write(`  ${w.slice(0, 12)}... `);
    const activity = await fetchActivity(w);
    process.stdout.write(`${activity.length} events`);
    if (activity.length === 0) {
      console.log(" (inactive or API blocked)");
      continue;
    }
    if (dumpMode) {
      console.log("");
      dumpTrades(activity, w);
      return;
    }
    const s = summarize(activity, w);
    console.log(
      ` PnL=${s.realized >= 0 ? "+" : ""}$${s.realized.toFixed(0)} ` +
      `wr=${(s.winRate * 100).toFixed(0)}% ` +
      `vol=$${s.volume.toFixed(0)} ` +
      `closed=${s.closed}`
    );
    results.push(s);
  }

  if (results.length === 0) {
    console.log("\nNo activity found. Either all wallets are inactive, or the data-api is unreachable.");
    return;
  }

  results.sort((a, b) => b.realized - a.realized);

  console.log(`\n=== Ranked by realized PnL (last ${lookbackDays}d) ===\n`);
  console.log(
    "wallet".padEnd(14),
    "trades".padStart(7),
    "closed".padStart(7),
    "win%".padStart(6),
    "realized".padStart(10),
    "volume".padStart(10),
    "medSz".padStart(7),
    "top cat".padStart(14),
    "idle(d)".padStart(8)
  );
  console.log("-".repeat(95));
  for (const s of results) {
    const topCat = Object.entries(s.catPct).sort((a, b) => b[1] - a[1])[0];
    const catStr = topCat ? `${topCat[0]}(${(topCat[1] * 100).toFixed(0)}%)` : "-";
    console.log(
      `${s.user.slice(0, 12)}..`.padEnd(14),
      String(s.trades).padStart(7),
      String(s.closed).padStart(7),
      `${(s.winRate * 100).toFixed(0)}%`.padStart(6),
      `${s.realized >= 0 ? "+" : ""}$${s.realized.toFixed(0)}`.padStart(10),
      `$${s.volume.toFixed(0)}`.padStart(10),
      `$${s.medSize.toFixed(0)}`.padStart(7),
      catStr.padStart(14),
      s.daysSinceLast.toFixed(0).padStart(8)
    );
  }

  const copyable = results.filter((s) =>
    s.daysSinceLast < 14 &&
    s.winRate >= 0.65 &&
    s.realized > 0 &&
    s.medSize < 1000 &&
    s.closed >= 10
  );

  console.log(`\n=== Copy-trade candidates (${copyable.length}/${results.length}) ===`);
  console.log("Filters: active ≤14d, win rate ≥65%, realized PnL > 0, median order < $1000, ≥10 closed positions\n");
  for (const s of copyable) {
    console.log(`  ${s.user}`);
    console.log(`    ${s.trades} trades, ${s.closed} closed, win rate ${(s.winRate * 100).toFixed(0)}% (${s.wins}W/${s.losses}L)`);
    console.log(`    Realized: +$${s.realized.toFixed(0)}   Volume: $${s.volume.toFixed(0)}   Median order: $${s.medSize.toFixed(0)}   Max order: $${s.maxSize.toFixed(0)}`);
    console.log(`    Categories:`, Object.entries(s.catCount).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join("  "));
    console.log(`    Last active: ${new Date(s.lastTs * 1000).toISOString().slice(0, 10)} (${s.daysSinceLast.toFixed(0)}d ago)`);
    console.log(`    Top winners:`);
    for (const [m, p] of s.topWinners) {
      console.log(`      +$${p.toFixed(0).padStart(5)}  ${String(m).slice(0, 75)}`);
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
