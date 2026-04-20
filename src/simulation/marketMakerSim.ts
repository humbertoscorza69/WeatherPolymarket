/**
 * Monte Carlo simulator for the Polymarket weather market maker.
 *
 * What it simulates (per episode):
 *  - A single binary market over a session lifetime (e.g. 12 hours).
 *  - A true underlying probability `p_true` drawn from a realistic distribution.
 *  - A market midpoint that diffuses around p_true with some noise and drift.
 *  - Order-book depth (bid and ask) whose queues drain and refill stochastically.
 *  - A market-maker strategy that quotes at `mid - halfSpread`, posts SELL at
 *    entry + 1 tick after BUY fills, and can stop-loss via taker exit.
 *  - Resolution: at session end, probability collapses to 0 or 1 based on p_true.
 *
 * What it measures:
 *  - Realized PnL from every closed round-trip
 *  - Inventory mark-to-resolution (lost if a position can't exit before close)
 *  - Stop-loss costs (taker fees + adverse exit price)
 *  - LP rewards (approximated as $ / tick-minute the BUY or SELL rests close to mid)
 *
 * What it does NOT model:
 *  - Informed adversaries with a better forecast (we treat mid drift as exogenous)
 *  - Queue position (we assume uniform fill probability proportional to depth_ahead)
 *  - Polymarket's exact LP reward formula (we use a simple proxy)
 *
 * The simulator is deterministic per seed. Pass the same seed twice → same output.
 */

export interface StrategyParams {
  halfSpreadCents: number;          // BUY at mid - halfSpreadCents/100
  inventorySkewCents: number;       // widen spread linearly with exposure
  orderSizeUsdc: number;
  tickSize: number;
  minShares: number;
  refreshIntervalSec: number;        // time between re-quote cycles
  maxInventoryPositions: number;    // max concurrent positions before we stop quoting
  stopLoss: {
    enabled: boolean;
    catastrophicDropRatio: number;
    deepDropRatio: number;
    deepDropMaxMinutes: number;
    resolutionStopHours: number;
    resolutionDropRatio: number;
    maxHoldingHours: number;
  };
  takerFeeRate: number; // 0.0125 on Polymarket
  makerRebateRate: number; // 0.003125 (25% of 1.25% taker fee) — approximate
}

export interface MarketParams {
  pTrue: number;                     // true probability of outcome at resolution
  initialMid: number;                // starting midpoint
  midDriftBiasPerHour: number;       // drift toward p_true
  midVolPerHour: number;             // noise in mid (standard deviation)
  spreadCentsBid: number;            // width of book (bestAsk - bestBid) in cents
  bookQueueDepth: number;            // expected queue depth ahead of our order
  orderArrivalsPerMinute: number;    // Poisson rate of counterparty orders hitting the book
  sessionHours: number;              // duration of the simulation
  timeStepSec: number;               // simulation granularity
}

export interface SimulationResult {
  realizedPnlUsdc: number;
  roundTrips: number;
  stopLosses: number;
  stopLossCostUsdc: number;
  fillsBuy: number;
  fillsSell: number;
  leftoverShares: number;
  leftoverValueAtResolutionUsdc: number;
  lpRewardsUsdc: number;
  finalMid: number;
  pnlBreakdown: {
    fromRoundTrips: number;
    fromStopLosses: number;
    fromUnresolvedInventory: number;
    fromLpRewards: number;
  };
}

interface ActivePosition {
  shares: number;
  entryPrice: number;
  entryTimeSec: number;
  restingSellPrice: number | null;
}

