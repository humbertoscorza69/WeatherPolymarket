#!/usr/bin/env node
/**
 * Validate the resolution-taker backtest math against 4 winning wallets'
 * ACTUAL trades.
 *
 * Logic
 * -----
 * For each closed trade emitted by fetch-wallet-trades:
 *   1. Look up the matching market in data/resolved-market-cache/ (keyed by
 *      conditionId + side).
 *   2. Take the wallet's REAL entry: price = trade.entryAvg, ts = trade.openTs.
 *   3. Compute what our backtest math SAYS the trade should earn if held to
 *      resolution, given the resolved-market's tokenResolutionValue:
 *        backtestPnl = trade.shares × (tokenResolutionValue − trade.entryAvg)
 *   4. Compare to the trade's ACTUAL realized pnlUsdc (which reflects the
 *      wallet's exit — whether they sold early or got redeemed at $1).
 *
 * Interpretation of the gap
 * -------------------------
 *   - If backtestPnl ≈ actualPnl across all trades: our engine's math
 *     reproduces ground truth. The grid config is the only thing to fix.
 *   - If backtestPnl > actualPnl systematically: we're overestimating (the
 *     wallets exit BEFORE resolution and give up some upside — that's the
 *     "retail sells at 0.999 before $1.00" edge we're fading).
 *   - If backtestPnl < actualPnl or signs flip: engine bug. Don't touch the
 *     grid until we figure out why.
 *
 * We also report "coverage" — how many trades we could match to the cache.
 * Trades on markets we never fetched, or whose cache doesn't reach the
 * wallet's entry timestamp, are skipped.
 *
 * Usage
 * -----
 *   npm run validate-backtest
 *   npm run validate-backtest -- --wallet=0xfc25f141ed27bb1787338d2c4e7f51e3a15e1f7f
 */

import fs from "node:fs/promises";
import path from "node:path";

const CACHE_DIR = path.resolve("data/resolved-market-cache");
const TRADES_DIR = path.resolve("data/wallet-trades");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const walletFilter = args.wallet ? String(args.wallet).toLowerCase() : null;

function median(a) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function pct(a, q) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * q)))];
}

async function loadCacheIndex() {
  // Build a map conditionId → { YES?: cacheRecord, NO?: cacheRecord }
  let files;
  try {
    files = await fs.readdir(CACHE_DIR);
  } catch (e) {
    console.error(`Cache directory missing: ${CACHE_DIR}`);
    console.error(`Run 'npm run fetch-resolved-markets' first.`);
    process.exit(1);
  }
  const index = new Map();
  let loaded = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(CACHE_DIR, f), "utf8"));
      if (!raw.conditionId || !raw.side) continue;
      if (!index.has(raw.conditionId)) index.set(raw.conditionId, {});
      index.get(raw.conditionId)[raw.side] = raw;
      loaded++;
    } catch (_) { /* ignore malformed */ }
  }
  return { index, loaded };
}

async function loadWalletTrades() {
  let files;
  try {
    files = await fs.readdir(TRADES_DIR);
  } catch (e) {
    console.error(`Trades directory missing: ${TRADES_DIR}`);
    console.error(`Run 'npm run fetch-wallet-trades' first.`);
    process.exit(1);
  }
  const walletTrades = new Map(); // wallet → trades[]
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const addr = f.replace(".jsonl", "").toLowerCase();
    if (walletFilter && addr !== walletFilter) continue;
    const body = await fs.readFile(path.join(TRADES_DIR, f), "utf8");
    const trades = body.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    walletTrades.set(addr, trades);
  }
  return walletTrades;
}

/**
 * Given a cache record and an entry timestamp, find the closest sample and
 * return our backtest's estimated entry price. Also return the time gap so
 * we can flag trades that fell outside the cached 72h pre-resolution window.
 */
function lookupSamplePrice(cacheRecord, entryTs) {
  const samples = cacheRecord.samples;
  if (!samples || samples.length === 0) return null;
  // Binary search for closest timestamp
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].t < entryTs) lo = mid + 1;
    else hi = mid;
  }
  const i = lo;
  const prev = samples[Math.max(0, i - 1)];
  const next = samples[Math.min(samples.length - 1, i)];
  const closest = Math.abs(prev.t - entryTs) < Math.abs(next.t - entryTs) ? prev : next;
  return {
    samplePrice: closest.p,
    sampleTs: closest.t,
    gapSeconds: closest.t - entryTs,
    insideWindow: entryTs >= samples[0].t - 60 && entryTs <= samples[samples.length - 1].t + 60
  };
}

