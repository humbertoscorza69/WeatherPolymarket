import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STOP_LOSS_CONFIG, evaluateStopLoss, exitUrgency } from "../src/core/stopLoss.js";

const NOW = 1_700_000_000_000;

function baseInput(overrides: Partial<Parameters<typeof evaluateStopLoss>[0]> = {}) {
  return {
    conditionId: "0x1",
    outcomeLabel: "17C",
    avgEntryPrice: 0.3,
    shares: 10,
    currentMid: 0.3,
    entryTime: NOW - 60_000, // held 1 minute
    now: NOW,
    hoursToResolution: 6,
    ...overrides
  };
}

test("stop-loss: no triggers when price is stable", () => {
  const d = evaluateStopLoss(baseInput(), DEFAULT_STOP_LOSS_CONFIG);
  assert.equal(d.shouldStop, false);
});

test("stop-loss: catastrophic drop fires when mid < entry × 0.30", () => {
  const d = evaluateStopLoss(baseInput({ currentMid: 0.08 }), DEFAULT_STOP_LOSS_CONFIG);
  assert.equal(d.shouldStop, true);
  if (d.shouldStop) assert.equal(d.rule, "CATASTROPHIC_DROP");
});

test("stop-loss: deep drop requires mid ≤ 60% AND > 120 minutes held", () => {
  // 50% drop but only 30 min held → NO trigger
  const short = evaluateStopLoss(
    baseInput({ currentMid: 0.15, entryTime: NOW - 30 * 60_000 }),
    DEFAULT_STOP_LOSS_CONFIG
  );
  assert.equal(short.shouldStop, false);

  // 50% drop and 121 min held → trigger
  const stale = evaluateStopLoss(
    baseInput({ currentMid: 0.15, entryTime: NOW - 121 * 60_000 }),
    DEFAULT_STOP_LOSS_CONFIG
  );
  assert.equal(stale.shouldStop, true);
  if (stale.shouldStop) assert.equal(stale.rule, "DEEP_DROP_STALE");
});

test("stop-loss: near-resolution rule fires when < 1h and mid < 70%", () => {
  const d = evaluateStopLoss(
    baseInput({ hoursToResolution: 0.5, currentMid: 0.2 }),
    DEFAULT_STOP_LOSS_CONFIG
  );
  assert.equal(d.shouldStop, true);
  if (d.shouldStop) assert.equal(d.rule, "NEAR_RESOLUTION_ADVERSE");
});

test("stop-loss: max holding hits after 12h regardless of price", () => {
  const d = evaluateStopLoss(
    baseInput({ entryTime: NOW - 13 * 3600_000, currentMid: 0.32 }),
    DEFAULT_STOP_LOSS_CONFIG
  );
  assert.equal(d.shouldStop, true);
  if (d.shouldStop) assert.equal(d.rule, "MAX_HOLDING");
});

test("stop-loss: disabled config returns no action", () => {
  const d = evaluateStopLoss(baseInput({ currentMid: 0.01 }), {
    ...DEFAULT_STOP_LOSS_CONFIG,
    enabled: false
  });
  assert.equal(d.shouldStop, false);
});

test("stop-loss: unknown entry price (0) skips evaluation", () => {
  const d = evaluateStopLoss(
    baseInput({ avgEntryPrice: 0, currentMid: 0.05 }),
    DEFAULT_STOP_LOSS_CONFIG
  );
  assert.equal(d.shouldStop, false);
});

test("exit urgency: catastrophic and near-resolution are urgent; deep-stale and max-holding are patient", () => {
  assert.equal(exitUrgency("CATASTROPHIC_DROP"), "urgent");
  assert.equal(exitUrgency("NEAR_RESOLUTION_ADVERSE"), "urgent");
  assert.equal(exitUrgency("DEEP_DROP_STALE"), "patient");
  assert.equal(exitUrgency("MAX_HOLDING"), "patient");
});
