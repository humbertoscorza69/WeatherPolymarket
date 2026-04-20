import assert from "node:assert/strict";
import test from "node:test";
import { OrderType, OrderSide, type SignedOrder } from "@polymarket/clob-client";
import { buildRawOrderPayload } from "../src/execution/clobDriver.js";

const signedOrder: SignedOrder = {
  salt: "123",
  maker: "0xmaker",
  signer: "0xsigner",
  taker: "0x0000000000000000000000000000000000000000",
  tokenId: "token-1",
  makerAmount: "1000000",
  takerAmount: "500000",
  expiration: "0",
  nonce: "0",
  feeRateBps: "0",
  side: OrderSide.BUY,
  signatureType: 1,
  signature: "0xsig"
};

test("buildRawOrderPayload adds top-level postOnly true for GTC orders", () => {
  const payload = buildRawOrderPayload(signedOrder, "0xfunder", OrderType.GTC, true);

  assert.equal(payload.postOnly, true);
  assert.equal(payload.deferExec, false);
  assert.equal(payload.owner, "0xfunder");
  assert.equal(payload.orderType, "GTC");
  assert.equal(payload.order.tokenId, "token-1");
  assert.equal(payload.order.side, "BUY");
});

test("buildRawOrderPayload rejects postOnly FOK orders", () => {
  assert.throws(() => buildRawOrderPayload(signedOrder, "0xfunder", OrderType.FOK, true), /GTC or GTD/);
});
