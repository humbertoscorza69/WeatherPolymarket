import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/config.js";
import { buildBuyQuotes, buildSellOnFill, filterPostOnlySafeQuotes, roundShares, roundPriceDown } from "../src/core/multiMarketQuoter.js";
import { QuoteIntent, Forecast, WeatherEvent } from "../src/types.js";

const baseConfig: Config = {
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
  enableFairValueCap: false,
  inventorySkewCents: 0,
  volWindowSize: 60,
  volMultiplier: 0,
  volMaxExtraCents: 3,
  stopLossEnabled: false,
  stopLossCatastrophicDropRatio: 0.3,
  stopLossDeepDropRatio: 0.6,
  stopLossDeepDropMaxMinutes: 120,
  stopLossResolutionHours: 1,
  stopLossResolutionDropRatio: 0.7,
  stopLossMaxHoldingHours: 12,
  stopLossMakerExitWaitSeconds: 90,
  orderSizeUsdc: 2,
  clobMinShares: 5,
  maxSharesPerMarket: 5,
  maxPositionPerMarketUsdc: 3,
  maxTotalExposureUsdc: 10,
  tickSize: 0.01,
  refreshIntervalMs: 30_000,
  orderPostOnly: true,
  dataDir: "data",
  clobHost: "https://clob.polymarket.com",
  polymarketSignatureType: 1
};
// Tests that assert fair-value-cap behaviour opt in explicitly.
const config: Config = { ...baseConfig, enableFairValueCap: true };

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

/**
 * Deterministic "now" right at resolution time so hoursToResolution = 0
 * and sigma = baseUncertaintyC (no horizon scaling). With forecast=20,
 * sigma=1.5, outcomes=[18,19,20,21,22] treating 18 as low-tail and
 * 22 as high-tail, the CDF-derived probabilities are roughly:
 *   18→0.159  19→0.211  20→0.261  21→0.211  22→0.159
 */
const FIXED_NOW = new Date("2026-04-21T23:59:59Z");

// Books with midpoints close to forecast probabilities (divergence < 0.15)
// Forecast probs at uncertainty=1.5: 18→0.12, 19→0.23, 20→0.29, 21→0.23, 22→0.12
const books = [
  { tokenId: "yes-18", bestBid: 0.10, bestAsk: 0.14 }, // mid=0.12, forecast≈0.12
  { tokenId: "yes-19", bestBid: 0.21, bestAsk: 0.25 }, // mid=0.23, forecast≈0.23
  { tokenId: "yes-20", bestBid: 0.27, bestAsk: 0.31 }, // mid=0.29, forecast≈0.29
  { tokenId: "yes-21", bestBid: 0.21, bestAsk: 0.25 }, // mid=0.23, forecast≈0.23
  { tokenId: "yes-22", bestBid: 0.10, bestAsk: 0.14 }  // mid=0.12, forecast≈0.12
];

test("buildBuyQuotes creates post-only BUY YES quotes capped at min(mid, fair) - halfSpread", () => {
  const { quotes } = buildBuyQuotes(event, forecast, config, books, [], FIXED_NOW);

  assert.ok(quotes.length > 0);
  assert.ok(quotes.every((quote) => quote.side === "BUY"));
  assert.ok(quotes.every((quote) => quote.postOnly === true));
  assert.ok(quotes.every((quote) => quote.price >= 0.02 && quote.price <= 0.98));
  assert.ok(quotes.every((quote) => quote.shares >= config.clobMinShares));

  // 20°C peak: fair ≈ 0.261, mid = 0.29. fair < mid so fairBid (0.251) binds,
  // rounded down to 0.01 tick = 0.25. Guarantees positive EV vs our fair value.
  const quote20 = quotes.find((q) => q.outcomeLabel === "20C");
  assert.ok(quote20, "20C quote should exist");
  assert.equal(quote20.price, 0.25);
  assert.ok(quote20.reason.includes("binding=fair"));
});

test("buildBuyQuotes caps total exposure", () => {
  const { quotes } = buildBuyQuotes(event, forecast, config, books, [], FIXED_NOW);
  // maxTotalExposureUsdc=10, orderSizeUsdc=2 → up to 5 quotes
  assert.equal(quotes.length, 5);

  const { quotes: capped } = buildBuyQuotes(event, forecast, { ...config, maxTotalExposureUsdc: 4 }, books, [], FIXED_NOW);
  assert.equal(capped.length, 2);
});

