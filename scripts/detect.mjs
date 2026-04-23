#!/usr/bin/env node
/**
 * LIVE OPPORTUNITY DETECTION + SIMULATED TRADING
 *
 * Runs continuously against live market + weather data. Applies the EXACT
 * same rules as v12 backtest for NO, YES, and LOWEST markets. When a signal
 * fires, logs it AND simulates a $SIZE trade (no real capital).
 *
 * Maintains a simulated bankroll. Each position is tracked in memory and
 * settled when the market resolves or max_hold expires.
 *
 * Data sources:
 *   - Polymarket Gamma: active weather markets + prices
 *   - aviationweather.gov/api/data/metar: hourly airport observations (PRIMARY)
 *   - api.open-meteo.com/v1/forecast: forecast for future hours
 *
 * Output:
 *   data/detect-log.jsonl     — append-only log of all signals
 *   data/detect-positions.json — current open positions
 *   data/detect-bankroll.json  — bankroll history
 *
 * Usage:
 *   node scripts/detect.mjs                          # default: scan every 5 min, $5 per trade
 *   node scripts/detect.mjs --interval=60            # scan every 60 sec
 *   node scripts/detect.mjs --once                   # single pass
 *   node scripts/detect.mjs --bankroll=100 --tradesize=5   # $100 daily, $5 per trade
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const CFG = {
  MIN_ENTRY_NO:     Number(argv.minentryno ?? "0.70"),
  MAX_ENTRY_NO:     Number(argv.maxentryno ?? "0.99"),
  MIN_ENTRY_YES:    Number(argv.minentryyes ?? "0.30"),
  MAX_ENTRY_YES:    Number(argv.maxentryyes ?? "0.70"),
  TTR_MIN_SEC:      Number(argv.ttrmin ?? String(60*60)),        // 1h (allow early entries)
  TTR_MAX_SEC:      Number(argv.ttrmax ?? String(24*3600)),      // 24h (matches 0x900e's 10h median entry)
  CROSSED_BUF:      Number(argv.crossedbuf ?? "0.5"),
  FORECAST_BUF:     Number(argv.forecastbuf ?? "2.0"),
  INTERVAL_SEC:     Number(argv.interval ?? "60"),     // main scan — fast
  POS_CHECK_SEC:    Number(argv.poscheck ?? "30"),     // open-position updates — faster
  WEATHER_TTL_SEC:  Number(argv.weathertll ?? "600"),  // cache weather 10min (it updates hourly anyway)
  ONCE:             argv.once === "true",
  BANKROLL:         Number(argv.bankroll ?? "100"),
  TRADE_SIZE:       Number(argv.tradesize ?? "5"),
  MIN_SHARES:       Number(argv.minshares ?? "5"),     // Polymarket minimum
  MAX_HOLD_MIN:     Number(argv.maxhold ?? "1440"),  // v14 — hold to resolution like 937
  RESET:            argv.reset === "true",
  NO_CAP:           argv.nocap === "true",           // disable "insufficient bankroll" gate
};

const LOG = path.resolve("data/detect-log.jsonl");
const POSITIONS_FILE = path.resolve("data/detect-positions.json");
const BANKROLL_FILE = path.resolve("data/detect-bankroll.json");
const STATIONS_FILE = path.resolve("data/metar-stations.json");
await fs.mkdir(path.dirname(LOG), { recursive: true });

const STATIONS = existsSync(STATIONS_FILE)
  ? JSON.parse(await fs.readFile(STATIONS_FILE, "utf8"))
  : {};

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const OM_FORECAST = "https://api.open-meteo.com/v1/forecast";
const OM_GEO = "https://geocoding-api.open-meteo.com/v1/search";

// ----- state (persisted) -----
// --bankroll on the CLI ALWAYS wins over persisted state. Previously the spread
// below let a saved bankroll override the CLI arg, which is why --bankroll=5000
// appeared to be ignored. Positions/trades/realizedPnl still load from disk
// so restarts don't lose history.
let state = { positions: [], bankroll: CFG.BANKROLL, realizedPnl: 0, trades: [] };
const bankrollArgPassed = Object.prototype.hasOwnProperty.call(argv, "bankroll");
if (!CFG.RESET && existsSync(POSITIONS_FILE)) {
  try {
    const persisted = JSON.parse(await fs.readFile(POSITIONS_FILE, "utf8"));
    state = { ...state, ...persisted };
    if (bankrollArgPassed) {
      // --bankroll means "my total capital is X" — effective cash = X minus
      // what's already tied up in open positions. Fixes the bug where a
      // restart with --bankroll=10000 reset effective cash to $10k even
      // though $750 was still deployed across 185 open positions.
      const openExposure = (state.positions || []).reduce((s, p) => s + (Number(p.positionSize) || 0), 0);
      state.bankroll = CFG.BANKROLL - openExposure;
      console.log(`[startup] --bankroll=${CFG.BANKROLL} with $${openExposure.toFixed(2)} deployed in ${state.positions.length} open positions → effective cash $${state.bankroll.toFixed(2)}`);
    }
  } catch {}
}

async function persist() {
  // Atomic write: tmp + rename. fs.writeFile can produce a truncated file if
  // the process is killed mid-write (Ctrl-C during flush). Renaming is
  // atomic on POSIX and Windows, so we never see a half-written state on
  // next startup. Prevents the "restart lost all positions" class of bug.
  const tmp = POSITIONS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, POSITIONS_FILE);
}

// ----- small utilities -----
async function fetchJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) {
        if (i === retries) throw new Error(`HTTP ${r.status}`);
        await new Promise(x => setTimeout(x, 500 * (i + 1)));
        continue;
      }
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(x => setTimeout(x, 500 * (i + 1)));
    }
  }
}

function parseWeatherTitle(t) {
  if (!t) return null;
  const isLowest = /lowest temperature/i.test(t);
  let m = t.match(/temperature in ([A-Z][\w .\-']+?) be/i);
  if (!m) m = t.match(/temperature in ([A-Z][\w .\-']+?) on/i);
  if (!m) return null;
  const city = m[1].trim();
  const unit = /°F/i.test(t) ? "F" : "C";
  const r = t.match(/be\s+(?:between\s+)?(\d+)(?:\s*-\s*(\d+))?\s*°?/i);
  const thr = r ? Number(r[1]) : null;
  const thrHi = r && r[2] ? Number(r[2]) : null;
  let typ = "exact";
  if (/or higher/i.test(t)) typ = "at_or_above";
  else if (/or below/i.test(t)) typ = "at_or_below";
  else if (/between/i.test(t)) typ = "between";
  let date = null;
  const iso = t.match(/on\s+(\d{4}-\d{2}-\d{2})/);
  const mon = t.match(/on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)(?:,\s*(\d{4}))?/i);
  if (iso) date = iso[1];
  else if (mon) {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const mi = months.findIndex(x => x.toLowerCase() === mon[1].toLowerCase());
    const y = mon[3] || String(new Date().getUTCFullYear());
    date = `${y}-${String(mi+1).padStart(2,"0")}-${String(mon[2]).padStart(2,"0")}`;
  }
  return { city, date, unit, threshold: thr, thresholdHigh: thrHi, type: typ, isLowest };
}

function toC(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }

async function fetchLiveWeatherMarkets() {
  const markets = [];
  const nowIso = new Date().toISOString();
  const in48h = new Date(Date.now() + 86400_000 * 2).toISOString();
  let offset = 0;
  while (offset < 5000) {
    const url = `${GAMMA}/markets?closed=false&tag_slug=weather&limit=500&offset=${offset}&end_date_min=${nowIso}&end_date_max=${in48h}`;
    const page = await fetchJson(url);
    if (!Array.isArray(page) || !page.length) break;
    for (const m of page) {
      if (!m.conditionId) continue;
      const q = m.question || m.title || "";
      if (!/temperature/i.test(q)) continue;
      markets.push({
        conditionId: m.conditionId,
        title: q,
        endDate: m.endDate,
        clobTokenIds: typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds,
      });
    }
    if (page.length < 500) break;
    offset += 500;
  }
  return markets;
}

async function fetchCurrentPrice(clobTokenIds) {
  if (!Array.isArray(clobTokenIds) || clobTokenIds.length < 2) return null;
  const noTokenId = clobTokenIds[1];
  try {
    const r = await fetchJson(`${CLOB}/midpoint?token_id=${noTokenId}`);
    return r?.mid ? Number(r.mid) : null;
  } catch { return null; }
}

// METAR = PRIMARY (matches Polymarket's resolver)
async function fetchMetar(icao, hours = 24) {
  const url = `${METAR_API}?ids=${icao}&format=json&hours=${hours}`;
  try {
    const data = await fetchJson(url);
    if (!Array.isArray(data)) return [];
    return data.map(m => ({ t: m.obsTime, tempC: m.temp }))
      .filter(o => o.t && o.tempC != null).sort((a,b) => a.t - b.t);
  } catch { return []; }
}

// Open-Meteo = forecast for future hours (needed for YES signal)
async function fetchOpenMeteo(city, tz) {
  try {
    const g = await fetchJson(`${OM_GEO}?name=${encodeURIComponent(city)}&count=1&format=json`);
    const r = g?.results?.[0];
    if (!r) return { samples: [], tz: null };
    const url = `${OM_FORECAST}?latitude=${r.latitude}&longitude=${r.longitude}&hourly=temperature_2m&timezone=UTC&past_days=1&forecast_days=2`;
    const j = await fetchJson(url);
    const times = j?.hourly?.time ?? [];
    const temps = j?.hourly?.temperature_2m ?? [];
    const samples = times.map((t, i) => ({ t: Math.floor(new Date(t + "Z").getTime()/1000), tempC: temps[i] }))
      .filter(s => Number.isFinite(s.tempC)).sort((a,b) => a.t - b.t);
    return { samples, tz: r.timezone };
  } catch { return { samples: [], tz: null }; }
}

// Merge METAR (past) + Open-Meteo (future) for best signal
// Weather cache — key = city|date. Weather updates hourly, so we cache per
// city+date for WEATHER_TTL_SEC (default 10 min) to avoid hammering APIs on
// fast scan intervals.
const _weatherCache = new Map();  // key -> {at, metar, openMeteo}

async function getObservationsForMarket(market) {
  const key = `${market.city}__${market.date}`;
  const nowMs = Date.now();
  const cached = _weatherCache.get(key);
  if (cached && nowMs - cached.at < CFG.WEATHER_TTL_SEC * 1000) {
    return { metar: cached.metar, openMeteo: cached.openMeteo };
  }
  const icao = STATIONS[market.city];
  const metarObs = icao ? await fetchMetar(icao, 48) : [];
  const om = await fetchOpenMeteo(market.city, null);
  _weatherCache.set(key, { at: nowMs, metar: metarObs, openMeteo: om.samples });
  return { metar: metarObs, openMeteo: om.samples };
}

/**
 * Same logic as backtest.mjs computeEntrySignal.
 * Returns {side, reason, cushion} or null.
 */
