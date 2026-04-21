export type Side = "BUY" | "SELL";

export interface WeatherEvent {
  id: string;
  title: string;
  slug?: string;
  city: string;
  date: string;
  markets: WeatherMarket[];
}

export interface WeatherMarket {
  conditionId: string;
  question: string;
  outcomeLabel: string;
  /** Bin centre in Celsius. For range buckets like "32-33°F", the midpoint converted to °C. */
  temperatureC: number;
  /** Bin width in Celsius. 1°C default; ~1.1°C for 2°F range markets; set by discovery. */
  binWidthC?: number;
  /** True if this outcome is the open-ended "X or below" bucket. */
  isLowTail?: boolean;
  /** True if this outcome is the open-ended "X or higher" bucket. */
  isHighTail?: boolean;
  /** Temperature unit inferred from the outcome label ("F" or "C"). Used only for logging. */
  rawUnit?: "F" | "C";
  yesTokenId: string;
  noTokenId: string;
  volume24hr: number;
  enableOrderBook: boolean;
  closed: boolean;
  resolved: boolean;
  bestBid?: number;
  bestAsk?: number;
  tickSize?: number;
}

export interface Forecast {
  city: string;
  date: string;
  temperatureMaxC: number;
  source: string;
}

export interface QuoteIntent {
  eventId: string;
  city: string;
  date: string;
  conditionId: string;
  tokenId: string;
  outcomeLabel: string;
  side: Side;
  price: number;
  sizeUsdc: number;
  shares: number;
  postOnly: true;
  reason: string;
}

export interface FillEvent {
  conditionId: string;
  tokenId: string;
  side: Side;
  price: number;
  shares: number;
}
