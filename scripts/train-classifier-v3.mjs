#!/usr/bin/env node
/**
 * v3: 23-wallet POS + tick features + WEATHER features + GBDT.
 * Exclude ALL winning wallets from tick-window (not just 937).
 */
import fs from "node:fs";
import path from "node:path";

const TICK_DIR    = path.resolve("data/tick-history");
const CACHE_DIR   = path.resolve("data/resolved-market-cache");
const TRADES_DIR  = path.resolve("data/wallet-trades");
const WEATHER_DIR = path.resolve("data/weather-history");
const OUT_DIR     = path.resolve("data/classifier");
fs.mkdirSync(OUT_DIR, { recursive: true });

// All 23+ winning wallets (read from jsonl filenames).
const WALLETS = fs.readdirSync(TRADES_DIR)
  .filter(f => f.endsWith(".jsonl"))
  .map(f => f.replace(".jsonl", "").toLowerCase());
const EXCLUDE = new Set(WALLETS);
console.log(`Excluding ${EXCLUDE.size} winning wallets from feature windows`);

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

// ----- title parsing (city, date, threshold, type) -----
function parseWeatherTitle(title) {
  if (!title) return null;
  const cityM = title.match(/temperature in ([A-Z][\w .\-']+?) be/i);
  if (!cityM) return null;
  const city = cityM[1].trim();
  const unit = /°F/i.test(title) ? "F" : "C";
  const rangeM = title.match(/be\s+(?:between\s+)?(\d+)(?:\s*-\s*(\d+))?\s*°/i);
  let threshold = null, thresholdHigh = null;
  if (rangeM) { threshold = Number(rangeM[1]); if (rangeM[2]) thresholdHigh = Number(rangeM[2]); }
  const type = /or higher/i.test(title) ? "at_or_above"
             : /or below/i.test(title) ? "at_or_below"
             : /between/i.test(title) ? "between" : "exact";
  let date = null;
  const isoM = title.match(/on\s+(\d{4}-\d{2}-\d{2})/);
  const monM = title.match(/on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)(?:,\s*(\d{4}))?/i);
  if (isoM) date = isoM[1];
  else if (monM) {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const mi = months.findIndex(m => m.toLowerCase() === monM[1].toLowerCase());
    date = `${monM[3]||"2026"}-${String(mi+1).padStart(2,"0")}-${String(monM[2]).padStart(2,"0")}`;
  }
  if (!date) return null;
  return { city, date, unit, threshold, thresholdHigh, type };
}

// ----- tick-window features (same as v2 but multi-wallet exclude) -----
function windowFeatures(ticks, entryTs, windowSec, outcomeIndex) {
  const lo = entryTs - windowSec;
  const w = ticks.filter(t =>
    t.timestamp >= lo && t.timestamp < entryTs &&
    t.outcomeIndex === outcomeIndex &&
    !EXCLUDE.has((t.proxyWallet || "").toLowerCase())
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

// ----- weather features -----
const WEATHER_CACHE = new Map();
function loadWeather(city, date) {
  const key = `${city}__${date}`;
  if (WEATHER_CACHE.has(key)) return WEATHER_CACHE.get(key);
  const p = path.join(WEATHER_DIR, `${key}.json`);
  if (!fs.existsSync(p)) { WEATHER_CACHE.set(key, null); return null; }
  try {
    const w = JSON.parse(fs.readFileSync(p, "utf8"));
    WEATHER_CACHE.set(key, w); return w;
  } catch { WEATHER_CACHE.set(key, null); return null; }
}
function toCelsius(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }
// local-day-so-far samples: samples with t <= entryTs AND on market's local date.
// Approximate local day by UTC offset ±14h window around date noon — good enough for threshold tracking.
function weatherFeatures(market, entryTs) {
  const w = loadWeather(market.city, market.date);
  const feats = { wx_avail: 0, wx_temp_now: 0, wx_max_sofar: 0, wx_delta_to_thr: 0, wx_slope_3h: 0, wx_hours_remain: 24, wx_crossed: 0 };
  if (!w?.samples?.length || market.threshold == null) return feats;
  feats.wx_avail = 1;
  // Day bounds: [date 00:00 local, date 23:59 local]. Without full tz math, use ±14h around date-midnight-UTC.
  const dayStart = new Date(market.date + "T00:00:00Z").getTime() / 1000 - 14*3600;
  const dayEnd   = new Date(market.date + "T00:00:00Z").getTime() / 1000 + 38*3600;
  const inDay = w.samples.filter(s => s.t >= dayStart && s.t <= dayEnd && s.t <= entryTs);
  if (!inDay.length) return feats;
  const tempCNow = inDay[inDay.length - 1].tempC;
  const maxSoFar = Math.max(...inDay.map(s => s.tempC));
  const thrC = toCelsius(market.threshold, market.unit);
  feats.wx_temp_now = tempCNow;
  feats.wx_max_sofar = maxSoFar;
  feats.wx_delta_to_thr = thrC - maxSoFar;
  // slope over last 3h
  const recent = inDay.filter(s => s.t >= entryTs - 3*3600);
  if (recent.length >= 2) {
    const first = recent[0], last = recent[recent.length - 1];
    feats.wx_slope_3h = (last.tempC - first.tempC) / Math.max(1, (last.t - first.t) / 3600);
  }
  feats.wx_hours_remain = Math.max(0, (dayEnd - 14*3600 - entryTs) / 3600); // hrs to local midnight (approx)
  // crossed: for at_or_below -> max_sofar is ALREADY above threshold → market should be NO (good for our NO entry)
  // for at_or_above -> max has NOT yet reached threshold (still possible NO outcome if day ends soon)
  if (market.type === "at_or_below" && maxSoFar > thrC) feats.wx_crossed = 1;
  else if (market.type === "at_or_above" && maxSoFar < thrC && feats.wx_hours_remain < 6) feats.wx_crossed = 1;
  else if (market.type === "exact" && (maxSoFar < market.threshold - 1 || maxSoFar > market.threshold + 1)) feats.wx_crossed = 1;
  return feats;
}

function extractFeatures(cid, market, entryTs, entryPrice, outcomeIndex) {
  const ticks = loadTicks(cid);
  if (!ticks.length) return null;
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
  const wx = weatherFeatures(market, entryTs);
  Object.assign(feats, wx);
  return feats;
}

function forwardCheck(cid, entryTs, outcomeIndex, windowSec = 15*60, target = 0.999) {
  const side = outcomeIndex === 1 ? "NO" : "YES";
  const c = loadCache(cid, side);
  if (!c?.samples?.length) return null;
  for (const s of c.samples) {
    if (s.t < entryTs) continue;
    if (s.t > entryTs + windowSec) break;
    if (s.p >= target) return 1;
  }
  return 0;
}
function priceAtTs(cid, ts, side) {
  const c = loadCache(cid, side);
  if (!c?.samples?.length) return null;
  let best = null, bestD = Infinity;
  for (const s of c.samples) {
    const d = Math.abs(s.t - ts);
    if (d < bestD) { bestD = d; best = s; }
    if (s.t > ts + 120) break;
  }
  return bestD <= 120 ? best : null;
}

console.log("Building v3 dataset (23-wallet POS + adjacent-NEG)...");

// Gather all weather trades across all wallets as POS.
const pos = [];
const posKeys = new Set(); // block NEG sampling near any POS moment
for (const walletFile of fs.readdirSync(TRADES_DIR).filter(f => f.endsWith(".jsonl"))) {
  const wallet = walletFile.replace(".jsonl", "").toLowerCase();
  const lines = fs.readFileSync(path.join(TRADES_DIR, walletFile), "utf8").trim().split("\n").filter(Boolean);
  for (const l of lines) {
    let t; try { t = JSON.parse(l); } catch { continue; }
    if (!/temperature/i.test(t.title || "")) continue;
    if (t.entryAvg < 0.85 || t.entryAvg > 0.998) continue;
    const market = parseWeatherTitle(t.title);
    if (!market) continue;
    const f = extractFeatures(t.conditionId, market, t.openTs, t.entryAvg, t.outcomeIndex);
    if (!f) continue;
    f.label = 1;
    f.conditionId = t.conditionId;
    f.entryTs = t.openTs;
    f.wallet = wallet;
    f.outcomeIndex = t.outcomeIndex;
    f._market = market;
    pos.push(f);
    for (let off = -180; off <= 180; off += 30) posKeys.add(`${t.conditionId}|${t.openTs + off}`);
  }
}
console.log(`POS (all-wallet weather entries, band 0.85-0.998): ${pos.length}`);

// Adjacent-NEG for each POS.
const neg = [];
for (const p of pos) {
  for (const offMin of [-30, -20, -10, -5, 5, 10, 20, 30]) {
    const negTs = p.entryTs + offMin * 60;
    if (posKeys.has(`${p.conditionId}|${negTs}`)) continue;
    const side = p.outcomeIndex === 1 ? "NO" : "YES";
    const snap = priceAtTs(p.conditionId, negTs, side);
    if (!snap) continue;
    if (snap.p < 0.85 || snap.p > 0.998) continue;
    if (forwardCheck(p.conditionId, negTs, p.outcomeIndex, 15*60, 0.999) !== 0) continue;
    const f = extractFeatures(p.conditionId, p._market, negTs, snap.p, p.outcomeIndex);
    if (!f) continue;
    f.label = 0;
    f.conditionId = p.conditionId;
    f.entryTs = negTs;
    neg.push(f);
  }
}
console.log(`NEG (adjacent, forward-check failed): ${neg.length}`);

// ========== GBDT (same as v2) ==========
function trainTree(X, g, h, maxDepth, lambda = 1.0, minLeaf = 20) {
  const n = X.length, p = X[0].length;
  function buildNode(indices, depth) {
    if (depth >= maxDepth || indices.length < 2 * minLeaf) {
      const gs = indices.reduce((s,i)=>s+g[i],0), hs = indices.reduce((s,i)=>s+h[i],0);
      return { leaf: true, value: -gs/(hs+lambda) };
    }
    let bestGain = -Infinity, bestFeat = -1, bestThr = null, bestLeft = null, bestRight = null;
    for (let feat = 0; feat < p; feat++) {
      const sorted = [...indices].sort((a,b) => X[a][feat] - X[b][feat]);
      let leftG = 0, leftH = 0;
      const tG = indices.reduce((s,i)=>s+g[i],0), tH = indices.reduce((s,i)=>s+h[i],0);
      for (let i = 0; i < sorted.length - 1; i++) {
        leftG += g[sorted[i]]; leftH += h[sorted[i]];
        if (i+1 < minLeaf || sorted.length - i - 1 < minLeaf) continue;
        if (X[sorted[i]][feat] === X[sorted[i+1]][feat]) continue;
        const rG = tG - leftG, rH = tH - leftH;
        const gain = (leftG*leftG)/(leftH+lambda) + (rG*rG)/(rH+lambda) - (tG*tG)/(tH+lambda);
        if (gain > bestGain) {
          bestGain = gain; bestFeat = feat;
          bestThr = (X[sorted[i]][feat] + X[sorted[i+1]][feat]) / 2;
          bestLeft = sorted.slice(0, i+1); bestRight = sorted.slice(i+1);
        }
      }
    }
    if (bestGain <= 0 || bestFeat < 0) {
      const gs = indices.reduce((s,i)=>s+g[i],0), hs = indices.reduce((s,i)=>s+h[i],0);
      return { leaf: true, value: -gs/(hs+lambda) };
    }
    return { leaf: false, feat: bestFeat, thr: bestThr,
      left: buildNode(bestLeft, depth+1), right: buildNode(bestRight, depth+1) };
  }
  return buildNode([...Array(n).keys()], 0);
}
function treePredict(node, x) {
  if (node.leaf) return node.value;
  return x[node.feat] <= node.thr ? treePredict(node.left, x) : treePredict(node.right, x);
}
function trainGBDT(train, featNames, { nTrees = 60, maxDepth = 3, eta = 0.1 } = {}) {
  const X = train.map(d => featNames.map(k => Number.isFinite(d[k]) ? d[k] : 0));
  const y = train.map(d => d.label);
  const n = X.length;
  const preds = new Array(n).fill(0);
  const trees = [];
  const sig = z => 1/(1+Math.exp(-Math.max(-30, Math.min(30, z))));
  for (let t = 0; t < nTrees; t++) {
    const p = preds.map(sig);
    const g = y.map((yi, i) => p[i] - yi);
    const h = p.map(pi => pi*(1-pi)+1e-6);
    const tree = trainTree(X, g, h, maxDepth);
    trees.push(tree);
    for (let i = 0; i < n; i++) preds[i] += eta * treePredict(tree, X[i]);
  }
  return { trees, eta, featNames };
}
function scoreGBDT(model, feat) {
  const x = model.featNames.map(k => Number.isFinite(feat[k]) ? feat[k] : 0);
  let z = 0;
  for (const t of model.trees) z += model.eta * treePredict(t, x);
  return 1/(1+Math.exp(-Math.max(-30, Math.min(30, z))));
}
function auc(scored) {
  const sorted = [...scored].sort((a,b)=>b.p-a.p);
  let tp=0,fp=0,ptp=0,pfp=0,area=0;
  for (const s of sorted) {
    if (s.y===1) tp++; else fp++;
    if (fp!==pfp) { area += (tp+ptp)/2 * (fp-pfp); ptp=tp; pfp=fp; }
  }
  const pt = scored.filter(s=>s.y===1).length, nt = scored.filter(s=>s.y===0).length;
  return area / Math.max(1, pt*nt);
}
function shuffled(a) { const x=[...a]; for (let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];} return x; }

// ========== train + validate ==========
const all = [...pos, ...neg].filter(d => d.label !== undefined);
const featNames = Object.keys(all[0]).filter(k => !["label","conditionId","entryTs","wallet","outcomeIndex","_market"].includes(k));
console.log(`${featNames.length} features; total=${all.length} pos=${pos.length} neg=${neg.length}`);

// Random split
const sh = shuffled(all);
const split = Math.floor(sh.length * 0.7);
const train = sh.slice(0, split), test = sh.slice(split);
console.log(`Train: ${train.length}  Test: ${test.length}`);
console.log("Training GBDT (60 trees, depth 3, eta 0.1)...");
const model = trainGBDT(train, featNames);
const scored = test.map(t => ({ y: t.label, p: scoreGBDT(model, t) }));
console.log(`GBDT random-split AUC: ${auc(scored).toFixed(4)}`);

// Market-split
const cids = [...new Set(all.map(d => d.conditionId))];
const shCids = shuffled(cids);
const trainCids = new Set(shCids.slice(0, Math.floor(shCids.length * 0.7)));
const tr2 = all.filter(d => trainCids.has(d.conditionId));
const te2 = all.filter(d => !trainCids.has(d.conditionId));
console.log(`Market-split: train=${tr2.length} test=${te2.length}`);
const m2 = trainGBDT(tr2, featNames);
const s2 = te2.map(t => ({ y: t.label, p: scoreGBDT(m2, t) }));
console.log(`GBDT market-split AUC: ${auc(s2).toFixed(4)}`);

// Random-label baseline
const sh4 = shuffled(all).map(x => ({ ...x, label: Math.random()<0.5 ? 0 : 1 }));
const sp4 = Math.floor(sh4.length * 0.7);
const m4 = trainGBDT(sh4.slice(0, sp4), featNames, { nTrees: 30 });
const s4 = sh4.slice(sp4).map(t => ({ y: t.label, p: scoreGBDT(m4, t) }));
console.log(`Random-label AUC (should ~0.5): ${auc(s4).toFixed(4)}`);

// P/R thresholds
console.log("P/R at thresholds (random-split):");
for (const th of [0.3, 0.5, 0.7, 0.8, 0.9]) {
  const picked = scored.filter(s => s.p >= th);
  const tp = picked.filter(s => s.y===1).length, fp = picked.filter(s => s.y===0).length;
  const pr = (tp+fp) > 0 ? tp/(tp+fp) : 0;
  const rc = scored.filter(s=>s.y===1).length > 0 ? tp / scored.filter(s=>s.y===1).length : 0;
  console.log(`  th=${th}  picked=${picked.length} tp=${tp} fp=${fp}  precision=${(100*pr).toFixed(1)}%  recall=${(100*rc).toFixed(1)}%`);
}

// Single-feature AUC diagnostic (detect leaks)
console.log("\nSingle-feature AUC (|0.5-auc|>0.2 is suspicious):");
for (const fn of featNames) {
  const single = test.map(t => ({ y: t.label, p: Number.isFinite(t[fn]) ? t[fn] : 0 }));
  const a = auc(single);
  if (Math.abs(a - 0.5) > 0.15) console.log(`  ${fn.padEnd(24)}  ${a.toFixed(3)}`);
}

fs.writeFileSync(path.join(OUT_DIR, "model-gbdt-v3.json"), JSON.stringify(model));
console.log(`\nSaved: ${path.join(OUT_DIR, "model-gbdt-v3.json")}`);
