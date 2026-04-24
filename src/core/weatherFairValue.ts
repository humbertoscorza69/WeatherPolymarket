export interface ProbabilityPoint {
  conditionId?: string;
  temperatureC: number;
  probability: number;
  kind: "low-tail" | "point" | "high-tail";
}

export interface OutcomeBucket {
  /** Optional per-market id so callers can correlate results. */
  conditionId?: string;
  /** Bin centre in Celsius. For range bins this is the centre; for tails, the closed edge. */
  temperatureC: number;
  /** Bin width in Celsius. Ignored for tails. */
  binWidthC: number;
  isLowTail: boolean;
  isHighTail: boolean;
}

export interface FairValueOptions {
  /** Hours until market resolution for horizon-scaled σ. */
  hoursToResolution?: number;
}

/**
 * Convert a point forecast of daily max temperature into a probability
 * distribution over a list of outcome buckets, using proper CDF integration.
 *
 * Each bucket carries its own width and an explicit tail flag. This lets the
 * solver handle:
 *   - Celsius 1°C bins (width 1, non-tail)
 *   - Fahrenheit 2°F range bins → width ≈ 1.11°C, non-tail
 *   - "X or below" → low-tail (CDF up to the closed edge)
 *   - "X or higher" → high-tail (survival above the closed edge)
 *   - mixed-unit grids
 *
 * Normalized so the sum equals 1 over the provided buckets.
 */
export function forecastToProbabilities(
  forecastTempC: number,
  baseUncertaintyC: number,
  buckets: OutcomeBucket[],
  options: FairValueOptions = {}
): ProbabilityPoint[] {
  if (!Number.isFinite(forecastTempC)) throw new Error("forecastTempC must be finite");
  if (!Number.isFinite(baseUncertaintyC) || baseUncertaintyC <= 0) {
    throw new Error("uncertaintyC must be > 0");
  }
  if (buckets.length === 0) throw new Error("buckets must not be empty");

  const sigma = horizonScaledSigma(baseUncertaintyC, options.hoursToResolution);

  const raw = buckets.map<ProbabilityPoint>((bucket) => {
    const { temperatureC: centre, binWidthC, isLowTail, isHighTail } = bucket;
    const halfWidth = binWidthC / 2;
    let p: number;
    let kind: ProbabilityPoint["kind"];
    if (isLowTail) {
      // Low tail: "31°F or below" uses 31°F as the closed upper edge, so the
      // bucket covers T ≤ centre + halfWidth (the outside of the range edge).
      p = normalCdf((centre + halfWidth - forecastTempC) / sigma);
      kind = "low-tail";
    } else if (isHighTail) {
      // High tail: "50°F or higher" → T > centre − halfWidth.
      p = 1 - normalCdf((centre - halfWidth - forecastTempC) / sigma);
      kind = "high-tail";
    } else {
      p =
        normalCdf((centre + halfWidth - forecastTempC) / sigma) -
        normalCdf((centre - halfWidth - forecastTempC) / sigma);
      kind = "point";
    }
    return { conditionId: bucket.conditionId, temperatureC: centre, probability: p, kind };
  });

  const total = raw.reduce((sum, point) => sum + point.probability, 0);
  if (total <= 0) throw new Error("probability distribution total was zero");

  return raw.map((point) => ({ ...point, probability: point.probability / total }));
}

/**
 * Standard NWP (numerical weather prediction) forecast error scaling.
 *
 * Same-day σ is the baseline (σ₀); error grows roughly as √(1 + horizon/24h)
 * out through 5-7 days. This captures the fact that a market resolving in 6
 * hours has much tighter forecast uncertainty than one resolving in 3 days.
 *
 *   hours |   multiplier
 *     0   |   1.00  (σ = σ₀)
 *    24   |   1.41  (σ = 1.41·σ₀)
 *    72   |   2.00  (σ = 2·σ₀)
 *   168   |   2.83  (σ = 2.83·σ₀, 7-day)
 */
export function horizonScaledSigma(baseSigma: number, hoursToResolution?: number): number {
  if (!Number.isFinite(hoursToResolution) || hoursToResolution === undefined) return baseSigma;
  const h = Math.max(0, hoursToResolution);
  return baseSigma * Math.sqrt(1 + h / 24);
}

/** Standard normal CDF via Abramowitz & Stegun erf approximation (< 1.5e-7 error). */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-absX * absX);
  return sign * y;
}

export function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}
