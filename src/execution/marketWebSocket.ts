import WebSocket from "ws";
import type { BookTop } from "./orderBookClient.js";

/**
 * Polymarket market-data WebSocket client.
 *
 * Stream:     wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Subscribe:  { type: "subscribe", channel: "market", markets: [asset_id, ...] }
 *
 * Message shapes (observed):
 *
 *   book snapshot           event_type="book"   bids[], asks[]
 *   price change (L2 delta) event_type="price_change"  price_changes: [{price, size, side}]
 *   tick size change        event_type="tick_size_change"
 *   last trade (info)       event_type="last_trade_price"
 *
 * The client maintains a local mirror of every subscribed book so consumers
 * don't have to re-parse every delta. Call `book(assetId)` to get the
 * current best-bid / best-ask / depth snapshot synchronously.
 */

export interface MarketWsAuth {
  apiKey?: string;
  secret?: string;
  passphrase?: string;
}

export interface MarketWsHandlers {
  onBook?(assetId: string, book: BookTop): void;
  onError?(error: Error): void;
  onOpen?(assetIds: string[]): void;
  onClose?(code: number, reason: string): void;
}

export interface MarketWebSocketOptions {
  assetIds: string[];
  handlers: MarketWsHandlers;
  auth?: MarketWsAuth;
  url?: string;
  WebSocketCtor?: typeof WebSocket;
}

interface BookSide {
  price: number;
  size: number;
}

/**
 * In-memory L2 mirror: maps price → size per side. Deltas with size=0
 * remove the level. Price keys are strings (the exchange sends them as
 * strings) to avoid float precision problems.
 */
export class LocalBook {
  private bids = new Map<string, number>();
  private asks = new Map<string, number>();
  private tickSize?: string;

  applySnapshot(payload: {
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
    tick_size?: string;
  }): void {
    this.bids.clear();
    this.asks.clear();
    for (const lvl of payload.bids ?? []) this.setLevel("bid", lvl.price, lvl.size);
    for (const lvl of payload.asks ?? []) this.setLevel("ask", lvl.price, lvl.size);
    if (payload.tick_size) this.tickSize = payload.tick_size;
  }

  applyDelta(changes: Array<{ price: string; size: string; side: string }>): void {
    for (const c of changes) {
      const side = c.side.toUpperCase() === "BUY" || c.side.toUpperCase() === "BID" ? "bid" : "ask";
      this.setLevel(side, c.price, c.size);
    }
  }

  setTickSize(tick: string): void {
    this.tickSize = tick;
  }

  /** Return a sorted snapshot of the current book. */
  snapshot(): BookTop {
    const bids = this.sortedLevels(this.bids, true);
    const asks = this.sortedLevels(this.asks, false);
    return {
      bestBid: bids[0]?.price,
      bestAsk: asks[0]?.price,
      tickSize: this.tickSize,
      bids,
      asks,
      bidDepth: bids.reduce((s, lvl) => s + lvl.size, 0),
      askDepth: asks.reduce((s, lvl) => s + lvl.size, 0)
    };
  }

  private setLevel(side: "bid" | "ask", price: string, sizeStr: string): void {
    const size = Number(sizeStr);
    const map = side === "bid" ? this.bids : this.asks;
    if (!Number.isFinite(size) || size <= 0) {
      map.delete(price);
    } else {
      map.set(price, size);
    }
  }

  private sortedLevels(map: Map<string, number>, descending: boolean): BookSide[] {
    const entries = [...map.entries()]
      .map(([price, size]) => ({ price: Number(price), size }))
      .filter((l) => Number.isFinite(l.price) && l.size > 0);
    entries.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
    return entries;
  }
}

export class MarketWebSocket {
  private ws?: WebSocket;
  private readonly url: string;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly books = new Map<string, LocalBook>();
  private reconnectAttempts = 0;
  private shouldReconnect = true;

  constructor(private readonly options: MarketWebSocketOptions) {
    this.url = options.url ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    this.WebSocketCtor = options.WebSocketCtor ?? WebSocket;
    for (const id of options.assetIds) this.books.set(id, new LocalBook());
  }

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  close(): void {
    this.shouldReconnect = false;
    this.ws?.close();
  }

  /** Synchronous book snapshot for a given asset. Undefined if not subscribed. */
  book(assetId: string): BookTop | undefined {
    return this.books.get(assetId)?.snapshot();
  }

  private openSocket(): void {
    const ws = new this.WebSocketCtor(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.reconnectAttempts = 0;
      const subscribe: Record<string, unknown> = {
        type: "subscribe",
        channel: "market",
        markets: this.options.assetIds
      };
      if (this.options.auth) subscribe.auth = this.options.auth;
      ws.send(JSON.stringify(subscribe));
      this.options.handlers.onOpen?.(this.options.assetIds);
    });
    ws.on("message", (raw) => {
      try {
        this.handleMessage(raw.toString());
      } catch (err) {
        this.options.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on("error", (err) => {
      this.options.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf?.toString?.() ?? "";
      this.options.handlers.onClose?.(code, reason);
      if (this.shouldReconnect) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    // Exponential backoff, capped at 30s
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempts, 6));
    setTimeout(() => {
      if (this.shouldReconnect) this.openSocket();
    }, delayMs);
  }

  /** Parse one WS message and dispatch. Exposed for unit testing. */
  handleMessage(raw: string): void {
    // Exchange sometimes sends "PONG" or bare heartbeats; ignore those.
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
    const parsed = JSON.parse(trimmed) as unknown;
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const ev of events) {
      this.dispatchEvent(ev as Record<string, unknown>);
    }
  }

  private dispatchEvent(ev: Record<string, unknown>): void {
    const assetId = typeof ev.asset_id === "string" ? ev.asset_id : undefined;
    if (!assetId) return;
    const book = this.books.get(assetId);
    if (!book) return;
    const type = String(ev.event_type ?? ev.type ?? "").toLowerCase();
    if (type === "book" || type === "book_update") {
      book.applySnapshot({
        bids: ev.bids as Array<{ price: string; size: string }>,
        asks: ev.asks as Array<{ price: string; size: string }>,
        tick_size: typeof ev.tick_size === "string" ? ev.tick_size : undefined
      });
    } else if (type === "price_change") {
      const changes = ev.price_changes as Array<{ price: string; size: string; side: string }>;
      if (Array.isArray(changes)) book.applyDelta(changes);
    } else if (type === "tick_size_change") {
      if (typeof ev.new_tick_size === "string") book.setTickSize(ev.new_tick_size);
    }
    this.options.handlers.onBook?.(assetId, book.snapshot());
  }
}
