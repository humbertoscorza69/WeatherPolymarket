#!/usr/bin/env node
/**
 * Fetch METAR (Meteorological Aerodrome Report) observations from
 * Aviation Weather Center — the same data source Polymarket uses to
 * resolve weather markets.
 *
 * Unlike Open-Meteo (reanalysis/modeled data), METAR is ACTUAL airport
 * station observations.  Polymarket specifies the resolving station in
 * each market's rules (usually the nearest major airport).
 *
 * API: https://aviationweather.gov/api/data/metar
 * Docs: https://aviationweather.gov/data/api/
 *
 * Output: data/metar-observations/<ICAO>__<YYYY-MM-DD>.json
 *   {
 *     station: "KJFK",
 *     city: "New York City",
 *     date: "2026-04-20",
 *     observations: [{t, tempC, dewpointC, windKt}],
 *     computedMax: 23.5,
 *     computedMin: 12.1,
 *   }
 *
 * Per-city station mapping: see data/metar-stations.json — map city names
 * used in Polymarket markets to the ICAO station Polymarket uses. This
 * mapping must be curated — Polymarket's rules on each market state the
 * station; we hard-code the common ones.
 *
 * Usage:
 *   node scripts/fetch-metar-observations.mjs --days=30
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));
const DAYS = Number(argv.days ?? "30");
const REFRESH = argv.refresh === "true";

const OUT_DIR = path.resolve("data/metar-observations");
await fs.mkdir(OUT_DIR, { recursive: true });

// Polymarket's resolving stations for common weather-market cities.
// Source: each Polymarket market's rules page states the ICAO code.
// Extend as needed; unknown cities just won't get METAR data fetched.
const STATION_MAP = {
  "New York City": "KJFK",   // JFK
  "Los Angeles":   "KLAX",
  "Chicago":       "KORD",
  "Miami":         "KMIA",
  "Dallas":        "KDFW",
  "Houston":       "KIAH",
  "Atlanta":       "KATL",
  "Seattle":       "KSEA",
  "Denver":        "KDEN",
  "San Francisco": "KSFO",
  "Austin":        "KAUS",
  "Boston":        "KBOS",
  "Toronto":       "CYYZ",
  "London":        "EGLL",   // Heathrow
  "Paris":         "LFPG",   // CDG
  "Amsterdam":     "EHAM",
  "Madrid":        "LEMD",
  "Berlin":        "EDDB",
  "Munich":        "EDDM",
  "Milan":         "LIMC",   // Malpensa
  "Frankfurt":     "EDDF",
  "Helsinki":      "EFHK",
  "Warsaw":        "EPWA",
  "Moscow":        "UUEE",   // Sheremetyevo
  "Istanbul":      "LTFM",
  "Ankara":        "LTAC",
  "Tel Aviv":      "LLBG",
  "Jeddah":        "OEJN",
  "Dubai":         "OMDB",
  "Karachi":       "OPKC",
  "Lucknow":       "VILK",
  "Beijing":       "ZBAA",
  "Shanghai":      "ZSPD",   // Pudong
  "Shenzhen":      "ZGSZ",
  "Guangzhou":     "ZGGG",
  "Chengdu":       "ZUUU",
  "Chongqing":     "ZUCK",
  "Wuhan":         "ZHHH",
  "Hong Kong":     "VHHH",
  "Taipei":        "RCTP",
  "Seoul":         "RKSI",   // Incheon
  "Tokyo":         "RJTT",   // Haneda
  "Busan":         "RKPK",
  "Singapore":     "WSSS",
  "Kuala Lumpur":  "WMKK",
  "Jakarta":       "WIII",
  "Manila":        "RPLL",
  "Bangkok":       "VTBS",
  "Mumbai":        "VABB",
  "Delhi":         "VIDP",
  "Lagos":         "DNMM",
  "Cape Town":     "FACT",
  "Sao Paulo":     "SBGR",   // Guarulhos
  "Buenos Aires":  "SAEZ",
  "Mexico City":   "MMMX",
  "Panama City":   "MPTO",
  "Wellington":    "NZWN",
  "Sydney":        "YSSY",
};

const stationsOut = path.resolve("data/metar-stations.json");
await fs.writeFile(stationsOut, JSON.stringify(STATION_MAP, null, 2));
console.log(`Wrote station mapping: ${stationsOut}`);

async function fetchJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) {
        if (i === retries) throw new Error(`HTTP ${r.status}: ${await r.text().catch(()=>"")}`.slice(0, 120));
        await new Promise(x => setTimeout(x, 1000 * (i + 1)));
        continue;
      }
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(x => setTimeout(x, 1000 * (i + 1)));
    }
  }
}

// aviationweather.gov METAR API:
// https://aviationweather.gov/api/data/metar?ids=KJFK&format=json&startTime=2026-04-20T00:00:00Z&endTime=2026-04-20T23:59:59Z&hours=168
async function fetchMetarForDay(icao, date) {
  // API accepts startTime, endTime, OR hours (count from now)
  const url = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&date=${date.replace(/-/g,"")}&hoursBeforeNow=48`;
  try {
    const data = await fetchJson(url);
    if (!Array.isArray(data)) return { observations: [], error: "non-array response" };
    const obs = data.map(m => ({
      t: m.obsTime,  // unix seconds
      tempC: m.temp,
      dewpointC: m.dewp,
      windKt: m.wspd,
      rawOb: m.rawOb,
    })).filter(o => o.t && o.tempC != null).sort((a,b) => a.t - b.t);
    return { observations: obs };
  } catch (e) {
    return { observations: [], error: e.message };
  }
}

// For each (city, date) we have a weather-history file for, try to fetch METAR
const WEATHER_DIR = path.resolve("data/weather-history");
const weatherFiles = await fs.readdir(WEATHER_DIR);
const needed = new Set();
for (const f of weatherFiles) {
  if (!f.endsWith(".json") || f.startsWith("_")) continue;
  const parts = f.replace(".json","").split("__");
  if (parts.length !== 2) continue;
  const [city, date] = parts;
  const icao = STATION_MAP[city];
  if (!icao) continue;  // no station mapping — skip
  needed.add(`${icao}__${date}`);
}
console.log(`Need METAR for ${needed.size} (station, date) pairs`);

let ok = 0, skipped = 0, failed = 0;
let i = 0;
for (const key of needed) {
  i++;
  const [icao, date] = key.split("__");
  const outFile = path.join(OUT_DIR, `${key}.json`);
  if (!REFRESH && existsSync(outFile)) { skipped++; continue; }
  process.stdout.write(`[${i}/${needed.size}] ${icao} ${date} `);
  const { observations, error } = await fetchMetarForDay(icao, date);
  if (error) { console.log(`ERR ${error.slice(0,40)}`); failed++; continue; }
  if (observations.length === 0) { console.log(`no obs`); failed++; continue; }
  const temps = observations.map(o => o.tempC).filter(t => Number.isFinite(t));
  const payload = {
    station: icao,
    date,
    observations,
    computedMax: temps.length ? Math.max(...temps) : null,
    computedMin: temps.length ? Math.min(...temps) : null,
    fetchedAt: Date.now(),
  };
  await fs.writeFile(outFile, JSON.stringify(payload));
  console.log(`${observations.length} obs, max=${payload.computedMax}°C`);
  ok++;
  await new Promise(r => setTimeout(r, 150));  // rate limit
}
console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
