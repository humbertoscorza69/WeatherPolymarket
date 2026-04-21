import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { LocalBook, MarketWebSocket } from "../src/execution/marketWebSocket.js";

test("LocalBook: snapshot populates bids/asks and best prices", () => {
  const book = new LocalBook();
  book.applySnapshot({
    bids: [
      { price: "0.29", size: "10" },
      { price: "0.28", size: "5" }
    ],
    asks: [
      { price: "0.31", size: "8" },
      { price: "0.32", size: "12" }
    ],
    tick_size: "0.01"
  });
  const snap = book.snapshot();
  assert.equal(snap.bestBid, 0.29);
  assert.equal(snap.bestAsk, 0.31);
  assert.equal(snap.tickSize, "0.01");
  assert.equal(snap.bidDepth, 15);
  assert.equal(snap.askDepth, 20);
  // Bids sorted descending, asks ascending
  assert.deepEqual(snap.bids?.map((l) => l.price), [0.29, 0.28]);
  assert.deepEqual(snap.asks?.map((l) => l.price), [0.31, 0.32]);
});

test("LocalBook: delta updates add, modify, and remove levels", () => {
  const book = new LocalBook();
  book.applySnapshot({
    bids: [{ price: "0.29", size: "10" }],
    asks: [{ price: "0.31", size: "8" }]
  });
  // Modify existing
  book.applyDelta([{ price: "0.29", size: "15", side: "BUY" }]);
  assert.equal(book.snapshot().bids?.[0]?.size, 15);
  // Add new level
  book.applyDelta([{ price: "0.30", size: "5", side: "BID" }]);
  assert.equal(book.snapshot().bestBid, 0.30);
  // Remove by zero size
  book.applyDelta([{ price: "0.30", size: "0", side: "BUY" }]);
  assert.equal(book.snapshot().bestBid, 0.29);
});

test("LocalBook: BID/BUY and ASK/SELL both recognized", () => {
  const book = new LocalBook();
  book.applyDelta([
    { price: "0.20", size: "10", side: "BUY" },
    { price: "0.30", size: "10", side: "bid" },
    { price: "0.40", size: "10", side: "ASK" },
    { price: "0.50", size: "10", side: "sell" }
  ]);
  const s = book.snapshot();
  assert.equal(s.bestBid, 0.30);
  assert.equal(s.bestAsk, 0.40);
});

test("MarketWebSocket.handleMessage: ignores non-JSON and unknown assets", () => {
  const events: string[] = [];
  class Fake extends EventEmitter {
    send() {}
    close() {}
  }
  const ws = new MarketWebSocket({
    assetIds: ["yes-1"],
    handlers: {
      onBook: (id) => events.push(`book ${id}`)
    },
    WebSocketCtor: Fake as unknown as typeof import("ws")["default"]
  });
  ws.handleMessage("PONG"); // ignored
  ws.handleMessage(JSON.stringify({ event_type: "book", asset_id: "not-subscribed", bids: [], asks: [] }));
  assert.equal(events.length, 0, "unknown asset should not call onBook");
});

test("MarketWebSocket.handleMessage: book event updates the local mirror and invokes handler", () => {
  const events: Array<{ id: string; bestBid?: number; bestAsk?: number }> = [];
  class Fake extends EventEmitter {
    send() {}
    close() {}
  }
  const ws = new MarketWebSocket({
    assetIds: ["yes-1"],
    handlers: {
      onBook: (id, book) => events.push({ id, bestBid: book.bestBid, bestAsk: book.bestAsk })
    },
    WebSocketCtor: Fake as unknown as typeof import("ws")["default"]
  });
  ws.handleMessage(
    JSON.stringify({
      event_type: "book",
      asset_id: "yes-1",
      bids: [{ price: "0.29", size: "10" }],
      asks: [{ price: "0.31", size: "5" }],
      tick_size: "0.01"
    })
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.bestBid, 0.29);
  assert.equal(events[0]!.bestAsk, 0.31);
  // Synchronous accessor works too
  assert.equal(ws.book("yes-1")?.bestBid, 0.29);
});

test("MarketWebSocket.handleMessage: price_change delta applies to existing book", () => {
  const events: number[] = [];
  class Fake extends EventEmitter {
    send() {}
    close() {}
  }
  const ws = new MarketWebSocket({
    assetIds: ["yes-1"],
    handlers: {
      onBook: (_, book) => events.push(book.bestBid ?? -1)
    },
    WebSocketCtor: Fake as unknown as typeof import("ws")["default"]
  });
  // Seed with a snapshot
  ws.handleMessage(
    JSON.stringify({
      event_type: "book",
      asset_id: "yes-1",
      bids: [{ price: "0.29", size: "10" }],
      asks: [{ price: "0.31", size: "5" }]
    })
  );
  // Delta lifts best bid to 0.30
  ws.handleMessage(
    JSON.stringify({
      event_type: "price_change",
      asset_id: "yes-1",
      price_changes: [{ price: "0.30", size: "20", side: "BUY" }]
    })
  );
  assert.equal(events.at(-1), 0.30);
});

test("MarketWebSocket.handleMessage: array payload dispatches each event", () => {
  let count = 0;
  class Fake extends EventEmitter {
    send() {}
    close() {}
  }
  const ws = new MarketWebSocket({
    assetIds: ["yes-1", "yes-2"],
    handlers: { onBook: () => (count += 1) },
    WebSocketCtor: Fake as unknown as typeof import("ws")["default"]
  });
  ws.handleMessage(
    JSON.stringify([
      { event_type: "book", asset_id: "yes-1", bids: [{ price: "0.29", size: "1" }], asks: [] },
      { event_type: "book", asset_id: "yes-2", bids: [], asks: [{ price: "0.80", size: "1" }] }
    ])
  );
  assert.equal(count, 2);
});