function computeEntrySignal(market, metarObs, omObs, nowSec, buffer, forecastBuf) {
  if (!market || market.threshold == null) return null;
  const thrC = toC(market.threshold, market.unit);

  // Observed max so far — PREFER METAR (Polymarket resolver source)
  const primaryObs = metarObs.length ? metarObs : omObs;
  if (!primaryObs.length) return null;
  let obsMax = -999;
  for (const o of primaryObs) {
    if (o.t > nowSec) break;
    if (o.tempC > obsMax) obsMax = o.tempC;
  }
  if (obsMax <= -999) obsMax = null;

  // Forecast max — Open-Meteo only (METAR doesn't forecast)
  let fMax = -999;
  for (const o of omObs) if (o.tempC > fMax) fMax = o.tempC;
  // Blend with past METAR observations (they may extend beyond Open-Meteo's past reach)
  for (const o of metarObs) if (o.tempC > fMax) fMax = o.tempC;
  if (fMax <= -999) fMax = null;

  if (market.isLowest) {
    if (!primaryObs.length) return null;
    let obsMin = 999;
    for (const o of primaryObs) { if (o.t > nowSec) break; if (o.tempC < obsMin) obsMin = o.tempC; }
    if (obsMin >= 999) return null;
    if (market.type === "exact" && obsMin < thrC - buffer)
      return { side: "NO", reason: "lowest-observed-below", cushion: thrC - obsMin };
    return null;
  }

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
    const thrHiC = toC(market.thresholdHigh, market.unit);
    if (obsMax != null && obsMax > thrHiC + buffer)
      return { side: "NO", reason: "observed-above-range", cushion: obsMax - thrHiC };
  }
  return null;
}

