import assert from "node:assert/strict";
import test from "node:test";
import {
  forecastToProbabilities,
  horizonScaledSigma,
  normalCdf,
  roundPrice
} from "../src/core/weatherFairValue.js";

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

test("forecastToProbabilities uses CDF bins, not pdf, and marks tail buckets", () => {
  const distribution = forecastToProbabilities(20, 1.5, [18, 19, 20, 21, 22]);
  const byTemp = new Map(distribution.map((p) => [p.temperatureC, p]));

  // Shape expectations for forecast=20, sigma=1.5, bin width 1:
  //   18 is left tail (P(T ≤ 18.5)) ≈ 0.159
  //   19 is interior bin (18.5..19.5) ≈ 0.211
  //   20 is peak bin (19.5..20.5) ≈ 0.261
  //   21 ≈ 0.211
  //   22 is right tail (P(T > 21.5)) ≈ 0.159
  assert.ok(Math.abs(byTemp.get(18)!.probability - 0.1587) < 0.01);
  assert.ok(Math.abs(byTemp.get(19)!.probability - 0.2108) < 0.01);
  assert.ok(Math.abs(byTemp.get(20)!.probability - 0.2611) < 0.01);
  assert.ok(Math.abs(byTemp.get(22)!.probability - 0.1587) < 0.01);

  // Tail flags are set correctly
  assert.equal(byTemp.get(18)!.kind, "low-tail");
  assert.equal(byTemp.get(19)!.kind, "point");
  assert.equal(byTemp.get(20)!.kind, "point");
  assert.equal(byTemp.get(22)!.kind, "high-tail");
});

test("horizonScaledSigma grows as sqrt(1 + hours/24)", () => {
  assert.equal(horizonScaledSigma(1.5), 1.5);
  assert.equal(horizonScaledSigma(1.5, 0), 1.5);
  assert.ok(Math.abs(horizonScaledSigma(1.5, 24) - 1.5 * Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(horizonScaledSigma(1.5, 72) - 1.5 * 2) < 1e-9);
  // Negative / zero clamps
  assert.equal(horizonScaledSigma(1.5, -5), 1.5);
});

test("forecastToProbabilities widens distribution as horizon grows", () => {
  const now = forecastToProbabilities(20, 1.5, [18, 19, 20, 21, 22], { hoursToResolution: 0 });
  const sevenDays = forecastToProbabilities(20, 1.5, [18, 19, 20, 21, 22], { hoursToResolution: 168 });
  const peakNow = now.find((p) => p.temperatureC === 20)!.probability;
  const peakFuture = sevenDays.find((p) => p.temperatureC === 20)!.probability;
  // Same forecast, longer horizon → flatter distribution
  assert.ok(peakFuture < peakNow, `future peak ${peakFuture} should be below near peak ${peakNow}`);
});

test("normalCdf matches known standard-normal values", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1) - 0.8413) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1) - 0.1587) < 1e-3);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
});
