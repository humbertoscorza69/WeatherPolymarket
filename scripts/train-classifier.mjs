#!/usr/bin/env node
/**
 * Train a logistic regression classifier to predict "will price hit 0.999
 * within 15 min" from tick-level microstructure features.
 *
 * POS examples: 937's 682 entries (all profitable, 100% directional win rate)
 * NEG examples: sampled candidate entries on the same markets at different
 *               times that pass the coarse filters (TTR 1-3h, price band) but
 *               where forward-looking check shows price DID NOT hit 0.999
 *               in the next 15 min.
 *
 * Features:
 *   static:       price, ttrSec, pricesqr
 *   NO-side ticks in prior 1/5/15m: n, buyPressure, whaleCount, priceRange,
 *                                    uniqueTakers, sinceLastTickSec
 *   YES-side ticks in prior 1/5/15m: same
 *
 * Output:
 *   data/classifier/model.json   (weights + feature names + threshold)
 *   stdout: AUC, precision/recall at various thresholds, feature importance
 */

import fs from "node:fs";
import path from "node:path";

const TICK_DIR   = path.resolve("data/tick-history");
const CACHE_DIR  = path.resolve("data/resolved-market-cache");
const TRADE_FILE = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");
const OUT_DIR    = path.resolve("data/classifier");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ----------------- data load -----------------

