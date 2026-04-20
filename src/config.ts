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
  maxForecastDivergence: number;
  enableFairValueCap: boolean;
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
    maxForecastDivergence: envNum("MAX_FORECAST_DIVERGENCE", 0.15),
    // Default OFF: pure market making captures spread + rebates regardless
    // of the bot's own forecast. Turn ON if you want the fair-value safety
    // guard that skips outcomes where market mid exceeds our fair estimate.
    enableFairValueCap: envBool("ENABLE_FAIR_VALUE_CAP", false),
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
