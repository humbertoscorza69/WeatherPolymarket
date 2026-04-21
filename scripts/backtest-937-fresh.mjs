#!/usr/bin/env node
/**
 * Fresh-sim backtest: bot makes its OWN entry decisions on all cached
 * weather markets. Validates whether the strategy is viable without
 * 937's specific entry picks (i.e., can we discover the same edge
 * from market state alone?).
 *
 * Simulation model (maker-optimistic):
 *   Entry — post passive bid at sample price when:
 *     - hour(ts) is in peak window
 *     - price is in [MIN_ENTRY, MAX_ENTRY]
 *     - market city is in whitelist (or no-blacklist)
 *     - no existing open position on this market
 *     - bankroll capacity available
 *   Fill is assumed (optimistic: this sample is a printed trade at our bid price)
 *
 *   Exit — post ask at ASK_TARGET:
 *     - if any later sample within MAX_HOLD_MIN has price >= ASK_TARGET: fill at ASK_TARGET
 *     - else at timeout: cancel, flat unwind (exit price = entry price, zero PnL)
 *
 * Capital & concurrency:
 *   - Each trade commits FIXED_TRADE_USDC (default $40)
 *   - BANKROLL (default $100) constrains concurrent positions
 *   - Trades that can't be sized are skipped
 *
 * Output:
 *   stdout summary + data/backtest-937-fresh.csv per-trade
 *
 * Usage:
 *   node scripts/backtest-937-fresh.mjs
 *   node scripts/backtest-937-fresh.mjs --ask=0.999 --maxhold=15 --bankroll=100 --tradesize=40
 */

import fs from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));

const CFG = {
  ASK_TARGET:   Number(argv.ask      ?? "0.999"),
  MAX_HOLD_MIN: Number(argv.maxhold  ?? "15"),
  MIN_ENTRY:    Number(argv.minentry ?? "0.95"),
  MAX_ENTRY:    Number(argv.maxentry ?? "0.998"),
  BANKROLL:     Number(argv.bankroll ?? "100000"),  // effectively unlimited for signal research
  TRADE_USDC:   Number(argv.tradesize?? "40"),
  SIDE_ONLY:    argv.side ?? "NO",
  COOLDOWN_SEC: Number(argv.cooldown ?? "900"),
  TTR_MIN_SEC:  Number(argv.ttrmin ?? String(60*60)),
  TTR_MAX_SEC:  Number(argv.ttrmax ?? String(3*60*60)),
  // Microstructure filters derived from feature-compare.mjs:
  //   - n1m >= 1: prior 1 min must have activity (live orderbook)
  //   - p60mAgo <= MAX_P60: market has climbed in last hour
  //   - deltaFromMin15m >= MIN_DELTA_FROM_MIN_15M: price has risen from 15m low
  REQUIRE_N1M:         argv.noact !== "true",       // default ON
  MAX_P60M_AGO:        Number(argv.maxp60 ?? "0.98"),
  MIN_DELTA_MIN15M:    Number(argv.mindelta15 ?? "0.003"),
  // Optional: city filter (default OFF — 937 trades many cities)
  CITY_WHITELIST: argv.cities ? argv.cities.split(",") : [],
};

const CACHE_DIR = path.resolve("data/resolved-market-cache");
const OUT_CSV = path.resolve("data/backtest-937-fresh.csv");

const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : "nan";

function cityFromTitle(title) {
  if (!title) return null;
  const m = title.match(/(?:temperature in|temp in) ([A-Z][\w .\-']+?)(?:\s+be|\s+on|,)/i);
  return m ? m[1].trim() : null;
}

function loadMarket(file) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));
    if (!Array.isArray(j.samples) || j.samples.length < 3) return null;
    return j;
  } catch { return null; }
}

function hourOf(ts) { return new Date(ts * 1000).getUTCHours(); }

