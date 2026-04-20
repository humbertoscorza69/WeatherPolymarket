import { Config } from "../config.js";
import { FillEvent, Forecast, QuoteIntent, WeatherEvent } from "../types.js";
import { forecastToProbabilities, roundPrice } from "./weatherFairValue.js";

export interface PositionSnapshot {
  conditionId: string;
  exposureUsdc: number;
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
  now: Date = new Date()
): BuildBuyQuotesResult {
  const probabilities = forecastToProbabilities(
    forecast.temperatureMaxC,
    config.weatherUncertaintyC,
    event.markets.map((market) => market.temperatureC),
    { hoursToResolution: hoursUntilResolution(event.date, now) }
  );
  const fairByTemp = new Map(probabilities.map((point) => [point.temperatureC, point.probability]));
  const bookByToken = new Map(books.map((book) => [book.tokenId, book]));
  const heldConditions = new Set(positions.filter((p) => p.exposureUsdc > 0).map((p) => p.conditionId));
  const halfSpread = config.halfSpreadCents / 100;
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
    if (spread < 0.002) {
      skipped.push({ conditionId: market.conditionId, outcomeLabel: market.outcomeLabel, reason: `spread_too_tight=${spread}` });
      continue;
    }

    if (heldConditions.has(market.conditionId)) {
      skipped.push({ conditionId: market.conditionId, outcomeLabel: market.outcomeLabel, reason: "has_position" });
      continue;
    }

    const mid = (book.bestBid + book.bestAsk) / 2;
    const forecastProb = fairByTemp.get(market.temperatureC);
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

    // Round to the market's actual tick, falling back to config default
    const tick = market.tickSize ?? config.tickSize;
    // Cap bid at min(mid - halfSpread, fairValue - halfSpread) so we never
    // quote above our own fair value. Buying above fair value is guaranteed
    // adverse selection — if the forecast is right, the market will converge
    // below our entry and our SELL at entry+tick never fills. The fair-value
    // cap turns pure spread-capture into spread-capture-with-edge-guard.
    const midBid = mid - halfSpread;
    const fairBid = forecastProb - halfSpread;
    const rawBid = Math.min(midBid, fairBid);
    const bid = roundPriceToTickDown(rawBid, tick);
    if (bid < tick || bid > 1 - tick) {
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `bid_out_of_bounds bid=${bid} fair=${roundPrice(forecastProb)} mid=${roundPrice(mid)}`
      });
      continue;
    }
    if (bid >= book.bestAsk) continue;
    if (bid > forecastProb) {
      // Would cross our own fair-value guard after rounding — skip
      skipped.push({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        reason: `bid_above_fair bid=${bid} fair=${roundPrice(forecastProb)}`
      });
      continue;
    }

    if (totalExposure + config.orderSizeUsdc > config.maxTotalExposureUsdc) break;

    const shares = roundShares(config.orderSizeUsdc / bid);
    if (shares < config.clobMinShares) continue;

    quotes.push({
      eventId: event.id,
      city: event.city,
      date: event.date,
      conditionId: market.conditionId,
      tokenId: market.yesTokenId,
      outcomeLabel: market.outcomeLabel,
      side: "BUY",
      price: bid,
      sizeUsdc: config.orderSizeUsdc,
      shares,
      postOnly: true,
      reason: `mid=${roundPrice(mid)} forecast=${roundPrice(forecastProb)} binding=${fairBid < midBid ? "fair" : "mid"} divergence=${roundPrice(divergence)} halfSpread=${halfSpread}`
    });
    totalExposure += config.orderSizeUsdc;
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
