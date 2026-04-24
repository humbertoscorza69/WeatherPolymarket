#!/usr/bin/env node
/**
 * Fetch historical hourly temperature for every weather market in the
 * resolved-market-cache. Uses Open-Meteo's free archive API (no key).
 *
 * For each unique (city, date) pair:
 *   1. Geocode city -> (lat, lon) via Open-Meteo geocoding (cached)
 *   2. Fetch hourly temperature_2m for [date-1, date+1] in UTC
 *      (extra day each side to handle timezone boundary cleanly)
 *   3. Write to data/weather-history/<city>__<date>.json
 *
 * Output schema:
 *   {
 *     city, country, lat, lon, date,
 *     samples: [{ t: unix_sec, tempC }]
 *   }
 *
 * Usage:
 *   npm run fetch-historical-weather
 *
 * Runtime: ~10 min for ~500 unique (city, date) pairs (Open-Meteo is fast).
 * Free limit is 10k requests/day, we use ~1k.
 *
 * Caveat: Open-Meteo's archive API uses reanalysis data with a ~5-day lag.
 * Very recent markets (< 5 days old) may not have historical data yet; those
 * fall back to the forecast API.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const CACHE_DIR = path.resolve("data/resolved-market-cache");
const OUT_DIR   = path.resolve("data/weather-history");
const GEO_CACHE = path.resolve("data/weather-history/_geocoding.json");
await fs.mkdir(OUT_DIR, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));
const REFRESH = args.refresh === "true";

async function fetchJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) { if (i === retries) throw new Error(`HTTP ${r.status}`); await new Promise(x=>setTimeout(x, 1000 * (i+1))); continue; }
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(x => setTimeout(x, 1000 * (i+1)));
    }
  }
}

// ----- parsing the market title -----

function parseWeatherTitle(title) {
  if (!title) return null;
  // "Will the highest temperature in Taipei be 29°C on April 12?"
  // "Will the highest temperature in Paris be 22°C on April 15?"
  // "Will the highest temperature in Miami be between 82-83°F on April 20?"
  // "Will the highest temperature in Denver be 54°F or higher on April 12?"
  const cityMatch = title.match(/temperature in ([A-Z][\w .\-']+?) be/i);
  if (!cityMatch) return null;
  const city = cityMatch[1].trim();

  const unit = /°F/i.test(title) ? "F" : "C";
  // Threshold: single like "29°C", "54°F", or range "82-83°F"
  let threshold = null, thresholdHigh = null;
  const rangeMatch = title.match(/be\s+(?:between\s+)?(\d+)(?:\s*-\s*(\d+))?\s*°/i);
  if (rangeMatch) {
    threshold = Number(rangeMatch[1]);
    if (rangeMatch[2]) thresholdHigh = Number(rangeMatch[2]);
  }

  const type = /or higher/i.test(title) ? "at_or_above"
              : /or below/i.test(title) ? "at_or_below"
              : /between/i.test(title)  ? "between"
              : "exact";

  // Date: "on April 12", "on April 12, 2026", "on 2026-04-21"
  let date = null;
  const monthMatch = title.match(/on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)(?:,\s*(\d{4}))?/i);
  const isoMatch = title.match(/on\s+(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) date = isoMatch[1];
  else if (monthMatch) {
    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const mIdx = monthNames.findIndex(m => m.toLowerCase() === monthMatch[1].toLowerCase());
    const day = monthMatch[2];
    const year = monthMatch[3] || "2026"; // default current
    date = `${year}-${String(mIdx+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  }
  if (!date) return null;

  return { city, date, unit, threshold, thresholdHigh, type };
}

// ----- geocoding cache -----

let geoCache = {};
if (existsSync(GEO_CACHE)) {
  try { geoCache = JSON.parse(await fs.readFile(GEO_CACHE, "utf8")); } catch {}
}

async function geocode(city) {
  if (geoCache[city]) return geoCache[city];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`;
  try {
    const j = await fetchJson(url);
    const r = j?.results?.[0];
    if (!r) { geoCache[city] = null; return null; }
    const out = { lat: r.latitude, lon: r.longitude, country: r.country, tz: r.timezone };
    geoCache[city] = out;
    await fs.writeFile(GEO_CACHE, JSON.stringify(geoCache, null, 2));
    return out;
  } catch (e) {
    console.log(`geocode fail ${city}: ${e.message}`);
    geoCache[city] = null;
    return null;
  }
}

// ----- weather fetch -----

async function fetchDay(lat, lon, date, tz = "UTC") {
  const d = new Date(date + "T00:00:00Z");
  const startDate = new Date(d.getTime() - 86400*1000).toISOString().slice(0,10);
  const endDate   = new Date(d.getTime() + 86400*1000).toISOString().slice(0,10);
  const now = Date.now();
  const ageDays = (now - d.getTime()) / 86400_000;

  // For dates older than 5 days → try archive first (reanalysis)
  if (ageDays >= 5) {
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&hourly=temperature_2m&timezone=UTC`;
      const j = await fetchJson(url);
      const times = j?.hourly?.time ?? [];
      const temps = j?.hourly?.temperature_2m ?? [];
      if (temps.length > 0 && temps.some(t => t !== null)) {
        const samples = times.map((t, i) => ({ t: Math.floor(new Date(t + "Z").getTime()/1000), tempC: temps[i] }))
                             .filter(s => s.tempC !== null && Number.isFinite(s.tempC));
        return { samples, source: "archive" };
      }
    } catch (e) { /* fall through */ }
  }

  // For recent / future dates (< 5d old, up to +16d future), use forecast API.
  // Open-Meteo forecast accepts start_date/end_date within ±16 days of now WITHOUT past_days.
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&hourly=temperature_2m&timezone=UTC`;
    const j = await fetchJson(url);
    const times = j?.hourly?.time ?? [];
    const temps = j?.hourly?.temperature_2m ?? [];
    if (temps.length > 0 && temps.some(t => t !== null)) {
      const samples = times.map((t, i) => ({ t: Math.floor(new Date(t + "Z").getTime()/1000), tempC: temps[i] }))
                           .filter(s => s.tempC !== null && Number.isFinite(s.tempC));
      return { samples, source: "forecast" };
    }
  } catch (e) { /* fall through */ }

  // Last resort: forecast with past_days (recovers recent past when the
  // start_date/end_date approach fails — older open-meteo quirk).
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&timezone=UTC&past_days=16&forecast_days=16`;
    const j = await fetchJson(url);
    const times = j?.hourly?.time ?? [];
    const temps = j?.hourly?.temperature_2m ?? [];
    const targetStart = new Date(startDate + "T00:00:00Z").getTime() / 1000;
    const targetEnd   = new Date(endDate   + "T23:59:59Z").getTime() / 1000;
    const samples = times.map((t, i) => ({ t: Math.floor(new Date(t + "Z").getTime()/1000), tempC: temps[i] }))
                         .filter(s => s.tempC !== null && Number.isFinite(s.tempC) &&
                                      s.t >= targetStart && s.t <= targetEnd);
    if (samples.length > 0) return { samples, source: "forecast-pastdays" };
  } catch (e) {
    return { samples: [], error: e.message };
  }
  return { samples: [], error: "no-data-from-any-endpoint" };
}