function validateWallet(addr, trades, cacheIndex) {
  const rows = [];
  const stats = {
    wallet: addr,
    totalTrades: trades.length,
    matchedConditionId: 0,
    matchedWithSamples: 0,
    matchedInWindow: 0,
    actualTotalPnl: 0,
    backtestTotalPnl_atActualEntry: 0,
    backtestTotalPnl_atSamplePrice: 0,
    categoriesCovered: new Map()
  };

  for (const t of trades) {
    stats.actualTotalPnl += t.pnlUsdc;

    const ciEntry = cacheIndex.get(t.conditionId);
    if (!ciEntry) continue;
    stats.matchedConditionId++;

    const cacheRecord = ciEntry[t.side];
    if (!cacheRecord) continue;
    stats.matchedWithSamples++;

    const cat = cacheRecord.category ?? "other";
    stats.categoriesCovered.set(cat, (stats.categoriesCovered.get(cat) ?? 0) + 1);

    const lookup = lookupSamplePrice(cacheRecord, t.openTs);
    if (!lookup) continue;
    if (!lookup.insideWindow) continue;
    stats.matchedInWindow++;

    // Two variants of the comparison:
    //   (a) backtestPnl using the wallet's EXACT entry price → tests our PnL
    //       math vs their realized outcome
    //   (b) backtestPnl using our SAMPLE price at that timestamp → tests
    //       whether the sample data faithfully reflects what they paid
    const res = cacheRecord.tokenResolutionValue;
    const pnlAtActualEntry = t.shares * (res - t.entryAvg);
    const pnlAtSamplePrice = t.shares * (res - lookup.samplePrice);

    stats.backtestTotalPnl_atActualEntry += pnlAtActualEntry;
    stats.backtestTotalPnl_atSamplePrice += pnlAtSamplePrice;

    rows.push({
      conditionId: t.conditionId,
      side: t.side,
      category: cat,
      shares: t.shares,
      walletEntry: t.entryAvg,
      sampleEntry: lookup.samplePrice,
      sampleGapSec: lookup.gapSeconds,
      tokenResolutionValue: res,
      actualPnl: t.pnlUsdc,
      backtestPnlActualEntry: pnlAtActualEntry,
      backtestPnlSampleEntry: pnlAtSamplePrice,
      gapActual: pnlAtActualEntry - t.pnlUsdc,
      gapSample: pnlAtSamplePrice - t.pnlUsdc
    });
  }

  // Per-trade gap distribution (sample-entry variant)
  const gapsSample = rows.map((r) => r.gapSample);
  const gapsActual = rows.map((r) => r.gapActual);
  stats.gapActualMedian = median(gapsActual);
  stats.gapActualMean = gapsActual.length ? gapsActual.reduce((s, x) => s + x, 0) / gapsActual.length : 0;
  stats.gapSampleMedian = median(gapsSample);
  stats.gapSampleMean = gapsSample.length ? gapsSample.reduce((s, x) => s + x, 0) / gapsSample.length : 0;
  stats.gapActualP05 = pct(gapsActual, 0.05);
  stats.gapActualP95 = pct(gapsActual, 0.95);

  return { stats, rows };
}

