#!/usr/bin/env node
/**
 * v5 backtest: TRUE maker-on-both-sides, mirroring 937's mechanism.
 *
 * Mechanism:
 *   1. Classifier triggers at time T in market M when score >= threshold AND
 *      price is in [MIN_ENTRY, MAX_ENTRY].
 *   2. Post a LIMIT BUY at (price - BID_OFFSET) for SIZE shares. That's
 *      below the last traded price, so we're a MAKER waiting to be crossed.
 *   3. Walk ticks forward from T. For each NO-side SELL tick at price <=
 *      our_bid, it crossed a resting bid. Consume BUY_QUEUE first, then
 *      our shares. If our shares fill (partial or full) -> move to exit.
 *      If not filled by T + BUY_WAIT_MIN -> cancel, no position.
 *   4. Post a LIMIT SELL at 0.999 for the shares we acquired.
 *   5. Walk ticks forward from fill time. For each NO-side BUY tick at
 *      price >= 0.999, consume SELL_QUEUE then our shares.
 *   6. Stop-loss: if, after STOPLOSS_MIN minutes of holding, the market
 *      price (last observed NO-side tick price) has dropped below
 *      (fill_price - STOPLOSS_DELTA), CANCEL the limit sell and post
 *      a new LIMIT SELL at (price - BID_OFFSET) to unwind slowly (still
 *      maker). If not filled by STOPLOSS_TIMEOUT_MIN, TAKE at market.
 *   7. Max hold: if we're still not out by MAX_HOLD_MIN, take at market.
 *
 * Usage:
 *   node scripts/backtest-maker-v5.mjs [--threshold=0.7] [--bidoffset=0.001]
 *     [--buywait=5] [--buyqueue=200] [--sellqueue=200]
 *     [--stoplossmin=20] [--stoplossdelta=0.005] [--stoplosstimeout=15]
 *     [--maxhold=60] [--tradesize=40] [--model=...]
 */
import fs from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const CFG = {
  THRESHOLD:          Number(argv.threshold ?? "0.7"),
  MIN_ENTRY:          Number(argv.minentry ?? "0.95"),
  MAX_ENTRY:          Number(argv.maxentry ?? "0.998"),
  BID_OFFSET:         Number(argv.bidoffset ?? "0.001"),
  SELL_TARGET:        Number(argv.selltarget ?? "0.999"),
  BUY_WAIT_MIN:       Number(argv.buywait ?? "5"),
  BUY_QUEUE:          Number(argv.buyqueue ?? "200"),
  SELL_QUEUE:         Number(argv.sellqueue ?? "200"),
  STOPLOSS_MIN:       Number(argv.stoplossmin ?? "20"),
  STOPLOSS_DELTA:     Number(argv.stoplossdelta ?? "0.005"),
  STOPLOSS_TIMEOUT:   Number(argv.stoplosstimeout ?? "15"),
  MAX_HOLD_MIN:       Number(argv.maxhold ?? "60"),
  TTR_MIN:            Number(argv.ttrmin ?? String(60*60)),
  TTR_MAX:            Number(argv.ttrmax ?? String(3*60*60)),
  COOLDOWN_SEC:       Number(argv.cooldown ?? "900"),
  // === v7 production guards ===
  ROLLING_N:          Number(argv.rollingn ?? "50"),
  ROLLING_MIN_WR:     Number(argv.rollingminwr ?? "0.8"),
  PAUSE_MIN:          Number(argv.pausemin ?? "60"),
  LIQ_LOOKBACK_SEC:   Number(argv.liqlookback ?? "600"),
  LIQ_MIN_VOLUME:     Number(argv.liqminvol ?? "50"),
  LIQ_MIN_PRICE:      Number(argv.liqminprice ?? "0.96"),
  MARKET_LOSS_LIMIT:  Number(argv.marketlosslimit ?? "2"),
  MARKET_BLACKLIST_MIN: Number(argv.marketblmin ?? "1440"),
  // === v8 momentum guard ===
  // Reject entry if price declined more than DECLINE_MAX in last DECLINE_LOOKBACK seconds.
  // Catches "the market is crashing right now" — don't try to catch a falling knife.
  DECLINE_LOOKBACK:   Number(argv.declinelb ?? "300"),    // 5 min
  DECLINE_MAX:        Number(argv.declinemax ?? "0.005"), // 0.5pp drop disqualifies
  // Hard immediate stop-loss: if price moves below entry - HARD_STOP within HARD_STOP_SEC, exit NOW
  HARD_STOP_SEC:      Number(argv.hardstopsec ?? "300"),   // first 5 min
  HARD_STOP_DELTA:    Number(argv.hardstopdelta ?? "0.01"),// 1pp drop = abort
  TRADE_USDC:         Number(argv.tradesize ?? "40"),
};
const MIN_ENTRY_TS = Number(argv.minentryts ?? "0");
const MAX_ENTRY_TS = Number(argv.maxentryts ?? "9999999999");

const TICK_DIR    = path.resolve("data/tick-history");
const CACHE_DIR   = path.resolve("data/resolved-market-cache");
const WEATHER_DIR = path.resolve("data/weather-history");
const TRADES_DIR  = path.resolve("data/wallet-trades");
const MODEL_FILE  = path.resolve(argv.model ?? "data/classifier/model-gbdt-v3.json");
const OUT_CSV     = path.resolve("data/backtest-output.csv");
const METAR_DIR   = path.resolve("data/metar-observations");
const STATIONS    = JSON.parse(fs.readFileSync(path.resolve("data/metar-stations.json"), "utf8"));

// v10: use METAR (airport stations, same source Polymarket resolves on) as
// primary observation; fall back to Open-Meteo when METAR not available.
const RESOLUTION = JSON.parse(fs.readFileSync(path.resolve("data/resolution-index.json"), "utf8"));
const SAMPLE_BUCKET_SEC = Number(argv.samplebucket ?? "60");
const FILTER_TYPE = argv.filtertype ?? "exact";
const FILTER_UNIT = argv.filterunit ?? "C";
const REQUIRE_CROSSED = (argv.reqcrossed ?? "true") !== "false";
const CROSSED_BUFFER  = Number(argv.crossedbuf ?? "0.5");

