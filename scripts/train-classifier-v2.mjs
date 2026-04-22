#!/usr/bin/env node
/**
 * Round 2 classifier: tougher NEG sampling + wider entry band + GBDT.
 *
 * Changes vs train-classifier.mjs:
 *   1. ADJACENT-NEGATIVE SAMPLING: for each POS (937 entry), generate NEG
 *      candidates on the SAME market at t±[5,30] minutes from the POS. These
 *      are "close-but-not-it" moments that force the classifier to find
 *      the real microstructure discriminator, not market-level bias.
 *   2. WIDER ENTRY BAND: 0.85-0.998 (was 0.95-0.998) to catch outlier
 *      winners like 937's Taipei 0.85->0.999 move (+$434).
 *   3. GRADIENT BOOSTED DECISION TREES: tiny GBDT (depth 3, 100 trees) in pure
 *      JS to capture interactions (e.g., "whale_opp AND low_since AND broad_takers"
 *      that logistic regression's linear form cannot represent).
 *
 * Sanity: we verify AUC on market-split and random-label shuffle.
 */

import fs from "node:fs";
import path from "node:path";

const TICK_DIR   = path.resolve("data/tick-history");
const CACHE_DIR  = path.resolve("data/resolved-market-cache");
const TRADE_FILE = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");
const OUT_DIR    = path.resolve("data/classifier");
fs.mkdirSync(OUT_DIR, { recursive: true });

