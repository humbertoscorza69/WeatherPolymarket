#!/usr/bin/env node
/**
 * Reverse-engineer 937 and fc25 decision logic:
 *   - hour-of-day distribution of entries (time-of-day edge?)
 *   - day-of-week distribution
 *   - which markets they pick (per-market PnL, per-market count)
 *   - entry-price histogram
 *   - hold-minutes histogram
 *   - win rate by bucket
 *
 * Input:  data/wallet-trades/<addr>.jsonl
 * Output: stdout summary
 */

import fs from "node:fs";
import path from "node:path";

const WALLETS = [
  { label: "937",  addr: "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab" },
  { label: "fc25", addr: "0xfc25f141ed27bb1787338d2c4e7f51e3a15e1f7f" }
];

function loadTrades(addr) {
  const p = path.resolve(`data/wallet-trades/${addr}.jsonl`);
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : "nan";
const bar = (v, max, width=20) => {
  const n = Math.max(0, Math.min(width, Math.round(width * v / (max || 1))));
  return "█".repeat(n) + "·".repeat(width - n);
};

function histByHour(trades) {
  const buckets = Array.from({length: 24}, () => ({ n: 0, pnl: 0, wins: 0 }));
  for (const t of trades) {
    const h = new Date(t.openTs * 1000).getUTCHours();
    buckets[h].n += 1;
    buckets[h].pnl += (t.pnlUsdc || 0);
    if ((t.pnlUsdc || 0) > 0) buckets[h].wins += 1;
  }
  return buckets;
}

function histByDow(trades) {
  const buckets = Array.from({length: 7}, () => ({ n: 0, pnl: 0, wins: 0 }));
  for (const t of trades) {
    const d = new Date(t.openTs * 1000).getUTCDay(); // 0=Sun
    buckets[d].n += 1;
    buckets[d].pnl += (t.pnlUsdc || 0);
    if ((t.pnlUsdc || 0) > 0) buckets[d].wins += 1;
  }
  return buckets;
}

function cityFromWeather(title) {
  const m = (title || "").match(/temperature in ([A-Z][\w .\-']+?)(?:\s+be|\s+on|,)/i);
  return m ? m[1].trim() : null;
}
function tempFromWeather(title) {
  const m = (title || "").match(/be (\d+)°?([CF])/);
  return m ? `${m[1]}${m[2]}` : null;
}

function groupBy(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const k = keyFn(t) || "(unknown)";
    if (!map.has(k)) map.set(k, { n: 0, pnl: 0, wins: 0, losses: 0 });
    const b = map.get(k);
    b.n += 1;
    b.pnl += (t.pnlUsdc || 0);
    if ((t.pnlUsdc || 0) > 0) b.wins += 1;
    else if ((t.pnlUsdc || 0) < 0) b.losses += 1;
  }
  return map;
}

function printHourHist(label, buckets) {
  const maxN = Math.max(...buckets.map(b => b.n));
  console.log(`\n-- ${label}: trades by UTC hour --`);
  console.log(`hr   n  ${"".padStart(20,' ')}    pnl$       winRate`);
  for (let h = 0; h < 24; h++) {
    const b = buckets[h];
    const wr = b.n ? (100 * b.wins / b.n).toFixed(0) + "%" : "-";
    console.log(`${String(h).padStart(2,'0')} ${String(b.n).padStart(4)} ${bar(b.n, maxN)}  ${fmt(b.pnl).padStart(8)}  ${wr}`);
  }
}

function printDowHist(label, buckets) {
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const maxN = Math.max(...buckets.map(b => b.n));
  console.log(`\n-- ${label}: trades by UTC day-of-week --`);
  for (let d = 0; d < 7; d++) {
    const b = buckets[d];
    const wr = b.n ? (100 * b.wins / b.n).toFixed(0) + "%" : "-";
    console.log(`${days[d]} ${String(b.n).padStart(4)} ${bar(b.n, maxN)}  ${fmt(b.pnl).padStart(8)}  ${wr}`);
  }
}

function printEntryHist(label, trades) {
  const bins = [
    { name: "≤0.50", lo: -Infinity, hi: 0.50 },
    { name: "0.50-0.80", lo: 0.50, hi: 0.80 },
    { name: "0.80-0.90", lo: 0.80, hi: 0.90 },
    { name: "0.90-0.95", lo: 0.90, hi: 0.95 },
    { name: "0.95-0.99", lo: 0.95, hi: 0.99 },
    { name: "0.99-0.995", lo: 0.99, hi: 0.995 },
    { name: "0.995-0.999", lo: 0.995, hi: 0.999 },
    { name: "≥0.999", lo: 0.999, hi: Infinity }
  ];
  const b = bins.map(x => ({ ...x, n: 0, pnl: 0, wins: 0 }));
  for (const t of trades) {
    const e = t.entryAvg;
    if (!Number.isFinite(e)) continue;
    for (const bin of b) {
      if (e >= bin.lo && e < bin.hi) { bin.n += 1; bin.pnl += (t.pnlUsdc||0); if ((t.pnlUsdc||0)>0) bin.wins += 1; break; }
    }
  }
  console.log(`\n-- ${label}: entry price histogram --`);
  for (const bin of b) {
    const wr = bin.n ? (100 * bin.wins / bin.n).toFixed(0) + "%" : "-";
    console.log(`${bin.name.padEnd(14)} ${String(bin.n).padStart(4)}  pnl=$${fmt(bin.pnl).padStart(8)}  wr=${wr}`);
  }
}

function printHoldHist(label, trades) {
  const bins = [
    { name: "<1min", lo: 0, hi: 1 },
    { name: "1-5min", lo: 1, hi: 5 },
    { name: "5-15min", lo: 5, hi: 15 },
    { name: "15-60min", lo: 15, hi: 60 },
    { name: "1-4h", lo: 60, hi: 240 },
    { name: "4-24h", lo: 240, hi: 1440 },
    { name: "1-7d", lo: 1440, hi: 10080 },
    { name: ">7d", lo: 10080, hi: Infinity }
  ];
  const b = bins.map(x => ({ ...x, n: 0, pnl: 0, wins: 0 }));
  for (const t of trades) {
    const h = t.holdMinutes;
    if (!Number.isFinite(h)) continue;
    for (const bin of b) {
      if (h >= bin.lo && h < bin.hi) { bin.n += 1; bin.pnl += (t.pnlUsdc||0); if ((t.pnlUsdc||0)>0) bin.wins += 1; break; }
    }
  }
  console.log(`\n-- ${label}: hold duration histogram --`);
  for (const bin of b) {
    const wr = bin.n ? (100 * bin.wins / bin.n).toFixed(0) + "%" : "-";
    console.log(`${bin.name.padEnd(10)} ${String(bin.n).padStart(4)}  pnl=$${fmt(bin.pnl).padStart(8)}  wr=${wr}`);
  }
}

function printTopMarkets(label, trades, topN = 15) {
  const grouped = groupBy(trades, t => t.conditionId);
  const sorted = [...grouped.entries()].sort((a,b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl));
  console.log(`\n-- ${label}: top ${topN} conditionIds by |PnL| --`);
  for (const [cid, b] of sorted.slice(0, topN)) {
    const sample = trades.find(t => t.conditionId === cid);
    const title = (sample?.title || "").slice(0, 55);
    const side  = sample?.side || "?";
    console.log(`  $${fmt(b.pnl).padStart(9)} n=${String(b.n).padStart(3)} w=${b.wins} l=${b.losses} ${side.padEnd(3)} "${title}"`);
  }
}

function printWeatherBreakdown(label, trades) {
  const weatherOnly = trades.filter(t => /temperature/i.test(t.title || ""));
  if (weatherOnly.length < 10) return;

  const byCity = groupBy(weatherOnly, t => cityFromWeather(t.title));
  const sortedCity = [...byCity.entries()].sort((a,b) => b[1].pnl - a[1].pnl);
  console.log(`\n-- ${label}: weather breakdown by city (top 10 by PnL) --`);
  for (const [city, b] of sortedCity.slice(0, 10)) {
    const wr = b.n ? (100 * b.wins / b.n).toFixed(0) + "%" : "-";
    console.log(`  ${city.padEnd(20)} n=${String(b.n).padStart(4)}  pnl=$${fmt(b.pnl).padStart(8)}  wr=${wr}`);
  }
  console.log(`-- ${label}: weather breakdown by city (bottom 10 by PnL) --`);
  for (const [city, b] of sortedCity.slice(-10).reverse()) {
    const wr = b.n ? (100 * b.wins / b.n).toFixed(0) + "%" : "-";
    console.log(`  ${city.padEnd(20)} n=${String(b.n).padStart(4)}  pnl=$${fmt(b.pnl).padStart(8)}  wr=${wr}`);
  }

  const bySide = groupBy(weatherOnly, t => t.side);
  console.log(`\n-- ${label}: weather by side --`);
  for (const [side, b] of bySide) {
    const wr = b.n ? (100 * b.wins / b.n).toFixed(0) + "%" : "-";
    console.log(`  ${side.padEnd(3)} n=${String(b.n).padStart(4)}  pnl=$${fmt(b.pnl).padStart(8)}  wr=${wr}`);
  }
}

function printInterTradeGap(label, trades) {
  const sorted = [...trades].sort((a,b) => a.openTs - b.openTs);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i].openTs - sorted[i-1].openTs) / 60);
  gaps.sort((a,b)=>a-b);
  const q = p => gaps[Math.floor(p*(gaps.length-1))];
  console.log(`\n-- ${label}: inter-trade gap (minutes between consecutive entries) --`);
  console.log(`  p05=${fmt(q(0.05),1)}  p25=${fmt(q(0.25),1)}  p50=${fmt(q(0.5),1)}  p75=${fmt(q(0.75),1)}  p95=${fmt(q(0.95),1)}`);
  console.log(`  span: first=${new Date(sorted[0].openTs*1000).toISOString()}  last=${new Date(sorted.at(-1).openTs*1000).toISOString()}`);
  const spanDays = (sorted.at(-1).openTs - sorted[0].openTs) / 86400;
  console.log(`  total span: ${fmt(spanDays,1)}d, avg ${fmt(trades.length/spanDays,2)} trades/day`);
}

for (const w of WALLETS) {
  const trades = loadTrades(w.addr);
  console.log(`\n${"=".repeat(80)}`);
  console.log(`${w.label.toUpperCase()}  (${w.addr})  trades=${trades.length}`);
  console.log("=".repeat(80));

  printHourHist(w.label, histByHour(trades));
  printDowHist(w.label, histByDow(trades));
  printEntryHist(w.label, trades);
  printHoldHist(w.label, trades);
  printInterTradeGap(w.label, trades);
  printTopMarkets(w.label, trades, 10);
  printWeatherBreakdown(w.label, trades);
}