// Dynamic sizing tier (same as backtest.mjs)
function sizeMultiplier(sig) {
  if (sig.side === "NO") {
    if (sig.reason === "observed-above" && sig.cushion >= 1.5) return 1.0;
    return 0.7;
  }
  return sig.cushion > 0.3 ? 0.4 : 0.2;
}

async function simulateEntry(market, mkt, sig, currentPrice) {
  const sideMult = sizeMultiplier(sig);

  const entryPrice = sig.side === "NO" ? currentPrice : (1 - currentPrice);
  if (sig.side === "NO") {
    if (entryPrice < CFG.MIN_ENTRY_NO || entryPrice > CFG.MAX_ENTRY_NO) return null;
  } else {
    if (entryPrice < CFG.MIN_ENTRY_YES || entryPrice > CFG.MAX_ENTRY_YES) return null;
  }

  // Polymarket minimum: 5 shares. Enforce that we buy at least MIN_SHARES,
  // even if our size multiplier would have been smaller in dollars.
  const dollarSize = CFG.TRADE_SIZE * sideMult;
  let shares = Math.max(CFG.MIN_SHARES, Math.floor(dollarSize / entryPrice));
  let positionSize = shares * entryPrice;

  if (!CFG.NO_CAP && positionSize > state.bankroll) {
    console.log(`  ⏸  Insufficient bankroll for ${market.city} ${sig.side} (need $${positionSize.toFixed(2)}, have $${state.bankroll.toFixed(2)})`);
    return null;
  }

  state.bankroll -= positionSize;
  const position = {
    openedAt: new Date().toISOString(),
    openedTs: Math.floor(Date.now() / 1000),
    conditionId: mkt.conditionId,
    city: market.city,
    date: market.date,
    side: sig.side,
    reason: sig.reason,
    cushion: Math.round(sig.cushion * 10) / 10,
    entryPrice: Math.round(entryPrice * 10000) / 10000,
    shares: Math.round(shares * 100) / 100,
    positionSize,
    sizeMult: sideMult,
    title: mkt.title,
    endDate: mkt.endDate,
    closed: false,
  };
  state.positions.push(position);
  await fs.appendFile(LOG, JSON.stringify({ type: "OPEN", ...position }) + "\n");
  console.log(`  🎯 ENTRY  ${sig.side.padEnd(3)} ${market.city.padEnd(15)} ${market.date}  price=${entryPrice.toFixed(4)}  size=$${positionSize.toFixed(2)} (${(sideMult*100).toFixed(0)}%) cushion=${position.cushion}°C`);
  return position;
}

