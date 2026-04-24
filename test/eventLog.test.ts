import assert from "node:assert/strict";
import test from "node:test";
import { EventLog } from "../src/core/eventLog.js";

test("EventLog tracks realized P&L, round-trip count, win rate", () => {
  const log = new EventLog({ bufferLimit: 10 });

  log.record({ type: "BUY_PLACED", price: 0.29, shares: 6 });
  log.record({ type: "BUY_FILLED", price: 0.29, shares: 6 });
  log.record({ type: "SELL_PLACED", price: 0.30, shares: 6 });
  log.record({ type: "ROUND_TRIP", price: 0.30, shares: 6, profitUsdc: 0.06 });

  log.record({ type: "BUY_PLACED", price: 0.35, shares: 5 });
  log.record({ type: "ROUND_TRIP", price: 0.34, shares: 5, profitUsdc: -0.05 });

  const m = log.metrics();
  assert.equal(m.roundTrips, 2);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.buysPlaced, 2);
  assert.equal(m.sellsPlaced, 1);
  assert.ok(Math.abs(m.realizedPnlUsdc - 0.01) < 1e-9);
});

test("EventLog ring buffer caps size", () => {
  const log = new EventLog({ bufferLimit: 3 });
  for (let i = 0; i < 10; i++) log.record({ type: "BUY_PLACED", price: i / 100 });
  const recent = log.recent(10);
  assert.equal(recent.length, 3);
  assert.equal(recent[0]?.price, 0.07);
  assert.equal(recent[2]?.price, 0.09);
});

test("EventLog counts TAKER_CRITICAL fills", () => {
  const log = new EventLog();
  log.record({ type: "TAKER_CRITICAL", side: "BUY", price: 0.3, shares: 6 });
  log.record({ type: "TAKER_CRITICAL", side: "SELL", price: 0.31, shares: 6 });
  assert.equal(log.metrics().takerFills, 2);
});
