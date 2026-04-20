import assert from "node:assert/strict";
import test from "node:test";
import { forecastToProbabilities, roundPrice } from "../src/core/weatherFairValue.js";

test("forecastToProbabilities normalizes distribution and peaks near forecast", () => {
  const distribution = forecastToProbabilities(20.1, 1.5, [18, 19, 20, 21, 22]);
  const total = distribution.reduce((sum, point) => sum + point.probability, 0);
  const peak = distribution.reduce((best, point) => (point.probability > best.probability ? point : best));

  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.equal(peak.temperatureC, 20);
});

test("forecastToProbabilities rejects invalid uncertainty", () => {
  assert.throws(() => forecastToProbabilities(20, 0, [19, 20, 21]), /uncertaintyC/);
});

test("roundPrice rounds to cents", () => {
  assert.equal(roundPrice(0.374), 0.37);
  assert.equal(roundPrice(0.375), 0.38);
});

test("forecastToProbabilities rejects empty outcomes", () => {
  assert.throws(() => forecastToProbabilities(20, 1.5, []), /outcomesC/);
});
