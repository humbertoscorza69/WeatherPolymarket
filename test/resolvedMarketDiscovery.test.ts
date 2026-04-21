import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResolvedUrl,
  parseResolvedEvents,
  type ResolvedGammaEvent
} from "../src/adapters/resolvedMarketDiscovery.js";

test("buildResolvedUrl: includes both end_date_min AND end_date_max bounds", () => {
  const url = buildResolvedUrl(84, 30, 100);
  assert.ok(url.includes("tag_id=84"));
  assert.ok(url.includes("closed=true"));
  assert.ok(url.includes("limit=100"));
  assert.ok(url.includes("end_date_min="), "recent-enough bound");
  assert.ok(url.includes("end_date_max="), "actually-past-end bound prevents future-dated markets leaking in");
  assert.ok(url.includes("order=endDate"));
});

test("parseResolvedEvents: rejects markets whose endDate is in the future", () => {
  const futureISO = new Date(Date.now() + 90 * 86400_000).toISOString();
  const events: ResolvedGammaEvent[] = [{
    id: "e1", title: "Will Xabi Alonso be out as Real Madrid Manager in 2026?",
    endDate: futureISO,
    markets: [{
      conditionId: "0xfuture",
      endDate: futureISO,
      clobTokenIds: JSON.stringify(["a", "b"]),
      // Gamma DOES sometimes ship [1,0] on unresolved markets — that's why
      // we need the endDate<now gate in addition to the outcomePrices check.
      outcomePrices: JSON.stringify(["1", "0"]),
      enableOrderBook: true,
      closed: true,
      volumeClob: 5000
    }]
  }];
  const parsed = parseResolvedEvents(events, {
    gammaUrl: "x",
    minVolumeUsdc: 100,
    maxEvents: 100
  });
  assert.equal(parsed.length, 0, "future-dated market must be rejected even with clean outcomePrices");
});

test("parseResolvedEvents: emits YES+NO tokens for a resolved market", () => {
  const events: ResolvedGammaEvent[] = [{
    id: "e1", title: "Will it rain in NYC on Apr 15?", slug: "rain-nyc-apr15",
    endDate: "2026-04-15T20:00:00Z",
    tags: [{ slug: "weather", label: "Weather" }],
    markets: [{
      conditionId: "0xabc",
      question: "Will it rain in NYC on Apr 15?",
      endDate: "2026-04-15T20:00:00Z",
      clobTokenIds: JSON.stringify(["tok_yes", "tok_no"]),
      outcomePrices: JSON.stringify(["1", "0"]),
      enableOrderBook: true,
      closed: true,
      resolved: true,
      volumeClob: 5000
    }]
  }];

  const parsed = parseResolvedEvents(events, {
    gammaUrl: "x",
    minVolumeUsdc: 100,
    maxEvents: 100
  });
  assert.equal(parsed.length, 2, "should emit YES + NO virtual markets");
  const yes = parsed.find((p) => p.side === "YES")!;
  const no = parsed.find((p) => p.side === "NO")!;
  assert.equal(yes.tokenResolutionValue, 1, "YES paid out $1 (outcomePrices[0]=1)");
  assert.equal(no.tokenResolutionValue, 0, "NO paid out $0");
  assert.equal(yes.conditionId, "0xabc");
  assert.equal(yes.tokenId, "tok_yes");
  assert.equal(no.tokenId, "tok_no");
  assert.equal(yes.category, "weather");
});

test("parseResolvedEvents: drops markets with unresolved outcome prices", () => {
  const events: ResolvedGammaEvent[] = [{
    id: "e1", title: "Void market",
    endDate: "2026-04-15T20:00:00Z",
    markets: [{
      conditionId: "0xvoid",
      endDate: "2026-04-15T20:00:00Z",
      clobTokenIds: JSON.stringify(["tok_yes", "tok_no"]),
      outcomePrices: JSON.stringify(["0.5", "0.5"]), // void / refund
      enableOrderBook: true,
      closed: true,
      volumeClob: 5000
    }]
  }];
  const parsed = parseResolvedEvents(events, {
    gammaUrl: "x",
    minVolumeUsdc: 100,
    maxEvents: 100
  });
  assert.equal(parsed.length, 0);
});

test("parseResolvedEvents: respects minVolume and endDate window filters", () => {
  const events: ResolvedGammaEvent[] = [
    {
      id: "low-vol", title: "low",
      endDate: "2026-04-15T20:00:00Z",
      markets: [{
        conditionId: "0x1",
        endDate: "2026-04-15T20:00:00Z",
        clobTokenIds: JSON.stringify(["a", "b"]),
        outcomePrices: JSON.stringify(["1", "0"]),
        closed: true,
        volumeClob: 50 // below 1000 filter
      }]
    },
    {
      id: "high-vol", title: "high",
      endDate: "2026-04-15T20:00:00Z",
      markets: [{
        conditionId: "0x2",
        endDate: "2026-04-15T20:00:00Z",
        clobTokenIds: JSON.stringify(["c", "d"]),
        outcomePrices: JSON.stringify(["0", "1"]),
        closed: true,
        volumeClob: 5000
      }]
    }
  ];
  const parsed = parseResolvedEvents(events, {
    gammaUrl: "x",
    minVolumeUsdc: 1000,
    maxEvents: 100
  });
  assert.equal(parsed.length, 2, "only high-vol market should pass, producing 2 tokens");
  assert.ok(parsed.every((p) => p.conditionId === "0x2"));
});
