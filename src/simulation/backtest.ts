/**
 * Historical backtest for the weather market maker.
 *
 * Input: a real MarketPrice[] time series (from Polymarket's
 * `clob.getPricesHistory`) and a strategy config. Output: a deterministic
 * replay of what the bot would have done, with PnL, fills, and stop-loss
 * counts.
 *
 * Accounting assumptions (documented honestly)
 * --------------------------------------------
 * - The historical series gives us mid-like samples `{t, p}` at the
 *   requested interval (1h / 6h / 1d, or Polymarket's `max` which is finer).
 *   It does NOT contain the full order book or the trade tape.
 * - We treat each sample as "the mid prevailed at this instant", which
 *   biases fill rate UPWARD (real queue position / depth not modeled).
 * - BUY fill rule: if any observed price ≤ our resting bid, assume we
 *   filled at our bid. (The market actually traded at our level.)
 * - SELL fill rule: if a subsequent sample's price ≥ our SELL (entry + tick),
 *   assume fill. Same caveat.
 * - Stop-loss trigger rules are identical to the live bot.
 *
 * Interpretation
 * --------------
 * The backtest is an OPTIMISTIC UPPER BOUND on what the strategy could have
 * achieved. Real fills are slower because of queue position. If the backtest
 * shows unprofitable results, the live bot is almost certainly unprofitable.
 * If the backtest is profitable, live performance is probably some fraction
 * of that — a useful directional signal, not an exact forecast.
 */

export interface BacktestPriceSample {
  t: number; // UNIX seconds
  p: number; // mid price
}

export interface BacktestStrategy {
  halfSpreadCents: number;
  inventorySkewCents: number;
  volMultiplier: number;
  volMaxExtraCents: number;
  volWindowSize: number;
  orderSizeUsdc: number;
  tickSize: number;
  minShares: number;
  refreshIntervalSec: number;
  maxInventoryPositions: number;
  stopLossEnabled: boolean;
  stopLossCatastrophicDropRatio: number;
  stopLossDeepDropRatio: number;
  stopLossDeepDropMaxMinutes: number;
  stopLossResolutionHours: number;
  stopLossResolutionDropRatio: number;
  stopLossMaxHoldingHours: number;
  takerFeeRate: number;
  /** Take-profit ticks above entry. 1 = classic MM exit; higher captures
   *  bigger moves at the cost of fill rate. */
  tpTicksBase?: number;
  /** Volatility-adjusted TP: tp_ticks = base + floor(mult × stddev_cents / tick_cents). */
  tpVolMultiplier?: number;
  /** Cap on tp_ticks when using vol adjustment. */
  tpTicksMax?: number;
  /** Drift filter: skip quotes on down-trending mids. See multiMarketQuoter. */
  driftFilterEnabled?: boolean;
  driftFilterMinSamples?: number;
  driftFilterDownDriftCents?: number;
  driftFilterRatio?: number;
  /** Polymarket LP reward config for THIS market. When provided, the
   *  backtest replaces the crude proxy with the real proximity-weighted
   *  formula: reward_per_step = size × (1 − distance/maxSpread) × (step/86400) ×
   *  competitiveShare × ratePerDay. When omitted, the crude proxy is used
   *  (backward compatible). */
  rewardsRatePerDay?: number;
  rewardsMaxSpreadCents?: number;
  rewardsMinSize?: number;
  rewardsCompetitiveShare?: number;
}

export interface BacktestResult {
  market: string;
  samples: number;
  spanHours: number;
  /** Total PnL including LP rewards. Spread PnL + LP rewards − stop-loss cost. */
  realizedPnlUsdc: number;
  roundTrips: number;
  stopLosses: number;
  stopLossPnlUsdc: number;
  /** LP reward contribution only. Useful to split spread-vs-rewards revenue. */
  lpRewardsUsdc: number;
  leftoverShares: number;
  leftoverEntryValueUsdc: number;
  buyFills: number;
  sellFills: number;
  firstPrice: number;
  lastPrice: number;
}

