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
  // Rolling circuit breaker: pause entries if rolling WR drops below threshold.
  ROLLING_N:          Number(argv.rollingn ?? "50"),     // window size
  ROLLING_MIN_WR:     Number(argv.rollingminwr ?? "0.8"), // pause if WR < this
  PAUSE_MIN:          Number(argv.pausemin ?? "60"),     // stay paused this long
  // Liquidity gate: require recent tick volume at high price to confirm
  // market is in "NO-likely" state.
  LIQ_LOOKBACK_SEC:   Number(argv.liqlookback ?? "600"),  // last N seconds
  LIQ_MIN_VOLUME:     Number(argv.liqminvol ?? "50"),     // shares traded in lookback
  LIQ_MIN_PRICE:      Number(argv.liqminprice ?? "0.96"), // at this price or higher
  // Per-market cooldown on loss streaks
  MARKET_LOSS_LIMIT:  Number(argv.marketlosslimit ?? "2"), // consecutive losses
  MARKET_BLACKLIST_MIN: Number(argv.marketblmin ?? "1440"), // blacklist for 24h
  TRADE_USDC:         Number(argv.tradesize ?? "40"),
};
const MIN_ENTRY_TS = Number(argv.minentryts ?? "0");
const MAX_ENTRY_TS = Number(argv.maxentryts ?? "9999999999");

const TICK_DIR    = path.resolve("data/tick-history");
const CACHE_DIR   = path.resolve("data/resolved-market-cache");
const WEATHER_DIR = path.resolve("data/weather-history");
const TRADES_DIR  = path.resolve("data/wallet-trades");
const MODEL_FILE  = path.resolve(argv.model ?? "data/classifier/model-gbdt-v3.json");
const OUT_CSV     = path.resolve("data/backtest-maker-v7.csv");

// v6: sample from tick data, not just cache
const SAMPLE_BUCKET_SEC = Number(argv.samplebucket ?? "60");

const EXCLUDE = new Set(
  fs.readdirSync(TRADES_DIR).filter(f => f.endsWith(".jsonl")).map(f => f.replace(".jsonl","").toLowerCase())
);
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
  const x = model.featNames.map(k => Number.isFinite(feat[k]) ? feat[k] : 0);
  let z = 0;
  for (const t of model.trees) z += model.eta * treePredict(t, x);
  return 1/(1+Math.exp(-Math.max(-30, Math.min(30, z))));
}

console.log(`v6 config: th=${CFG.THRESHOLD} band=[${CFG.MIN_ENTRY},${CFG.MAX_ENTRY}] bidOffset=${CFG.BID_OFFSET} buyWait=${CFG.BUY_WAIT_MIN}m queues=${CFG.BUY_QUEUE}/${CFG.SELL_QUEUE} stopLoss@${CFG.STOPLOSS_MIN}m<-${CFG.STOPLOSS_DELTA} maxHold=${CFG.MAX_HOLD_MIN}m size=\$${CFG.TRADE_USDC} sampleBucket=${SAMPLE_BUCKET_SEC}s`);

