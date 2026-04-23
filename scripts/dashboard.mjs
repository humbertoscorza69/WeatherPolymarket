#!/usr/bin/env node
/**
 * Local trading dashboard for detect.mjs paper-trading output.
 *
 * Usage:
 *   node scripts/dashboard.mjs              # serves on http://localhost:8787
 *   node scripts/dashboard.mjs --port=9000
 *
 * Endpoints:
 *   GET /                → HTML dashboard (Sprint 2+)
 *   GET /api/stats       → JSON of computed metrics + all trades
 *   GET /api/health      → liveness
 */
import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));
const PORT = Number(argv.port ?? "8787");
const POSITIONS_FILE = path.resolve("data/detect-positions.json");
const LOG_FILE = path.resolve("data/detect-log.jsonl");
const UI_FILE = path.resolve("scripts/dashboard-ui.html");

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const STATIONS_FILE = path.resolve("data/metar-stations.json");
const PRICE_TTL_MS = Number(argv.pricettl ?? "30000");  // 30s cache
const PRICE_BATCH = Number(argv.pricebatch ?? "20");
const WEATHER_TTL_MS = Number(argv.weatherttl ?? "300000");  // 5min cache

const STATIONS = existsSync(STATIONS_FILE) ? JSON.parse(await fs.readFile(STATIONS_FILE, "utf8")) : {};

const num = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

// ---- Live price cache + background poller for open positions ----
// Maps conditionId -> { noPrice, ts, tokens, endDate, error }
const priceCache = new Map();
const META_TTL_MS = 24 * 60 * 60 * 1000; // tokens + endDate don't change — cache 24h
const PRICE_CONCURRENCY = Number(argv.concurrency ?? "8");
const POLLER_LOG = (argv.pricelog ?? "true") !== "false";

const diagnostics = {
  pollerStartedAt: null,
  lastPollAt: null,
  lastPollDurationMs: null,
  totalPolls: 0,
  totalGammaCalls: 0,
  totalGammaFailures: 0,
  totalClobCalls: 0,
  totalClobFailures: 0,
  lastError: null,
  positionsTracked: 0,
  positionsPriced: 0,
};

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { __error: `HTTP ${r.status}`, __body: body.slice(0, 200) };
    }
    return await r.json();
  } catch (e) { return { __error: String(e?.message || e) }; }
}

// Run async tasks with bounded concurrency
async function runParallel(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function loop() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { error: e?.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, loop));
  return results;
}

// Fetch ALL weather markets (open + closed) via /events, return
// Map<conditionId, marketData>. This replaces per-conditionId /markets
// queries which Gamma silently breaks for weather conditionIds (returns
// unrelated featured markets). The /events endpoint works reliably.
async function fetchWeatherMarketsByCondition() {
  const map = new Map();
  for (const closedFilter of [false, true]) {
    let offset = 0;
    while (offset < 5000) {
      diagnostics.totalGammaCalls++;
      const url = `${GAMMA}/events?closed=${closedFilter}&tag_slug=weather&limit=100&offset=${offset}`;
      const page = await fetchJson(url);
      if (page?.__error) { diagnostics.totalGammaFailures++; break; }
      if (!Array.isArray(page) || !page.length) break;
      for (const ev of page) {
        const children = Array.isArray(ev.markets) ? ev.markets : [];
        for (const m of children) {
          if (!m.conditionId) continue;
          let yesPrice = null, noPrice = null;
          if (m.outcomePrices) {
            try {
              const parsed = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
              if (Array.isArray(parsed) && parsed.length >= 2) {
                yesPrice = Number(parsed[0]);
                noPrice = Number(parsed[1]);
                if (!Number.isFinite(yesPrice)) yesPrice = null;
                if (!Number.isFinite(noPrice)) noPrice = null;
              }
            } catch {}
          }
          const tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          map.set(String(m.conditionId).toLowerCase(), {
            yesPrice, noPrice,
            closed: m.closed === true,
            archived: m.archived === true,
            umaResolutionStatus: m.umaResolutionStatus,
            endDate: m.endDate,
            tokens,
            lastTradePrice: m.lastTradePrice != null ? Number(m.lastTradePrice) : null,
            title: m.question || m.title,
          });
        }
      }
      if (page.length < 100) break;
      offset += 100;
    }
  }
  return map;
}

