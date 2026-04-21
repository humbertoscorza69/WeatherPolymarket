#!/usr/bin/env node
/**
 * Feature-level comparison between 937's 682 entries (POSITIVE examples)
 * and our fresh-sim's timeout-flat entries (NEGATIVE examples).
 *
 * For each entry (both groups), compute:
 *   - price_at_entry
 *   - price_Nm_ago for N in {1, 3, 5, 15, 30, 60}
 *   - max_price_Nm_ago, min_price_Nm_ago
 *   - slope_Nm (linear regression over last N minutes)
 *   - n_samples_in_last_Nm (sampling density = liquidity proxy)
 *   - prior_price_stability: (max - min) / mean over last 15m
 *   - time_to_resolution (seconds)
 *   - hour_utc, day_of_week
 *   - city
 *
 * Then compare distributions feature-by-feature.
 * Surface the top discriminating features (largest KL / distribution gap).
 */

import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = path.resolve("data/resolved-market-cache");
const TRADE_FILE = path.resolve("data/wallet-trades/0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab.jsonl");

function cityFromTitle(title) {
  if (!title) return null;
  const m = title.match(/(?:temperature in|temp in) ([A-Z][\w .\-']+?)(?:\s+be|\s+on|,)/i);
  return m ? m[1].trim() : null;
}

function loadMarket(cid, side) {
  const p = path.join(CACHE_DIR, `${cid}-${side}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function slope(pts) {
  const n = pts.length;
  if (n < 2) return 0;
  const meanT = pts.reduce((s, p) => s + p.t, 0) / n;
  const meanP = pts.reduce((s, p) => s + p.p, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.t - meanT) * (p.p - meanP); den += (p.t - meanT) ** 2; }
  return den > 0 ? num / den : 0;
}

function extractFeatures(samples, entryIdx, marketEndTs) {
  const entry = samples[entryIdx];
  const feats = {
    price: entry.p,
    ttrSec: marketEndTs - entry.t,
    hour: new Date(entry.t * 1000).getUTCHours(),
    dow: new Date(entry.t * 1000).getUTCDay()
  };

  for (const minsBack of [1, 3, 5, 15, 30, 60]) {
    const sinceT = entry.t - minsBack * 60;
    const window = [];
    // Walk backward
    for (let i = entryIdx - 1; i >= 0; i--) {
      if (samples[i].t < sinceT) break;
      window.push(samples[i]);
    }
    window.reverse();
    if (!window.length) {
      feats[`n${minsBack}m`] = 0;
      feats[`p${minsBack}mAgo`] = entry.p;
      feats[`max${minsBack}m`] = entry.p;
      feats[`min${minsBack}m`] = entry.p;
      feats[`range${minsBack}m`] = 0;
      feats[`slope${minsBack}m`] = 0;
      continue;
    }
    feats[`n${minsBack}m`] = window.length;
    feats[`p${minsBack}mAgo`] = window[0].p;
    feats[`max${minsBack}m`] = Math.max(...window.map(x => x.p));
    feats[`min${minsBack}m`] = Math.min(...window.map(x => x.p));
    feats[`range${minsBack}m`] = feats[`max${minsBack}m`] - feats[`min${minsBack}m`];
    feats[`slope${minsBack}m`] = slope([...window, entry]);
    feats[`deltaFromMax${minsBack}m`] = entry.p - feats[`max${minsBack}m`];
    feats[`deltaFromMin${minsBack}m`] = entry.p - feats[`min${minsBack}m`];
  }
  return feats;
}

function percentiles(arr) {
  if (!arr.length) return {};
  const s = [...arr].sort((a, b) => a - b);
  const q = p => s[Math.floor(p * (s.length - 1))];
  return { p05: q(0.05), p25: q(0.25), p50: q(0.50), p75: q(0.75), p95: q(0.95), mean: s.reduce((x,y)=>x+y,0)/s.length };
}

function compareDists(pos, neg, featNames) {
  console.log("\nFEATURE DISTRIBUTION COMPARISON");
  console.log("(POS = 937 real entries, N=" + pos.length + ";  NEG = fresh-sim failed entries, N=" + neg.length + ")");
  console.log();
  const rows = [];
  for (const name of featNames) {
    const p = percentiles(pos.map(f => f[name]).filter(Number.isFinite));
    const n = percentiles(neg.map(f => f[name]).filter(Number.isFinite));
    if (!Number.isFinite(p.p50) || !Number.isFinite(n.p50)) continue;
    // Discriminator score: |p50 difference| / std of combined
    const combined = [...pos.map(f => f[name]), ...neg.map(f => f[name])].filter(Number.isFinite);
    const meanAll = combined.reduce((x,y)=>x+y,0) / combined.length;
    const std = Math.sqrt(combined.reduce((s,x) => s + (x - meanAll)**2, 0) / combined.length);
    const score = std > 0 ? Math.abs(p.p50 - n.p50) / std : 0;
    rows.push({ name, pos: p, neg: n, score });
  }
  rows.sort((a, b) => b.score - a.score);
  console.log("feature".padEnd(22), "POS p50".padStart(10), "NEG p50".padStart(10), "gap-score".padStart(10));
  for (const r of rows.slice(0, 20)) {
    const format = v => Number.isFinite(v) ? v.toFixed(5) : "-";
    console.log(
      r.name.padEnd(22),
      format(r.pos.p50).padStart(10),
      format(r.neg.p50).padStart(10),
      r.score.toFixed(3).padStart(10)
    );
  }
  return rows;
}

function main() {
  // -------- POSITIVE: extract features at 937's actual entries --------
  const trades = fs.readFileSync(TRADE_FILE, "utf8").trim().split("\n").map(JSON.parse);
  const pos = [];
  for (const t of trades) {
    if (!/temperature/i.test(t.title || "")) continue;
    const m = loadMarket(t.conditionId, t.side);
    if (!m || !m.samples?.length) continue;
    const marketEndTs = m.samples[m.samples.length - 1].t;
    // Find sample index closest to t.openTs
    let idx = -1, best = Infinity;
    for (let i = 0; i < m.samples.length; i++) {
      const d = Math.abs(m.samples[i].t - t.openTs);
      if (d < best) { best = d; idx = i; }
    }
    if (idx < 0 || best > 120) continue; // require sample within 2 min of entry
    const f = extractFeatures(m.samples, idx, marketEndTs);
    f.label = "POS";
    f.city = cityFromTitle(t.title);
    f.actualPnl = t.pnlUsdc;
    f.actualHold = t.holdMinutes;
    pos.push(f);
  }
  console.log(`POS features extracted: ${pos.length} of ${trades.length} trades`);

  // -------- NEGATIVE: extract features from markets where 937 did NOT enter
  // but our naive fresh-sim filter would fire (hour+price+ttr+city).
  // Sample negatives from the full weather-NO cache at the same
  // time-of-day windows, filter to 1-3h TTR, band 0.95-0.998, whitelist cities.
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith("-NO.json"));
  const neg = [];
  // Index 937's actual entries by (conditionId, approx-time) for fast negative filtering
  const posKeys = new Set(trades.map(t => `${t.conditionId}|${Math.floor(t.openTs / 60)}`));
  for (const f of files) {
    const m = loadMarket(f.replace("-NO.json", ""), "NO");
    if (!m || !m.samples?.length) continue;
    if (!/temperature/i.test(m.title || "")) continue;
    const city = cityFromTitle(m.title);
    const marketEndTs = m.samples[m.samples.length - 1].t;
    for (let i = 5; i < m.samples.length; i += 3) { // sparse walk
      const s = m.samples[i];
      // Only TTR-window and price-band filters — no hour/city filter
      if (s.p < 0.95 || s.p > 0.998) continue;
      const ttr = marketEndTs - s.t;
      if (ttr < 60*60 || ttr > 3*60*60) continue;
      // Exclude points near 937's actual entries
      const key = `${m.conditionId}|${Math.floor(s.t / 60)}`;
      if (posKeys.has(key)) continue;
      // Also exclude points within 2 min of ANY 937 entry on same market (dedup)
      const near = trades.some(t => t.conditionId === m.conditionId && Math.abs(t.openTs - s.t) < 120);
      if (near) continue;
      const feat = extractFeatures(m.samples, i, marketEndTs);
      feat.label = "NEG";
      feat.city = city;
      // Forward-check: is this a WOULD-BE failure? compute sim PnL at 15min maxhold
      const windowEnd = s.t + 15 * 60;
      let simResult = "timeout";
      let simExit = s.p;
      for (let j = i + 1; j < m.samples.length && m.samples[j].t <= windowEnd; j++) {
        if (m.samples[j].p >= 0.999) { simResult = "hit"; simExit = 0.999; break; }
      }
      feat.simResult = simResult;
      feat.simExit = simExit;
      feat.simPnl = simResult === "hit" ? (0.999 - s.p) : 0; // per-share
      neg.push(feat);
    }
  }
  console.log(`NEG features extracted: ${neg.length} candidate entries (${neg.filter(n => n.simResult === "timeout").length} would fail)`);

  // Only use NEG that would have FAILED to fit our purpose (fresh-sim bad entries)
  const negFailed = neg.filter(n => n.simResult === "timeout");
  console.log(`NEG failing entries (for comparison): ${negFailed.length}`);

  // -------- Compare distributions --------
  const featNames = [
    "price", "ttrSec", "hour",
    "p1mAgo", "p3mAgo", "p5mAgo", "p15mAgo", "p30mAgo", "p60mAgo",
    "max1m", "max3m", "max5m", "max15m", "max30m", "max60m",
    "min1m", "min3m", "min5m", "min15m", "min30m", "min60m",
    "range1m", "range3m", "range5m", "range15m", "range30m", "range60m",
    "slope1m", "slope5m", "slope15m", "slope30m", "slope60m",
    "deltaFromMax5m", "deltaFromMax15m", "deltaFromMax30m",
    "deltaFromMin5m", "deltaFromMin15m", "deltaFromMin30m",
    "n1m", "n5m", "n15m", "n30m", "n60m"
  ];
  compareDists(pos, negFailed, featNames);

  // City-level: which cities have the best POS-NEG separation?
  console.log("\n\nPER-CITY split:");
  const cities = new Map();
  for (const p of pos) {
    if (!cities.has(p.city)) cities.set(p.city, { pos: 0, neg: 0, posHitRate: 0 });
    cities.get(p.city).pos += 1;
  }
  for (const n of negFailed) {
    if (!cities.has(n.city)) cities.set(n.city, { pos: 0, neg: 0, posHitRate: 0 });
    cities.get(n.city).neg += 1;
  }
  for (const [city, b] of cities) {
    const ratio = b.pos / Math.max(1, b.pos + b.neg);
    console.log(`  ${(city||"?").padEnd(20)} pos=${b.pos} neg=${b.neg} posRate=${(100*ratio).toFixed(1)}%`);
  }
}

main();