function simulateMarket(market, state) {
  const city = cityFromTitle(market.title);
  if (CFG.CITY_WHITELIST.length && !CFG.CITY_WHITELIST.includes(city)) return [];
  if (market.side !== CFG.SIDE_ONLY) return [];
  // Only weather
  if (market.category && market.category !== "weather") return [];
  if (!/temperature/i.test(market.title || "")) return [];

  const samples = market.samples;
  const trades = [];

  let position = null;
  let lastEntryTs = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (position) {
      const hold = (s.t - position.entryTs) / 60;
      if (s.p >= CFG.ASK_TARGET) {
        const exitPrice = CFG.ASK_TARGET;
        const pnl = position.shares * (exitPrice - position.entryPrice);
        trades.push({
          conditionId: market.conditionId,
          side: market.side,
          city,
          title: market.title,
          entryTs: position.entryTs,
          entryPrice: position.entryPrice,
          exitTs: s.t,
          exitPrice,
          shares: position.shares,
          usdc: position.usdc,
          holdMin: hold,
          pnl,
          status: "target-hit"
        });
        state.capitalInUse -= position.usdc;
        position = null;
      } else if (hold >= CFG.MAX_HOLD_MIN) {
        // Flat unwind
        trades.push({
          conditionId: market.conditionId,
          side: market.side,
          city,
          title: market.title,
          entryTs: position.entryTs,
          entryPrice: position.entryPrice,
          exitTs: s.t,
          exitPrice: position.entryPrice,
          shares: position.shares,
          usdc: position.usdc,
          holdMin: hold,
          pnl: 0,
          status: "timeout-flat"
        });
        state.capitalInUse -= position.usdc;
        position = null;
      }
    }
    if (!position) {
      const h = hourOf(s.t);
      const inPeak = CFG.PEAK_HOURS.includes(h);
      const inBand = s.p >= CFG.MIN_ENTRY && s.p <= CFG.MAX_ENTRY;
      const offCd = (s.t - lastEntryTs) >= CFG.COOLDOWN_SEC;
      const hasCap = (state.capitalInUse + CFG.TRADE_USDC) <= CFG.BANKROLL;
      if (inPeak && inBand && offCd && hasCap) {
        const shares = CFG.TRADE_USDC / s.p;
        position = { entryTs: s.t, entryPrice: s.p, shares, usdc: CFG.TRADE_USDC };
        state.capitalInUse += CFG.TRADE_USDC;
        lastEntryTs = s.t;
      }
    }
  }

  // Close any still-open position at last sample
  if (position) {
    const last = samples[samples.length - 1];
    trades.push({
      conditionId: market.conditionId,
      side: market.side,
      city,
      title: market.title,
      entryTs: position.entryTs,
      entryPrice: position.entryPrice,
      exitTs: last.t,
      exitPrice: position.entryPrice,
      shares: position.shares,
      usdc: position.usdc,
      holdMin: (last.t - position.entryTs) / 60,
      pnl: 0,
      status: "end-of-window-flat"
    });
    state.capitalInUse -= position.usdc;
  }
  return trades;
}

function loadAllMarkets() {
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
  const markets = [];
  for (const f of files) {
    const m = loadMarket(f);
    if (m) markets.push(m);
  }
  return markets;
}

