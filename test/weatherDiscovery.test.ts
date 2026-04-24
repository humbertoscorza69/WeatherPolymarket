import assert from "node:assert/strict";
import test from "node:test";
import { parseWeatherEvents, parseWeatherTitle } from "../src/adapters/weatherDiscovery.js";

test("parseWeatherTitle extracts city and current-year date", () => {
  const parsed = parseWeatherTitle("Highest temperature in Shanghai on April 30?");
  assert.deepEqual(parsed, { city: "Shanghai", date: "2026-04-30" });
});

test("parseWeatherEvents parses binary outcome markets from Gamma shape", () => {
  const events = parseWeatherEvents(
    [
      {
        id: "event-1",
        title: "Highest temperature in Shanghai on April 21?",
        eventDate: "2026-04-30",
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

test("parseWeatherEvents excludes resolved and closed markets", () => {
  const events = parseWeatherEvents(
    [
      {
        id: "event-1",
        title: "Highest temperature in Seoul on April 21?",
        eventDate: "2026-04-30",
        markets: [
          {
            conditionId: "0xclosed",
            question: "Will the high be 16°C?",
            clobTokenIds: JSON.stringify(["yes", "no"]),
            volume24hr: "1000",
            enableOrderBook: true,
            closed: true
          },
          {
            conditionId: "0xopen",
            question: "Will the high be 17°C?",
            clobTokenIds: JSON.stringify(["yes2", "no2"]),
            volume24hr: "1000",
            enableOrderBook: true,
            closed: false,
            resolved: false
          }
        ]
      }
    ],
    { maxEvents: 5, maxOutcomesPerEvent: 10, minMarketVolumeUsdc: 0 }
  );

  assert.equal(events[0]?.markets.length, 1);
  assert.equal(events[0]?.markets[0]?.conditionId, "0xopen");
});

test("parseWeatherEvents excludes same-day events", () => {
  const today = new Date().toISOString().slice(0, 10);
  const events = parseWeatherEvents(
    [
      {
        id: "event-1",
        title: "Highest temperature in Seoul on April 21?",
        eventDate: today,
        markets: [
          {
            conditionId: "0xopen",
            question: "Will the high be 17°C?",
            clobTokenIds: JSON.stringify(["yes2", "no2"]),
            volume24hr: "1000",
            enableOrderBook: true
          }
        ]
      }
    ],
    { maxEvents: 5, maxOutcomesPerEvent: 10, minMarketVolumeUsdc: 0 }
  );

  assert.equal(events.length, 0);
});
