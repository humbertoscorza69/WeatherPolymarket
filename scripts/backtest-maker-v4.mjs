#!/usr/bin/env node
/**
 * v4 backtest: realistic maker with queue + breakeven bailout.
 *
 * Model:
 *   1. Entry: market buy at trade-price (same as v3; already pays the offer)
 *   2. Immediately post LIMIT SELL at 0.999 for full size
 *   3. Queue: assume QUEUE_AHEAD shares of other sells ahead of us at 0.999.
 *      We fill only after cumulative BUY flow at price >= 0.999 during
 *      the hold window exceeds (QUEUE_AHEAD + ourShares).
 *   4. Breakeven bailout: if holdMin >= BAILOUT_MIN AND current price is
 *      more than BAILOUT_DELTA below entry, cancel the limit sell and
 *      exit at current market price (= a small planned loss — cutting it
 *      before it grows).
 *   5. Full timeout (maxHold): cancel and exit at market (realistic).
 *   6. Target hit: fully filled at 0.999.
 *
 * This yields a realistic WR:
 *   - queue prevents "free" flat exits when price merely touched 0.999
 *   - breakeven prevents catastrophic timeouts
 *
 * Usage:
 *   node scripts/backtest-maker-v4.mjs [--threshold=0.7] [--queue=200]
 *     [--bailoutmin=5] [--bailoutdelta=0.005] [--maxhold=15]
 *     [--minentryts=...] [--model=...]
 */
import fs from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const CFG = {
  ASK_TARGET:     Number(argv.ask ?? "0.999"),
  QUEUE_AHEAD:    Number(argv.queue ?? "200"),        // shares of other sells queued ahead of us at 0.999
  MAX_HOLD_MIN:   Number(argv.maxhold ?? "15"),
  BAILOUT_MIN:    Number(argv.bailoutmin ?? "5"),     // after this many min...
  BAILOUT_DELTA:  Number(argv.bailoutdelta ?? "0.005"), // ...if price < entry - this, bail to current market
  MIN_ENTRY:      Number(argv.minentry ?? "0.95"),
  MAX_ENTRY:      Number(argv.maxentry ?? "0.998"),
  TRADE_USDC:     Number(argv.tradesize ?? "40"),
  TTR_MIN:        Number(argv.ttrmin ?? String(60*60)),
  TTR_MAX:        Number(argv.ttrmax ?? String(3*60*60)),
  COOLDOWN_SEC:   Number(argv.cooldown ?? "900"),
  THRESHOLD:      Number(argv.threshold ?? "0.7"),
};
const MIN_ENTRY_TS = Number(argv.minentryts ?? "0");
const MAX_ENTRY_TS = Number(argv.maxentryts ?? "9999999999");

const TICK_DIR    = path.resolve("data/tick-history");
const CACHE_DIR   = path.resolve("data/resolved-market-cache");
const WEATHER_DIR = path.resolve("data/weather-history");
const TRADES_DIR  = path.resolve("data/wallet-trades");
const MODEL_FILE  = path.resolve(argv.model ?? "data/classifier/model-gbdt-v3.json");
const OUT_CSV     = path.resolve("data/backtest-maker-v4.csv");

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
  const tempCNow = inDay[inDay.length - 1].tempC;
  const maxSoFar = Math.max(...inDay.map(s => s.tempC));
  const thrC = toCelsius(market.threshold, market.unit);
  feats.wx_temp_now = tempCNow;
  feats.wx_max_sofar = maxSoFar;
  feats.wx_delta_to_thr = thrC - maxSoFar;
  const recent = inDay.filter(s => s.t >= entryTs - 3*3600);
  if (recent.length >= 2) {
    const first = recent[0], last = recent[recent.length - 1];
    feats.wx_slope_3h = (last.tempC - first.tempC) / Math.max(1, (last.t - first.t) / 3600);
  }
  feats.wx_hours_remain = Math.max(0, (dayEnd - 14*3600 - entryTs) / 3600);
  if (market.type === "at_or_below" && maxSoFar > thrC) feats.wx_crossed = 1;
  else if (market.type === "at_or_above" && maxSoFar < thrC && feats.wx_hours_remain < 6) feats.wx_crossed = 1;
  else if (market.type === "exact" && (maxSoFar < market.threshold - 1 || maxSoFar > market.threshold + 1)) feats.wx_crossed = 1;
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

console.log(`Config: threshold=${CFG.THRESHOLD} queue=${CFG.QUEUE_AHEAD}  bailout@${CFG.BAILOUT_MIN}min if <entry-${CFG.BAILOUT_DELTA}  maxhold=${CFG.MAX_HOLD_MIN}min  size=\$${CFG.TRADE_USDC}`);