const EXCLUDE_WALLET = "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";

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
function extractFeatures(cid, entryTs, entryPrice, outcomeIndex) {
  const ticks = loadTicks(cid);
  if (!ticks.length) return null;
  const other = outcomeIndex === 1 ? 0 : 1;
  // No ttrSec (leaks). Just microstructure + price.
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

// ========== Dataset ==========
console.log("Building dataset with adjacent-NEG + wider band...");
const walletTrades = fs.readFileSync(TRADE_FILE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

const pos = [];
for (const t of walletTrades) {
  if (!/temperature/i.test(t.title || "")) continue;
  if (t.entryAvg < 0.85 || t.entryAvg > 0.998) continue; // wider band
  const f = extractFeatures(t.conditionId, t.openTs, t.entryAvg, t.outcomeIndex);
  if (!f) continue;
  f.label = 1;
  f.conditionId = t.conditionId;
  f.entryTs = t.openTs;
  pos.push(f);
}
console.log(`POS (937 entries, band 0.85-0.998): ${pos.length}`);

const neg = [];
const walletKeys = new Set();
for (const t of walletTrades) {
  // Mark a ±3min window around each 937 entry as "off-limits for NEG"
  for (let offset = -180; offset <= 180; offset += 30) {
    walletKeys.add(`${t.conditionId}|${t.openTs + offset}`);
  }
}

// ADJACENT-NEG: for each POS, sample NEG moments on SAME market at t±[5,30] min
for (const p of pos) {
  for (const offsetMin of [-30, -20, -10, -5, 5, 10, 20, 30]) {
    const negTs = p.entryTs + offsetMin * 60;
    // Don't overlap with any 937 entry
    const key = `${p.conditionId}|${negTs}`;
    if (walletKeys.has(key)) continue;
    // Check if this moment satisfies the coarse filter
    const snapshot = priceAtTs(p.conditionId, negTs, "NO");
    if (!snapshot) continue;
    if (snapshot.p < 0.85 || snapshot.p > 0.998) continue;
    // Forward check: price should NOT reach 0.999 within 15 min
    if (forwardCheck(p.conditionId, negTs, 1, 15*60, 0.999) !== 0) continue;
    const f = extractFeatures(p.conditionId, negTs, snapshot.p, 1);
    if (!f) continue;
    f.label = 0;
    f.conditionId = p.conditionId;
    f.entryTs = negTs;
    neg.push(f);
  }
}
console.log(`NEG (adjacent to 937 entries, forward-check failed): ${neg.length}`);

// ========== GBDT implementation ==========
/** Tiny CART regression tree for squared-loss gradient. */
function trainTree(X, g, h, maxDepth, lambda = 1.0, minLeaf = 20) {
  const n = X.length, p = X[0].length;
  function buildNode(indices, depth) {
    if (depth >= maxDepth || indices.length < 2 * minLeaf) {
      const gSum = indices.reduce((s, i) => s + g[i], 0);
      const hSum = indices.reduce((s, i) => s + h[i], 0);
      return { leaf: true, value: -gSum / (hSum + lambda) };
    }
    let bestGain = -Infinity, bestFeat = -1, bestThr = null, bestLeft = null, bestRight = null;
    for (let feat = 0; feat < p; feat++) {
      // Sort indices by feature value
      const sorted = [...indices].sort((a, b) => X[a][feat] - X[b][feat]);
      let leftG = 0, leftH = 0;
      const totalG = indices.reduce((s, i) => s + g[i], 0);
      const totalH = indices.reduce((s, i) => s + h[i], 0);
      for (let i = 0; i < sorted.length - 1; i++) {
        leftG += g[sorted[i]];
        leftH += h[sorted[i]];
        if (i + 1 < minLeaf || sorted.length - i - 1 < minLeaf) continue;
        if (X[sorted[i]][feat] === X[sorted[i+1]][feat]) continue;
        const rightG = totalG - leftG;
        const rightH = totalH - leftH;
        const gain = (leftG*leftG)/(leftH + lambda) + (rightG*rightG)/(rightH + lambda) - (totalG*totalG)/(totalH + lambda);
        if (gain > bestGain) {
          bestGain = gain; bestFeat = feat;
          bestThr = (X[sorted[i]][feat] + X[sorted[i+1]][feat]) / 2;
          bestLeft = sorted.slice(0, i+1);
          bestRight = sorted.slice(i+1);
        }
      }
    }
    if (bestGain <= 0 || bestFeat < 0) {
      const gSum = indices.reduce((s, i) => s + g[i], 0);
      const hSum = indices.reduce((s, i) => s + h[i], 0);
      return { leaf: true, value: -gSum / (hSum + lambda) };
    }
    return { leaf: false, feat: bestFeat, thr: bestThr,
      left: buildNode(bestLeft, depth + 1), right: buildNode(bestRight, depth + 1) };
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
    // Gradient/Hessian for logistic loss
    const p = preds.map(z => sig(z));
    const g = y.map((yi, i) => p[i] - yi);
    const h = p.map(pi => pi * (1 - pi) + 1e-6);
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

// ========== Train + validate ==========
function auc(scored) {
  const sorted = [...scored].sort((a,b) => b.p - a.p);
  let tp = 0, fp = 0, prevTp = 0, prevFp = 0, area = 0;
  for (const s of sorted) {
    if (s.y === 1) tp++; else fp++;
    if (fp !== prevFp) { area += (tp + prevTp)/2 * (fp - prevFp); prevTp = tp; prevFp = fp; }
  }
  const pt = scored.filter(s => s.y === 1).length;
  const nt = scored.filter(s => s.y === 0).length;
  return area / Math.max(1, pt * nt);
}
function shuffled(a) { const x = [...a]; for (let i = x.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }

const all = [...pos, ...neg];
const featNames = Object.keys(all[0]).filter(k => !["label","conditionId","entryTs"].includes(k));
console.log(`${featNames.length} features; total=${all.length} pos=${pos.length} neg=${neg.length}`);

// Random split
const sh = shuffled(all);
const split = Math.floor(sh.length * 0.7);
const train = sh.slice(0, split);
const test = sh.slice(split);
console.log(`\nTrain: ${train.length} (pos=${train.filter(x=>x.label).length} neg=${train.filter(x=>!x.label).length})`);
console.log(`Test:  ${test.length} (pos=${test.filter(x=>x.label).length} neg=${test.filter(x=>!x.label).length})`);

console.log(`\nTraining GBDT (60 trees, depth 3, eta 0.1)...`);
const model = trainGBDT(train, featNames);
const scored = test.map(t => ({ y: t.label, p: scoreGBDT(model, t) }));
console.log(`\nGBDT random-split AUC: ${auc(scored).toFixed(4)}`);

// Market-split
const cids = [...new Set(all.map(d => d.conditionId))];
const shCids = shuffled(cids);
const trainCids = new Set(shCids.slice(0, Math.floor(shCids.length * 0.7)));
const tr2 = all.filter(d => trainCids.has(d.conditionId));
const te2 = all.filter(d => !trainCids.has(d.conditionId));
console.log(`\nMarket-split: train=${tr2.length} test=${te2.length}`);
const m2 = trainGBDT(tr2, featNames);
const s2 = te2.map(t => ({ y: t.label, p: scoreGBDT(m2, t) }));
console.log(`GBDT market-split AUC: ${auc(s2).toFixed(4)}`);

// Random-label baseline
const sh4 = shuffled(all).map((x, i) => ({ ...x, label: Math.random() < 0.5 ? 0 : 1 }));
const sp4 = Math.floor(sh4.length * 0.7);
const m4 = trainGBDT(sh4.slice(0, sp4), featNames, { nTrees: 30 });
const s4 = sh4.slice(sp4).map(t => ({ y: t.label, p: scoreGBDT(m4, t) }));
console.log(`Random-label AUC (should ~0.5): ${auc(s4).toFixed(4)}`);

// P/R at thresholds
console.log(`\nGBDT precision/recall at thresholds (random-split):`);
for (const th of [0.3, 0.5, 0.7, 0.8, 0.9]) {
  const picked = scored.filter(s => s.p >= th);
  const tp = picked.filter(s => s.y === 1).length;
  const fp = picked.filter(s => s.y === 0).length;
  const pr = (tp+fp) > 0 ? tp/(tp+fp) : 0;
  const rc = scored.filter(s => s.y === 1).length > 0 ? tp/scored.filter(s => s.y === 1).length : 0;
  console.log(`  th=${th}  picked=${picked.length} tp=${tp} fp=${fp}  precision=${(100*pr).toFixed(1)}%  recall=${(100*rc).toFixed(1)}%`);
}

// Save model (GBDT format differs)
fs.writeFileSync(path.join(OUT_DIR, "model-gbdt.json"), JSON.stringify(model));
console.log(`\nSaved: ${path.join(OUT_DIR, "model-gbdt.json")}`);
