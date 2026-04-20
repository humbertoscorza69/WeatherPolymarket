import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFillMessage, normalizeOrderUpdate } from "../src/execution/userWebSocket.js";

test("normalizeFillMessage parses TRADE events", () => {
  const fill = normalizeFillMessage({
    event_type: "TRADE",
    asset_id: "asset-1",
    side: "BUY",
    price: "0.29",
    size: "6.5",
    trader_side: "MAKER"
  });

  assert.deepEqual(fill, {
    assetId: "asset-1",
    side: "BUY",
    price: 0.29,
    shares: 6.5,
    traderSide: "MAKER",
    orderId: undefined
  });
});

test("normalizeFillMessage ignores non-fill events", () => {
  assert.equal(normalizeFillMessage({ event_type: "ORDER_UPDATE" }), null);
});

test("normalizeOrderUpdate parses zero-match cancellations", () => {
  const update = normalizeOrderUpdate({
    event_type: "ORDER_UPDATE",
    asset_id: "asset-1",
    side: "SELL",
    status: "CANCELLED",
    size_matched: "0"
  });

  assert.equal(update?.assetId, "asset-1");
  assert.equal(update?.side, "SELL");
  assert.equal(update?.status, "CANCELLED");
  assert.equal(update?.sizeMatched, 0);
});
