#!/usr/bin/env node
/**
 * Inspect a local METAR file: print top-N observations by tempC,
 * with raw METAR strings so we can see exactly what produced an
 * outlier reading.
 *
 * Usage:
 *   node scripts/inspect-metar.mjs --icao=KATL --date=2026-04-19
 *   node scripts/inspect-metar.mjs --icao=KATL --date=2026-04-19 --top=20
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
const ICAO = argv.icao;
const DATE = argv.date;
const TOP = Number(argv.top ?? "15");
if (!ICAO || !DATE) { console.error("usage: --icao=KATL --date=YYYY-MM-DD"); process.exit(1); }

const candidates = [
  `data/metar-observations/${ICAO}__${DATE}.json`,
  `data/metar-history/${ICAO}__${DATE}.json`,
];
let filePath = null, raw = null;
for (const p of candidates) {
  if (existsSync(p)) { filePath = p; raw = JSON.parse(await fs.readFile(p, "utf8")); break; }
}
if (!raw) { console.error(`no file found in: ${candidates.join(", ")}`); process.exit(1); }

console.log(`File: ${filePath}`);
console.log(`Top-level keys: ${Object.keys(raw).join(", ")}`);
console.log(`Type of root: ${Array.isArray(raw) ? "array(len=" + raw.length + ")" : typeof raw}`);

// The METAR file format from fetch-metar-observations.mjs is:
// { station, date, observations: [{t, tempC, dewpointC, windKt, rawOb}], computedMax, computedMin }
// But other formats may exist. Discover the obs array dynamically.
let obs = null;
if (Array.isArray(raw)) obs = raw;
else if (Array.isArray(raw.observations)) obs = raw.observations;
else if (Array.isArray(raw.obs)) obs = raw.obs;
else if (Array.isArray(raw.data)) obs = raw.data;
else {
  // Last resort: walk one level deep for any array-of-objects with tempC
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "tempC" in v[0]) {
      obs = v;
      console.log(`(found obs array at key "${k}")`);
      break;
    }
  }
}
if (!obs) {
  console.error("Could not locate observations array. Dump of raw:");
  console.error(JSON.stringify(raw, null, 2).slice(0, 2000));
  process.exit(1);
}

console.log(`Observations: ${obs.length}`);
console.log(`computedMax: ${raw.computedMax ?? "(not set)"}`);
console.log(`computedMin: ${raw.computedMin ?? "(not set)"}`);

const valid = obs.filter(o => typeof o.tempC === "number");
const sorted = [...valid].sort((a, b) => b.tempC - a.tempC);

console.log(`\n=== TOP ${TOP} BY tempC ===`);
for (const o of sorted.slice(0, TOP)) {
  const iso = typeof o.t === "number" ? new Date(o.t * 1000).toISOString() : "(no t)";
  const dew = typeof o.dewpointC === "number" ? `dew=${o.dewpointC}` : "";
  const raw = o.rawOb ?? o.raw ?? "(no raw)";
  console.log(`${String(o.tempC).padStart(6)}°C  ${iso}  ${dew}`);
  console.log(`        raw: ${raw}`);
}

console.log(`\n=== ALL OBS IN CHRONOLOGICAL ORDER (tempC, raw) ===`);
const chrono = [...valid].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
for (const o of chrono) {
  const iso = typeof o.t === "number" ? new Date(o.t * 1000).toISOString() : "(no t)";
  console.log(`${iso}  ${String(o.tempC).padStart(5)}°C  ${o.rawOb ?? o.raw ?? ""}`);
}
