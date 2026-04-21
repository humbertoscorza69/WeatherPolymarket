#!/usr/bin/env node
/**
 * Historical backtest against Polymarket's real price history.
 *
 * Usage:
 *   # With active weather markets (auto-discover):
 *   npm run backtest
 *
 *   # With specific tokenIds (comma-separated):
 *   npm run backtest -- --tokens=0xabc,0xdef --interval=1h
 *
 *   # Time window override:
 *   npm run backtest -- --days=7 --interval=6h
 *
 * Requires POLYMARKET_API_KEY/SECRET/PASSPHRASE in .env to hit the CLOB REST
 * API authenticated (or can work read-only for prices-history).
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { backtest, summarizeBatch } from "../dist/src/simulation/backtest.js";
import { findActiveWeatherEvents } from "../dist/src/adapters/weatherDiscovery.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

// Polymarket's `interval` is a fixed time window (1h/6h/1d/1w/max),
// not a sample granularity — using interval=1h collapses the dataset
// to the last hour regardless of startTs/endTs. For a custom date
// range we use `fidelity` (minutes between samples) and omit interval.
// --interval=<label> is a convenience mapping to fidelity minutes.
const FIDELITY_BY_LABEL = { "1h": 60, "6h": 360, "1d": 1440 };
const intervalLabel = args.interval ?? "1h";
const fidelity = Number(args.fidelity ?? FIDELITY_BY_LABEL[intervalLabel] ?? 60);
const days = Number(args.days ?? "7");
const tokensArg = args.tokens;

const host = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  console.error("POLYMARKET_PRIVATE_KEY is required in .env");
  process.exit(1);
}
const signer = new Wallet(privateKey);
const client = new ClobClient(
  host,
  137,
  signer,
  {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE
  },
  Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1"),
  process.env.POLYMARKET_FUNDER_ADDRESS
);

// Strategy template. tickSize and halfSpread are resolved per-market in main()
// because Polymarket has both 0.001 and 0.01 tick markets.
const HALF_SPREAD_TICKS = Number(process.env.HALF_SPREAD_TICKS ?? "1");
const HALF_SPREAD_CENTS = Number(process.env.HALF_SPREAD_CENTS ?? "1");
const MIN_OUTCOME_MID = Number(process.env.MIN_OUTCOME_MID ?? "0.05");
const MAX_OUTCOME_MID = Number(process.env.MAX_OUTCOME_MID ?? "0.95");
const MAX_POSITION_PER_MARKET_USDC = Number(process.env.MAX_POSITION_PER_MARKET_USDC ?? "3");

function strategyFor(tickSize) {
  // Match live quoter behaviour: prefer halfSpreadTicks if > 0, fall back to cents
  const halfSpreadCents = HALF_SPREAD_TICKS > 0
    ? HALF_SPREAD_TICKS * tickSize * 100  // cents
    : HALF_SPREAD_CENTS;
  return {
    halfSpreadCents,
    inventorySkewCents: Number(process.env.INVENTORY_SKEW_CENTS ?? "2"),
    volMultiplier: Number(process.env.VOL_MULTIPLIER ?? "1.0"),
    volMaxExtraCents: Number(process.env.VOL_MAX_EXTRA_CENTS ?? "3"),
    volWindowSize: Number(process.env.VOL_WINDOW_SIZE ?? "60"),
    orderSizeUsdc: Number(process.env.ORDER_SIZE_USDC ?? "2"),
    tickSize,
    minShares: Number(process.env.CLOB_MIN_SHARES ?? "5"),
    refreshIntervalSec: 30,
    maxInventoryPositions: 10,
    stopLossEnabled: (process.env.STOP_LOSS_ENABLED ?? "true") !== "false",
    stopLossCatastrophicDropRatio: Number(process.env.STOP_LOSS_CATASTROPHIC_DROP ?? "0.30"),
    stopLossDeepDropRatio: Number(process.env.STOP_LOSS_DEEP_DROP ?? "0.60"),
    stopLossDeepDropMaxMinutes: Number(process.env.STOP_LOSS_DEEP_DROP_MINUTES ?? "120"),
    stopLossResolutionHours: Number(process.env.STOP_LOSS_RESOLUTION_HOURS ?? "1"),
    stopLossResolutionDropRatio: Number(process.env.STOP_LOSS_RESOLUTION_DROP ?? "0.70"),
    stopLossMaxHoldingHours: Number(process.env.STOP_LOSS_MAX_HOLDING_HOURS ?? "12"),
    takerFeeRate: 0.0125
  };
}

async function resolveTokens() {
  if (tokensArg) return tokensArg.split(",").map((s) => s.trim()).filter(Boolean);
  // Auto-discover active weather markets
  const events = await findActiveWeatherEvents({
    maxEvents: Number(process.env.MAX_EVENTS ?? "3"),
    maxOutcomesPerEvent: Number(process.env.MAX_OUTCOMES_PER_EVENT ?? "12"),
    minMarketVolumeUsdc: 0
  });
  const tokens = [];
  for (const event of events) {
    for (const market of event.markets) {
      tokens.push({ tokenId: market.yesTokenId, label: `${event.city} ${market.outcomeLabel}` });
    }
  }
  return tokens.length ? tokens : [];
}

async function fetchHistory(tokenId) {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - days * 86400;
  const raw = await client.getPricesHistory({
    market: tokenId,
    startTs,
    endTs,
    fidelity
  });
  // SDK type says MarketPrice[] but the exchange actually returns
  // {history: MarketPrice[]} in some versions. Handle both shapes and a
  // bare `null`/empty-object defensively.
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.history)) return raw.history;
    if (Array.isArray(raw.data)) return raw.data;
  }
  return [];
}

async function main() {
  console.log(`\nBacktest parameters:`);
  console.log(`  window=${days}d  fidelity=${fidelity}min (interval-label=${intervalLabel})`);
  console.log(`  HALF_SPREAD_TICKS=${HALF_SPREAD_TICKS}  HALF_SPREAD_CENTS=${HALF_SPREAD_CENTS}`);
  console.log(`  outcome band=${MIN_OUTCOME_MID}..${MAX_OUTCOME_MID}  per-market tick auto-resolved\n`);

  const tokens = await resolveTokens();
  if (tokens.length === 0) {
    console.error("No tokens to backtest (no --tokens, no active weather markets).");
    process.exit(1);
  }
  console.log(`Backtesting ${tokens.length} markets...\n`);

  const results = [];
  let bandSkips = 0;
  for (const t of tokens) {
    const tokenId = typeof t === "string" ? t : t.tokenId;
    const label = typeof t === "string" ? t.slice(0, 10) + "..." : t.label;
    try {
      // Resolve per-market tickSize so halfSpread scales correctly. Falls back
      // to 0.01 if the lookup fails.
      let tickSize = 0.01;
      try {
        const raw = await client.getTickSize(tokenId);
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) tickSize = parsed;
      } catch {
        /* keep default */
      }
      const history = await fetchHistory(tokenId);
      const samples = (history ?? []).map((p) => ({ t: p.t, p: p.p }));
      if (samples.length < 10) {
        const firstTs = samples[0]?.t;
        const lastTs = samples[samples.length - 1]?.t;
        const spanMin = firstTs && lastTs ? (lastTs - firstTs) / 60 : 0;
        console.log(`  ${label.padEnd(28)}  skipped (only ${samples.length} samples, span=${spanMin.toFixed(1)}min — market may be too fresh)`);
        continue;
      }
      // Outcome band filter: median price has to be in the tradable band.
      const sortedPrices = [...samples.map((s) => s.p)].sort((a, b) => a - b);
      const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];
      if (medianPrice < MIN_OUTCOME_MID || medianPrice > MAX_OUTCOME_MID) {
        bandSkips++;
        console.log(`  ${label.padEnd(28)}  skipped band (median=${medianPrice.toFixed(3)} outside ${MIN_OUTCOME_MID}..${MAX_OUTCOME_MID}, tick=${tickSize})`);
        continue;
      }
      const strategy = strategyFor(tickSize);
      const r = backtest(label, samples, strategy);
      results.push(r);
      console.log(
        `  ${label.padEnd(28)}  tick=${tickSize}  n=${samples.length}  span=${r.spanHours.toFixed(1)}h  fills=${r.buyFills}/${r.sellFills}  stops=${r.stopLosses}  PnL=$${r.realizedPnlUsdc.toFixed(4)}  leftover=${r.leftoverShares.toFixed(2)}sh`
      );
    } catch (err) {
      console.log(`  ${label.padEnd(28)}  error: ${String(err).slice(0, 80)}`);
    }
  }
  if (bandSkips > 0) console.log(`  (${bandSkips} markets skipped because median price was outside the tradable band)\n`);

  const batch = summarizeBatch(results);
  console.log(`\nSummary across ${batch.markets} markets:`);
  console.log(`  Total realized P&L:      $${batch.totalPnlUsdc.toFixed(3)}`);
  console.log(`  Mean P&L / market:       $${batch.mean.toFixed(3)}`);
  console.log(`  Median P&L / market:     $${batch.median.toFixed(3)}`);
  console.log(`  5th percentile:          $${batch.percentile5.toFixed(3)}`);
  console.log(`  95th percentile:         $${batch.percentile95.toFixed(3)}`);
  console.log(`  Profitable markets:      ${(batch.winRate * 100).toFixed(1)}%`);
  console.log(`  Round-trips (total):     ${batch.totalRoundTrips}`);
  console.log(`  Stop-losses (total):     ${batch.totalStopLosses}`);
  console.log(`  Unresolved inventory:    $${batch.totalLeftoverEntryValueUsdc.toFixed(3)} at entry prices`);
  console.log(
    `\nNOTE: This is an OPTIMISTIC upper bound. Real fills are slower because queue position is not modeled.`
  );
  console.log(
    `      If the backtest shows a loss, the strategy is almost certainly unprofitable live.\n`
  );
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
