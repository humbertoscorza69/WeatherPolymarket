import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/config.js";
import { buildBuyQuotes, buildSellOnFill } from "../src/core/multiMarketQuoter.js";
import { Forecast, WeatherEvent } from "../src/types.js";

const config: Config = {
  mode: "live",
  liveApiEnabled: false,
  dryRunLive: true,
  maxEvents: 1,
  maxOutcomesPerEvent: 10,
  minMarketVolumeUsdc: 0,
  weatherApi: "open-meteo",
  weatherUncertaintyC: 1.5,
  halfSpreadCents: 2,
  orderSizeUsdc: 2,
  maxSharesPerMarket: 5,
  maxTotalExposureUsdc: 10,
  refreshIntervalMs: 30_000,
  orderPostOnly: true,
  dataDir: "data"
};

const event: WeatherEvent = {
  id: "event-1",
  title: "Highest temperature in Shanghai on April 21?",
  city: "Shanghai",
  date: "2026-04-21",
  markets: [18, 19, 20, 21, 22].map((temp) => ({
    conditionId: `0x${temp}`,
    question: `Will the high be ${temp}°C?`,
    outcomeLabel: `${temp}C`,
    temperatureC: temp,
    yesTokenId: `yes-${temp}`,
    noTokenId: `no-${temp}`,
    volume24hr: 1000,
    enableOrderBook: true,
    closed: false,
    resolved: false
  }))
};

const forecast: Forecast = {
  city: "Shanghai",
  date: "2026-04-21",
  temperatureMaxC: 20,
  source: "open-meteo"
};

test("buildBuyQuotes creates post-only BUY YES quotes for eligible outcomes", () => {
  const quotes = buildBuyQuotes(event, forecast, config);

  assert.ok(quotes.length > 0);
  assert.ok(quotes.every((quote) => quote.side === "BUY"));
  assert.ok(quotes.every((quote) => quote.postOnly === true));
  assert.ok(quotes.every((quote) => quote.price >= 0.02 && quote.price <= 0.98));
});

test("buildBuyQuotes caps total exposure", () => {
  const quotes = buildBuyQuotes(event, forecast, { ...config, maxTotalExposureUsdc: 4 });
  assert.equal(quotes.length, 2);
});

test("buildSellOnFill creates immediate maker sell at entry plus spread", () => {
  const sell = buildSellOnFill(
    { conditionId: "0x20", tokenId: "yes-20", side: "BUY", price: 0.31, shares: 6 },
    2
  );

  assert.equal(sell?.side, "SELL");
  assert.equal(sell?.price, 0.33);
  assert.equal(sell?.size, 6);
  assert.equal(sell?.postOnly, true);
});
