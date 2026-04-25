#!/usr/bin/env node
/**
 * No-lookahead backtest of the Wunderground "agreement guard" against
 * 937's 1,710 closed trades.
 *
 * For each closed trade taken at time T:
 *   1. Compute METAR running max as of T   (obs where t <= T only).
 *   2. Compute Wunderground running max as of T (obs where t_unix <= T only).
 *   3. Apply the guard: would we have entered, or would the guard have skipped?
 *   4. Score the decision against the trade's actual P&L.
 *
 * STRICT RULES:
 *   - No observation with t > openTs is ever read.
 *   - The trade outcome (pnlUsdc, exitPrice, redemptionWon, closeTs) is
 *     ONLY used to score the decision AFTER the guard has decided.
 *     It is NEVER an input to the guard.
 *   - The bucket value is parsed from the title at entry time (visible).
 *
 * GUARD VARIANTS (sweep all in one run):
 *   strict-min     : enter iff min(metar_max, wunder_max) > bucketHigh
 *                    (both sources must independently confirm bucket dead)
 *   delta-0.5      : enter unless metar_max - wunder_max >= 0.5 C
 *   delta-1.0      : enter unless metar_max - wunder_max >= 1.0 C
 *   wunder-only    : enter iff wunder_max > bucketHigh  (ignore METAR)
 *   metar-only     : enter iff metar_max > bucketHigh   (current bot behavior)
 *
 * Usage:
 *   node scripts/backtest-wunder-guard.mjs
 *   node scripts/backtest-wunder-guard.mjs --wallet=0x... --out=data/analysis/guard-backtest.json
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
const OUT = argv.out ?? `data/analysis/guard-backtest.json`;

const MONTHS = { January:1, February:2, March:3, April:4, May:5, June:6,
                 July:7, August:8, September:9, October:10, November:11, December:12 };

// ---- title parsing -------------------------------------------------------
const CITY_DATE_RE = /highest temperature in ([\w \-']+?)\s+be\s+.*?\s+on\s+([A-Za-z]+)\s+(\d{1,2})\??$/i;

// supported bucket forms:
//   "be 20°C on April 25"            → exact C, low=20 high=20
//   "be 20-21°C on April 25"         → range C, low=20 high=21
//   "be between 70-71°F on April 25" → range F, low=70 high=71
//   "be 9°C or higher on April 25"   → orHigher C, low=9 high=+inf
//   "be 70°F or higher on April 25"  → orHigher F
//   "be 9°C or below on April 25"    → orBelow (rare)
function parseBucket(title) {
  let m;
  // C ranges and exacts
  m = /be\s+(\d+)\s*°C\s+or\s+higher/i.exec(title);
  if (m) return { unit: "C", low: +m[1], high: +Infinity, kind: "orHigher" };
  m = /be\s+(\d+)\s*°C\s+or\s+below/i.exec(title);
  if (m) return { unit: "C", low: -Infinity, high: +m[1], kind: "orBelow" };
  m = /be\s+(?:between\s+)?(\d+)\s*-\s*(\d+)\s*°C/i.exec(title);
  if (m) return { unit: "C", low: +m[1], high: +m[2], kind: "range" };
  m = /be\s+(\d+)\s*°C\s+on/i.exec(title);
  if (m) return { unit: "C", low: +m[1], high: +m[1], kind: "exact" };
  // F ranges and exacts
  m = /be\s+(\d+)\s*°F\s+or\s+higher/i.exec(title);
  if (m) return { unit: "F", low: +m[1], high: +Infinity, kind: "orHigher" };
  m = /be\s+(?:between\s+)?(\d+)\s*-\s*(\d+)\s*°F/i.exec(title);
  if (m) return { unit: "F", low: +m[1], high: +m[2], kind: "range" };
  m = /be\s+(\d+)\s*°F\s+on/i.exec(title);
  if (m) return { unit: "F", low: +m[1], high: +m[1], kind: "exact" };
  return null;
}

function parseCityDate(title) {
  const m = CITY_DATE_RE.exec(title);
  if (!m) return null;
  const city = m[1].trim();
  const month = MONTHS[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()];
  if (!month) return null;
  return { city, date: `2026-${String(month).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}` };
}

// ---- file loaders --------------------------------------------------------
const stations = JSON.parse(await fs.readFile("data/metar-stations.json", "utf8"));
const metarCache = new Map();
const wuCache = new Map();

async function loadMetar(icao, date) {
  const k = `${icao}|${date}`;
  if (metarCache.has(k)) return metarCache.get(k);
  let v = null;
  for (const dir of ["data/metar-observations", "data/metar-history"]) {
    const p = path.resolve(`${dir}/${icao}__${date}.json`);
    if (existsSync(p)) { v = JSON.parse(await fs.readFile(p, "utf8")); break; }
  }
  metarCache.set(k, v);
  return v;
}

async function loadWu(icao, date) {
  const k = `${icao}|${date}`;
  if (wuCache.has(k)) return wuCache.get(k);
  const p = path.resolve(`data/wunderground-history/${icao}__${date}.json`);
  const v = existsSync(p) ? JSON.parse(await fs.readFile(p, "utf8")) : null;
  wuCache.set(k, v);
  return v;
}

// ---- running-max computation (NO LOOKAHEAD) -----------------------------
function metarRunningMaxC(metar, openTs) {
  if (!metar) return null;
  let mx = -Infinity;
  for (const o of metar.observations || []) {
    if (typeof o.t !== "number" || typeof o.tempC !== "number") continue;
    if (o.t <= openTs) {
      if (o.tempC > mx) mx = o.tempC;
    }
  }
  return mx === -Infinity ? null : mx;
}

function wunderRunningMax(wu, openTs, unit) {
  if (!wu) return null;
  let mx = -Infinity;
  for (const o of wu.observations || []) {
    if (typeof o.t_unix !== "number") continue;
    if (o.t_unix > openTs) continue;          // <= NO LOOKAHEAD
    const v = unit === "F" ? o.tempF : o.tempC;
    if (typeof v !== "number") continue;
    if (v > mx) mx = v;
  }
  return mx === -Infinity ? null : mx;
}

// ---- guard variants ------------------------------------------------------
// All guards return true iff a NO entry should be ALLOWED.
// (For YES trades they pass through unchanged — too few to model.)
function metarMaxInUnit(metarMaxC, unit) {
  if (metarMaxC == null) return null;
  return unit === "F" ? metarMaxC * 9 / 5 + 32 : metarMaxC;
}

const GUARDS = {
  "metar-only":  ({metarMax, bucket}) => metarMax != null && metarMax > bucket.high,
  "wunder-only": ({wunderMax}, _, bucket) => wunderMax != null && wunderMax > bucket.high,
  "strict-min":  ({metarMax, wunderMax, bucket}) =>
                   metarMax != null && wunderMax != null &&
                   Math.min(metarMax, wunderMax) > bucket.high,
  "delta-0.5":   ({metarMax, wunderMax, bucket}) => {
                   if (metarMax == null) return false;
                   if (wunderMax == null) return false;
                   if (metarMax - wunderMax >= 0.5) return false;
                   return metarMax > bucket.high;
                 },
  "delta-1.0":   ({metarMax, wunderMax, bucket}) => {
                   if (metarMax == null) return false;
                   if (wunderMax == null) return false;
                   if (metarMax - wunderMax >= 1.0) return false;
                   return metarMax > bucket.high;
                 },
};

// Re-shape signature so guards take a single context object
function applyGuard(name, ctx) {
  switch (name) {
    case "metar-only":  return ctx.metarMaxInUnit != null && ctx.metarMaxInUnit > ctx.bucket.high;
    case "wunder-only": return ctx.wunderMax != null && ctx.wunderMax > ctx.bucket.high;
    case "strict-min":  return ctx.metarMaxInUnit != null && ctx.wunderMax != null &&
                               Math.min(ctx.metarMaxInUnit, ctx.wunderMax) > ctx.bucket.high;
    case "delta-0.5": {
      if (ctx.metarMaxInUnit == null || ctx.wunderMax == null) return false;
      if (ctx.metarMaxInUnit - ctx.wunderMax >= 0.5) return false;
      return ctx.metarMaxInUnit > ctx.bucket.high;
    }
    case "delta-1.0": {
      if (ctx.metarMaxInUnit == null || ctx.wunderMax == null) return false;
      if (ctx.metarMaxInUnit - ctx.wunderMax >= 1.0) return false;
      return ctx.metarMaxInUnit > ctx.bucket.high;
    }
    default: throw new Error(`unknown guard: ${name}`);
  }
}

// ---- main ----------------------------------------------------------------
async function main() {
  const tradesPath = `data/wallet-complete/${WALLET}/closed-trades.jsonl`;
  if (!existsSync(tradesPath)) throw new Error(`no trades file: ${tradesPath}`);

  const lines = (await fs.readFile(tradesPath, "utf8")).split("\n").filter(Boolean);
  const trades = lines.map(l => JSON.parse(l));
  console.log(`Loaded ${trades.length} closed trades for ${WALLET}.`);

  const guardNames = ["metar-only", "wunder-only", "strict-min", "delta-0.5", "delta-1.0"];

  // Per-guard accumulators
  const stats = Object.fromEntries(guardNames.map(n => [n, {
    allowed: 0, blocked: 0,
    allowed_pnl: 0, blocked_pnl: 0,
    allowed_wins: 0, allowed_losses: 0, allowed_zero: 0,
    blocked_wins: 0, blocked_losses: 0, blocked_zero: 0,
    real_loss_blocked: 0, real_loss_allowed: 0,
  }]));
  const noData = { metarMissing: 0, wuMissing: 0, bothMissing: 0, parseFail: 0 };
  const perTrade = [];
  const realLosses = []; // pnl < -0.01

  for (const t of trades) {
    const cd = parseCityDate(t.title || "");
    const bucket = parseBucket(t.title || "");
    if (!cd || !bucket) { noData.parseFail++; continue; }

    const icao = stations[cd.city];
    if (!icao) { noData.parseFail++; continue; }

    const metar = await loadMetar(icao, cd.date);
    const wu = await loadWu(icao, cd.date);

    const metarMaxC = metarRunningMaxC(metar, t.openTs);
    const wunderMax = wunderRunningMax(wu, t.openTs, bucket.unit);
    const metarMaxInUnit = metarMaxInUnit_(metarMaxC, bucket.unit);

    if (metar == null && wu == null) noData.bothMissing++;
    else if (metar == null) noData.metarMissing++;
    else if (wu == null) noData.wuMissing++;

    const isRealLoss = t.pnlUsdc < -0.01;
    const pnl = t.pnlUsdc || 0;
    const ctx = { metarMaxInUnit, wunderMax, bucket };

    const traceRow = {
      city: cd.city, date: cd.date, icao, openTs: t.openTs,
      title: t.title, side: t.side, pnl: Math.round(pnl * 1000) / 1000,
      bucket, metarMaxC, metarMaxInUnit, wunderMax,
      decisions: {},
    };

    for (const g of guardNames) {
      const allowed = applyGuard(g, ctx);
      if (allowed) {
        stats[g].allowed++;
        stats[g].allowed_pnl += pnl;
        if (pnl > 0.01) stats[g].allowed_wins++;
        else if (pnl < -0.01) { stats[g].allowed_losses++; if (isRealLoss) stats[g].real_loss_allowed++; }
        else stats[g].allowed_zero++;
      } else {
        stats[g].blocked++;
        stats[g].blocked_pnl += pnl;
        if (pnl > 0.01) stats[g].blocked_wins++;
        else if (pnl < -0.01) { stats[g].blocked_losses++; if (isRealLoss) stats[g].real_loss_blocked++; }
        else stats[g].blocked_zero++;
      }
      traceRow.decisions[g] = allowed ? "ALLOW" : "BLOCK";
    }

    perTrade.push(traceRow);
    if (isRealLoss) realLosses.push(traceRow);
  }

  // Round PnL fields for printing
  for (const g of guardNames) {
    stats[g].allowed_pnl = Math.round(stats[g].allowed_pnl * 100) / 100;
    stats[g].blocked_pnl = Math.round(stats[g].blocked_pnl * 100) / 100;
  }

  const summary = {
    wallet: WALLET,
    closed_trades: trades.length,
    parsed: perTrade.length,
    no_data: noData,
    total_pnl: Math.round(perTrade.reduce((a, r) => a + r.pnl, 0) * 100) / 100,
    real_losses_count: realLosses.length,
    guards: stats,
  };

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n=== ALL REAL LOSSES (pnl < -$0.01) ===");
  for (const r of realLosses) {
    console.log(JSON.stringify({
      city: r.city, date: r.date, side: r.side, pnl: r.pnl,
      bucket: `${r.bucket.kind} ${r.bucket.low}-${r.bucket.high}°${r.bucket.unit}`,
      metarMaxC: r.metarMaxC, metarMaxInUnit: r.metarMaxInUnit, wunderMax: r.wunderMax,
      decisions: r.decisions, title: r.title,
    }));
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({ summary, real_losses: realLosses, per_trade: perTrade }, null, 2));
  console.log(`\nFull results written to ${OUT}`);
}

function metarMaxInUnit_(metarMaxC, unit) {
  if (metarMaxC == null) return null;
  return unit === "F" ? metarMaxC * 9 / 5 + 32 : metarMaxC;
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
