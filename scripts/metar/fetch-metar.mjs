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

async function fetchStationDay(icao, date) {
  // IEM requires year1/month1/day1 and year2/month2/day2. Ask for the whole
  // UTC day; we'll filter later by city-local tz at feature time.
  const [y, m, d] = date.split("-").map(Number);
  const nd = new Date(Date.UTC(y, m - 1, d));
  nd.setUTCDate(nd.getUTCDate() + 1);
  const y2 = nd.getUTCFullYear(), m2 = nd.getUTCMonth() + 1, d2 = nd.getUTCDate();
  const q = new URLSearchParams({
    station: icao,
    data: "tmpc",
    year1: String(y), month1: String(m), day1: String(d),
    year2: String(y2), month2: String(m2), day2: String(d2),
    tz: "Etc/UTC",
    format: "onlycomma",
    latlon: "no",
    elev: "no",
    missing: "M",
    trace: "T",
    direct: "no",
    report_type: "3,4",      // 3=METAR, 4=SPECI
  });
  const url = `${IEM_ENDPOINT}?${q.toString()}`;
  const text = await fetchText(url);
  return parseCsv(text);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const mapJson = JSON.parse(await fs.readFile(CITY_MAP_PATH, "utf8"));
  const cityMap = mapJson.cities;

  // Build the fetch list from data/weather-history/<City>__<Date>.json file names
  const files = existsSync(WX_DIR) ? await fs.readdir(WX_DIR) : [];
  const pairs = [];
  for (const f of files) {
    const m = f.match(/^(.+?)__(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const [, city, date] = m;
    if (CITIES_FILTER && !CITIES_FILTER.has(city)) continue;
    if (SINCE && date < SINCE) continue;
    if (!cityMap[city]) continue;
    pairs.push({ city, date, icao: cityMap[city].icao, name: cityMap[city].name });
  }
  pairs.sort((a, b) => (a.icao + a.date).localeCompare(b.icao + b.date));
  console.log(`target set: ${pairs.length} (city, date) pairs across ${new Set(pairs.map(p=>p.icao)).size} stations`);

  let fetched = 0, skipped = 0, failed = 0;
  for (const p of pairs) {
    if (fetched + failed >= LIMIT) { console.log(`hit --limit=${LIMIT}, stopping`); break; }
    const out = path.join(OUT_DIR, `${p.icao}__${p.date}.json`);
    if (!FORCE && existsSync(out)) { skipped++; continue; }
    process.stdout.write(`  ${p.icao} ${p.date} (${p.city}, ${p.name}) ... `);
    try {
      const samples = await fetchStationDay(p.icao, p.date);
      const body = {
        city: p.city, icao: p.icao, station_name: p.name, date: p.date,
        tz: "UTC", source: "iem-asos", fetchedAt: new Date().toISOString(),
        nSamples: samples.length, samples,
      };
      await fs.writeFile(out, JSON.stringify(body));
      console.log(`${samples.length} samples`);
      fetched++;
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 200));  // be nice to IEM
  }
  console.log(`\ndone: fetched=${fetched} skipped=${skipped} failed=${failed}  out=${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