// ----- main -----

async function main() {
  // Scan BOTH resolved-market-cache titles AND wallet-trades titles so we cover
  // every weather market referenced by any wallet, not just ones in the cache.
  const markets = new Map(); // city__date -> parsed

  // Source 1: resolved-market-cache
  if (existsSync(CACHE_DIR)) {
    const files = (await fs.readdir(CACHE_DIR)).filter(f => f.endsWith(".json"));
    for (const f of files) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(CACHE_DIR, f), "utf8"));
        if (!/temperature/i.test(j.title || "")) continue;
        const parsed = parseWeatherTitle(j.title);
        if (!parsed) continue;
        const key = `${parsed.city}__${parsed.date}`;
        if (!markets.has(key)) markets.set(key, parsed);
      } catch {}
    }
    console.log(`From resolved-market-cache: ${markets.size} (city, date) pairs`);
  }

  // Source 2: wallet-trades (catches markets that are in any winning wallet
  // but not in our price-history cache)
  const walletDir = path.resolve("data/wallet-trades");
  if (existsSync(walletDir)) {
    const walletFiles = (await fs.readdir(walletDir)).filter(f => f.endsWith(".jsonl"));
    for (const wf of walletFiles) {
      const lines = (await fs.readFile(path.join(walletDir, wf), "utf8")).trim().split("\n").filter(Boolean);
      for (const l of lines) {
        try {
          const t = JSON.parse(l);
          if (!/temperature/i.test(t.title || "")) continue;
          const parsed = parseWeatherTitle(t.title);
          if (!parsed) continue;
          const key = `${parsed.city}__${parsed.date}`;
          if (!markets.has(key)) markets.set(key, parsed);
        } catch {}
      }
    }
  }
  console.log(`Total unique (city, date) pairs after including wallet-trades: ${markets.size}\n`);

  let ok = 0, skipped = 0, fail = 0, noGeo = 0;
  let i = 0;
  for (const [key, m] of markets) {
    i++;
    const outFile = path.join(OUT_DIR, `${key}.json`);
    if (!REFRESH && existsSync(outFile)) {
      const sz = (await fs.stat(outFile)).size;
      if (sz > 50) { skipped++; continue; }
    }
    const geo = await geocode(m.city);
    if (!geo) { process.stdout.write(`[${i}/${markets.size}] ${m.city.padEnd(20)} ${m.date}  NO-GEO\n`); noGeo++; continue; }
    process.stdout.write(`[${i}/${markets.size}] ${m.city.padEnd(20)} ${m.date}  lat=${geo.lat.toFixed(2)} lon=${geo.lon.toFixed(2)}  `);
    const res = await fetchDay(geo.lat, geo.lon, m.date);
    if (!res.samples.length) {
      console.log(`no-data ${res.error || ""}`);
      fail++;
      continue;
    }
    const payload = {
      city: m.city, country: geo.country, lat: geo.lat, lon: geo.lon, tz: geo.tz,
      date: m.date,
      threshold: m.threshold, thresholdHigh: m.thresholdHigh, unit: m.unit, type: m.type,
      source: res.source,
      fetchedAt: Date.now(),
      samples: res.samples
    };
    await fs.writeFile(outFile, JSON.stringify(payload));
    console.log(`${res.samples.length} hourly samples (${res.source})`);
    ok++;
    if (i % 25 === 0) await new Promise(r => setTimeout(r, 500));
    else await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\nDone. ok=${ok} skipped=${skipped} fail=${fail} no-geo=${noGeo}`);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
