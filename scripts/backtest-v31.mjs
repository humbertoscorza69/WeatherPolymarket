#!/usr/bin/env node
/**
 * Backtest v31 selectivity rule (bucket_distance ∈ [0.5, 5]°C from observed
 * max) against 937's actual 1537 entries. Reports:
 *   - RECALL: what fraction of 937's entries would v31 have fired on?
 *   - OUT-OF-SCOPE: 937 entries v31 skips, with reasons
 *   - Win-rate & PnL within the v31-approved subset vs the rest
 *   - Per-band breakdown (distance histogram of approved vs rejected)
 *
 * This validates whether the distance-filter is the right rule BEFORE
 * we run the bot with real capital.
 */
import fs from "node:fs/promises";
import path from "node:path";

const JSONL = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");
const SUMMARY = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.summary.json");
const WX_DIR = path.resolve("data/weather-history");

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));
const MIN_DIST = Number(argv["min-dist"] ?? "0.5");
const MAX_DIST = Number(argv["max-dist"] ?? "5");

function parseTitle(title) {
  if (!title) return null;
  const t = title;
  let m;
  const cityMatch = t.match(/temperature in ([A-Z][A-Za-z .'-]+?) be /);
  if (!cityMatch) return null;
  const city = cityMatch[1].trim();
  const bucket = /highest/i.test(t) ? "highest" : (/lowest/i.test(t) ? "lowest" : null);
  let thrLo = null, thrHi = null, unit = null;
  if ((m = t.match(/be (\d+)-(\d+)\s*°?([CF])/))) {
    thrLo = Number(m[1]); thrHi = Number(m[2]); unit = m[3];
  } else if ((m = t.match(/be (above|over|below|under)\s*(\d+(?:\.\d+)?)\s*°?([CF])/i))) {
    thrLo = Number(m[2]); thrHi = thrLo; unit = m[3];
  } else if ((m = t.match(/be (\d+(?:\.\d+)?)\s*°?([CF])/))) {
    thrLo = Number(m[1]); thrHi = thrLo; unit = m[2];
  }
  let date = null;
  const iso = t.match(/on\s+(\d{4}-\d{2}-\d{2})/);
  const mon = t.match(/on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)(?:,\s*(\d{4}))?/i);
  if (iso) date = iso[1];
  else if (mon) {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const mi = months.findIndex(x => x.toLowerCase() === mon[1].toLowerCase());
    const y = mon[3] || "2026";
    date = `${y}-${String(mi+1).padStart(2,"0")}-${String(mon[2]).padStart(2,"0")}`;
  }
  return { city, date, bucket, thrLo, thrHi, unit };
}

function toC(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }

const _wxCache = new Map();
async function loadWeather(city, date) {
  const key = `${city}__${date}`;
  if (_wxCache.has(key)) return _wxCache.get(key);
  try {
    const raw = await fs.readFile(path.join(WX_DIR, `${key}.json`), "utf8");
    const wx = JSON.parse(raw);
    _wxCache.set(key, wx);
    return wx;
  } catch {
    _wxCache.set(key, null);
    return null;
  }
}

// Observed max temperature up to a given timestamp (mimics what the bot
// would have computed at entry time, not end-of-day).
function observedMaxUpTo(wx, tsSec) {
  if (!wx?.samples) return null;
  let maxC = -Infinity;
  for (const s of wx.samples) {
    if (s.t > tsSec) break;
    if (s.tempC > maxC) maxC = s.tempC;
  }
  return Number.isFinite(maxC) ? maxC : null;
}

function distanceCheck(bucketLoC, bucketHiC, obsMaxC) {
  if (obsMaxC == null) return { skip: true, reason: "no-obs" };
  const hi = bucketHiC ?? bucketLoC;
  let distance, relation;
  if (obsMaxC < bucketLoC)      { distance = bucketLoC - obsMaxC; relation = "above-max"; }
  else if (obsMaxC > hi)        { distance = obsMaxC - hi;        relation = "below-max"; }
  else                          { distance = 0; relation = "contains-max"; }
  if (relation === "contains-max") return { skip: true, reason: "contains-max", distance, relation };
  if (distance < MIN_DIST)         return { skip: true, reason: "too-close",    distance, relation };
  if (distance > MAX_DIST)         return { skip: true, reason: "too-far",      distance, relation };
  return { skip: false, reason: "pass", distance, relation };
}

async function main() {
  const trades = (await fs.readFile(JSONL, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const summary = JSON.parse(await fs.readFile(SUMMARY, "utf8"));
  const opens = summary.openPositions || [];
  const all = [...trades, ...opens].filter(e => e.title && e.openTs);

  console.log(`=== Backtest v31 distance rule vs 937's ${all.length} entries ===`);
  console.log(`Rule: bucket_distance ∈ [${MIN_DIST}°C, ${MAX_DIST}°C] from observed max at entry time\n`);

  const outcome = { pass: [], "too-close": [], "too-far": [], "contains-max": [], "no-obs": [], "no-wx": [], "parse-fail": [] };
  for (const e of all) {
    const p = parseTitle(e.title);
    if (!p || p.thrLo == null || !p.date) { outcome["parse-fail"].push(e); continue; }
    const wx = await loadWeather(p.city, p.date);
    if (!wx) { outcome["no-wx"].push(e); continue; }
    const obsMaxC = observedMaxUpTo(wx, e.openTs);
    const bucketLoC = toC(p.thrLo, p.unit);
    const bucketHiC = toC(p.thrHi ?? p.thrLo, p.unit);
    const r = distanceCheck(bucketLoC, bucketHiC, obsMaxC);
    const rec = { entry: e, parsed: p, obsMaxC, ...r };
    outcome[r.reason].push(rec);
  }

  const total = all.length;
  const annotated = total - outcome["parse-fail"].length - outcome["no-wx"].length;
  console.log(`=== Filter decisions (of ${total} entries, ${annotated} annotatable) ===`);
  for (const k of ["pass", "too-close", "too-far", "contains-max", "no-obs", "no-wx", "parse-fail"]) {
    const n = outcome[k].length;
    const pct = annotated ? (100 * n / annotated).toFixed(1) : "—";
    console.log(`  ${k.padEnd(14)} ${String(n).padStart(5)}  ${pct.padStart(5)}%`);
  }

  // Recall: of ANNOTATED entries where we could compute the rule, what % pass?
  const recallDenom = outcome.pass.length + outcome["too-close"].length + outcome["too-far"].length + outcome["contains-max"].length;
  const recall = recallDenom ? outcome.pass.length / recallDenom : 0;
  console.log(`\nRECALL: ${(100*recall).toFixed(1)}% (${outcome.pass.length} / ${recallDenom})`);
  console.log(`  ← fraction of 937's entries v31 would have fired on`);

  // Win/PnL comparison: pass vs too-close vs too-far
  console.log(`\n=== PnL & win-rate by filter outcome (closed trades only) ===`);
  for (const k of ["pass", "too-close", "too-far", "contains-max"]) {
    const closed = outcome[k].filter(r => r.entry.pnlUsdc != null);
    if (!closed.length) { console.log(`  ${k.padEnd(14)} no closed trades`); continue; }
    const wins = closed.filter(r => r.entry.pnlUsdc > 0.01).length;
    const losses = closed.filter(r => r.entry.pnlUsdc < -0.01).length;
    const wr = wins / closed.length;
    const totalPnl = closed.reduce((s, r) => s + (r.entry.pnlUsdc || 0), 0);
    const avgPnl = totalPnl / closed.length;
    console.log(`  ${k.padEnd(14)} n=${String(closed.length).padStart(4)}  W=${String(wins).padStart(3)}  L=${String(losses).padStart(2)}  WR=${(100*wr).toFixed(1).padStart(5)}%  totalPnl=$${totalPnl.toFixed(2).padStart(8)}  avg=$${avgPnl.toFixed(3)}`);
  }

  // Distance histogram of PASS vs REJECTED
  console.log(`\n=== Distance histogram (annotated entries) ===`);
  const edges = [0.5, 1, 1.5, 2, 3, 5, 8];
  for (const k of ["pass", "too-close", "too-far"]) {
    const counts = new Array(edges.length + 1).fill(0);
    for (const r of outcome[k]) {
      if (r.distance == null) continue;
      let i = edges.findIndex(e => r.distance < e);
      if (i === -1) i = edges.length;
      counts[i]++;
    }
    console.log(`  ${k}:`);
    for (let i = 0; i < counts.length; i++) {
      const lo = i === 0 ? "-∞" : edges[i-1].toString();
      const hi = i === edges.length ? "+∞" : edges[i].toString();
      if (!counts[i]) continue;
      console.log(`    ${lo.padStart(5)}–${hi.padEnd(5)} °C    ${counts[i]}`);
    }
  }

  // Sample too-close and too-far trades for inspection
  console.log(`\n=== Sample rejected trades ===`);
  for (const k of ["too-close", "too-far", "contains-max"]) {
    const sub = outcome[k].slice(0, 5);
    if (!sub.length) continue;
    console.log(`\n  ${k}:`);
    for (const r of sub) {
      const p = r.parsed;
      const pnl = r.entry.pnlUsdc;
      const sideAndPrice = `${r.entry.side} @ ${Number(r.entry.entryAvg).toFixed(4)}`;
      const pnlStr = pnl != null ? `pnl $${pnl.toFixed(2)}` : "[open]";
      console.log(`    ${p.city.padEnd(16)} ${p.date}  bucket [${p.thrLo}-${p.thrHi ?? p.thrLo}°${p.unit}] obs=${r.obsMaxC?.toFixed(1)}°C dist=${r.distance?.toFixed(2)}°C  ${sideAndPrice}  ${pnlStr}`);
    }
  }

  // Estimate v31 PnL vs 937's actual PnL, if we'd only taken the "pass" set
  const passClosed = outcome.pass.filter(r => r.entry.pnlUsdc != null);
  const v31Pnl = passClosed.reduce((s, r) => s + r.entry.pnlUsdc, 0);
  const allClosed = all.filter(e => e.pnlUsdc != null);
  const actualPnl = allClosed.reduce((s, e) => s + e.pnlUsdc, 0);
  console.log(`\n=== PnL projection ===`);
  console.log(`  937 actual PnL (all closed):      $${actualPnl.toFixed(2)} over ${allClosed.length} trades`);
  console.log(`  v31 would have captured:          $${v31Pnl.toFixed(2)} over ${passClosed.length} trades`);
  console.log(`  v31 capture rate:                 ${actualPnl ? (100*v31Pnl/actualPnl).toFixed(1) : "—"}% of 937's PnL`);
  console.log(`  v31 trade count ratio:            ${(100 * passClosed.length / allClosed.length).toFixed(1)}% of 937's volume`);
}

main().catch(e => { console.error(e); process.exit(1); });