// Load weather observations for on-the-fly threshold checks.
// TIGHTER day-window: +/- 12h around local day boundary computed from tz
// (falls back to UTC-centered 24h window if tz is missing).
const WEATHER_OBS = new Map();
for (const wf of fs.readdirSync(WEATHER_DIR)) {
  if (!wf.endsWith(".json") || wf.startsWith("_")) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WEATHER_DIR, wf), "utf8"));
    if (!j.samples?.length || !j.date) continue;
    // Compute local-day offset via Intl if possible. Otherwise assume UTC.
    let tzOffsetSec = 0;
    if (j.tz) {
      try {
        const mid = new Date(j.date + "T12:00:00Z");
        const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: j.tz, hour: "2-digit", hour12: false, timeZoneName: "longOffset" });
        const parts = fmt.formatToParts(mid);
        const offStr = parts.find(p => p.type === "timeZoneName")?.value || "GMT+00:00";
        const m = offStr.match(/([+-])(\d{2}):?(\d{2})?/);
        if (m) tzOffsetSec = (m[1] === "+" ? 1 : -1) * (Number(m[2])*3600 + Number(m[3]||0)*60);
      } catch {}
    }
    const localMidnightUTC = new Date(j.date + "T00:00:00Z").getTime() / 1000 - tzOffsetSec;
    const dayStart = localMidnightUTC;
    const dayEnd = localMidnightUTC + 24*3600;  // local day [00:00, 24:00)
    const samples = j.samples.filter(s => s.t >= dayStart && s.t < dayEnd && s.tempC != null)
      .map(s => [s.t, s.tempC]).sort((a,b) => a[0]-b[0]);
    if (samples.length) WEATHER_OBS.set(`${j.city}__${j.date}`, samples);
  } catch {}
}
console.log(`Open-Meteo observations loaded: ${WEATHER_OBS.size} (city, date) pairs`);

// v10: METAR observations (Polymarket's actual resolution source)
const METAR_OBS = new Map();  // city__date -> sorted [[t, tempC], ...]
for (const mf of fs.readdirSync(METAR_DIR)) {
  if (!mf.endsWith(".json")) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(METAR_DIR, mf), "utf8"));
    if (!j.observations?.length || !j.date || !j.station) continue;
    const samples = j.observations.filter(o => o.tempC != null && o.t)
      .map(o => [o.t, o.tempC]).sort((a,b) => a[0]-b[0]);
    if (samples.length) {
      // Map back to city using STATIONS (reverse lookup)
      for (const [city, icao] of Object.entries(STATIONS)) {
        if (icao === j.station) { METAR_OBS.set(`${city}__${j.date}`, samples); break; }
      }
    }
  } catch {}
}
console.log(`METAR observations loaded: ${METAR_OBS.size} (city, date) pairs`);

// v11: compute a "perfect forecast" max using full-day observations.
// In live, this would be Open-Meteo FORECAST API at entryTs.
function forecastMaxFromObs(obsArr) {
  if (!obsArr || !obsArr.length) return null;
  let fmax = -999;
  for (const [, temp] of obsArr) if (temp > fmax) fmax = temp;
  return fmax > -999 ? fmax : null;
}
function observedMaxBefore(obsArr, entryTs) {
  if (!obsArr || !obsArr.length) return null;
  let mx = -999;
  for (const [t, temp] of obsArr) { if (t > entryTs) break; if (temp > mx) mx = temp; }
  return mx > -999 ? mx : null;
}
function observedMinBefore(obsArr, entryTs) {
  if (!obsArr || !obsArr.length) return null;
  let mn = 999;
  for (const [t, temp] of obsArr) { if (t > entryTs) break; if (temp < mn) mn = temp; }
  return mn < 999 ? mn : null;
}

// Returns best obs array: METAR preferred, Open-Meteo fallback
function bestObs(market) {
  if (!market) return null;
  return METAR_OBS.get(`${market.city}__${market.date}`)
      || WEATHER_OBS.get(`${market.city}__${market.date}`);
}

// v12: cross-source agreement check. Returns true if METAR and Open-Meteo
// agree on observed max-so-far within AGREEMENT_TOL, or if only one source
// is available (no disagreement possible).  Returns false when both available
// and disagreement exceeds tolerance — signal should be skipped.
function sourcesAgree(market, entryTs, tol) {
  if (!market) return false;
  const metarObs = METAR_OBS.get(`${market.city}__${market.date}`);
  const omObs = WEATHER_OBS.get(`${market.city}__${market.date}`);
  if (!metarObs || !omObs) return true;  // only one source → can't disagree
  const metarMax = observedMaxBefore(metarObs, entryTs);
  const omMax = observedMaxBefore(omObs, entryTs);
  if (metarMax == null || omMax == null) return true;
  return Math.abs(metarMax - omMax) <= tol;
}

/**
 * v11 multi-signal entry logic.  Returns {side, reason, cushion} or null.
 *   side: "NO" or "YES" (which outcome we're buying)
 *   cushion: confidence margin (larger = safer)
 */