async function main() {
  console.log(`\nLoading resolved-market cache...`);
  const { index, loaded } = await loadCacheIndex();
  console.log(`  ${loaded} cache files across ${index.size} distinct conditionIds`);

  console.log(`\nLoading wallet trades...`);
  const walletTrades = await loadWalletTrades();
  if (walletTrades.size === 0) {
    console.error(`No wallet-trade JSONL files found in ${TRADES_DIR}`);
    console.error(`Run 'npm run fetch-wallet-trades' first.`);
    process.exit(1);
  }

  const allStats = [];
  for (const [addr, trades] of walletTrades.entries()) {
    const { stats, rows } = validateWallet(addr, trades, index);
    allStats.push(stats);

    // Per-wallet detail CSV so we can eyeball divergences
    const csvPath = path.join(TRADES_DIR, `${addr}.validation.csv`);
    const header = [
      "conditionId", "side", "category", "shares",
      "walletEntry", "sampleEntry", "sampleGapSec",
      "tokenResolutionValue",
      "actualPnl", "backtestPnlActualEntry", "backtestPnlSampleEntry",
      "gapActual", "gapSample"
    ].join(",");
    const body = rows.map((r) =>
      [
        r.conditionId, r.side, r.category, r.shares.toFixed(2),
        r.walletEntry.toFixed(4), r.sampleEntry.toFixed(4), r.sampleGapSec,
        r.tokenResolutionValue,
        r.actualPnl.toFixed(4), r.backtestPnlActualEntry.toFixed(4), r.backtestPnlSampleEntry.toFixed(4),
        r.gapActual.toFixed(4), r.gapSample.toFixed(4)
      ].join(",")
    ).join("\n");
    await fs.writeFile(csvPath, `${header}\n${body}\n`, "utf8");
  }

  console.log(`\n=== Ground-truth vs backtest comparison ===\n`);
  console.log(
    "wallet".padEnd(12),
    "trades".padStart(7),
    "matchCI".padStart(8),
    "matchTok".padStart(9),
    "inWin".padStart(6),
    "actualPnL".padStart(11),
    "btAtEntry".padStart(11),
    "btAtSample".padStart(12),
    "gapActual".padStart(11),
    "gapSample".padStart(11)
  );
  console.log("-".repeat(120));
  for (const s of allStats) {
    console.log(
      s.wallet.slice(0, 10).padEnd(12),
      String(s.totalTrades).padStart(7),
      String(s.matchedConditionId).padStart(8),
      String(s.matchedWithSamples).padStart(9),
      String(s.matchedInWindow).padStart(6),
      `$${s.actualTotalPnl.toFixed(0)}`.padStart(11),
      `$${s.backtestTotalPnl_atActualEntry.toFixed(0)}`.padStart(11),
      `$${s.backtestTotalPnl_atSamplePrice.toFixed(0)}`.padStart(12),
      `$${s.gapActualMean.toFixed(3)}`.padStart(11),
      `$${s.gapSampleMean.toFixed(3)}`.padStart(11)
    );
  }

  console.log(`\nColumns:`);
  console.log(`  trades      — total closed trades for this wallet`);
  console.log(`  matchCI     — trades whose conditionId appears in our cache`);
  console.log(`  matchTok    — matchCI × correct side (YES/NO) cached`);
  console.log(`  inWin       — matchTok × entry ts falls within cached 72h window`);
  console.log(`  actualPnL   — wallet's realized PnL, summed across ALL closed trades`);
  console.log(`  btAtEntry   — backtest PnL using wallet's own entry price (tests math)`);
  console.log(`  btAtSample  — backtest PnL using our sample price @ entry ts (tests data)`);
  console.log(`  gapActual   — mean per-trade (btAtEntry − actualPnL)`);
  console.log(`  gapSample   — mean per-trade (btAtSample − actualPnL)`);

  console.log(`\n=== Category coverage ===`);
  for (const s of allStats) {
    const cats = [...s.categoriesCovered.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  ${s.wallet.slice(0, 10)} → ${cats.map(([c, n]) => `${c}=${n}`).join("  ")}`);
  }

  console.log(`\n=== Interpretation cheat-sheet ===`);
  console.log(`  If matchCI << trades: need to fetch more resolved markets (categories gap).`);
  console.log(`  If gapActual ≈ 0: engine math is correct; grid config is the only thing wrong.`);
  console.log(`  If gapActual > 0 (positive gap, sample): we overestimate — wallet exits before resolution,`);
  console.log(`     giving up ~gap per trade. That's the fadable retail-exit edge.`);
  console.log(`  If gapActual < 0 or signs flip: engine bug — stop and investigate before touching grid.`);
  console.log(`\nPer-trade CSVs written to ${TRADES_DIR}/<addr>.validation.csv`);
}

main().catch((e) => { console.error("\nvalidate-backtest failed:", e); process.exit(1); });
