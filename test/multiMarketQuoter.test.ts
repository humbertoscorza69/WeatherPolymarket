import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/config.js";
import { buildBuyQuotes, buildSellOnFill, filterPostOnlySafeQuotes, roundShares, roundPriceDown } from "../src/core/multiMarketQuoter.js";
import { QuoteIntent, Forecast, WeatherEvent } from "../src/types.js";

const config: Config = {
  mode: "live",
  liveApiEnabled: false,
  dryRunLive: true,
  maxEvents: 1,
  maxOutcomesPerEvent: 10,
  minMarketVolumeUsdc: 0,
  weatherApi: "open-meteo",
  weatherUncertaintyC: 1.5,
  halfSpreadCents: 1,
  maxForecastDivergence: 0.15,
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

// Books with midpoints close to forecast probabilities (divergence < 0.15)
// Forecast probs at uncertainty=1.5: 18→0.12, 19→0.23, 20→0.29, 21→0.23, 22→0.12
const books = [
  { tokenId: "yes-18", bestBid: 0.10, bestAsk: 0.14 }, // mid=0.12, forecast≈0.12
  { tokenId: "yes-19", bestBid: 0.21, bestAsk: 0.25 }, // mid=0.23, forecast≈0.23
  { tokenId: "yes-20", bestBid: 0.27, bestAsk: 0.31 }, // mid=0.29, forecast≈0.29
  { tokenId: "yes-21", bestBid: 0.21, bestAsk: 0.25 }, // mid=0.23, forecast≈0.23
  { tokenId: "yes-22", bestBid: 0.10, bestAsk: 0.14 }  // mid=0.12, forecast≈0.12
];

test("buildBuyQuotes creates post-only BUY YES quotes priced at midpoint minus half-spread", () => {
  const { quotes } = buildBuyQuotes(event, forecast, config, books);

  assert.ok(quotes.length > 0);
  assert.ok(quotes.every((quote) => quote.side === "BUY"));
  assert.ok(quotes.every((quote) => quote.postOnly === true));
  assert.ok(quotes.every((quote) => quote.price >= 0.02 && quote.price <= 0.98));
  assert.ok(quotes.every((quote) => quote.shares >= config.clobMinShares));

  // Price should be roundDown(mid - 0.01)
  const quote20 = quotes.find((q) => q.outcomeLabel === "20C");
  assert.ok(quote20);
  assert.equal(quote20.price, 0.28); // mid=0.29, halfSpread=0.01 → 0.28
});

test("buildBuyQuotes caps total exposure", () => {
  const { quotes } = buildBuyQuotes(event, forecast, config, books, [], );
  // maxTotalExposureUsdc=10, orderSizeUsdc=2 → up to 5 quotes
  // All 5 outcomes pass checks, total = 5×2 = 10 ≤ 10
  assert.equal(quotes.length, 5);

  const { quotes: capped } = buildBuyQuotes(event, forecast, { ...config, maxTotalExposureUsdc: 4 }, books);
  assert.equal(capped.length, 2);
});

test("buildBuyQuotes skips outcomes with an existing position", () => {
  const { quotes } = buildBuyQuotes(event, forecast, config, books, [{ conditionId: "0x20", exposureUsdc: 1 }]);
  assert.equal(quotes.some((q) => q.conditionId === "0x20"), false, "should skip conditionId with open position");
  assert.equal(quotes.some((q) => q.conditionId === "0x19"), true, "should still quote others");
});

test("buildBuyQuotes rejects orders below CLOB minimum shares", () => {
  const { quotes } = buildBuyQuotes(event, forecast, { ...config, clobMinShares: 1000 }, books);
  assert.equal(quotes.length, 0);
});

test("buildBuyQuotes skips outcomes with no book data", () => {
  const { quotes, skipped } = buildBuyQuotes(event, forecast, config, []);
  assert.equal(quotes.length, 0);
  assert.equal(skipped.length, 5);
  assert.ok(skipped.every((s) => s.reason === "no_book_data"));
});

test("buildBuyQuotes skips outcomes where market diverges too far from forecast", () => {
  const divergedBooks = [
    { tokenId: "yes-20", bestBid: 0.55, bestAsk: 0.60 } // mid=0.575, forecast≈0.29 → divergence=0.285 > 0.15
  ];
  const { quotes, skipped } = buildBuyQuotes(event, forecast, config, divergedBooks);
  assert.equal(quotes.length, 0);
  assert.ok(skipped.some((s) => s.conditionId === "0x20" && s.reason.startsWith("divergence=")));
});

test("buildBuyQuotes skips outcomes where book spread is too tight", () => {
  const tightBooks = [
    { tokenId: "yes-20", bestBid: 0.289, bestAsk: 0.290 } // spread=0.001 < 0.002
  ];
  const { skipped } = buildBuyQuotes(event, forecast, config, tightBooks);
  assert.ok(skipped.some((s) => s.conditionId === "0x20" && s.reason.startsWith("spread_too_tight=")));
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

test("roundPriceDown floors to two decimals", () => {
  assert.equal(roundPriceDown(0.295), 0.29);
  assert.equal(roundPriceDown(0.291), 0.29);
  assert.equal(roundPriceDown(0.299), 0.29);
});

test("filterPostOnlySafeQuotes skips BUY quotes that cross best ask", () => {
  const quote: QuoteIntent = {
    eventId: "event-1", city: "Shanghai", date: "2026-04-21",
    conditionId: "0x20", tokenId: "yes-20", outcomeLabel: "20C",
    side: "BUY", price: 0.15, sizeUsdc: 2, shares: 10, postOnly: true, reason: "test"
  };

  const result = filterPostOnlySafeQuotes([quote], [{ tokenId: "yes-20", bestAsk: 0.1 }]);

  assert.equal(result.safeQuotes.length, 0);
  assert.equal(result.skippedQuotes[0]?.reason, "buy_crosses_best_ask=0.1");
});

test("filterPostOnlySafeQuotes keeps BUY quotes below best ask", () => {
  const quote: QuoteIntent = {
    eventId: "event-1", city: "Shanghai", date: "2026-04-21",
    conditionId: "0x20", tokenId: "yes-20", outcomeLabel: "20C",
    side: "BUY", price: 0.28, sizeUsdc: 2, shares: 7, postOnly: true, reason: "test"
  };

  const result = filterPostOnlySafeQuotes([quote], [{ tokenId: "yes-20", bestAsk: 0.99 }]);

  assert.equal(result.safeQuotes.length, 1);
  assert.equal(result.skippedQuotes.length, 0);
});