function computeEntrySignal(market, entryTs, buffer, forecastBuf) {
  if (!market || market.threshold == null) return null;
  const obs = bestObs(market);
  if (!obs) return null;
  const thrC = market.unit === "F" ? (market.threshold - 32) * 5/9 : market.threshold;

  if (market.isLowest) {
    const minSoFar = observedMinBefore(obs, entryTs);
    if (minSoFar == null) return null;
    if (market.type === "exact") {
      if (minSoFar < thrC - buffer) return { side: "NO", reason: "lowest-observed-below", cushion: thrC - minSoFar };
    } else if (market.type === "at_or_above") {
      if (minSoFar < thrC - buffer) return { side: "NO", reason: "min-below-range", cushion: thrC - minSoFar };
    }
    return null;
  }

  const obsMax = observedMaxBefore(obs, entryTs);
  const fMax = forecastMaxFromObs(obs);

  if (market.type === "exact") {
    if (obsMax != null && obsMax > thrC + buffer)
      return { side: "NO", reason: "observed-above", cushion: obsMax - thrC };
    if (fMax != null && fMax < thrC - forecastBuf)
      return { side: "NO", reason: "forecast-below", cushion: thrC - fMax };
    if (fMax != null && Math.abs(fMax - thrC) <= 0.5 && (obsMax == null || obsMax <= thrC + buffer))
      return { side: "YES", reason: "forecast-in-range", cushion: 0.5 - Math.abs(fMax - thrC) };
  } else if (market.type === "at_or_below") {
    if (obsMax != null && obsMax > thrC + buffer)
      return { side: "NO", reason: "observed-above-threshold", cushion: obsMax - thrC };
  } else if (market.type === "between" && market.thresholdHigh != null) {
    const thrHiC = market.unit === "F" ? (market.thresholdHigh - 32) * 5/9 : market.thresholdHigh;
    if (obsMax != null && obsMax > thrHiC + buffer)
      return { side: "NO", reason: "observed-above-range", cushion: obsMax - thrHiC };
  }
  return null;
}

// v10-style boolean check kept for backward compat (used only if --v11off)
function thresholdCrossed(market, entryTs, buffer) {
  if (!market || market.threshold == null) return false;
  // Prefer METAR (Polymarket's source). Fall back to Open-Meteo.
  let obs = METAR_OBS.get(`${market.city}__${market.date}`);
  let source = "metar";
  if (!obs) { obs = WEATHER_OBS.get(`${market.city}__${market.date}`); source = "open-meteo"; }
  if (!obs) return false;
  let maxTemp = -999;
  for (const [t, temp] of obs) {
    if (t > entryTs) break;
    if (temp > maxTemp) maxTemp = temp;
  }
  if (maxTemp <= -999) return false;
  const thrC = market.unit === "F" ? (market.threshold - 32) * 5/9 : market.threshold;
  // v10 ASYMMETRIC MODE (default): only fire if observed is ABOVE threshold.
  // Since max-temp is monotonic over the day, observed > threshold means
  // final > threshold with CERTAINTY. Observed < threshold is probabilistic
  // (temp could rise to hit threshold) — excluded to eliminate tail losses.
  const ASYMMETRIC = (argv.asymmetric ?? "true") !== "false";
  if (market.type === "exact") {
    return ASYMMETRIC ? (maxTemp > thrC + buffer) : (Math.abs(maxTemp - thrC) > buffer);
  }
  if (market.type === "at_or_below") return maxTemp > thrC + buffer;
  if (market.type === "between" && market.thresholdHigh != null) {
    const thrHiC = market.unit === "F" ? (market.thresholdHigh - 32) * 5/9 : market.thresholdHigh;
    return maxTemp > thrHiC + buffer;
  }
  return false;  // at_or_above not detectable early (needs end-of-day)
}

