#!/usr/bin/env node
/**
 * Fetch historical METAR temperature observations from Iowa State's IEM
 * ASOS service (free, no key, global airport coverage). For each (city, date)
 * in our target set, writes hourly tempC samples to:
 *
 *   data/metar-history/<ICAO>__<YYYY-MM-DD>.json
 *
 * Format matches data/weather-history/ so downstream feature extraction
 * can be redirected with minimal code changes:
 *   {
 *     city, icao, station_name, date, tz (fallback to UTC),
 *     source: "iem-asos",
 *     samples: [ { t: <utc_sec>, tempC: <num> }, ... ]
 *   }
 *
 * Usage:
 *   node scripts/metar/fetch-metar.mjs
 *     # fetches every (city, date) combo that appears in data/weather-history/
 *
 *   node scripts/metar/fetch-metar.mjs --cities=Madrid,Amsterdam
 *     # restrict to a subset
 *
 *   node scripts/metar/fetch-metar.mjs --since=2026-04-01
 *     # only dates >= this YYYY-MM-DD
 *
 *   node scripts/metar/fetch-metar.mjs --limit=20
 *     # safety cap on total (city, date) pairs fetched
 *
 * Caveats:
 *   - IEM only has data up to ~30 min real-time lag; this is fine for
 *     historical backtests but live bot should use aviationweather.gov
 *     instead.
 *   - We fetch UTC-normalized samples; the daily-max-in-local-tz calculation
 *     must still happen at feature-extraction time using city tz.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const CITY_MAP_PATH = path.resolve("scripts/metar/city-icao-map.json");
const WX_DIR = path.resolve("data/weather-history");
const OUT_DIR = path.resolve("data/metar-history");
const IEM_ENDPOINT = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";

const CITIES_FILTER = argv.cities ? new Set(argv.cities.split(",").map(s => s.trim())) : null;
const SINCE = argv.since ?? null;
const LIMIT = argv.limit ? Number(argv.limit) : Infinity;
const FORCE = argv.force === "true";

async function fetchText(url, attempt = 1) {
  try {
    const r = await fetch(url, { headers: { accept: "text/plain" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}`);
    return await r.text();
  } catch (e) {
    if (attempt < 4) {
      const wait = Math.pow(2, attempt) * 1000;
      console.log(`   retry ${attempt} in ${wait}ms (${e.message})`);
      await new Promise(r => setTimeout(r, wait));
      return fetchText(url, attempt + 1);
    }
    throw e;
  }
}

// Parse an IEM ASOS CSV response with columns station,valid,tmpf,tmpc
// (we ask for tmpc so TMPC is in Celsius directly).
function parseCsv(text) {
  const lines = text.trim().split("\n").filter(l => l && !l.startsWith("#"));
  if (!lines.length) return [];
  const header = lines.shift().split(",").map(s => s.trim().toLowerCase());
  const idxTs = header.indexOf("valid");
  const idxT = header.indexOf("tmpc");
  if (idxTs < 0 || idxT < 0) return [];
  const samples = [];
  for (const row of lines) {
    const cols = row.split(",");
    const tsStr = cols[idxTs];
    const tc = cols[idxT];
    if (!tsStr || tc === "M" || tc === "" || tc == null) continue;
    const tempC = Number(tc);
    if (!Number.isFinite(tempC)) continue;
    const utcSec = Math.floor(new Date(tsStr + "Z").getTime() / 1000);
    if (!Number.isFinite(utcSec)) continue;
    samples.push({ t: utcSec, tempC });
  }
  samples.sort((a, b) => a.t - b.t);
  return samples;
}

// Fetch the entire date range for one station in a single request — IEM
// supports date spans so we drop ~800 per-day calls to ~50 per-station calls.
async function fetchStationRange(icao, startDate, endDateInclusive) {
  const [y1, m1, d1] = startDate.split("-").map(Number);
  // +1 day because IEM's end is exclusive.
  const end = new Date(Date.UTC(...endDateInclusive.split("-").map((v, i) => i === 1 ? Number(v) - 1 : Number(v))));
  end.setUTCDate(end.getUTCDate() + 1);
  const y2 = end.getUTCFullYear(), m2 = end.getUTCMonth() + 1, d2 = end.getUTCDate();
  const q = new URLSearchParams({
    station: icao,
    data: "tmpc",
    year1: String(y1), month1: String(m1), day1: String(d1),
    year2: String(y2), month2: String(m2), day2: String(d2),
    tz: "Etc/UTC",
    format: "onlycomma",
    latlon: "no",
    elev: "no",
    missing: "M",
    trace: "T",
    direct: "no",
    report_type: "3,4",
  });
  const url = `${IEM_ENDPOINT}?${q.toString()}`;
  const text = await fetchText(url);
  return parseCsv(text);
}

function utcSecToISODate(t) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const mapJson = JSON.parse(await fs.readFile(CITY_MAP_PATH, "utf8"));
  const cityMap = mapJson.cities;

  // Build the fetch list from data/weather-history/<City>__<Date>.json file names.
  const files = existsSync(WX_DIR) ? await fs.readdir(WX_DIR) : [];
  const byStation = new Map();  // icao -> { city, name, dates:Set }
  let pairCount = 0;
  for (const f of files) {
    const m = f.match(/^(.+?)__(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const [, city, date] = m;
    if (CITIES_FILTER && !CITIES_FILTER.has(city)) continue;
    if (SINCE && date < SINCE) continue;
    if (!cityMap[city]) continue;
    const icao = cityMap[city].icao;
    if (!byStation.has(icao)) byStation.set(icao, { city, name: cityMap[city].name, dates: new Set() });
    byStation.get(icao).dates.add(date);
    pairCount++;
  }
  console.log(`target set: ${pairCount} (city, date) pairs across ${byStation.size} stations`);

  let fetched = 0, skipped = 0, failed = 0;
  let stationsDone = 0;
  const stationEntries = [...byStation.entries()];
  for (const [icao, info] of stationEntries) {
    if (fetched + failed >= LIMIT) { console.log(`hit --limit=${LIMIT}, stopping`); break; }
    const dates = [...info.dates].sort();
    if (!dates.length) continue;
    // If every target file already exists, skip the station entirely.
    const allExist = !FORCE && dates.every(d => existsSync(path.join(OUT_DIR, `${icao}__${d}.json`)));
    if (allExist) { skipped += dates.length; stationsDone++; continue; }
    const firstDate = dates[0], lastDate = dates[dates.length - 1];
    process.stdout.write(`  [${stationsDone+1}/${byStation.size}] ${icao} (${info.city}, ${info.name})  ${firstDate} → ${lastDate}  (${dates.length} dates) ... `);
    try {
      const samples = await fetchStationRange(icao, firstDate, lastDate);
      // Bucket samples by UTC calendar date.
      const perDay = new Map();
      for (const s of samples) {
        const d = utcSecToISODate(s.t);
        if (!info.dates.has(d)) continue;        // only write dates we care about
        if (!perDay.has(d)) perDay.set(d, []);
        perDay.get(d).push(s);
      }
      let written = 0;
      for (const d of dates) {
        const out = path.join(OUT_DIR, `${icao}__${d}.json`);
        if (!FORCE && existsSync(out)) { skipped++; continue; }
        const daySamples = perDay.get(d) || [];
        const body = {
          city: info.city, icao, station_name: info.name, date: d,
          tz: "UTC", source: "iem-asos", fetchedAt: new Date().toISOString(),
          nSamples: daySamples.length, samples: daySamples,
        };
        await fs.writeFile(out, JSON.stringify(body));
        if (daySamples.length) fetched++; else failed++;   // zero-sample days count as fail
        written++;
      }
      console.log(`wrote ${written} files (${samples.length} total samples)`);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
      failed += dates.length;
    }
    stationsDone++;
    await new Promise(r => setTimeout(r, 2000));  // 2s between stations — IEM is sensitive
  }
  console.log(`\ndone: fetched=${fetched} skipped=${skipped} failed=${failed}  out=${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
