import assert from "node:assert/strict";
import test from "node:test";
import { parseGenericEvents, GAMMA_PRESETS } from "../src/adapters/genericDiscovery.js";

const futureDate = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

test("GAMMA_PRESETS exposes the common Polymarket categories", () => {
  assert.ok("weather" in GAMMA_PRESETS);
  assert.ok("politics" in GAMMA_PRESETS);
  assert.ok("sports" in GAMMA_PRESETS);
  assert.ok("entertainment" in GAMMA_PRESETS);
  assert.ok(GAMMA_PRESETS.politics.includes("tag_id="));
});

test("parseGenericEvents returns WeatherEvent-shaped stubs for arbitrary events", () => {
  const raw = [
    {
      id: "ev-1",
      title: "Will Trump win Iowa caucus?",
      eventDate: futureDate,
      markets: [
        {
          conditionId: "0xabc",
          question: "Trump wins Iowa",
          clobTokenIds: JSON.stringify(["yes-1", "no-1"]),
          volume24hr: "5000",
          enableOrderBook: true,
          closed: false,
          resolved: false
        }
      ]
    }
  ];
  const events = parseGenericEvents(raw, {
    gammaUrl: "x",
    maxEvents: 5,
    maxOutcomesPerEvent: 10,
    minMarketVolumeUsdc: 0
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.title, "Will Trump win Iowa caucus?");
  assert.equal(events[0]!.markets.length, 1);
  assert.equal(events[0]!.markets[0]!.conditionId, "0xabc");
  assert.equal(events[0]!.markets[0]!.yesTokenId, "yes-1");
  // Dummy temp fields for downstream type compatibility
  assert.equal(typeof events[0]!.markets[0]!.temperatureC, "number");
});

test("parseGenericEvents skips resolved / closed / no-book markets", () => {
  const events = parseGenericEvents(
    [
      {
        id: "ev",
        title: "Some event",
        eventDate: futureDate,
        markets: [
          { conditionId: "0x1", clobTokenIds: JSON.stringify(["a", "b"]), closed: true, enableOrderBook: true },
          { conditionId: "0x2", clobTokenIds: JSON.stringify(["c", "d"]), resolved: true, enableOrderBook: true },
          { conditionId: "0x3", clobTokenIds: JSON.stringify(["e", "f"]), enableOrderBook: false },
          { conditionId: "0x4", clobTokenIds: JSON.stringify(["g", "h"]), enableOrderBook: true, closed: false, resolved: false }
        ]
      }
    ],
    { gammaUrl: "x", maxEvents: 1, maxOutcomesPerEvent: 10, minMarketVolumeUsdc: 0 }
  );
  assert.equal(events[0]!.markets.length, 1);
  assert.equal(events[0]!.markets[0]!.conditionId, "0x4");
});

test("parseGenericEvents excludes events whose date is today or past", () => {
  const today = new Date().toISOString().slice(0, 10);
  const events = parseGenericEvents(
    [
      {
        id: "past",
        title: "Past event",
        eventDate: today,
        markets: [{ conditionId: "0x1", clobTokenIds: JSON.stringify(["a", "b"]), enableOrderBook: true }]
      }
    ],
    { gammaUrl: "x", maxEvents: 1, maxOutcomesPerEvent: 10, minMarketVolumeUsdc: 0 }
  );
  assert.equal(events.length, 0);
});

test("parseGenericEvents respects maxEvents / maxOutcomesPerEvent limits", () => {
  const manyEvents = Array.from({ length: 5 }, (_, i) => ({
    id: `e${i}`,
    title: `event ${i}`,
    eventDate: futureDate,
    markets: Array.from({ length: 20 }, (_, j) => ({
      conditionId: `0x${i}${j}`,
      clobTokenIds: JSON.stringify([`y${i}${j}`, `n${i}${j}`]),
      enableOrderBook: true,
      closed: false,
      resolved: false
    }))
  }));
  const events = parseGenericEvents(manyEvents, {
    gammaUrl: "x",
    maxEvents: 2,
    maxOutcomesPerEvent: 3,
    minMarketVolumeUsdc: 0
  });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.markets.length, 3);
});