// Note: previously a `metarLockOutcome` function lived here to settle
// positions early based on METAR observations. Removed in v22 because METAR
// was being treated as a resolution oracle when Polymarket is the authority.
// METAR remains the ENTRY signal source (see computeEntrySignal).

async function resolvePositions() {
  // Polymarket is the settlement authority. METAR is the ENTRY signal, not
  // the resolution oracle (Gamma is). Settlement priority:
  //   1. Past endDate + 5min → Gamma outcomePrices = [1,0] or [0,1] → $1/$0
  //   2. Past endDate + 6h without Gamma resolution → exit at current CLOB
  //      midpoint (taker price). Honest: if Polymarket hasn't resolved, we
  //      don't pretend it has.
  //   3. Max hold reached → exit at current taker price
  //
  // No more settle-*-metar-lock or settle-*-metar. Those were booking phantom
  // $1 payouts before Polymarket had a chance to resolve. Removed in v22.
  const nowSec = Math.floor(Date.now() / 1000);
  let settled = 0, checked = 0, gammaResolved = 0, lagTaker = 0, maxholdTaker = 0, stillOpen = 0;
  for (const pos of state.positions) {
    if (pos.closed) continue;
    checked++;
    const marketEndSec = Math.floor(new Date(pos.endDate).getTime() / 1000);
    const holdMin = (nowSec - pos.openedTs) / 60;
    let exitPrice = null;
    let status = null;

    // PATH 1: past endDate + 5min → check Gamma for actual resolution
    if (nowSec >= marketEndSec + 300) {
      try {
        const mkt = await fetchJson(`${GAMMA}/markets?conditionIds=${pos.conditionId}`);
        const m = Array.isArray(mkt) ? mkt[0] : mkt;
        if (m) {
          let yesP = null, noP = null;
          if (m.outcomePrices) {
            try {
              const parsed = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
              if (Array.isArray(parsed) && parsed.length >= 2) { yesP = Number(parsed[0]); noP = Number(parsed[1]); }
            } catch {}
          }
          const priceResolved = Number.isFinite(yesP) && Number.isFinite(noP)
            && Math.max(yesP, noP) >= 0.999 && Math.min(yesP, noP) <= 0.001;
          if (priceResolved) {
            const yesWon = yesP >= 0.5;
            const ourSideWon = (pos.side === "YES" && yesWon) || (pos.side === "NO" && !yesWon);
            exitPrice = ourSideWon ? 1.0 : 0.0;
            status = ourSideWon ? "settle-win" : "settle-lose";
            gammaResolved++;
          }
        }
      } catch (err) {
        console.log(`  ⚠️  gamma check failed for ${pos.city} ${pos.date}: ${err?.message || err}`);
      }
    }

    // PATH 2: past endDate + 6h with no Gamma resolution → exit at current
    // CLOB midpoint (UMA is taking forever; honest taker exit at whatever
    // the orderbook says RIGHT NOW, no free $1 payouts).
    if (exitPrice == null && nowSec >= marketEndSec + 6 * 3600) {
      try {
        const m = await fetchJson(`${GAMMA}/markets?conditionIds=${pos.conditionId}`);
        const mk = Array.isArray(m) ? m[0] : m;
        const tokens = typeof mk?.clobTokenIds === "string" ? JSON.parse(mk.clobTokenIds) : mk?.clobTokenIds;
        if (tokens?.length >= 2) {
          const book = await fetchJson(`${CLOB}/book?token_id=${tokens[1]}`);
          const bids = Array.isArray(book?.bids) ? book.bids : [];
          const asks = Array.isArray(book?.asks) ? book.asks : [];
          const bestBid = bids.length ? Number(bids[bids.length - 1]?.price) : null;
          const bestAsk = asks.length ? Number(asks[0]?.price) : null;
          let mid = null;
          if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) mid = (bestBid + bestAsk) / 2;
          else if (Number.isFinite(bestBid)) mid = bestBid;
          else if (Number.isFinite(bestAsk)) mid = bestAsk;
          if (mid != null) {
            exitPrice = pos.side === "NO" ? mid : (1 - mid);
            status = "settle-taker-lag";
            lagTaker++;
          }
        }
      } catch {}
    }

    // PATH 3: max-hold timeout (applies regardless of endDate — e.g. maxhold
    // exceeded before endDate for long-dated markets we don't have)
    if (exitPrice == null && holdMin >= CFG.MAX_HOLD_MIN) {
      try {
        const m = await fetchJson(`${GAMMA}/markets?conditionIds=${pos.conditionId}`);
        const mk = Array.isArray(m) ? m[0] : m;
        const tokens = typeof mk?.clobTokenIds === "string" ? JSON.parse(mk.clobTokenIds) : mk?.clobTokenIds;
        const currentNo = await fetchCurrentPrice(tokens);
        if (currentNo != null) {
          exitPrice = pos.side === "NO" ? currentNo : (1 - currentNo);
          status = "maxhold-taker";
          maxholdTaker++;
        }
      } catch {}
    }

    if (exitPrice != null) {
      const pnl = pos.shares * (exitPrice - pos.entryPrice);
      const returned = pos.shares * exitPrice;
      state.bankroll += returned;
      state.realizedPnl += pnl;
      pos.closed = true;
      pos.closedAt = new Date().toISOString();
      pos.exitPrice = Math.round(exitPrice * 10000) / 10000;
      pos.status = status;
      pos.pnl = Math.round(pnl * 100) / 100;
      state.trades.push({ ...pos });
      await fs.appendFile(LOG, JSON.stringify({ type: "CLOSE", ...pos }) + "\n");
      const emoji = pnl > 0 ? "✅" : (pnl < 0 ? "❌" : "⏸");
      console.log(`  ${emoji} CLOSE ${pos.side.padEnd(3)} ${pos.city.padEnd(15)} ${pos.date}  exit=${exitPrice.toFixed(4)}  pnl=$${pnl.toFixed(2)}  ${status}`);
      settled++;
    } else {
      stillOpen++;
    }
  }
  if (checked > 0) {
    console.log(`  [resolve] checked=${checked} settled=${settled} (gamma=${gammaResolved} lag-taker=${lagTaker} maxhold=${maxholdTaker}) stillOpen=${stillOpen}  realizedPnl=$${state.realizedPnl.toFixed(2)}  bankroll=$${state.bankroll.toFixed(2)}`);
  }
  // Drop closed positions
  state.positions = state.positions.filter(p => !p.closed);
}