/**
 * Mulberry32 PRNG. Deterministic per seed, fast, good enough for MC.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  // Box-Muller
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function poisson(rng: () => number, lambda: number): number {
  // Knuth algorithm; fine for small-to-moderate lambda
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

export function simulate(
  strategy: StrategyParams,
  market: MarketParams,
  seed: number
): SimulationResult {
  const rng = makeRng(seed);

  const sessionSec = market.sessionHours * 3600;
  const stepSec = market.timeStepSec;
  const totalSteps = Math.ceil(sessionSec / stepSec);

  let mid = market.initialMid;
  const positions: ActivePosition[] = [];
  let realizedPnl = 0;
  let roundTrips = 0;
  let stopLosses = 0;
  let stopLossCost = 0;
  let fillsBuy = 0;
  let fillsSell = 0;
  let lpRewards = 0;

  let lastRefreshSec = -strategy.refreshIntervalSec;
  let restingBuyPrice: number | null = null;
  let restingBuyQueueAhead = 0; // updated when we place

  for (let step = 0; step <= totalSteps; step++) {
    const nowSec = step * stepSec;
    const hoursToResolution = (sessionSec - nowSec) / 3600;

    // 1) Advance the midpoint with drift + noise
    {
      const dtHours = stepSec / 3600;
      const drift = (market.pTrue - mid) * market.midDriftBiasPerHour * dtHours;
      const noise = gaussian(rng) * market.midVolPerHour * Math.sqrt(dtHours);
      mid = clamp(mid + drift + noise, 0.001, 0.999);
    }

    // 2) Refresh BUY quote
    if (nowSec - lastRefreshSec >= strategy.refreshIntervalSec) {
      lastRefreshSec = nowSec;
      const heldPositions = positions.length;
      if (heldPositions < strategy.maxInventoryPositions) {
        const utilization = heldPositions / Math.max(1, strategy.maxInventoryPositions);
        const effectiveHalfSpread =
          (strategy.halfSpreadCents + strategy.inventorySkewCents * utilization) / 100;
        const targetBid = mid - effectiveHalfSpread;
        const bid = roundDownToTick(targetBid, strategy.tickSize);
        if (bid > 0 && bid < 1) {
          restingBuyPrice = bid;
          restingBuyQueueAhead = Math.max(0, market.bookQueueDepth + gaussian(rng) * 3);
        } else {
          restingBuyPrice = null;
        }
      } else {
        restingBuyPrice = null;
      }
    }

    // 3) Stochastic order arrivals; may fill our resting orders
    const arrivals = poisson(rng, (market.orderArrivalsPerMinute / 60) * stepSec);
    for (let a = 0; a < arrivals; a++) {
      // Each arrival: with probability 0.5 it's a seller (hits bids), else a buyer (hits asks)
      const isSeller = rng() < 0.5;
      if (isSeller && restingBuyPrice !== null) {
        if (restingBuyQueueAhead > 0) {
          restingBuyQueueAhead -= 1;
        } else {
          // Our BUY fills
          const shares = Math.max(strategy.minShares, strategy.orderSizeUsdc / restingBuyPrice);
          positions.push({
            shares,
            entryPrice: restingBuyPrice,
            entryTimeSec: nowSec,
            restingSellPrice: null
          });
          fillsBuy++;
          restingBuyPrice = null;
          // Place SELL at entry + 1 tick immediately
          const pos = positions[positions.length - 1]!;
          pos.restingSellPrice = roundDownToTick(pos.entryPrice + strategy.tickSize, strategy.tickSize);
        }
      } else if (!isSeller) {
        // Buyer hits asks. Check any resting SELL of ours.
        for (const pos of positions) {
          if (pos.restingSellPrice !== null && mid + 0.005 >= pos.restingSellPrice) {
            const profit = (pos.restingSellPrice - pos.entryPrice) * pos.shares;
            realizedPnl += profit;
            roundTrips++;
            fillsSell++;
            // Mark for removal
            pos.shares = 0;
            break;
          }
        }
      }
    }
    // Sweep filled positions
    for (let i = positions.length - 1; i >= 0; i--) {
      if (positions[i]!.shares <= 0) positions.splice(i, 1);
    }

    // 4) Stop-loss evaluation
    if (strategy.stopLoss.enabled) {
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i]!;
        const heldMin = (nowSec - pos.entryTimeSec) / 60;
        const priceRatio = mid / pos.entryPrice;
        const trigger =
          priceRatio <= strategy.stopLoss.catastrophicDropRatio ||
          (priceRatio <= strategy.stopLoss.deepDropRatio &&
            heldMin >= strategy.stopLoss.deepDropMaxMinutes) ||
          (hoursToResolution <= strategy.stopLoss.resolutionStopHours &&
            priceRatio < strategy.stopLoss.resolutionDropRatio) ||
          heldMin / 60 >= strategy.stopLoss.maxHoldingHours;
        if (trigger) {
          // Execute taker exit at best bid (approximated as mid - spread/2)
          const bestBid = mid - market.spreadCentsBid / 200;
          const exitPrice = Math.max(0, bestBid);
          const grossExit = exitPrice * pos.shares;
          const fee = grossExit * strategy.takerFeeRate;
          const netProceeds = grossExit - fee;
          const costBasis = pos.entryPrice * pos.shares;
          const pnl = netProceeds - costBasis;
          realizedPnl += pnl;
          stopLosses++;
          stopLossCost += Math.max(0, -pnl);
          positions.splice(i, 1);
        }
      }
    }

    // 5) LP rewards proxy: $ proportional to (1 - distance_from_mid/max_window) × size × dt
    //    Approximation of Polymarket's "closer to mid = more reward" scheme.
    if (restingBuyPrice !== null) {
      const distance = Math.abs(mid - restingBuyPrice);
      const window = 0.03; // 3¢ reward window
      const closeness = Math.max(0, 1 - distance / window);
      lpRewards += closeness * strategy.orderSizeUsdc * (stepSec / 3600) * 0.0002; // ~$0.0002/hr/$size at mid
    }
    for (const pos of positions) {
      if (pos.restingSellPrice !== null) {
        const distance = Math.abs(mid - pos.restingSellPrice);
        const window = 0.03;
        const closeness = Math.max(0, 1 - distance / window);
        lpRewards += closeness * pos.entryPrice * pos.shares * (stepSec / 3600) * 0.0002;
      }
    }
  }

  // 6) Resolve any remaining inventory at p_true collapsing to {0, 1}
  const outcomeWins = rng() < market.pTrue;
  const resolutionPrice = outcomeWins ? 1 : 0;
  let leftoverShares = 0;
  let leftoverValue = 0;
  let leftoverPnl = 0;
  for (const pos of positions) {
    leftoverShares += pos.shares;
    leftoverValue += resolutionPrice * pos.shares;
    leftoverPnl += (resolutionPrice - pos.entryPrice) * pos.shares;
  }
  realizedPnl += leftoverPnl;

  return {
    realizedPnlUsdc: realizedPnl + lpRewards,
    roundTrips,
    stopLosses,
    stopLossCostUsdc: stopLossCost,
    fillsBuy,
    fillsSell,
    leftoverShares,
    leftoverValueAtResolutionUsdc: leftoverValue,
    lpRewardsUsdc: lpRewards,
    finalMid: mid,
    pnlBreakdown: {
      fromRoundTrips: realizedPnl - leftoverPnl,
      fromStopLosses: -stopLossCost,
      fromUnresolvedInventory: leftoverPnl,
      fromLpRewards: lpRewards
    }
  };
}

export interface BatchStats {
  strategy: string;
  episodes: number;
  meanPnl: number;
  medianPnl: number;
  stdPnl: number;
  winRate: number;
  maxDrawdown: number;
  percentile5: number;
  percentile95: number;
  meanRoundTrips: number;
  meanStopLosses: number;
  meanLpRewards: number;
}

export function runBatch(
  strategyName: string,
  strategy: StrategyParams,
  marketSpec: () => MarketParams,
  episodes: number,
  seedBase = 1
): BatchStats {
  const pnls: number[] = [];
  let totalRoundTrips = 0;
  let totalStopLosses = 0;
  let totalLpRewards = 0;
  for (let i = 0; i < episodes; i++) {
    const res = simulate(strategy, marketSpec(), seedBase + i);
    pnls.push(res.realizedPnlUsdc);
    totalRoundTrips += res.roundTrips;
    totalStopLosses += res.stopLosses;
    totalLpRewards += res.lpRewardsUsdc;
  }
  pnls.sort((a, b) => a - b);
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const median = pnls[Math.floor(pnls.length / 2)]!;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
  const std = Math.sqrt(variance);
  const wins = pnls.filter((p) => p > 0).length;
  return {
    strategy: strategyName,
    episodes,
    meanPnl: mean,
    medianPnl: median,
    stdPnl: std,
    winRate: wins / episodes,
    maxDrawdown: pnls[0]!,
    percentile5: pnls[Math.floor(pnls.length * 0.05)]!,
    percentile95: pnls[Math.floor(pnls.length * 0.95)]!,
    meanRoundTrips: totalRoundTrips / episodes,
    meanStopLosses: totalStopLosses / episodes,
    meanLpRewards: totalLpRewards / episodes
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function roundDownToTick(v: number, tickSize: number): number {
  const factor = Math.round(1 / tickSize);
  return Math.floor(v * factor + 1e-9) / factor;
}
