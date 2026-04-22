#!/usr/bin/env node
/**
 * LIVE OPPORTUNITY DETECTION ENGINE
 *
 * Runs continuously against live market + weather data. Applies the EXACT
 * same rules as the v10 backtest. When a signal fires, logs:
 *   - Market details (city, date, threshold, type)
 *   - Current price, TTR, observed max temperature
 *   - What our backtest predicted (NO will win)
 *
 * It does NOT place orders. Purpose: confirm signals fire in real time
 * and track what actually happens (does NO resolve as predicted?).
 *
 * Data sources (all public, free):
 *   - Polymarket Gamma:  active weather markets + current prices
 *   - aviationweather.gov/api/data/metar: hourly station observations
 *   - api.open-meteo.com/v1/forecast: backup / cities w/o METAR mapping
 *
 * Output:
 *   data/detect-log.jsonl — append-only log of all signals fired
 *   data/detect-followup.jsonl — per-market outcome when it resolves
 *
 * Usage:
 *   node scripts/detect.mjs                         # default: check every 5min
 *   node scripts/detect.mjs --interval=60           # every 60 sec
 *   node scripts/detect.mjs --once                  # single pass
 *   node scripts/detect.mjs --minentry=0.70 ...    # same flags as backtest
 *
 * Integration with live bot later:
 *   Signals printed to stdout are actionable. A later live-bot script
 *   can consume this same detection logic and place real orders.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const CFG = {
  MIN_ENTRY:    Number(argv.minentry ?? "0.70"),
  MAX_ENTRY:    Number(argv.maxentry ?? "0.99"),
  TTR_MIN_SEC:  Number(argv.ttrmin ?? String(30*60)),       // 0.5h
  TTR_MAX_SEC:  Number(argv.ttrmax ?? String(8*3600)),      // 8h
  CROSSED_BUF:  Number(argv.crossedbuf ?? "0.5"),
  INTERVAL_SEC: Number(argv.interval ?? "300"),             // 5 min
  ONCE:         argv.once === "true",
  FILTER_TYPE:  argv.filtertype ?? "exact",
  FILTER_UNIT:  argv.filterunit ?? "C",
};

const LOG = path.resolve("data/detect-log.jsonl");
const FOLLOWUP = path.resolve("data/detect-followup.jsonl");
const STATE = path.resolve("data/detect-state.json");
const STATIONS_FILE = path.resolve("data/metar-stations.json");
await fs.mkdir(path.dirname(LOG), { recursive: true });

const STATIONS = existsSync(STATIONS_FILE)
  ? JSON.parse(await fs.readFile(STATIONS_FILE, "utf8"))
  : {};

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const OM_FORECAST = "https://api.open-meteo.com/v1/forecast";
const OM_GEO = "https://geocoding-api.open-meteo.com/v1/search";

// ----- small utilities -----
async function fetchJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) {
        if (i === retries) throw new Error(`HTTP ${r.status}`);
        await new Promise(x => setTimeout(x, 500 * (i + 1)));
        continue;
      }
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(x => setTimeout(x, 500 * (i + 1)));
    }
  }
}

function parseWeatherTitle(t) {
  if (!t) return null;
  let m = t.match(/temperature in ([A-Z][\w .\-']+?) be/i);
  if (!m) m = t.match(/temperature in ([A-Z][\w .\-']+?) on/i);
  if (!m) return null;
  const city = m[1].trim();
  const unit = /°F/i.test(t) ? "F" : "C";
  const r = t.match(/be\s+(?:between\s+)?(\d+)(?:\s*-\s*(\d+))?\s*°?/i);
  const thr = r ? Number(r[1]) : null;
  const thrHi = r && r[2] ? Number(r[2]) : null;
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
    const y = mon[3] || String(new Date().getUTCFullYear());
    date = `${y}-${String(mi+1).padStart(2,"0")}-${String(mon[2]).padStart(2,"0")}`;
  }
  return { city, date, unit, threshold: thr, thresholdHigh: thrHi, type: typ, isLowest: /lowest temperature/i.test(t) };
}

function toC(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }

async function fetchLiveWeatherMarkets() {
  // Get all open weather markets with endDate in the next 24h
  const markets = [];
  const nowIso = new Date().toISOString();
  const in24h = new Date(Date.now() + 86400_000 * 2).toISOString();
  let offset = 0;
  while (offset < 5000) {
    const url = `${GAMMA}/markets?closed=false&tag_slug=weather&limit=500&offset=${offset}&end_date_min=${nowIso}&end_date_max=${in24h}`;
    const page = await fetchJson(url);
    if (!Array.isArray(page) || !page.length) break;
    for (const m of page) {
      if (!m.conditionId) continue;
      const q = m.question || m.title || "";
      if (!/temperature/i.test(q)) continue;
      markets.push({
        conditionId: m.conditionId,
        title: q,
        endDate: m.endDate,
        clobTokenIds: typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds,
      });
    }
    if (page.length < 500) break;
    offset += 500;
  }
  return markets;
}

async function fetchCurrentPrice(clobTokenIds) {
  // clobTokenIds is [YES_token, NO_token]. We care about NO price.
  if (!Array.isArray(clobTokenIds) || clobTokenIds.length < 2) return null;
  const noTokenId = clobTokenIds[1];
  try {
    const r = await fetchJson(`${CLOB}/midpoint?token_id=${noTokenId}`);
    return r?.mid ? Number(r.mid) : null;
  } catch { return null; }
}

// METAR: fetch today's observations for a station
async function fetchMetarToday(icao) {
  const url = `${METAR_API}?ids=${icao}&format=json&hours=24`;
  try {
    const data = await fetchJson(url);
    if (!Array.isArray(data)) return [];
    return data.map(m => ({ t: m.obsTime, tempC: m.temp }))
      .filter(o => o.t && o.tempC != null).sort((a,b) => a.t - b.t);
  } catch { return []; }
}

// Open-Meteo forecast for the city (fallback when no METAR station)
async function fetchOpenMeteoForecast(city) {
  try {
    const g = await fetchJson(`${OM_GEO}?name=${encodeURIComponent(city)}&count=1&format=json`);
    const r = g?.results?.[0];
    if (!r) return { samples: [], tz: null };
    const url = `${OM_FORECAST}?latitude=${r.latitude}&longitude=${r.longitude}&hourly=temperature_2m&timezone=UTC&past_days=1&forecast_days=2`;
    const j = await fetchJson(url);
    const times = j?.hourly?.time ?? [];
    const temps = j?.hourly?.temperature_2m ?? [];
    const samples = times.map((t, i) => ({ t: Math.floor(new Date(t + "Z").getTime()/1000), tempC: temps[i] }))
      .filter(s => Number.isFinite(s.tempC));
    return { samples, tz: r.timezone };
  } catch { return { samples: [], tz: null }; }
}

function thresholdCrossed(market, obs, buffer) {
  if (!market || market.threshold == null) return { crossed: false };
  const nowSec = Math.floor(Date.now() / 1000);
  let maxTemp = -999;
  for (const [t, temp] of obs) {
    if (t > nowSec) break;
    if (temp > maxTemp) maxTemp = temp;
  }
  if (maxTemp <= -999) return { crossed: false, reason: "no observations" };
  const thrC = toC(market.threshold, market.unit);
  const thrHiC = market.thresholdHigh != null ? toC(market.thresholdHigh, market.unit) : null;
  if (market.type === "exact") return { crossed: Math.abs(maxTemp - thrC) > buffer, maxTemp, thrC };
  if (market.type === "at_or_below") return { crossed: maxTemp > thrC + buffer, maxTemp, thrC };
  if (market.type === "between" && thrHiC != null) return { crossed: maxTemp > thrHiC + buffer, maxTemp, thrC: thrHiC };
  return { crossed: false, maxTemp, thrC };
}

async function scanOnce() {
  const tScan = new Date().toISOString();
  console.log(`\n[${tScan}] Scanning live weather markets...`);
  const markets = await fetchLiveWeatherMarkets();
  console.log(`  fetched ${markets.length} open weather markets`);

  const signals = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (const mk of markets) {
    const parsed = parseWeatherTitle(mk.title);
    if (!parsed || !parsed.date || parsed.threshold == null) continue;
    if (parsed.isLowest) continue;  // not modeled yet
    if (CFG.FILTER_TYPE !== "any" && parsed.type !== CFG.FILTER_TYPE) continue;
    if (CFG.FILTER_UNIT !== "any" && parsed.unit !== CFG.FILTER_UNIT) continue;

    const endSec = Math.floor(new Date(mk.endDate).getTime() / 1000);
    const ttr = endSec - nowSec;
    if (ttr < CFG.TTR_MIN_SEC || ttr > CFG.TTR_MAX_SEC) continue;

    // Price check
    const price = await fetchCurrentPrice(mk.clobTokenIds);
    if (price == null) continue;
    if (price < CFG.MIN_ENTRY || price > CFG.MAX_ENTRY) continue;

    // Weather check (prefer METAR, fallback Open-Meteo)
    const icao = STATIONS[parsed.city];
    let obs = [];
    let obsSource = null;
    if (icao) {
      obs = await fetchMetarToday(icao);
      if (obs.length) obsSource = `metar:${icao}`;
    }
    if (!obs.length) {
      const om = await fetchOpenMeteoForecast(parsed.city);
      obs = om.samples;
      if (obs.length) obsSource = "open-meteo";
    }

    const tc = thresholdCrossed(parsed, obs, CFG.CROSSED_BUF);
    if (!tc.crossed) continue;

    const signal = {
      ts: tScan,
      conditionId: mk.conditionId,
      title: mk.title,
      city: parsed.city,
      date: parsed.date,
      threshold: parsed.threshold,
      type: parsed.type,
      currentPrice: price,
      ttrHours: Math.round(ttr / 360) / 10,
      endDate: mk.endDate,
      obsMaxTempC: Math.round(tc.maxTemp * 10) / 10,
      thresholdC: Math.round(tc.thrC * 10) / 10,
      cushionC: Math.round((tc.maxTemp - tc.thrC) * 10) / 10,
      obsSource,
      projectedPnLPerShare: 1.0 - price,  // if hold to NO resolution
      projectedPct: Math.round((1.0 / price - 1) * 10000) / 100,
    };
    signals.push(signal);
    await fs.appendFile(LOG, JSON.stringify(signal) + "\n");
    console.log(`  🎯 SIGNAL  ${parsed.city.padEnd(15)} ${parsed.date}  thr=${parsed.threshold}${parsed.unit}  obs=${signal.obsMaxTempC}  cushion=+${signal.cushionC}  price=${price.toFixed(4)}  TTR=${signal.ttrHours}h  upside=+${signal.projectedPct}%`);
  }

  if (signals.length === 0) {
    console.log(`  (no signals fired this pass)`);
  } else {
    console.log(`\n[${tScan}] ${signals.length} signals logged to ${LOG}`);
  }
  return signals;
}

async function main() {
  console.log(`Detection engine config: TTR=[${CFG.TTR_MIN_SEC/3600}h, ${CFG.TTR_MAX_SEC/3600}h] price=[${CFG.MIN_ENTRY}, ${CFG.MAX_ENTRY}] buffer=${CFG.CROSSED_BUF}°C interval=${CFG.INTERVAL_SEC}s`);
  console.log(`Logs: ${LOG}`);
  console.log(`METAR stations mapped: ${Object.keys(STATIONS).length}`);
  console.log();
  do {
    try { await scanOnce(); }
    catch (e) { console.error(`scan error: ${e.message}`); }
    if (CFG.ONCE) break;
    await new Promise(r => setTimeout(r, CFG.INTERVAL_SEC * 1000));
  } while (true);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