async function scanOnce() {
  const tScan = new Date().toISOString();
  console.log(`\n[${tScan}] Bankroll: $${state.bankroll.toFixed(2)}  Realized: $${state.realizedPnl.toFixed(2)}  Open: ${state.positions.length}  Total trades: ${state.trades.length}`);
  // (resolvePositions already called by outer fast-path loop)

  const markets = await fetchLiveWeatherMarkets();
  console.log(`  scanning ${markets.length} open weather markets...`);

  let opened = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const mk of markets) {
    const parsed = parseWeatherTitle(mk.title);
    if (!parsed || !parsed.date || parsed.threshold == null) continue;
    const endSec = Math.floor(new Date(mk.endDate).getTime() / 1000);
    const ttr = endSec - nowSec;
    if (ttr < CFG.TTR_MIN_SEC || ttr > CFG.TTR_MAX_SEC) continue;

    // Don't re-enter a market we already have a position in
    if (state.positions.some(p => p.conditionId === mk.conditionId)) continue;

    // Fetch observations
    const { metar, openMeteo } = await getObservationsForMarket(parsed);
    if (metar.length === 0 && openMeteo.length === 0) continue;

    const sig = computeEntrySignal(parsed, metar, openMeteo, nowSec, CFG.CROSSED_BUF, CFG.FORECAST_BUF);
    if (!sig) continue;

    // Fetch current price
    const noPrice = await fetchCurrentPrice(mk.clobTokenIds);
    if (noPrice == null) continue;
    const currentPrice = sig.side === "NO" ? noPrice : (1 - noPrice);
    if (sig.side === "NO" && (noPrice < CFG.MIN_ENTRY_NO || noPrice > CFG.MAX_ENTRY_NO)) continue;
    if (sig.side === "YES" && (currentPrice < CFG.MIN_ENTRY_YES || currentPrice > CFG.MAX_ENTRY_YES)) continue;

    const pos = await simulateEntry(parsed, mk, sig, noPrice);
    if (pos) opened++;
  }

  await persist();
  console.log(`  opened ${opened} new positions this scan`);
}

