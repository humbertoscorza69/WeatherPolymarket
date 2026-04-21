import assert from "node:assert/strict";
import test from "node:test";
import { depthAhead, fetchOrderBookTop, type BookTop } from "../src/execution/orderBookClient.js";

function mockResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("fetchOrderBookTop returns sorted depth arrays and totals", async () => {
  const mockFetch: typeof fetch = async () =>
    mockResponse({
      asset_id: "0xT",
      bids: [
        { price: "0.28", size: "10" },
        { price: "0.29", size: "15" },
        { price: "0.27", size: "5" }
      ],
      asks: [
        { price: "0.32", size: "8" },
        { price: "0.31", size: "12" }
      ],
      tick_size: "0.01",
      neg_risk: false
    });

  const book = await fetchOrderBookTop("0xT", "https://host", mockFetch);
  assert.equal(book.bestBid, 0.29); // max of bids
  assert.equal(book.bestAsk, 0.31); // min of asks
  // Bids sorted high→low
  assert.deepEqual(
    book.bids?.map((b) => b.price),
    [0.29, 0.28, 0.27]
  );
  // Asks sorted low→high
  assert.deepEqual(
    book.asks?.map((a) => a.price),
    [0.31, 0.32]
  );
  assert.equal(book.bidDepth, 30);
  assert.equal(book.askDepth, 20);
});

test("fetchOrderBookTop filters zero-size and invalid levels", async () => {
  const mockFetch: typeof fetch = async () =>
    mockResponse({
      asset_id: "0xT",
      bids: [
        { price: "0.29", size: "10" },
        { price: "0.28", size: "0" }, // zero size — dropped
        { price: "bad", size: "5" } // non-numeric — dropped
      ],
      asks: [{ price: "0.31", size: "8" }]
    });
  const book = await fetchOrderBookTop("0xT", "https://host", mockFetch);
  assert.equal(book.bids?.length, 1);
  assert.equal(book.bidDepth, 10);
});

test("depthAhead: queue ahead of a BUY at a given price", () => {
  const book: BookTop = {
    bestBid: 0.29,
    bestAsk: 0.31,
    bids: [
      { price: 0.29, size: 15 },
      { price: 0.28, size: 10 },
      { price: 0.27, size: 5 }
    ],
    asks: []
  };
  // A BUY at 0.28 sits behind everything at 0.28 or better (0.29 + 0.28 = 25)
  assert.equal(depthAhead(book, "BUY", 0.28), 25);
  // A BUY at 0.29 sits behind the existing 0.29 resting (15)
  assert.equal(depthAhead(book, "BUY", 0.29), 15);
  // A BUY at 0.30 (above bestBid) would be best bid — no queue ahead
  assert.equal(depthAhead(book, "BUY", 0.30), 0);
});

test("depthAhead: queue ahead of a SELL at a given price", () => {
  const book: BookTop = {
    bestBid: 0.29,
    bestAsk: 0.31,
    bids: [],
    asks: [
      { price: 0.31, size: 8 },
      { price: 0.32, size: 12 },
      { price: 0.33, size: 20 }
    ]
  };
  // A SELL at 0.32 sits behind everything at 0.32 or better (0.31 + 0.32 = 20)
  assert.equal(depthAhead(book, "SELL", 0.32), 20);
  // A SELL at 0.31 sits behind the 0.31 resting (8)
  assert.equal(depthAhead(book, "SELL", 0.31), 8);
  // A SELL at 0.30 would be new best ask — no queue ahead
  assert.equal(depthAhead(book, "SELL", 0.30), 0);
});
