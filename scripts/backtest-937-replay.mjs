#!/usr/bin/env node
/**
 * Replay backtest for 937 (weather NO scalper).
 *
 * Purpose: trust 937's entry decisions (time, price, market) and ask:
 *   if OUR bot had entered at the same moment with a maker-optimistic fill,
 *   and exited by OUR 5-minute-cap rule targeting 0.999,
 *   how would our PnL compare to theirs?
 *
 * This validates the EXIT model only. The entry model is tested by
 * backtest-937-fresh.mjs.
 *
 * Input:
 *   data/wallet-trades/0x937....jsonl          (each closed trade)
 *   data/resolved-market-cache/<cid>-<side>.json  (price samples)
 *
 * Output:
 *   stdout summary
 *   data/backtest-937-replay.csv (per-trade)
 */

import fs from "node:fs";
import path from "node:path";

const WALLET_ADDR = "0x937bcac3a8a30c07d827ad0550c3fe3a6756bfab";
const TRADE_FILE  = path.resolve(`data/wallet-trades/${WALLET_ADDR}.jsonl`);
const CACHE_DIR   = path.resolve("data/resolved-market-cache");
const OUT_CSV     = path.resolve("data/backtest-937-replay.csv");

// -------- strategy config (override via CLI: --ask=0.999 --maxhold=15) --------
const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));
const CFG = {
  ASK_TARGET:     Number(argv.ask      ?? "0.999"),
  MAX_HOLD_MIN:   Number(argv.maxhold  ?? "5"),
  MIN_ENTRY:      Number(argv.minentry ?? "0.95"),
  MAX_ENTRY:      Number(argv.maxentry ?? "0.998"),
  LIQ_MODE:       argv.liq ?? "last-sample",  // last-sample | entry | skip
};
// -----------------------------------------------------------------------------

const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : "nan";

