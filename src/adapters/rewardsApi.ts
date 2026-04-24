/**
 * Polymarket Liquidity Rewards API wrapper.
 *
 * Polymarket distributes a daily USDC pool to makers on each market in the
 * Rewards Program. The per-market reward is weighted by:
 *   - our resting order size × time-on-book
 *   - proximity to midpoint (cutoff at market.rewards_max_spread)
 *   - relative to all other makers' combined score on the same market
 *
 * Reward rate per maker (approximate):
 *   our_score    = size × (1 − distance/max_spread) × time_fraction_of_day
 *   total_score  = sum over all competing makers
 *   our_reward   = (our_score / total_score) × rate_per_day
 *
 * We don't know total_score without simulating competitors. In the backtest
 * we use a `competitiveShare` parameter (default 0.10 = "we capture 10% of
 * the pool") which is conservative for thinly-made markets and pessimistic
 * for heavily-made ones. Live calibration via `getUserEarningsAndMarketsConfig()`
 * can refine this later.
 *
 * Endpoint: GET /rewards/markets (paginated, SDK handles paging).
 */

import type { MarketReward } from "@polymarket/clob-client";

export interface RewardsSnapshot {
  conditionId: string;
  marketSlug: string;
  eventSlug: string;
  question: string;
  /** Daily pool in USDC (sum across active reward configs). */
  ratePerDay: number;
  /** Cents from mid beyond which orders don't qualify. */
  maxSpreadCents: number;
  /** Minimum order size in shares to qualify. */
  minSize: number;
  /** Token IDs for YES / NO sides. */
  yesTokenId?: string;
  noTokenId?: string;
  /** Earliest start and latest end across reward configs. */
  startDate?: string;
  endDate?: string;
}

/** Transform raw MarketReward[] from the SDK into our compact snapshot. */
export function parseRewardsList(raw: MarketReward[]): RewardsSnapshot[] {
  const today = new Date().toISOString().slice(0, 10);
  return raw
    .map<RewardsSnapshot | null>((m) => {
      const configs = m.rewards_config ?? [];
      // Keep only configs active today (start <= today <= end)
      const active = configs.filter((cfg) => {
        const s = (cfg.start_date ?? "").slice(0, 10);
        const e = (cfg.end_date ?? "").slice(0, 10);
        return (!s || s <= today) && (!e || e >= today);
      });
      const ratePerDay = active.reduce((sum, cfg) => sum + (cfg.rate_per_day ?? 0), 0);
      if (ratePerDay <= 0) return null;
      const startDate = active
        .map((c) => c.start_date)
        .filter(Boolean)
        .sort()[0];
      const endDate = active
        .map((c) => c.end_date)
        .filter(Boolean)
        .sort()
        .slice(-1)[0];
      const tokens = m.tokens ?? [];
      const yesToken = tokens.find((t) =>
        ["yes", "Yes", "YES"].includes(t.outcome)
      );
      const noToken = tokens.find((t) =>
        ["no", "No", "NO"].includes(t.outcome)
      );
      return {
        conditionId: m.condition_id,
        marketSlug: m.market_slug,
        eventSlug: m.event_slug,
        question: m.question,
        ratePerDay,
        maxSpreadCents: Number(m.rewards_max_spread),
        minSize: Number(m.rewards_min_size),
        yesTokenId: yesToken?.token_id,
        noTokenId: noToken?.token_id,
        startDate,
        endDate
      };
    })
    .filter((x): x is RewardsSnapshot => x !== null);
}

/**
 * Estimated daily LP reward for quoting `size` USDC at `distanceCents` from
 * mid on a market with rewards config, assuming we capture `competitiveShare`
 * of the daily pool AND meet the market's minimum order size.
 *
 * IMPORTANT: This enforces the min_size check. Markets with high pool sizes
 * tend to have high min_size (250-1000 shares), which requires $50-$500 per
 * order to qualify at typical prices. Ignoring this returns fantasy numbers.
 *
 * quoteScore = size × max(0, 1 − distance / maxSpread)
 * estReward  = quoteScore share × competitiveShare × ratePerDay
 */
export function estimatedDailyReward(
  snapshot: RewardsSnapshot,
  sizeUsdc: number,
  distanceCents: number,
  competitiveShare = 0.1,
  assumedPrice = 0.5
): number {
  if (sizeUsdc <= 0 || snapshot.ratePerDay <= 0) return 0;
  if (distanceCents >= snapshot.maxSpreadCents) return 0;
  // Enforce the min_size gate. At `sizeUsdc` and a typical market price,
  // shares = sizeUsdc / assumedPrice. If this is below the rewards-program
  // minimum, we earn nothing.
  const shares = sizeUsdc / assumedPrice;
  if (shares < snapshot.minSize) return 0;
  const proximity = Math.max(0, 1 - distanceCents / snapshot.maxSpreadCents);
  return proximity * competitiveShare * snapshot.ratePerDay;
}

/** Returns true if a given bankroll/order-size can satisfy the min-size gate
 *  on this market at a given expected price. */
export function isFeasible(
  snapshot: RewardsSnapshot,
  sizeUsdc: number,
  expectedPrice = 0.5
): boolean {
  return sizeUsdc / expectedPrice >= snapshot.minSize;
}
