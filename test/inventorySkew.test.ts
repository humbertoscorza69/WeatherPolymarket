import assert from "node:assert/strict";
import test from "node:test";
import { skewedHalfSpreadCents } from "../src/core/inventorySkew.js";

test("inventory skew: no widening at 0 utilization", () => {
  const spread = skewedHalfSpreadCents(
    { baseHalfSpreadCents: 1, inventorySkewCents: 2, maxExposureUsdc: 10 },
    0
  );
  assert.equal(spread, 1);
});

test("inventory skew: full widening at max utilization", () => {
  const spread = skewedHalfSpreadCents(
    { baseHalfSpreadCents: 1, inventorySkewCents: 2, maxExposureUsdc: 10 },
    10
  );
  assert.equal(spread, 3); // base + full skew
});

test("inventory skew: linear ramp at half utilization", () => {
  const spread = skewedHalfSpreadCents(
    { baseHalfSpreadCents: 1, inventorySkewCents: 2, maxExposureUsdc: 10 },
    5
  );
  assert.equal(spread, 2); // base + 0.5 × skew
});

test("inventory skew: clamps over-utilization", () => {
  const spread = skewedHalfSpreadCents(
    { baseHalfSpreadCents: 1, inventorySkewCents: 2, maxExposureUsdc: 10 },
    25
  );
  assert.equal(spread, 3);
});

test("inventory skew: zero max exposure returns base", () => {
  const spread = skewedHalfSpreadCents(
    { baseHalfSpreadCents: 1, inventorySkewCents: 2, maxExposureUsdc: 0 },
    5
  );
  assert.equal(spread, 1);
});
