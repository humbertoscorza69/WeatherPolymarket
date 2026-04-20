export interface ProbabilityPoint {
  temperatureC: number;
  probability: number;
  /** Kind of bucket used: "low-tail" (open ≤), "point" (bin around value), or "high-tail" (open ≥). */
  kind?: "low-tail" | "point" | "high-tail";
}

export interface FairValueOptions {
  /**
   * Hours until the market resolves. Uncertainty scales as σ(h) = σ₀·√(1 + h/24)
   * to match empirical NWP forecast error growth. If omitted, σ₀ is used unscaled.
   */
  hoursToResolution?: number;
  /**
   * Width of a temperature bin in °C. Default 1. "17°C" outcome means max rounds
   * to 17, i.e. P(16.5 ≤ T < 17.5).
   */
  binWidthC?: number;
}

/**
 * Convert a point forecast of daily max temperature into a probability distribution
 * over a list of discrete °C outcomes, using CDF integration over each bin.
 *
 * Unlike a raw-pdf implementation, this:
 *  - integrates the Gaussian over each bin's ±½ range (so the probability mass
 *    is actually correct, not just a pdf height),
 *  - treats the MIN and MAX outcomes as open-ended tail buckets (P(T ≤ min+½)
 *    and P(T > max−½) respectively), which is how Polymarket publishes the
 *    "below X" and "above X" outcomes on weather markets,
 *  - scales σ with √(1 + h/24) when hoursToResolution is provided.
 *
 * The result is normalized so the sum over the provided outcomes equals 1.
 */
export function forecastToProbabilities(
  forecastTempC: number,
  baseUncertaintyC: number,
  outcomesC: number[],
  options: FairValueOptions = {}
): ProbabilityPoint[] {
  if (!Number.isFinite(forecastTempC)) throw new Error("forecastTempC must be finite");
  if (!Number.isFinite(baseUncertaintyC) || baseUncertaintyC <= 0) {
    throw new Error("uncertaintyC must be > 0");
  }
  if (outcomesC.length === 0) throw new Error("outcomesC must not be empty");

  const sigma = horizonScaledSigma(baseUncertaintyC, options.hoursToResolution);
  const binHalf = (options.binWidthC ?? 1) / 2;

  const sorted = [...outcomesC].sort((a, b) => a - b);
  const minT = sorted[0]!;
  const maxT = sorted[sorted.length - 1]!;

  const raw = outcomesC.map<ProbabilityPoint>((temp) => {
    let p: number;
    let kind: ProbabilityPoint["kind"];
    if (temp === minT && sorted.length > 1) {
      // Left tail: cumulative probability up to min + ½ bin
      p = normalCdf((minT + binHalf - forecastTempC) / sigma);
      kind = "low-tail";
    } else if (temp === maxT && sorted.length > 1) {
      // Right tail: survival probability above max − ½ bin
      p = 1 - normalCdf((maxT - binHalf - forecastTempC) / sigma);
      kind = "high-tail";
    } else {
      // Interior bin: integrate Gaussian over [temp − ½, temp + ½]
      p =
        normalCdf((temp + binHalf - forecastTempC) / sigma) -
        normalCdf((temp - binHalf - forecastTempC) / sigma);
      kind = "point";
    }
    return { temperatureC: temp, probability: p, kind };
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