function loadCacheSamples(conditionId, side) {
  const p = path.join(CACHE_DIR, `${conditionId}-${side}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(j.samples) ? j.samples : null;
  } catch {
    return null;
  }
}

function simulateExit(samples, entryTs, entryPrice) {
  const windowEnd = entryTs + CFG.MAX_HOLD_MIN * 60;
  // Filter samples to [entryTs, windowEnd]
  const window = samples.filter(s => s.t >= entryTs && s.t <= windowEnd);
  if (!window.length) {
    // No samples in our 5-min window: cannot simulate properly.
    return { status: "no-samples-in-window", exitPrice: entryPrice, exitTs: windowEnd, holdMin: CFG.MAX_HOLD_MIN };
  }
  // Target exit: first sample at price >= ASK_TARGET
  for (const s of window) {
    if (s.p >= CFG.ASK_TARGET) {
      return {
        status: "target-hit",
        exitPrice: CFG.ASK_TARGET,
        exitTs: s.t,
        holdMin: (s.t - entryTs) / 60
      };
    }
  }
  // Timeout: behavior depends on CFG.LIQ_MODE
  const last = window[window.length - 1];
  if (CFG.LIQ_MODE === "skip") {
    // Pretend we never entered this trade
    return { status: "skipped-timeout", exitPrice: entryPrice, exitTs: windowEnd, holdMin: CFG.MAX_HOLD_MIN };
  }
  if (CFG.LIQ_MODE === "entry") {
    // Unwind flat at entry (best-case maker: cancel + no fill)
    return { status: "timeout-flat", exitPrice: entryPrice, exitTs: windowEnd, holdMin: CFG.MAX_HOLD_MIN };
  }
  return {
    status: "timeout-liquidate",
    exitPrice: last.p,
    exitTs: last.t,
    holdMin: (last.t - entryTs) / 60
  };
}

function classify(trade) {
  const e = trade.entryAvg;
  if (!Number.isFinite(e)) return { skip: "bad-entry" };
  if (e < CFG.MIN_ENTRY) return { skip: "entry-too-low" };
  if (e > CFG.MAX_ENTRY) return { skip: "entry-too-high" };
  return { skip: null };
}

function run() {
  if (!fs.existsSync(TRADE_FILE)) {
    console.error(`Missing ${TRADE_FILE}`);
    process.exit(1);
  }
  const trades = fs.readFileSync(TRADE_FILE, "utf8").trim().split("\n")
    .filter(Boolean).map(JSON.parse);
  console.log(`Loaded ${trades.length} trades for 937`);
  console.log(`Config: ASK=${CFG.ASK_TARGET} MAX_HOLD=${CFG.MAX_HOLD_MIN}min ENTRY=[${CFG.MIN_ENTRY},${CFG.MAX_ENTRY}]`);

  let nSkipReason = new Map();
  let nCacheMiss = 0, nCacheHit = 0;
  let nTargetHit = 0, nTimeout = 0, nNoSamples = 0;
  let actualPnlTotal = 0, simPnlTotal = 0;
  let actualPnlTakenSubset = 0;
  const rows = [];
  const perTrade = [];

  for (const t of trades) {
    const cls = classify(t);
    if (cls.skip) {
      nSkipReason.set(cls.skip, (nSkipReason.get(cls.skip) || 0) + 1);
      actualPnlTotal += t.pnlUsdc || 0;
      continue;
    }
    const samples = loadCacheSamples(t.conditionId, t.side);
    if (!samples) {
      nCacheMiss += 1;
      actualPnlTotal += t.pnlUsdc || 0;
      continue;
    }
    nCacheHit += 1;

    const res = simulateExit(samples, t.openTs, t.entryAvg);
    const simPnl = t.shares * (res.exitPrice - t.entryAvg);
    const actualPnl = t.pnlUsdc || 0;

    if (res.status === "target-hit") nTargetHit += 1;
    else if (res.status === "timeout-liquidate") nTimeout += 1;
    else nNoSamples += 1;

    actualPnlTotal += actualPnl;
    actualPnlTakenSubset += actualPnl;
    simPnlTotal += simPnl;

    perTrade.push({ actualPnl, simPnl, status: res.status, holdMin: res.holdMin });

    rows.push([
      t.conditionId, t.side, t.openTs, t.entryAvg.toFixed(4),
      t.exitPrice?.toFixed?.(4) ?? "", t.holdMinutes?.toFixed?.(1) ?? "",
      t.shares.toFixed(2), actualPnl.toFixed(4),
      res.status, res.exitPrice.toFixed(4), res.holdMin.toFixed(1),
      simPnl.toFixed(4), (simPnl - actualPnl).toFixed(4),
      (t.title || "").replace(/,/g, " ")
    ].join(","));
  }

  // CSV out
  fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  const header = "conditionId,side,openTs,walletEntry,walletExit,walletHoldMin,shares,actualPnl,simStatus,simExit,simHoldMin,simPnl,gap,title";
  fs.writeFileSync(OUT_CSV, [header, ...rows].join("\n") + "\n");

  console.log(`\n-- REPLAY RESULTS --`);
  console.log(`skipped by filter:`);
  for (const [k,v] of nSkipReason) console.log(`  ${k}: ${v}`);
  console.log(`cache hits: ${nCacheHit}  misses: ${nCacheMiss}`);
  console.log(`simulated exits: target-hit=${nTargetHit}  timeout=${nTimeout}  no-samples=${nNoSamples}`);

  const eligibleCount = nCacheHit;
  const winRate = perTrade.length ? (100 * perTrade.filter(p => p.simPnl > 0).length / perTrade.length).toFixed(1) + "%" : "-";

  console.log(`\n-- PNL --`);
  console.log(`wallet total (all 682 trades):           $${fmt(actualPnlTotal)}`);
  console.log(`wallet total (subset we simulated, n=${eligibleCount}): $${fmt(actualPnlTakenSubset)}`);
  console.log(`bot sim total (same subset):             $${fmt(simPnlTotal)}`);
  console.log(`diff (sim - wallet):                     $${fmt(simPnlTotal - actualPnlTakenSubset)}`);
  console.log(`sim PnL/trade (avg):                     $${fmt(simPnlTotal / Math.max(1, eligibleCount), 3)}`);
  console.log(`sim win rate:                            ${winRate}`);
  console.log(`\nCSV: ${OUT_CSV}`);
}

run();
