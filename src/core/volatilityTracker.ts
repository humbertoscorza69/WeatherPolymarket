/**
 * Realized-volatility tracker for per-market adaptive spread.
 *
 * Rationale
 * ---------
 * A fixed halfSpread of 1¢ is a blunt instrument. When a book is calm (mid
 * barely moves), 1¢ captures maker rebates and the bid reliably sits in the
 * queue until a seller arrives. When a book is volatile (mid swinging > 2¢
 * between refreshes), 1¢ is a hair-trigger — we get filled into every
 * adverse micro-move, and adverse selection bites us.
 *
 * Classical MM theory (Avellaneda-Stoikov, Cartea-Jaimungal) says the
 * optimal half-spread should scale with σ (price volatility). The simplest
 * usable form:
 *
 *   effectiveHalfSpread = baseHalfSpread + volMultiplier × realizedStddev
 *
 * where realizedStddev is the standard deviation of recent mid updates
 * measured in cents. Strategy is then a line: low vol → base spread; high
 * vol → wider spread that automatically backs off when flow gets toxic.
 *
 * We cap the widening at maxExtraCents so the bot doesn't stop quoting
 * entirely in a big shock.
 *
 * Implementation
 * --------------
 * Per-conditionId bounded ring buffer of the last N mid observations.
 * Compute stddev of cent-denominated mid returns (mid_t − mid_{t−1}).
 * O(N) per sample, O(1) per read if cached. For N ≤ 120 at one update every
 * 30s, this is 1 hour of memory and tiny CPU.
 */

export interface VolTrackerOptions {
  windowSize: number; // number of samples retained, e.g. 60 = 30 min at 30s refresh
  volMultiplier: number; // cents added per 1 cent of stddev
  maxExtraCents: number; // cap on added cents
}

export interface VolSnapshot {
  stddevCents: number;
  samples: number;
  extraCents: number;
  /** Signed drift in cents over the recent window: positive = up-trending,
   *  negative = down-trending, zero = oscillating. Computed as the mean of
   *  the recent returns (not stddev). Used by the trend-drift filter. */
  driftCents: number;
  /** |driftCents| / stddevCents — a normalized "how trend-y is this?" signal.
   *  Large values (> 1.0) indicate persistent directional movement (informed
   *  flow / news); small values (< 0.3) indicate oscillating book. Skip BUYs
   *  when driftRatio is large AND direction is down (market converging below
   *  our entry target). */
  driftRatio: number;
}

export class VolatilityTracker {
  private readonly buffers = new Map<string, number[]>();

  constructor(private readonly options: VolTrackerOptions) {}

  update(conditionId: string, midPrice: number): void {
    let buf = this.buffers.get(conditionId);
    if (!buf) {
      buf = [];
      this.buffers.set(conditionId, buf);
    }
    buf.push(midPrice);
    if (buf.length > this.options.windowSize) buf.shift();
  }

  snapshot(conditionId: string): VolSnapshot {
    const buf = this.buffers.get(conditionId);
    if (!buf || buf.length < 3) {
      return {
        stddevCents: 0,
        samples: buf?.length ?? 0,
        extraCents: 0,
        driftCents: 0,
        driftRatio: 0
      };
    }
    // First-difference returns in cents. Mean = signed drift, stddev = noise.
    const diffsCents: number[] = [];
    for (let i = 1; i < buf.length; i++) diffsCents.push((buf[i]! - buf[i - 1]!) * 100);
    const mean = diffsCents.reduce((s, v) => s + v, 0) / diffsCents.length;
    const variance = diffsCents.reduce((s, v) => s + (v - mean) ** 2, 0) / diffsCents.length;
    const stddev = Math.sqrt(variance);
    // driftCents = total cent move per step on average (signed).
    // Over the full window that's mean × (buf.length - 1) cents of drift.
    const windowDriftCents = mean * (buf.length - 1);
    // driftRatio: t-statistic style — |mean| / (stddev / √(N-1)). Large values
    // mean "this drift is reliable, not noise". When stddev ≈ 0 and drift ≠ 0
    // (perfect monotonic trend), treat as very high signal (capped at 999).
    let driftRatio = 0;
    if (Math.abs(windowDriftCents) > 1e-9) {
      if (stddev > 1e-9) {
        driftRatio = Math.abs(windowDriftCents) / (stddev * Math.sqrt(buf.length - 1));
      } else {
        driftRatio = 999;
      }
    }
    const extra = Math.min(this.options.maxExtraCents, this.options.volMultiplier * stddev);
    return {
      stddevCents: stddev,
      samples: buf.length,
      extraCents: extra,
      driftCents: windowDriftCents,
      driftRatio
    };
  }

  /** Effective cents of halfSpread given base cents and current vol. */
  effectiveHalfSpreadCents(conditionId: string, baseCents: number): number {
    return baseCents + this.snapshot(conditionId).extraCents;
  }

  /** For dashboard/metrics. */
  allSnapshots(): Array<{ conditionId: string } & VolSnapshot> {
    return [...this.buffers.keys()].map((cid) => ({ conditionId: cid, ...this.snapshot(cid) }));
  }
}
