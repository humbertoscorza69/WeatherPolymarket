#!/usr/bin/env node
/**
 * Fresh-sim using v2 classifier (GBDT, adjacent-NEG training).
 * Same exit rules as v1, wider entry band (0.85-0.998).
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
  MIN_ENTRY:    Number(argv.minentry ?? "0.85"),
  MAX_ENTRY:    Number(argv.maxentry ?? "0.998"),
  TRADE_USDC:   Number(argv.tradesize ?? "40"),
  TTR_MIN:      Number(argv.ttrmin ?? String(60*60)),
  TTR_MAX:      Number(argv.ttrmax ?? String(3*60*60)),
  COOLDOWN_SEC: Number(argv.cooldown ?? "900"),
  THRESHOLD:    Number(argv.threshold ?? "0.5"),
  SIZING:        argv.sizing ?? "flat",
  REF_SPREAD:    Number(argv.refspread ?? "0.002"),
  BANKROLL_MAX:  Number(argv.bankrollmax ?? "5000"),
  // liquidation mode on timeout:
  //   flat     - exit at entry price (no loss, optimistic)
  //   realistic- exit at actual market price at t+maxhold (honest)
  LIQ_MODE:     argv.liq ?? "flat",
};

function computeUsdcSize(entryPrice) {
  if (CFG.SIZING === "flat") return CFG.TRADE_USDC;
  const potential = CFG.ASK_TARGET - entryPrice;
  if (potential <= 0) return CFG.TRADE_USDC;
  const scaled = CFG.TRADE_USDC * (potential / CFG.REF_SPREAD);
  if (CFG.SIZING === "capped") return Math.min(scaled, CFG.BANKROLL_MAX);
  return scaled;
}

const TICK_DIR   = path.resolve("data/tick-history");
const CACHE_DIR  = path.resolve("data/resolved-market-cache");
const MODEL_FILE = path.resolve("data/classifier/model-gbdt.json");
const OUT_CSV    = path.resolve("data/backtest-937-classifier-v2.csv");

const EXCLUDE_WALLET = "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";
const model = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8"));

const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : "nan";
function loadTicks(cid) {
  const p = path.join(TICK_DIR, `${cid}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).sort((a,b)=>a.timestamp-b.timestamp);
}
function loadCache(cid, side) {
  const p = path.join(CACHE_DIR, `${cid}-${side}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function cityFromTitle(title) {
  if (!title) return null;
  const m = title.match(/(?:temperature in|temp in) ([A-Z][\w .\-']+?)(?:\s+be|\s+on|,)/i);
  return m ? m[1].trim() : null;
}
function windowFeatures(ticks, entryTs, windowSec, outcomeIndex) {
  const lo = entryTs - windowSec;
  const w = ticks.filter(t =>
    t.timestamp >= lo && t.timestamp < entryTs &&
    t.outcomeIndex === outcomeIndex &&
    t.proxyWallet?.toLowerCase() !== EXCLUDE_WALLET
  );
  const f = { n: w.length, buySize: 0, sellSize: 0, whaleCount: 0, uniqueTakers: 0, priceMin: 1, priceMax: 0, sinceLast: windowSec };
  const takers = new Set();
  for (const t of w) {
    const sz = Number(t.size) || 0;
    if (t.side === "BUY") f.buySize += sz; else f.sellSize += sz;
    if (sz >= 100) f.whaleCount += 1;
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
function featuresFor(ticks, entryTs, entryPrice, outcomeIndex) {
  const other = outcomeIndex === 1 ? 0 : 1;
  const feats = { price: entryPrice };
  for (const w of [60, 300, 900]) {
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
function treePredict(node, x) {
  if (node.leaf) return node.value;
  return x[node.feat] <= node.thr ? treePredict(node.left, x) : treePredict(node.right, x);
}
function scoreEntry(feat) {
  const x = model.featNames.map(k => Number.isFinite(feat[k]) ? feat[k] : 0);
  let z = 0;
  for (const t of model.trees) z += model.eta * treePredict(t, x);
  return 1/(1+Math.exp(-Math.max(-30, Math.min(30, z))));
}

const tickFiles = fs.readdirSync(TICK_DIR).filter(f => f.endsWith(".jsonl"));
console.log(`Config: threshold=${CFG.THRESHOLD} band=[${CFG.MIN_ENTRY},${CFG.MAX_ENTRY}] maxhold=${CFG.MAX_HOLD_MIN} TTR=[${CFG.TTR_MIN/3600}h,${CFG.TTR_MAX/3600}h]`);
console.log(`Scanning ${tickFiles.length} markets...`);

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
console.log(`${events.length} candidate sample events\n`);

let passedCoarse = 0, scored = 0, opened = 0;
const positions = new Map();
const lastEntryByCid = new Map();
const trades = [];
const tickCache = new Map();

for (const ev of events) {
  const key = `${ev.conditionId}-NO`;
  const pos = positions.get(key);
  if (pos) {
    const hold = (ev.t - pos.entryTs) / 60;
    if (ev.p >= CFG.ASK_TARGET) {
      trades.push({ ...pos, exitTs: ev.t, exitPrice: CFG.ASK_TARGET, holdMin: hold,
        pnl: pos.shares * (CFG.ASK_TARGET - pos.entryPrice), status: "target-hit" });
      positions.delete(key);
    } else if (hold >= CFG.MAX_HOLD_MIN) {
      // Liquidation: flat (optimistic) or at actual market price (honest)
      const exitP = CFG.LIQ_MODE === "realistic" ? ev.p : pos.entryPrice;
      const pnl = CFG.LIQ_MODE === "realistic"
        ? pos.shares * (exitP - pos.entryPrice)
        : 0;
      trades.push({ ...pos, exitTs: ev.t, exitPrice: exitP, holdMin: hold, pnl,
        status: CFG.LIQ_MODE === "realistic" ? "timeout-liq" : "timeout-flat" });
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

  if (!tickCache.has(ev.conditionId)) tickCache.set(ev.conditionId, loadTicks(ev.conditionId));
  const ticks = tickCache.get(ev.conditionId);
  const feats = featuresFor(ticks, ev.t, ev.p, 1);
  const s = scoreEntry(feats);
  scored++;
  if (s < CFG.THRESHOLD) continue;

  const usdc = computeUsdcSize(ev.p);
  const shares = usdc / ev.p;
  positions.set(key, {
    conditionId: ev.conditionId, city: ev.city, title: ev.title,
    entryTs: ev.t, entryPrice: ev.p, shares, usdc, score: s
  });
  lastEntryByCid.set(key, ev.t);
  opened++;
}

for (const [key, pos] of positions) {
  trades.push({ ...pos, exitTs: pos.entryTs + CFG.MAX_HOLD_MIN*60, exitPrice: pos.entryPrice, holdMin: CFG.MAX_HOLD_MIN, pnl: 0, status: "end-flat" });
}

const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
const targetHit = trades.filter(t => t.status === "target-hit").length;
const totalUsdc = trades.reduce((s, t) => s + t.usdc, 0);
const firstTs = trades.length ? Math.min(...trades.map(t => t.entryTs)) : 0;
const lastTs = trades.length ? Math.max(...trades.map(t => t.exitTs)) : 0;
const spanDays = (lastTs - firstTs) / 86400;

console.log(`candidates(TTR+band): ${passedCoarse}  scored: ${scored}  opened: ${opened}`);
console.log(`total trades: ${trades.length}  target-hit: ${targetHit} (${trades.length ? (100*targetHit/trades.length).toFixed(1)+"%" : "-"})`);
console.log(`total PnL: $${fmt(totalPnl)}  avg/trade: $${fmt(totalPnl/Math.max(1,trades.length),3)}  ROI deployed: ${fmt(100*totalPnl/Math.max(1,totalUsdc),2)}%`);
console.log(`span: ${fmt(spanDays,1)}d  PnL/day: $${fmt(totalPnl/Math.max(0.1,spanDays),2)}  trades/day: ${fmt(trades.length/Math.max(0.1,spanDays),1)}`);

const rows = trades.map(t => [
  t.conditionId, t.city || "", t.entryTs, t.entryPrice.toFixed(4),
  t.exitTs, t.exitPrice.toFixed(4), t.shares.toFixed(2), t.usdc.toFixed(2),
  t.holdMin.toFixed(1), t.pnl.toFixed(4), (t.score ?? "").toString().slice(0,6), t.status,
  (t.title || "").replace(/,/g, " ")
].join(","));
fs.writeFileSync(OUT_CSV, ["conditionId,city,entryTs,entryPrice,exitTs,exitPrice,shares,usdc,holdMin,pnl,score,status,title", ...rows].join("\n") + "\n");
