#!/usr/bin/env node
/**
 * Build a matched-pair feature dataset for 900e's entry selection.
 *
 * For each 900e entry (closed + open), we look up all the OTHER
 * HIGHEST-temperature markets in the same (city, date) group and snapshot
 * every market's state at 900e's entry timestamp. Label = 1 for the market
 * 900e chose at that ts, 0 for siblings they did NOT pick.
 *
 * This produces a "why this bucket and not the others at the same moment?"
 * dataset — the cleanest way to isolate 900e's selection rule from
 * confounders like city-of-day or seasonal bias.
 *
 * Strict no-lookahead:
 *   - weather samples gated at t <= snapshotTs
 *   - tick features only use ticks with timestamp < snapshotTs
 *   - future outcomes never leak into features
 *
 * Inputs:
 *   data/analysis/universe-markets.jsonl    (from build-universe.mjs)
 *   data/wallet-trades/0x900e*.jsonl        (closed trades)
 *   data/wallet-trades/0x900e*.summary.json (open positions)
 *   data/tick-history/<conditionId>.jsonl
 *   data/weather-history/<City>__<Date>.json
 *
 * Output:
 *   data/analysis/features-900e.csv
 *   data/analysis/features-900e-report.txt
 *
 * Usage:  node scripts/analysis/extract-features.mjs
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ADDR = "0x900e2ba4b715e8e5088899948355d74c796ff6bf";
const UNIVERSE = path.resolve("data/analysis/universe-markets.jsonl");
const TRADES = path.resolve(`data/wallet-trades/${ADDR}.jsonl`);
const SUMMARY = path.resolve(`data/wallet-trades/${ADDR}.summary.json`);
const TICK_DIR = path.resolve("data/tick-history");
const WX_DIR = path.resolve("data/weather-history");
const OUT = path.resolve("data/analysis/features-900e.csv");
const REPORT = path.resolve("data/analysis/features-900e-report.txt");

// Local end-of-day (23:59:59 in the city's tz) expressed as UTC seconds.
// We need wx.tz to do this right; fallback to UTC if missing.
function endOfDayUtc(date, tz) {
  if (!tz) return Math.floor(new Date(`${date}T23:59:59Z`).getTime() / 1000);
  // Use Intl to find the UTC offset at the date's noon in that tz, then
  // back out the end-of-day in UTC.
  try {
    const noonUtc = new Date(`${date}T12:00:00Z`).getTime();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(new Date(noonUtc));
    const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const localAsUtcMs = Date.UTC(+obj.year, +obj.month - 1, +obj.day, +obj.hour, +obj.minute, +obj.second);
    const offsetMs = localAsUtcMs - noonUtc;          // tz offset in ms
    const eodLocal = new Date(`${date}T23:59:59Z`).getTime();  // "local" midnight in naive UTC
    return Math.floor((eodLocal - offsetMs) / 1000);
  } catch {
    return Math.floor(new Date(`${date}T23:59:59Z`).getTime() / 1000);
  }
}

// NO-LOOKAHEAD: max tempC for samples with t <= cutoff
function observedMaxUpTo(samples, cutoff) {
  let maxC = -Infinity, maxTs = null;
  for (const s of samples) {
    if (s.t > cutoff) break;
    if (s.tempC > maxC) { maxC = s.tempC; maxTs = s.t; }
  }
  return { maxC: Number.isFinite(maxC) ? maxC : null, maxTs };
}

function currentTempAt(samples, cutoff) {
  let last = null;
  for (const s of samples) {
    if (s.t > cutoff) break;
    last = s;
  }
  return last;
}

// NO-LOOKAHEAD: last tick with timestamp < cutoff, per outcomeIndex.
function lastTickBefore(ticks, cutoff, outcomeIdx) {
  let last = null;
  for (const t of ticks) {
    if (t.timestamp >= cutoff) break;
    if (t.outcomeIndex === outcomeIdx) last = t;
  }
  return last;
}

function countTicksInWindow(ticks, cutoff, windowSec, outcomeIdx) {
  const lo = cutoff - windowSec;
  let n = 0;
  for (const t of ticks) {
    if (t.timestamp >= cutoff) break;
    if (t.timestamp < lo) continue;
    if (outcomeIdx != null && t.outcomeIndex !== outcomeIdx) continue;
    n++;
  }
  return n;
}

async function main() {
  const t0 = Date.now();

  // Load universe
  const universe = (await fs.readFile(UNIVERSE, "utf8"))
    .trim().split("\n").map(l => JSON.parse(l));
  const byGroup = new Map();  // "city|date" -> [markets]
  const byConditionId = new Map();
  for (const m of universe) {
    const key = `${m.city}|${m.date}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(m);
    byConditionId.set(m.conditionId, m);
  }
  console.log(`universe: ${universe.length} markets · ${byGroup.size} city-date groups`);

  // Load 900e entries (closed + open)
  const closedRaw = await fs.readFile(TRADES, "utf8");
  const closed = closedRaw.trim().split("\n").map(l => JSON.parse(l));
  const summary = JSON.parse(await fs.readFile(SUMMARY, "utf8"));
  const opens = summary.openPositions || [];
  const entries = [...closed.map(t => ({ ...t, _type: "closed" })), ...opens.map(t => ({ ...t, _type: "open" }))]
    .filter(e => e.openTs && e.conditionId);
  console.log(`900e entries: ${entries.length} (${closed.length} closed, ${opens.length} open)`);

  // Group 900e entries by (city, date) using the universe's city/date when we can.
  // Dedupe on (openTs, conditionId): a position that was partly-closed and
  // partly-open produces two events with identical openTs — collapse to one.
  const entriesByGroup = new Map();
  let entriesSkipNoUniverse = 0;
  const seen = new Set();
  for (const e of entries) {
    const m = byConditionId.get(e.conditionId);
    if (!m) { entriesSkipNoUniverse++; continue; }
    const dedupKey = `${e.openTs}|${e.conditionId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const key = `${m.city}|${m.date}`;
    if (!entriesByGroup.has(key)) entriesByGroup.set(key, []);
    entriesByGroup.get(key).push({ ...e, _city: m.city, _date: m.date });
  }
  console.log(`900e groups to process: ${entriesByGroup.size}   (${entriesSkipNoUniverse} entries skipped: conditionId not in universe, ${entries.length - seen.size - entriesSkipNoUniverse} deduped)`);

  // Process each group
  const rows = [];
  const tickCache = new Map();       // conditionId -> ticks
  const wxCache = new Map();         // city|date -> weather
  let groupsNoWeather = 0, snapshotsMade = 0, marketsSnapped = 0;

  async function loadTicks(conditionId) {
    if (tickCache.has(conditionId)) return tickCache.get(conditionId);
    const f = path.join(TICK_DIR, `${conditionId}.jsonl`);
    if (!existsSync(f)) { tickCache.set(conditionId, null); return null; }
    try {
      const raw = await fs.readFile(f, "utf8");
      const ticks = raw.trim().split("\n").map(l => JSON.parse(l));
      ticks.sort((a, b) => a.timestamp - b.timestamp);
      tickCache.set(conditionId, ticks);
      return ticks;
    } catch { tickCache.set(conditionId, null); return null; }
  }

  async function loadWx(city, date) {
    const key = `${city}|${date}`;
    if (wxCache.has(key)) return wxCache.get(key);
    const f = path.join(WX_DIR, `${city}__${date}.json`);
    if (!existsSync(f)) { wxCache.set(key, null); return null; }
    try {
      const raw = await fs.readFile(f, "utf8");
      const wx = JSON.parse(raw);
      wxCache.set(key, wx);
      return wx;
    } catch { wxCache.set(key, null); return null; }
  }

  let idx = 0;
  for (const [groupKey, groupEntries] of entriesByGroup) {
    idx++;
    if (idx % 50 === 0) process.stdout.write(`  group ${idx}/${entriesByGroup.size}  rows so far: ${rows.length}\n`);
    const [city, date] = groupKey.split("|");
    const wx = await loadWx(city, date);
    if (!wx) { groupsNoWeather++; continue; }
    const markets = byGroup.get(groupKey);
    const eodUtc = endOfDayUtc(date, wx.tz);

    // Each 900e entry is one snapshot. At that snapshot we compute features
    // for EVERY market in the group (including the one they entered).
    for (const snap of groupEntries) {
      const ts = snap.openTs;
      const { maxC: obsMaxC, maxTs: obsMaxTs } = observedMaxUpTo(wx.samples, ts);
      if (obsMaxC == null) continue;
      const currSample = currentTempAt(wx.samples, ts);
      const ttrH = (eodUtc - ts) / 3600;
      const obsMaxAgeH = obsMaxTs ? (ts - obsMaxTs) / 3600 : null;

      snapshotsMade++;
      for (const m of markets) {
        const ticks = await loadTicks(m.conditionId);
        const yesTick = ticks ? lastTickBefore(ticks, ts, 0) : null;
        const noTick  = ticks ? lastTickBefore(ticks, ts, 1) : null;
        const n1h = ticks ? countTicksInWindow(ticks, ts, 3600, null) : 0;
        const nTot = ticks ? ticks.filter(t => t.timestamp < ts).length : 0;

        // Bucket position vs obs_max
        const bLoC = m.bucketLoC == null ? -Infinity : m.bucketLoC;
        const bHiC = m.bucketHiC == null ? Infinity  : m.bucketHiC;
        let bucketRel, signedDistC;
        if (obsMaxC < bLoC)      { bucketRel = "below_obs"; signedDistC = bLoC - obsMaxC; }   // bucket above observed (+)
        else if (obsMaxC > bHiC) { bucketRel = "above_obs"; signedDistC = -(obsMaxC - bHiC); } // bucket below observed (-)
        else                     { bucketRel = "contains";  signedDistC = 0; }

        // Label
        const isLabel = m.conditionId === snap.conditionId ? 1 : 0;

        rows.push({
          snapshot_ts: ts,
          snapshot_dt: new Date(ts * 1000).toISOString(),
          city, date,
          condition_id: m.conditionId,
          bucket_kind: m.kind,
          bucket_lo_c: m.bucketLoC,
          bucket_hi_c: m.bucketHiC,
          obs_max_c: Number(obsMaxC.toFixed(2)),
          obs_max_age_h: obsMaxAgeH == null ? null : Number(obsMaxAgeH.toFixed(2)),
          current_temp_c: currSample ? Number(currSample.tempC.toFixed(2)) : null,
          ttr_h: Number(ttrH.toFixed(2)),
          bucket_rel: bucketRel,
          signed_dist_c: Number(signedDistC.toFixed(2)),
          abs_dist_c: Number(Math.abs(signedDistC).toFixed(2)),
          yes_price: yesTick ? yesTick.price : null,
          no_price: noTick ? noTick.price : null,
          yes_price_age_s: yesTick ? ts - yesTick.timestamp : null,
          no_price_age_s: noTick ? ts - noTick.timestamp : null,
          n_ticks_1h: n1h,
          n_ticks_total: nTot,
          group_size: markets.length,
          label: isLabel,
          entered_side: isLabel ? snap.side : null,
          entered_price: isLabel ? snap.entryAvg : null,
          entered_usdc: isLabel ? snap.entryUsdc : null,
          entered_pnl: isLabel ? (snap.pnlUsdc ?? null) : null,
          entry_type: isLabel ? snap._type : null,
        });
        marketsSnapped++;
      }
    }
  }

  // Rank by |signed_dist| within each snapshot (lower rank = closer to obs_max)
  const bySnap = new Map();
  for (const r of rows) {
    const k = `${r.snapshot_ts}|${r.city}|${r.date}`;
    if (!bySnap.has(k)) bySnap.set(k, []);
    bySnap.get(k).push(r);
  }
  for (const group of bySnap.values()) {
    const sortedByDist = [...group].sort((a, b) => a.abs_dist_c - b.abs_dist_c);
    sortedByDist.forEach((r, i) => r.rank_by_abs_dist = i + 1);
    const sortedByYes = [...group].filter(r => r.yes_price != null).sort((a, b) => a.yes_price - b.yes_price);
    sortedByYes.forEach((r, i) => r.rank_by_yes_price = i + 1);
    const sortedByNo = [...group].filter(r => r.no_price != null).sort((a, b) => a.no_price - b.no_price);
    sortedByNo.forEach((r, i) => r.rank_by_no_price = i + 1);
  }

  // Write CSV
  const cols = [
    "snapshot_ts","snapshot_dt","city","date","condition_id",
    "bucket_kind","bucket_lo_c","bucket_hi_c",
    "obs_max_c","obs_max_age_h","current_temp_c","ttr_h",
    "bucket_rel","signed_dist_c","abs_dist_c",
    "yes_price","no_price","yes_price_age_s","no_price_age_s",
    "n_ticks_1h","n_ticks_total","group_size",
    "rank_by_abs_dist","rank_by_yes_price","rank_by_no_price",
    "label","entered_side","entered_price","entered_usdc","entered_pnl","entry_type",
  ];
  const esc = (v) => {
    if (v == null) return "";
    if (typeof v === "number") return String(v);
    const s = String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [cols.join(",")];
  for (const r of rows) out.push(cols.map(c => esc(r[c])).join(","));
  await fs.writeFile(OUT, out.join("\n") + "\n");

  const nLabel1 = rows.filter(r => r.label === 1).length;
  const report = [];
  report.push(`=== extract-features report ===`);
  report.push(`groups processed:    ${entriesByGroup.size}`);
  report.push(`groups no-weather:   ${groupsNoWeather}`);
  report.push(`snapshots made:      ${snapshotsMade}`);
  report.push(`markets snapshotted: ${marketsSnapped}`);
  report.push(`total rows:          ${rows.length}`);
  report.push(`label=1 rows:        ${nLabel1}  (${(100*nLabel1/rows.length).toFixed(2)}%)`);
  report.push(`elapsed:             ${((Date.now()-t0)/1000).toFixed(1)}s`);
  report.push(`output:              ${OUT}`);
  const txt = report.join("\n");
  console.log("\n" + txt);
  await fs.writeFile(REPORT, txt + "\n");
}

main().catch(e => { console.error(e); process.exit(1); });
