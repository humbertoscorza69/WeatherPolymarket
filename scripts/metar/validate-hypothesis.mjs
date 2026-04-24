#!/usr/bin/env node
/**
 * Validate: does METAR daily-max match Polymarket's resolution better
 * than Open-Meteo gridded data?
 *
 * Method:
 *   1. Find each of 900e's closed trades where the market cleanly
 *      resolved (last tick near 0.001 or 0.999 for one side).
 *   2. Infer the winning bucket: for each (city, date) group, the bucket
 *      whose YES token's last tick was near 1.0 is the winner.
 *   3. Compare:
 *        - Open-Meteo daily max vs Polymarket's winning bucket
 *        - METAR daily max vs Polymarket's winning bucket
 *      The source that consistently lands in the winning bucket is the
 *      one Polymarket actually uses.
 *
 * Output:
 *   data/analysis/metar-vs-open-meteo.csv
 *   data/analysis/metar-vs-open-meteo-report.txt
 *
 * Usage:
 *   node scripts/metar/validate-hypothesis.mjs
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const UNIVERSE = path.resolve("data/analysis/universe-markets.jsonl");
const WX_DIR = path.resolve("data/weather-history");
const METAR_DIR = path.resolve("data/metar-history");
const TICK_DIR = path.resolve("data/tick-history");
const CITY_MAP_PATH = path.resolve("scripts/metar/city-icao-map.json");
const OUT = path.resolve("data/analysis/metar-vs-open-meteo.csv");
const REPORT = path.resolve("data/analysis/metar-vs-open-meteo-report.txt");

// Polymarket weather markets round the observed max to the nearest integer.
// "Will the highest temperature be 28°C?" resolves YES iff round(final_max) == 28.
// Round-half-up is standard.
function roundTempC(x) {
  return Math.floor(x + 0.5);
}

function finalMax(samples) {
  let m = -Infinity;
  for (const s of samples) if (s.tempC > m) m = s.tempC;
  return Number.isFinite(m) ? m : null;
}

async function loadLastTickPrices(conditionId) {
  const file = path.join(TICK_DIR, `${conditionId}.jsonl`);
  if (!existsSync(file)) return null;
  try {
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    let lastYes = null, lastNo = null, lastTs = 0;
    for (const l of lines) {
      try {
        const t = JSON.parse(l);
        if (t.outcomeIndex === 0) lastYes = t;
        if (t.outcomeIndex === 1) lastNo = t;
        if (t.timestamp > lastTs) lastTs = t.timestamp;
      } catch {}
    }
    return { lastYes, lastNo, lastTs };
  } catch { return null; }
}

async function main() {
  const universe = (await fs.readFile(UNIVERSE, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const cityMap = JSON.parse(await fs.readFile(CITY_MAP_PATH, "utf8")).cities;

  // Group markets by (city, date)
  const byGroup = new Map();
  for (const m of universe) {
    const k = `${m.city}|${m.date}`;
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(m);
  }

  const rows = [];
  let checked = 0, noOM = 0, noMETAR = 0, noCityMap = 0, unresolved = 0;
  for (const [gkey, markets] of byGroup) {
    const [city, date] = gkey.split("|");
    if (!cityMap[city]) { noCityMap++; continue; }
    const icao = cityMap[city].icao;
    const wxPath = path.join(WX_DIR, `${city}__${date}.json`);
    const metarPath = path.join(METAR_DIR, `${icao}__${date}.json`);
    if (!existsSync(wxPath)) { noOM++; continue; }
    if (!existsSync(metarPath)) { noMETAR++; continue; }
    const wx = JSON.parse(await fs.readFile(wxPath, "utf8"));
    const metar = JSON.parse(await fs.readFile(metarPath, "utf8"));
    const omMax = finalMax(wx.samples);
    const metarMax = finalMax(metar.samples);
    if (omMax == null || metarMax == null) continue;

    // Find the winning bucket: scan all markets in the group, pick the one
    // whose YES-side last tick >= 0.995 (or NO-side last tick <= 0.005).
    let winnerBucket = null, winnerConditionId = null;
    for (const m of markets) {
      const prices = await loadLastTickPrices(m.conditionId);
      if (!prices) continue;
      // Use only last-day's ticks (market resolution should produce clear terminal prices).
      const yesResolved = prices.lastYes && prices.lastYes.price >= 0.995;
      const noResolved  = prices.lastNo  && prices.lastNo.price  <= 0.005;
      if (yesResolved || noResolved) {
        winnerBucket = m;
        winnerConditionId = m.conditionId;
        break;
      }
    }
    if (!winnerBucket) { unresolved++; continue; }

    // Compute bucket for METAR and OM daily-max
    const omRounded = roundTempC(omMax);
    const metarRounded = roundTempC(metarMax);

    const winLo = winnerBucket.bucketLoC == null ? -Infinity : winnerBucket.bucketLoC;
    const winHi = winnerBucket.bucketHiC == null ? Infinity  : winnerBucket.bucketHiC;

    const omAgrees = (winnerBucket.kind === "exact" && omRounded === winnerBucket.bucketLo) ||
                     (winnerBucket.kind === "or_below" && omMax <= winHi) ||
                     (winnerBucket.kind === "range" && omMax >= winLo && omMax <= winHi);
    const metarAgrees = (winnerBucket.kind === "exact" && metarRounded === winnerBucket.bucketLo) ||
                        (winnerBucket.kind === "or_below" && metarMax <= winHi) ||
                        (winnerBucket.kind === "range" && metarMax >= winLo && metarMax <= winHi);

    rows.push({
      city, date, icao, kind: winnerBucket.kind,
      winBucket: winnerBucket.kind === "exact" ? String(winnerBucket.bucketLo) :
                 (winnerBucket.kind === "or_below" ? `≤${winnerBucket.bucketHi}` :
                  winnerBucket.kind === "or_above" ? `≥${winnerBucket.bucketLo}` :
                  `${winnerBucket.bucketLo}-${winnerBucket.bucketHi}`),
      omMax: Number(omMax.toFixed(2)),
      metarMax: Number(metarMax.toFixed(2)),
      omRounded, metarRounded,
      omAgrees, metarAgrees,
      delta: Number((omMax - metarMax).toFixed(2)),
    });
    checked++;
  }

  // Write CSV
  const cols = ["city","date","icao","kind","winBucket","omMax","metarMax","omRounded","metarRounded","omAgrees","metarAgrees","delta"];
  const esc = v => v == null ? "" : (typeof v === "number" || typeof v === "boolean" ? String(v) : (/[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v)));
  const out = [cols.join(",")];
  for (const r of rows) out.push(cols.map(c => esc(r[c])).join(","));
  await fs.writeFile(OUT, out.join("\n") + "\n");

  // Summary
  const nOMAgree = rows.filter(r => r.omAgrees).length;
  const nMETARAgree = rows.filter(r => r.metarAgrees).length;
  const nBoth = rows.filter(r => r.omAgrees && r.metarAgrees).length;
  const nNeither = rows.filter(r => !r.omAgrees && !r.metarAgrees).length;
  const nOnlyOM = rows.filter(r => r.omAgrees && !r.metarAgrees).length;
  const nOnlyMETAR = rows.filter(r => !r.omAgrees && r.metarAgrees).length;

  const deltas = rows.map(r => r.delta).sort((a,b)=>a-b);
  const q = p => deltas.length ? deltas[Math.floor(p * deltas.length)] : 0;

  const lines = [];
  lines.push(`=== METAR vs Open-Meteo agreement report ===`);
  lines.push(`resolved city-date groups compared: ${rows.length}`);
  lines.push(`  no-city-map: ${noCityMap}   no-open-meteo: ${noOM}   no-metar: ${noMETAR}   unresolved-market: ${unresolved}`);
  lines.push(``);
  lines.push(`OM agrees with market:    ${nOMAgree}  (${(100*nOMAgree/rows.length).toFixed(1)}%)`);
  lines.push(`METAR agrees with market: ${nMETARAgree}  (${(100*nMETARAgree/rows.length).toFixed(1)}%)`);
  lines.push(`Both agree:               ${nBoth}`);
  lines.push(`Only OM agrees:           ${nOnlyOM}`);
  lines.push(`Only METAR agrees:        ${nOnlyMETAR}  ← these are the ones the METAR pivot would rescue`);
  lines.push(`Neither agrees:           ${nNeither}  ← data source unknown`);
  lines.push(``);
  lines.push(`OM - METAR daily-max delta (°C):`);
  if (deltas.length) {
    lines.push(`  min=${deltas[0].toFixed(2)}  p10=${q(.1).toFixed(2)}  p25=${q(.25).toFixed(2)}  p50=${q(.5).toFixed(2)}  p75=${q(.75).toFixed(2)}  p90=${q(.9).toFixed(2)}  max=${deltas[deltas.length-1].toFixed(2)}`);
  }
  lines.push(``);
  lines.push(`=== METAR-rescue candidates (first 20) — Only METAR agrees ===`);
  const rescues = rows.filter(r => r.metarAgrees && !r.omAgrees).slice(0, 20);
  for (const r of rescues) {
    lines.push(`  ${r.city.padEnd(16)} ${r.date}  bucket=${r.winBucket.padEnd(5)}  OM=${r.omMax.toFixed(1)}(rounds ${r.omRounded}) · METAR=${r.metarMax.toFixed(1)}(rounds ${r.metarRounded})  delta=${r.delta.toFixed(2)}°C`);
  }
  lines.push(``);
  lines.push(`=== Cases where neither agrees (first 10) — could indicate wrong ICAO mapping ===`);
  const neither = rows.filter(r => !r.omAgrees && !r.metarAgrees).slice(0, 10);
  for (const r of neither) {
    lines.push(`  ${r.city.padEnd(16)} ${r.date}  bucket=${r.winBucket.padEnd(5)}  OM=${r.omMax.toFixed(1)}(rounds ${r.omRounded}) · METAR=${r.metarMax.toFixed(1)}(rounds ${r.metarRounded})`);
  }
  lines.push(``);
  lines.push(`output CSV: ${OUT}`);

  const txt = lines.join("\n");
  console.log(txt);
  await fs.writeFile(REPORT, txt + "\n");
}

main().catch(e => { console.error(e); process.exit(1); });
