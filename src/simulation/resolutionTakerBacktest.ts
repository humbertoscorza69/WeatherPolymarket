/**
 * Backtest engine for the "resolution taker" strategy — the fc25 / 2d99 / 937
 * pattern we extracted from the wallet analyzer.
 *
 * The thesis
 * ----------
 * Retail traders often sell WINNING positions before resolution to lock in
 * profit — they'd rather take $0.99 now than wait for $1.00 at settlement.
 * A patient buyer who takes the other side of those "close out early" orders
 * and holds to resolution earns the gap:
 *
 *   pnl_per_share = (resolution_value - entry_price) - fee × entry_price
 *                 = (1 - 0.98) - 0 × 0.98 = $0.02  (if side wins)
 *
 * Across a universe of near-resolving markets with any outcome priced in the
 * [0.90, 0.998] band, this tends to be positive when the entry price is well
 * below 1.0 AND the market actually resolves in our favor.
 *
 * What the backtest simulates
 * ---------------------------
 *   1. Walk chronologically through a market's minute-level price samples.
 *   2. If `sample.p ∈ [entryMin, entryMax]` AND the time-to-resolution is
 *      within `maxHoldHours` AND above `minTimeToResolutionHours` (buffer so
 *      we don't chase literal last-second fills), attempt entry.
 *   3. Entry is taker-priced at `sample.p` (we assume worst-case: no maker
 *      rebate, fill at the observed mid). A Bernoulli coin flip with
 *      `fillProbability` decides whether we actually got on-book fast enough.
 *   4. On entry, size = orderSizeUsdc / entryPrice shares; pay takerFeeRate.
 *   5. Hold to resolution. Settlement value = 1 if this token is the winning
 *      side of the binary, else 0.
 *   6. PnL = shares × (settlementValue − entryPrice) − fees.
 *
 * This is a DETERMINISTIC upper-bound backtest. Monte Carlo in a separate
 * module perturbs fill probability, entry slippage, and fee assumptions so
 * we see the full uncertainty band, not a single fantasy number.
 *
 * What the backtest explicitly does NOT model
 * -------------------------------------------
 *   - Bid-ask spread around the mid (entry is assumed AT the sample price).
 *     Real entry is at best_ask ≥ mid; add 0.5-1 tick slippage in MC.
 *   - Queue position in the orderbook (we assume we can always take).
 *   - Capital cap: if a strategy would hold > N concurrent positions at our
 *     bankroll, the cap is enforced via the `maxConcurrentPositions` knob.
 *   - Adversarial selection: real retail flow gets worse as the price gets
 *     closer to 1.00. MC's fill-probability perturbation approximates this.
 */

export interface ResolvedMarketSamples {
  /** Stable ID (conditionId OR tokenId — doesn't matter as long as it's unique per virtual market). */
  id: string;
  /** Human-readable label for logging. */
  label: string;
  /** Token-level tick size (0.01 on most CLOB markets, 0.001 on some). */
  tickSize: number;
  /** Chronologically ordered minute-level price samples. */
  samples: { t: number; p: number }[];
  /** UNIX seconds at which the binary condition resolved. */
  resolutionTs: number;
  /** 1 if THIS token paid out $1 at resolution, 0 if it paid out $0. */
  tokenResolutionValue: 0 | 1;
  /** Category tag (weather, sports, crypto, ...) — used only for reporting. */
  category?: string;
}

export interface ResolutionTakerConfig {
  /** Lower bound of the entry price band. Below this, the outcome is not
   *  near-certain enough to be worth the buy-and-hold risk. */
  entryPriceMin: number;
  /** Upper bound of the entry band. Prices above this leave no room for
   *  fees to be covered (and often aren't reachable without taking). */
  entryPriceMax: number;
  /** Maximum hours before resolution we're willing to enter. Entering too
   *  early increases risk of a reversal before resolution. */
  maxHoldHours: number;
  /** Minimum hours to resolution — don't enter in the literal last few
   *  minutes (execution risk + fee hit on short holds). */
  minTimeToResolutionHours: number;
  /** USDC per entry. Must exceed the market's minimum order size at the
   *  entry price (enforced inside the backtest). */
  orderSizeUsdc: number;
  /** Per-fill taker fee as a fraction (Polymarket is ~0 currently, leave
   *  the knob so we can stress-test). */
  takerFeeRate: number;
  /** Probability that a given in-band sample results in an actual fill.
   *  Deterministic backtest uses 1.0 (optimistic); Monte Carlo varies this. */
  fillProbability: number;
  /** How many concurrent positions the strategy can hold at once (per the
   *  bankroll). Markets exceeding this at a given moment are skipped. */
  maxConcurrentPositions: number;
  /** Minimum shares an entry must represent; drop fills below this (micro
   *  fills distort per-trade PnL and wouldn't happen on a real CLOB). */
  minShares: number;
  /** If true, attempt multiple entries per market whenever price re-enters
   *  the band (mimics how the fc25 wallet scales into positions). If false,
   *  only the first valid sample triggers an entry. */
  allowMultipleEntries: boolean;
}

