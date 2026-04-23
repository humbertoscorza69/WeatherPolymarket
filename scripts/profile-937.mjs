#!/usr/bin/env node
/**
 * Empirical profile of wallet 0x937 from data/wallet-trades/<addr>.jsonl.
 * Derives the actual strategy axes — entry price band, hold time, side mix,
 * market-type filter, sizing distribution, time-of-day pattern, threshold
 * offset — to anchor v29-empirical detect rules in real data, not guesses.
 *
 * Usage: node scripts/profile-937.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const FILE = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");

function parseTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  let type = null;
  if (/\bbe between\b/.test(t)) type = "between";
  else if (/\bbe (above|over|>= ?\d)/.test(t)) type = "above";
  else if (/\bbe (below|under|<= ?\d)/.test(t)) type = "below";
  else if (/\bbe \d/.test(t)) type = "between";       // "be 13°C" = exact bucket
  // HIGHEST/LOWEST hint
  let bucket = null;
  if (/\bhighest temperature\b/.test(t)) bucket = "highest";
  else if (/\blowest temperature\b/.test(t)) bucket = "lowest";
  // Threshold extraction: "be 13°C", "be 58-59°F", "be above 30°C"
  let thrLow = null, thrHigh = null, unit = null;
  let m;
  if ((m = t.match(/be (\d+)-(\d+)\s*°?([cf])/))) {
    thrLow = Number(m[1]); thrHigh = Number(m[2]); unit = m[3].toUpperCase();
  } else if ((m = t.match(/be (above|over|below|under)\s*(\d+(?:\.\d+)?)\s*°?([cf])/))) {
    thrLow = Number(m[2]); thrHigh = thrLow; unit = m[3].toUpperCase();
  } else if ((m = t.match(/be (\d+(?:\.\d+)?)\s*°?([cf])/))) {
    thrLow = Number(m[1]); thrHigh = thrLow; unit = m[2].toUpperCase();
  }
  // City: between "in" and "be"
  const cityMatch = title.match(/in ([A-Z][A-Za-z .'-]+?) be /);
  const city = cityMatch ? cityMatch[1].trim() : null;
  return { type, bucket, thrLow, thrHigh, unit, city };
}

function bucketize(values, edges) {
  const counts = new Array(edges.length + 1).fill(0);
  for (const v of values) {
    let i = edges.findIndex(e => v < e);
    if (i === -1) i = edges.length;
    counts[i]++;
  }
  return counts;
}

function fmtBuckets(edges, counts, total) {
  const lines = [];
  for (let i = 0; i < counts.length; i++) {
    const lo = i === 0 ? "-∞" : edges[i - 1].toString();
    const hi = i === edges.length ? "+∞" : edges[i].toString();
    const pct = total ? (100 * counts[i] / total) : 0;
    const bar = "█".repeat(Math.round(pct / 2));
    lines.push(`  ${lo.padStart(6)}–${hi.padEnd(6)}  ${String(counts[i]).padStart(5)}  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
  }
  return lines.join("\n");
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(p / 100 * s.length));
  return s[i];
}

async function main() {
  const txt = await fs.readFile(FILE, "utf8");
  const trades = txt.trim().split("\n").map(l => JSON.parse(l)).filter(t => t.holdMinutes != null);
  console.log(`=== 937 empirical profile · ${trades.length} closed trades ===\n`);

  // 1. Side mix
  const noTrades = trades.filter(t => t.side === "NO");
  const yesTrades = trades.filter(t => t.side === "YES");
  console.log(`Side mix:`);
  console.log(`  NO  ${noTrades.length} (${(100*noTrades.length/trades.length).toFixed(1)}%)`);
  console.log(`  YES ${yesTrades.length} (${(100*yesTrades.length/trades.length).toFixed(1)}%)`);

  // 2. Entry price distribution (NO-side)
  const noEntries = noTrades.map(t => t.entryAvg).filter(x => Number.isFinite(x));
  console.log(`\nNO entry price distribution:`);
  console.log(`  min=${Math.min(...noEntries).toFixed(4)} p10=${pct(noEntries,10).toFixed(4)} p50=${pct(noEntries,50).toFixed(4)} p90=${pct(noEntries,90).toFixed(4)} max=${Math.max(...noEntries).toFixed(4)}`);
  const noEdges = [0.50, 0.70, 0.80, 0.90, 0.95, 0.97, 0.98, 0.99, 0.995, 0.999];
  console.log(fmtBuckets(noEdges, bucketize(noEntries, noEdges), noEntries.length));

  // 3. Entry price distribution (YES-side)
  if (yesTrades.length) {
    const yesEntries = yesTrades.map(t => t.entryAvg).filter(x => Number.isFinite(x));
    console.log(`\nYES entry price distribution:`);
    console.log(`  min=${Math.min(...yesEntries).toFixed(4)} p10=${pct(yesEntries,10).toFixed(4)} p50=${pct(yesEntries,50).toFixed(4)} p90=${pct(yesEntries,90).toFixed(4)} max=${Math.max(...yesEntries).toFixed(4)}`);
    const yesEdges = [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.90];
    console.log(fmtBuckets(yesEdges, bucketize(yesEntries, yesEdges), yesEntries.length));
  }

  // 4. Hold time distribution
  const holds = trades.map(t => t.holdMinutes).filter(x => Number.isFinite(x));
  console.log(`\nHold-minute distribution:`);
  console.log(`  min=${Math.min(...holds).toFixed(1)} p10=${pct(holds,10).toFixed(1)} p50=${pct(holds,50).toFixed(1)} p90=${pct(holds,90).toFixed(1)} p99=${pct(holds,99).toFixed(1)} max=${Math.max(...holds).toFixed(1)}`);
  const holdEdges = [1, 5, 15, 30, 60, 120, 240, 720, 1440];
  console.log(fmtBuckets(holdEdges, bucketize(holds, holdEdges), holds.length));

  // 5. Exit price (TRADE/SELL only) → are they scalping near 1, or selling early?
  const sells = trades.filter(t => t.type === "sell");
  const redeems = trades.filter(t => t.type === "redeem");
  console.log(`\nExit type:`);
  console.log(`  sell    ${sells.length} (${(100*sells.length/trades.length).toFixed(1)}%) — order-book exit`);
  console.log(`  redeem  ${redeems.length} (${(100*redeems.length/trades.length).toFixed(1)}%) — settled at $1/$0`);
  if (sells.length) {
    const exits = sells.map(t => t.exitPrice).filter(x => Number.isFinite(x));
    console.log(`  Sell-exit price: p10=${pct(exits,10).toFixed(4)} p50=${pct(exits,50).toFixed(4)} p90=${pct(exits,90).toFixed(4)}`);
    const exitEdges = [0.50, 0.80, 0.90, 0.95, 0.98, 0.99, 0.995, 0.999];
    console.log(fmtBuckets(exitEdges, bucketize(exits, exitEdges), exits.length));
  }

  // 6. Sizing distribution (USDC at entry)
  const sizes = trades.map(t => t.entryUsdc).filter(x => Number.isFinite(x));
  console.log(`\nEntry size (USDC):`);
  console.log(`  min=$${Math.min(...sizes).toFixed(2)} p10=$${pct(sizes,10).toFixed(2)} p50=$${pct(sizes,50).toFixed(2)} p90=$${pct(sizes,90).toFixed(2)} max=$${Math.max(...sizes).toFixed(2)}`);
  const sizeEdges = [10, 25, 50, 100, 200, 500, 1000];
  console.log(fmtBuckets(sizeEdges, bucketize(sizes, sizeEdges), sizes.length));

  // 7. Time-of-day entry pattern (UTC hour)
  const hours = trades.map(t => new Date(t.openTs * 1000).getUTCHours());
  console.log(`\nEntry time (UTC hour):`);
  const hourCounts = new Array(24).fill(0);
  for (const h of hours) hourCounts[h]++;
  for (let h = 0; h < 24; h++) {
    const pct2 = (100 * hourCounts[h] / hours.length);
    const bar = "█".repeat(Math.round(pct2 / 2));
    console.log(`  ${String(h).padStart(2, "0")}:00  ${String(hourCounts[h]).padStart(4)}  ${pct2.toFixed(1).padStart(5)}%  ${bar}`);
  }

  // 8. Market type breakdown
  const typed = trades.map(t => ({ ...t, parsed: parseTitle(t.title) })).filter(t => t.parsed?.type);
  const byType = {};
  const byBucket = {};
  for (const t of typed) {
    byType[t.parsed.type] = (byType[t.parsed.type] || 0) + 1;
    if (t.parsed.bucket) byBucket[t.parsed.bucket] = (byBucket[t.parsed.bucket] || 0) + 1;
  }
  console.log(`\nMarket type (parsed from title, n=${typed.length}):`);
  for (const [k, v] of Object.entries(byType).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k.padEnd(10)} ${v} (${(100*v/typed.length).toFixed(1)}%)`);
  }
  console.log(`Bucket (HIGHEST vs LOWEST):`);
  for (const [k, v] of Object.entries(byBucket).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k.padEnd(10)} ${v} (${(100*v/typed.length).toFixed(1)}%)`);
  }

  // 9. City distribution (top 20)
  const byCity = {};
  for (const t of typed) if (t.parsed.city) byCity[t.parsed.city] = (byCity[t.parsed.city] || 0) + 1;
  console.log(`\nTop 20 cities traded:`);
  const ranked = Object.entries(byCity).sort((a,b)=>b[1]-a[1]).slice(0, 20);
  for (const [c, n] of ranked) console.log(`  ${c.padEnd(20)} ${String(n).padStart(4)}`);

  // 10. Win rate cross-tab: by side, by entry-price band
  console.log(`\nWin rate by entry band (NO):`);
  const bands = [[0.50, 0.80], [0.80, 0.90], [0.90, 0.95], [0.95, 0.98], [0.98, 0.99], [0.99, 0.995], [0.995, 1.001]];
  for (const [lo, hi] of bands) {
    const sub = noTrades.filter(t => t.entryAvg >= lo && t.entryAvg < hi);
    if (!sub.length) continue;
    const wins = sub.filter(t => (t.pnlUsdc || 0) > 0.01).length;
    const wr = 100 * wins / sub.length;
    const totalPnl = sub.reduce((s,t)=>s+(t.pnlUsdc||0),0);
    console.log(`  [${lo.toFixed(3)}-${hi.toFixed(3)})  n=${String(sub.length).padStart(4)}  WR=${wr.toFixed(1).padStart(5)}%  PnL=$${totalPnl.toFixed(2)}`);
  }

  // 11. Hold-time bucket vs PnL
  console.log(`\nWin rate × PnL by hold bucket:`);
  const hbands = [[0, 5], [5, 15], [15, 30], [30, 60], [60, 240], [240, 1440], [1440, 99999]];
  for (const [lo, hi] of hbands) {
    const sub = trades.filter(t => t.holdMinutes >= lo && t.holdMinutes < hi);
    if (!sub.length) continue;
    const wins = sub.filter(t => (t.pnlUsdc || 0) > 0.01).length;
    const wr = 100 * wins / sub.length;
    const totalPnl = sub.reduce((s,t)=>s+(t.pnlUsdc||0),0);
    console.log(`  [${lo}-${hi}min)  n=${String(sub.length).padStart(4)}  WR=${wr.toFixed(1).padStart(5)}%  PnL=$${totalPnl.toFixed(2)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