async function main() {
  console.log(`=== Detect engine + simulator ===`);
  console.log(`Bankroll: $${state.bankroll.toFixed(2)} (CLI=$${CFG.BANKROLL}${CFG.RESET ? ", --reset" : ""}${CFG.NO_CAP ? ", --nocap (no bankroll gate)" : ""})  Trade size: $${CFG.TRADE_SIZE} (base; dynamic 0.2-1.0x by confidence; min 5 shares enforced)`);
  console.log(`Scan intervals: market scan=${CFG.INTERVAL_SEC}s, position check=${CFG.POS_CHECK_SEC}s, weather cache=${CFG.WEATHER_TTL_SEC}s`);
  console.log(`TTR=[${CFG.TTR_MIN_SEC/3600}h, ${CFG.TTR_MAX_SEC/3600}h]`);
  console.log(`Data hierarchy:`);
  console.log(`  METAR (airport stations, ~30min lag) — PRIMARY. Matches Polymarket resolver.`);
  console.log(`  Open-Meteo forecast — used for FUTURE temps (YES signals need forecasts).`);
  console.log(`METAR stations mapped: ${Object.keys(STATIONS).length}\n`);

  // Persist immediately so the startup bankroll correction lands on disk
  // before any other action (scan / resolve / first loop write). Protects
  // against: user kills the process after the startup log but before the
  // first persist() — leaving the stale bankroll in the file.
  await persist();
  console.log(`[startup] state persisted · bankroll $${state.bankroll.toFixed(2)} · ${state.positions.length} open · ${state.trades.length} closed`);

  // Run resolvePositions once up-front so any overdue positions settle
  // immediately at startup (handles the case where detect was down during
  // resolution time)
  await resolvePositions();
  await persist();

  if (CFG.ONCE) {
    await scanOnce();
    await persist();
  } else {
    // Two-timer model: fast position tracker, slower market scanner
    let lastScan = 0;
    while (true) {
      try {
        // Always check open positions first (fast path)
        await resolvePositions();
        // Full market scan every INTERVAL_SEC
        const nowMs = Date.now();
        if (nowMs - lastScan >= CFG.INTERVAL_SEC * 1000) {
          await scanOnce();
          lastScan = nowMs;
        }
        await persist();
      } catch (e) {
        console.error(`loop error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, CFG.POS_CHECK_SEC * 1000));
    }
  }

  console.log(`\n=== FINAL SUMMARY ===`);
  console.log(`Bankroll: $${state.bankroll.toFixed(2)}`);
  console.log(`Realized PnL: $${state.realizedPnl.toFixed(2)}`);
  console.log(`Closed trades: ${state.trades.length}`);
  if (state.trades.length) {
    const wins = state.trades.filter(t => t.pnl > 0.01).length;
    const losses = state.trades.filter(t => t.pnl < -0.01).length;
    console.log(`WR: ${(100*wins/state.trades.length).toFixed(1)}% (${wins}W / ${losses}L / ${state.trades.length - wins - losses} flat)`);
  }
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
