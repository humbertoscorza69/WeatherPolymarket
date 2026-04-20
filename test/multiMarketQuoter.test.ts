import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/config.js";
import { buildBuyQuotes, buildSellOnFill, filterPostOnlySafeQuotes, roundShares } from "../src/core/multiMarketQuoter.js";
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
  clobMinShares: 5,
  maxSharesPerMarket: 5,
  maxPositionPerMarketUsdc: 3,
  maxTotalExposureUsdc: 10,
  refreshIntervalMs: 30_000,
  orderPostOnly: true,
  dataDir: "data",
  clobHost: "https://clob.polymarket.com",
  polymarketSignatureType: 1
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
  assert.ok(quotes.every((quote) => quote.shares >= config.clobMinShares));
});

test("buildBuyQuotes caps total exposure", () => {
  const quotes = buildBuyQuotes(event, forecast, { ...config, maxTotalExposureUsdc: 4 });
  assert.equal(quotes.length, 2);
});

test("buildBuyQuotes enforces per-condition exposure caps", () => {
  const quotes = buildBuyQuotes(event, forecast, config, [{ conditionId: "0x20", exposureUsdc: 2 }]);
  assert.equal(quotes.some((quote) => quote.conditionId === "0x20"), false);
  assert.equal(quotes.some((quote) => quote.conditionId === "0x19"), true);
});

test("buildBuyQuotes rejects orders below CLOB minimum shares", () => {
  const quotes = buildBuyQuotes(event, forecast, { ...config, clobMinShares: 1000 });
  assert.equal(quotes.length, 0);
});

test("buildBuyQuotes allows simultaneous positions across different outcomes", () => {
  const quotes = buildBuyQuotes(event, forecast, config, [{ conditionId: "0x20", exposureUsdc: 1 }]);
  assert.equal(quotes.some((quote) => quote.conditionId === "0x20"), true);
  assert.equal(quotes.some((quote) => quote.conditionId === "0x19"), true);
});

test("buildSellOnFill creates immediate maker sell at entry plus full spread", () => {
  const sell = buildSellOnFill(
    { conditionId: "0x20", tokenId: "yes-20", side: "BUY", price: 0.29, shares: 6 },
    2
  );

  assert.equal(sell?.side, "SELL");
  assert.equal(sell?.price, 0.33);
  assert.equal(sell?.shares, 6);
  assert.equal(sell?.sizeUsdc, 1.98);
  assert.equal(sell?.postOnly, true);
});

test("buildSellOnFill ignores non-BUY fills", () => {
  const sell = buildSellOnFill(
    { conditionId: "0x20", tokenId: "yes-20", side: "SELL", price: 0.31, shares: 6 },
    2
  );
  assert.equal(sell, null);
});

test("buildSellOnFill rejects exits above 98 cents", () => {
  const sell = buildSellOnFill(
    { conditionId: "0x20", tokenId: "yes-20", side: "BUY", price: 0.98, shares: 6 },
    2
  );
  assert.equal(sell, null);
});

test("roundShares floors to four decimals", () => {
  assert.equal(roundShares(6.666666), 6.6666);
});

test("filterPostOnlySafeQuotes skips BUY quotes that cross best ask", () => {
  const quote = buildBuyQuotes(event, forecast, config).find((item) => item.outcomeLabel === "20C");
  assert.ok(quote);

  const result = filterPostOnlySafeQuotes([quote], [{ tokenId: quote.tokenId, bestAsk: 0.1 }]);

  assert.equal(result.safeQuotes.length, 0);
  assert.equal(result.skippedQuotes[0]?.reason, "buy_crosses_best_ask=0.1");
});

test("filterPostOnlySafeQuotes keeps BUY quotes below best ask", () => {
  const quote = buildBuyQuotes(event, forecast, config).find((item) => item.outcomeLabel === "20C");
  assert.ok(quote);

  const result = filterPostOnlySafeQuotes([quote], [{ tokenId: quote.tokenId, bestAsk: 0.99 }]);

  assert.equal(result.safeQuotes.length, 1);
  assert.equal(result.skippedQuotes.length, 0);
});
