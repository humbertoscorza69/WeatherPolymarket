#!/usr/bin/env node
/**
 * Timing analysis of 937's entries: time-of-day, day-of-week, and
 * time-to-resolution. Uses last tick timestamp per conditionId as proxy
 * for market end time.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const TRADES = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");
const SUMMARY = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.summary.json");
const TICK_DIR = path.resolve("data/tick-history");

function histo(values, edges, labelFn) {
  const counts = new Array(edges.length + 1).fill(0);
  for (const v of values) {
    let i = edges.findIndex(e => v < e);
    if (i === -1) i = edges.length;
    counts[i]++;
  }
  const total = values.length;
  const lines = [];
  for (let i = 0; i < counts.length; i++) {
    const lo = i === 0 ? "-∞" : String(edges[i-1]);
    const hi = i === edges.length ? "+∞" : String(edges[i]);
    const label = labelFn ? labelFn(lo, hi) : `${lo}–${hi}`;
    const pct = total ? (100*counts[i]/total) : 0;
    const bar = "█".repeat(Math.round(pct/2));
    lines.push(`  ${label.padEnd(16)}  ${String(counts[i]).padStart(5)}  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
  }
  return lines.join("\n");
}

const endTsCache = new Map();
async function lastTickTs(conditionId) {
  if (endTsCache.has(conditionId)) return endTsCache.get(conditionId);
  const file = path.join(TICK_DIR, `${conditionId}.jsonl`);
  if (!existsSync(file)) { endTsCache.set(conditionId, null); return null; }
  try {
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.trim().split("\n");
    // scan all, max ts
    let maxTs = 0;
    for (const l of lines) {
      try {
        const t = JSON.parse(l);
        if (t.timestamp > maxTs) maxTs = t.timestamp;
      } catch {}
    }
    endTsCache.set(conditionId, maxTs || null);
    return maxTs || null;
  } catch { endTsCache.set(conditionId, null); return null; }
}

async function main() {
  const trades = (await fs.readFile(TRADES, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const summary = JSON.parse(await fs.readFile(SUMMARY, "utf8"));
  const all = [...trades, ...(summary.openPositions || [])].filter(e => e.openTs);
  console.log(`=== 937 TIMING ANALYSIS · n=${all.length} (closed+open) ===\n`);

  // 1. UTC hour of entry
  const hours = all.map(e => new Date(e.openTs * 1000).getUTCHours());
  console.log(`Entry hour (UTC):`);
  const hourBuckets = new Array(24).fill(0);
  for (const h of hours) hourBuckets[h]++;
  for (let h = 0; h < 24; h++) {
    const pct = (100*hourBuckets[h]/hours.length);
    const bar = "█".repeat(Math.round(pct/2));
    console.log(`  ${String(h).padStart(2,"0")}:00  ${String(hourBuckets[h]).padStart(4)}  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
  }

  // 2. Day of week
  const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dowCounts = new Array(7).fill(0);
  for (const e of all) dowCounts[new Date(e.openTs * 1000).getUTCDay()]++;
  console.log(`\nEntry day of week (UTC):`);
  for (let i = 0; i < 7; i++) {
    const pct = (100*dowCounts[i]/all.length);
    const bar = "█".repeat(Math.round(pct/2));
    console.log(`  ${dow[i]}  ${String(dowCounts[i]).padStart(4)}  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
  }

  // 3. Time-to-resolution
  console.log(`\nTime-to-resolution (TTR) at entry...`);
  let ttrComputed = 0, ttrMissing = 0;
  const ttrHours = [];
  const hoursByCid = new Map();
  for (const e of all) {
    let end = hoursByCid.get(e.conditionId);
    if (end === undefined) { end = await lastTickTs(e.conditionId); hoursByCid.set(e.conditionId, end); }
    if (!end) { ttrMissing++; continue; }
    const ttrH = (end - e.openTs) / 3600;
    if (ttrH >= 0 && ttrH < 200) { ttrHours.push(ttrH); ttrComputed++; }
    else { ttrMissing++; }
  }
  console.log(`  (computed for ${ttrComputed}/${all.length}, ${ttrMissing} missing tick data)`);
  ttrHours.sort((a,b)=>a-b);
  const p = (q) => ttrHours[Math.floor(Math.min(ttrHours.length-1, q*ttrHours.length/100))];
  if (ttrHours.length) {
    console.log(`  p10=${p(10).toFixed(1)}h  p25=${p(25).toFixed(1)}h  p50=${p(50).toFixed(1)}h  p75=${p(75).toFixed(1)}h  p90=${p(90).toFixed(1)}h  max=${p(99).toFixed(1)}h`);
  }
  console.log(`\n  TTR histogram:`);
  console.log(histo(ttrHours, [0.5, 1, 2, 4, 8, 12, 16, 24, 48]));

  // 4. Entry hour CROSSED with TTR (to see if early-day entries have longer TTR)
  console.log(`\n=== UTC hour × TTR cross-tab ===`);
  console.log(`  hour   n    p50 TTR (h)   p90 TTR (h)`);
  for (let h = 0; h < 24; h++) {
    const sub = [];
    for (const e of all) {
      if (new Date(e.openTs * 1000).getUTCHours() !== h) continue;
      const end = hoursByCid.get(e.conditionId);
      if (!end) continue;
      const ttrH = (end - e.openTs) / 3600;
      if (ttrH >= 0 && ttrH < 200) sub.push(ttrH);
    }
    if (!sub.length) continue;
    sub.sort((a,b)=>a-b);
    const med = sub[Math.floor(sub.length/2)];
    const p90 = sub[Math.floor(sub.length * 0.9)];
    console.log(`  ${String(h).padStart(2,"0")}:00  ${String(sub.length).padStart(4)}      ${med.toFixed(1).padStart(5)}         ${p90.toFixed(1).padStart(5)}`);
  }

  // 5. Most-traded cities' timing — are different cities entered at different hours?
  console.log(`\n=== Entry hour by top 8 cities ===`);
  const cityRE = /temperature in ([A-Z][A-Za-z .'-]+?) be /;
  const byCity = new Map();
  for (const e of all) {
    const m = e.title && e.title.match(cityRE);
    if (!m) continue;
    const city = m[1].trim();
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push(new Date(e.openTs * 1000).getUTCHours());
  }
  const topCities = [...byCity.entries()].sort((a,b)=>b[1].length-a[1].length).slice(0, 8);
  console.log(`  ${"city".padEnd(15)}  n  |  p10  p50  p90 UTC hour`);
  for (const [city, hs] of topCities) {
    hs.sort((a,b)=>a-b);
    const h10 = hs[Math.floor(hs.length*0.1)];
    const h50 = hs[Math.floor(hs.length*0.5)];
    const h90 = hs[Math.floor(hs.length*0.9)];
    console.log(`  ${city.padEnd(15)} ${String(hs.length).padStart(3)}  |  ${String(h10).padStart(2,"0")}   ${String(h50).padStart(2,"0")}   ${String(h90).padStart(2,"0")}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
