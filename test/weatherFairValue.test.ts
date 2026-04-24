import assert from "node:assert/strict";
import test from "node:test";
import {
  forecastToProbabilities,
  horizonScaledSigma,
  normalCdf,
  roundPrice
} from "../src/core/weatherFairValue.js";

/**
 * Helper: build canonical 1°C interior bins with min as low-tail and max as
 * high-tail (matches the old pdf-era API tests expected).
 */
function celsiusGrid(temps: number[]) {
  const sorted = [...temps].sort((a, b) => a - b);
  return sorted.map((t, i) => ({
    temperatureC: t,
    binWidthC: 1,
    isLowTail: i === 0,
    isHighTail: i === sorted.length - 1
  }));
}

test("forecastToProbabilities normalizes distribution and peaks near forecast", () => {
  const distribution = forecastToProbabilities(20.1, 1.5, celsiusGrid([18, 19, 20, 21, 22]));
  const total = distribution.reduce((sum, point) => sum + point.probability, 0);
  const peak = distribution.reduce((best, point) => (point.probability > best.probability ? point : best));

  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.equal(peak.temperatureC, 20);
});

test("forecastToProbabilities rejects invalid uncertainty", () => {
  assert.throws(() => forecastToProbabilities(20, 0, celsiusGrid([19, 20, 21])), /uncertaintyC/);
});

test("roundPrice rounds to cents", () => {
  assert.equal(roundPrice(0.374), 0.37);
  assert.equal(roundPrice(0.375), 0.38);
});

test("forecastToProbabilities rejects empty buckets", () => {
  assert.throws(() => forecastToProbabilities(20, 1.5, []), /buckets/);
});

test("forecastToProbabilities uses CDF bins and marks tail buckets", () => {
  const distribution = forecastToProbabilities(20, 1.5, celsiusGrid([18, 19, 20, 21, 22]));
  const byTemp = new Map(distribution.map((p) => [p.temperatureC, p]));

  assert.ok(Math.abs(byTemp.get(18)!.probability - 0.1587) < 0.01);
  assert.ok(Math.abs(byTemp.get(19)!.probability - 0.2108) < 0.01);
  assert.ok(Math.abs(byTemp.get(20)!.probability - 0.2611) < 0.01);
  assert.ok(Math.abs(byTemp.get(22)!.probability - 0.1587) < 0.01);

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
  assert.equal(horizonScaledSigma(1.5, -5), 1.5);
});

test("forecastToProbabilities widens distribution as horizon grows", () => {
  const now = forecastToProbabilities(20, 1.5, celsiusGrid([18, 19, 20, 21, 22]), { hoursToResolution: 0 });
  const sevenDays = forecastToProbabilities(20, 1.5, celsiusGrid([18, 19, 20, 21, 22]), { hoursToResolution: 168 });
  const peakNow = now.find((p) => p.temperatureC === 20)!.probability;
  const peakFuture = sevenDays.find((p) => p.temperatureC === 20)!.probability;
  assert.ok(peakFuture < peakNow, `future peak ${peakFuture} should be below near peak ${peakNow}`);
});

test("normalCdf matches known standard-normal values", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1) - 0.8413) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1) - 0.1587) < 1e-3);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
});

test("forecastToProbabilities handles Fahrenheit buckets via converted centres", () => {
  // Chicago-style grid: forecast 18.5°C (= 65.3°F), Fahrenheit buckets covering
  // ~31°F (≈-0.5°C) up through ~50°F+ (≈10°C+). Almost all mass should land on
  // the "50°F or higher" bucket.
  const fToC = (f: number) => ((f - 32) * 5) / 9;
  const fahrenheitGrid = [
    { temperatureC: fToC(31), binWidthC: (5 / 9) * 1, isLowTail: true, isHighTail: false },
    { temperatureC: fToC(32.5), binWidthC: (5 / 9) * 2, isLowTail: false, isHighTail: false },
    { temperatureC: fToC(34.5), binWidthC: (5 / 9) * 2, isLowTail: false, isHighTail: false },
    { temperatureC: fToC(50), binWidthC: (5 / 9) * 1, isLowTail: false, isHighTail: true }
  ];
  const distribution = forecastToProbabilities(18.5, 1.5, fahrenheitGrid);
  const highTail = distribution.find((p) => p.kind === "high-tail")!;
  assert.ok(highTail.probability > 0.98, `high-tail should carry ~all mass, got ${highTail.probability}`);
});