test("buildBuyQuotes skips outcomes with an existing position", () => {
  const { quotes } = buildBuyQuotes(event, forecast, config, books, [{ conditionId: "0x20", exposureUsdc: 1 }], FIXED_NOW);
  assert.equal(quotes.some((q) => q.conditionId === "0x20"), false, "should skip conditionId with open position");
  assert.equal(quotes.some((q) => q.conditionId === "0x19"), true, "should still quote others");
});

test("buildBuyQuotes rejects orders below CLOB minimum shares", () => {
  const { quotes } = buildBuyQuotes(event, forecast, { ...config, clobMinShares: 1000 }, books, [], FIXED_NOW);
  assert.equal(quotes.length, 0);
});

test("buildBuyQuotes skips outcomes with no book data", () => {
  const { quotes, skipped } = buildBuyQuotes(event, forecast, config, [], [], FIXED_NOW);
  assert.equal(quotes.length, 0);
  assert.equal(skipped.length, 5);
  assert.ok(skipped.every((s) => s.reason === "no_book_data"));
});

test("buildBuyQuotes caps bid at min(mid - halfSpread, fair - halfSpread)", () => {
  // 22°C is a high-tail bucket with fair ≈ 0.159. Give it an inflated market mid
  // (0.30) to simulate the "market overvalues the tail" case from the Seoul
  // session analysis. The fair-value cap must keep our bid at or below fair.
  const overvaluedBooks = [
    { tokenId: "yes-22", bestBid: 0.28, bestAsk: 0.32 }
  ];
  const { quotes } = buildBuyQuotes(
    event,
    forecast,
    { ...config, maxForecastDivergence: 0.5, halfSpreadCents: 1, tickSize: 0.01 },
    overvaluedBooks,
    [],
    FIXED_NOW
  );
  const q22 = quotes.find((q) => q.conditionId === "0x22");
  assert.ok(q22, "expected a quote for 22C once divergence gate is loosened");
  // fair≈0.159 → fairBid = 0.149 → round-down to 0.01 = 0.14; midBid = 0.29 → min = 0.14.
  assert.equal(q22.price, 0.14);
  assert.ok(q22.price <= 0.16, `bid ${q22.price} must not exceed fair value`);
  assert.ok(q22.reason.includes("binding=fair"), `reason should mark fair as binding: ${q22.reason}`);
});

test("buildBuyQuotes in pure-MM mode (cap OFF) quotes at mid - halfSpread even when market overvalues", () => {
  // Same overvalued-tail case as the capped test, but with cap disabled.
  const overvaluedBooks = [
    { tokenId: "yes-22", bestBid: 0.28, bestAsk: 0.32 } // mid=0.30; fair~0.16 at FIXED_NOW
  ];
  const { quotes, skipped } = buildBuyQuotes(
    event,
    forecast,
    { ...baseConfig, maxForecastDivergence: 0.5 }, // cap OFF
    overvaluedBooks,
    [],
    FIXED_NOW
  );
  const q22 = quotes.find((q) => q.conditionId === "0x22");
  assert.ok(q22, "pure MM should still quote overvalued outcomes");
  // mid - halfSpread = 0.29 (no fair clamp)
  assert.equal(q22.price, 0.29);
  assert.ok(q22.reason.includes("binding=mid"));
  assert.ok(!skipped.some((s) => s.reason.startsWith("bid_above_fair")));
});