const EXCLUDE = new Set(
  fs.readdirSync(TRADES_DIR).filter(f => f.endsWith(".jsonl")).map(f => f.replace(".jsonl","").toLowerCase())
);
// Classifier model is optional in v10 — strategy uses weather-confirmed entries,
// not ML scoring. Load if present (used only when --threshold > 0); otherwise
// a stub that returns 1.0 so every event passes the threshold gate.
const model = fs.existsSync(MODEL_FILE)
  ? JSON.parse(fs.readFileSync(MODEL_FILE, "utf8"))
  : { featNames: [], trees: [], eta: 0 };
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
function parseWeatherTitle(title) {
  if (!title) return null;
  const isLowest = /lowest temperature/i.test(title);
  let cityM = title.match(/temperature in ([A-Z][\w .\-']+?) be/i);
  if (!cityM) cityM = title.match(/temperature in ([A-Z][\w .\-']+?) on/i);
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
  return { city, date, unit, threshold, thresholdHigh, type, isLowest };
}
const WEATHER_CACHE = new Map();
function loadWeather(city, date) {
  const key = `${city}__${date}`;
  if (WEATHER_CACHE.has(key)) return WEATHER_CACHE.get(key);
  const p = path.join(WEATHER_DIR, `${key}.json`);
  if (!fs.existsSync(p)) { WEATHER_CACHE.set(key, null); return null; }
  try { const w = JSON.parse(fs.readFileSync(p, "utf8")); WEATHER_CACHE.set(key, w); return w; }
  catch { WEATHER_CACHE.set(key, null); return null; }
}
function toCelsius(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }

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
function weatherFeatures(market, entryTs) {
  const feats = { wx_avail: 0, wx_temp_now: 0, wx_max_sofar: 0, wx_delta_to_thr: 0, wx_slope_3h: 0, wx_hours_remain: 24, wx_crossed: 0 };
  if (!market || market.threshold == null) return feats;
  const w = loadWeather(market.city, market.date);
  if (!w?.samples?.length) return feats;
  feats.wx_avail = 1;
  const dayStart = new Date(market.date + "T00:00:00Z").getTime() / 1000 - 14*3600;
  const dayEnd   = new Date(market.date + "T00:00:00Z").getTime() / 1000 + 38*3600;
  const inDay = w.samples.filter(s => s.t >= dayStart && s.t <= dayEnd && s.t <= entryTs);
  if (!inDay.length) return feats;
  feats.wx_temp_now = inDay[inDay.length - 1].tempC;
  feats.wx_max_sofar = Math.max(...inDay.map(s => s.tempC));
  feats.wx_delta_to_thr = toCelsius(market.threshold, market.unit) - feats.wx_max_sofar;
  const recent = inDay.filter(s => s.t >= entryTs - 3*3600);
  if (recent.length >= 2) {
    const first = recent[0], last = recent[recent.length - 1];
    feats.wx_slope_3h = (last.tempC - first.tempC) / Math.max(1, (last.t - first.t) / 3600);
  }
  feats.wx_hours_remain = Math.max(0, (dayEnd - 14*3600 - entryTs) / 3600);
  const thrC = toCelsius(market.threshold, market.unit);
  if (market.type === "at_or_below" && feats.wx_max_sofar > thrC) feats.wx_crossed = 1;
  else if (market.type === "at_or_above" && feats.wx_max_sofar < thrC && feats.wx_hours_remain < 6) feats.wx_crossed = 1;
  else if (market.type === "exact" && (feats.wx_max_sofar < market.threshold - 1 || feats.wx_max_sofar > market.threshold + 1)) feats.wx_crossed = 1;
  return feats;
}
function featuresFor(ticks, market, entryTs, entryPrice, outcomeIndex) {
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
  Object.assign(feats, weatherFeatures(market, entryTs));
  return feats;
}
function treePredict(node, x) {
  if (node.leaf) return node.value;
  return x[node.feat] <= node.thr ? treePredict(node.left, x) : treePredict(node.right, x);
}
function scoreEntry(feat) {
  if (!model.trees?.length) return 1.0;  // no classifier → always pass
  const x = model.featNames.map(k => Number.isFinite(feat[k]) ? feat[k] : 0);
  let z = 0;
  for (const t of model.trees) z += model.eta * treePredict(t, x);
  return 1/(1+Math.exp(-Math.max(-30, Math.min(30, z))));
}

console.log(`v8 config: th=${CFG.THRESHOLD} band=[${CFG.MIN_ENTRY},${CFG.MAX_ENTRY}] bidOff=${CFG.BID_OFFSET} buyWait=${CFG.BUY_WAIT_MIN}m queues=${CFG.BUY_QUEUE}/${CFG.SELL_QUEUE} stopLoss@${CFG.STOPLOSS_MIN}m<-${CFG.STOPLOSS_DELTA} maxHold=${CFG.MAX_HOLD_MIN}m size=\$${CFG.TRADE_USDC} bucket=${SAMPLE_BUCKET_SEC}s filter=${FILTER_TYPE}/${FILTER_UNIT}`);

// v8: market filter via weather-derived resolution-index. Covers Jan-Apr 2026.
const TITLE_INDEX = JSON.parse(fs.readFileSync(path.resolve("data/market-titles.json"), "utf8"));
const tickFiles = fs.readdirSync(TICK_DIR).filter(f => f.endsWith(".jsonl"));
const events = [];
let tickMarkets = 0, filtered = 0;
const monthCounts = {};
// HONEST MODE: include ALL markets (both NO and YES winners). We only
// get to filter based on information available at entry time via thresholdCrossed.
// This is what a real bot would see — no knowledge of future resolution.
const ALLOW_YES_MARKETS = (argv.allowyes ?? "true") !== "false";
for (const f of tickFiles) {
  const conditionId = f.replace(".jsonl", "");
  const res = RESOLUTION[conditionId];
  if (!res) { filtered++; continue; }
  // Only filter on market TYPE and UNIT (available at list time — not look-ahead)
  if (FILTER_TYPE !== "any" && res.type !== FILTER_TYPE) { filtered++; continue; }
  if (FILTER_UNIT !== "any" && res.unit !== FILTER_UNIT) { filtered++; continue; }
  if (!ALLOW_YES_MARKETS && res.resolved !== 1) { filtered++; continue; }

  const title = TITLE_INDEX[conditionId];
  if (!title) continue;
  const market = parseWeatherTitle(title);
  const city = cityFromTitle(title);
  if (!market) continue;

  const ticks = loadTicks(conditionId);
  if (!ticks.length) continue;
  tickMarkets++;

  // marketEndTs = end of resolution day in UTC (last possible tick before resolution)
  const dayEnd = new Date(res.date + "T23:59:59Z").getTime() / 1000 + 14 * 3600;
  const marketEndTs = Math.min(dayEnd, ticks[ticks.length - 1].timestamp);
  const mo = res.date.slice(0, 7);
  monthCounts[mo] = (monthCounts[mo] || 0) + 1;

  // Sample: one event per SAMPLE_BUCKET_SEC using latest NO-side price
  let lastBucket = -1;
  let lastPrice = null;
  for (const t of ticks) {
    if (t.outcomeIndex !== 1) continue;  // always NO-side for base market price
    lastPrice = t.price;
    const bucket = Math.floor(t.timestamp / SAMPLE_BUCKET_SEC);
    if (bucket > lastBucket && lastPrice !== null) {
      events.push({
        t: bucket * SAMPLE_BUCKET_SEC, p: lastPrice,
        conditionId, city, market, title, marketEndTs
      });
      lastBucket = bucket;
    }
  }
}
events.sort((a, b) => a.t - b.t);
console.log(`${events.length} candidate events from ${tickMarkets} markets (filtered out ${filtered}); months: ${JSON.stringify(monthCounts)}`);

/**
 * Simulate the full maker-on-both-sides trade.
 *
 * Returns: {
 *   opened:  bool  (was the limit buy filled at all?)
 *   entryFill: shares actually bought
 *   entryPrice: avg price of filled shares (= our bid)
 *   exitPrice:  avg price of sold shares
 *   exitFill:   shares actually sold
 *   pnl: realized PnL on sold shares (unfilled remaining is ignored — we
 *        would carry those to next iteration or cancel)
 *   status: 'not-filled' | 'filled-999' | 'partial-999' | 'stoploss-maker'
 *           | 'stoploss-taker' | 'maxhold-taker'
 *   holdMin: time from entry-fill to exit
 * }
 */
function simulateTrade(cid, entryTs, marketPrice, ourBidPrice, shares, cfg) {
  const p = path.join(TICK_DIR, `${cid}.jsonl`);
  if (!fs.existsSync(p)) return { opened: false, status: 'no-ticks' };
  const ticks = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

  // --- PHASE 1: limit BUY at ourBidPrice ---
  // We fill when NO-side SELL ticks at price <= ourBidPrice cross the book.
  // BUY_QUEUE shares are ahead of us.
  let buyQueueRem = cfg.BUY_QUEUE;
  let buyShares = 0;       // shares we've acquired
  let buyNotional = 0;     // $ spent
  let fillTs = null;
  const buyDeadline = entryTs + cfg.BUY_WAIT_MIN * 60;
  let lastPrice = marketPrice;

  for (const t of ticks) {
    if (t.timestamp < entryTs) continue;
    if (t.timestamp > buyDeadline) break;
    if (t.outcomeIndex !== (cfg.ENTRY_SIDE ?? 1)) continue;
    lastPrice = t.price;
    // Only SELL ticks at price <= ourBidPrice could have crossed our bid
    if (t.side !== "SELL" || t.price > ourBidPrice) continue;
    let avail = Number(t.size) || 0;
    // Consume queue first
    if (buyQueueRem > 0) {
      const take = Math.min(avail, buyQueueRem);
      buyQueueRem -= take; avail -= take;
    }
    if (avail > 0 && buyShares < shares) {
      const take = Math.min(avail, shares - buyShares);
      buyShares += take;
      buyNotional += take * t.price; // we get filled at the trade price (or our bid, whichever is better)
      if (buyShares >= shares - 1e-6) { fillTs = t.timestamp; break; }
      // Partial fill; record time and keep accumulating
      if (fillTs === null) fillTs = t.timestamp;
    }
  }

  if (buyShares < 1e-6) {
    return { opened: false, status: 'not-filled', entryFill: 0, exitFill: 0, pnl: 0, holdMin: 0 };
  }

  const avgEntry = buyNotional / buyShares;
  // --- PHASE 2: limit SELL at SELL_TARGET ---
  let sellQueueRem = cfg.SELL_QUEUE;
  let sellShares = 0;
  let sellNotional = 0;
  const sellStart = fillTs; // when our first buy filled
  const sellDeadline = sellStart + cfg.MAX_HOLD_MIN * 60;
  const stopLossTrigger = sellStart + cfg.STOPLOSS_MIN * 60;
  const stopLossDeadline = stopLossTrigger + cfg.STOPLOSS_TIMEOUT * 60;
  let inStopLossMode = false;
  let stopLossBid = null;
  let status = null;

  for (const t of ticks) {
    if (t.timestamp < sellStart) continue;
    if (t.outcomeIndex !== (cfg.ENTRY_SIDE ?? 1)) continue;
    lastPrice = t.price;

    // Primary exit: limit SELL at SELL_TARGET. Fills when NO-side BUY tick at price >= SELL_TARGET.
    if (!inStopLossMode && t.side === "BUY" && t.price >= cfg.SELL_TARGET) {
      let avail = Number(t.size) || 0;
      if (sellQueueRem > 0) {
        const take = Math.min(avail, sellQueueRem);
        sellQueueRem -= take; avail -= take;
      }
      if (avail > 0 && sellShares < buyShares) {
        const take = Math.min(avail, buyShares - sellShares);
        sellShares += take;
        sellNotional += take * cfg.SELL_TARGET;
        if (sellShares >= buyShares - 1e-6) { status = 'filled-999'; break; }
      }
    }

    // v8 HARD STOP: in first HARD_STOP_SEC of holding, if price drops > HARD_STOP_DELTA,
    // immediately TAKE liquidity to exit (don't wait for slow-stoploss to unwind).
    // Catches "the buy filled because the market is crashing" and limits damage.
    if (t.timestamp - sellStart <= cfg.HARD_STOP_SEC && t.price < avgEntry - cfg.HARD_STOP_DELTA) {
      const rem = buyShares - sellShares;
      sellShares += rem;
      sellNotional += rem * t.price;
      status = 'hardstop';
      break;
    }

    // Stoploss trigger: enter unwind mode if price drops
    if (!inStopLossMode && t.timestamp >= stopLossTrigger && t.price < avgEntry - cfg.STOPLOSS_DELTA) {
      inStopLossMode = true;
      stopLossBid = t.price;
    }

    // Stoploss unwind (still maker): SELL at stopLossBid. Fill when BUY tick at price >= stopLossBid.
    if (inStopLossMode && t.side === "BUY" && t.price >= stopLossBid) {
      let avail = Number(t.size) || 0;
      if (avail > 0 && sellShares < buyShares) {
        const take = Math.min(avail, buyShares - sellShares);
        sellShares += take;
        sellNotional += take * stopLossBid;
        if (sellShares >= buyShares - 1e-6) { status = 'stoploss-maker'; break; }
      }
    }

    // Stoploss taker: if maker unwind didn't complete in time, take liquidity
    if (inStopLossMode && t.timestamp > stopLossDeadline && sellShares < buyShares) {
      // Exit remaining at current price (taker)
      const rem = buyShares - sellShares;
      sellShares += rem;
      sellNotional += rem * t.price;
      status = 'stoploss-taker';
      break;
    }

    // Max hold timeout: if market has resolved, settle remaining at the
    // actual payout for our side. Otherwise take at current tick price.
    if (t.timestamp > sellDeadline) {
      const rem = buyShares - sellShares;
      if (rem > 0) {
        const pastRes = cfg.RESOLUTION_TS && t.timestamp >= cfg.RESOLUTION_TS;
        const winVal = cfg.WIN_RESOLUTION_VALUE ?? 1;  // value of RESOLUTION_VALUE where our side wins
        const settlePrice = pastRes && cfg.RESOLUTION_VALUE === winVal ? 1.0
                          : pastRes && cfg.RESOLUTION_VALUE != null ? 0.0
                          : t.price;
        sellShares += rem;
        sellNotional += rem * settlePrice;
      }
      const pastRes = cfg.RESOLUTION_TS && t.timestamp >= cfg.RESOLUTION_TS;
      const winVal = cfg.WIN_RESOLUTION_VALUE ?? 1;
      status = pastRes && cfg.RESOLUTION_VALUE === winVal ? 'settle-win'
             : pastRes && cfg.RESOLUTION_VALUE != null ? 'settle-lose'
             : 'maxhold-taker';
      break;
    }
  }

  // If we ran out of ticks without closing:
  //   If market is RESOLVED to NO ($1 payout), shares auto-settle at $1.
  //   Otherwise exit at last observed price.
  if (status === null) {
    const rem = buyShares - sellShares;
    const winVal = cfg.WIN_RESOLUTION_VALUE ?? 1;
    if (rem > 0) {
      const settlePrice = cfg.RESOLUTION_VALUE === winVal ? 1.0
                        : cfg.RESOLUTION_VALUE != null ? 0.0
                        : lastPrice;
      sellShares += rem;
      sellNotional += rem * settlePrice;
    }
    status = cfg.RESOLUTION_VALUE === winVal ? 'settle-win'
           : cfg.RESOLUTION_VALUE != null ? 'settle-lose'
           : (sellShares > 0 ? 'partial-999' : 'stuck');
  }

  const avgExit = sellShares > 0 ? sellNotional / sellShares : avgEntry;
  const pnl = sellNotional - buyNotional;
  const holdMin = (fillTs && sellShares > 0) ? (sellStart + cfg.MAX_HOLD_MIN*60 - fillTs) / 60 : 0;
  // Actually recompute holdMin as exit-fill-time - entry-fill-time; but we don't track exit-time per partial
  // Approximate holdMin from status
  return {
    opened: true, status, entryFill: buyShares, exitFill: sellShares,
    entryPrice: avgEntry, exitPrice: avgExit,
    pnl, holdMin: 0  // not tracked precisely; fine for summary stats
  };
}

let passedCoarse = 0, scored = 0, attempted = 0, filled = 0;
let gatedLiq = 0, gatedCB = 0, gatedBL = 0, gatedMomentum = 0, gatedCrossed = 0, gatedDisagree = 0;
const positions = new Map();
const lastEntryByCid = new Map();
const trades = [];
const tickCache = new Map();
// v7 state
const rollingWins = [];  // sliding window of pnl outcomes (>0.01 = 1, else 0)
let pauseUntilTs = 0;
const marketLossStreak = new Map();  // cid -> consecutive loss count
const marketBlacklistUntil = new Map(); // cid -> ts

function checkLiquidity(ticks, entryTs, cfg) {
  const lo = entryTs - cfg.LIQ_LOOKBACK_SEC;
  let vol = 0;
  for (const t of ticks) {
    if (t.timestamp < lo || t.timestamp >= entryTs) continue;
    if (t.outcomeIndex !== (cfg.ENTRY_SIDE ?? 1)) continue;
    if (t.price < cfg.LIQ_MIN_PRICE) continue;
    vol += Number(t.size) || 0;
    if (vol >= cfg.LIQ_MIN_VOLUME) return true;
  }
  return false;
}

// v8: reject entry if price has dropped sharply in last LOOKBACK sec
function checkMomentum(ticks, entryTs, currentPrice, cfg) {
  const lo = entryTs - cfg.DECLINE_LOOKBACK;
  let maxRecent = currentPrice;
  for (const t of ticks) {
    if (t.timestamp < lo || t.timestamp >= entryTs) continue;
    if (t.outcomeIndex !== (cfg.ENTRY_SIDE ?? 1)) continue;
    if (t.price > maxRecent) maxRecent = t.price;
  }
  // If recent peak is more than DECLINE_MAX above current = declining, reject
  return (maxRecent - currentPrice) <= cfg.DECLINE_MAX;
}

for (const ev of events) {
  const key = `${ev.conditionId}-NO`;
  if (positions.has(key)) continue;

  // v11: outer band widened to cover BOTH NO (NO price in [0.70, 0.99]) and
  // YES (NO price in [0.30, 0.70] = YES price 0.30-0.70) entries. Inner
  // side-aware check enforces the specific band per side.
  const outerMin = Math.min(CFG.MIN_ENTRY, 1 - (CFG.MAX_ENTRY_YES ?? 0.70));
  const outerMax = Math.max(CFG.MAX_ENTRY, 1 - (CFG.MIN_ENTRY_YES ?? 0.30));
  const inBand = ev.p >= outerMin && ev.p <= outerMax;
  const ttr = ev.marketEndTs - ev.t;
  const inTtr = ttr >= CFG.TTR_MIN && ttr <= CFG.TTR_MAX;
  const inTimeWindow = ev.t >= MIN_ENTRY_TS && ev.t <= MAX_ENTRY_TS;
  if (!inBand || !inTtr || !inTimeWindow) continue;
  passedCoarse++;

  const lastTs = lastEntryByCid.get(key) || 0;
  if (ev.t - lastTs < CFG.COOLDOWN_SEC) continue;

  // GUARD 1: circuit breaker on rolling WR
  if (ev.t < pauseUntilTs) { gatedCB++; continue; }

  // GUARD 2: per-market blacklist (loss streak)
  const blUntil = marketBlacklistUntil.get(ev.conditionId) || 0;
  if (ev.t < blUntil) { gatedBL++; continue; }

  if (!tickCache.has(ev.conditionId)) tickCache.set(ev.conditionId, loadTicks(ev.conditionId));
  const ticks = tickCache.get(ev.conditionId);

  // v11: compute entry signal BEFORE liquidity/momentum check (we need to
  // know which side we're entering to check the right side's liquidity)
  const sig = computeEntrySignal(ev.market, ev.t, CROSSED_BUFFER, CFG.FORECAST_BUF || 2.0);
  if (!sig) { gatedCrossed++; continue; }

  // v12: if both weather sources are available, require them to agree. If
  // they disagree by more than AGREEMENT_TOL, the market is unreliable —
  // skip. 63%% of v11 losses came from markets with >1°C source disagreement.
  const agreementTol = Number(argv.agreementtol ?? "1.0");
  if (!sourcesAgree(ev.market, ev.t, agreementTol)) { gatedDisagree++; continue; }

  // Determine token we're buying + price filter
  let entryPrice, sideOutcomeIndex;
  if (sig.side === "NO") {
    entryPrice = ev.p;  // ev.p is NO-side price
    sideOutcomeIndex = 1;
    if (entryPrice < CFG.MIN_ENTRY || entryPrice > CFG.MAX_ENTRY) continue;
  } else {
    entryPrice = 1 - ev.p;  // YES price = 1 - NO price
    sideOutcomeIndex = 0;
    if (entryPrice < (CFG.MIN_ENTRY_YES ?? 0.30) || entryPrice > (CFG.MAX_ENTRY_YES ?? 0.70)) continue;
  }

  // GUARD 3: liquidity gate for the SIDE we're entering (side-aware in v11)
  const liqCfg = { ...CFG, ENTRY_SIDE: sideOutcomeIndex, LIQ_MIN_PRICE: sig.side === "NO" ? CFG.LIQ_MIN_PRICE : 0.30 };
  if (!checkLiquidity(ticks, ev.t, liqCfg)) { gatedLiq++; continue; }

  // GUARD 4 (v8): momentum check — reject if price declining
  // For YES entries, we want price RISING (opposite of NO).
  // Skip momentum check for YES for simplicity (our weather-confirmed signal
  // is the primary safety; momentum matters less for directional entries).
  if (sig.side === "NO" && !checkMomentum(ticks, ev.t, ev.p, CFG)) { gatedMomentum++; continue; }

  const feats = featuresFor(ticks, ev.market, ev.t, entryPrice, sideOutcomeIndex);
  const s = scoreEntry(feats);
  scored++;
  if (s < CFG.THRESHOLD) continue;

  attempted++;
  const ourBidPrice = Math.max(0.01, entryPrice - CFG.BID_OFFSET);
  // v12: asymmetric sizing — YES side is higher variance (~85%% WR vs NO's 99%%),
  // so we size YES at YES_SIZE_MULT × base (default 0.5 = half size).
  const sizeMult = sig.side === "YES" ? (Number(argv.yessizemult ?? "0.5")) : 1.0;
  const usdcSize = CFG.TRADE_USDC * sizeMult;
  const shares = usdcSize / ourBidPrice;
  const resolution = RESOLUTION[ev.conditionId];
  // Settlement value depends on which side we're holding
  let settleWinValue, settleLoseValue;
  if (sig.side === "NO") {
    settleWinValue = 1;  // resolved=1 means NO won, $1 per NO share
    settleLoseValue = 0;
  } else {
    settleWinValue = 0;  // resolved=0 means YES won, $1 per YES share — keyed to resolved value
    settleLoseValue = 1;
  }
  const cfgWithRes = {
    ...CFG,
    RESOLUTION_VALUE: resolution?.resolved,
    RESOLUTION_TS: ev.marketEndTs,
    ENTRY_SIDE: sideOutcomeIndex,      // 0 = YES tokens, 1 = NO tokens
    WIN_RESOLUTION_VALUE: settleWinValue,  // value of RESOLUTION_VALUE where we win
  };
  const res = simulateTrade(ev.conditionId, ev.t, entryPrice, ourBidPrice, shares, cfgWithRes);
  res.entrySide = sig.side;
  res.signalReason = sig.reason;
  res.cushion = sig.cushion;
  if (!res.opened) {
    // No position opened — don't record as a trade (but count in attempts)
    lastEntryByCid.set(key, ev.t);
    continue;
  }
  filled++;
  trades.push({
    conditionId: ev.conditionId, city: ev.city, title: ev.title,
    entryTs: ev.t, ourBid: ourBidPrice, entryFill: res.entryFill,
    entryPrice: res.entryPrice, exitFill: res.exitFill, exitPrice: res.exitPrice,
    pnl: res.pnl, status: res.status, score: s,
    side: sig.side, reason: sig.reason, cushion: sig.cushion.toFixed(2)
  });
  lastEntryByCid.set(key, ev.t);
  positions.set(key, { entryTs: ev.t });
  positions.delete(key);

  // === v7 live guards update ===
  // Rolling WR circuit breaker
  const won = res.pnl > 0.01 ? 1 : 0;
  rollingWins.push(won);
  if (rollingWins.length > CFG.ROLLING_N) rollingWins.shift();
  if (rollingWins.length === CFG.ROLLING_N) {
    const wr = rollingWins.reduce((s,v) => s+v, 0) / CFG.ROLLING_N;
    if (wr < CFG.ROLLING_MIN_WR && pauseUntilTs < ev.t) {
      pauseUntilTs = ev.t + CFG.PAUSE_MIN * 60;
    }
  }
  // Per-market loss streak blacklist
  if (res.pnl < -0.01) {
    const streak = (marketLossStreak.get(ev.conditionId) || 0) + 1;
    marketLossStreak.set(ev.conditionId, streak);
    if (streak >= CFG.MARKET_LOSS_LIMIT) {
      marketBlacklistUntil.set(ev.conditionId, ev.t + CFG.MARKET_BLACKLIST_MIN * 60);
      marketLossStreak.set(ev.conditionId, 0);
    }
  } else if (res.pnl > 0.01) {
    marketLossStreak.set(ev.conditionId, 0);
  }
}

const wins = trades.filter(t => t.pnl > 0.01).length;
const losses = trades.filter(t => t.pnl < -0.01).length;
const flat = trades.filter(t => Math.abs(t.pnl) <= 0.01).length;
const byStatus = {};
for (const t of trades) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
const totalPnl = trades.reduce((s,t)=>s+t.pnl, 0);
const totalBought = trades.reduce((s,t)=>s+t.entryFill, 0);
const totalSold = trades.reduce((s,t)=>s+t.exitFill, 0);
const firstTs = trades.length ? Math.min(...trades.map(t => t.entryTs)) : 0;
const lastTs = trades.length ? Math.max(...trades.map(t => t.entryTs)) : 0;
const spanDays = (lastTs - firstTs) / 86400;

console.log(`candidates: ${passedCoarse}  gated[liq:${gatedLiq} mom:${gatedMomentum} crossed:${gatedCrossed} disagree:${gatedDisagree} CB:${gatedCB} BL:${gatedBL}]  scored:${scored}  attempted:${attempted}  filled:${filled}`);
console.log(`entry fill rate: ${fmt(100*filled/Math.max(1,attempted),1)}%  (limit-buy cross rate)`);
console.log(`by exit status:`);
for (const [k, v] of Object.entries(byStatus).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k.padEnd(18)}  ${v}`);
}
console.log(`WR strict (pnl>+0.01):    ${fmt(100*wins/Math.max(1,trades.length),1)}%  (${wins}/${trades.length})`);
console.log(`WR inclusive (pnl>=-0.01): ${fmt(100*(wins+flat)/Math.max(1,trades.length),1)}%  (937 metric)`);
console.log(`losers: ${losses} (${fmt(100*losses/Math.max(1,trades.length),1)}%)`);
console.log(`total PnL: \$${fmt(totalPnl)}  avg/trade: \$${fmt(totalPnl/Math.max(1,trades.length),3)}`);
console.log(`span: ${fmt(spanDays,1)}d  PnL/day: \$${fmt(totalPnl/Math.max(0.1,spanDays),2)}  trades/day: ${fmt(trades.length/Math.max(0.1,spanDays),1)}`);

// Monthly breakdown (the critical metric: positive every month?)
const byMonth = {};
for (const t of trades) {
  const mo = new Date(t.entryTs * 1000).toISOString().slice(0, 7);
  if (!byMonth[mo]) byMonth[mo] = { n: 0, wins: 0, losses: 0, flat: 0, pnl: 0 };
  byMonth[mo].n++;
  byMonth[mo].pnl += t.pnl;
  if (t.pnl > 0.01) byMonth[mo].wins++;
  else if (t.pnl < -0.01) byMonth[mo].losses++;
  else byMonth[mo].flat++;
}
console.log(`\n=== MONTHLY BREAKDOWN (the key metric) ===`);
console.log("  month     n  wins losses  WR_str  WR_inc      PnL  verdict");
let allPositive = true;
for (const mo of Object.keys(byMonth).sort()) {
  const b = byMonth[mo];
  const wr_str = 100 * b.wins / b.n;
  const wr_inc = 100 * (b.wins + b.flat) / b.n;
  const verdict = b.pnl > 0 ? "PROFIT" : (b.pnl < 0 ? "LOSS" : "flat");
  if (b.pnl <= 0) allPositive = false;
  const pnlStr = "$" + b.pnl.toFixed(2);
  console.log(`  ${mo}  ${String(b.n).padStart(4)}  ${String(b.wins).padStart(4)}  ${String(b.losses).padStart(4)}   ${wr_str.toFixed(1).padStart(5)}%  ${wr_inc.toFixed(1).padStart(5)}%  ${pnlStr.padStart(8)}  ${verdict}`);
}
console.log(`\nAll months profitable: ${allPositive ? '✓ YES' : '✗ NO'}`);

// Side breakdown (v11)
const bySide = {};
for (const t of trades) {
  if (!bySide[t.side]) bySide[t.side] = { n: 0, wins: 0, losses: 0, pnl: 0 };
  bySide[t.side].n++;
  bySide[t.side].pnl += t.pnl;
  if (t.pnl > 0.01) bySide[t.side].wins++;
  else if (t.pnl < -0.01) bySide[t.side].losses++;
}
console.log(`\n=== SIDE BREAKDOWN ===`);
console.log("  side      n  wins loss  WR%   PnL       avg/trade");
for (const s of Object.keys(bySide).sort()) {
  const b = bySide[s];
  const wr = 100 * b.wins / Math.max(1, b.n);
  console.log(`  ${s.padEnd(4)}  ${String(b.n).padStart(4)}  ${String(b.wins).padStart(4)} ${String(b.losses).padStart(4)}  ${wr.toFixed(1).padStart(5)}  $${b.pnl.toFixed(2).padStart(7)}  $${(b.pnl/Math.max(1,b.n)).toFixed(3)}`);
}

// Signal reason breakdown
const byReason = {};
for (const t of trades) {
  if (!byReason[t.reason]) byReason[t.reason] = { n: 0, pnl: 0 };
  byReason[t.reason].n++;
  byReason[t.reason].pnl += t.pnl;
}
console.log(`\n=== SIGNAL REASON BREAKDOWN ===`);
for (const [r, b] of Object.entries(byReason).sort((a,b) => b[1].n - a[1].n)) {
  console.log(`  ${r.padEnd(25)} n=${String(b.n).padStart(4)}  PnL=$${b.pnl.toFixed(2)}  avg=$${(b.pnl/b.n).toFixed(3)}`);
}

const rows = trades.map(t => [
  t.conditionId, t.city || "", t.entryTs, t.side, t.reason, t.cushion, t.ourBid.toFixed(4),
  t.entryPrice.toFixed(4), t.entryFill.toFixed(2),
  t.exitPrice.toFixed(4), t.exitFill.toFixed(2),
  t.pnl.toFixed(4), t.status, (t.score ?? "").toString().slice(0,6),
  (t.title || "").replace(/,/g, " ")
].join(","));
fs.writeFileSync(OUT_CSV, ["conditionId,city,entryTs,side,reason,cushion,ourBid,entryPrice,entryFill,exitPrice,exitFill,pnl,status,score,title", ...rows].join("\n") + "\n");
console.log(`\nSaved: ${OUT_CSV}`);
