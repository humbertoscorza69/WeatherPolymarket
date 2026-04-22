#!/usr/bin/env node
/**
 * Build a resolution index for ALL weather markets we have tick data for,
 * by combining title parsing + actual max temperatures from Open-Meteo.
 *
 * Output: data/resolution-index.json
 *   { conditionId: { resolved: 0|1, maxTempC, threshold, type, city, date, source } }
 *
 *   resolved: 1 if NO won (high temp didn't match the question), 0 if YES won.
 *
 * This avoids needing the slow Polymarket cache fetch for every market —
 * we already have the ground truth from weather observations.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("data/resolution-index.json");
const TICK_DIR = path.resolve("data/tick-history");
const WEATHER_DIR = path.resolve("data/weather-history");
const TITLES = JSON.parse(await fs.readFile(path.resolve("data/market-titles.json"), "utf8"));

function parseTitle(t) {
  if (!t) return null;
  let m = t.match(/temperature in ([A-Z][\w .\-']+?) be/i);
  if (!m) m = t.match(/temperature in ([A-Z][\w .\-']+?) on/i);
  if (!m) return null;
  const city = m[1].trim();
  const unit = /°F/i.test(t) ? "F" : "C";
  const r = t.match(/be\s+(?:between\s+)?(\d+)(?:\s*-\s*(\d+))?\s*°?/i);
  const thr_lo = r ? Number(r[1]) : null;
  const thr_hi = r && r[2] ? Number(r[2]) : null;
  let typ = "exact";
  if (/or higher/i.test(t)) typ = "at_or_above";
  else if (/or below/i.test(t)) typ = "at_or_below";
  else if (/between/i.test(t)) typ = "between";
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
  return { city, date, unit, threshold: thr_lo, thr_hi, type: typ };
}

function toC(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }

function resolve(p, maxTempC) {
  if (!p || p.threshold == null) return null;
  const thrC = toC(p.threshold, p.unit);
  const thrHiC = toC(p.thr_hi || p.threshold, p.unit);
  if (p.type === "exact") {
    // Polymarket rounds to int. NO wins if rounded high doesn't match threshold.
    return Math.round(maxTempC * (p.unit === "F" ? 9/5 : 1) + (p.unit === "F" ? 32 : 0)) === p.threshold ? 0 : 1;
  } else if (p.type === "at_or_above") {
    return maxTempC >= thrC - 0.001 ? 0 : 1;
  } else if (p.type === "at_or_below") {
    return maxTempC <= thrC + 0.001 ? 0 : 1;
  } else if (p.type === "between") {
    return (thrC - 0.5 <= maxTempC && maxTempC <= thrHiC + 0.5) ? 0 : 1;
  }
  return null;
}

// Build weather max-temp index
const wxFiles = (await fs.readdir(WEATHER_DIR)).filter(f => f.endsWith(".json") && !f.startsWith("_"));
const wxIndex = new Map();
for (const f of wxFiles) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(WEATHER_DIR, f), "utf8"));
    if (!j.samples?.length || !j.date) continue;
    const dayStart = new Date(j.date + "T00:00:00Z").getTime() / 1000 - 14*3600;
    const dayEnd = dayStart + 28*3600 + 24*3600;
    const sameDay = j.samples.filter(s => s.t >= dayStart && s.t <= dayEnd && s.tempC != null);
    if (sameDay.length === 0) continue;
    wxIndex.set(`${j.city}__${j.date}`, Math.max(...sameDay.map(s => s.tempC)));
  } catch {}
}
console.log(`Weather max-temps: ${wxIndex.size} (city, date) pairs`);

// Load Polymarket resolution outcomes (GROUND TRUTH when available)
const CACHE_DIR = path.resolve("data/resolved-market-cache");
const pmResolution = new Map();  // cid -> 1 if NO-paid-$1, 0 if YES-paid-$1
for (const f of (await fs.readdir(CACHE_DIR))) {
  if (!f.endsWith("-NO.json")) continue;
  const cid = f.replace("-NO.json", "");
  try {
    const j = JSON.parse(await fs.readFile(path.join(CACHE_DIR, f), "utf8"));
    const v = j.tokenResolutionValue;
    if (v === 1 || v === "1") pmResolution.set(cid, 1);
    else if (v === 0 || v === "0") pmResolution.set(cid, 0);
    // null/None = not yet resolved, skip
  } catch {}
}
console.log(`Polymarket cache resolutions: ${pmResolution.size} markets (ground truth)`);

// Walk tick markets
const tickFiles = (await fs.readdir(TICK_DIR)).filter(f => f.endsWith(".jsonl"));
const out = {};
const stats = { total: tickFiles.length, no_title: 0, bad_parse: 0, no_weather: 0, no_won: 0, yes_won: 0, unresolvable: 0, pm_source: 0, weather_source: 0, disagreements: 0 };
for (const f of tickFiles) {
  const cid = f.replace(".jsonl", "");
  const title = TITLES[cid];
  if (!title || !/temperature/i.test(title)) { stats.no_title++; continue; }
  const p = parseTitle(title);
  if (!p || !p.date) { stats.bad_parse++; continue; }
  const wxKey = `${p.city}__${p.date}`;
  const maxTempC = wxIndex.get(wxKey);
  // Prefer Polymarket's actual resolution over weather-derived
  let r = null;
  let source = null;
  if (pmResolution.has(cid)) {
    r = pmResolution.get(cid);
    source = "polymarket";
    stats.pm_source++;
    // Sanity: also compute weather-derived and flag disagreements
    if (maxTempC != null) {
      const wr = resolve(p, maxTempC);
      if (wr !== null && wr !== r) stats.disagreements++;
    }
  } else if (maxTempC != null) {
    r = resolve(p, maxTempC);
    source = "weather-derived";
    stats.weather_source++;
  }
  if (r == null) {
    if (maxTempC == null) stats.no_weather++;
    else stats.unresolvable++;
    continue;
  }
  if (r === 1) stats.no_won++; else stats.yes_won++;
  out[cid] = {
    resolved: r,
    maxTempC: maxTempC != null ? Math.round(maxTempC * 10) / 10 : null,
    threshold: p.threshold,
    thr_hi: p.thr_hi,
    type: p.type,
    unit: p.unit,
    city: p.city,
    date: p.date,
    source,
  };
}
await fs.writeFile(OUT, JSON.stringify(out));
console.log(`Resolved: ${stats.no_won + stats.yes_won}  (NO=${stats.no_won}, YES=${stats.yes_won})`);
console.log(`Skipped: title=${stats.no_title} parse=${stats.bad_parse} weather=${stats.no_weather} unres=${stats.unresolvable}`);
console.log(`Saved: ${OUT}  (${Object.keys(out).length} entries)`);

// Monthly breakdown
const byMonth = {};
for (const [cid, r] of Object.entries(out)) {
  const mo = r.date.slice(0, 7);
  if (!byMonth[mo]) byMonth[mo] = { no: 0, yes: 0 };
  if (r.resolved === 1) byMonth[mo].no++;
  else byMonth[mo].yes++;
}
console.log(`\nResolution coverage by month:`);
for (const mo of Object.keys(byMonth).sort()) {
  const b = byMonth[mo];
  console.log(`  ${mo}: NO=${b.no}  YES=${b.yes}  total=${b.no+b.yes}  NO-rate=${Math.round(100*b.no/(b.no+b.yes))}%`);
}
