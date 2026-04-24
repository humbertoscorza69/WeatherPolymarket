import assert from "node:assert/strict";
import test from "node:test";
import {
  fahrenheitToCelsius,
  parseOutcomeBucket,
  parseWeatherEvents,
  parseWeatherTitle
} from "../src/adapters/weatherDiscovery.js";

test("parseOutcomeBucket: celsius point bin", () => {
  const b = parseOutcomeBucket("17°C")!;
  assert.equal(b.rawUnit, "C");
  assert.equal(b.temperatureC, 17);
  assert.equal(b.binWidthC, 1);
  assert.equal(b.isLowTail, false);
  assert.equal(b.isHighTail, false);
});

test("parseOutcomeBucket: fahrenheit range bin '32-33°F' uses midpoint converted to C", () => {
  const b = parseOutcomeBucket("32-33°F")!;
  assert.equal(b.rawUnit, "F");
  // midpoint 32.5°F → 0.278°C
  assert.ok(Math.abs(b.temperatureC - fahrenheitToCelsius(32.5)) < 1e-9);
  // 2°F wide → ~1.11°C in Celsius
  assert.ok(Math.abs(b.binWidthC - (2 * 5) / 9) < 1e-9);
});

test("parseOutcomeBucket: '31°F or below' is low tail", () => {
  const b = parseOutcomeBucket("31°F or below")!;
  assert.equal(b.isLowTail, true);
  assert.equal(b.isHighTail, false);
  assert.equal(b.rawUnit, "F");
  assert.ok(Math.abs(b.temperatureC - fahrenheitToCelsius(31)) < 1e-9);
});

test("parseOutcomeBucket: '50°F or higher' is high tail", () => {
  const b = parseOutcomeBucket("50°F or higher")!;
  assert.equal(b.isHighTail, true);
  assert.equal(b.isLowTail, false);
  assert.ok(Math.abs(b.temperatureC - fahrenheitToCelsius(50)) < 1e-9);
});

test("parseOutcomeBucket: '5°C or colder' and 'Above 30°C' handle alt phrasings", () => {
  assert.equal(parseOutcomeBucket("5°C or colder")?.isLowTail, true);
  assert.equal(parseOutcomeBucket("Above 30°C")?.isHighTail, true);
  assert.equal(parseOutcomeBucket("Below 10°C")?.isLowTail, true);
});

test("parseOutcomeBucket: defaults to Celsius when no unit marker is present", () => {
  const b = parseOutcomeBucket("17")!;
  assert.equal(b.rawUnit, "C");
  assert.equal(b.temperatureC, 17);
});


test("parseWeatherTitle extracts city and current-year date", () => {
  const parsed = parseWeatherTitle("Highest temperature in Shanghai on April 21?");
  assert.deepEqual(parsed, { city: "Shanghai", date: "2026-04-21" });
});

// Use a future date so the `meta.date <= today` filter in parseWeatherEvents
// doesn't exclude these tests after the clock rolls forward.
function futureDate(): { iso: string; title: string } {
  const d = new Date(Date.now() + 30 * 24 * 3600_000);
  const iso = d.toISOString().slice(0, 10);
  const monthName = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const day = d.getUTCDate();
  return { iso, title: `${monthName} ${day}` };
}

test("parseWeatherEvents parses binary outcome markets from Gamma shape", () => {
  const { iso, title } = futureDate();
  const events = parseWeatherEvents(
    [
      {
        id: "event-1",
        title: `Highest temperature in Shanghai on ${title}?`,
        eventDate: iso,
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
  const { iso, title } = futureDate();
  const events = parseWeatherEvents(
    [
      {
        id: "event-1",
        title: `Highest temperature in Seoul on ${title}?`,
        eventDate: iso,
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