const tickFiles = fs.readdirSync(TICK_DIR).filter(f => f.endsWith(".jsonl"));
console.log(`Scanning ${tickFiles.length} markets...`);

// Build candidate events from resolved-market price cache
const events = [];
for (const f of tickFiles) {
  const conditionId = f.replace(".jsonl", "");
  const cache = loadCache(conditionId, "NO");
  if (!cache?.samples?.length) continue;
  if (!/temperature/i.test(cache.title || "")) continue;
  const market = parseWeatherTitle(cache.title);
  const city = cityFromTitle(cache.title);
  const marketEndTs = cache.samples[cache.samples.length - 1].t;
  for (const s of cache.samples) {
    events.push({ t: s.t, p: s.p, conditionId, city, market, title: cache.title, marketEndTs });
  }
}
events.sort((a, b) => a.t - b.t);
console.log(`${events.length} candidate sample events`);

/**
 * Simulate a limit sell at 0.999 given the tick stream.
 *
 * Returns {filled, fillTs, fillShares, exitPrice, holdMin, status, exitPnl}
 *
 * Walks ticks from entryTs forward. For each BUY tick at price >= 0.999,
 * consume queue then our shares. Track elapsed time and price to apply
 * the bailout rule.
 */
function simulateExit(cid, entryTs, entryPrice, shares, maxHoldMin, queueAhead, bailoutMin, bailoutDelta) {
  const p = path.join(TICK_DIR, `${cid}.jsonl`);
  if (!fs.existsSync(p)) {
    return { status: "no-ticks", exitPrice: entryPrice, holdMin: 0, pnl: 0, filled: 0 };
  }
  const ticks = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  // Our limit sell is for side NO (outcomeIndex=1).
  // In Polymarket tick data, a BUY at price X for outcomeIndex=1 = someone BUYING NO at X → crosses resting SELL at X.
  // We need BUY flow at price >= 0.999 on the NO side to fill our sell.
  let queueRemaining = queueAhead;
  let ourRemaining = shares;
  let lastPrice = entryPrice; // tracks NO-side market price over time
  const maxHoldSec = maxHoldMin * 60;
  const bailoutSec = bailoutMin * 60;
  for (const t of ticks) {
    if (t.timestamp < entryTs) continue;
    if (t.timestamp > entryTs + maxHoldSec) break;
    if (t.outcomeIndex !== 1) continue; // only NO-side ticks
    const holdSec = t.timestamp - entryTs;
    // Update last observed price
    lastPrice = t.price;
    // Fill logic: only BUYs at >= 0.999 can cross resting SELLs at 0.999
    if (t.side === "BUY" && t.price >= 0.999) {
      let avail = Number(t.size) || 0;
      // Consume queue first, then our order
      if (queueRemaining > 0) {
        const take = Math.min(avail, queueRemaining);
        queueRemaining -= take;
        avail -= take;
      }
      if (avail > 0 && ourRemaining > 0) {
        const fill = Math.min(avail, ourRemaining);
        ourRemaining -= fill;
        if (ourRemaining <= 1e-6) {
          // Fully filled
          const filledShares = shares - ourRemaining;
          const holdMin = holdSec / 60;
          return {
            status: "filled-999", exitPrice: 0.999, holdMin,
            pnl: filledShares * (0.999 - entryPrice),
            filled: filledShares
          };
        }
      }
    }
    // Bailout check: after bailoutSec, if NO-side price has dropped far below entry,
    // cancel unfilled portion and exit at market (loss = (market_price - entry) × remaining)
    if (holdSec >= bailoutSec && t.price < entryPrice - bailoutDelta) {
      const filledShares = shares - ourRemaining;
      const pnl = filledShares * (0.999 - entryPrice) + ourRemaining * (t.price - entryPrice);
      return {
        status: "bailout", exitPrice: t.price, holdMin: holdSec / 60,
        pnl, filled: filledShares
      };
    }
  }
  // End of hold window: cancel whatever's unfilled, exit at last observed price
  const filledShares = shares - ourRemaining;
  const pnl = filledShares * (0.999 - entryPrice) + ourRemaining * (lastPrice - entryPrice);
  return {
    status: filledShares > 0 ? "partial-timeout" : "timeout",
    exitPrice: lastPrice, holdMin: maxHoldMin,
    pnl, filled: filledShares
  };
}

let passedCoarse = 0, scored = 0, opened = 0;
const positions = new Map();
const lastEntryByCid = new Map();
const trades = [];
const tickCache = new Map();

