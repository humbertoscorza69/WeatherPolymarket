export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBookSnapshot {
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  tick_size?: string;
  neg_risk?: boolean;
}

export interface BookTop {
  bestBid?: number;
  bestAsk?: number;
  tickSize?: string;
  negRisk?: boolean;
}

export async function fetchOrderBookTop(
  tokenId: string,
  host = "https://clob.polymarket.com",
  fetchImpl: typeof fetch = fetch
): Promise<BookTop> {
  const url = `${host}/book?token_id=${encodeURIComponent(tokenId)}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`CLOB book fetch failed for ${tokenId}: ${response.status} ${response.statusText}`);
  }
  const book = (await response.json()) as OrderBookSnapshot;
  return {
    bestBid: maxPrice(book.bids),
    bestAsk: minPrice(book.asks),
    tickSize: book.tick_size,
    negRisk: book.neg_risk
  };
}

function maxPrice(levels: OrderBookLevel[] = []): number | undefined {
  const prices = levels.map((level) => Number(level.price)).filter(Number.isFinite);
  return prices.length > 0 ? Math.max(...prices) : undefined;
}

function minPrice(levels: OrderBookLevel[] = []): number | undefined {
  const prices = levels.map((level) => Number(level.price)).filter(Number.isFinite);
  return prices.length > 0 ? Math.min(...prices) : undefined;
}
