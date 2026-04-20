import assert from "node:assert/strict";
import test from "node:test";
import { parseWeatherEvents, parseWeatherTitle } from "../src/adapters/weatherDiscovery.js";

test("parseWeatherTitle extracts city and current-year date", () => {
  const parsed = parseWeatherTitle("Highest temperature in Shanghai on April 21?");
  assert.deepEqual(parsed, { city: "Shanghai", date: "2026-04-21" });
});

test("parseWeatherEvents parses binary outcome markets from Gamma shape", () => {
  const events = parseWeatherEvents(
    [
      {
        id: "event-1",
        title: "Highest temperature in Shanghai on April 21?",
        markets: [
          {
            conditionId: "0xabc",
            question: "Will the high be 20°C?",
            clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
            outcomePrices: JSON.stringify(["0.40", "0.60"]),
            volume24hr: "1200",
            enableOrderBook: true,
            closed: false,
            resolved: false
          }
        ]
      }
    ],
    { maxEvents: 5, maxOutcomesPerEvent: 10, minMarketVolumeUsdc: 500 }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.city, "Shanghai");
  assert.equal(events[0]?.markets.length, 1);
  assert.equal(events[0]?.markets[0]?.temperatureC, 20);
  assert.equal(events[0]?.markets[0]?.yesTokenId, "yes-token");
});