function run() {
  console.log(`Config: ASK=${CFG.ASK_TARGET} MAX_HOLD=${CFG.MAX_HOLD_MIN}min ENTRY=[${CFG.MIN_ENTRY},${CFG.MAX_ENTRY}]`);
  console.log(`        BANKROLL=$${CFG.BANKROLL} TRADE=$${CFG.TRADE_USDC}`);
  console.log(`        TTR=[${CFG.TTR_MIN_SEC/3600}h,${CFG.TTR_MAX_SEC/3600}h] side=${CFG.SIDE_ONLY}`);
  console.log(`        filters: n1m>=1=${CFG.REQUIRE_N1M} p60mAgo<=${CFG.MAX_P60M_AGO} deltaFromMin15m>=${CFG.MIN_DELTA_MIN15M}`);
  console.log(`        cities=${CFG.CITY_WHITELIST.length ? CFG.CITY_WHITELIST.join(",") : "ALL"}\n`);

  const all = loadAllMarkets();
  console.log(`Loaded ${all.length} market cache files`);

  // Weather-only, correct side, with city on whitelist — filter count
  const eligible = all.filter(m => {
    if (m.side !== CFG.SIDE_ONLY) return false;
    if (!/temperature/i.test(m.title || "")) return false;
    const c = cityFromTitle(m.title);
    if (CFG.CITY_WHITELIST.length && !CFG.CITY_WHITELIST.includes(c)) return false;
    return true;
  });
  console.log(`Eligible weather-${CFG.SIDE_ONLY} markets in whitelisted cities: ${eligible.length}\n`);

  // Timeline-ordered simulation. For each sample we also precompute
  // microstructure features needed for the entry filter.
  const events = [];
  for (const m of eligible) {
    const city = cityFromTitle(m.title);
    const marketEndTs = m.resolutionTs || m.samples[m.samples.length - 1].t;
    const samples = m.samples;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      // n1m: count of samples in (t-60, t)
      let n1m = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (samples[j].t < s.t - 60) break;
        n1m++;
      }
      // p60mAgo: price 60 min ago (closest sample, or entry if nothing)
      let p60mAgo = s.p;
      for (let j = i - 1; j >= 0; j--) {
        if (samples[j].t <= s.t - 60 * 60) { p60mAgo = samples[j].p; break; }
      }
      // min15m: min price in prior 15 min (including current)
      let min15m = s.p;
      for (let j = i - 1; j >= 0; j--) {
        if (samples[j].t < s.t - 15 * 60) break;
        if (samples[j].p < min15m) min15m = samples[j].p;
      }
      const deltaFromMin15m = s.p - min15m;
      events.push({ t: s.t, p: s.p, market: m, city, marketEndTs, n1m, p60mAgo, deltaFromMin15m });
    }
  }
  events.sort((a, b) => a.t - b.t);

  const state = { capitalInUse: 0 };
  const positions = new Map(); // conditionId+side -> {entryTs, entryPrice, shares, usdc, city}
  const lastEntryByCid = new Map();
  const trades = [];
  const totalEntryTriggers = { evaluated: 0, blockedByCooldown: 0, blockedByBankroll: 0, opened: 0 };

  for (const ev of events) {
    const key = `${ev.market.conditionId}-${ev.market.side}`;
    const pos = positions.get(key);

    if (pos) {
      const hold = (ev.t - pos.entryTs) / 60;
      if (ev.p >= CFG.ASK_TARGET) {
        const pnl = pos.shares * (CFG.ASK_TARGET - pos.entryPrice);
        trades.push({
          conditionId: ev.market.conditionId, side: ev.market.side, city: ev.city,
          title: ev.market.title,
          entryTs: pos.entryTs, entryPrice: pos.entryPrice,
          exitTs: ev.t, exitPrice: CFG.ASK_TARGET,
          shares: pos.shares, usdc: pos.usdc, holdMin: hold, pnl, status: "target-hit"
        });
        state.capitalInUse -= pos.usdc;
        positions.delete(key);
      } else if (hold >= CFG.MAX_HOLD_MIN) {
        trades.push({
          conditionId: ev.market.conditionId, side: ev.market.side, city: ev.city,
          title: ev.market.title,
          entryTs: pos.entryTs, entryPrice: pos.entryPrice,
          exitTs: ev.t, exitPrice: pos.entryPrice,
          shares: pos.shares, usdc: pos.usdc, holdMin: hold, pnl: 0, status: "timeout-flat"
        });
        state.capitalInUse -= pos.usdc;
        positions.delete(key);
      }
    }
    if (!positions.has(key)) {
      const inBand = ev.p >= CFG.MIN_ENTRY && ev.p <= CFG.MAX_ENTRY;
      const ttr = ev.marketEndTs - ev.t;
      const inTtrWindow = ttr >= CFG.TTR_MIN_SEC && ttr <= CFG.TTR_MAX_SEC;
      // Microstructure gates
      const actOk = !CFG.REQUIRE_N1M || ev.n1m >= 1;
      const p60Ok = ev.p60mAgo <= CFG.MAX_P60M_AGO;
      const deltaOk = ev.deltaFromMin15m >= CFG.MIN_DELTA_MIN15M;
      if (inBand && inTtrWindow && actOk && p60Ok && deltaOk) {
        totalEntryTriggers.evaluated++;
        const lastTs = lastEntryByCid.get(key) || 0;
        const offCd = (ev.t - lastTs) >= CFG.COOLDOWN_SEC;
        const hasCap = (state.capitalInUse + CFG.TRADE_USDC) <= CFG.BANKROLL;
        if (!offCd) { totalEntryTriggers.blockedByCooldown++; continue; }
        if (!hasCap) { totalEntryTriggers.blockedByBankroll++; continue; }
        const shares = CFG.TRADE_USDC / ev.p;
        positions.set(key, {
          entryTs: ev.t, entryPrice: ev.p, shares, usdc: CFG.TRADE_USDC, city: ev.city
        });
        state.capitalInUse += CFG.TRADE_USDC;
        lastEntryByCid.set(key, ev.t);
        totalEntryTriggers.opened++;
      }
    }
  }

  // Close any still-open positions at end of data
  for (const [key, pos] of positions) {
    const last = eligible.find(m => `${m.conditionId}-${m.side}` === key)?.samples?.at(-1);
    if (last) {
      trades.push({
        conditionId: key.split("-")[0], side: pos.city ? "NO" : "",
        city: pos.city, title: "",
        entryTs: pos.entryTs, entryPrice: pos.entryPrice,
        exitTs: last.t, exitPrice: pos.entryPrice,
        shares: pos.shares, usdc: pos.usdc, holdMin: (last.t - pos.entryTs) / 60,
        pnl: 0, status: "end-of-window-flat"
      });
    }
  }

  // Stats
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalUsdc = trades.reduce((s, t) => s + t.usdc, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const flat = trades.filter(t => t.pnl === 0).length;
  const targetHit = trades.filter(t => t.status === "target-hit").length;

  const firstTs = trades.length ? Math.min(...trades.map(t => t.entryTs)) : 0;
  const lastTs = trades.length ? Math.max(...trades.map(t => t.exitTs)) : 0;
  const spanDays = (lastTs - firstTs) / 86400;

  console.log(`\n-- ENTRY TRIGGERS --`);
  console.log(`evaluated: ${totalEntryTriggers.evaluated}`);
  console.log(`blocked by cooldown: ${totalEntryTriggers.blockedByCooldown}`);
  console.log(`blocked by bankroll: ${totalEntryTriggers.blockedByBankroll}`);
  console.log(`opened positions:    ${totalEntryTriggers.opened}`);

  console.log(`\n-- EXIT STATUSES --`);
  const byStatus = new Map();
  for (const t of trades) byStatus.set(t.status, (byStatus.get(t.status) || 0) + 1);
  for (const [k, v] of byStatus) console.log(`  ${k}: ${v}`);

  console.log(`\n-- PNL --`);
  console.log(`total trades:       ${trades.length}`);
  console.log(`wins / losses / flat: ${wins} / ${losses} / ${flat}`);
  console.log(`target-hit rate:    ${trades.length ? (100*targetHit/trades.length).toFixed(1)+"%" : "-"}`);
  console.log(`total PnL:          $${fmt(totalPnl)}`);
  console.log(`avg PnL/trade:      $${fmt(totalPnl/Math.max(1, trades.length), 3)}`);
  console.log(`total capital deployed: $${fmt(totalUsdc, 0)}`);
  console.log(`return on deployed: ${fmt(100*totalPnl/Math.max(1,totalUsdc), 2)}%`);

  console.log(`\n-- TIME --`);
  console.log(`first trade: ${new Date(firstTs*1000).toISOString()}`);
  console.log(`last trade:  ${new Date(lastTs*1000).toISOString()}`);
  console.log(`span days:   ${fmt(spanDays, 1)}`);
  console.log(`PnL/day:     $${fmt(totalPnl/Math.max(0.1, spanDays), 2)}`);
  console.log(`trades/day:  ${fmt(trades.length/Math.max(0.1, spanDays), 1)}`);

  // Per-city breakdown
  const byCity = new Map();
  for (const t of trades) {
    const c = t.city || "(?)";
    if (!byCity.has(c)) byCity.set(c, { n:0, pnl:0, wins:0 });
    const b = byCity.get(c);
    b.n++; b.pnl += t.pnl; if (t.pnl > 0) b.wins++;
  }
  console.log(`\n-- PER-CITY --`);
  for (const [c, b] of [...byCity.entries()].sort((a,b)=>b[1].pnl-a[1].pnl)) {
    const wr = b.n ? (100*b.wins/b.n).toFixed(0)+"%" : "-";
    console.log(`  ${c.padEnd(20)} n=${String(b.n).padStart(4)}  pnl=$${fmt(b.pnl).padStart(8)}  wr=${wr}`);
  }

  // CSV output
  const header = "conditionId,side,city,entryTs,entryPrice,exitTs,exitPrice,shares,usdc,holdMin,pnl,status,title";
  const rows = trades.map(t => [
    t.conditionId, t.side, t.city || "", t.entryTs, t.entryPrice.toFixed(4),
    t.exitTs, t.exitPrice.toFixed(4), t.shares.toFixed(2), t.usdc.toFixed(2),
    t.holdMin.toFixed(1), t.pnl.toFixed(4), t.status,
    (t.title || "").replace(/,/g, " ")
  ].join(","));
  fs.writeFileSync(OUT_CSV, [header, ...rows].join("\n") + "\n");
  console.log(`\nCSV: ${OUT_CSV}`);
}

run();
