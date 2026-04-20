import { Config } from "../config.js";
import { FillEvent, Forecast, QuoteIntent, WeatherEvent } from "../types.js";
import { forecastToProbabilities, roundPrice } from "./weatherFairValue.js";

export interface PositionSnapshot {
  conditionId: string;
  exposureUsdc: number;
}

export function buildBuyQuotes(
  event: WeatherEvent,
  forecast: Forecast,
  config: Config,
  positions: PositionSnapshot[] = []
): QuoteIntent[] {
  const probabilities = forecastToProbabilities(
    forecast.temperatureMaxC,
    config.weatherUncertaintyC,
    event.markets.map((market) => market.temperatureC)
  );
  const fairByTemp = new Map(probabilities.map((point) => [point.temperatureC, point.probability]));
  const exposureByCondition = new Map(positions.map((position) => [position.conditionId, position.exposureUsdc]));
  const halfSpread = config.halfSpreadCents / 100;
  const quotes: QuoteIntent[] = [];

  for (const market of event.markets) {
    if (market.closed || market.resolved || !market.enableOrderBook) continue;
    if (market.volume24hr < config.minMarketVolumeUsdc) continue;

    const fair = fairByTemp.get(market.temperatureC);
    if (fair === undefined) continue;

    const bid = roundPrice(fair - halfSpread);
    if (bid < 0.02 || bid > 0.98) continue;
    const currentExposure = exposureByCondition.get(market.conditionId) ?? 0;
    if (currentExposure + config.orderSizeUsdc > config.maxPositionPerMarketUsdc) continue;

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
      reason: `weather_fair=${roundPrice(fair)} forecast=${forecast.temperatureMaxC}C halfSpread=${halfSpread} shares=${shares}`
    });
  }

  return capTotalExposure(quotes, config.maxTotalExposureUsdc);
}

export function buildSellOnFill(fill: FillEvent, halfSpreadCents: number): QuoteIntent | null {
  if (fill.side !== "BUY") return null;
  const fullSpread = (halfSpreadCents * 2) / 100;
  const price = roundPrice(fill.price + fullSpread);
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
    sizeUsdc: roundPrice(price * fill.shares),
    shares: fill.shares,
    postOnly: true,
    reason: `sell_on_fill entry=${fill.price} halfSpreadCents=${halfSpreadCents} fullSpread=${fullSpread}`
  };
}

function capTotalExposure(quotes: QuoteIntent[], maxTotalExposureUsdc: number): QuoteIntent[] {
  const selected: QuoteIntent[] = [];
  let exposure = 0;
  for (const quote of quotes) {
    if (exposure + quote.sizeUsdc > maxTotalExposureUsdc) break;
    selected.push(quote);
    exposure += quote.sizeUsdc;
  }
  return selected;
}

export function roundShares(value: number): number {
  return Math.floor(value * 10000) / 10000;
}