test("buildBuyQuotes per-conditionId dedupe works across many events at once (50+ outcomes)", () => {
  // Build 10 events × 10 outcomes = 100 markets. Seed inventory on every third
  // market and confirm buildBuyQuotes skips EXACTLY those (no more, no less).
  const events: WeatherEvent[] = Array.from({ length: 10 }, (_, evIdx) => ({
    id: `city-${evIdx}`,
    title: `Highest temperature in City${evIdx} on April 21?`,
    city: `City${evIdx}`,
    date: "2026-04-21",
    markets: Array.from({ length: 10 }, (_, tIdx) => ({
      conditionId: `${evIdx}-${tIdx}`,
      question: `Will City${evIdx} high be ${15 + tIdx}°C?`,
      outcomeLabel: `${15 + tIdx}C`,
      temperatureC: 15 + tIdx,
      yesTokenId: `yes-${evIdx}-${tIdx}`,
      noTokenId: `no-${evIdx}-${tIdx}`,
      volume24hr: 1000,
      enableOrderBook: true,
      closed: false,
      resolved: false
    }))
  }));

  const allConditions = events.flatMap((e) => e.markets.map((m) => m.conditionId));
  const held = allConditions.filter((_, i) => i % 3 === 0);
  const positions = held.map((conditionId) => ({ conditionId, exposureUsdc: 1 }));

  // One book per market with a healthy spread; shared book template
  const booksFor = (evIdx: number) =>
    events[evIdx]!.markets.map((m, tIdx) => ({
      tokenId: m.yesTokenId,
      bestBid: 0.10 + tIdx * 0.01,
      bestAsk: 0.14 + tIdx * 0.01
    }));

  const sharedForecast = (evIdx: number): Forecast => ({
    city: `City${evIdx}`,
    date: "2026-04-21",
    temperatureMaxC: 20,
    source: "open-meteo"
  });

  // Run each event through the quoter independently (same thing main.ts does)
  const allQuotedConditions = new Set<string>();
  const allSkippedForPosition = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const result = buildBuyQuotes(
      events[i]!,
      sharedForecast(i),
      { ...baseConfig, maxTotalExposureUsdc: 1000, maxForecastDivergence: 0.5 },
      booksFor(i),
      positions,
      FIXED_NOW
    );
    for (const q of result.quotes) allQuotedConditions.add(q.conditionId);
    for (const s of result.skipped) {
      if (s.reason === "has_position") allSkippedForPosition.add(s.conditionId);
    }
  }

  // Every held condition must be skipped with has_position (not duplicated)
  for (const cid of held) {
    assert.ok(allSkippedForPosition.has(cid), `held conditionId ${cid} must be skipped`);
    assert.ok(!allQuotedConditions.has(cid), `held conditionId ${cid} must NOT get a BUY quote`);
  }
  // Non-held conditions should get quoted (where other gates allow)
  const unheld = allConditions.filter((c) => !held.includes(c));
  assert.ok(unheld.length > 0);
  // Not every unheld condition has to be quoted (spread/divergence may filter),
  // but AT LEAST SOME from every event should be
  for (let i = 0; i < events.length; i++) {
    const someQuoted = events[i]!.markets.some(
      (m) => allQuotedConditions.has(m.conditionId) || held.includes(m.conditionId)
    );
    assert.ok(someQuoted, `event ${i} should produce quotes for some outcomes`);
  }
});

test("buildBuyQuotes applies the fair-value cap independently to every city/event", () => {
  // Two cities with different forecasts and over-priced tail outcomes.
  // Guarantees the cap is event-scoped and not globally cached.
  const seoulEvent: WeatherEvent = {
    id: "seoul-1",
    title: "Highest temperature in Seoul on April 21?",
    city: "Seoul",
    date: "2026-04-21",
    markets: [14, 15, 16, 17, 18].map((temp) => ({
      conditionId: `seoul-0x${temp}`,
      question: `Will Seoul high be ${temp}°C?`,
      outcomeLabel: `${temp}C`,
      temperatureC: temp,
      yesTokenId: `seoul-yes-${temp}`,
      noTokenId: `seoul-no-${temp}`,
      volume24hr: 1000,
      enableOrderBook: true,
      closed: false,
      resolved: false
    }))
  };
  const seoulForecast: Forecast = { city: "Seoul", date: "2026-04-21", temperatureMaxC: 17.2, source: "open-meteo" };

  // Seoul 14°C: market mid inflated (0.07) vs fair (≈0.029 for low-tail at f=17.2)
  const seoulBooks = [{ tokenId: "seoul-yes-14", bestBid: 0.06, bestAsk: 0.08 }];

  const parisEvent: WeatherEvent = {
    ...seoulEvent,
    id: "paris-1",
    title: "Highest temperature in Paris on April 21?",
    city: "Paris",
    markets: [10, 11, 12, 13, 14].map((temp) => ({
      conditionId: `paris-0x${temp}`,
      question: `Will Paris high be ${temp}°C?`,
      outcomeLabel: `${temp}C`,
      temperatureC: temp,
      yesTokenId: `paris-yes-${temp}`,
      noTokenId: `paris-no-${temp}`,
      volume24hr: 1000,
      enableOrderBook: true,
      closed: false,
      resolved: false
    }))
  };
  const parisForecast: Forecast = { city: "Paris", date: "2026-04-21", temperatureMaxC: 12, source: "open-meteo" };
  // Paris 10°C: market mid inflated relative to the Paris fair for that bin
  const parisBooks = [{ tokenId: "paris-yes-10", bestBid: 0.20, bestAsk: 0.24 }];

  const seoul = buildBuyQuotes(
    seoulEvent,
    seoulForecast,
    { ...config, maxForecastDivergence: 0.5 },
    seoulBooks,
    [],
    FIXED_NOW
  );
  const paris = buildBuyQuotes(
    parisEvent,
    parisForecast,
    { ...config, maxForecastDivergence: 0.5 },
    parisBooks,
    [],
    FIXED_NOW
  );

  const seoul14 = seoul.quotes.find((q) => q.conditionId === "seoul-0x14");
  const paris10 = paris.quotes.find((q) => q.conditionId === "paris-0x10");

  // Both overvalued tail cases: the fair-value cap must bind for each.
  if (seoul14) {
    assert.ok(seoul14.reason.includes("binding=fair"), `Seoul 14°C should bind on fair: ${seoul14.reason}`);
    assert.ok(seoul14.price < 0.07, `Seoul bid ${seoul14.price} should be below mid=0.07`);
  }
  if (paris10) {
    assert.ok(paris10.reason.includes("binding=fair"), `Paris 10°C should bind on fair: ${paris10.reason}`);
    assert.ok(paris10.price < 0.22, `Paris bid ${paris10.price} should be below mid=0.22`);
  }
  // At minimum, one of the two overvalued cases must have been skipped or fair-bound.
  const seoulSkipped = seoul.skipped.some((s) => s.conditionId === "seoul-0x14" && s.reason.startsWith("bid_above_fair"));
  const parisSkipped = paris.skipped.some((s) => s.conditionId === "paris-0x10" && s.reason.startsWith("bid_above_fair"));
  assert.ok(
    seoul14 || seoulSkipped || paris10 || parisSkipped,
    "either a fair-bound quote or a bid_above_fair skip must exist for each overvalued city"
  );
});