// Compatibility wrapper kept for /api/debug-market endpoint. Uses the events
// batch internally now instead of the broken /markets?conditionIds=X path.
async function fetchMarketData(conditionId) {
  const map = await fetchWeatherMarketsByCondition();
  const d = map.get(String(conditionId).toLowerCase());
  if (!d) {
    diagnostics.totalGammaFailures++;
    return { error: `conditionId not found in events listing (${map.size} markets indexed)` };
  }
  const tokens = d.tokens;
  const yesPrice = d.yesPrice, noPrice = d.noPrice;
  const priceResolved = (yesPrice === 1 && noPrice === 0) || (yesPrice === 0 && noPrice === 1)
    || (Number.isFinite(yesPrice) && Number.isFinite(noPrice) && Math.max(yesPrice, noPrice) >= 0.999 && Math.min(yesPrice, noPrice) <= 0.001);
  const closedFlag = d.closed || d.archived;
  const umaResolved = d.umaResolutionStatus === "resolved";
  const resolved = priceResolved || closedFlag || umaResolved;
  let noWon = null, yesWon = null;
  if (resolved && priceResolved) {
    noWon = noPrice >= 0.5; yesWon = yesPrice >= 0.5;
  }
  return {
    tokens,
    endDate: d.endDate,
    title: d.title,
    yesPrice, noPrice, lastTradePrice: d.lastTradePrice,
    resolved, noWon, yesWon,
    closed: closedFlag,
    priceSource: (yesPrice != null && noPrice != null) ? "gamma-outcome" : null,
    rawFlags: { closed: d.closed, archived: d.archived, umaResolutionStatus: d.umaResolutionStatus },
  };
}

// CLOB fallback — best bid + best ask from the orderbook. Used only when
// Gamma outcomePrices is missing. Returns midpoint or null.
// CLOB orderbook — returns { bestBid, bestAsk, midpoint } for the NO token.
async function fetchBook(noTokenId) {
  diagnostics.totalClobCalls++;
  const r = await fetchJson(`${CLOB}/book?token_id=${noTokenId}`);
  if (r?.__error || !r) { diagnostics.totalClobFailures++; return null; }
  const bids = Array.isArray(r.bids) ? r.bids : [];
  const asks = Array.isArray(r.asks) ? r.asks : [];
  const bestBid = bids.length ? Number(bids[bids.length - 1]?.price) : null;
  const bestAsk = asks.length ? Number(asks[0]?.price) : null;
  let midpoint = null;
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) midpoint = (bestBid + bestAsk) / 2;
  else if (Number.isFinite(bestBid)) midpoint = bestBid;
  else if (Number.isFinite(bestAsk)) midpoint = bestAsk;
  return { bestBid, bestAsk, midpoint };
}
async function fetchBookMidpoint(noTokenId) {
  const b = await fetchBook(noTokenId);
  return b?.midpoint ?? null;
}

