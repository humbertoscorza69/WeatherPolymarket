import assert from "node:assert/strict";
import test from "node:test";
import { VolatilityTracker } from "../src/core/volatilityTracker.js";

test("VolatilityTracker: zero extraCents when fewer than 3 samples", () => {
  const tracker = new VolatilityTracker({ windowSize: 30, volMultiplier: 1, maxExtraCents: 3 });
  tracker.update("0x1", 0.29);
  const snap = tracker.snapshot("0x1");
  assert.equal(snap.samples, 1);
  assert.equal(snap.extraCents, 0);
});

test("VolatilityTracker: stddev computed in cent-denominated returns", () => {
  const tracker = new VolatilityTracker({ windowSize: 60, volMultiplier: 1, maxExtraCents: 3 });
  // Seed with stable mid → zero stddev, zero extra
  [0.29, 0.29, 0.29, 0.29, 0.29].forEach((m) => tracker.update("0x1", m));
  const calm = tracker.snapshot("0x1");
  assert.ok(calm.stddevCents < 1e-9);
  assert.equal(calm.extraCents, 0);

  // Jump mid by 2¢ each tick → stddev ≈ 2 cents, extra = 1 × 2 = 2¢
  const tracker2 = new VolatilityTracker({ windowSize: 60, volMultiplier: 1, maxExtraCents: 3 });
  [0.29, 0.31, 0.29, 0.31, 0.29, 0.31].forEach((m) => tracker2.update("0x1", m));
  const vol = tracker2.snapshot("0x1");
  assert.ok(vol.stddevCents > 1.5, `stddev should be ~2¢, got ${vol.stddevCents}`);
  assert.ok(vol.extraCents > 1, `extraCents should scale with stddev, got ${vol.extraCents}`);
});

test("VolatilityTracker: extraCents respects maxExtraCents cap", () => {
  const tracker = new VolatilityTracker({ windowSize: 60, volMultiplier: 10, maxExtraCents: 3 });
  // Huge vol — 5¢ jumps
  [0.30, 0.35, 0.30, 0.35, 0.30, 0.35].forEach((m) => tracker.update("0x1", m));
  const snap = tracker.snapshot("0x1");
  assert.equal(snap.extraCents, 3, "extra should cap at maxExtraCents");
});

test("VolatilityTracker: ring buffer drops old samples", () => {
  const tracker = new VolatilityTracker({ windowSize: 3, volMultiplier: 1, maxExtraCents: 3 });
  for (let i = 0; i < 10; i++) tracker.update("0x1", 0.29);
  const snap = tracker.snapshot("0x1");
  assert.equal(snap.samples, 3);
});

test("VolatilityTracker: per-market independence", () => {
  const tracker = new VolatilityTracker({ windowSize: 60, volMultiplier: 1, maxExtraCents: 3 });
  // Market A: stable
  [0.29, 0.29, 0.29, 0.29].forEach((m) => tracker.update("A", m));
  // Market B: jumpy
  [0.29, 0.35, 0.29, 0.35].forEach((m) => tracker.update("B", m));
  const a = tracker.snapshot("A");
  const b = tracker.snapshot("B");
  assert.ok(b.stddevCents > a.stddevCents, "Market B should show more vol than Market A");
  assert.ok(b.extraCents > a.extraCents);
});

test("VolatilityTracker: effectiveHalfSpreadCents adds extra to base", () => {
  const tracker = new VolatilityTracker({ windowSize: 60, volMultiplier: 1, maxExtraCents: 3 });
  [0.29, 0.31, 0.29, 0.31, 0.29, 0.31].forEach((m) => tracker.update("0x1", m));
  const base = 1;
  const eff = tracker.effectiveHalfSpreadCents("0x1", base);
  assert.ok(eff > base);
  assert.ok(eff <= base + 3);
});
