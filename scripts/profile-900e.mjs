#!/usr/bin/env node
/**
 * Empirical profile of wallet 0x900e (95.7% WR, $3,965 PnL, 258 closed).
 * Unlike 937 (NO-only scalper at 0.99+), 900e trades BOTH sides at a wide
 * price range (0.04-0.99). This script mirrors profile-937.mjs but surfaces
 * the axes that matter for a directional-bettor style: YES-cheap vs NO-rich,
 * hold-time × entry-band, per-city concentration, and the handful of outlier
 * losses that pull average PnL down from its 95% win rate.
 *
 * Usage: node scripts/profile-900e.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const ADDR = "0x900e2ba4b715e8e5088899948355d74c796ff6bf";
const FILE = path.resolve(`data/wallet-trades/${ADDR}.jsonl`);
const SUMMARY = path.resolve(`data/wallet-trades/${ADDR}.summary.json`);

function parseTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  let bucket = null;
  if (/\bhighest temperature\b/.test(t)) bucket = "highest";
  else if (/\blowest temperature\b/.test(t)) bucket = "lowest";
  let thrLow = null, thrHigh = null, unit = null;
  let m;
  if ((m = t.match(/be (\d+)-(\d+)\s*°?([cf])/))) {
    thrLow = Number(m[1]); thrHigh = Number(m[2]); unit = m[3].toUpperCase();
  } else if ((m = t.match(/be (above|over|below|under)\s*(\d+(?:\.\d+)?)\s*°?([cf])/))) {
    thrLow = Number(m[2]); thrHigh = thrLow; unit = m[3].toUpperCase();
  } else if ((m = t.match(/be (\d+(?:\.\d+)?)\s*°?([cf])/))) {
    thrLow = Number(m[1]); thrHigh = thrLow; unit = m[2].toUpperCase();
  }
  const cityMatch = title.match(/in ([A-Z][A-Za-z .'-]+?) be /);
  const city = cityMatch ? cityMatch[1].trim() : null;
  let type = null;
  if (/\bbe between\b/.test(t) || /be \d+-\d+/.test(t)) type = "between";
  else if (/\bbe (above|over|>=)/.test(t)) type = "above";
  else if (/\bbe (below|under|<=|\d+ ?°[cf] or below)/.test(t)) type = "below";
  else if (/\bbe \d/.test(t)) type = "exact";
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
    const p = total ? (100 * counts[i] / total) : 0;
    const bar = "█".repeat(Math.round(p / 2));
    lines.push(`  ${lo.padStart(6)}–${hi.padEnd(6)}  ${String(counts[i]).padStart(5)}  ${p.toFixed(1).padStart(5)}%  ${bar}`);
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
  const summary = JSON.parse(await fs.readFile(SUMMARY, "utf8"));
  const openPositions = Array.isArray(summary.openPositions) ? summary.openPositions : [];

  console.log(`=== 900e empirical profile ===`);
  console.log(`  closed=${trades.length}  open=${openPositions.length}  WR=${(100*summary.winRate).toFixed(1)}%  realizedPnl=$${summary.realizedPnlUsdc.toFixed(2)}`);
  console.log();

  // 1. Side mix
  const noTrades = trades.filter(t => t.side === "NO");
  const yesTrades = trades.filter(t => t.side === "YES");
  console.log(`Side mix (closed):`);
  console.log(`  NO  ${noTrades.length} (${(100*noTrades.length/trades.length).toFixed(1)}%)`);
  console.log(`  YES ${yesTrades.length} (${(100*yesTrades.length/trades.length).toFixed(1)}%)`);

  // 2. Entry price — per side — because 900e trades BOTH sides meaningfully
  for (const [label, sub] of [["NO", noTrades], ["YES", yesTrades]]) {
    if (!sub.length) continue;
    const entries = sub.map(t => t.entryAvg).filter(Number.isFinite);
    console.log(`\n${label} entry price:`);
    console.log(`  min=${Math.min(...entries).toFixed(4)} p10=${pct(entries,10).toFixed(4)} p25=${pct(entries,25).toFixed(4)} p50=${pct(entries,50).toFixed(4)} p75=${pct(entries,75).toFixed(4)} p90=${pct(entries,90).toFixed(4)} max=${Math.max(...entries).toFixed(4)}`);
    const edges = [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.80, 0.90, 0.95, 0.99, 0.999];
    console.log(fmtBuckets(edges, bucketize(entries, edges), entries.length));
  }

  // 3. Hold time (directional bettor: holds longer than a scalper)
  const holds = trades.map(t => t.holdMinutes).filter(Number.isFinite);
  console.log(`\nHold-minute distribution:`);
  console.log(`  min=${Math.min(...holds).toFixed(1)} p10=${pct(holds,10).toFixed(1)} p25=${pct(holds,25).toFixed(1)} p50=${pct(holds,50).toFixed(1)} p75=${pct(holds,75).toFixed(1)} p90=${pct(holds,90).toFixed(1)} p99=${pct(holds,99).toFixed(1)} max=${Math.max(...holds).toFixed(1)}`);
  const holdEdges = [5, 15, 30, 60, 120, 240, 480, 1440];
  console.log(fmtBuckets(holdEdges, bucketize(holds, holdEdges), holds.length));

  // 4. Exit type & exit price — do they scalp to 0.999, sell mid-run, or redeem?
  const sells = trades.filter(t => t.type === "sell");
  const redeems = trades.filter(t => t.type === "redeem");
  console.log(`\nExit type:`);
  console.log(`  sell    ${sells.length} (${(100*sells.length/trades.length).toFixed(1)}%)`);
  console.log(`  redeem  ${redeems.length} (${(100*redeems.length/trades.length).toFixed(1)}%)`);
  if (sells.length) {
    const exits = sells.map(t => t.exitPrice).filter(Number.isFinite);
    console.log(`  Sell-exit price: p10=${pct(exits,10).toFixed(4)} p25=${pct(exits,25).toFixed(4)} p50=${pct(exits,50).toFixed(4)} p75=${pct(exits,75).toFixed(4)} p90=${pct(exits,90).toFixed(4)}`);
    const edges = [0.05, 0.20, 0.50, 0.80, 0.90, 0.95, 0.99, 0.999];
    console.log(fmtBuckets(edges, bucketize(exits, edges), exits.length));
  }

  // 5. Sizing
  const sizes = trades.map(t => t.entryUsdc).filter(Number.isFinite);
  console.log(`\nEntry size (USDC):`);
  console.log(`  min=$${Math.min(...sizes).toFixed(2)} p10=$${pct(sizes,10).toFixed(2)} p50=$${pct(sizes,50).toFixed(2)} p75=$${pct(sizes,75).toFixed(2)} p90=$${pct(sizes,90).toFixed(2)} max=$${Math.max(...sizes).toFixed(2)}`);
  const sizeEdges = [10, 25, 50, 100, 250, 500, 1000, 5000];
  console.log(fmtBuckets(sizeEdges, bucketize(sizes, sizeEdges), sizes.length));

  // 6. PnL distribution — with 95.7% WR the long-tail losses matter most
  const pnls = trades.map(t => t.pnlUsdc).filter(Number.isFinite).sort((a,b)=>a-b);
  const totalPnl = pnls.reduce((a,b)=>a+b, 0);
  const winSum = pnls.filter(x => x > 0).reduce((a,b)=>a+b, 0);
  const lossSum = pnls.filter(x => x < 0).reduce((a,b)=>a+b, 0);
  console.log(`\nPnL per trade (USDC):`);
  console.log(`  totalPnl=$${totalPnl.toFixed(2)}  wins_sum=$${winSum.toFixed(2)}  losses_sum=$${lossSum.toFixed(2)}`);
  console.log(`  min=$${pnls[0].toFixed(2)}  p25=$${pct(pnls,25).toFixed(2)}  p50=$${pct(pnls,50).toFixed(2)}  p75=$${pct(pnls,75).toFixed(2)}  max=$${pnls[pnls.length-1].toFixed(2)}`);
  const pnlEdges = [-500, -100, -10, -1, 0, 1, 10, 50, 200];
  console.log(fmtBuckets(pnlEdges, bucketize(pnls, pnlEdges), pnls.length));

  // Top 10 losses and wins — qualitative outlier check
  const byPnl = [...trades].filter(t => Number.isFinite(t.pnlUsdc)).sort((a,b) => a.pnlUsdc - b.pnlUsdc);
  console.log(`\nTOP 10 losses:`);
  for (const t of byPnl.slice(0, 10)) {
    const city = parseTitle(t.title)?.city || "?";
    console.log(`  ${t.side} ${city.padEnd(18)} entry=${t.entryAvg.toFixed(4)} exit=${t.exitPrice?.toFixed(4) ?? "—"} shares=${t.shares.toFixed(1).padStart(7)} hold=${t.holdMinutes.toFixed(0)}min  pnl=$${t.pnlUsdc.toFixed(2)}`);
  }
  console.log(`\nTOP 10 wins:`);
  for (const t of byPnl.slice(-10).reverse()) {
    const city = parseTitle(t.title)?.city || "?";
    console.log(`  ${t.side} ${city.padEnd(18)} entry=${t.entryAvg.toFixed(4)} exit=${t.exitPrice?.toFixed(4) ?? "—"} shares=${t.shares.toFixed(1).padStart(7)} hold=${t.holdMinutes.toFixed(0)}min  pnl=$${t.pnlUsdc.toFixed(2)}`);
  }

  // 7. Time-of-day
  const hours = trades.map(t => new Date(t.openTs * 1000).getUTCHours());
  const hourCounts = new Array(24).fill(0);
  for (const h of hours) hourCounts[h]++;
  console.log(`\nEntry hour (UTC):`);
  for (let h = 0; h < 24; h++) {
    const p2 = 100 * hourCounts[h] / hours.length;
    const bar = "█".repeat(Math.round(p2 / 2));
    console.log(`  ${String(h).padStart(2, "0")}:00  ${String(hourCounts[h]).padStart(4)}  ${p2.toFixed(1).padStart(5)}%  ${bar}`);
  }

  // 8. Market type
  const typed = trades.map(t => ({ ...t, parsed: parseTitle(t.title) })).filter(t => t.parsed?.bucket);
  const byType = {}, byBucket = {};
  for (const t of typed) {
    if (t.parsed.type) byType[t.parsed.type] = (byType[t.parsed.type] || 0) + 1;
    byBucket[t.parsed.bucket] = (byBucket[t.parsed.bucket] || 0) + 1;
  }
  console.log(`\nMarket type (n=${typed.length}):`);
  for (const [k, v] of Object.entries(byType).sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(10)} ${v} (${(100*v/typed.length).toFixed(1)}%)`);
  console.log(`Bucket:`);
  for (const [k, v] of Object.entries(byBucket).sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(10)} ${v} (${(100*v/typed.length).toFixed(1)}%)`);

  // 9. City distribution
  const byCity = {};
  for (const t of typed) if (t.parsed.city) byCity[t.parsed.city] = (byCity[t.parsed.city] || 0) + 1;
  const ranked = Object.entries(byCity).sort((a,b)=>b[1]-a[1]).slice(0, 20);
  console.log(`\nTop 20 cities traded:`);
  for (const [c, n] of ranked) console.log(`  ${c.padEnd(20)} ${String(n).padStart(4)}`);

  // 10. Win-rate × entry-price × side — the core discriminator
  console.log(`\nWin rate × entry band (NO):`);
  const noBands = [[0.50, 0.80], [0.80, 0.90], [0.90, 0.95], [0.95, 0.98], [0.98, 0.995], [0.995, 1.001]];
  for (const [lo, hi] of noBands) {
    const sub = noTrades.filter(t => t.entryAvg >= lo && t.entryAvg < hi);
    if (!sub.length) continue;
    const wins = sub.filter(t => (t.pnlUsdc||0) > 0.01).length;
    const totalPnl = sub.reduce((s,t)=>s+(t.pnlUsdc||0), 0);
    console.log(`  [${lo.toFixed(3)}-${hi.toFixed(3)})  n=${String(sub.length).padStart(4)}  WR=${(100*wins/sub.length).toFixed(1).padStart(5)}%  PnL=$${totalPnl.toFixed(2)}`);
  }
  console.log(`\nWin rate × entry band (YES):`);
  const yesBands = [[0, 0.05], [0.05, 0.15], [0.15, 0.30], [0.30, 0.50], [0.50, 0.70], [0.70, 0.90], [0.90, 1.001]];
  for (const [lo, hi] of yesBands) {
    const sub = yesTrades.filter(t => t.entryAvg >= lo && t.entryAvg < hi);
    if (!sub.length) continue;
    const wins = sub.filter(t => (t.pnlUsdc||0) > 0.01).length;
    const totalPnl = sub.reduce((s,t)=>s+(t.pnlUsdc||0), 0);
    console.log(`  [${lo.toFixed(3)}-${hi.toFixed(3)})  n=${String(sub.length).padStart(4)}  WR=${(100*wins/sub.length).toFixed(1).padStart(5)}%  PnL=$${totalPnl.toFixed(2)}`);
  }

  // 11. Hold-time × PnL
  console.log(`\nWin rate × PnL by hold bucket:`);
  const hbands = [[0, 10], [10, 30], [30, 60], [60, 120], [120, 240], [240, 720], [720, 99999]];
  for (const [lo, hi] of hbands) {
    const sub = trades.filter(t => t.holdMinutes >= lo && t.holdMinutes < hi);
    if (!sub.length) continue;
    const wins = sub.filter(t => (t.pnlUsdc||0) > 0.01).length;
    const totalPnl = sub.reduce((s,t)=>s+(t.pnlUsdc||0), 0);
    console.log(`  [${lo}-${hi}min)  n=${String(sub.length).padStart(4)}  WR=${(100*wins/sub.length).toFixed(1).padStart(5)}%  PnL=$${totalPnl.toFixed(2)}`);
  }

  // 12. Open positions — current exposure regime
  if (openPositions.length) {
    console.log(`\n=== OPEN POSITIONS · ${openPositions.length} ===`);
    for (const p of openPositions) {
      const city = parseTitle(p.title)?.city || "?";
      const ageH = ((Date.now()/1000 - p.openTs) / 3600);
      console.log(`  ${p.side} ${city.padEnd(18)} entry=${p.entryAvg.toFixed(4)} size=$${(p.entryUsdc||0).toFixed(2)} age=${ageH.toFixed(1)}h  ${p.title}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