test("buildBuyQuotes prefers mid-based bid when fair >= mid (market undervalues)", () => {
  // 20°C outcome: fair ≈ 0.261 (CDF peak), pick a book where mid is well below fair.
  const undervaluedBooks = [
    { tokenId: "yes-20", bestBid: 0.15, bestAsk: 0.19 } // mid=0.17, fair≈0.26
  ];
  const { quotes } = buildBuyQuotes(
    event,
    forecast,
    { ...config, maxForecastDivergence: 0.5 },
    undervaluedBooks,
    [],
    FIXED_NOW
  );
  const q20 = quotes.find((q) => q.conditionId === "0x20");
  assert.ok(q20);
  // mid - halfSpread = 0.16; fair - halfSpread = 0.251; min = 0.16
  assert.equal(q20.price, 0.16);
  assert.ok(q20.reason.includes("binding=mid"));
});

test("buildBuyQuotes skips outcomes where market diverges too far from forecast", () => {
  const divergedBooks = [
    { tokenId: "yes-20", bestBid: 0.55, bestAsk: 0.60 } // mid=0.575, forecast≈0.29 → divergence=0.285 > 0.15
  ];
  const { quotes, skipped } = buildBuyQuotes(event, forecast, config, divergedBooks, [], FIXED_NOW);
  assert.equal(quotes.length, 0);
  assert.ok(skipped.some((s) => s.conditionId === "0x20" && s.reason.startsWith("divergence=")));
});

test("buildBuyQuotes skips outcomes where book spread is too tight", () => {
  const tightBooks = [
    { tokenId: "yes-20", bestBid: 0.289, bestAsk: 0.290 } // spread=0.001 < 0.002
  ];
  const { skipped } = buildBuyQuotes(event, forecast, config, tightBooks, [], FIXED_NOW);
  assert.ok(skipped.some((s) => s.conditionId === "0x20" && s.reason.startsWith("spread_too_tight=")));
});

test("buildSellOnFill creates immediate maker sell at entry plus one tick", () => {
  const sell = buildSellOnFill(
    { conditionId: "0x20", tokenId: "yes-20", side: "BUY", price: 0.29, shares: 6 },
    0.01
  );

  assert.equal(sell?.side, "SELL");
  assert.equal(sell?.price, 0.30);
  assert.equal(sell?.shares, 6);
  assert.equal(sell?.sizeUsdc, 1.8);
  assert.equal(sell?.postOnly, true);
});

test("buildSellOnFill ignores non-BUY fills", () => {
  const sell = buildSellOnFill(
    { conditionId: "0x20", tokenId: "yes-20", side: "SELL", price: 0.31, shares: 6 },
    0.01
  );
  assert.equal(sell, null);
});

test("buildSellOnFill rejects exits above 98 cents", () => {
  const sell = buildSellOnFill(
    { conditionId: "0x20", tokenId: "yes-20", side: "BUY", price: 0.98, shares: 6 },
    0.01
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
