import assert from "node:assert/strict";
import test from "node:test";
import { InventoryEngine } from "../src/core/inventoryEngine.js";

test("InventoryEngine tracks average entry per conditionId", () => {
  const inventory = new InventoryEngine();
  inventory.applyFill({ conditionId: "0x17", tokenId: "yes-17", side: "BUY", price: 0.2, shares: 5 });
  const position = inventory.applyFill({ conditionId: "0x17", tokenId: "yes-17", side: "BUY", price: 0.4, shares: 5 });

  assert.equal(position.shares, 10);
  assert.equal(position.avgEntryPrice, 0.3);
});

test("InventoryEngine separates outcomes by conditionId", () => {
  const inventory = new InventoryEngine();
  inventory.applyFill({ conditionId: "0x17", tokenId: "yes-17", side: "BUY", price: 0.2, shares: 5 });
  inventory.applyFill({ conditionId: "0x18", tokenId: "yes-18", side: "BUY", price: 0.5, shares: 3 });

  assert.equal(inventory.getPosition("0x17").shares, 5);
  assert.equal(inventory.getPosition("0x18").shares, 3);
});

test("InventoryEngine realizes PnL on sells", () => {
  const inventory = new InventoryEngine();
  inventory.applyFill({ conditionId: "0x17", tokenId: "yes-17", side: "BUY", price: 0.2, shares: 5 });
  const position = inventory.applyFill({ conditionId: "0x17", tokenId: "yes-17", side: "SELL", price: 0.3, shares: 2 });

  assert.equal(position.shares, 3);
  assert.ok(Math.abs(position.realizedPnl - 0.2) < 1e-12);
});
