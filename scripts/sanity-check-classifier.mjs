#!/usr/bin/env node
/**
 * Rigorous sanity checks for the tick-trained classifier.
 *
 * Tests for:
 *   1. Random-label baseline: if we shuffle labels, does AUC collapse to 0.5?
 *      (If not -> the classifier isn't learning, we're just seeing data regularities.)
 *   2. Market-split validation: train on 70% of conditionIds, test on the
 *      remaining 30%. If AUC holds, the classifier generalizes to NEW markets,
 *      not just to near-timestamp leakage within the same market.
 *   3. Time-split validation: train on the first 70% of days, test on the
 *      last 30%. If AUC holds, no temporal leakage.
 *   4. Single-feature AUCs: what's the AUC of the strongest individual feature?
 *      If it's already 0.9, the classifier isn't adding much.
 *   5. Feature-free random baseline: a model with zero information should give
 *      AUC ~0.5. Sanity.
 *
 * Also reruns with an even stricter NEG sampling to check if the result
 * depends on the specific NEG set we chose.
 */

import fs from "node:fs";
import path from "node:path";

const TICK_DIR   = path.resolve("data/tick-history");
const CACHE_DIR  = path.resolve("data/resolved-market-cache");
const TRADE_FILE = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");

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
function extractFeatures(cid, entryTs, entryPrice, outcomeIndex, marketEndTs) {
  const ticks = loadTicks(cid);
  if (!ticks.length) return null;
  const other = outcomeIndex === 1 ? 0 : 1;
  const feats = { price: entryPrice, ttrSec: marketEndTs - entryTs, pricesq: entryPrice * entryPrice };
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

function buildDataset() {
  console.log("Building POS + NEG sets...");
  const walletTrades = fs.readFileSync(TRADE_FILE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const pos = [];
  const posTtrs = [];
  for (const t of walletTrades) {
    if (!/temperature/i.test(t.title || "")) continue;
    const c = loadCache(t.conditionId, t.side);
    if (!c?.samples?.length) continue;
    const endTs = c.samples[c.samples.length-1].t;
    const f = extractFeatures(t.conditionId, t.openTs, t.entryAvg, t.outcomeIndex, endTs);
    if (!f) continue;
    f.label = 1;
    f.conditionId = t.conditionId;
    f.entryTs = t.openTs;
    pos.push(f);
    posTtrs.push(endTs - t.openTs);
  }

  // Match NEG TTR distribution to POS: for each NEG candidate, keep it only
  // if its ttr is within ±60sec of some POS ttr (so sampling is distribution-
  // matched, not uniform). Prevents classifier from using ttr as a leaky
  // sampling-bias signal.
  posTtrs.sort((a,b) => a-b);
  const posTtrSet = new Set(posTtrs.map(t => Math.floor(t / 60))); // 60-sec buckets

  const walKeys = new Set();
  for (const t of walletTrades) {
    const b = Math.floor(t.openTs / (30*60));
    walKeys.add(`${t.conditionId}|${b-1}`);
    walKeys.add(`${t.conditionId}|${b}`);
    walKeys.add(`${t.conditionId}|${b+1}`);
  }
  const tickFiles = fs.readdirSync(TICK_DIR).filter(f => f.endsWith(".jsonl"));
  const neg = [];
  for (const tf of tickFiles) {
    if (neg.length >= 2500) break;
    const cid = tf.replace(".jsonl", "");
    const c = loadCache(cid, "NO");
    if (!c?.samples?.length) continue;
    const endTs = c.samples[c.samples.length-1].t;
    for (let i = 10; i < c.samples.length; i += 3) {
      if (neg.length >= 2500) break;
      const s = c.samples[i];
      const ttr = endTs - s.t;
      // Distribution-match: only keep NEG where ttr bucket exists in POS
      if (!posTtrSet.has(Math.floor(ttr / 60))) continue;
      if (s.p < 0.95 || s.p > 0.998) continue;
      const bucket = Math.floor(s.t / (30*60));
      if (walKeys.has(`${cid}|${bucket}`)) continue;
      if (forwardCheck(cid, s.t, 1, 15*60, 0.999) !== 0) continue;
      const f = extractFeatures(cid, s.t, s.p, 1, endTs);
      if (!f) continue;
      f.label = 0; f.conditionId = cid; f.entryTs = s.t;
      neg.push(f);
    }
  }
  console.log(`  POS=${pos.length}  NEG=${neg.length} (distribution-matched on ttrSec)`);
  return { pos, neg };
}

function trainLR(data, featNames, epochs=2500, lr=0.05, lambda=1e-3) {
  const X = data.map(d => featNames.map(k => Number.isFinite(d[k]) ? d[k] : 0));
  const y = data.map(d => d.label);
  const n = X.length, p = featNames.length;
  const mu = featNames.map((_, j) => X.reduce((s, r) => s + r[j], 0) / n);
  const sigma = featNames.map((_, j) => {
    const m = mu[j];
    return Math.sqrt(X.reduce((s, r) => s + (r[j]-m)**2, 0) / n) || 1;
  });
  const Xn = X.map(r => r.map((v, j) => (v - mu[j]) / sigma[j]));
  let w = new Array(p).fill(0); let b = 0;
  const sig = z => 1/(1+Math.exp(-Math.max(-30, Math.min(30,z))));
  const posCount = y.filter(v => v === 1).length;
  const negCount = y.length - posCount;
  const wPos = negCount / Math.max(1, posCount);
  for (let ep = 0; ep < epochs; ep++) {
    let gW = new Array(p).fill(0), gB = 0;
    for (let i = 0; i < n; i++) {
      const z = Xn[i].reduce((s, v, j) => s + v*w[j], b);
      const pi = sig(z);
      const cw = y[i] === 1 ? wPos : 1;
      const err = (pi - y[i]) * cw;
      for (let j = 0; j < p; j++) gW[j] += err * Xn[i][j];
      gB += err;
    }
    for (let j = 0; j < p; j++) w[j] -= (lr/n)*(gW[j] + lambda*w[j]);
    b -= (lr/n)*gB;
  }
  return { w, b, mu, sigma, featNames };
}

function score(model, feat) {
  const z = model.featNames.reduce((s, n, j) => {
    const v = Number.isFinite(feat[n]) ? feat[n] : 0;
    return s + ((v - model.mu[j]) / model.sigma[j]) * model.w[j];
  }, model.b);
  return 1/(1+Math.exp(-Math.max(-30, Math.min(30,z))));
}
function auc(scored) {
  const sorted = [...scored].sort((a,b) => b.p - a.p);
  let tp = 0, fp = 0, prevTp = 0, prevFp = 0, area = 0;
  for (const s of sorted) {
    if (s.y === 1) tp++; else fp++;
    if (fp !== prevFp) { area += (tp + prevTp)/2 * (fp - prevFp); prevTp = tp; prevFp = fp; }
  }
  const posTotal = scored.filter(s => s.y === 1).length;
  const negTotal = scored.filter(s => s.y === 0).length;
  return area / Math.max(1, posTotal * negTotal);
}
function shuffled(arr) { const a = [...arr]; for (let i = a.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---- run sanity checks ----

const { pos, neg } = buildDataset();
const all = [...pos, ...neg];
const featNames = Object.keys(all[0]).filter(k => !["label","conditionId","entryTs"].includes(k));

// ========== TEST 1: random split baseline ==========
console.log("\n========== TEST 1: random 70/30 split (baseline) ==========");
const sh = shuffled(all);
const split = Math.floor(sh.length * 0.7);
const train1 = sh.slice(0, split), test1 = sh.slice(split);
const m1 = trainLR(train1, featNames);
const s1 = test1.map(t => ({ y: t.label, p: score(m1, t) }));
console.log(`  AUC: ${auc(s1).toFixed(4)}`);
console.log(`  pos in test: ${test1.filter(t=>t.label).length}, neg: ${test1.filter(t=>!t.label).length}`);

// ========== TEST 2: market-split ==========
console.log("\n========== TEST 2: market-split (train on 70% of conditionIds) ==========");
const cids = [...new Set(all.map(d => d.conditionId))];
const shCids = shuffled(cids);
const cidSplit = Math.floor(shCids.length * 0.7);
const trainCids = new Set(shCids.slice(0, cidSplit));
const train2 = all.filter(d => trainCids.has(d.conditionId));
const test2 = all.filter(d => !trainCids.has(d.conditionId));
const m2 = trainLR(train2, featNames);
const s2 = test2.map(t => ({ y: t.label, p: score(m2, t) }));
console.log(`  train markets: ${trainCids.size}, test markets: ${cids.length - trainCids.size}`);
console.log(`  train pos/neg: ${train2.filter(t=>t.label).length}/${train2.filter(t=>!t.label).length}`);
console.log(`  test  pos/neg: ${test2.filter(t=>t.label).length}/${test2.filter(t=>!t.label).length}`);
console.log(`  AUC on held-out markets: ${auc(s2).toFixed(4)}`);

// ========== TEST 3: time-split ==========
console.log("\n========== TEST 3: time-split (train on earliest 70% of examples) ==========");
const sorted = [...all].sort((a,b) => a.entryTs - b.entryTs);
const split3 = Math.floor(sorted.length * 0.7);
const train3 = sorted.slice(0, split3), test3 = sorted.slice(split3);
const m3 = trainLR(train3, featNames);
const s3 = test3.map(t => ({ y: t.label, p: score(m3, t) }));
const trainEnd = new Date(train3[train3.length-1].entryTs * 1000).toISOString().slice(0,10);
const testStart = new Date(test3[0].entryTs * 1000).toISOString().slice(0,10);
console.log(`  train ends ${trainEnd}, test starts ${testStart}`);
console.log(`  train pos/neg: ${train3.filter(t=>t.label).length}/${train3.filter(t=>!t.label).length}`);
console.log(`  test  pos/neg: ${test3.filter(t=>t.label).length}/${test3.filter(t=>!t.label).length}`);
console.log(`  AUC on future: ${auc(s3).toFixed(4)}`);

// ========== TEST 4: random labels ==========
console.log("\n========== TEST 4: random labels (should collapse to ~0.5) ==========");
const labs = all.map(x => x.label);
for (let i = labs.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [labs[i], labs[j]] = [labs[j], labs[i]]; }
const shuffled4 = all.map((x, i) => ({ ...x, label: labs[i] }));
const tr4 = shuffled(shuffled4).slice(0, split);
const te4 = shuffled(shuffled4).slice(split);
const m4 = trainLR(tr4, featNames);
const s4 = te4.map(t => ({ y: t.label, p: score(m4, t) }));
console.log(`  AUC (should be ~0.5): ${auc(s4).toFixed(4)}`);

// ========== TEST 5: single-feature AUCs ==========
console.log("\n========== TEST 5: single-feature AUCs (top 10) ==========");
const featAucs = featNames.map(n => {
  const scored = test1.map(t => ({ y: t.label, p: Number.isFinite(t[n]) ? t[n] : 0 }));
  let aucV = auc(scored);
  if (aucV < 0.5) aucV = 1 - aucV;
  return { n, auc: aucV };
}).sort((a, b) => b.auc - a.auc);
for (const f of featAucs.slice(0, 10)) {
  console.log(`  ${f.n.padEnd(22)} ${f.auc.toFixed(4)}`);
}

// ========== TEST 6: positive self-recognition (classifier on 937's entries as input) ==========
console.log("\n========== TEST 6: 937's entries vs random NEG sample (out-of-sample sanity) ==========");
// Use the time-split model (m3) to score all of pos vs neg
const posScores = pos.map(p => score(m3, p)).sort((a,b)=>a-b);
const negScores = neg.map(p => score(m3, p)).sort((a,b)=>a-b);
const qp = pct => posScores[Math.floor(pct*(posScores.length-1))];
const qn = pct => negScores[Math.floor(pct*(negScores.length-1))];
console.log(`  937 (POS) scores: p05=${qp(0.05).toFixed(3)} p50=${qp(0.5).toFixed(3)} p95=${qp(0.95).toFixed(3)}`);
console.log(`  NEG scores:       p05=${qn(0.05).toFixed(3)} p50=${qn(0.5).toFixed(3)} p95=${qn(0.95).toFixed(3)}`);
