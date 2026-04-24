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
const SUMMARY = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.summary.json");

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

  // ============== OPEN POSITIONS (separate regime) ==============
  // The closed-trade view shows exit behavior. Open positions show which
  // markets 937 is currently sitting in but hasn't sold yet — which can
  // reveal a hold-to-resolution sub-strategy invisible in closed data.
  let openPositions = [];
  try {
    const summary = JSON.parse(await fs.readFile(SUMMARY, "utf8"));
    openPositions = Array.isArray(summary.openPositions) ? summary.openPositions : [];
  } catch (e) { console.log(`\n(no summary file: ${e.message})`); }

  if (openPositions.length) {
    console.log(`\n\n=== OPEN POSITIONS · ${openPositions.length} ===`);

    // Side mix
    const oNo = openPositions.filter(p => p.side === "NO");
    const oYes = openPositions.filter(p => p.side === "YES");
    console.log(`Side mix:`);
    console.log(`  NO  ${oNo.length} (${(100*oNo.length/openPositions.length).toFixed(1)}%)`);
    console.log(`  YES ${oYes.length} (${(100*oYes.length/openPositions.length).toFixed(1)}%)`);

    // NO entry price
    const oNoEntries = oNo.map(p => p.entryAvg).filter(Number.isFinite);
    if (oNoEntries.length) {
      console.log(`\nOpen NO entry price:`);
      console.log(`  min=${Math.min(...oNoEntries).toFixed(4)} p10=${pct(oNoEntries,10).toFixed(4)} p25=${pct(oNoEntries,25).toFixed(4)} p50=${pct(oNoEntries,50).toFixed(4)} p75=${pct(oNoEntries,75).toFixed(4)} p90=${pct(oNoEntries,90).toFixed(4)} max=${Math.max(...oNoEntries).toFixed(4)}`);
      const noEdges2 = [0.20, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95, 0.97, 0.98, 0.99, 0.995, 0.999];
      console.log(fmtBuckets(noEdges2, bucketize(oNoEntries, noEdges2), oNoEntries.length));
    }

    // YES entry price
    const oYesEntries = oYes.map(p => p.entryAvg).filter(Number.isFinite);
    if (oYesEntries.length) {
      console.log(`\nOpen YES entry price:`);
      console.log(`  min=${Math.min(...oYesEntries).toFixed(4)} p10=${pct(oYesEntries,10).toFixed(4)} p50=${pct(oYesEntries,50).toFixed(4)} p90=${pct(oYesEntries,90).toFixed(4)} max=${Math.max(...oYesEntries).toFixed(4)}`);
      const yesEdges2 = [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.90];
      console.log(fmtBuckets(yesEdges2, bucketize(oYesEntries, yesEdges2), oYesEntries.length));
    }

    // Open position sizing
    const oSizes = openPositions.map(p => p.entryUsdc).filter(Number.isFinite);
    console.log(`\nOpen position size (USDC):`);
    console.log(`  min=$${Math.min(...oSizes).toFixed(2)} p10=$${pct(oSizes,10).toFixed(2)} p50=$${pct(oSizes,50).toFixed(2)} p90=$${pct(oSizes,90).toFixed(2)} max=$${Math.max(...oSizes).toFixed(2)}`);

    // Age of open positions (how long have they been held already)
    const nowSec = Math.floor(Date.now() / 1000);
    const ages = openPositions.map(p => (nowSec - p.openTs) / 60).filter(Number.isFinite);
    console.log(`\nOpen position AGE (minutes since openTs):`);
    console.log(`  min=${Math.min(...ages).toFixed(1)} p10=${pct(ages,10).toFixed(1)} p50=${pct(ages,50).toFixed(1)} p90=${pct(ages,90).toFixed(1)} max=${Math.max(...ages).toFixed(1)}`);
    const ageEdges = [60, 240, 1440, 4320, 10080, 43200];  // 1h, 4h, 1d, 3d, 7d, 30d
    console.log(fmtBuckets(ageEdges, bucketize(ages, ageEdges), ages.length));

    // Market type (open)
    const oTyped = openPositions.map(p => ({ ...p, parsed: parseTitle(p.title) })).filter(p => p.parsed?.type);
    const oByType = {};
    const oByBucket = {};
    for (const t of oTyped) {
      oByType[t.parsed.type] = (oByType[t.parsed.type] || 0) + 1;
      if (t.parsed.bucket) oByBucket[t.parsed.bucket] = (oByBucket[t.parsed.bucket] || 0) + 1;
    }
    console.log(`\nOpen market type (parsed, n=${oTyped.length}):`);
    for (const [k, v] of Object.entries(oByType).sort((a,b)=>b[1]-a[1])) {
      console.log(`  ${k.padEnd(10)} ${v} (${(100*v/oTyped.length).toFixed(1)}%)`);
    }
    console.log(`Open bucket:`);
    for (const [k, v] of Object.entries(oByBucket).sort((a,b)=>b[1]-a[1])) {
      console.log(`  ${k.padEnd(10)} ${v} (${(100*v/oTyped.length).toFixed(1)}%)`);
    }

    // ============ CLUSTER ANALYSIS — distinct sub-strategies? ============
    // Split open positions into price-band regimes to test the hypothesis
    // that 937 runs multiple strategies (scalper, mid-NO holder, lottery YES).
    console.log(`\n=== Open NO position REGIMES (cluster by entry price) ===`);
    const regimes = [
      { name: "deep-cheap (NO 0.20-0.50)", lo: 0.20, hi: 0.50 },
      { name: "mid-NO (0.50-0.80)",        lo: 0.50, hi: 0.80 },
      { name: "high-NO (0.80-0.95)",       lo: 0.80, hi: 0.95 },
      { name: "scalp-edge (0.95-0.99)",    lo: 0.95, hi: 0.99 },
      { name: "scalp-tip (0.99-0.999)",    lo: 0.99, hi: 0.999 },
      { name: "scalp-cap (0.999+)",        lo: 0.999, hi: 1.001 },
    ];
    for (const r of regimes) {
      const sub = oNo.filter(p => p.entryAvg >= r.lo && p.entryAvg < r.hi);
      if (!sub.length) continue;
      const totalUsdc = sub.reduce((s,p)=>s+(p.entryUsdc||0),0);
      const medAge = pct(sub.map(p=>(nowSec-p.openTs)/60).filter(Number.isFinite), 50);
      const medSize = pct(sub.map(p=>p.entryUsdc).filter(Number.isFinite), 50);
      console.log(`  ${r.name.padEnd(28)} n=${String(sub.length).padStart(4)} | $${totalUsdc.toFixed(0).padStart(7)} total | $${medSize.toFixed(0).padStart(4)} med size | ${medAge.toFixed(0).padStart(5)}min med age`);
    }

    console.log(`\n=== Open YES position REGIMES ===`);
    const yesRegimes = [
      { name: "lottery (YES ≤0.05)",       lo: 0.0,  hi: 0.05 },
      { name: "cheap (0.05-0.20)",         lo: 0.05, hi: 0.20 },
      { name: "mid-YES (0.20-0.50)",       lo: 0.20, hi: 0.50 },
      { name: "high-YES (0.50-0.90)",      lo: 0.50, hi: 0.90 },
      { name: "deep-YES (0.90+)",          lo: 0.90, hi: 1.001 },
    ];
    for (const r of yesRegimes) {
      const sub = oYes.filter(p => p.entryAvg >= r.lo && p.entryAvg < r.hi);
      if (!sub.length) continue;
      const totalUsdc = sub.reduce((s,p)=>s+(p.entryUsdc||0),0);
      const medAge = pct(sub.map(p=>(nowSec-p.openTs)/60).filter(Number.isFinite), 50);
      const medSize = pct(sub.map(p=>p.entryUsdc).filter(Number.isFinite), 50);
      console.log(`  ${r.name.padEnd(28)} n=${String(sub.length).padStart(4)} | $${totalUsdc.toFixed(0).padStart(7)} total | $${medSize.toFixed(0).padStart(4)} med size | ${medAge.toFixed(0).padStart(5)}min med age`);
    }

    // ============ Closed trades + open positions COMBINED price hist ============
    console.log(`\n=== COMBINED entry price (open + closed, NO side) ===`);
    const allNoEntries = [...noEntries, ...oNoEntries];
    const noEdges3 = [0.20, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95, 0.99, 0.999];
    console.log(fmtBuckets(noEdges3, bucketize(allNoEntries, noEdges3), allNoEntries.length));
    const allYesEntries = [...(yesTrades.map(t=>t.entryAvg).filter(Number.isFinite)), ...oYesEntries];
    if (allYesEntries.length) {
      console.log(`\n=== COMBINED entry price (open + closed, YES side) ===`);
      const yesEdges3 = [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.90];
      console.log(fmtBuckets(yesEdges3, bucketize(allYesEntries, yesEdges3), allYesEntries.length));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
