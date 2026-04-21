#!/usr/bin/env node
/**
 * Profile the four target wallets from data/wallet-trades/*.jsonl to
 * reverse-engineer their real exit strategy. Hold-to-resolution is the
 * CURRENT backtest assumption and this script exists to falsify it.
 */

import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("data/wallet-trades");

const WALLETS = [
  { label: "fc25",  addr: "0xfc25f141ed27bb1787338d2c4e7f51e3a15e1f7f" },
  { label: "2785",  addr: "0x2785e7022dc20757108204b13c08cea8613b70ae" },
  { label: "2d99",  addr: "0x2d99e29c4f066ba32098c65e4c7454b277d94ca3" },
  { label: "937",   addr: "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab" }
];

const q = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[i];
};
const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
const fmt  = (n, d=3) => Number.isFinite(n) ? n.toFixed(d) : "nan";
const pct  = n => Number.isFinite(n) ? (100*n).toFixed(1)+"%" : "nan";

function categorize(title) {
  const t = (title || "").toLowerCase();
  if (/weather|temperature|rain|snow|high in|low in|highest temp/.test(t)) return "weather";
  if (/will .+ win on \d|real madrid|barcelona|liverpool|arsenal|fc\b|cf\b|vs\..* [0-9]{2}|raptors|cavaliers|celtics|knicks|nuggets|lakers|warriors|o\/u|spread:|moneyline|mlb|nba|nhl|hockey|baseball|football|soccer|game \d winner|bo3|bo5|tennis|open|madrid|atp|wta|ufc|mma/.test(t)) return "sports";
  if (/lol:|dota 2|esports|cs:|counter-strike|valorant/.test(t)) return "esports";
  if (/btc|bitcoin|ethereum|eth |solana|doge|crypto|price on/.test(t)) return "crypto";
  if (/trump|biden|fed|rate|election|congress|senate|iran|israel|ukraine|russia|china|pope|geopolitics/.test(t)) return "politics";
  if (/oscar|grammy|emmy|tv|film|movie|album|song|entertainment/.test(t)) return "entertainment";
  return "other";
}

