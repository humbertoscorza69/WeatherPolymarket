import { Config } from "../config.js";
import { FillEvent, Forecast, QuoteIntent, WeatherEvent } from "../types.js";
import { forecastToProbabilities, roundPrice } from "./weatherFairValue.js";
import { skewedHalfSpreadCents } from "./inventorySkew.js";

export interface PositionSnapshot {
  conditionId: string;
  exposureUsdc: number;
  /** Optional share count so the dedupe check works even when entry price is unknown. */
  shares?: number;
}

export interface QuoteBookTop {
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
}

export interface PostOnlyFilterResult {
  safeQuotes: QuoteIntent[];
  skippedQuotes: Array<{ quote: QuoteIntent; reason: string }>;
}

export interface BuildBuyQuotesResult {
  quotes: QuoteIntent[];
  skipped: Array<{ conditionId: string; outcomeLabel: string; reason: string }>;
}

export function buildBuyQuotes(
  event: WeatherEvent,
  forecast: Forecast,
  config: Config,
  books: QuoteBookTop[],
  positions: PositionSnapshot[] = [],
  now: Date = new Date(),
  volExtraCents: (conditionId: string) => number = () => 0
): BuildBuyQuotesResult {
  // Build a richer description of each outcome's bucket for the CDF solver so
  // Fahrenheit / range / tail markets are handled correctly.
  const buckets = event.markets.map((market) => ({
    conditionId: market.conditionId,
    temperatureC: market.temperatureC,
    binWidthC: market.binWidthC ?? 1,
    isLowTail: market.isLowTail ?? false,
    isHighTail: market.isHighTail ?? false
  }));
  const probabilities = forecastToProbabilities(
    forecast.temperatureMaxC,
    config.weatherUncertaintyC,
    buckets,
    { hoursToResolution: hoursUntilResolution(event.date, now) }
  );
  const fairByConditionId = new Map(probabilities.map((point) => [point.conditionId, point.probability]));
  const bookByToken = new Map(books.map((book) => [book.tokenId, book]));
  // A position is "held" if either USDC exposure is > 0 OR we have ≥ 1 share
  // (share count is more reliable when entry price was unknown on startup).
  const heldConditions = new Set(
    positions.filter((p) => p.exposureUsdc > 0 || (p.shares ?? 0) > 0).map((p) => p.conditionId)
  );
  // Apply inventory skew: widen the spread as current exposure grows toward the cap.
  // Vol widening is applied per-outcome inside the loop (different per market).
  const currentExposureUsdc = positions.reduce((sum, p) => sum + (p.exposureUsdc ?? 0), 0);
  const inventorySkewedHalfCents = skewedHalfSpreadCents(
    {
      baseHalfSpreadCents: config.halfSpreadCents,
      inventorySkewCents: config.inventorySkewCents,
      maxExposureUsdc: config.maxTotalExposureUsdc
    },
    currentExposureUsdc
  );
  const quotes: QuoteIntent[] = [];
  const skipped: Array<{ conditionId: string; outcomeLabel: string; reason: string }> = [];
  let totalExposure = 0;

  for (const market of event.markets) {
    if (market.closed || market.resolved || !market.enableOrderBook) continue;
    if (market.volume24hr < config.minMarketVolumeUsdc) continue;

    const book = bookByToken.get(market.yesTokenId);
    if (!book || book.bestBid === undefined || book.bestAsk === undefined) {
      skipped.push({ conditionId: market.conditionId, outcomeLabel: market.outcomeLabel, reason: "no_book_data" });
      continue;
    }

    const spread = book.bestAsk - book.bestBid;
    // Minimum profitable spread. Our exit is entry + 1 tick, so the absolute
    // floor is 2 ticks (one for our BUY edge, one for our SELL edge). Using
    // 2 × market tick makes this threshold scale with the market's tick size
    // instead of a hardcoded 0.002 that was tuned for 0.01-tick markets.
    const tick = market.tickSize ?? config.tickSize;
    const minProfitableSpread = 2 * tick;
    if (spread < minProfitableSpread - 1e-9) {
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `spread_too_tight=${roundPrice(spread)} minRequired=${minProfitableSpread}`
      });
      continue;
    }

    if (heldConditions.has(market.conditionId)) {
      skipped.push({ conditionId: market.conditionId, outcomeLabel: market.outcomeLabel, reason: "has_position" });
      continue;
    }

    const mid = (book.bestBid + book.bestAsk) / 2;
    const forecastProb = fairByConditionId.get(market.conditionId);
    if (forecastProb === undefined) continue;

    const divergence = Math.abs(mid - forecastProb);
    if (divergence > config.maxForecastDivergence) {
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `divergence=${roundPrice(divergence)} market=${roundPrice(mid)} forecast=${roundPrice(forecastProb)}`
      });
      continue;
    }

    // Compute half-spread.
    //
    // If HALF_SPREAD_TICKS is set (>0), use it: halfSpread = N × market tick.
    // This is the right default — on a 0.001-tick market, halfSpreadCents=1
    // (1¢) means 10 ticks below mid, which is way too wide for the very narrow
    // tail-outcome books. Quoting in ticks adapts naturally.
    //
    // Inventory skew and vol widening still add cents on top.
    const baseHalfSpread = config.halfSpreadTicks > 0
      ? config.halfSpreadTicks * tick
      : config.halfSpreadCents / 100;
    const inventorySkew = (inventorySkewedHalfCents - config.halfSpreadCents) / 100; // contribution beyond base
    const volExtra = Math.max(0, volExtraCents(market.conditionId)) / 100;
    const halfSpread = baseHalfSpread + Math.max(0, inventorySkew) + volExtra;

    // Pricing: pure market making by default. We quote at `mid - halfSpread`
    // and let the spread + maker rebates be our edge.
    //
    // Optional: if ENABLE_FAIR_VALUE_CAP is on, we additionally cap the bid
    // at `fair - halfSpread`. This is a safety guard against adverse
    // selection (buying into an outcome that will converge below our entry),
    // NOT a forecast-driven prediction.
    const midBid = mid - halfSpread;
    const fairBid = forecastProb - halfSpread;
    const cap = config.enableFairValueCap;
    const rawBid = cap ? Math.min(midBid, fairBid) : midBid;
    const bid = roundPriceToTickDown(rawBid, tick);
    if (bid < tick || bid > 1 - tick) {
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `bid_out_of_bounds bid=${bid} fair=${roundPrice(forecastProb)} mid=${roundPrice(mid)}`
      });
      continue;
    }
    if (bid >= book.bestAsk) {
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `bid_crosses_ask bid=${bid} ask=${book.bestAsk}`
      });
      continue;
    }
    if (cap && bid > forecastProb) {
      // Would cross our own fair-value guard after rounding — skip
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `bid_above_fair bid=${bid} fair=${roundPrice(forecastProb)}`
      });
      continue;
    }

    // Outcome-level price filter. Skip outcomes whose mid is outside the
    // tradable band (default 0.05..0.95). Tail-extreme outcomes have either
    // 1-tick spreads (no profit) or share-count constraints we can't satisfy.
    if (mid < config.minOutcomeMid || mid > config.maxOutcomeMid) {
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `mid_out_of_band mid=${roundPrice(mid)} band=${config.minOutcomeMid}..${config.maxOutcomeMid}`
      });
      continue;
    }

    if (totalExposure + config.orderSizeUsdc > config.maxTotalExposureUsdc) break;

    // Adaptive order size: at high prices, $2 may not buy enough shares to
    // meet Polymarket's minimum (default 5). Scale the order up to satisfy
    // the minimum, capped by maxPositionPerMarketUsdc to stay within risk.
    const baseShares = roundShares(config.orderSizeUsdc / bid);
    let orderSizeUsdc = config.orderSizeUsdc;
    let shares = baseShares;
    if (shares < config.clobMinShares) {
      const requiredUsdc = config.clobMinShares * bid;
      if (requiredUsdc <= config.maxPositionPerMarketUsdc) {
        orderSizeUsdc = Math.ceil(requiredUsdc * 100) / 100; // round up to next cent
        shares = roundShares(orderSizeUsdc / bid);
      }
    }
    if (shares < config.clobMinShares) {
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `min_shares bid=${bid} shares=${shares} need=${config.clobMinShares} maxPosition=${config.maxPositionPerMarketUsdc}`
      });
      continue;
    }

    quotes.push({
      eventId: event.id,
      city: event.city,
      date: event.date,
      conditionId: market.conditionId,
      tokenId: market.yesTokenId,
      outcomeLabel: market.outcomeLabel,
      side: "BUY",
      price: bid,
      sizeUsdc: orderSizeUsdc,
      shares,
      postOnly: true,
      reason: `mid=${roundPrice(mid)} forecast=${roundPrice(forecastProb)} binding=${cap && fairBid < midBid ? "fair" : "mid"} divergence=${roundPrice(divergence)} halfSpread=${halfSpread} sized=${orderSizeUsdc}`
    });
    totalExposure += orderSizeUsdc;
  }

  return { quotes, skipped };
}

