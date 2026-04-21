/**
 * Stop-loss rules for Polymarket weather market making.
 *
 * Context
 * -------
 * Weather markets resolve at end-of-day. Losing outcomes pay 0. Winners pay 1.
 * If we're stuck holding shares in a losing outcome at resolution, we lose 100%
 * of the capital invested in that position. The resting SELL at entry + 1 tick
 * will not fill if the market mid has collapsed below our entry.
 *
 * Rules (any ONE trigger → stop-loss)
 * ------------------------------------
 *  1. Catastrophic drop: current mid ≤ entry × catastrophicDropRatio.
 *     (Default 0.30 — losing 70% of expected value in any market is a clear
 *     "forecast was wrong, get out" signal.)
 *
 *  2. Deep drop held too long: mid ≤ entry × deepDropRatio AND we've held
 *     > deepDropMaxMinutes.
 *     (Default 0.60 mid vs entry, held > 120 min. The market has firmly
 *     re-priced us as a loser and isn't reverting.)
 *
 *  3. Near resolution: hoursToResolution ≤ resolutionStopHours AND
 *     mid < entry × resolutionDropRatio.
 *     (Default: 1h before close, mid below 70% of entry. Past this horizon
 *     reversion is unlikely; cut.)
 *
 *  4. Absolute holding cap: held > maxHoldingHours regardless of price.
 *     (Default 12h. Prevents overnight positions just before resolution.)
 *
 * Exit plan
 * ---------
 * When triggered, cancel any resting SELL and submit a SELL FAK (taker) at
 * bestBid so we pay the 1.25% taker fee but guarantee exit. We eat a small,
 * known loss instead of a 100% loss at resolution.
 */

export type StopLossRule =
  | "CATASTROPHIC_DROP"
  | "DEEP_DROP_STALE"
  | "NEAR_RESOLUTION_ADVERSE"
  | "MAX_HOLDING";

/**
 * Exit ladder per rule:
 *  - "urgent" rules exit via taker immediately. Certainty dominates slippage.
 *  - "patient" rules first try a maker SELL at bestAsk for a fixed time
 *    window. Only fall back to taker if that doesn't fill. This captures the
 *    maker rebate + avoids the taker fee when we're not in a hurry.
 *
 *  Catastrophic and near-resolution are ALWAYS urgent — the market is either
 *  collapsing or running out of time, and waiting is strictly worse.
 *
 *  Deep-drop-stale and max-holding are patient — the position has been
 *  stuck but not cratering, so waiting a minute for a maker fill is
 *  reasonable.
 */
export function exitUrgency(rule: StopLossRule): "urgent" | "patient" {
  switch (rule) {
    case "CATASTROPHIC_DROP":
    case "NEAR_RESOLUTION_ADVERSE":
      return "urgent";
    case "DEEP_DROP_STALE":
    case "MAX_HOLDING":
      return "patient";
  }
}

export interface StopLossConfig {
  enabled: boolean;
  catastrophicDropRatio: number;
  deepDropRatio: number;
  deepDropMaxMinutes: number;
  resolutionStopHours: number;
  resolutionDropRatio: number;
  maxHoldingHours: number;
  /** Seconds to wait on a maker SELL before falling back to taker. Patient rules only. */
  makerExitWaitSeconds: number;
}

export const DEFAULT_STOP_LOSS_CONFIG: StopLossConfig = {
  enabled: true,
  catastrophicDropRatio: 0.3,
  deepDropRatio: 0.6,
  deepDropMaxMinutes: 120,
  resolutionStopHours: 1,
  resolutionDropRatio: 0.7,
  maxHoldingHours: 12,
  makerExitWaitSeconds: 90
};

export interface StopLossInput {
  conditionId: string;
  outcomeLabel: string;
  avgEntryPrice: number;
  shares: number;
  currentMid: number;
  /** UNIX ms when the first BUY for this position filled. */
  entryTime: number;
  /** UNIX ms for now. */
  now: number;
  /** Hours until the event resolves (end-of-day UTC). */
  hoursToResolution: number;
}

export type StopLossDecision =
  | { shouldStop: false }
  | { shouldStop: true; rule: StopLossRule; detail: Record<string, number | string> };

export function evaluateStopLoss(input: StopLossInput, config: StopLossConfig): StopLossDecision {
  if (!config.enabled) return { shouldStop: false };
  if (input.avgEntryPrice <= 0) return { shouldStop: false }; // unknown entry, don't act
  if (input.currentMid <= 0) return { shouldStop: false };

  const heldMinutes = (input.now - input.entryTime) / 60_000;
  const priceRatio = input.currentMid / input.avgEntryPrice;

  // Rule 1: catastrophic drop
  if (priceRatio <= config.catastrophicDropRatio) {
    return {
      shouldStop: true,
      rule: "CATASTROPHIC_DROP",
      detail: {
        priceRatio: round4(priceRatio),
        threshold: config.catastrophicDropRatio,
        entry: input.avgEntryPrice,
        mid: input.currentMid
      }
    };
  }

  // Rule 2: deep drop held too long
  if (priceRatio <= config.deepDropRatio && heldMinutes >= config.deepDropMaxMinutes) {
    return {
      shouldStop: true,
      rule: "DEEP_DROP_STALE",
      detail: {
        priceRatio: round4(priceRatio),
        threshold: config.deepDropRatio,
        heldMinutes: round2(heldMinutes),
        maxMinutes: config.deepDropMaxMinutes
      }
    };
  }

  // Rule 3: near resolution with adverse mid
  if (
    input.hoursToResolution <= config.resolutionStopHours &&
    priceRatio < config.resolutionDropRatio
  ) {
    return {
      shouldStop: true,
      rule: "NEAR_RESOLUTION_ADVERSE",
      detail: {
        priceRatio: round4(priceRatio),
        threshold: config.resolutionDropRatio,
        hoursToResolution: round2(input.hoursToResolution),
        windowHours: config.resolutionStopHours
      }
    };
  }

  // Rule 4: absolute holding cap
  if (heldMinutes / 60 >= config.maxHoldingHours) {
    return {
      shouldStop: true,
      rule: "MAX_HOLDING",
      detail: {
        heldHours: round2(heldMinutes / 60),
        maxHours: config.maxHoldingHours
      }
    };
  }

  return { shouldStop: false };
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
