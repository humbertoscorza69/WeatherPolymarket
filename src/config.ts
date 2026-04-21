export interface Config {
  mode: "live" | "paper" | "replay";
  liveApiEnabled: boolean;
  dryRunLive: boolean;
  maxEvents: number;
  maxOutcomesPerEvent: number;
  minMarketVolumeUsdc: number;
  weatherApi: "open-meteo";
  weatherUncertaintyC: number;
  halfSpreadCents: number;
  /** Override: half-spread in TICKS rather than cents. When > 0 takes precedence
   *  over halfSpreadCents. On 0.001-tick markets, 1 tick = 0.1¢, so halfSpreadCents=1
   *  is 10× too wide. Quoting in ticks scales naturally across markets. */
  halfSpreadTicks: number;
  maxForecastDivergence: number;
  /** Outcome-level price filter. Skip outcomes whose mid is outside this band.
   *  Tail-extreme outcomes have either 1-tick spreads (no profit) or
   *  share-count constraints we can't satisfy. */
  minOutcomeMid: number;
  maxOutcomeMid: number;
  enableFairValueCap: boolean;
  inventorySkewCents: number;
  /** Base TP ticks above entry. Default 1 = current "entry + 1 tick" behavior. */
  tpTicksBase: number;
  /** Volatility-adjusted TP: tp_ticks = base + floor(multiplier × realized_vol_cents / tick_cents).
   *  0 disables. Positive values widen TP in volatile markets, keep it tight in calm ones. */
  tpVolMultiplier: number;
  /** Hard cap on TP ticks to prevent infinite-wait SELLs. */
  tpTicksMax: number;
  volWindowSize: number;
  volMultiplier: number;
  volMaxExtraCents: number;
  stopLossEnabled: boolean;
  stopLossCatastrophicDropRatio: number;
  stopLossDeepDropRatio: number;
  stopLossDeepDropMaxMinutes: number;
  stopLossResolutionHours: number;
  stopLossResolutionDropRatio: number;
  stopLossMaxHoldingHours: number;
  stopLossMakerExitWaitSeconds: number;
  orderSizeUsdc: number;
  clobMinShares: number;
  maxSharesPerMarket: number;
  maxPositionPerMarketUsdc: number;
  maxTotalExposureUsdc: number;
  tickSize: number;
  refreshIntervalMs: number;
  orderPostOnly: true;
  dataDir: string;
  clobHost: string;
  polymarketPrivateKey?: string;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketApiPassphrase?: string;
  polymarketFunderAddress?: string;
  polymarketSignatureType: number;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

export function loadConfig(): Config {
  const mode = (process.env.MODE ?? "live") as Config["mode"];
  if (!["live", "paper", "replay"].includes(mode)) {
    throw new Error("MODE must be live, paper, or replay");
  }

  const config: Config = {
    mode,
    liveApiEnabled: envBool("LIVE_API_ENABLED", false),
    dryRunLive: envBool("DRY_RUN_LIVE", true),
    maxEvents: envNum("MAX_EVENTS", 1),
    maxOutcomesPerEvent: envNum("MAX_OUTCOMES_PER_EVENT", 12),
    minMarketVolumeUsdc: envNum("MIN_MARKET_VOLUME_USDC", 0),
    weatherApi: "open-meteo",
    weatherUncertaintyC: envNum("WEATHER_UNCERTAINTY_C", 1.5),
    halfSpreadCents: envNum("HALF_SPREAD_CENTS", 1),
    // 0 disables; if > 0 the quoter uses halfSpread = N × market tickSize
    // instead of halfSpreadCents/100. This is the right default for
    // multi-tick-size environments (Polymarket has 0.001 and 0.01 markets).
    halfSpreadTicks: envNum("HALF_SPREAD_TICKS", 1),
    maxForecastDivergence: envNum("MAX_FORECAST_DIVERGENCE", 0.15),
    // Outcome filter band. Default 0.05..0.95 excludes both tails. Tail
    // outcomes typically have 1-tick spreads and very thin opposing books;
    // there's no spread for us to capture there.
    minOutcomeMid: envNum("MIN_OUTCOME_MID", 0.05),
    maxOutcomeMid: envNum("MAX_OUTCOME_MID", 0.95),
    // Default OFF: pure market making captures spread + rebates regardless
    // of the bot's own forecast. Turn ON if you want the fair-value safety
    // guard that skips outcomes where market mid exceeds our fair estimate.
    enableFairValueCap: envBool("ENABLE_FAIR_VALUE_CAP", false),
    // Widen the BUY spread as inventory grows. At full utilization the
    // effective halfSpread = halfSpreadCents + inventorySkewCents.
    inventorySkewCents: envNum("INVENTORY_SKEW_CENTS", 2),
    // Take-profit ticks above entry. Default 1 = "lock in one tick" (MM classic).
    // Set TP_VOL_MULTIPLIER > 0 to let the TP scale up in volatile markets.
    // tp_ticks = TP_TICKS_BASE + floor(TP_VOL_MULTIPLIER × stddev_cents / tick_cents)
    //          clamped to TP_TICKS_MAX.
    // Warning: wider TP = slower fill = more capital held = more stop-loss risk.
    tpTicksBase: envNum("TP_TICKS_BASE", 1),
    tpVolMultiplier: envNum("TP_VOL_MULTIPLIER", 0),
    tpTicksMax: envNum("TP_TICKS_MAX", 5),
    // Realized-volatility-aware spread widening (Avellaneda-Stoikov light).
    // MC sweep over 5000 episodes × 9 variants showed VOL_MULTIPLIER=1.0 gives
    // the best mixed-vs-adverse trade-off (Sharpe 0.314 in adverse, on par
    // with tighter variants in calm). See docs/MARKET_MAKING.md §5.
    volWindowSize: envNum("VOL_WINDOW_SIZE", 60),
    volMultiplier: envNum("VOL_MULTIPLIER", 1.0),
    volMaxExtraCents: envNum("VOL_MAX_EXTRA_CENTS", 3),
    // Stop-loss system. Closes a position via hybrid ladder (maker-then-taker
    // for patient rules, immediate taker for urgent rules).
    stopLossEnabled: envBool("STOP_LOSS_ENABLED", true),
    stopLossCatastrophicDropRatio: envNum("STOP_LOSS_CATASTROPHIC_DROP", 0.3),
    stopLossDeepDropRatio: envNum("STOP_LOSS_DEEP_DROP", 0.6),
    stopLossDeepDropMaxMinutes: envNum("STOP_LOSS_DEEP_DROP_MINUTES", 120),
    stopLossResolutionHours: envNum("STOP_LOSS_RESOLUTION_HOURS", 1),
    stopLossResolutionDropRatio: envNum("STOP_LOSS_RESOLUTION_DROP", 0.7),
    stopLossMaxHoldingHours: envNum("STOP_LOSS_MAX_HOLDING_HOURS", 12),
    stopLossMakerExitWaitSeconds: envNum("STOP_LOSS_MAKER_EXIT_WAIT_SECONDS", 90),
    orderSizeUsdc: envNum("ORDER_SIZE_USDC", 2),
    clobMinShares: envNum("CLOB_MIN_SHARES", 5),
    maxSharesPerMarket: envNum("MAX_SHARES_PER_MARKET", 5),
    maxPositionPerMarketUsdc: envNum("MAX_POSITION_PER_MARKET_USDC", 3),
    maxTotalExposureUsdc: envNum("MAX_TOTAL_EXPOSURE_USDC", 15),
    tickSize: envNum("TICK_SIZE", 0.01),
    refreshIntervalMs: envNum("REFRESH_INTERVAL_MS", 30_000),
    orderPostOnly: true,
    dataDir: process.env.DATA_DIR ?? "data",
    clobHost: process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com",
    polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY,
    polymarketApiKey: process.env.POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
    polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    polymarketFunderAddress: process.env.POLYMARKET_FUNDER_ADDRESS,
    polymarketSignatureType: envNum("POLYMARKET_SIGNATURE_TYPE", 1)
  };

  if (config.liveApiEnabled && !config.dryRunLive) {
    for (const name of [
      "POLYMARKET_PRIVATE_KEY",
      "POLYMARKET_API_KEY",
      "POLYMARKET_API_SECRET",
      "POLYMARKET_API_PASSPHRASE",
      "POLYMARKET_FUNDER_ADDRESS"
    ]) {
      if (!process.env[name]) throw new Error(`${name} is required when real live trading is enabled`);
    }
  }

  return config;
}
