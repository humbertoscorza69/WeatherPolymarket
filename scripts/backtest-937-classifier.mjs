#!/usr/bin/env node
/**
 * Fresh-sim backtest using the tick-trained classifier as the entry gate.
 *
 * Walks timeline of candidate entries (TTR 1-3h, price 0.95-0.998, NO side,
 * weather-only). At each candidate, extracts the same microstructure
 * features the classifier was trained on, scores them, enters only if
 * score >= threshold.
 *
 * Exit rule: maker ASK at 0.999, 15min max hold, flat unwind on timeout.
 *
 * Usage:
 *   node scripts/backtest-937-classifier.mjs --threshold=0.8
 */

import fs from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const CFG = {
  ASK_TARGET:   Number(argv.ask ?? "0.999"),
  MAX_HOLD_MIN: Number(argv.maxhold ?? "15"),
  MIN_ENTRY:    Number(argv.minentry ?? "0.95"),
  MAX_ENTRY:    Number(argv.maxentry ?? "0.998"),
  TRADE_USDC:   Number(argv.tradesize ?? "40"),
  TTR_MIN:      Number(argv.ttrmin ?? String(60*60)),
  TTR_MAX:      Number(argv.ttrmax ?? String(3*60*60)),
  COOLDOWN_SEC: Number(argv.cooldown ?? "900"),
  THRESHOLD:    Number(argv.threshold ?? "0.8"),
};

const TICK_DIR   = path.resolve("data/tick-history");
const CACHE_DIR  = path.resolve("data/resolved-market-cache");
const MODEL_FILE = path.resolve("data/classifier/model.json");
const OUT_CSV    = path.resolve("data/backtest-937-classifier.csv");

const model = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8"));
const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : "nan";

