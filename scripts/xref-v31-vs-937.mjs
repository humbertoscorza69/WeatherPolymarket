#!/usr/bin/env node
/**
 * Full cross-reference of v31 strategy vs 937's actual behavior, using
 * all three local data sources:
 *
 *   data/wallet-trades/0x937...jsonl    937's entries + closed trades
 *   data/tick-history/<conditionId>.jsonl  full trade tape per market
 *   data/weather-history/<city>__<date>.json  hourly temperature samples
 *
 * For each 937 closed trade, this script:
 *   1. Parses title → (city, date, thresholds)
 *   2. Loads weather, computes observed max at 937's entry timestamp
 *   3. Applies v31 entry filter (distance 0.5-5°C, HIGHEST+between, ask in range)
 *   4. If v31 would enter → simulates v31's exit using the tick tape:
 *      - first BUY tick on our token at price ≥ 0.999 within 60 min
 *        → our 0.999 profit-take fills (PATH 0)
 *      - else nearest tick at 60-min boundary → taker cut (PATH 3)
 *   5. Compares our simulated outcome to 937's actual outcome (WR, hold time)
 *
 * Report:
 *   - RECALL: % of 937's trades v31 would enter
 *   - WR match: do our simulated exits produce 937's ~99.5% WR?
 *   - Hold-time match: are our exits as fast as 937's?
 *   - Divergence cases
 *
 * Usage:
 *   node scripts/xref-v31-vs-937.mjs
 *   node scripts/xref-v31-vs-937.mjs --min-dist=0.3 --max-dist=6   # tune
 *   node scripts/xref-v31-vs-937.mjs --sell-target=0.998           # tune exit
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const TRADES_FILE = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");
const SUMMARY_FILE = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.summary.json");
const WX_DIR = path.resolve("data/weather-history");
const TICK_DIR = path.resolve("data/tick-history");

const MIN_DIST     = Number(argv["min-dist"]    ?? "0.1");
const MAX_DIST     = Number(argv["max-dist"]    ?? "5");
const MIN_ASK      = Number(argv["min-ask"]     ?? "0.80");
const MAX_ASK      = Number(argv["max-ask"]     ?? "0.999");
const SELL_TARGET  = Number(argv["sell-target"] ?? "0.999");
const MAX_HOLD_MIN = Number(argv["max-hold"]    ?? "60");
const MIN_TTR_H    = Number(argv["min-ttr"]     ?? "0.1");   // 6 min
const MAX_TTR_H    = Number(argv["max-ttr"]     ?? "4");     // 4 hours

function parseTitle(title) {
  if (!title) return null;
  let m;
  const cityMatch = title.match(/temperature in ([A-Z][A-Za-z .'-]+?) be /);
  if (!cityMatch) return null;
  const city = cityMatch[1].trim();
  let thrLo = null, thrHi = null, unit = null;
  if ((m = title.match(/be (\d+)-(\d+)\s*°?([CF])/))) {
    thrLo = Number(m[1]); thrHi = Number(m[2]); unit = m[3];
  } else if ((m = title.match(/be (above|over|below|under)\s*(\d+(?:\.\d+)?)\s*°?([CF])/i))) {
    thrLo = Number(m[2]); thrHi = thrLo; unit = m[3];
  } else if ((m = title.match(/be (\d+(?:\.\d+)?)\s*°?([CF])/))) {
    thrLo = Number(m[1]); thrHi = thrLo; unit = m[2];
  }
  let date = null;
  const iso = title.match(/on\s+(\d{4}-\d{2}-\d{2})/);
  const mon = title.match(/on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)(?:,\s*(\d{4}))?/i);
  if (iso) date = iso[1];
  else if (mon) {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const mi = months.findIndex(x => x.toLowerCase() === mon[1].toLowerCase());
    const y = mon[3] || "2026";
    date = `${y}-${String(mi+1).padStart(2,"0")}-${String(mon[2]).padStart(2,"0")}`;
  }
  return { city, date, thrLo, thrHi, unit };
}

function toC(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }

const _wxCache = new Map();
async function loadWeather(city, date) {
  const key = `${city}__${date}`;
  if (_wxCache.has(key)) return _wxCache.get(key);
  try {
    const wx = JSON.parse(await fs.readFile(path.join(WX_DIR, `${key}.json`), "utf8"));
    _wxCache.set(key, wx);
    return wx;
  } catch { _wxCache.set(key, null); return null; }
}
function observedMaxUpTo(wx, tsSec) {
  if (!wx?.samples) return null;
  let m = -Infinity;
  for (const s of wx.samples) {
    if (s.t > tsSec) break;
    if (s.tempC > m) m = s.tempC;
  }
  return Number.isFinite(m) ? m : null;
}

const _tickCache = new Map();
async function loadTicks(conditionId) {
  if (_tickCache.has(conditionId)) return _tickCache.get(conditionId);
  const file = path.join(TICK_DIR, `${conditionId}.jsonl`);
  if (!existsSync(file)) { _tickCache.set(conditionId, null); return null; }
  try {
    const raw = await fs.readFile(file, "utf8");
    const ticks = raw.trim().split("\n").map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    ticks.sort((a, b) => a.timestamp - b.timestamp);
    _tickCache.set(conditionId, ticks);
    return ticks;
  } catch { _tickCache.set(conditionId, null); return null; }
}

// Simulate v31's exit for a 937 entry: find the first tick on our TOKEN
// (by asset id) where a BUY at price ≥ SELL_TARGET would have filled our
// resting sell. If none within MAX_HOLD_MIN, exit at the last observed
// tick price (taker cut).
function simulateExit(ticks, entry, sellTarget, maxHoldMin) {
  if (!ticks) return null;
  const startTs = entry.openTs;
  const cutoffTs = startTs + maxHoldMin * 60;
  // Our SELL at 0.999 on our token fills when some TAKER BUYS at ≥ 0.999.
  // A BUY tick at price ≥ sellTarget post-entry = our fill.
  let firstFill = null;
  let lastTickBefore = null;
  for (const t of ticks) {
    if (String(t.asset) !== String(entry.asset)) continue;  // our token only
    if (t.timestamp <= startTs) continue;                   // must be after entry
    if (t.timestamp > cutoffTs) break;                      // max-hold boundary
    lastTickBefore = t;
    if (t.side === "BUY" && t.price >= sellTarget) {
      firstFill = t;
      break;
    }
  }
  if (firstFill) {
    return {
      status: "profit-take",
      exitPrice: sellTarget,
      exitTs: firstFill.timestamp,
      holdMin: (firstFill.timestamp - startTs) / 60,
    };
  }
  // Max-hold cut — use the last tick we saw before the cutoff, mid-approximated
  if (lastTickBefore) {
    return {
      status: "scalp-maxhold",
      exitPrice: lastTickBefore.price,
      exitTs: cutoffTs,
      holdMin: maxHoldMin,
    };
  }
  // Zero market activity during hold window — exit at entry price (flat)
  return { status: "no-activity", exitPrice: entry.entryAvg, exitTs: cutoffTs, holdMin: maxHoldMin };
}

async function main() {
  console.log(`=== v31 cross-reference against 937's actual trades ===`);
  console.log(`Rule: distance ∈ [${MIN_DIST},${MAX_DIST}]°C · ask ∈ [${MIN_ASK},${MAX_ASK}] · TTR ∈ [${MIN_TTR_H},${MAX_TTR_H}]h · exit @ ${SELL_TARGET} · max-hold ${MAX_HOLD_MIN}min\n`);

  const trades = (await fs.readFile(TRADES_FILE, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const summary = JSON.parse(await fs.readFile(SUMMARY_FILE, "utf8"));
  const closed = trades.filter(t => t.pnlUsdc != null);     // only closed (to compare WR vs actual)
  console.log(`937 closed trades: ${closed.length}`);

  const reasons = { pass:[], skip_noWx:[], skip_titleFail:[], skip_distTooClose:[], skip_distTooFar:[], skip_distContains:[], skip_askRange:[], skip_noTicks:[], skip_ttrTooClose:[], skip_ttrTooFar:[] };
  let totalAnnotatable = 0;

  for (const entry of closed) {
    const p = parseTitle(entry.title);
    if (!p || p.thrLo == null || !p.date) { reasons.skip_titleFail.push({ entry }); continue; }
    totalAnnotatable++;
    // Entry-price filter (ask range) — use 937's actual entry price as proxy for the ask they paid
    const ask = entry.entryAvg;
    if (!(ask >= MIN_ASK && ask <= MAX_ASK)) { reasons.skip_askRange.push({ entry, parsed: p, ask }); continue; }
    // Distance filter
    const wx = await loadWeather(p.city, p.date);
    if (!wx) { reasons.skip_noWx.push({ entry, parsed: p }); continue; }
    const obsMax = observedMaxUpTo(wx, entry.openTs);
    if (obsMax == null) { reasons.skip_noWx.push({ entry, parsed: p }); continue; }
    const bucketLoC = toC(p.thrLo, p.unit);
    const bucketHiC = toC(p.thrHi ?? p.thrLo, p.unit);
    let distance, relation;
    if (obsMax < bucketLoC)      { distance = bucketLoC - obsMax; relation = "above-max"; }
    else if (obsMax > bucketHiC) { distance = obsMax - bucketHiC; relation = "below-max"; }
    else                         { distance = 0; relation = "contains-max"; }
    if (relation === "contains-max") { reasons.skip_distContains.push({ entry, parsed: p, obsMax, distance }); continue; }
    if (distance < MIN_DIST)         { reasons.skip_distTooClose.push({ entry, parsed: p, obsMax, distance }); continue; }
    if (distance > MAX_DIST)         { reasons.skip_distTooFar.push({ entry, parsed: p, obsMax, distance }); continue; }
    // v31 accepts on distance — now simulate the exit using tick data
    const ticks = await loadTicks(entry.conditionId);
    if (!ticks) { reasons.skip_noTicks.push({ entry, parsed: p, obsMax, distance, relation }); continue; }
    // TTR check: use last tick timestamp as resolution proxy
    const endTs = ticks.reduce((m, t) => t.timestamp > m ? t.timestamp : m, 0);
    const ttrH = endTs ? (endTs - entry.openTs) / 3600 : null;
    if (ttrH != null && ttrH < MIN_TTR_H) { reasons.skip_ttrTooClose.push({ entry, parsed: p, ttrH }); continue; }
    if (ttrH != null && ttrH > MAX_TTR_H) { reasons.skip_ttrTooFar.push({ entry, parsed: p, ttrH }); continue; }
    const exit = simulateExit(ticks, entry, SELL_TARGET, MAX_HOLD_MIN);
    const simPnl = entry.shares * (exit.exitPrice - entry.entryAvg);
    reasons.pass.push({
      entry, parsed: p, obsMax, distance, relation,
      sim: exit, simPnl,
      actualPnl: entry.pnlUsdc, actualHoldMin: entry.holdMinutes,
    });
  }

  // ======== Report ========
  const annot = totalAnnotatable;
  console.log(`=== Filter outcome (closed trades, ${annot} annotatable) ===`);
  const rowNames = ["pass", "skip_distTooClose", "skip_distTooFar", "skip_distContains", "skip_askRange", "skip_ttrTooClose", "skip_ttrTooFar", "skip_noWx", "skip_noTicks", "skip_titleFail"];
  for (const r of rowNames) {
    const n = reasons[r].length;
    const pct = annot ? (100 * n / annot).toFixed(1) : "—";
    console.log(`  ${r.padEnd(22)} ${String(n).padStart(5)}  ${pct.padStart(5)}%`);
  }

  // WR on the PASS set — simulated vs actual
  const passed = reasons.pass;
  const simWins = passed.filter(r => r.simPnl > 0.01).length;
  const simLosses = passed.filter(r => r.simPnl < -0.01).length;
  const simBreak = passed.length - simWins - simLosses;
  const simTotalPnl = passed.reduce((s, r) => s + r.simPnl, 0);
  const actualWins = passed.filter(r => r.actualPnl > 0.01).length;
  const actualLosses = passed.filter(r => r.actualPnl < -0.01).length;
  const actualTotalPnl = passed.reduce((s, r) => s + r.actualPnl, 0);
  console.log(`\n=== WIN RATE comparison (v31 sim vs 937 actual, n=${passed.length} matched) ===`);
  console.log(`                    Simulated        Actual 937`);
  console.log(`  wins            ${String(simWins).padStart(8)}  ${String(actualWins).padStart(18)}`);
  console.log(`  losses          ${String(simLosses).padStart(8)}  ${String(actualLosses).padStart(18)}`);
  console.log(`  break-even      ${String(simBreak).padStart(8)}  ${String(passed.length - actualWins - actualLosses).padStart(18)}`);
  console.log(`  WR (win-only)   ${(100*simWins/passed.length).toFixed(1).padStart(7)}%  ${(100*actualWins/passed.length).toFixed(1).padStart(17)}%`);
  console.log(`  WR (non-loss)   ${(100*(simWins+simBreak)/passed.length).toFixed(1).padStart(7)}%  ${(100*(passed.length-actualLosses)/passed.length).toFixed(1).padStart(17)}%`);
  console.log(`  total PnL       $${simTotalPnl.toFixed(2).padStart(8)}   $${actualTotalPnl.toFixed(2).padStart(16)}`);
  console.log(`  avg PnL/trade   $${(simTotalPnl/passed.length).toFixed(3).padStart(8)}   $${(actualTotalPnl/passed.length).toFixed(3).padStart(16)}`);

  // Hold-time match
  const simHolds = passed.map(r => r.sim.holdMin).sort((a,b)=>a-b);
  const actualHolds = passed.map(r => r.actualHoldMin).filter(x => Number.isFinite(x)).sort((a,b)=>a-b);
  const pct = (arr, q) => arr.length ? arr[Math.min(arr.length-1, Math.floor(q*arr.length/100))] : 0;
  console.log(`\n=== Hold time (minutes) ===`);
  console.log(`                  p10       p50       p90`);
  console.log(`  v31 sim      ${pct(simHolds,10).toFixed(1).padStart(6)}    ${pct(simHolds,50).toFixed(1).padStart(6)}    ${pct(simHolds,90).toFixed(1).padStart(6)}`);
  console.log(`  937 actual   ${pct(actualHolds,10).toFixed(1).padStart(6)}    ${pct(actualHolds,50).toFixed(1).padStart(6)}    ${pct(actualHolds,90).toFixed(1).padStart(6)}`);

  // Exit status distribution
  const statusCounts = {};
  for (const r of passed) statusCounts[r.sim.status] = (statusCounts[r.sim.status] || 0) + 1;
  console.log(`\n=== v31 simulated exit status ===`);
  for (const [k, v] of Object.entries(statusCounts).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k.padEnd(18)} ${v}  (${(100*v/passed.length).toFixed(1)}%)`);
  }

  // Divergence analysis: cases where sim disagrees with actual on W/L
  const divergent = passed.filter(r => (r.simPnl > 0.01) !== (r.actualPnl > 0.01));
  console.log(`\n=== Divergent outcomes (sim vs actual disagree on win/loss): ${divergent.length} cases ===`);
  for (const r of divergent.slice(0, 8)) {
    console.log(`  ${r.parsed.city.padEnd(16)} ${r.parsed.date}  bucket=[${r.parsed.thrLo}-${r.parsed.thrHi ?? r.parsed.thrLo}°${r.parsed.unit}] entry=${r.entry.side}/${Number(r.entry.entryAvg).toFixed(4)}`);
    console.log(`    actual: exit=${Number(r.entry.exitPrice || 0).toFixed(4)} pnl=$${r.actualPnl.toFixed(2)} hold=${Number(r.actualHoldMin).toFixed(1)}min`);
    console.log(`    sim:    exit=${r.sim.exitPrice.toFixed(4)} pnl=$${r.simPnl.toFixed(2)} hold=${r.sim.holdMin.toFixed(1)}min  (${r.sim.status})`);
  }

  // Headline for the user
  console.log(`\n=== HEADLINE ===`);
  const simWR_nonloss = (simWins + simBreak) / passed.length;
  const actualWR_nonloss = (passed.length - actualLosses) / passed.length;
  console.log(`  v31 captures ${passed.length} of ${closed.length} trades (${(100*passed.length/closed.length).toFixed(1)}% recall).`);
  console.log(`  v31 sim non-loss rate: ${(100*simWR_nonloss).toFixed(2)}%   937 actual non-loss rate: ${(100*actualWR_nonloss).toFixed(2)}%`);
  console.log(`  Delta: ${((100*simWR_nonloss) - (100*actualWR_nonloss)).toFixed(2)}pp`);
  console.log(`  v31 total PnL: $${simTotalPnl.toFixed(2)}   937 actual PnL on same trades: $${actualTotalPnl.toFixed(2)}`);
  if (reasons.skip_noTicks.length) {
    console.log(`  (${reasons.skip_noTicks.length} trades skipped — no tick file for that conditionId in data/tick-history/)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
