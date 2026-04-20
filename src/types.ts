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
  temperatureC: number;
  yesTokenId: string;
  noTokenId: string;
  volume24hr: number;
  enableOrderBook: boolean;
  closed: boolean;
  resolved: boolean;
  bestBid?: number;
  bestAsk?: number;
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
  size: number;
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
