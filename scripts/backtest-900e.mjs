#!/usr/bin/env node
/**
 * Backtest 900e's strategy against their own closed trades, with strict
 * no-look-ahead. For each 900e entry we:
 *
 *   1. Observe only the weather samples with t ≤ openTs
 *   2. Observe only the tick trades with timestamp < openTs
 *   3. Decide entry using ONLY those observables (no outcome, no end-of-day)
 *   4. Simulate forward exit using ticks with timestamp > openTs, applying
 *      configurable profit-take / stop-loss / timeout rules
 *   5. Compare simulated PnL to 900e's actual realized PnL
 *
 * Fails loud: any trade where our rule couldn't fire (feature missing, data
 * gap) is counted as "skipped" and reported, never silently dropped.
 *
 * Usage:
 *   node scripts/backtest-900e.mjs                 # default rule
 *   node scripts/backtest-900e.mjs --profit=0.95 --stop=0.30 --timeout=120
 *   node scripts/backtest-900e.mjs --train-pct=0.7 # chronological 70/30 split
 *
 * Invariants (grep "NO-LOOKAHEAD"):
 *   - weather window strictly uses t <= openTs
 *   - tick forward window strictly uses timestamp > openTs
 *   - exit decision only reads tick at index i (not i+k)
 *   - actual 900e exit price is never used in sim
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const ADDR = "0x900e2ba4b715e8e5088899948355d74c796ff6bf";
const TRADES = path.resolve(`data/wallet-trades/${ADDR}.jsonl`);
const SUMMARY = path.resolve(`data/wallet-trades/${ADDR}.summary.json`);
const TICK_DIR = path.resolve("data/tick-history");
const WX_DIR   = path.resolve("data/weather-history");

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

// Exit rule parameters — defaults drawn from 900e's empirical profile.
const PROFIT_TARGET = Number(argv.profit  ?? "0.95");   // exit at our-side >= 0.95
const STOP_FRAC     = Number(argv.stop    ?? "0.30");   // exit at our-side <= entry*(1-STOP)
const TIMEOUT_MIN   = Number(argv.timeout ?? "120");    // exit at +TIMEOUT min
const TRAIN_PCT     = Number(argv["train-pct"] ?? "1.0"); // 1.0 = no split

// Entry filter parameters — default: accept every 900e entry, filter later.
const NO_BAND  = [Number(argv["no-lo"]  ?? "0.00"), Number(argv["no-hi"]  ?? "1.00")];
const YES_BAND = [Number(argv["yes-lo"] ?? "0.00"), Number(argv["yes-hi"] ?? "1.00")];

function parseTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  const cityMatch = title.match(/in ([A-Z][A-Za-z .'-]+?) be /);
  const city = cityMatch ? cityMatch[1].trim() : null;
  let thrLo = null, thrHi = null, unit = null;
  let m;
  if ((m = t.match(/be (\d+)-(\d+)\s*°?([cf])/))) {
    thrLo = Number(m[1]); thrHi = Number(m[2]); unit = m[3].toUpperCase();
  } else if ((m = t.match(/be (above|over|below|under)\s*(\d+(?:\.\d+)?)\s*°?([cf])/))) {
    thrLo = Number(m[2]); thrHi = thrLo; unit = m[3].toUpperCase();
  } else if ((m = t.match(/be (\d+(?:\.\d+)?)\s*°?([cf])/))) {
    thrLo = Number(m[1]); thrHi = thrLo; unit = m[2].toUpperCase();
  }
  let bucket = null;
  if (/\bhighest temperature\b/.test(t)) bucket = "highest";
  else if (/\blowest temperature\b/.test(t)) bucket = "lowest";
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

const toC = (v, u) => u === "F" ? (v - 32) * 5/9 : v;

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

// NO-LOOKAHEAD: max observed tempC with sample.t <= cutoffTs
function observedMaxUpTo(wx, cutoffTs) {
  if (!wx?.samples) return null;
  let maxC = -Infinity;
  for (const s of wx.samples) {
    if (s.t > cutoffTs) break;  // samples are chronologically ordered
    if (s.tempC > maxC) maxC = s.tempC;
  }
  return Number.isFinite(maxC) ? maxC : null;
}

const _tickCache = new Map();
async function loadTicks(conditionId) {
  if (_tickCache.has(conditionId)) return _tickCache.get(conditionId);
  const file = path.join(TICK_DIR, `${conditionId}.jsonl`);
  if (!existsSync(file)) { _tickCache.set(conditionId, null); return null; }
  try {
    const raw = await fs.readFile(file, "utf8");
    const ticks = raw.trim().split("\n").map(l => JSON.parse(l));
    ticks.sort((a, b) => a.timestamp - b.timestamp);
    _tickCache.set(conditionId, ticks);
    return ticks;
  } catch {
    _tickCache.set(conditionId, null);
    return null;
  }
}

// NO-LOOKAHEAD: simulate forward exit. entryTs is exclusive — we only see
// ticks whose timestamp is strictly greater. Same side (our-side) ticks
// represent liquidity we could take.
function simulateExit(ticks, side, entryTs, entryPrice, shares) {
  const wantedIdx = side === "NO" ? 1 : 0;
  const forward = ticks.filter(t => t.timestamp > entryTs && t.outcomeIndex === wantedIdx);
  if (!forward.length) {
    return { reason: "no-ticks-after", exitPrice: null, exitTs: null, pnl: null };
  }
  const timeoutTs = entryTs + TIMEOUT_MIN * 60;
  const stopPrice = entryPrice * (1 - STOP_FRAC);
  for (const t of forward) {
    if (t.price >= PROFIT_TARGET) {
      return { reason: "profit-take", exitPrice: t.price, exitTs: t.timestamp, pnl: shares * (t.price - entryPrice) };
    }
    if (t.price <= stopPrice) {
      return { reason: "stop-loss", exitPrice: t.price, exitTs: t.timestamp, pnl: shares * (t.price - entryPrice) };
    }
    if (t.timestamp >= timeoutTs) {
      return { reason: "timeout", exitPrice: t.price, exitTs: t.timestamp, pnl: shares * (t.price - entryPrice) };
    }
  }
  // No exit rule triggered within the available forward tape — use last
  // tick seen (most honest approximation: this is how much we'd have if
  // the data ran out, not a peek at future prices).
  const last = forward[forward.length - 1];
  return { reason: "tape-ended", exitPrice: last.price, exitTs: last.timestamp, pnl: shares * (last.price - entryPrice) };
}

function entryRule(trade, parsed, obsMaxC) {
  const bucketLoC = toC(parsed.thrLo, parsed.unit);
  const bucketHiC = toC(parsed.thrHi ?? parsed.thrLo, parsed.unit);
  const price = trade.entryAvg;
  // Price-band gate (from 900e's profile bands that had ≥95% WR and +PnL)
  if (trade.side === "NO"  && (price < NO_BAND[0]  || price > NO_BAND[1]))  return { fire: false, reason: "no-price-band" };
  if (trade.side === "YES" && (price < YES_BAND[0] || price > YES_BAND[1])) return { fire: false, reason: "yes-price-band" };
  // Position of observed-max vs bucket — informational; not gating yet
  const distance = obsMaxC == null ? null :
      (obsMaxC < bucketLoC ? bucketLoC - obsMaxC :
       obsMaxC > bucketHiC ? obsMaxC - bucketHiC : 0);
  return { fire: true, reason: "pass", distance, bucketLoC, bucketHiC, obsMaxC };
}

function summarize(trades, label) {
  if (!trades.length) { console.log(`${label}: n=0`); return; }
  const n = trades.length;
  const fired = trades.filter(t => t.sim?.fired);
  const withPnl = fired.filter(t => t.sim.pnl != null);
  const wins = withPnl.filter(t => t.sim.pnl > 0.01).length;
  const losses = withPnl.filter(t => t.sim.pnl < -0.01).length;
  const simPnl = withPnl.reduce((s, t) => s + t.sim.pnl, 0);
  const actualPnl = trades.reduce((s, t) => s + (t.actualPnl || 0), 0);
  const wr = withPnl.length ? 100 * wins / withPnl.length : 0;
  console.log(`\n=== ${label} · n=${n} ===`);
  console.log(`  fired     : ${fired.length}/${n} (${(100*fired.length/n).toFixed(1)}%)`);
  console.log(`  w/ pnl    : ${withPnl.length}`);
  console.log(`  wins      : ${wins}  losses: ${losses}  WR=${wr.toFixed(1)}%`);
  console.log(`  sim PnL   : $${simPnl.toFixed(2)}`);
  console.log(`  actual PnL: $${actualPnl.toFixed(2)}   (of full set, not just fired)`);
  console.log(`  sim vs act: ${actualPnl ? (100*simPnl/actualPnl).toFixed(1) : "—"}% capture`);
  // Exit-reason breakdown
  const byReason = {};
  for (const t of withPnl) byReason[t.sim.reason] = (byReason[t.sim.reason] || 0) + 1;
  console.log(`  exit reasons:`);
  for (const [r, c] of Object.entries(byReason).sort((a,b)=>b[1]-a[1])) {
    const subPnl = withPnl.filter(x => x.sim.reason === r).reduce((s, x) => s + x.sim.pnl, 0);
    console.log(`    ${r.padEnd(15)} ${String(c).padStart(4)}  pnl=$${subPnl.toFixed(2)}`);
  }
}

async function main() {
  const raw = await fs.readFile(TRADES, "utf8");
  const allTrades = raw.trim().split("\n").map(l => JSON.parse(l))
    .filter(t => t.holdMinutes != null && t.title && t.openTs && t.entryAvg != null);

  // Chronological sort — train/test split is by time.
  allTrades.sort((a, b) => a.openTs - b.openTs);
  const cutoff = Math.floor(allTrades.length * TRAIN_PCT);
  const train = allTrades.slice(0, cutoff);
  const test  = allTrades.slice(cutoff);
  console.log(`=== backtest-900e ===`);
  console.log(`rule: profit>=${PROFIT_TARGET}  stop=-${(100*STOP_FRAC).toFixed(0)}%  timeout=${TIMEOUT_MIN}min`);
  console.log(`      NO band=[${NO_BAND[0]},${NO_BAND[1]}]  YES band=[${YES_BAND[0]},${YES_BAND[1]}]`);
  console.log(`trades: n=${allTrades.length}  train=${train.length} (first ${(100*TRAIN_PCT).toFixed(0)}%)  test=${test.length}`);
  if (allTrades.length) {
    const t0 = new Date(allTrades[0].openTs * 1000).toISOString().slice(0, 10);
    const t1 = new Date(allTrades[allTrades.length-1].openTs * 1000).toISOString().slice(0, 10);
    console.log(`date range: ${t0} → ${t1}`);
  }

  const enriched = [];
  let missingWx = 0, missingTicks = 0, missingTitle = 0;
  for (const t of allTrades) {
    const parsed = parseTitle(t.title);
    if (!parsed?.city || !parsed?.date || parsed.thrLo == null) { missingTitle++; enriched.push({ trade: t, actualPnl: t.pnlUsdc, sim: { fired: false, reason: "title-parse-fail" } }); continue; }
    const wx = await loadWeather(parsed.city, parsed.date);
    if (!wx) { missingWx++; enriched.push({ trade: t, actualPnl: t.pnlUsdc, parsed, sim: { fired: false, reason: "no-weather" } }); continue; }
    const ticks = await loadTicks(t.conditionId);
    if (!ticks) { missingTicks++; enriched.push({ trade: t, actualPnl: t.pnlUsdc, parsed, sim: { fired: false, reason: "no-ticks" } }); continue; }
    const obsMaxC = observedMaxUpTo(wx, t.openTs);  // NO-LOOKAHEAD
    const rule = entryRule(t, parsed, obsMaxC);
    if (!rule.fire) { enriched.push({ trade: t, actualPnl: t.pnlUsdc, parsed, obsMaxC, rule, sim: { fired: false, reason: rule.reason } }); continue; }
    // Sim uses 900e's own entry price & shares (same risk as they took).
    // This validates the EXIT engine while holding entry constant.
    const exit = simulateExit(ticks, t.side, t.openTs, t.entryAvg, t.shares);  // NO-LOOKAHEAD
    enriched.push({
      trade: t, actualPnl: t.pnlUsdc, parsed, obsMaxC, rule,
      sim: { fired: true, reason: exit.reason, exitPrice: exit.exitPrice, exitTs: exit.exitTs, pnl: exit.pnl },
    });
  }
  console.log(`\ndata gaps: title-parse=${missingTitle}  no-weather=${missingWx}  no-ticks=${missingTicks}`);

  // Split-aware summary
  const trainEnriched = enriched.slice(0, cutoff);
  const testEnriched  = enriched.slice(cutoff);
  summarize(trainEnriched, TRAIN_PCT < 1 ? `TRAIN (first ${(100*TRAIN_PCT).toFixed(0)}%)` : "ALL");
  if (TRAIN_PCT < 1) summarize(testEnriched, `TEST (last ${(100*(1-TRAIN_PCT)).toFixed(0)}%)`);

  // Per-trade delta: where does sim diverge most from actual?
  const fired = enriched.filter(e => e.sim.fired && e.sim.pnl != null);
  const deltas = fired.map(e => ({ e, delta: (e.sim.pnl - e.actualPnl) })).sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta));
  console.log(`\n=== TOP 10 divergences (sim_pnl - actual_pnl) ===`);
  for (const { e, delta } of deltas.slice(0, 10)) {
    const city = e.parsed?.city || "?";
    console.log(`  ${e.trade.side} ${city.padEnd(16)} ${e.parsed?.date ?? "?"}  entry=${e.trade.entryAvg.toFixed(4)}  actual_exit=${e.trade.exitPrice?.toFixed(4) ?? "?"}  sim_exit=${e.sim.exitPrice?.toFixed(4)}(${e.sim.reason})  actual_pnl=$${e.actualPnl?.toFixed(2)}  sim_pnl=$${e.sim.pnl.toFixed(2)}  Δ=$${delta.toFixed(2)}`);
  }

  // Aggregate parity: how closely does sim total match actual total on the
  // fired subset?
  const firedActual = fired.reduce((s, e) => s + (e.actualPnl || 0), 0);
  const firedSim    = fired.reduce((s, e) => s + e.sim.pnl, 0);
  const parity      = firedActual ? (firedSim / firedActual) : 0;
  console.log(`\n=== PARITY (fired subset) ===`);
  console.log(`  actual PnL on fired trades: $${firedActual.toFixed(2)}`);
  console.log(`  sim    PnL on fired trades: $${firedSim.toFixed(2)}`);
  console.log(`  parity ratio:               ${(100*parity).toFixed(1)}%`);
  console.log(`  (<90%: rule exits too early / cuts winners; >110%: rule lets winners run vs 900e who takes profits)`);
}

main().catch(e => { console.error(e); process.exit(1); });
