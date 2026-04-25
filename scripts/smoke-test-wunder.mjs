#!/usr/bin/env node
/**
 * Smoke-test that the v33-wunder integration can actually reach Wunderground
 * and pulls real observations. Hits 3 cities for today and prints the count
 * + max C — exactly what computeObservedMaxC() will see at scan time.
 *
 * Usage:
 *   node scripts/smoke-test-wunder.mjs
 *   node scripts/smoke-test-wunder.mjs --date=2026-04-25
 *   node scripts/smoke-test-wunder.mjs --cities=Seoul,Madrid,Jeddah,Atlanta
 */
import fs from "node:fs/promises";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

function todayUtcDate() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

const date = argv.date && argv.date !== "true" ? argv.date : todayUtcDate();
const cities = (argv.cities && argv.cities !== "true"
  ? argv.cities.split(",").map(s => s.trim())
  : ["Seoul", "Madrid", "Jeddah", "Tokyo", "Lagos"]);

const STATIONS = JSON.parse(await fs.readFile("data/metar-stations.json", "utf8"));
const CITY_WU = JSON.parse(await fs.readFile("data/city-wu.json", "utf8"));
const WU_API_KEY = "e1f10a1e78da46f5b10a1e78da96f525";

async function fetchWu(icao, country, dateStr) {
  const url = `https://api.weather.com/v1/location/${icao}:9:${country.toUpperCase()}/observations/historical.json?apiKey=${WU_API_KEY}&units=m&startDate=${dateStr.replace(/-/g, "")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const obs = Array.isArray(data?.observations) ? data.observations : [];
  let max = -Infinity, maxAt = null;
  for (const o of obs) {
    if (typeof o.temp === "number" && o.temp > max) {
      max = o.temp;
      maxAt = o.valid_time_gmt ? new Date(o.valid_time_gmt * 1000).toISOString() : null;
    }
  }
  return { count: obs.length, max: max === -Infinity ? null : max, maxAt };
}

console.log(`Testing v33-wunder fetch path for ${date}\n`);
let ok = 0, fail = 0;
for (const city of cities) {
  const info = CITY_WU[city];
  const icao = STATIONS[city];
  if (!info) { console.log(`  ${city.padEnd(15)} SKIP — not in city-wu.json`); continue; }
  if (!icao) { console.log(`  ${city.padEnd(15)} SKIP — not in metar-stations.json`); continue; }
  if (info.source !== "wunderground") {
    console.log(`  ${city.padEnd(15)} SKIP — source=${info.source} (would fall back to METAR)`);
    continue;
  }
  try {
    const r = await fetchWu(icao, info.country, date);
    console.log(`  ${city.padEnd(15)} ${icao}/${info.country}  ${String(r.count).padStart(3)} obs · max ${r.max ?? "?"}°C @ ${r.maxAt ?? "?"}`);
    ok++;
  } catch (e) {
    console.log(`  ${city.padEnd(15)} ${icao}/${info.country}  ERROR: ${e.message}`);
    fail++;
  }
}
console.log(`\nResult: ${ok} ok, ${fail} failed. ${ok > 0 ? "✓ v33 fetch path works." : "✗ v33 cannot reach Wunderground."}`);
