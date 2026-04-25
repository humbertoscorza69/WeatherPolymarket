#!/usr/bin/env node
/**
 * Fetch Wunderground's hourly history for a city/date and compute the
 * day's max °C — i.e. the actual resolution source for most Polymarket
 * weather markets. Optionally compare against the local METAR file
 * (data/metar-observations/<ICAO>__<DATE>.json) to surface feed gaps.
 *
 * Usage:
 *   node scripts/fetch-wunderground-max.mjs --city="Seoul" --date=2026-04-25
 *   node scripts/fetch-wunderground-max.mjs --city="Seoul"            # date = today UTC
 *   node scripts/fetch-wunderground-max.mjs --all --date=2026-04-25   # all known cities
 *   node scripts/fetch-wunderground-max.mjs --city="Seoul" --save     # write data/wunderground-history/...
 *
 * Output: a JSON block to stdout. Paste it back when reporting results.
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

// Wunderground daily-history URL slugs, taken verbatim from the user-verified
// resolution-source list (the bit between /history/daily/ and /date/).
// Format: city -> { country, slug, icao, source }
//   source = "wunderground" | "weather.gov" | "hko"
// Cities whose Polymarket markets resolve on a NON-Wunderground source
// (Hong Kong → HKO; Tel Aviv/Istanbul/Moscow → NWS) are flagged so we
// don't accidentally treat the WU number as ground truth for them.
const CITY_INFO = {
  "Seoul":         { country: "kr", slug: "incheon",          icao: "RKSI", source: "wunderground" },
  "Shanghai":      { country: "cn", slug: "shanghai",         icao: "ZSPD", source: "wunderground" },
  "London":        { country: "gb", slug: "london",           icao: "EGLC", source: "wunderground" },
  "Chengdu":       { country: "cn", slug: "chengdu",          icao: "ZUUU", source: "wunderground" },
  "Beijing":       { country: "cn", slug: "beijing",          icao: "ZBAA", source: "wunderground" },
  "Wellington":    { country: "nz", slug: "wellington",       icao: "NZWN", source: "wunderground" },
  "New York City": { country: "us", slug: "ny/new-york-city", icao: "KLGA", source: "wunderground" },
  "Guangzhou":     { country: "cn", slug: "guangzhou",        icao: "ZGGG", source: "wunderground" },
  "Tokyo":         { country: "jp", slug: "tokyo",            icao: "RJTT", source: "wunderground" },
  "Chongqing":     { country: "cn", slug: "chongqing",        icao: "ZUCK", source: "wunderground" },
  "Singapore":     { country: "sg", slug: "singapore",        icao: "WSSS", source: "wunderground" },
  "Shenzhen":      { country: "cn", slug: "shenzhen",         icao: "ZGSZ", source: "wunderground" },
  "Chicago":       { country: "us", slug: "il/chicago",       icao: "KORD", source: "wunderground" },
  "Taipei":        { country: "tw", slug: "taipei",           icao: "RCSS", source: "wunderground" },
  "Ankara":        { country: "tr", slug: "%C3%A7ubuk",       icao: "LTAC", source: "wunderground" },
  "Denver":        { country: "us", slug: "co/aurora",        icao: "KBKF", source: "wunderground" },
  "Wuhan":         { country: "cn", slug: "wuhan",            icao: "ZHHH", source: "wunderground" },
  "Paris":         { country: "fr", slug: "bonneuil-en-france", icao: "LFPB", source: "wunderground" },
  "Atlanta":       { country: "us", slug: "ga/atlanta",       icao: "KATL", source: "wunderground" },
  "Jakarta":       { country: "id", slug: "jakarta",          icao: "WIHH", source: "wunderground" },
  "Helsinki":      { country: "fi", slug: "vantaa",           icao: "EFHK", source: "wunderground" },
  "Munich":        { country: "de", slug: "munich",           icao: "EDDM", source: "wunderground" },
  "Busan":         { country: "kr", slug: "busan",            icao: "RKPK", source: "wunderground" },
  "Madrid":        { country: "es", slug: "madrid",           icao: "LEMD", source: "wunderground" },
  "Lagos":         { country: "ng", slug: "lagos",            icao: "DNMM", source: "wunderground" },
  "Milan":         { country: "it", slug: "milan",            icao: "LIMC", source: "wunderground" },
  "Kuala Lumpur":  { country: "my", slug: "sepang-district",  icao: "WMKK", source: "wunderground" },
  "Manila":        { country: "ph", slug: "manila",           icao: "RPLL", source: "wunderground" },
  "Lucknow":       { country: "in", slug: "lucknow",          icao: "VILK", source: "wunderground" },
  "Miami":         { country: "us", slug: "fl/miami",         icao: "KMIA", source: "wunderground" },
  "Houston":       { country: "us", slug: "tx/houston",       icao: "KHOU", source: "wunderground" },
  "Los Angeles":   { country: "us", slug: "ca/los-angeles",   icao: "KLAX", source: "wunderground" },
  "Karachi":       { country: "pk", slug: "karachi",          icao: "OPKC", source: "wunderground" },
  "Warsaw":        { country: "pl", slug: "warsaw",           icao: "EPWA", source: "wunderground" },
  "San Francisco": { country: "us", slug: "ca/san-francisco", icao: "KSFO", source: "wunderground" },
  "Toronto":       { country: "ca", slug: "mississauga",      icao: "CYYZ", source: "wunderground" },
  "Buenos Aires":  { country: "ar", slug: "ezeiza",           icao: "SAEZ", source: "wunderground" },
  "Austin":        { country: "us", slug: "tx/austin",        icao: "KAUS", source: "wunderground" },
  "Sao Paulo":     { country: "br", slug: "guarulhos",        icao: "SBGR", source: "wunderground" },
  "Amsterdam":     { country: "nl", slug: "schiphol",         icao: "EHAM", source: "wunderground" },
  "Mexico City":   { country: "mx", slug: "mexico-city",      icao: "MMMX", source: "wunderground" },
  "Seattle":       { country: "us", slug: "wa/seatac",        icao: "KSEA", source: "wunderground" },
  "Dallas":        { country: "us", slug: "tx/dallas",        icao: "KDAL", source: "wunderground" },
  "Panama City":   { country: "pa", slug: "panama-city",      icao: "MPMG", source: "wunderground" },
  "Jeddah":        { country: "sa", slug: "jeddah",           icao: "OEJN", source: "wunderground" },
  "Cape Town":     { country: "za", slug: "matroosfontein",   icao: "FACT", source: "wunderground" },
  // Non-Wunderground resolution sources — flagged so we don't trust WU here:
  "Hong Kong":     { country: "hk", slug: "hong-kong",        icao: "VHHH", source: "hko",
                     sourceUrl: "https://www.weather.gov.hk/en/cis/climat.htm" },
  "Tel Aviv":      { country: "il", slug: null,               icao: "LLBG", source: "weather.gov",
                     sourceUrl: "https://www.weather.gov/wrh/timeseries?site=LLBG" },
  "Istanbul":      { country: "tr", slug: null,               icao: "LTFM", source: "weather.gov",
                     sourceUrl: "https://www.weather.gov/wrh/timeseries?site=LTFM" },
  "Moscow":        { country: "ru", slug: null,               icao: "UUWW", source: "weather.gov",
                     sourceUrl: "https://www.weather.gov/wrh/timeseries?site=UUWW" },
};

// Public api key embedded in Wunderground's own client-side JS — used here
// only to read the same data the daily-history page itself shows. If WU
// rotates it, fall back to scraping the rendered page.
const WU_API_KEY = "e1f10a1e78da46f5b10a1e78da96f525";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function fToC(f) {
  if (f == null || Number.isNaN(f)) return null;
  return (f - 32) * 5 / 9;
}

function todayUTCDate() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function parseDate(s) {
  // accepts YYYY-MM-DD; returns { y, m, d, yyyymmdd }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date: ${s} (want YYYY-MM-DD)`);
  return { y: +m[1], m: +m[2], d: +m[3], yyyymmdd: `${m[1]}${m[2]}${m[3]}` };
}

function fmtDailyUrl(info, date) {
  // https://www.wunderground.com/history/daily/<country>/<slug>/<ICAO>/date/YYYY-M-D
  const { y, m, d } = parseDate(date);
  return `https://www.wunderground.com/history/daily/${info.country}/${info.slug}/${info.icao}/date/${y}-${m}-${d}`;
}

async function fetchWuApi(icao, country, date) {
  // Wunderground's underlying observations endpoint. units=e returns °F + mph (matches the page).
  const { yyyymmdd } = parseDate(date);
  const url = `https://api.weather.com/v1/location/${icao}:9:${country.toUpperCase()}/observations/historical.json?apiKey=${WU_API_KEY}&units=e&startDate=${yyyymmdd}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`api.weather.com ${res.status} ${res.statusText} for ${icao} ${date}`);
  const json = await res.json();
  const obs = json.observations || [];
  return obs.map(o => ({
    t_unix: o.valid_time_gmt,
    iso: o.valid_time_gmt ? new Date(o.valid_time_gmt * 1000).toISOString() : null,
    tempF: o.temp,
    tempC: fToC(o.temp),
    dewF: o.dewPt,
    raw: o,
  }));
}

async function fetchWuPageScrape(info, date) {
  // Fallback: parse __NEXT_DATA__ from the daily-history HTML.
  const url = fmtDailyUrl(info, date);
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html" } });
  if (!res.ok) throw new Error(`page ${res.status} ${res.statusText} for ${url}`);
  const html = await res.text();
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error(`__NEXT_DATA__ not found in ${url}`);
  const data = JSON.parse(m[1]);
  // Walk the Next.js data tree looking for an observations-like array.
  const found = [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object" && node[0] != null) {
        const k = Object.keys(node[0]);
        if (k.includes("temp") || k.includes("temperature") || k.includes("valid_time_gmt")) {
          found.push(node);
        }
      }
      for (const x of node) walk(x, depth + 1);
    } else if (typeof node === "object") {
      for (const v of Object.values(node)) walk(v, depth + 1);
    }
  };
  walk(data);
  if (!found.length) throw new Error(`no observations array in __NEXT_DATA__`);
  // Pick the longest array as the hourly observations.
  const obs = found.sort((a, b) => b.length - a.length)[0];
  return obs.map(o => ({
    t_unix: o.valid_time_gmt ?? null,
    iso: o.valid_time_gmt ? new Date(o.valid_time_gmt * 1000).toISOString() : (o.expire_time_gmt ?? null),
    tempF: o.temp ?? o.temperature ?? null,
    tempC: fToC(o.temp ?? o.temperature ?? null),
    raw: o,
  }));
}

async function loadMetar(icao, date) {
  const p = path.resolve(`data/metar-observations/${icao}__${date}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function processCity(city, date, opts) {
  const info = CITY_INFO[city];
  if (!info) return { city, error: "unknown city" };
  const result = {
    city,
    date,
    icao: info.icao,
    resolution_source: info.source,
    wunderground_url: info.slug ? fmtDailyUrl(info, date) : (info.sourceUrl ?? null),
  };
  if (info.source !== "wunderground") {
    result.note = `resolution source is ${info.source}, not Wunderground — fetching WU anyway for cross-check`;
  }

  let obs;
  try {
    obs = await fetchWuApi(info.icao, info.country, date);
    result.fetch_method = "api.weather.com";
  } catch (apiErr) {
    result.api_error = String(apiErr.message ?? apiErr);
    if (info.slug) {
      try {
        obs = await fetchWuPageScrape(info, date);
        result.fetch_method = "page-scrape";
      } catch (pageErr) {
        result.page_error = String(pageErr.message ?? pageErr);
        return result;
      }
    } else {
      result.page_error = "no slug — non-Wunderground source";
      return result;
    }
  }

  // Compute max °C from observations; keep the timestamp of the max.
  let maxC = -Infinity, maxAt = null, maxF = null;
  const trimmed = [];
  for (const o of obs) {
    if (typeof o.tempF === "number") {
      const c = o.tempC;
      if (c != null && c > maxC) { maxC = c; maxAt = o.iso; maxF = o.tempF; }
      trimmed.push({ iso: o.iso, tempF: o.tempF, tempC: c == null ? null : Math.round(c * 100) / 100 });
    }
  }
  result.observations_count = trimmed.length;
  result.wunder_max_f = maxF;
  result.wunder_max_c = maxC === -Infinity ? null : Math.round(maxC * 100) / 100;
  result.wunder_max_c_rounded = result.wunder_max_c == null ? null : Math.round(result.wunder_max_c);
  result.wunder_max_at = maxAt;

  // METAR cross-check.
  const metar = await loadMetar(info.icao, date);
  if (metar) {
    result.metar_max_c = metar.computedMax ?? null;
    result.metar_obs_count = (metar.observations ?? []).length;
    if (typeof result.metar_max_c === "number" && typeof result.wunder_max_c === "number") {
      result.delta_metar_minus_wunder_c = Math.round((result.metar_max_c - result.wunder_max_c) * 100) / 100;
      result.disagreement = Math.abs(result.delta_metar_minus_wunder_c) >= 0.5;
    }
  } else {
    result.metar_status = "no local METAR file";
  }

  if (opts.save) {
    const outDir = path.resolve("data/wunderground-history");
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `${info.icao}__${date}.json`);
    await fs.writeFile(outPath, JSON.stringify({ ...result, observations: trimmed }, null, 2));
    result.saved_to = outPath;
  }
  if (opts.includeObs) result.observations = trimmed;
  return result;
}

async function main() {
  const date = argv.date && argv.date !== "true" ? argv.date : todayUTCDate();
  const save = argv.save === "true";
  const includeObs = argv.obs === "true";
  const cities = argv.all === "true"
    ? Object.keys(CITY_INFO)
    : (argv.city ? [argv.city] : ["Seoul"]);

  const out = [];
  for (const city of cities) {
    try {
      const r = await processCity(city, date, { save, includeObs });
      out.push(r);
      // small delay to be polite
      if (cities.length > 1) await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      out.push({ city, date, error: String(e.message ?? e) });
    }
  }
  console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
}

main().catch(e => {
  console.error("fatal:", e);
  process.exit(1);
});