interface Position {
  shares: number;
  entryPrice: number;
  entryTimeSec: number;
  restingSell: number | null;
}

export function backtest(
  marketId: string,
  samples: BacktestPriceSample[],
  strategy: BacktestStrategy,
  resolutionOutcome?: 0 | 1
): BacktestResult {
  if (samples.length < 2) return emptyResult(marketId, samples);
  const ordered = [...samples].sort((a, b) => a.t - b.t);
  const resolutionTs = ordered[ordered.length - 1]!.t;
  // LP reward accumulator — uses the Polymarket formula when rewards config
  // is on the strategy, otherwise stays zero.
  let lpRewards = 0;
  const rewardsActive =
    (strategy.rewardsRatePerDay ?? 0) > 0 &&
    (strategy.rewardsMaxSpreadCents ?? 0) > 0;
  const competitiveShare = strategy.rewardsCompetitiveShare ?? 0.1;
  let lastSampleTs = ordered[0]!.t;

  const positions: Position[] = [];
  let realizedPnl = 0;
  let roundTrips = 0;
  let stopLosses = 0;
  let stopLossPnl = 0;
  let buyFills = 0;
  let sellFills = 0;

  let restingBuy: number | null = null;
  let lastRefreshTs = -Infinity;

  const mids: number[] = [];
  const pushMid = (p: number) => {
    mids.push(p);
    if (mids.length > strategy.volWindowSize) mids.shift();
  };
  const stddevCents = (): number => {
    if (mids.length < 3) return 0;
    const diffs: number[] = [];
    for (let i = 1; i < mids.length; i++) diffs.push((mids[i]! - mids[i - 1]!) * 100);
    const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    const variance = diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / diffs.length;
    return Math.sqrt(variance);
  };
  const driftStats = (): { samples: number; driftCents: number; driftRatio: number } => {
    if (mids.length < 3) return { samples: mids.length, driftCents: 0, driftRatio: 0 };
    const diffs: number[] = [];
    for (let i = 1; i < mids.length; i++) diffs.push((mids[i]! - mids[i - 1]!) * 100);
    const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    const variance = diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / diffs.length;
    const sd = Math.sqrt(variance);
    const windowDrift = mean * (mids.length - 1);
    const ratio = sd > 1e-9 ? Math.abs(windowDrift) / (sd * Math.sqrt(mids.length - 1)) : 0;
    return { samples: mids.length, driftCents: windowDrift, driftRatio: ratio };
  };

  for (const sample of ordered) {
    const ts = sample.t;
    const p = sample.p;
    pushMid(p);
    const hoursToResolution = Math.max(0, (resolutionTs - ts) / 3600);

    // 1) Fill checks FIRST — the resting bid/SELLs from the previous refresh
    //    may have been hit by the market during the interval ending at `ts`.
    //    Refreshing first would shadow the still-resting order with a new price.
    if (restingBuy !== null && p <= restingBuy + 1e-9) {
      const shares = Math.max(strategy.minShares, strategy.orderSizeUsdc / restingBuy);
      // Dynamic TP: base + vol-adjusted extra ticks, capped.
      const tpBase = Math.max(1, Math.floor(strategy.tpTicksBase ?? 1));
      const volMul = strategy.tpVolMultiplier ?? 0;
      const tpMax = strategy.tpTicksMax ?? 5;
      let tpTicks = tpBase;
      if (volMul > 0) {
        const volCents = stddevCents();
        const extra = Math.floor((volMul * volCents) / (strategy.tickSize * 100));
        tpTicks = Math.min(tpMax, tpBase + Math.max(0, extra));
      }
      positions.push({
        shares,
        entryPrice: restingBuy,
        entryTimeSec: ts,
        restingSell: roundDownToTick(restingBuy + tpTicks * strategy.tickSize, strategy.tickSize)
      });
      buyFills++;
      restingBuy = null;
    }
    for (let j = positions.length - 1; j >= 0; j--) {
      const pos = positions[j]!;
      if (pos.restingSell !== null && p >= pos.restingSell - 1e-9) {
        realizedPnl += (pos.restingSell - pos.entryPrice) * pos.shares;
        roundTrips++;
        sellFills++;
        positions.splice(j, 1);
      }
    }

    // 2) Refresh the BUY quote only AFTER resolving fills against the prior bid.
    if (ts - lastRefreshTs >= strategy.refreshIntervalSec) {
      lastRefreshTs = ts;
      let skipQuote = false;
      // Drift filter: skip quote if the mid has been trending down.
      if (strategy.driftFilterEnabled) {
        const ds = driftStats();
        if (ds.samples >= (strategy.driftFilterMinSamples ?? 10)) {
          const downTrending =
            ds.driftCents <= -(strategy.driftFilterDownDriftCents ?? 2) &&
            ds.driftRatio >= (strategy.driftFilterRatio ?? 1.2);
          if (downTrending) skipQuote = true;
        }
      }
      if (!skipQuote && positions.length < strategy.maxInventoryPositions) {
        const utilization = positions.length / Math.max(1, strategy.maxInventoryPositions);
        const volExtra = Math.min(
          strategy.volMaxExtraCents,
          strategy.volMultiplier * stddevCents()
        );
        const effectiveHalfSpread =
          (strategy.halfSpreadCents + strategy.inventorySkewCents * utilization + volExtra) / 100;
        const raw = p - effectiveHalfSpread;
        const bid = roundDownToTick(raw, strategy.tickSize);
        restingBuy = bid > strategy.tickSize && bid < 1 - strategy.tickSize ? bid : null;
      } else {
        restingBuy = null;
      }
    }

    // Stop-loss
    if (strategy.stopLossEnabled) {
      for (let j = positions.length - 1; j >= 0; j--) {
        const pos = positions[j]!;
        const heldMin = (ts - pos.entryTimeSec) / 60;
        const priceRatio = p / pos.entryPrice;
        const fire =
          priceRatio <= strategy.stopLossCatastrophicDropRatio ||
          (priceRatio <= strategy.stopLossDeepDropRatio &&
            heldMin >= strategy.stopLossDeepDropMaxMinutes) ||
          (hoursToResolution <= strategy.stopLossResolutionHours &&
            priceRatio < strategy.stopLossResolutionDropRatio) ||
          heldMin / 60 >= strategy.stopLossMaxHoldingHours;
        if (!fire) continue;
        const exitPrice = Math.max(0, p);
        const fee = exitPrice * pos.shares * strategy.takerFeeRate;
        const pnl = (exitPrice - pos.entryPrice) * pos.shares - fee;
        realizedPnl += pnl;
        stopLosses++;
        if (pnl < 0) stopLossPnl += pnl;
        positions.splice(j, 1);
      }
    }

    // 5) LP rewards — accumulate while orders rest near mid.
    //
    // Per Polymarket's rewards program, the reward pool is distributed by:
    //   our_score  = size × proximity × time-on-book
    //   our_share  = our_score / total_score_of_all_makers  (≈ competitiveShare)
    //   reward     = our_share × rate_per_day
    //
    // competitiveShare abstracts away the total-maker-score term; it's a
    // conservative estimate of our slice of the pool. So per step:
    //   reward = proximity × (step_sec / 86400) × competitiveShare × rate_per_day
    // Per order: both BUY and SELL earn independently when each sits within
    // max_spread of mid AND meets min_size.
    if (rewardsActive) {
      const stepSec = Math.max(0, ts - lastSampleTs);
      const timeFraction = stepSec / 86400;
      const maxSpread = strategy.rewardsMaxSpreadCents ?? 0;
      const minSize = strategy.rewardsMinSize ?? 0;
      const ratePerDay = strategy.rewardsRatePerDay ?? 0;
      // Resting BUY
      if (restingBuy !== null) {
        const distanceCents = Math.abs(p - restingBuy) * 100;
        const shares = strategy.orderSizeUsdc / restingBuy;
        if (distanceCents < maxSpread && shares >= minSize) {
          const proximity = 1 - distanceCents / maxSpread;
          lpRewards += proximity * timeFraction * competitiveShare * ratePerDay;
        }
      }
      // Resting SELLs (one per open position)
      for (const pos of positions) {
        if (pos.restingSell === null) continue;
        const distanceCents = Math.abs(p - pos.restingSell) * 100;
        if (distanceCents < maxSpread && pos.shares >= minSize) {
          const proximity = 1 - distanceCents / maxSpread;
          lpRewards += proximity * timeFraction * competitiveShare * ratePerDay;
        }
      }
    }
    lastSampleTs = ts;
  }

  // Settlement
  let leftoverShares = 0;
  let leftoverEntryValue = 0;
  for (const pos of positions) {
    leftoverShares += pos.shares;
    leftoverEntryValue += pos.entryPrice * pos.shares;
    if (resolutionOutcome !== undefined) {
      realizedPnl += (resolutionOutcome - pos.entryPrice) * pos.shares;
    }
  }

  return {
    market: marketId,
    samples: ordered.length,
    spanHours: (resolutionTs - ordered[0]!.t) / 3600,
    realizedPnlUsdc: realizedPnl + lpRewards,
    roundTrips,
    stopLosses,
    stopLossPnlUsdc: stopLossPnl,
    lpRewardsUsdc: lpRewards,
    leftoverShares,
    leftoverEntryValueUsdc: leftoverEntryValue,
    buyFills,
    sellFills,
    firstPrice: ordered[0]!.p,
    lastPrice: ordered[ordered.length - 1]!.p
  };
}