for (const ev of events) {
  const key = `${ev.conditionId}-NO`;
  if (positions.has(key)) continue;  // single position per market at a time

  const inBand = ev.p >= CFG.MIN_ENTRY && ev.p <= CFG.MAX_ENTRY;
  const ttr = ev.marketEndTs - ev.t;
  const inTtr = ttr >= CFG.TTR_MIN && ttr <= CFG.TTR_MAX;
  const inTimeWindow = ev.t >= MIN_ENTRY_TS && ev.t <= MAX_ENTRY_TS;
  if (!inBand || !inTtr || !inTimeWindow) continue;
  passedCoarse++;

  const lastTs = lastEntryByCid.get(key) || 0;
  if (ev.t - lastTs < CFG.COOLDOWN_SEC) continue;

  if (!tickCache.has(ev.conditionId)) tickCache.set(ev.conditionId, loadTicks(ev.conditionId));
  const ticks = tickCache.get(ev.conditionId);
  const feats = featuresFor(ticks, ev.market, ev.t, ev.p, 1);
  const s = scoreEntry(feats);
  scored++;
  if (s < CFG.THRESHOLD) continue;

  const usdc = CFG.TRADE_USDC;
  const shares = usdc / ev.p;
  const exit = simulateExit(
    ev.conditionId, ev.t, ev.p, shares,
    CFG.MAX_HOLD_MIN, CFG.QUEUE_AHEAD,
    CFG.BAILOUT_MIN, CFG.BAILOUT_DELTA
  );
  trades.push({
    conditionId: ev.conditionId, city: ev.city, title: ev.title,
    entryTs: ev.t, entryPrice: ev.p, shares, usdc, score: s,
    exitTs: ev.t + exit.holdMin * 60, exitPrice: exit.exitPrice,
    holdMin: exit.holdMin, pnl: exit.pnl, filled: exit.filled,
    status: exit.status
  });
  lastEntryByCid.set(key, ev.t);
  positions.set(key, { entryTs: ev.t, exitTs: ev.t + exit.holdMin * 60 });
  // Free the market once our exit time passes — but since events are sorted
  // by time, positions only block further entries in the same market during the hold.
  opened++;
}

// Summary
const filled999 = trades.filter(t => t.status === "filled-999").length;
const bailouts  = trades.filter(t => t.status === "bailout").length;
const partials  = trades.filter(t => t.status === "partial-timeout").length;
const timeouts  = trades.filter(t => t.status === "timeout").length;
const wins      = trades.filter(t => t.pnl > 0.01).length;
const losses    = trades.filter(t => t.pnl < -0.01).length;
const flat      = trades.filter(t => Math.abs(t.pnl) <= 0.01).length;
const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
const totalUsdc = trades.reduce((s, t) => s + t.usdc, 0);
const firstTs = trades.length ? Math.min(...trades.map(t => t.entryTs)) : 0;
const lastTs  = trades.length ? Math.max(...trades.map(t => t.exitTs))  : 0;
const spanDays = (lastTs - firstTs) / 86400;

console.log(`candidates(TTR+band): ${passedCoarse}  scored: ${scored}  opened: ${opened}`);
console.log(`filled-999: ${filled999}  bailout: ${bailouts}  partial: ${partials}  timeout: ${timeouts}`);
console.log(`WR strict (pnl>0.01):      ${fmt(100*wins/Math.max(1,trades.length),1)}%  (${wins}/${trades.length})`);
console.log(`WR inclusive (pnl>=-0.01): ${fmt(100*(wins+flat)/Math.max(1,trades.length),1)}%  (937 metric)`);
console.log(`losers (pnl<-0.01): ${losses} (${fmt(100*losses/Math.max(1,trades.length),1)}%)`);
console.log(`total PnL: \$${fmt(totalPnl)}  avg/trade: \$${fmt(totalPnl/Math.max(1,trades.length),3)}`);
console.log(`span: ${fmt(spanDays,1)}d  PnL/day: \$${fmt(totalPnl/Math.max(0.1,spanDays),2)}  trades/day: ${fmt(trades.length/Math.max(0.1,spanDays),1)}`);
console.log(`fill rate: ${fmt(100*filled999/Math.max(1,trades.length),1)}% full, ${fmt(100*partials/Math.max(1,trades.length),1)}% partial`);

const rows = trades.map(t => [
  t.conditionId, t.city || "", t.entryTs, t.entryPrice.toFixed(4),
  t.exitTs.toFixed(0), t.exitPrice.toFixed(4), t.shares.toFixed(2), t.usdc.toFixed(2),
  t.holdMin.toFixed(1), t.pnl.toFixed(4), t.filled.toFixed(2),
  (t.score ?? "").toString().slice(0,6), t.status,
  (t.title || "").replace(/,/g, " ")
].join(","));
fs.writeFileSync(OUT_CSV, ["conditionId,city,entryTs,entryPrice,exitTs,exitPrice,shares,usdc,holdMin,pnl,filled,score,status,title", ...rows].join("\n") + "\n");
console.log(`\nSaved: ${OUT_CSV}`);
