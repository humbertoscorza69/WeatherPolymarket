#!/usr/bin/env node
/**
 * Stage 1: universe forward backtest of the 900e rule.
 *
 * For every (city, date) group in the universe:
 *   - load weather + ticks for every market in the group
 *   - walk forward in 15-minute snapshots from group start to group end
 *   - at each snapshot, for each market, compute features (NO LOOKAHEAD)
 *   - if the 900e rule fires, simulate a forward entry at ask, exit with
 *     the validated rule (profit >= 0.98, no stop, timeout 120min)
 *   - compound PnL with fixed $100 per trade (comparable across markets)
 *
 * Cheats avoided:
 *   - weather samples: only t <= snapshotTs
 *   - tick features: only timestamp < snapshotTs
 *   - forward exit: only ticks with timestamp > snapshotTs
 *   - never uses the market's resolution or 900e's exit price
 *
 * Modes (CLI):
 *   --exclude-900e        skip groups 900e ever traded (Stage 2)
 *   --strip-900e-ticks    keep groups but remove 900e's own trades from the
 *                         tape before feature/exit computation (Stage 4)
 *   --profit=<f>          profit target (default 0.98)
 *   --timeout=<m>          timeout minutes (default 120)
 *   --max-dist=<c>         max |bucket - obs_max| (default 2.0)
 *   --no-max=<f>           max NO price to enter (default 0.97)
 *   --no-min=<f>           min NO price to enter (default 0.05)
 *   --freshness=<s>        max seconds since last tick (default 300)
 *   --max-total-ticks=<n>  max total prior ticks (default 250)
 *   --snap-min=<m>         snapshot cadence (default 15)
 *   --bet-usdc=<$>         fixed bet size (default 100)
 *   --limit=<n>            process only first n groups (for iteration)
 *
 * Outputs:
 *   data/analysis/universe-backtest-<tag>.csv
 *   data/analysis/universe-backtest-<tag>-report.txt
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"];
}));

const UNIVERSE = path.resolve("data/analysis/universe-markets.jsonl");
const TICK_DIR = path.resolve("data/tick-history");
const WX_DIR = path.resolve("data/weather-history");
const NINE_HUNDRED_E = "0x900e2ba4b715e8e5088899948355d74c796ff6bf";
const TRADES_900E = path.resolve(`data/wallet-trades/${NINE_HUNDRED_E}.jsonl`);
const SUMMARY_900E = path.resolve(`data/wallet-trades/${NINE_HUNDRED_E}.summary.json`);

const EXCLUDE_900E = argv["exclude-900e"] === "true";
const STRIP_900E_TICKS = argv["strip-900e-ticks"] === "true";
const PROFIT = Number(argv.profit ?? "0.98");
const TIMEOUT = Number(argv.timeout ?? "120") * 60;   // seconds
const MAX_DIST = Number(argv["max-dist"] ?? "2.0");
const MIN_DIST = Number(argv["min-dist"] ?? "0.0");
const NO_MAX = Number(argv["no-max"] ?? "0.97");
const NO_MIN = Number(argv["no-min"] ?? "0.05");
const FRESH = Number(argv.freshness ?? "300");        // seconds
const MAX_TOTAL_TICKS = Number(argv["max-total-ticks"] ?? "250");
const SNAP_MIN = Number(argv["snap-min"] ?? "15") * 60; // seconds
const BET = Number(argv["bet-usdc"] ?? "100");
const LIMIT = argv.limit ? Number(argv.limit) : Infinity;
// v3 temporal safety filters. Defaults off for backward compat; pass --min-obs-age=2 and --max-ttr=6 to enable.
const MIN_OBS_AGE_H = Number(argv["min-obs-age"] ?? "0");
const MAX_TTR_H = Number(argv["max-ttr"] ?? "99");
const STOP_FRAC = Number(argv["stop"] ?? "0");   // fraction of entry price; 0 = disabled
const ALLOW_CONTAINS = argv["no-contains"] === "true" ? false : true;
// v4 forecast oracle. --forecast=oracle uses the actual final daily max
// (LOOKAHEAD, clearly labeled) to approximate a perfect forecast. This
// bounds the strategy from above: if the oracle version doesn't pay,
// no real forecast will. --forecast=noisy adds N(0, sigma) noise to the
// oracle to simulate imperfect forecasts. --forecast-noise=<sigma>
// controls the sigma (default 2.0 °C).
const FORECAST_MODE = argv["forecast"] ?? "none";  // "none" | "oracle" | "noisy"
const FORECAST_NOISE_C = Number(argv["forecast-noise"] ?? "2.0");
const FORECAST_TOL_C = Number(argv["forecast-tol"] ?? "1.0");  // min margin for NO entry
const TAG = argv.tag ?? (EXCLUDE_900E ? "excl900e" : STRIP_900E_TICKS ? "strip900e" : "full");

const OUT = path.resolve(`data/analysis/universe-backtest-${TAG}.csv`);
const REPORT = path.resolve(`data/analysis/universe-backtest-${TAG}-report.txt`);

// Local end-of-day helper — same as extract-features.mjs.
function endOfDayUtc(date, tz) {
  if (!tz) return Math.floor(new Date(`${date}T23:59:59Z`).getTime() / 1000);
  try {
    const noonUtc = new Date(`${date}T12:00:00Z`).getTime();
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const parts = fmt.formatToParts(new Date(noonUtc));
    const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const localAsUtcMs = Date.UTC(+obj.year, +obj.month - 1, +obj.day, +obj.hour, +obj.minute, +obj.second);
    const offsetMs = localAsUtcMs - noonUtc;
    const eodLocal = new Date(`${date}T23:59:59Z`).getTime();
    return Math.floor((eodLocal - offsetMs) / 1000);
  } catch { return Math.floor(new Date(`${date}T23:59:59Z`).getTime() / 1000); }
}

function obsMaxUpTo(samples, cutoff) {
  let maxC = -Infinity;
  for (const s of samples) { if (s.t > cutoff) break; if (s.tempC > maxC) maxC = s.tempC; }
  return Number.isFinite(maxC) ? maxC : null;
}

// WARNING: LOOKAHEAD. Returns the actual daily peak across ALL samples.
// Used as a synthetic "perfect forecast" oracle to establish an upper
// bound on strategy performance. Never ship to live.
function finalMaxOracle(samples) {
  let maxC = -Infinity;
  for (const s of samples) if (s.tempC > maxC) maxC = s.tempC;
  return Number.isFinite(maxC) ? maxC : null;
}

// Box-Muller Gaussian noise — deterministic seeding via string hash.
function seededNoise(seedStr, sigma) {
  // Simple string -> uint32 hash (djb2) to seed a Mulberry32 PRNG.
  let h = 5381;
  for (let i = 0; i < seedStr.length; i++) h = ((h << 5) + h + seedStr.charCodeAt(i)) | 0;
  let state = (h >>> 0) || 1;
  const rand = () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const u1 = Math.max(1e-10, rand());
  const u2 = rand();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function lastTickBefore(ticks, cutoff, outcomeIdx) {
  let last = null;
  for (const t of ticks) {
    if (t.timestamp >= cutoff) break;
    if (t.outcomeIndex === outcomeIdx) last = t;
  }
  return last;
}

// Forward exit: walk ticks > entryTs for the entered side. Take first tick
// at >= profit target OR timeout. Never uses 900e's exit price explicitly.
function simulateExit(ticks, side, entryTs, entryPrice) {
  const wantedIdx = side === "NO" ? 1 : 0;
  const forward = ticks.filter(t => t.timestamp > entryTs && t.outcomeIndex === wantedIdx);
  if (!forward.length) return { reason: "no-ticks-after", exitPrice: null, exitTs: null };
  const timeoutTs = entryTs + TIMEOUT;
  const stopPrice = STOP_FRAC > 0 ? entryPrice * (1 - STOP_FRAC) : null;
  for (const t of forward) {
    if (t.price >= PROFIT) return { reason: "profit-take", exitPrice: t.price, exitTs: t.timestamp };
    if (stopPrice != null && t.price <= stopPrice) return { reason: "stop-loss", exitPrice: t.price, exitTs: t.timestamp };
    if (t.timestamp >= timeoutTs) return { reason: "timeout", exitPrice: t.price, exitTs: t.timestamp };
  }
  const last = forward[forward.length - 1];
  return { reason: "tape-ended", exitPrice: last.price, exitTs: last.timestamp };
}

async function main() {
  const t0 = Date.now();
  const universe = (await fs.readFile(UNIVERSE, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const byGroup = new Map();
  for (const m of universe) {
    const k = `${m.city}|${m.date}`;
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(m);
  }
  console.log(`universe: ${universe.length} markets in ${byGroup.size} groups`);

  // 900e set for --exclude-900e / --strip-900e-ticks
  let groups900e = new Set();
  if (EXCLUDE_900E || STRIP_900E_TICKS) {
    const closed = (await fs.readFile(TRADES_900E, "utf8")).trim().split("\n").map(l => JSON.parse(l));
    const summary = JSON.parse(await fs.readFile(SUMMARY_900E, "utf8"));
    const opens = summary.openPositions || [];
    const byCid = new Map(universe.map(m => [m.conditionId, m]));
    for (const e of [...closed, ...opens]) {
      const m = byCid.get(e.conditionId); if (!m) continue;
      groups900e.add(`${m.city}|${m.date}`);
    }
    console.log(`900e traded ${groups900e.size} groups`);
  }

  // Config banner
  console.log(`tag=${TAG}  excl900e=${EXCLUDE_900E}  strip900eTicks=${STRIP_900E_TICKS}`);
  console.log(`rule: |dist|<=${MAX_DIST}  no∈[${NO_MIN},${NO_MAX}]  fresh<=${FRESH}s  total<=${MAX_TOTAL_TICKS}  snap=${SNAP_MIN/60}min  obsAge>=${MIN_OBS_AGE_H}h  ttr<=${MAX_TTR_H}h  stop=${STOP_FRAC}  contains=${ALLOW_CONTAINS}`);
  console.log(`exit: profit>=${PROFIT}  no-stop  timeout=${TIMEOUT/60}min  bet=$${BET}`);

  const trades = [];
  const gkeys = [...byGroup.keys()];
  let gi = 0, groupsProcessed = 0, groupsNoWx = 0, groupsSkipped900e = 0;
  let snapshotsChecked = 0, marketsOpenedOnce = new Set();

  for (const gkey of gkeys) {
    gi++;
    if (gi > LIMIT) break;
    if (gi % 100 === 0) process.stdout.write(`  group ${gi}/${gkeys.length}  trades=${trades.length} (${((Date.now()-t0)/1000).toFixed(0)}s)\n`);
    if (EXCLUDE_900E && groups900e.has(gkey)) { groupsSkipped900e++; continue; }

    const [city, date] = gkey.split("|");
    const wxFile = path.join(WX_DIR, `${city}__${date}.json`);
    if (!existsSync(wxFile)) { groupsNoWx++; continue; }
    const wx = JSON.parse(await fs.readFile(wxFile, "utf8"));
    const eod = endOfDayUtc(date, wx.tz);
    const markets = byGroup.get(gkey);

    // Load ticks once per market, sort, optionally strip 900e's own fills
    const tickMap = new Map();
    let groupFirstTs = Infinity, groupLastTs = -Infinity;
    for (const m of markets) {
      const f = path.join(TICK_DIR, `${m.conditionId}.jsonl`);
      if (!existsSync(f)) continue;
      let ticks;
      try {
        ticks = (await fs.readFile(f, "utf8")).trim().split("\n").map(l => JSON.parse(l));
      } catch { continue; }
      ticks.sort((a, b) => a.timestamp - b.timestamp);
      if (STRIP_900E_TICKS) {
        ticks = ticks.filter(t => (t.proxyWallet || "").toLowerCase() !== NINE_HUNDRED_E);
      }
      if (!ticks.length) continue;
      tickMap.set(m.conditionId, ticks);
      if (ticks[0].timestamp < groupFirstTs) groupFirstTs = ticks[0].timestamp;
      if (ticks[ticks.length-1].timestamp > groupLastTs) groupLastTs = ticks[ticks.length-1].timestamp;
    }
    if (!tickMap.size) continue;
    groupsProcessed++;

    // Forecast: oracle/noisy use the day's actual final max. This is LOOKAHEAD
    // and only valid for upper-bound analysis, never live.
    let forecastPeakC = null;
    if (FORECAST_MODE === "oracle" || FORECAST_MODE === "noisy") {
      forecastPeakC = finalMaxOracle(wx.samples);
      if (forecastPeakC != null && FORECAST_MODE === "noisy") {
        forecastPeakC += seededNoise(`${city}|${date}`, FORECAST_NOISE_C);
      }
    }

    // Scan snapshots from first tick to end-of-day (cap horizon at eod so
    // we don't scan post-resolution noise).
    const scanStart = Math.max(groupFirstTs, eod - 30 * 3600);   // at most 30h before eod
    const scanEnd = Math.min(groupLastTs, eod);
    const firedInSnapshot = new Set();   // conditionIds already entered in this group
    for (let ts = scanStart; ts <= scanEnd; ts += SNAP_MIN) {
      const obsMax = obsMaxUpTo(wx.samples, ts);
      if (obsMax == null) continue;

      // Temporal safety filters — compute once per snapshot
      // obs_max age: find the last sample where tempC == obs_max
      let obsMaxTs = null;
      for (const s of wx.samples) { if (s.t > ts) break; if (s.tempC === obsMax) obsMaxTs = s.t; }
      const obsMaxAgeH = obsMaxTs ? (ts - obsMaxTs) / 3600 : null;
      const ttrH = (eod - ts) / 3600;
      if (obsMaxAgeH == null || obsMaxAgeH < MIN_OBS_AGE_H) continue;
      if (ttrH > MAX_TTR_H) continue;

      for (const m of markets) {
        if (firedInSnapshot.has(m.conditionId)) continue;
        const ticks = tickMap.get(m.conditionId);
        if (!ticks) continue;
        // Bucket position
        const bLoC = m.bucketLoC == null ? -Infinity : m.bucketLoC;
        const bHiC = m.bucketHiC == null ? Infinity  : m.bucketHiC;
        let bucketRel, signedDist;
        if (obsMax < bLoC)      { bucketRel = "below_obs"; signedDist = bLoC - obsMax; }
        else if (obsMax > bHiC) { bucketRel = "above_obs"; signedDist = -(obsMax - bHiC); }
        else                    { bucketRel = "contains";  signedDist = 0; }
        const absDist = Math.abs(signedDist);
        if (absDist > MAX_DIST) continue;
        if (absDist < MIN_DIST) continue;
        if (bucketRel === "contains" && !ALLOW_CONTAINS) continue;

        // Last prices and freshness
        const yesTick = lastTickBefore(ticks, ts, 0);
        const noTick  = lastTickBefore(ticks, ts, 1);
        if (!noTick) continue;
        const noAge = ts - noTick.timestamp;
        const yesAge = yesTick ? ts - yesTick.timestamp : Infinity;
        const fresh = Math.min(noAge, yesAge);
        if (fresh > FRESH) continue;
        if (noTick.price < NO_MIN || noTick.price > NO_MAX) continue;
        const priorTicks = ticks.filter(t => t.timestamp < ts).length;
        if (priorTicks > MAX_TOTAL_TICKS) continue;

        // Side selection v4 with optional forecast.
        //
        // Without forecast: "above_obs" → NO (bucket below obs, can't win),
        //                   "contains"  → YES (bucket holds current obs).
        // With forecast:    NO if bucket_hi <= forecast - TOL (definitively won't catch)
        //                   YES if forecast_peak is inside bucket
        //                   skip otherwise.
        let side;
        if (forecastPeakC != null) {
          if (bHiC + FORECAST_TOL_C <= forecastPeakC && bucketRel !== "contains") {
            // bucket ceiling is well below the forecast → bucket will not be the answer
            // This fires for both "above_obs" (already surpassed) and "below_obs"
            // (not yet reached but forecast suggests we blow past it).
            side = "NO";
          } else if (bLoC <= forecastPeakC && forecastPeakC <= bHiC) {
            // forecast peak lands inside this bucket → YES
            side = "YES";
          } else if (bLoC >= forecastPeakC + FORECAST_TOL_C) {
            // bucket floor is well above the forecast → bucket won't be reached
            side = "NO";
          } else continue;
        } else {
          if (bucketRel === "above_obs")       side = "NO";
          else if (bucketRel === "contains" && ALLOW_CONTAINS) side = "YES";
          else continue;
        }

        // Entry: pay the ask for that side. Our best proxy for "ask" is the
        // most recent same-side tick price (slightly pessimistic since that's
        // the last trade, which could have been a hit or a lift).
        const entrySideTick = side === "NO" ? noTick : yesTick;
        if (!entrySideTick) continue;
        const entryPrice = entrySideTick.price;
        // Reject entries where our-side price is already above the profit
        // target — no room to make money.
        if (entryPrice >= PROFIT) continue;
        const shares = BET / entryPrice;

        const exit = simulateExit(ticks, side, ts, entryPrice);
        if (!exit.exitPrice) continue;
        const pnl = shares * (exit.exitPrice - entryPrice);

        trades.push({
          city, date, conditionId: m.conditionId,
          bucketLoC: m.bucketLoC, bucketHiC: m.bucketHiC, kind: m.kind,
          snapshotTs: ts,
          obsMaxC: Number(obsMax.toFixed(2)),
          signedDist: Number(signedDist.toFixed(2)),
          bucketRel, side, entryPrice: Number(entryPrice.toFixed(4)),
          noPrice: Number(noTick.price.toFixed(4)),
          yesPrice: yesTick ? Number(yesTick.price.toFixed(4)) : null,
          exitPrice: Number(exit.exitPrice.toFixed(4)),
          exitTs: exit.exitTs, exitReason: exit.reason,
          holdMin: Math.round((exit.exitTs - ts) / 60),
          shares: Number(shares.toFixed(2)),
          pnl: Number(pnl.toFixed(2)),
          fresh: fresh, priorTicks,
        });
        marketsOpenedOnce.add(m.conditionId);
        firedInSnapshot.add(m.conditionId);
      }
      snapshotsChecked++;
    }
  }

  // Write CSV
  const cols = ["city","date","conditionId","bucketLoC","bucketHiC","kind","snapshotTs","obsMaxC","signedDist","bucketRel","side","entryPrice","noPrice","yesPrice","exitPrice","exitTs","exitReason","holdMin","shares","pnl","fresh","priorTicks"];
  const esc = v => v == null ? "" : (typeof v === "number" ? String(v) : (/[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v)));
  const out = [cols.join(",")];
  for (const r of trades) out.push(cols.map(c => esc(r[c])).join(","));
  await fs.writeFile(OUT, out.join("\n") + "\n");

  // Summary
  const wins = trades.filter(t => t.pnl > 0.01).length;
  const losses = trades.filter(t => t.pnl < -0.01).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const byReason = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;
  const bySide = { YES: trades.filter(t => t.side === "YES"), NO: trades.filter(t => t.side === "NO") };

  const lines = [];
  lines.push(`=== universe-backtest report · tag=${TAG} ===`);
  lines.push(`rule: |dist|<=${MAX_DIST}  no∈[${NO_MIN},${NO_MAX}]  fresh<=${FRESH}s  total<=${MAX_TOTAL_TICKS}  snap=${SNAP_MIN/60}min  obsAge>=${MIN_OBS_AGE_H}h  ttr<=${MAX_TTR_H}h  stop=${STOP_FRAC}  contains=${ALLOW_CONTAINS}`);
  lines.push(`exit: profit>=${PROFIT}  no-stop  timeout=${TIMEOUT/60}min  bet=$${BET}`);
  lines.push(`scanned: ${groupsProcessed} groups (no-wx=${groupsNoWx} skip900e=${groupsSkipped900e} limit=${LIMIT === Infinity ? "none" : LIMIT})`);
  lines.push(`snapshots: ${snapshotsChecked}   unique markets entered: ${marketsOpenedOnce.size}`);
  lines.push(``);
  lines.push(`=== trades ===`);
  lines.push(`n=${trades.length}  wins=${wins}  losses=${losses}  WR=${trades.length ? (100*wins/trades.length).toFixed(1) : "—"}%`);
  lines.push(`total PnL: $${totalPnl.toFixed(2)}   avg: $${trades.length ? (totalPnl/trades.length).toFixed(3) : "0"}/trade`);
  lines.push(`bet size:  $${BET}  per trade  (total risk = $${(BET * trades.length).toFixed(0)})`);
  lines.push(``);
  lines.push(`=== by side ===`);
  for (const [s, sub] of Object.entries(bySide)) {
    if (!sub.length) continue;
    const sw = sub.filter(t => t.pnl > 0.01).length;
    const sp = sub.reduce((a,b)=>a+b.pnl, 0);
    lines.push(`  ${s}: n=${sub.length}  WR=${(100*sw/sub.length).toFixed(1)}%  pnl=$${sp.toFixed(2)}  avg=$${(sp/sub.length).toFixed(3)}`);
  }
  lines.push(``);
  lines.push(`=== by exit reason ===`);
  for (const [r, n] of Object.entries(byReason).sort((a,b)=>b[1]-a[1])) {
    const sub = trades.filter(t => t.exitReason === r);
    const rp = sub.reduce((a,b)=>a+b.pnl, 0);
    const rw = sub.filter(t => t.pnl > 0.01).length;
    lines.push(`  ${r.padEnd(15)} n=${String(n).padStart(5)}  WR=${(100*rw/sub.length).toFixed(1)}%  pnl=$${rp.toFixed(2)}`);
  }
  lines.push(``);
  lines.push(`=== PnL distribution ===`);
  const pnls = trades.map(t => t.pnl).sort((a,b) => a-b);
  const q = p => pnls.length ? pnls[Math.floor(p*pnls.length)] : 0;
  if (pnls.length) {
    lines.push(`  min=$${pnls[0].toFixed(2)}  p10=$${q(.1).toFixed(2)}  p50=$${q(.5).toFixed(2)}  p90=$${q(.9).toFixed(2)}  p99=$${q(.99).toFixed(2)}  max=$${pnls[pnls.length-1].toFixed(2)}`);
  }
  lines.push(``);
  lines.push(`=== top 10 losses ===`);
  const sortedPnl = [...trades].sort((a,b) => a.pnl - b.pnl);
  for (const t of sortedPnl.slice(0, 10)) {
    lines.push(`  ${t.side} ${t.city.padEnd(16)} ${t.date}  dist=${t.signedDist}°C  ${t.bucketRel}  entry=${t.entryPrice}  exit=${t.exitPrice} (${t.exitReason})  pnl=$${t.pnl.toFixed(2)}`);
  }
  lines.push(``);
  lines.push(`=== top 10 wins ===`);
  for (const t of sortedPnl.slice(-10).reverse()) {
    lines.push(`  ${t.side} ${t.city.padEnd(16)} ${t.date}  dist=${t.signedDist}°C  ${t.bucketRel}  entry=${t.entryPrice}  exit=${t.exitPrice} (${t.exitReason})  pnl=$${t.pnl.toFixed(2)}`);
  }
  lines.push(``);
  lines.push(`elapsed: ${((Date.now()-t0)/1000).toFixed(0)}s`);
  lines.push(`output: ${OUT}`);
  const txt = lines.join("\n");
  console.log("\n" + txt);
  await fs.writeFile(REPORT, txt + "\n");
}

main().catch(e => { console.error(e); process.exit(1); });