export function buildSellOnFill(fill: FillEvent, tickSize: number): QuoteIntent | null {
  if (fill.side !== "BUY") return null;
  const price = roundPriceToTick(fill.price + tickSize, tickSize);
  if (price > 0.98) return null;
  return {
    eventId: "fill",
    city: "unknown",
    date: "unknown",
    conditionId: fill.conditionId,
    tokenId: fill.tokenId,
    outcomeLabel: "filled-outcome",
    side: "SELL",
    price,
    sizeUsdc: roundPriceToTick(price * fill.shares, tickSize),
    shares: fill.shares,
    postOnly: true,
    reason: `sell_on_fill entry=${fill.price} tickSize=${tickSize} exit=${price}`
  };
}

/** Round a price to the nearest tick, always rounding towards a valid resting price. */
export function roundPriceToTick(price: number, tickSize: number): number {
  const factor = Math.round(1 / tickSize);
  return Math.round(price * factor) / factor;
}

export function roundShares(value: number): number {
  return Math.floor(value * 10000) / 10000;
}

export function roundPriceDown(value: number): number {
  return Math.floor(value * 100) / 100;
}

/** Round a price DOWN to the nearest tick (for BUY side — better price for maker).
 *  Adds a 1e-9 epsilon to absorb IEEE-754 error: without it, 0.17 - 0.01 floors
 *  to 0.15 on a 0.01 tick because 0.17 - 0.01 = 0.15999999999999998 in JS. */