function profileWallet({ label, addr }) {
  const p = path.join(DIR, `${addr}.jsonl`);
  if (!fs.existsSync(p)) { console.log(`SKIP ${label}: no file`); return; }
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  const trades = lines.map(l => JSON.parse(l));

  const nTotal   = trades.length;
  const sells    = trades.filter(t => t.type === "sell");
  const redeems  = trades.filter(t => t.type === "redeem");
  const nSell    = sells.length, nRedeem = redeems.length;

  const totalPnl = trades.reduce((s, t) => s + (t.pnlUsdc || 0), 0);
  const wins     = trades.filter(t => (t.pnlUsdc || 0) > 0).length;
  const losses   = trades.filter(t => (t.pnlUsdc || 0) < 0).length;

  const entries  = trades.map(t => t.entryAvg).filter(Number.isFinite);
  const exitsAll = trades.map(t => t.exitPrice).filter(Number.isFinite);
  const holdsMin = trades.map(t => t.holdMinutes).filter(Number.isFinite);
  const sizes    = trades.map(t => Math.abs(t.entryUsdc || 0)).filter(Number.isFinite);
  const sharesArr = trades.map(t => t.shares || 0);

  const pps      = trades.map(t => t.pnlPerShare).filter(Number.isFinite);
  const pctMoves = trades
    .filter(t => t.type === "sell" && Number.isFinite(t.exitPrice) && Number.isFinite(t.entryAvg) && t.entryAvg > 0)
    .map(t => (t.exitPrice - t.entryAvg));

  // Category mix
  const catCount = new Map();
  for (const t of trades) {
    const c = categorize(t.title);
    catCount.set(c, (catCount.get(c) || 0) + 1);
  }
  const totalCat = [...catCount.values()].reduce((x,y)=>x+y,0);
  const catLine = [...catCount.entries()]
    .sort((a,b) => b[1]-a[1])
    .map(([c,n]) => `${c}=${n}(${((100*n/totalCat)|0)}%)`).join(" ");

  // Entry price bucketing for "resolution holders" (entry ≥ 0.95 AND redeemed)
  const resolutionHolders = trades.filter(t => t.type === "redeem" && (t.entryAvg || 0) >= 0.95);
  const earlyExiters     = trades.filter(t => t.type === "sell"   && (t.entryAvg || 0) >= 0.95);

  console.log(`\n=== ${label.toUpperCase()} (${addr}) ===`);
  console.log(`trades=${nTotal} sell=${nSell}(${pct(nSell/nTotal)}) redeem=${nRedeem}(${pct(nRedeem/nTotal)})`);
  console.log(`wins=${wins} losses=${losses} totalPnl=$${fmt(totalPnl,2)}`);
  console.log(`entryAvg p05=${fmt(q(entries,0.05))} p50=${fmt(q(entries,0.5))} p95=${fmt(q(entries,0.95))}`);
  console.log(`exitPrice p05=${fmt(q(exitsAll,0.05))} p50=${fmt(q(exitsAll,0.5))} p95=${fmt(q(exitsAll,0.95))}`);
  console.log(`holdMin   p05=${fmt(q(holdsMin,0.05),1)} p50=${fmt(q(holdsMin,0.5),1)} p95=${fmt(q(holdsMin,0.95),1)}`);
  console.log(`size $    p05=${fmt(q(sizes,0.05),0)} p50=${fmt(q(sizes,0.5),0)} p95=${fmt(q(sizes,0.95),0)}`);
  console.log(`pnl/share p05=${fmt(q(pps,0.05),4)} p50=${fmt(q(pps,0.5),4)} p95=${fmt(q(pps,0.95),4)}`);
  console.log(`Δprice    p05=${fmt(q(pctMoves,0.05),4)} p50=${fmt(q(pctMoves,0.5),4)} p95=${fmt(q(pctMoves,0.95),4)}  (sell only)`);
  console.log(`categories: ${catLine}`);
  console.log(`resolution-holders (entry≥0.95 AND redeem): ${resolutionHolders.length}`);
  console.log(`early-exiters (entry≥0.95 AND sell):        ${earlyExiters.length}`);
  if (earlyExiters.length) {
    const pnlEarly = earlyExiters.reduce((s,t)=>s+(t.pnlUsdc||0),0);
    const holdEarly = earlyExiters.map(t=>t.holdMinutes).filter(Number.isFinite);
    console.log(`   early-exit pnl=$${fmt(pnlEarly,2)} median-hold=${fmt(q(holdEarly,0.5),1)}min`);
  }
  if (resolutionHolders.length) {
    const pnlHold = resolutionHolders.reduce((s,t)=>s+(t.pnlUsdc||0),0);
    console.log(`   resolution-hold pnl=$${fmt(pnlHold,2)}`);
  }

  // Top PnL contributors
  const sorted = [...trades].sort((a,b)=>(b.pnlUsdc||0)-(a.pnlUsdc||0));
  console.log(`top 3 winners:`);
  for (const t of sorted.slice(0,3)) {
    console.log(`   +$${fmt(t.pnlUsdc,2)}  ${t.type} entry=${fmt(t.entryAvg,3)} exit=${fmt(t.exitPrice,3)} shares=${fmt(t.shares,0)} hold=${fmt(t.holdMinutes,1)}min  "${(t.title||'').slice(0,60)}"`);
  }
  console.log(`bottom 3 losers:`);
  for (const t of sorted.slice(-3).reverse()) {
    console.log(`   $${fmt(t.pnlUsdc,2)}  ${t.type} entry=${fmt(t.entryAvg,3)} exit=${fmt(t.exitPrice,3)} shares=${fmt(t.shares,0)} hold=${fmt(t.holdMinutes,1)}min  "${(t.title||'').slice(0,60)}"`);
  }
}

for (const w of WALLETS) profileWallet(w);