export interface ResolutionTakerTrade {
  market: string;
  category?: string;
  entryPrice: number;
  entryTs: number;
  resolutionTs: number;
  shares: number;
  notionalUsdc: number;
  holdHours: number;
  resolutionValue: 0 | 1;
  feeUsdc: number;
  pnlUsdc: number;
  won: boolean;
}

export interface ResolutionTakerBacktestResult {
  trades: ResolutionTakerTrade[];
  marketsConsidered: number;
  marketsEntered: number;
  totalPnlUsdc: number;
  totalNotionalUsdc: number;
  meanPnl: number;
  medianPnl: number;
  p05: number;
  p95: number;
  winRate: number;
  totalFeesUsdc: number;
  /** PnL aggregated by calendar day (unix day bucket → usdc). */
  dailyPnl: Map<string, number>;
}

/** Deterministic Xorshift32 for reproducible fill-probability sampling. */
function xorshift32(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

export function runResolutionTakerOnMarket(
  market: ResolvedMarketSamples,
  config: ResolutionTakerConfig,
  rng: () => number
): ResolutionTakerTrade[] {
  const trades: ResolutionTakerTrade[] = [];
  let entered = false; // only used when allowMultipleEntries=false

  for (const sample of market.samples) {
    if (!config.allowMultipleEntries && entered) break;
    const hoursToResolution = (market.resolutionTs - sample.t) / 3600;
    if (hoursToResolution > config.maxHoldHours) continue;
    if (hoursToResolution < config.minTimeToResolutionHours) break;
    if (sample.p < config.entryPriceMin || sample.p > config.entryPriceMax) continue;

    // Bernoulli fill. Deterministic on seed so results are reproducible.
    if (rng() > config.fillProbability) continue;

    const entryPrice = sample.p;
    const shares = config.orderSizeUsdc / entryPrice;
    if (shares < config.minShares) continue;

    const fee = entryPrice * shares * config.takerFeeRate;
    const grossPnl = shares * (market.tokenResolutionValue - entryPrice);
    const pnl = grossPnl - fee;

    trades.push({
      market: market.id,
      category: market.category,
      entryPrice,
      entryTs: sample.t,
      resolutionTs: market.resolutionTs,
      shares,
      notionalUsdc: shares * entryPrice,
      holdHours: hoursToResolution,
      resolutionValue: market.tokenResolutionValue,
      feeUsdc: fee,
      pnlUsdc: pnl,
      won: pnl > 0
    });
    entered = true;
  }

  return trades;
}

export function runResolutionTakerBacktest(
  markets: ResolvedMarketSamples[],
  config: ResolutionTakerConfig,
  seed = 0x9e3779b1
): ResolutionTakerBacktestResult {
  const rng = xorshift32(seed);
  // Apply concurrency cap by merging all trades into a single time-sorted
  // list and accepting them only when we have fewer than
  // maxConcurrentPositions open at the proposed entry instant.
  const candidateTrades: ResolutionTakerTrade[] = [];
  for (const market of markets) {
    candidateTrades.push(...runResolutionTakerOnMarket(market, config, rng));
  }
  candidateTrades.sort((a, b) => a.entryTs - b.entryTs);

  const accepted: ResolutionTakerTrade[] = [];
  const openEnds: number[] = []; // resolution timestamps of still-open trades
  for (const trade of candidateTrades) {
    // Expire any positions that have resolved before this trade's entry.
    while (openEnds.length > 0 && openEnds[0]! <= trade.entryTs) openEnds.shift();
    if (openEnds.length >= config.maxConcurrentPositions) continue;
    accepted.push(trade);
    openEnds.push(trade.resolutionTs);
    openEnds.sort((a, b) => a - b);
  }

  const pnls = accepted.map((t) => t.pnlUsdc);
  const sorted = [...pnls].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted.length === 0 ? 0 : sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * q)))]!;

  const dailyPnl = new Map<string, number>();
  for (const t of accepted) {
    const day = new Date(t.resolutionTs * 1000).toISOString().slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnlUsdc);
  }

  const totalPnl = pnls.reduce((s, x) => s + x, 0);
  const totalNotional = accepted.reduce((s, t) => s + t.notionalUsdc, 0);
  const totalFees = accepted.reduce((s, t) => s + t.feeUsdc, 0);
  const wins = accepted.filter((t) => t.won).length;

  return {
    trades: accepted,
    marketsConsidered: markets.length,
    marketsEntered: new Set(accepted.map((t) => t.market)).size,
    totalPnlUsdc: totalPnl,
    totalNotionalUsdc: totalNotional,
    meanPnl: pnls.length > 0 ? totalPnl / pnls.length : 0,
    medianPnl: pick(0.5),
    p05: pick(0.05),
    p95: pick(0.95),
    winRate: pnls.length > 0 ? wins / pnls.length : 0,
    totalFeesUsdc: totalFees,
    dailyPnl
  };
}