function emptyResult(marketId: string, samples: BacktestPriceSample[]): BacktestResult {
  return {
    market: marketId,
    samples: samples.length,
    spanHours: 0,
    realizedPnlUsdc: 0,
    roundTrips: 0,
    stopLosses: 0,
    stopLossPnlUsdc: 0,
    lpRewardsUsdc: 0,
    leftoverShares: 0,
    leftoverEntryValueUsdc: 0,
    buyFills: 0,
    sellFills: 0,
    firstPrice: samples[0]?.p ?? 0,
    lastPrice: samples[samples.length - 1]?.p ?? 0
  };
}

function roundDownToTick(v: number, tickSize: number): number {
  const factor = Math.round(1 / tickSize);
  return Math.floor(v * factor + 1e-9) / factor;
}

export interface BacktestBatchStats {
  markets: number;
  totalSamples: number;
  totalRoundTrips: number;
  totalStopLosses: number;
  totalPnlUsdc: number;
  totalLeftoverEntryValueUsdc: number;
  mean: number;
  median: number;
  percentile5: number;
  percentile95: number;
  winRate: number;
}

export function summarizeBatch(results: BacktestResult[]): BacktestBatchStats {
  if (results.length === 0) {
    return {
      markets: 0,
      totalSamples: 0,
      totalRoundTrips: 0,
      totalStopLosses: 0,
      totalPnlUsdc: 0,
      totalLeftoverEntryValueUsdc: 0,
      mean: 0,
      median: 0,
      percentile5: 0,
      percentile95: 0,
      winRate: 0
    };
  }
  const pnls = [...results.map((r) => r.realizedPnlUsdc)].sort((a, b) => a - b);
  const totalPnl = pnls.reduce((s, v) => s + v, 0);
  return {
    markets: results.length,
    totalSamples: results.reduce((s, r) => s + r.samples, 0),
    totalRoundTrips: results.reduce((s, r) => s + r.roundTrips, 0),
    totalStopLosses: results.reduce((s, r) => s + r.stopLosses, 0),
    totalPnlUsdc: totalPnl,
    totalLeftoverEntryValueUsdc: results.reduce((s, r) => s + r.leftoverEntryValueUsdc, 0),
    mean: totalPnl / pnls.length,
    median: pnls[Math.floor(pnls.length / 2)]!,
    percentile5: pnls[Math.floor(pnls.length * 0.05)]!,
    percentile95: pnls[Math.floor(pnls.length * 0.95)]!,
    winRate: pnls.filter((v) => v > 0).length / pnls.length
  };
}
