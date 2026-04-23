#!/usr/bin/env node
/**
 * Reverse-engineer 937's SELECTIVITY filter.
 *
 * For each of 937's entries:
 *   1. Parse (city, date, thresholdLo, thresholdHi, side) from the title
 *   2. Load data/weather-history/<city>__<date>.json
 *   3. Compute the actual HIGH observed that day (max tempC in 24-hour window)
 *   4. Compute "threshold distance" — how far 937's bet bucket is from the actual high
 *   5. Cross-tab by side, bucket relationship (above/below/contains), and cushion
 *
 * This tells us, empirically, the rule 937 uses to pick WHICH markets to enter.
 * e.g. "NO only when bucket is ≥X°C away from expected high."
 */
import fs from "node:fs/promises";
import path from "node:path";

const JSONL = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");
const SUMMARY = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.summary.json");
const WX_DIR = path.resolve("data/weather-history");

function parseTitle(title) {
  if (!title) return null;
  const t = title;
  let m;
  // Title format: "Will the highest temperature in <City> be [between] N[-M]°C|F on <Month> <D>?"
  const cityMatch = t.match(/temperature in ([A-Z][A-Za-z .'-]+?) be /);
  if (!cityMatch) return null;
  const city = cityMatch[1].trim();
  const bucket = /highest/i.test(t) ? "highest" : (/lowest/i.test(t) ? "lowest" : null);
  let thrLo = null, thrHi = null, unit = null;
  if ((m = t.match(/be (\d+)-(\d+)\s*°?([CF])/))) {
    thrLo = Number(m[1]); thrHi = Number(m[2]); unit = m[3];
  } else if ((m = t.match(/be (above|over|below|under)\s*(\d+(?:\.\d+)?)\s*°?([CF])/i))) {
    thrLo = Number(m[2]); thrHi = thrLo; unit = m[3];
  } else if ((m = t.match(/be (\d+(?:\.\d+)?)\s*°?([CF])/))) {
    thrLo = Number(m[1]); thrHi = thrLo; unit = m[2];
  }
  // Date
  let date = null;
  const iso = t.match(/on\s+(\d{4}-\d{2}-\d{2})/);
  const mon = t.match(/on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)(?:,\s*(\d{4}))?/i);
  if (iso) date = iso[1];
  else if (mon) {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const mi = months.findIndex(x => x.toLowerCase() === mon[1].toLowerCase());
    const y = mon[3] || "2026";
    date = `${y}-${String(mi+1).padStart(2,"0")}-${String(mon[2]).padStart(2,"0")}`;
  }
  return { city, date, bucket, thrLo, thrHi, unit };
}

function toC(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }

async function loadWeather(city, date) {
  const file = path.join(WX_DIR, `${city}__${date}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

// Pick the MAX tempC in the market's target-date 24h window (local-day proxy).
function highOnDate(wx, date) {
  if (!wx?.samples) return null;
  // samples are hourly timestamps in UTC seconds; filter to the market's
  // calendar date (UTC) — approximation, tz-correct would need wx.tz
  const t0 = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const t1 = t0 + 86400;
  const inDay = wx.samples.filter(s => s.t >= t0 && s.t < t1).map(s => s.tempC);
  if (!inDay.length) return null;
  return Math.max(...inDay);
}

async function main() {
  const trades = (await fs.readFile(JSONL, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const summary = JSON.parse(await fs.readFile(SUMMARY, "utf8"));
  const opens = summary.openPositions || [];
  const all = [...trades, ...opens].filter(e => e.title && e.openTs);

  // Per-entry annotation
  const annotated = [];
  let wxMissing = 0, titleParseFail = 0, highMissing = 0;
  for (const e of all) {
    const p = parseTitle(e.title);
    if (!p || p.thrLo == null || !p.date) { titleParseFail++; continue; }
    const wx = await loadWeather(p.city, p.date);
    if (!wx) { wxMissing++; continue; }
    const high = highOnDate(wx, p.date);
    if (high == null) { highMissing++; continue; }
    const bucketLoC = toC(p.thrLo, p.unit);
    const bucketHiC = toC(p.thrHi ?? p.thrLo, p.unit);
    // Relationship of bucket to actual high
    let bucketRel;       // "above", "below", "contains"
    let distanceC;       // signed distance of bucket center from actual high
    if (high < bucketLoC) { bucketRel = "below-high"; distanceC = bucketLoC - high; }
    else if (high > bucketHiC) { bucketRel = "above-high"; distanceC = high - bucketHiC; }
    else                 { bucketRel = "contains-high"; distanceC = 0; }
    annotated.push({
      city: p.city, date: p.date, bucketLoC, bucketHiC,
      side: e.side, entryAvg: e.entryAvg, pnl: e.pnlUsdc ?? null,
      high, bucketRel, distanceC,
      title: e.title,
    });
  }
  console.log(`Annotated ${annotated.length} of ${all.length} entries`);
  console.log(`  missing wx=${wxMissing} · title-parse-fail=${titleParseFail} · high-missing=${highMissing}\n`);

  // -------- Q1: where do 937 entries land relative to the actual high? --------
  console.log("=== Bucket-vs-high distribution ===");
  const byRel = { "below-high":0, "above-high":0, "contains-high":0 };
  for (const a of annotated) byRel[a.bucketRel]++;
  for (const k of Object.keys(byRel)) {
    console.log(`  ${k.padEnd(15)} ${String(byRel[k]).padStart(5)} (${(100*byRel[k]/annotated.length).toFixed(1)}%)`);
  }

  // -------- Q2: distance distribution (only bets on NO-side, excluding contains-high) --------
  console.log("\n=== Distance (°C) from actual high, by side ===");
  for (const side of ["NO", "YES"]) {
    const sub = annotated.filter(a => a.side === side && a.bucketRel !== "contains-high");
    if (!sub.length) continue;
    const dists = sub.map(a => a.distanceC).sort((x, y) => x - y);
    const p = (q) => dists[Math.floor(Math.min(dists.length - 1, q * dists.length / 100))];
    console.log(`  ${side}  n=${sub.length}  min=${p(0).toFixed(2)} p10=${p(10).toFixed(2)} p25=${p(25).toFixed(2)} p50=${p(50).toFixed(2)} p75=${p(75).toFixed(2)} p90=${p(90).toFixed(2)} max=${p(99).toFixed(2)}`);
    const edges = [0.5, 1, 1.5, 2, 3, 5, 8, 15];
    const counts = new Array(edges.length + 1).fill(0);
    for (const d of dists) {
      let i = edges.findIndex(e => d < e);
      if (i === -1) i = edges.length;
      counts[i]++;
    }
    console.log(`  bucket distance histogram:`);
    for (let i = 0; i < counts.length; i++) {
      const lo = i === 0 ? "-∞" : edges[i-1].toString();
      const hi = i === edges.length ? "+∞" : edges[i].toString();
      const pct = (100 * counts[i] / dists.length);
      const bar = "█".repeat(Math.round(pct / 2));
      console.log(`    ${lo.padStart(5)}–${hi.padEnd(5)} °C   ${String(counts[i]).padStart(5)}  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
    }
  }

  // -------- Q3: cross-tab side × bucketRel → did they bet the "right" direction? --------
  console.log("\n=== Side × bucket-vs-high ===");
  const xtab = {};
  for (const a of annotated) {
    const key = `${a.side}·${a.bucketRel}`;
    xtab[key] = (xtab[key] || 0) + 1;
  }
  for (const [k, v] of Object.entries(xtab).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }

  // -------- Q4: one-off case study — take the 5 (city, date) groups with most entries --------
  console.log("\n=== Case study: markets with most entries ===");
  const groups = new Map();
  for (const a of annotated) {
    const key = `${a.city}·${a.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const ranked = [...groups.entries()].sort((a,b) => b[1].length - a[1].length).slice(0, 5);
  for (const [key, g] of ranked) {
    const high = g[0].high;
    console.log(`\n  ${key}   actual high = ${high.toFixed(1)}°C   ${g.length} entries`);
    const sorted = [...g].sort((a,b) => a.bucketLoC - b.bucketLoC);
    for (const a of sorted) {
      const mark = a.bucketLoC <= high && high <= a.bucketHiC ? " ← contains high" : "";
      console.log(`    ${a.side.padEnd(3)} [${a.bucketLoC.toFixed(1)}-${a.bucketHiC.toFixed(1)}°C]  entry=${Number(a.entryAvg).toFixed(4)}  dist=${a.distanceC.toFixed(1)}°C  ${a.bucketRel}${mark}${a.pnl != null ? `  pnl=$${a.pnl.toFixed(2)}` : " [open]"}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
