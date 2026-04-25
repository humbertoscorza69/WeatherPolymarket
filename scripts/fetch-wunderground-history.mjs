#!/usr/bin/env node
/**
 * Pre-fetch Wunderground hourly history for every (city, date) pair in
 * 937's closed-trades log so the no-lookahead guard backtest can run
 * against historical truth.
 *
 * - Reads data/wallet-complete/<wallet>/closed-trades.jsonl
 * - Parses city+date from each title
 * - For each unique (city, date), fetches data/wunderground-history/<ICAO>__<DATE>.json
 *   ONLY if it doesn't already exist (resumable).
 * - Same fetch path as scripts/fetch-wunderground-max.mjs (api.weather.com).
 *
 * Usage:
 *   node scripts/fetch-wunderground-history.mjs
 *   node scripts/fetch-wunderground-history.mjs --wallet=0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab
 *   node scripts/fetch-wunderground-history.mjs --redo   # ignore cache
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const WALLET = argv.wallet ?? "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";
const REDO = argv.redo === "true";

// ---- city info (slug + ICAO + country, copied from fetch-wunderground-max.mjs) ----
const CITY_INFO = {
  "Seoul":         { country: "kr", slug: "incheon",            icao: "RKSI" },
  "Shanghai":      { country: "cn", slug: "shanghai",           icao: "ZSPD" },
  "London":        { country: "gb", slug: "london",             icao: "EGLC" },
  "Chengdu":       { country: "cn", slug: "chengdu",            icao: "ZUUU" },
  "Beijing":       { country: "cn", slug: "beijing",            icao: "ZBAA" },
  "Wellington":    { country: "nz", slug: "wellington",         icao: "NZWN" },
  "New York City": { country: "us", slug: "ny/new-york-city",   icao: "KLGA" },
  "Guangzhou":     { country: "cn", slug: "guangzhou",          icao: "ZGGG" },
  "Tokyo":         { country: "jp", slug: "tokyo",              icao: "RJTT" },
  "Chongqing":    { country: "cn", slug: "chongqing",          icao: "ZUCK" },
  "Singapore":     { country: "sg", slug: "singapore",          icao: "WSSS" },
  "Shenzhen":      { country: "cn", slug: "shenzhen",           icao: "ZGSZ" },
  "Chicago":       { country: "us", slug: "il/chicago",         icao: "KORD" },
  "Taipei":        { country: "tw", slug: "taipei",             icao: "RCSS" },
  "Ankara":        { country: "tr", slug: "%C3%A7ubuk",         icao: "LTAC" },
  "Denver":        { country: "us", slug: "co/aurora",          icao: "KBKF" },
  "Wuhan":         { country: "cn", slug: "wuhan",              icao: "ZHHH" },
  "Paris":         { country: "fr", slug: "bonneuil-en-france", icao: "LFPB" },
  "Atlanta":       { country: "us", slug: "ga/atlanta",         icao: "KATL" },
  "Jakarta":       { country: "id", slug: "jakarta",            icao: "WIHH" },
  "Helsinki":      { country: "fi", slug: "vantaa",             icao: "EFHK" },
  "Munich":        { country: "de", slug: "munich",             icao: "EDDM" },
  "Busan":         { country: "kr", slug: "busan",              icao: "RKPK" },
  "Madrid":        { country: "es", slug: "madrid",             icao: "LEMD" },
  "Lagos":         { country: "ng", slug: "lagos",              icao: "DNMM" },
  "Milan":         { country: "it", slug: "milan",              icao: "LIMC" },
  "Kuala Lumpur":  { country: "my", slug: "sepang-district",    icao: "WMKK" },
  "Manila":        { country: "ph", slug: "manila",             icao: "RPLL" },
  "Lucknow":       { country: "in", slug: "lucknow",            icao: "VILK" },
  "Miami":         { country: "us", slug: "fl/miami",           icao: "KMIA" },
  "Houston":       { country: "us", slug: "tx/houston",         icao: "KHOU" },
  "Los Angeles":   { country: "us", slug: "ca/los-angeles",     icao: "KLAX" },
  "Karachi":       { country: "pk", slug: "karachi",            icao: "OPKC" },
  "Warsaw":        { country: "pl", slug: "warsaw",             icao: "EPWA" },
  "San Francisco": { country: "us", slug: "ca/san-francisco",   icao: "KSFO" },
  "Toronto":       { country: "ca", slug: "mississauga",        icao: "CYYZ" },
  "Buenos Aires":  { country: "ar", slug: "ezeiza",             icao: "SAEZ" },
  "Austin":        { country: "us", slug: "tx/austin",          icao: "KAUS" },
  "Sao Paulo":     { country: "br", slug: "guarulhos",          icao: "SBGR" },
  "Amsterdam":     { country: "nl", slug: "schiphol",           icao: "EHAM" },
  "Mexico City":   { country: "mx", slug: "mexico-city",        icao: "MMMX" },
  "Seattle":       { country: "us", slug: "wa/seatac",          icao: "KSEA" },
  "Dallas":        { country: "us", slug: "tx/dallas",          icao: "KDAL" },
  "Panama City":   { country: "pa", slug: "panama-city",        icao: "MPMG" },
  "Jeddah":        { country: "sa", slug: "jeddah",             icao: "OEJN" },
  "Cape Town":     { country: "za", slug: "matroosfontein",     icao: "FACT" },
  "Hong Kong":     { country: "hk", slug: "hong-kong",          icao: "VHHH" },
  "Tel Aviv":      { country: "il", slug: null,                 icao: "LLBG" },
  "Istanbul":      { country: "tr", slug: null,                 icao: "LTFM" },
  "Moscow":        { country: "ru", slug: null,                 icao: "UUWW" },
  "Berlin":        { country: "de", slug: "berlin",             icao: "EDDB" },
  "Frankfurt":     { country: "de", slug: "frankfurt",          icao: "EDDF" },
  "Boston":        { country: "us", slug: "ma/boston",          icao: "KBOS" },
  "Sydney":        { country: "au", slug: "sydney",             icao: "YSSY" },
  "Bangkok":       { country: "th", slug: "bangkok",            icao: "VTBS" },
  "Mumbai":        { country: "in", slug: "mumbai",             icao: "VABB" },
  "Delhi":         { country: "in", slug: "delhi",              icao: "VIDP" },
  "Dubai":         { country: "ae", slug: "dubai",              icao: "OMDB" },
};

const WU_API_KEY = "e1f10a1e78da46f5b10a1e78da96f525";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OUT_DIR = path.resolve("data/wunderground-history");

const MONTHS = { January:1, February:2, March:3, April:4, May:5, June:6,
                 July:7, August:8, September:9, October:10, November:11, December:12 };

const TITLE_RE = /highest temperature in ([\w \-']+?)\s+be\s+.*?\s+on\s+([A-Za-z]+)\s+(\d{1,2})\??$/i;

function parseCityDate(title) {
  const m = TITLE_RE.exec(title);
  if (!m) return null;
  const city = m[1].trim();
  const month = MONTHS[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()];
  if (!month) return null;
  return { city, date: `2026-${String(month).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}` };
}

async function fetchWuApi(icao, country, date) {
  const yyyymmdd = date.replace(/-/g, "");
  const url = `https://api.weather.com/v1/location/${icao}:9:${country.toUpperCase()}/observations/historical.json?apiKey=${WU_API_KEY}&units=e&startDate=${yyyymmdd}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`api ${res.status} ${res.statusText}`);
  const json = await res.json();
  return json.observations || [];
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const tradesPath = `data/wallet-complete/${WALLET}/closed-trades.jsonl`;
  if (!existsSync(tradesPath)) throw new Error(`no trades file: ${tradesPath}`);

  const lines = (await fs.readFile(tradesPath, "utf8")).split("\n").filter(Boolean);
  const pairs = new Map(); // key = "<city>|<date>" → { city, date }
  for (const line of lines) {
    const t = JSON.parse(line);
    const cd = parseCityDate(t.title || "");
    if (!cd) continue;
    pairs.set(`${cd.city}|${cd.date}`, cd);
  }

  console.log(`Found ${pairs.size} unique (city, date) pairs from ${lines.length} closed trades.`);
  let fetched = 0, skipped = 0, failed = 0, unmapped = 0;
  const failures = [];

  let i = 0;
  for (const { city, date } of pairs.values()) {
    i++;
    const info = CITY_INFO[city];
    if (!info) { unmapped++; failures.push({ city, date, reason: "unmapped city" }); continue; }
    const outPath = path.join(OUT_DIR, `${info.icao}__${date}.json`);
    if (!REDO && existsSync(outPath)) { skipped++; continue; }

    try {
      const obs = await fetchWuApi(info.icao, info.country, date);
      const trimmed = obs.map(o => ({
        t_unix: o.valid_time_gmt,
        iso: o.valid_time_gmt ? new Date(o.valid_time_gmt * 1000).toISOString() : null,
        tempF: o.temp,
        tempC: (typeof o.temp === "number") ? Math.round(((o.temp - 32) * 5 / 9) * 100) / 100 : null,
      }));
      const valid = trimmed.filter(o => typeof o.tempF === "number");
      const max = valid.reduce((a, o) => o.tempF > a.tempF ? o : a, { tempF: -Infinity, tempC: null, iso: null });
      const payload = {
        station: info.icao,
        city,
        date,
        country: info.country,
        observations_count: trimmed.length,
        wunder_max_f: max.tempF === -Infinity ? null : max.tempF,
        wunder_max_c: max.tempC,
        wunder_max_at: max.iso,
        observations: trimmed,
        fetched_at: new Date().toISOString(),
      };
      await fs.writeFile(outPath, JSON.stringify(payload, null, 2));
      fetched++;
      if (i % 25 === 0 || fetched <= 5) {
        console.log(`[${i}/${pairs.size}] ${info.icao} ${date} → max ${payload.wunder_max_f}°F (${payload.wunder_max_c}°C), ${trimmed.length} obs`);
      }
    } catch (e) {
      failed++;
      failures.push({ city, date, icao: info.icao, reason: String(e.message ?? e) });
      console.error(`[${i}/${pairs.size}] ${info.icao} ${date} FAIL: ${e.message ?? e}`);
    }
    // be polite
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nDone. fetched=${fetched} skipped=${skipped} failed=${failed} unmapped=${unmapped}`);
  if (failures.length) {
    const failPath = path.join(OUT_DIR, "_failures.json");
    await fs.writeFile(failPath, JSON.stringify(failures, null, 2));
    console.log(`failures written to ${failPath}`);
  }
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
