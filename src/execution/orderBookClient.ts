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

export interface BookLevel {
  price: number;
  size: number;
}

export interface BookTop {
  bestBid?: number;
  bestAsk?: number;
  tickSize?: string;
  negRisk?: boolean;
  /** Full L2 depth (all resting price levels), bids sorted high→low, asks low→high. */
  bids?: BookLevel[];
  asks?: BookLevel[];
  /** Total size resting on each side. Useful for inventory/fill-prob metrics. */
  bidDepth?: number;
  askDepth?: number;
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
  const bids = normalizeLevels(book.bids).sort((a, b) => b.price - a.price);
  const asks = normalizeLevels(book.asks).sort((a, b) => a.price - b.price);
  return {
    bestBid: bids[0]?.price,
    bestAsk: asks[0]?.price,
    tickSize: book.tick_size,
    negRisk: book.neg_risk,
    bids,
    asks,
    bidDepth: bids.reduce((sum, lvl) => sum + lvl.size, 0),
    askDepth: asks.reduce((sum, lvl) => sum + lvl.size, 0)
  };
}

/**
 * Depth (in shares) resting AT OR BETTER THAN a given price on a given side.
 * For BUY side: sum of sizes at levels ≥ price (because a better bid is higher).
 * For SELL side: sum of sizes at levels ≤ price (better ask is lower).
 *
 * This is the "queue ahead of you" estimate when you place your order at `price`:
 * you sit behind all of that size in the match queue. Used for fill-probability
 * approximations without needing a full market-WS stream.
 */
export function depthAhead(book: BookTop, side: "BUY" | "SELL", price: number): number {
  if (side === "BUY" && book.bids) {
    return book.bids.filter((lvl) => lvl.price >= price).reduce((s, lvl) => s + lvl.size, 0);
  }
  if (side === "SELL" && book.asks) {
    return book.asks.filter((lvl) => lvl.price <= price).reduce((s, lvl) => s + lvl.size, 0);
  }
  return 0;
}

function normalizeLevels(levels: OrderBookLevel[] = []): BookLevel[] {
  return levels
    .map((lvl) => ({ price: Number(lvl.price), size: Number(lvl.size) }))
    .filter((lvl) => Number.isFinite(lvl.price) && Number.isFinite(lvl.size) && lvl.size > 0);
}