async function refreshPricesForPositions(positions) {
  const t0 = Date.now();
  diagnostics.positionsTracked = positions.length;
  if (POLLER_LOG) console.log(`[prices] polling ${positions.length} markets (CLOB /book primary, Gamma metadata+resolution)…`);

  // Step 1: Seed the cache from the POSITION itself. detect.mjs stores
  // clobTokenIds and endDate on every position at entry time (sprint 23).
  // We trust those over re-fetching from Gamma — Gamma's conditionIds
  // filter was silently returning featured markets (Russia-Ukraine) for
  // the wrong lookups, which cached the wrong tokens across every
  // position and made every Last price show 0.73.
  for (const p of positions) {
    const cur = priceCache.get(p.conditionId) || {};
    if (!cur.tokens && Array.isArray(p.clobTokenIds) && p.clobTokenIds.length >= 2) {
      priceCache.set(p.conditionId, {
        ...cur,
        tokens: p.clobTokenIds,
        endDate: p.endDate,
        source: "pos-stored",
        metaTs: t0,
        error: null,
      });
    }
  }

  // Step 2: ONE call to /events (paginated) gives us outcomePrices, closed,
  // umaResolutionStatus for every weather market. Replaces 173 broken
  // per-conditionId /markets calls. Merge resolution info into cache.
  let marketMap = new Map();
  try { marketMap = await fetchWeatherMarketsByCondition(); } catch {}
  for (const p of positions) {
    const cur = priceCache.get(p.conditionId) || {};
    const d = marketMap.get(String(p.conditionId).toLowerCase());
    if (!d) {
      priceCache.set(p.conditionId, { ...cur, gammaError: "not-in-events" });
      continue;
    }
    const priceResolved = (d.yesPrice === 1 && d.noPrice === 0) || (d.yesPrice === 0 && d.noPrice === 1)
      || (Number.isFinite(d.yesPrice) && Number.isFinite(d.noPrice) && Math.max(d.yesPrice, d.noPrice) >= 0.999 && Math.min(d.yesPrice, d.noPrice) <= 0.001);
    const closedFlag = d.closed || d.archived;
    const umaResolved = d.umaResolutionStatus === "resolved";
    const resolved = priceResolved || closedFlag || umaResolved;
    let noWon = null, yesWon = null;
    if (resolved && priceResolved) { noWon = d.noPrice >= 0.5; yesWon = d.yesPrice >= 0.5; }
    priceCache.set(p.conditionId, {
      ...cur,
      tokens: d.tokens || cur.tokens,
      endDate: d.endDate || cur.endDate,
      gammaYes: d.yesPrice,
      gammaNo: d.noPrice,
      lastTradePrice: d.lastTradePrice,
      resolved, noWon, yesWon,
      closed: closedFlag,
      metaTs: t0,
      gammaError: null,
    });
  }

  // Step 2: CLOB /book for LIVE midpoint — the actual price you'd pay/receive
  // right now, matching what polymarket.com displays. This runs every poll;
  // no caching past this cycle. If a market is resolved, the book will be
  // nearly one-sided (bid ~0 or ask ~1) and midpoint ≈ 0 or 1 naturally.
  await runParallel(positions, async (p) => {
    const cached = priceCache.get(p.conditionId);
    if (!cached?.tokens?.[1]) return;
    const book = await fetchBook(cached.tokens[1]);
    let noPrice = null, source = null, bestBid = null, bestAsk = null;
    if (book?.midpoint != null) {
      noPrice = book.midpoint;
      source = "clob-book";
      bestBid = book.bestBid;
      bestAsk = book.bestAsk;
    } else if (cached.resolved && cached.noWon != null) {
      // Resolved market with empty book → use Gamma's 1/0 payoff
      noPrice = cached.noWon ? 1 : 0;
      source = "gamma-resolved";
    } else if (cached.gammaNo != null) {
      noPrice = cached.gammaNo;
      source = "gamma-outcome";
    } else if (Number.isFinite(cached.lastTradePrice)) {
      noPrice = cached.lastTradePrice;
      source = "gamma-lasttrade";
    }
    if (noPrice != null) {
      priceCache.set(p.conditionId, {
        ...cached,
        noPrice,
        yesPrice: 1 - noPrice,
        bestBid, bestAsk,
        source,
        ts: Date.now(),
      });
    }
  }, PRICE_CONCURRENCY);

  const now = Date.now();
  diagnostics.lastPollAt = new Date(now).toISOString();
  diagnostics.lastPollDurationMs = now - t0;
  diagnostics.totalPolls++;
  diagnostics.positionsPriced = [...priceCache.values()].filter(c => c.noPrice != null && c.ts > now - 5 * PRICE_TTL_MS).length;
  // Source breakdown (so we can see how many are on CLOB vs falling back to Gamma)
  const sourceCounts = {};
  for (const c of priceCache.values()) {
    if (c.source) sourceCounts[c.source] = (sourceCounts[c.source] || 0) + 1;
  }
  diagnostics.priceSources = sourceCounts;
  // Distinct-price sanity check
  const prices = [...priceCache.values()].map(c => c.noPrice).filter(x => x != null);
  const counts = new Map();
  for (const p of prices) counts.set(p, (counts.get(p) || 0) + 1);
  let maxDupe = 0, dupeValue = null;
  for (const [v, n] of counts) { if (n > maxDupe) { maxDupe = n; dupeValue = v; } }
  diagnostics.distinctPrices = counts.size;
  diagnostics.mostCommonPrice = dupeValue;
  diagnostics.mostCommonPriceCount = maxDupe;
  if (POLLER_LOG) console.log(`[prices] poll done in ${diagnostics.lastPollDurationMs}ms · ${diagnostics.positionsPriced}/${positions.length} priced · ${counts.size} distinct · sources ${JSON.stringify(sourceCounts)} · clob fail ${diagnostics.totalClobFailures}/${diagnostics.totalClobCalls}`);
}

// Background poller — refreshes prices every PRICE_TTL_MS regardless of HTTP traffic
async function startBackgroundPoller() {
  diagnostics.pollerStartedAt = new Date().toISOString();
  const tick = async () => {
    try {
      const { state } = await loadData();
      if (state.positions?.length) {
        await refreshPricesForPositions(state.positions);
        // Weather runs less frequently (5min TTL) but we call it every poll; cache handles rate-limiting
        await refreshWeatherForPositions(state.positions);
      }
    } catch (e) { diagnostics.lastError = String(e?.message || e); console.error(`[prices] poller error:`, e?.message || e); }
    setTimeout(tick, PRICE_TTL_MS);
  };
  tick();  // fire immediately
}

// ---- Weather ground-truth cache (for per-position verdict) ----
// Key: city|date → { metar: [{t, tempC}], fetchedAt }
const weatherCache = new Map();

function toC(v, unit) { return unit === "F" ? (v - 32) * 5/9 : v; }

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

