import { Config } from "../config.js";
import { FillEvent, Forecast, QuoteIntent, WeatherEvent } from "../types.js";
import { forecastToProbabilities, roundPrice } from "./weatherFairValue.js";

export function buildBuyQuotes(event: WeatherEvent, forecast: Forecast, config: Config): QuoteIntent[] {
  const probabilities = forecastToProbabilities(
    forecast.temperatureMaxC,
    config.weatherUncertaintyC,
    event.markets.map((market) => market.temperatureC)
  );
  const fairByTemp = new Map(probabilities.map((point) => [point.temperatureC, point.probability]));
  const halfSpread = config.halfSpreadCents / 100;
  const quotes: QuoteIntent[] = [];

  for (const market of event.markets) {
    if (market.closed || market.resolved || !market.enableOrderBook) continue;
    if (market.volume24hr < config.minMarketVolumeUsdc) continue;

    const fair = fairByTemp.get(market.temperatureC);
    if (fair === undefined) continue;

    const bid = roundPrice(fair - halfSpread);
    if (bid < 0.02 || bid > 0.98) continue;

    quotes.push({
      eventId: event.id,
      city: event.city,
      date: event.date,
      conditionId: market.conditionId,
      tokenId: market.yesTokenId,
      outcomeLabel: market.outcomeLabel,
      side: "BUY",
      price: bid,
      size: config.orderSizeUsdc,
      postOnly: true,
      reason: `weather_fair=${roundPrice(fair)} forecast=${forecast.temperatureMaxC}C halfSpread=${halfSpread}`
    });
  }

  return capTotalExposure(quotes, config.maxTotalExposureUsdc);
}

export function buildSellOnFill(fill: FillEvent, spreadCents: number): QuoteIntent | null {
  if (fill.side !== "BUY") return null;
  const price = roundPrice(fill.price + spreadCents / 100);
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
    size: fill.shares,
    postOnly: true,
    reason: `sell_on_fill entry=${fill.price} spreadCents=${spreadCents}`
  };
}

function capTotalExposure(quotes: QuoteIntent[], maxTotalExposureUsdc: number): QuoteIntent[] {
  const selected: QuoteIntent[] = [];
  let exposure = 0;
  for (const quote of quotes) {
    if (exposure + quote.size > maxTotalExposureUsdc) break;
    selected.push(quote);
    exposure += quote.size;
  }
  return selected;
}