function loadTicks(conditionId) {
  const p = path.join(TICK_DIR, `${conditionId}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n")
    .filter(Boolean).map(JSON.parse)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function loadCache(conditionId, side) {
  const p = path.join(CACHE_DIR, `${conditionId}-${side}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function cityFromTitle(title) {
  if (!title) return null;
  const m = title.match(/(?:temperature in|temp in) ([A-Z][\w .\-']+?)(?:\s+be|\s+on|,)/i);
  return m ? m[1].trim() : null;
}

const EXCLUDE_WALLET = "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";

function windowFeatures(ticks, entryTs, windowSec, outcomeIndex) {
  const lo = entryTs - windowSec;
  const w = ticks.filter(t =>
    t.timestamp >= lo &&
    t.timestamp < entryTs &&
    t.outcomeIndex === outcomeIndex &&
    t.proxyWallet?.toLowerCase() !== EXCLUDE_WALLET
  );
  const f = { n: w.length, buySize: 0, sellSize: 0, whaleCount: 0, uniqueTakers: 0,
              priceMin: 1, priceMax: 0, sinceLast: windowSec };
  const takers = new Set();
  for (const t of w) {
    const size = Number(t.size) || 0;
    if (t.side === "BUY") f.buySize += size; else f.sellSize += size;
    if (size >= 100) f.whaleCount += 1;
    takers.add(t.proxyWallet);
    if (t.price < f.priceMin) f.priceMin = t.price;
    if (t.price > f.priceMax) f.priceMax = t.price;
  }
  f.uniqueTakers = takers.size;
  f.buyPressure = (f.buySize + f.sellSize > 0) ? f.buySize / (f.buySize + f.sellSize) : 0.5;
  f.priceRange = f.n > 0 ? f.priceMax - f.priceMin : 0;
  if (w.length) f.sinceLast = entryTs - w[w.length - 1].timestamp;
  return f;
}

function featuresFor(ticks, entryTs, entryPrice, outcomeIndex, marketEndTs) {
  const other = outcomeIndex === 1 ? 0 : 1;
  // Must match train-classifier.mjs feature set (no ttrSec/pricesq to avoid TTR leak)
  const feats = { price: entryPrice };
  for (const w of [60, 5*60, 15*60]) {
    const label = w === 60 ? "1m" : w === 300 ? "5m" : "15m";
    const own = windowFeatures(ticks, entryTs, w, outcomeIndex);
    const opp = windowFeatures(ticks, entryTs, w, other);
    feats[`n_own_${label}`] = own.n;
    feats[`buyP_own_${label}`] = own.buyPressure;
    feats[`whale_own_${label}`] = own.whaleCount;
    feats[`takers_own_${label}`] = own.uniqueTakers;
    feats[`range_own_${label}`] = own.priceRange;
    feats[`since_own_${label}`] = Math.min(w, own.sinceLast);
    feats[`n_opp_${label}`] = opp.n;
    feats[`buyP_opp_${label}`] = opp.buyPressure;
    feats[`whale_opp_${label}`] = opp.whaleCount;
  }
  return feats;
}

function scoreEntry(feat) {
  const z = model.featNames.reduce((s, name, j) => {
    const v = Number.isFinite(feat[name]) ? feat[name] : 0;
    const xn = (v - model.mu[j]) / model.sigma[j];
    return s + xn * model.w[j];
  }, model.b);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

// ---- main ----

const tickFiles = fs.readdirSync(TICK_DIR).filter(f => f.endsWith(".jsonl"));
console.log(`Config: threshold=${CFG.THRESHOLD} maxhold=${CFG.MAX_HOLD_MIN} TTR=[${CFG.TTR_MIN/3600}h,${CFG.TTR_MAX/3600}h]`);
console.log(`Scanning ${tickFiles.length} markets...\n`);

const events = [];
for (const f of tickFiles) {
  const conditionId = f.replace(".jsonl", "");
  const cache = loadCache(conditionId, "NO");
  if (!cache?.samples?.length) continue;
  if (!/temperature/i.test(cache.title || "")) continue;
  const city = cityFromTitle(cache.title);
  const marketEndTs = cache.samples[cache.samples.length - 1].t;
  for (const s of cache.samples) {
    events.push({ t: s.t, p: s.p, conditionId, city, title: cache.title, marketEndTs });
  }
}
events.sort((a, b) => a.t - b.t);
console.log(`${events.length} candidate sample events across all markets\n`);

let evaluated = 0, passedCoarse = 0, scored = 0, opened = 0;
const positions = new Map();
const lastEntryByCid = new Map();
const trades = [];
const tickCache = new Map(); // conditionId -> ticks

for (const ev of events) {
  const key = `${ev.conditionId}-NO`;
  const pos = positions.get(key);
  if (pos) {
    const hold = (ev.t - pos.entryTs) / 60;
    if (ev.p >= CFG.ASK_TARGET) {
      trades.push({
        ...pos, exitTs: ev.t, exitPrice: CFG.ASK_TARGET, holdMin: hold,
        pnl: pos.shares * (CFG.ASK_TARGET - pos.entryPrice), status: "target-hit"
      });
      positions.delete(key);
    } else if (hold >= CFG.MAX_HOLD_MIN) {
      trades.push({
        ...pos, exitTs: ev.t, exitPrice: pos.entryPrice, holdMin: hold, pnl: 0, status: "timeout-flat"
      });
      positions.delete(key);
    }
  }
  if (positions.has(key)) continue;

  const inBand = ev.p >= CFG.MIN_ENTRY && ev.p <= CFG.MAX_ENTRY;
  const ttr = ev.marketEndTs - ev.t;
  const inTtr = ttr >= CFG.TTR_MIN && ttr <= CFG.TTR_MAX;
  if (!inBand || !inTtr) continue;
  passedCoarse++;

  const lastTs = lastEntryByCid.get(key) || 0;
  if (ev.t - lastTs < CFG.COOLDOWN_SEC) continue;

  // Score with classifier
  if (!tickCache.has(ev.conditionId)) tickCache.set(ev.conditionId, loadTicks(ev.conditionId));
  const ticks = tickCache.get(ev.conditionId);
  const feats = featuresFor(ticks, ev.t, ev.p, 1, ev.marketEndTs);
  const s = scoreEntry(feats);
  scored++;
  if (s < CFG.THRESHOLD) continue;

  evaluated++;
  const shares = CFG.TRADE_USDC / ev.p;
  positions.set(key, {
    conditionId: ev.conditionId, city: ev.city, title: ev.title,
    entryTs: ev.t, entryPrice: ev.p, shares, usdc: CFG.TRADE_USDC, score: s
  });
  lastEntryByCid.set(key, ev.t);
  opened++;
}

// Close remaining
for (const [key, pos] of positions) {
  trades.push({ ...pos, exitTs: pos.entryTs + CFG.MAX_HOLD_MIN*60, exitPrice: pos.entryPrice, holdMin: CFG.MAX_HOLD_MIN, pnl: 0, status: "end-flat" });
}

const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
const targetHit = trades.filter(t => t.status === "target-hit").length;
const totalUsdc = trades.reduce((s, t) => s + t.usdc, 0);
const firstTs = trades.length ? Math.min(...trades.map(t => t.entryTs)) : 0;
const lastTs = trades.length ? Math.max(...trades.map(t => t.exitTs)) : 0;
const spanDays = (lastTs - firstTs) / 86400;

console.log(`-- ENTRY FUNNEL --`);
console.log(`candidates (TTR+band passed): ${passedCoarse}`);
console.log(`scored by classifier:         ${scored}`);
console.log(`opened positions:             ${opened}`);

console.log(`\n-- RESULTS --`);
console.log(`total trades:    ${trades.length}`);
console.log(`target-hit:      ${targetHit} (${trades.length ? (100*targetHit/trades.length).toFixed(1)+"%" : "-"})`);
console.log(`total PnL:       $${fmt(totalPnl)}`);
console.log(`PnL/trade avg:   $${fmt(totalPnl / Math.max(1, trades.length), 3)}`);
console.log(`ROI on deployed: ${fmt(100*totalPnl/Math.max(1,totalUsdc), 2)}%`);
console.log(`span days:       ${fmt(spanDays, 1)}`);
console.log(`PnL/day:         $${fmt(totalPnl/Math.max(0.1, spanDays), 2)}`);

// Write CSV
const rows = trades.map(t => [
  t.conditionId, t.city || "", t.entryTs, t.entryPrice.toFixed(4),
  t.exitTs, t.exitPrice.toFixed(4), t.shares.toFixed(2), t.usdc.toFixed(2),
  t.holdMin.toFixed(1), t.pnl.toFixed(4), (t.score ?? "").toString().slice(0,6), t.status,
  (t.title || "").replace(/,/g, " ")
].join(","));
fs.writeFileSync(OUT_CSV, ["conditionId,city,entryTs,entryPrice,exitTs,exitPrice,shares,usdc,holdMin,pnl,score,status,title", ...rows].join("\n") + "\n");
console.log(`\nCSV: ${OUT_CSV}`);