export function roundPriceToTickDown(value: number, tickSize: number): number {
  const factor = Math.round(1 / tickSize);
  return Math.floor(value * factor + 1e-9) / factor;
}

/**
 * Hours until market resolution. For Polymarket weather markets, resolution is
 * end-of-day (23:59 UTC) of the event date. If the date has already passed,
 * returns 0 (do not grow sigma into the past).
 */
export function hoursUntilResolution(eventDateIso: string, now: Date): number {
  const resolution = new Date(`${eventDateIso}T23:59:59Z`).getTime();
  return Math.max(0, (resolution - now.getTime()) / 3_600_000);
}

export function filterPostOnlySafeQuotes(quotes: QuoteIntent[], books: QuoteBookTop[]): PostOnlyFilterResult {
  const bookByToken = new Map(books.map((book) => [book.tokenId, book]));
  const safeQuotes: QuoteIntent[] = [];
  const skippedQuotes: Array<{ quote: QuoteIntent; reason: string }> = [];

  for (const quote of quotes) {
    const book = bookByToken.get(quote.tokenId);
    if (quote.side === "BUY" && book?.bestAsk !== undefined && quote.price >= book.bestAsk) {
      skippedQuotes.push({ quote, reason: `buy_crosses_best_ask=${book.bestAsk}` });
      continue;
    }
    if (quote.side === "SELL" && book?.bestBid !== undefined && quote.price <= book.bestBid) {
      skippedQuotes.push({ quote, reason: `sell_crosses_best_bid=${book.bestBid}` });
      continue;
    }
    safeQuotes.push(quote);
  }

  return { safeQuotes, skippedQuotes };
}