async function fetchMetar(icao, hours = 36) {
  const url = `${METAR_API}?ids=${icao}&format=json&hours=${hours}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data
      .map(m => ({ t: typeof m.obsTime === "number" ? m.obsTime : Math.floor(new Date(m.obsTime).getTime()/1000), tempC: m.temp }))
      .filter(o => Number.isFinite(o.t) && o.tempC != null)
      .sort((a, b) => a.t - b.t);
  } catch { return []; }
}

async function getWeatherFor(city, date) {
  const key = `${city}__${date}`;
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS) return cached;
  const icao = STATIONS[city];
  if (!icao) {
    const miss = { metar: [], fetchedAt: Date.now(), noStation: true };
    weatherCache.set(key, miss);
    return miss;
  }
  const metar = await fetchMetar(icao, 36);
  // Filter to observations on this calendar date (UTC) — cheapest approximation for
  // "the day" since Polymarket titles reference local date. A ±12h window around
  // the date is more than enough for our diagnostic.
  const d0 = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000) - 12 * 3600;
  const d1 = d0 + 48 * 3600;
  const scoped = metar.filter(o => o.t >= d0 && o.t <= d1);
  const fresh = { metar: scoped, fetchedAt: Date.now(), icao };
  weatherCache.set(key, fresh);
  return fresh;
}

function computeVerdict(pos, metar) {
  const m = parseWeatherTitle(pos.title);
  if (!m || !metar?.length) return { observedMax: null, observedMin: null, threshold: null, verdict: "unknown" };
  const temps = metar.map(o => o.tempC);
  const observedMax = Math.max(...temps);
  const observedMin = Math.min(...temps);
  const thrC = toC(m.threshold, m.unit);
  const thrHiC = m.thresholdHigh != null ? toC(m.thresholdHigh, m.unit) : null;
  let verdict = "uncertain";
  const BUF = 0.2;

  if (m.isLowest) {
    // Market asks "will the lowest temperature be X". Observed_min only gets lower
    // (or stays) as the day continues — so if it's already < thr, NO is locked.
    if (observedMin < thrC - BUF) verdict = pos.side === "NO" ? "locked_win" : "locked_loss";
    else if (observedMin > thrC + BUF) verdict = pos.side === "YES" ? "leading" : "trailing";
  } else if (m.type === "between" && thrHiC != null) {
    // "between X-Y": YES wins if X <= final_max <= Y. observed_max only rises.
    if (observedMax > thrHiC + BUF) verdict = pos.side === "NO" ? "locked_win" : "locked_loss";
    else if (observedMax < thrC - BUF) verdict = "uncertain"; // depends on forecast
    else verdict = pos.side === "YES" ? "leading" : "trailing";
  } else if (m.type === "at_or_below") {
    if (observedMax > thrC + BUF) verdict = pos.side === "NO" ? "locked_win" : "locked_loss";
    else verdict = pos.side === "YES" ? "leading" : "trailing";
  } else if (m.type === "at_or_above") {
    if (observedMax > thrC + BUF) verdict = pos.side === "YES" ? "locked_win" : "locked_loss";
    else verdict = pos.side === "NO" ? "leading" : "trailing";
  } else {
    // exact: YES wins only if final_max == threshold. observed_max monotone ⇒
    // once it exceeds threshold, YES is dead.
    if (observedMax > thrC + BUF) verdict = pos.side === "NO" ? "locked_win" : "locked_loss";
    else if (observedMax < thrC - BUF - 2) verdict = pos.side === "NO" ? "leading" : "trailing";
    else verdict = "uncertain";
  }

  return {
    observedMax: Math.round(observedMax * 10) / 10,
    observedMin: Math.round(observedMin * 10) / 10,
    threshold: m.threshold,
    thresholdHigh: m.thresholdHigh,
    thresholdUnit: m.unit,
    marketType: m.type,
    isLowest: m.isLowest,
    metarSamples: metar.length,
    verdict,
  };
}

async function refreshWeatherForPositions(positions) {
  const uniq = new Map(); // city|date → {city, date}
  for (const p of positions) {
    const title = parseWeatherTitle(p.title);
    if (!title?.city || !title?.date) continue;
    const key = `${title.city}__${title.date}`;
    if (!uniq.has(key)) uniq.set(key, { city: title.city, date: title.date });
  }
  const work = [...uniq.values()];
  await runParallel(work, async (w) => { await getWeatherFor(w.city, w.date); }, 6);
}

function unrealizedFor(pos, metarVerdict) {
  const cached = priceCache.get(pos.conditionId);
  if (!cached) return { lastPrice: null, unrealizedPnl: null, unrealizedPct: null, ttrSec: null, endDate: null, resolved: false };

  let lastPrice = null;
  let didWin = null;
  let priceSource = cached.source;

  // Use pos.endDate (stored at entry time) as the authoritative resolution
  // timestamp — Gamma sometimes returns the parent event's endDate.
  const authEndDate = pos.endDate || cached.endDate;

  // Resolution is a Polymarket decision, not a METAR decision. Only Gamma's
  // explicit 0/1 outcomePrices count. METAR locks become `leading`/`trailing`
  // prediction-level verdicts but never promote to `resolved_*`.
  const resolved = !!cached.resolved;

  if (resolved && cached.noWon !== null && cached.yesWon !== null) {
    didWin = pos.side === "NO" ? cached.noWon : cached.yesWon;
    lastPrice = didWin ? 1 : 0;
    priceSource = "gamma-resolved";
  } else if (cached.noPrice != null) {
    // Live or pending-resolution market — use whatever CLOB/Gamma last gave us
    lastPrice = pos.side === "NO" ? cached.noPrice : cached.yesPrice ?? (1 - cached.noPrice);
  }

  if (lastPrice == null) return { lastPrice: null, unrealizedPnl: null, unrealizedPct: null, ttrSec: null, endDate: authEndDate, resolved };

  const unrealizedPnl = num(pos.shares) * (lastPrice - num(pos.entryPrice));
  const unrealizedPct = num(pos.entryPrice) > 0 ? (lastPrice - num(pos.entryPrice)) / num(pos.entryPrice) : 0;
  let ttrSec = null;
  if (authEndDate) {
    const end = new Date(authEndDate).getTime();
    if (Number.isFinite(end)) ttrSec = Math.max(0, Math.floor((end - Date.now()) / 1000));
  }
  return {
    lastPrice,
    unrealizedPnl,
    unrealizedPct,
    ttrSec,
    endDate: authEndDate,
    resolved,
    didWin,
    priceSource,
  };
}

async function loadData() {
  let state = { positions: [], bankroll: 0, realizedPnl: 0, trades: [] };
  if (existsSync(POSITIONS_FILE)) {
    try { state = { ...state, ...JSON.parse(await fs.readFile(POSITIONS_FILE, "utf8")) }; } catch {}
  }
  let logLines = [];
  if (existsSync(LOG_FILE)) {
    try {
      const txt = await fs.readFile(LOG_FILE, "utf8");
      logLines = txt.trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
  }
  return { state, logLines };
}

function computeStats({ state, logLines }) {
  const opens = logLines.filter(e => e.type === "OPEN");
  const closes = logLines.filter(e => e.type === "CLOSE");
  const trades = state.trades || [];

  // core counts
  const totalAttempts = opens.length;
  const totalClosed = trades.length;
  const openCount = state.positions.length;

  // PnL buckets
  const wins = trades.filter(t => num(t.pnl) > 0.01);
  const losses = trades.filter(t => num(t.pnl) < -0.01);
  const flats = trades.filter(t => Math.abs(num(t.pnl)) <= 0.01);
  const winRate = totalClosed ? wins.length / totalClosed : 0;

  const grossWin = wins.reduce((s, t) => s + num(t.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + num(t.pnl), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const realizedPnl = trades.reduce((s, t) => s + num(t.pnl), 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
  const expectancy = totalClosed ? realizedPnl / totalClosed : 0;

  // Sharpe (per-trade, annualization skipped since these are paper prediction trades,
  // not daily returns; use normalized sharpe-like ratio: mean / std of pnl).
  const pnls = trades.map(t => num(t.pnl));
  const mean = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const variance = pnls.length ? pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std : 0;
  const downside = pnls.filter(p => p < 0);
  const downMean = downside.length ? downside.reduce((a, b) => a + b ** 2, 0) / downside.length : 0;
  const sortino = downMean > 0 ? mean / Math.sqrt(downMean) : 0;

  // streaks
  let curStreak = 0, curDir = 0, maxWinStreak = 0, maxLossStreak = 0;
  const sortedByClose = [...trades].sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));
  for (const t of sortedByClose) {
    const dir = num(t.pnl) > 0.01 ? 1 : (num(t.pnl) < -0.01 ? -1 : 0);
    if (dir === 0) continue;
    if (dir === curDir) curStreak++;
    else { curStreak = 1; curDir = dir; }
    if (dir > 0 && curStreak > maxWinStreak) maxWinStreak = curStreak;
    if (dir < 0 && curStreak > maxLossStreak) maxLossStreak = curStreak;
  }
  const currentStreak = curDir * curStreak;

  // equity curve + drawdown
  let equity = 0, peak = 0, maxDD = 0, maxRunup = 0, trough = 0;
  const equityCurve = [];
  for (const t of sortedByClose) {
    equity += num(t.pnl);
    equityCurve.push({ ts: t.closedAt, equity, pnl: num(t.pnl) });
    if (equity > peak) { peak = equity; trough = equity; }
    if (equity < trough) trough = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    const ru = equity - trough;
    if (ru > maxRunup) maxRunup = ru;
  }

  // ----- advanced quant metrics -----
  // Kelly criterion (fractional): f* = p - (1-p)/b   where b = avgWin/avgLoss
  const p = winRate;
  const b = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kelly = b > 0 ? p - (1 - p) / b : 0;

  // Omega ratio (threshold = 0): sum(gains) / sum(losses)
  const omega = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // Calmar ratio (CAGR-like): realizedPnl / max drawdown — interpreted as edge / pain
  const calmar = maxDD > 0 ? realizedPnl / maxDD : (realizedPnl > 0 ? Infinity : 0);

  // VaR / CVaR at 5% (worst 5% of trades)
  const sortedAsc = [...pnls].sort((a, b) => a - b);
  const varIdx = Math.max(0, Math.floor(sortedAsc.length * 0.05) - 1);
  const var95 = sortedAsc.length ? sortedAsc[varIdx] : 0;
  const tail = sortedAsc.slice(0, varIdx + 1);
  const cvar95 = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;

  // Recovery factor: net PnL / max drawdown
  const recoveryFactor = maxDD > 0 ? realizedPnl / maxDD : 0;

  // Ulcer index: sqrt(mean(drawdown%^2)) using equity curve
  let ulcerSum = 0;
  let runPeak = 0;
  for (const pt of equityCurve) {
    if (pt.equity > runPeak) runPeak = pt.equity;
    const dd = runPeak > 0 ? ((runPeak - pt.equity) / runPeak) * 100 : 0;
    ulcerSum += dd * dd;
  }
  const ulcer = equityCurve.length ? Math.sqrt(ulcerSum / equityCurve.length) : 0;

  // Skew + kurtosis of trade PnL
  const skew = std > 0 && pnls.length >= 3
    ? pnls.reduce((a, x) => a + ((x - mean) / std) ** 3, 0) / pnls.length : 0;
  const kurt = std > 0 && pnls.length >= 4
    ? pnls.reduce((a, x) => a + ((x - mean) / std) ** 4, 0) / pnls.length - 3 : 0;

  // Monthly aggregation (year-month → totals)
  const monthly = {};
  for (const t of trades) {
    if (!t.closedAt) continue;
    const ym = String(t.closedAt).slice(0, 7);
    monthly[ym] = monthly[ym] || { n: 0, pnl: 0, w: 0 };
    monthly[ym].n++;
    monthly[ym].pnl += num(t.pnl);
    if (num(t.pnl) > 0.01) monthly[ym].w++;
  }

  // Hourly heatmap (UTC hour → totals) for activity pattern
  const hourly = Array.from({ length: 24 }, () => ({ n: 0, pnl: 0, w: 0 }));
  for (const t of trades) {
    if (!t.closedAt) continue;
    const h = new Date(t.closedAt).getUTCHours();
    hourly[h].n++;
    hourly[h].pnl += num(t.pnl);
    if (num(t.pnl) > 0.01) hourly[h].w++;
  }

  // hold time
  const holds = trades.map(t => {
    const o = new Date(t.openedAt).getTime();
    const c = new Date(t.closedAt || Date.now()).getTime();
    return (c - o) / 60000; // minutes
  }).filter(h => h > 0);
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
  const medianHold = holds.length ? [...holds].sort((a, b) => a - b)[Math.floor(holds.length / 2)] : 0;

  // fill rate (OPEN events are always "filled" in paper mode, so use signal-to-close ratio)
  // Real fill rate requires knowing how many signals were REJECTED — we can use the
  // Insufficient-bankroll log as a proxy, but those are in console not JSONL. For now
  // report "attempt success" = closed / opened (open-still-running count excluded).
  const fillRate = totalAttempts ? (totalAttempts - openCount - 0) / totalAttempts : 0;

  // largest / smallest
  const sortedPnl = [...pnls].sort((a, b) => a - b);
  const largestLoss = sortedPnl[0] ?? 0;
  const largestWin = sortedPnl[sortedPnl.length - 1] ?? 0;

  // breakdowns
  const bySide = {};
  const byReason = {};
  const byCity = {};
  const byCushion = {};
  // Thermal-edge matrix: cushion-bucket × threshold-temp-bucket → { n, w, pnl }
  const thermalBuckets = {};  // key "cushion|threshold"
  const extractThreshold = (title) => {
    if (!title) return null;
    const m = String(title).match(/be\s+(-?\d+(?:\.\d+)?)°?C/i);
    return m ? Number(m[1]) : null;
  };
  for (const t of trades) {
    const s = t.side || "?"; bySide[s] = bySide[s] || { n: 0, pnl: 0, w: 0 };
    bySide[s].n++; bySide[s].pnl += num(t.pnl); if (num(t.pnl) > 0.01) bySide[s].w++;
    const r = t.reason || "?"; byReason[r] = byReason[r] || { n: 0, pnl: 0, w: 0 };
    byReason[r].n++; byReason[r].pnl += num(t.pnl); if (num(t.pnl) > 0.01) byReason[r].w++;
    const c = t.city || "?"; byCity[c] = byCity[c] || { n: 0, pnl: 0, w: 0 };
    byCity[c].n++; byCity[c].pnl += num(t.pnl); if (num(t.pnl) > 0.01) byCity[c].w++;
    const cu = Math.round(num(t.cushion) * 2) / 2;
    byCushion[cu] = byCushion[cu] || { n: 0, pnl: 0, w: 0 };
    byCushion[cu].n++; byCushion[cu].pnl += num(t.pnl); if (num(t.pnl) > 0.01) byCushion[cu].w++;

    const threshold = extractThreshold(t.title);
    const cushionBucket = Math.min(6, Math.max(0, Math.floor(num(t.cushion) + 0.5))); // 0..6 integer
    if (threshold != null) {
      const tBucket = Math.round(threshold); // 1°C buckets
      const key = `${cushionBucket}|${tBucket}`;
      thermalBuckets[key] = thermalBuckets[key] || { n: 0, w: 0, pnl: 0, cushion: cushionBucket, threshold: tBucket };
      thermalBuckets[key].n++;
      thermalBuckets[key].pnl += num(t.pnl);
      if (num(t.pnl) > 0.01) thermalBuckets[key].w++;
    }
  }

  // unrealized: enrich each open position with live price + unrealized
  // (caller should have refreshed the cache before computeStats)
  let unrealized = 0;
  let totalExposure = 0;
  let unrealizedKnown = 0;
  const enrichedPositions = (state.positions || []).map(p => {
    // Compute weather-derived verdict FIRST so unrealizedFor can use it as a
    // fallback when Gamma reports resolved but prices are ambiguous.
    const title = parseWeatherTitle(p.title);
    let verdictInfo = { verdict: "unknown" };
    if (title?.city && title?.date) {
      const wx = weatherCache.get(`${title.city}__${title.date}`);
      if (wx?.metar) verdictInfo = computeVerdict(p, wx.metar);
      else if (wx?.noStation) verdictInfo = { verdict: "no-station" };
    }
    const u = unrealizedFor(p, verdictInfo.verdict);
    totalExposure += num(p.positionSize);
    if (u.unrealizedPnl != null) {
      unrealized += u.unrealizedPnl;
      unrealizedKnown++;
    }
    // Only Gamma-reported resolution (outcomePrices collapsed to [1,0] or
    // [0,1]) promotes the verdict to its resolved form. METAR's locked_win /
    // locked_loss stay as prediction-level verdicts and do NOT flip to
    // resolved — Polymarket is the authority, not the weather station.
    if (u.resolved && u.didWin === true) verdictInfo.verdict = "resolved_win";
    else if (u.resolved && u.didWin === false) verdictInfo.verdict = "resolved_loss";
    return { ...p, ...u, ...verdictInfo };
  });
  // Best/worst open
  const sortedOpen = [...enrichedPositions].filter(p => p.unrealizedPnl != null).sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);
  const bestOpen = sortedOpen[0] || null;
  const worstOpen = sortedOpen[sortedOpen.length - 1] || null;

  // rolling WR (last N trades)
  const rollingN = 30;
  const rollingWR = [];
  for (let i = 0; i < sortedByClose.length; i++) {
    const window = sortedByClose.slice(Math.max(0, i - rollingN + 1), i + 1);
    const w = window.filter(t => num(t.pnl) > 0.01).length;
    rollingWR.push({ idx: i + 1, wr: window.length ? w / window.length : 0 });
  }

  // Open-position breakdowns (for Sprint 10)
  const openBySide = { NO: 0, YES: 0 };
  const openByCity = {};
  const openByVerdict = { resolved_win: 0, resolved_loss: 0, locked_win: 0, locked_loss: 0, leading: 0, trailing: 0, uncertain: 0, unknown: 0, "no-station": 0 };
  let projectedPayoff = 0;  // from resolved + locked positions
  let pendingSettlement = 0; // count of resolved markets we haven't settled locally yet
  for (const p of enrichedPositions) {
    openBySide[p.side] = (openBySide[p.side] || 0) + 1;
    openByCity[p.city || "?"] = (openByCity[p.city || "?"] || 0) + 1;
    openByVerdict[p.verdict || "unknown"] = (openByVerdict[p.verdict || "unknown"] || 0) + 1;
    if (p.resolved) pendingSettlement++;
    if (p.verdict === "resolved_win" || p.verdict === "locked_win") projectedPayoff += num(p.shares) * (1 - num(p.entryPrice));
    else if (p.verdict === "resolved_loss" || p.verdict === "locked_loss") projectedPayoff += num(p.shares) * (0 - num(p.entryPrice));
  }
  const trueEquity = num(state.bankroll) + totalExposure + unrealized; // bankroll cash + tied-up cost basis + mark-to-market gain/loss
  const exposurePct = (num(state.bankroll) + totalExposure) > 0
    ? totalExposure / (num(state.bankroll) + totalExposure)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      bankroll: num(state.bankroll),
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      unrealizedPnl: Math.round(unrealized * 100) / 100,
      unrealizedKnownCount: unrealizedKnown,
      totalPnl: Math.round((realizedPnl + unrealized) * 100) / 100,
      equity: Math.round(trueEquity * 100) / 100,
      totalExposure: Math.round(totalExposure * 100) / 100,
      exposurePct,
      openPositions: openCount,
      totalClosed,
      totalAttempts,
      wins: wins.length,
      losses: losses.length,
      flats: flats.length,
      winRate,
      fillRate,
      profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
      payoffRatio: Number.isFinite(payoff) ? payoff : null,
      expectancy,
      avgWin, avgLoss,
      largestWin, largestLoss,
      sharpe, sortino,
      grossWin, grossLoss,
      maxDrawdown: maxDD,
      maxRunup,
      currentStreak,
      maxWinStreak,
      maxLossStreak,
      avgHoldMin: avgHold,
      medianHoldMin: medianHold,
    },
    equityCurve,
    rollingWR,
    breakdown: { bySide, byReason, byCity, byCushion },
    thermalEdge: Object.values(thermalBuckets),
    execLog: logLines.slice(-500),  // last 500 events (OPEN + CLOSE), newest last
    openBreakdown: { bySide: openBySide, byCity: openByCity, byVerdict: openByVerdict, bestOpen, worstOpen, projectedPayoff: Math.round(projectedPayoff * 100) / 100, pendingSettlement },
    quant: {
      kelly,
      omega: Number.isFinite(omega) ? omega : null,
      calmar: Number.isFinite(calmar) ? calmar : null,
      var95, cvar95,
      recoveryFactor,
      ulcerIndex: ulcer,
      skew, kurtosis: kurt,
      pnlMean: mean, pnlStd: std,
      monthly, hourly,
    },
    openPositions: enrichedPositions,
    closedTrades: sortedByClose,
  };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  try {
    if (u.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
      return;
    }
    if (u.pathname === "/api/stats") {
      const data = await loadData();
      // Background poller keeps prices fresh; we just compute from the cache.
      const stats = computeStats(data);
      stats.diagnostics = { ...diagnostics };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(stats));
      return;
    }
    if (u.pathname === "/api/refresh-prices") {
      // Force-clear cache + re-fetch immediately so caller sees fresh prices on next /api/stats
      priceCache.clear();
      try {
        const { state } = await loadData();
        if (state.positions?.length) await refreshPricesForPositions(state.positions);
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cleared: true, ...diagnostics }));
      return;
    }
    if (u.pathname === "/api/debug-market") {
      const cid = u.query.id;
      if (!cid) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "missing ?id=conditionId" })); return; }
      // Return raw Gamma response + our interpretation
      const raw = await fetchJson(`${GAMMA}/markets?conditionIds=${cid}`);
      const parsed = await fetchMarketData(cid);
      const cached = priceCache.get(cid);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ conditionId: cid, rawGamma: raw, parsed, cached }, null, 2));
      return;
    }
    if (u.pathname === "/api/diagnostics") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ...diagnostics,
        sampleCache: [...priceCache.entries()].slice(0, 3).map(([k, v]) => ({
          conditionId: k.slice(0, 14) + "…",
          hasTokens: !!v.tokens,
          noPrice: v.noPrice,
          ageMs: v.ts ? Date.now() - v.ts : null,
          error: v.error,
        })),
      }, null, 2));
      return;
    }
    if (u.pathname === "/" || u.pathname === "/index.html") {
      if (existsSync(UI_FILE)) {
        const html = await fs.readFile(UI_FILE, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<html><body style="font-family:system-ui;padding:24px;background:#0b0e14;color:#c9d1d9">
          <h1>Dashboard API ready</h1>
          <p>Sprint 1 — server is up. UI lands in sprint 2.</p>
          <p>Try <a href="/api/stats" style="color:#58a6ff">/api/stats</a> for raw JSON.</p>
          </body></html>`);
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API:       http://localhost:${PORT}/api/stats`);
  console.log(`Diagnose:  http://localhost:${PORT}/api/diagnostics`);
  console.log(`Reads:     ${POSITIONS_FILE}`);
  console.log(`           ${LOG_FILE}`);
  console.log(`Polling Polymarket every ${PRICE_TTL_MS/1000}s (concurrency=${PRICE_CONCURRENCY})`);
  startBackgroundPoller();
});
