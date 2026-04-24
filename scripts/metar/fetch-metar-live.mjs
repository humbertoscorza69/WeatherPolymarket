#!/usr/bin/env node
/**
 * Fetch current METAR observations for every station in city-icao-map.json
 * from aviationweather.gov (free, no key, real-time within ~30 min).
 *
 * Writes per-station cache files with the last 24h of TMPC readings:
 *
 *   data/metar-live/<ICAO>.json
 *   {
 *     icao, city, fetched_at, station_name,
 *     samples: [ { t: <utc_sec>, tempC: <num>, raw: <raw_metar_string> }, ... ]
 *   }
 *
 * Designed to be run by detect.mjs (or a cron) every 15 minutes. The
 * detect process reads the cache file synchronously and computes
 * observed-max up to a given cutoff timestamp (strict no-lookahead at
 * feature time).
 *
 * Usage:
 *   node scripts/metar/fetch-metar-live.mjs
 *     # fetch all stations in city-icao-map
 *
 *   node scripts/metar/fetch-metar-live.mjs --cities=Madrid,Amsterdam
 *     # restrict to a subset
 *
 *   node scripts/metar/fetch-metar-live.mjs --hours=6
 *     # how many hours of history to pull (default 24)
 *
 *   node scripts/metar/fetch-metar-live.mjs --max-age=900
 *     # skip cache files younger than 900 seconds (default: always refresh)
 */
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const CITY_MAP_PATH = path.resolve("scripts/metar/city-icao-map.json");
const OUT_DIR = path.resolve("data/metar-live");
const API_BASE = "https://aviationweather.gov/api/data/metar";

const CITIES_FILTER = argv.cities ? new Set(argv.cities.split(",").map(s => s.trim())) : null;
const HOURS = Number(argv.hours ?? "24");
const MAX_AGE_SEC = Number(argv["max-age"] ?? "0");          // skip file if fresher than this
const VERBOSE = argv.verbose === "true";
// Batch size — aviationweather supports comma-joined IDs; 50 per call is safe.
const BATCH = Number(argv.batch ?? "50");

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 90)}`);
  return r.json();
}

// Parse a raw METAR string to extract tempC when the JSON `temp` field is missing.
// METAR format: "... 12/08 ..." means temp 12°C, dewpoint 8°C.
// Negative form: "M05/M09" for -5°C/-9°C.
function parseTempCFromRaw(raw) {
  if (!raw) return null;
  const m = raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  if (!m) return null;
  let t = m[1];
  const neg = t.startsWith("M");
  if (neg) t = t.slice(1);
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

async function fetchBatch(icaos) {
  const url = `${API_BASE}?ids=${icaos.join(",")}&format=json&taf=false&hours=${HOURS}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) return [];
  return data;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const mapJson = JSON.parse(await fs.readFile(CITY_MAP_PATH, "utf8"));
  const cityMap = mapJson.cities;

  // Build station -> {city, name} lookup, filtered by --cities.
  const stations = [];
  for (const [city, info] of Object.entries(cityMap)) {
    if (CITIES_FILTER && !CITIES_FILTER.has(city)) continue;
    stations.push({ icao: info.icao, city, name: info.name });
  }
  console.log(`target: ${stations.length} stations · hours=${HOURS}`);

  // Filter out fresh cached files if --max-age specified.
  const nowSec = Math.floor(Date.now() / 1000);
  const toFetch = stations.filter(s => {
    if (MAX_AGE_SEC <= 0) return true;
    const f = path.join(OUT_DIR, `${s.icao}.json`);
    if (!existsSync(f)) return true;
    const ageSec = nowSec - Math.floor(statSync(f).mtimeMs / 1000);
    return ageSec > MAX_AGE_SEC;
  });
  if (toFetch.length < stations.length) {
    console.log(`skipping ${stations.length - toFetch.length} stations with cache < ${MAX_AGE_SEC}s old`);
  }

  let written = 0, failed = 0, emptyStations = [];
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const chunk = toFetch.slice(i, i + BATCH);
    const icaos = chunk.map(s => s.icao);
    let observations;
    try {
      observations = await fetchBatch(icaos);
    } catch (e) {
      console.log(`  batch ${i}..${i+BATCH} FAIL: ${e.message}`);
      failed += chunk.length;
      continue;
    }
    // Group observations by station.
    const byStation = new Map();
    for (const ob of observations) {
      const id = ob.icaoId || ob.station;
      if (!id) continue;
      if (!byStation.has(id)) byStation.set(id, []);
      byStation.get(id).push(ob);
    }
    for (const s of chunk) {
      const obs = byStation.get(s.icao) || [];
      if (!obs.length) { emptyStations.push(s.icao); continue; }
      const samples = [];
      for (const ob of obs) {
        const tsStr = ob.reportTime || ob.obsTime || ob.prior || null;
        if (!tsStr) continue;
        // reportTime/obsTime are ISO-8601-like, UTC.
        const utcSec = Math.floor(new Date(tsStr + (tsStr.endsWith("Z") ? "" : "Z")).getTime() / 1000);
        if (!Number.isFinite(utcSec)) continue;
        let tempC = (ob.temp != null && Number.isFinite(ob.temp)) ? ob.temp : parseTempCFromRaw(ob.rawOb || ob.rawText || "");
        if (tempC == null || !Number.isFinite(tempC)) continue;
        samples.push({ t: utcSec, tempC, raw: ob.rawOb || ob.rawText || "" });
      }
      samples.sort((a, b) => a.t - b.t);
      const body = {
        icao: s.icao, city: s.city, station_name: s.name,
        source: "aviationweather.gov",
        fetched_at: new Date().toISOString(),
        n_samples: samples.length,
        samples,
      };
      await fs.writeFile(path.join(OUT_DIR, `${s.icao}.json`), JSON.stringify(body));
      written++;
      if (VERBOSE) console.log(`  ${s.icao.padEnd(5)} ${s.city.padEnd(16)} ${samples.length} samples`);
    }
    // Brief pause between batches to be nice.
    if (i + BATCH < toFetch.length) await new Promise(r => setTimeout(r, 500));
  }
  console.log(`done: written=${written} failed=${failed} empty=${emptyStations.length}  out=${OUT_DIR}`);
  if (emptyStations.length) console.log(`  empty (no obs or bad ICAO): ${emptyStations.join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