// v6: sample candidates from TICK data for weather markets. Filter to
// markets where NO resolved to $1 (cache.tokenResolutionValue==1) — that's
// the population 937 targets. Using cache as an oracle filter here is a
// BACKTEST-ONLY simplification; in live trading we'd need a classifier.
const TITLE_INDEX = JSON.parse(fs.readFileSync(path.resolve("data/market-titles.json"), "utf8"));
const REQUIRE_NO_RESOLVED = (argv.reqnores ?? "true") !== "false";
const tickFiles = fs.readdirSync(TICK_DIR).filter(f => f.endsWith(".jsonl"));
const events = [];
let tickMarkets = 0, cacheHits = 0, filtered = 0;
for (const f of tickFiles) {
  const conditionId = f.replace(".jsonl", "");
  const title = TITLE_INDEX[conditionId];
  if (!title) continue;
  if (!/temperature/i.test(title)) continue;
  const market = parseWeatherTitle(title);
  const city = cityFromTitle(title);
  if (!market) continue;

  const cache = loadCache(conditionId, "NO");
  const REQUIRE_CACHE = (argv.requirecache ?? "true") !== "false";
  if (REQUIRE_CACHE && (!cache || !cache.samples?.length)) { filtered++; continue; }
  if (REQUIRE_NO_RESOLVED && cache && cache.tokenResolutionValue !== 1 && cache.tokenResolutionValue !== "1") {
    filtered++; continue;
  }

  const ticks = loadTicks(conditionId);
  if (!ticks.length) continue;
  tickMarkets++;
  cacheHits++;

  // Use cache's resolution bound for marketEndTs (last sample time), else last tick
  const marketEndTs = cache?.samples?.length
    ? cache.samples[cache.samples.length - 1].t
    : ticks[ticks.length - 1].timestamp;

  // Sample: one event per SAMPLE_BUCKET_SEC using latest NO-side price
  let lastBucket = -1;
  let lastPrice = null;
  for (const t of ticks) {
    if (t.outcomeIndex !== 1) continue;
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
console.log(`${events.length} candidate events from ${tickMarkets} tick markets (${cacheHits} had cache)`);

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
    if (t.outcomeIndex !== 1) continue;
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
    if (t.outcomeIndex !== 1) continue;
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

    // Stoploss trigger: enter unwind mode if price drops
    if (!inStopLossMode && t.timestamp >= stopLossTrigger && t.price < avgEntry - cfg.STOPLOSS_DELTA) {
      inStopLossMode = true;
      // Post a new LIMIT SELL at current price - BID_OFFSET to be crossed quickly
      stopLossBid = t.price; // we're willing to sell at market; but we're a maker so we post at best_ask
      // In practice: post at current price (quick fill, small extra loss)
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

    // Max hold timeout: take remaining at market
    if (t.timestamp > sellDeadline) {
      const rem = buyShares - sellShares;
      if (rem > 0) {
        sellShares += rem;
        sellNotional += rem * t.price;
      }
      status = sellShares === buyShares && sellShares > 0 ? 'maxhold-taker' : 'maxhold-taker';
      break;
    }
  }

  // If we ran out of ticks without closing
  if (status === null) {
    const rem = buyShares - sellShares;
    if (rem > 0) {
      // Exit at last observed price
      sellShares += rem;
      sellNotional += rem * lastPrice;
    }
    status = sellShares > 0 ? 'partial-999' : 'stuck';
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
let gatedLiq = 0, gatedCB = 0, gatedBL = 0;
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
  // Require MIN_VOLUME shares of NO-side trading at >= MIN_PRICE in last LOOKBACK seconds
  const lo = entryTs - cfg.LIQ_LOOKBACK_SEC;
  let vol = 0;
  for (const t of ticks) {
    if (t.timestamp < lo || t.timestamp >= entryTs) continue;
    if (t.outcomeIndex !== 1) continue;
    if (t.price < cfg.LIQ_MIN_PRICE) continue;
    vol += Number(t.size) || 0;
    if (vol >= cfg.LIQ_MIN_VOLUME) return true;
  }
  return false;
}

for (const ev of events) {
  const key = `${ev.conditionId}-NO`;
  if (positions.has(key)) continue;

  const inBand = ev.p >= CFG.MIN_ENTRY && ev.p <= CFG.MAX_ENTRY;
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

  // GUARD 3: liquidity gate — require recent active trading at high price
  if (!checkLiquidity(ticks, ev.t, CFG)) { gatedLiq++; continue; }

  const feats = featuresFor(ticks, ev.market, ev.t, ev.p, 1);
  const s = scoreEntry(feats);
  scored++;
  if (s < CFG.THRESHOLD) continue;

  attempted++;
  const ourBidPrice = Math.max(0.01, ev.p - CFG.BID_OFFSET);
  const shares = CFG.TRADE_USDC / ourBidPrice;
  const res = simulateTrade(ev.conditionId, ev.t, ev.p, ourBidPrice, shares, CFG);
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
    pnl: res.pnl, status: res.status, score: s
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

console.log(`candidates(TTR+band): ${passedCoarse}  gated(liq): ${gatedLiq}  gated(CB): ${gatedCB}  gated(BL): ${gatedBL}  scored: ${scored}  attempted: ${attempted}  entry-filled: ${filled}`);
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

const rows = trades.map(t => [
  t.conditionId, t.city || "", t.entryTs, t.ourBid.toFixed(4),
  t.entryPrice.toFixed(4), t.entryFill.toFixed(2),
  t.exitPrice.toFixed(4), t.exitFill.toFixed(2),
  t.pnl.toFixed(4), t.status, (t.score ?? "").toString().slice(0,6),
  (t.title || "").replace(/,/g, " ")
].join(","));
fs.writeFileSync(OUT_CSV, ["conditionId,city,entryTs,ourBid,entryPrice,entryFill,exitPrice,exitFill,pnl,status,score,title", ...rows].join("\n") + "\n");
console.log(`\nSaved: ${OUT_CSV}`);