function loadTicks(conditionId) {
  const p = path.join(TICK_DIR, `${conditionId}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n")
    .filter(Boolean).map(JSON.parse)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function loadPriceCache(conditionId, side) {
  const p = path.join(CACHE_DIR, `${conditionId}-${side}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ----------------- feature extraction -----------------

/** Extract features from ticks in [ts - windowSec, ts] filtered by outcomeIndex. */
const EXCLUDE_WALLET = "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";

function windowFeatures(ticks, entryTs, windowSec, outcomeIndex) {
  const lo = entryTs - windowSec;
  // Strict < entryTs to avoid including the entry tick itself.
  // Exclude our own wallet's trades so the classifier learns from OTHER
  // participants' flow, not our own (matches production: a fresh bot has
  // no past trades of its own to reference).
  const w = ticks.filter(t =>
    t.timestamp >= lo &&
    t.timestamp < entryTs &&
    t.outcomeIndex === outcomeIndex &&
    t.proxyWallet?.toLowerCase() !== EXCLUDE_WALLET
  );
  const f = {
    n: w.length,
    buySize: 0, sellSize: 0,
    whaleCount: 0,
    uniqueTakers: 0,
    priceMin: 1, priceMax: 0,
    sinceLast: windowSec
  };
  const takers = new Set();
  for (const t of w) {
    const size = Number(t.size) || 0;
    if (t.side === "BUY") f.buySize += size;
    else f.sellSize += size;
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

function extractFeatures(conditionId, entryTs, entryPrice, outcomeIndex, marketEndTs) {
  const ticks = loadTicks(conditionId);
  if (!ticks.length) return null;

  const other = outcomeIndex === 1 ? 0 : 1; // YES if we're NO, vice versa
  // Dropped ttrSec and pricesq: ttrSec leaked (POS clusters tightly at 2h while
  // NEG spreads over 1-3h so the classifier was just re-learning the TTR filter).
  // pricesq correlates with price — redundant. Keep only true microstructure
  // features so the classifier's signal is honest.
  const feats = {
    price:  entryPrice
  };

  for (const w of [60, 5*60, 15*60]) {
    const label = w === 60 ? "1m" : w === 300 ? "5m" : "15m";
    const own = windowFeatures(ticks, entryTs, w, outcomeIndex);
    const opp = windowFeatures(ticks, entryTs, w, other);
    feats[`n_own_${label}`]        = own.n;
    feats[`buyP_own_${label}`]     = own.buyPressure;
    feats[`whale_own_${label}`]    = own.whaleCount;
    feats[`takers_own_${label}`]   = own.uniqueTakers;
    feats[`range_own_${label}`]    = own.priceRange;
    feats[`since_own_${label}`]    = Math.min(w, own.sinceLast);
    feats[`n_opp_${label}`]        = opp.n;
    feats[`buyP_opp_${label}`]     = opp.buyPressure;
    feats[`whale_opp_${label}`]    = opp.whaleCount;
  }
  return feats;
}

function forwardCheck(conditionId, entryTs, entryPrice, outcomeIndex, windowSec = 15*60, target = 0.999) {
  // Check if the SAME-side price reaches target within windowSec.
  // Use price-cache (sorted by t) as the forward oracle.
  const side = outcomeIndex === 1 ? "NO" : "YES";
  const cache = loadPriceCache(conditionId, side);
  if (!cache?.samples?.length) return null;
  for (const s of cache.samples) {
    if (s.t < entryTs) continue;
    if (s.t > entryTs + windowSec) break;
    if (s.p >= target) return 1;
  }
  return 0;
}

// ----------------- build POS / NEG sets -----------------

function buildPositives() {
  const walletTrades = fs.readFileSync(TRADE_FILE, "utf8").trim().split("\n")
    .filter(Boolean).map(JSON.parse);
  console.log(`Building POS set from ${walletTrades.length} wallet trades...`);
  const pos = [];
  for (const t of walletTrades) {
    if (!/temperature/i.test(t.title || "")) continue;
    // Need tick data AND price cache
    const cache = loadPriceCache(t.conditionId, t.side);
    if (!cache?.samples?.length) continue;
    const marketEndTs = cache.samples[cache.samples.length - 1].t;
    const f = extractFeatures(t.conditionId, t.openTs, t.entryAvg, t.outcomeIndex, marketEndTs);
    if (!f) continue;
    f.label = 1;
    f.conditionId = t.conditionId;
    f.entryTs = t.openTs;
    f.outcomeIndex = t.outcomeIndex;
    pos.push(f);
  }
  console.log(`  extracted ${pos.length} POS features`);
  return pos;
}

function buildNegatives(limit = 3000) {
  // Walk every tick-history market's NO-side price cache.
  // Sample points in TTR [1h, 3h] with price in [0.95, 0.998]
  // that are NOT near any 937 entry (> 30 min away) and where
  // forward-check confirms price did NOT reach 0.999 in next 15 min.
  const walletTrades = fs.readFileSync(TRADE_FILE, "utf8").trim().split("\n")
    .filter(Boolean).map(JSON.parse);
  const wal937Keys = new Set();
  for (const t of walletTrades) {
    // Round to 30-min buckets
    const bucket = Math.floor(t.openTs / (30*60));
    wal937Keys.add(`${t.conditionId}|${bucket - 1}`);
    wal937Keys.add(`${t.conditionId}|${bucket}`);
    wal937Keys.add(`${t.conditionId}|${bucket + 1}`);
  }

  const tickFiles = fs.readdirSync(TICK_DIR).filter(f => f.endsWith(".jsonl"));
  const neg = [];
  for (const tf of tickFiles) {
    if (neg.length >= limit) break;
    const conditionId = tf.replace(".jsonl", "");
    const noCache = loadPriceCache(conditionId, "NO");
    if (!noCache?.samples?.length) continue;
    const marketEndTs = noCache.samples[noCache.samples.length - 1].t;
    for (let i = 10; i < noCache.samples.length; i += 5) {
      if (neg.length >= limit) break;
      const s = noCache.samples[i];
      const ttr = marketEndTs - s.t;
      if (ttr < 60*60 || ttr > 3*60*60) continue;
      if (s.p < 0.95 || s.p > 0.998) continue;
      const bucket = Math.floor(s.t / (30*60));
      if (wal937Keys.has(`${conditionId}|${bucket}`)) continue;
      const forward = forwardCheck(conditionId, s.t, s.p, 1, 15*60, 0.999);
      if (forward !== 0) continue; // only keep confirmed failures
      const f = extractFeatures(conditionId, s.t, s.p, 1, marketEndTs);
      if (!f) continue;
      f.label = 0;
      f.conditionId = conditionId;
      f.entryTs = s.t;
      f.outcomeIndex = 1;
      neg.push(f);
    }
  }
  console.log(`Built NEG set: ${neg.length}`);
  return neg;
}

// ----------------- logistic regression -----------------

function trainLR(data, featNames, { epochs = 2500, lr = 0.05, lambda = 1e-3 } = {}) {
  // Build matrix
  const X = data.map(d => featNames.map(k => Number.isFinite(d[k]) ? d[k] : 0));
  const y = data.map(d => d.label);
  const n = X.length, p = featNames.length;
  // Z-normalize
  const mu = featNames.map((_, j) => X.reduce((s, r) => s + r[j], 0) / n);
  const sigma = featNames.map((_, j) => {
    const m = mu[j];
    const v = X.reduce((s, r) => s + (r[j] - m) ** 2, 0) / n;
    return Math.sqrt(v) || 1;
  });
  const Xn = X.map(r => r.map((v, j) => (v - mu[j]) / sigma[j]));

  let w = new Array(p).fill(0);
  let b = 0;
  const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

  // Class-balance weights
  const posCount = y.filter(v => v === 1).length;
  const negCount = y.length - posCount;
  const wPos = negCount / Math.max(1, posCount);
  const wNeg = 1;

  for (let ep = 0; ep < epochs; ep++) {
    let gradW = new Array(p).fill(0);
    let gradB = 0;
    let loss = 0;
    for (let i = 0; i < n; i++) {
      const z = Xn[i].reduce((s, v, j) => s + v * w[j], b);
      const pi = sigmoid(z);
      const cw = y[i] === 1 ? wPos : wNeg;
      const err = (pi - y[i]) * cw;
      for (let j = 0; j < p; j++) gradW[j] += err * Xn[i][j];
      gradB += err;
      loss += -cw * (y[i] * Math.log(pi + 1e-9) + (1 - y[i]) * Math.log(1 - pi + 1e-9));
    }
    for (let j = 0; j < p; j++) w[j] -= (lr / n) * (gradW[j] + lambda * w[j]);
    b -= (lr / n) * gradB;
    if (ep % 500 === 0) console.log(`  ep ${ep}: loss=${(loss/n).toFixed(4)}`);
  }
  return { w, b, mu, sigma, featNames };
}

function score(model, feat) {
  const z = model.featNames.reduce((s, name, j) => {
    const v = Number.isFinite(feat[name]) ? feat[name] : 0;
    const xn = (v - model.mu[j]) / model.sigma[j];
    return s + xn * model.w[j];
  }, model.b);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function auc(scored) {
  const sorted = [...scored].sort((a, b) => b.p - a.p);
  let tp = 0, fp = 0, prevTp = 0, prevFp = 0, area = 0;
  const posTotal = scored.filter(s => s.y === 1).length;
  const negTotal = scored.filter(s => s.y === 0).length;
  for (const s of sorted) {
    if (s.y === 1) tp++; else fp++;
    if (fp !== prevFp) {
      area += (tp + prevTp) / 2 * (fp - prevFp);
      prevTp = tp; prevFp = fp;
    }
  }
  return area / (posTotal * negTotal);
}

// ----------------- main -----------------

function main() {
  const pos = buildPositives();
  const neg = buildNegatives(Math.min(3000, pos.length * 3));

  const featNames = Object.keys(pos[0]).filter(k =>
    !["label","conditionId","entryTs","outcomeIndex"].includes(k));
  console.log(`\nUsing ${featNames.length} features: ${featNames.join(", ")}`);

  // Shuffle + 70/30 split
  const all = [...pos, ...neg];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const split = Math.floor(all.length * 0.7);
  const train = all.slice(0, split);
  const test = all.slice(split);
  console.log(`\nTrain: ${train.length} (pos=${train.filter(x => x.label).length} neg=${train.filter(x => !x.label).length})`);
  console.log(`Test:  ${test.length}  (pos=${test.filter(x => x.label).length} neg=${test.filter(x => !x.label).length})`);

  console.log(`\nTraining logistic regression...`);
  const model = trainLR(train, featNames, { epochs: 3000, lr: 0.05 });

  // Evaluate on test
  const scored = test.map(t => ({ y: t.label, p: score(model, t) }));
  console.log(`\nAUC: ${auc(scored).toFixed(4)}`);

  console.log(`\nPRECISION/RECALL at thresholds:`);
  for (const th of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const picked = scored.filter(s => s.p >= th);
    const tp = picked.filter(s => s.y === 1).length;
    const fp = picked.filter(s => s.y === 0).length;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = scored.filter(s => s.y === 1).length > 0 ? tp / scored.filter(s => s.y === 1).length : 0;
    console.log(`  th=${th}  picked=${picked.length} tp=${tp} fp=${fp}  precision=${(100*precision).toFixed(1)}%  recall=${(100*recall).toFixed(1)}%`);
  }

  console.log(`\nTOP FEATURES by |weight|:`);
  const imp = featNames.map((n, i) => ({ name: n, w: model.w[i] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  for (const f of imp.slice(0, 20)) console.log(`  ${f.name.padEnd(22)} ${f.w.toFixed(4)}`);

  // Save model
  const modelOut = { ...model, featNames };
  fs.writeFileSync(path.join(OUT_DIR, "model.json"), JSON.stringify(modelOut, null, 2));
  console.log(`\nSaved: ${path.join(OUT_DIR, "model.json")}`);
}

main();
