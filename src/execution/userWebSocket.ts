import WebSocket from "ws";
import { Side } from "../types.js";

export interface UserWsAuth {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface UserFill {
  assetId: string;
  side: Side;
  price: number;
  shares: number;
  traderSide?: "MAKER" | "TAKER" | string;
  orderId?: string;
}

export interface UserOrderUpdate {
  assetId?: string;
  orderId?: string;
  side?: Side;
  type?: string;
  status?: string;
  sizeMatched: number;
}

export interface UserWebSocketHandlers {
  onFill(fill: UserFill): void | Promise<void>;
  onOrderUpdate(update: UserOrderUpdate): void | Promise<void>;
  onError?(error: Error): void;
  onOpen?(): void;
}

export interface UserWebSocketOptions {
  auth: UserWsAuth;
  conditionIds: string[];
  handlers: UserWebSocketHandlers;
  url?: string;
  WebSocketCtor?: typeof WebSocket;
}

export class UserWebSocket {
  private ws?: WebSocket;
  private readonly url: string;
  private readonly WebSocketCtor: typeof WebSocket;

  constructor(private readonly options: UserWebSocketOptions) {
    this.url = options.url ?? "wss://ws-subscriptions-clob.polymarket.com/ws/user";
    this.WebSocketCtor = options.WebSocketCtor ?? WebSocket;
  }

  connect(): void {
    this.ws = new this.WebSocketCtor(this.url);
    this.ws.on("open", () => {
      this.ws?.send(
        JSON.stringify({
          type: "subscribe",
          channel: "user",
          auth: this.options.auth,
          markets: this.options.conditionIds
        })
      );
      this.options.handlers.onOpen?.();
    });
    this.ws.on("message", (data) => {
      void this.handleMessage(data.toString());
    });
    this.ws.on("error", (error) => {
      this.options.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  close(): void {
    this.ws?.close();
  }

  async handleMessage(raw: string): Promise<void> {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Log every raw message so we can see what the exchange actually sends
    process.stderr.write(
      `[USER-WS-RAW] type=${String(parsed.event_type ?? parsed.type ?? "?")} asset=${String(parsed.asset_id ?? "?")} side=${String(parsed.side ?? "?")} size=${String(parsed.size ?? parsed.matched_size ?? "?")}\n`
    );
    const fill = normalizeFillMessage(parsed);
    if (fill) {
      await this.options.handlers.onFill(fill);
      return;
    }
    const update = normalizeOrderUpdate(parsed);
    if (update) {
      await this.options.handlers.onOrderUpdate(update);
    }
  }
}

export function normalizeFillMessage(msg: Record<string, unknown>): UserFill | null {
  const eventType = String(msg.event_type ?? msg.type ?? "");
  if (eventType !== "TRADE" && eventType !== "FILL") return null;
  const assetId = String(msg.asset_id ?? msg.assetId ?? "");
  const side = normalizeSide(msg.side);
  const price = Number(msg.price);
  const shares = Number(msg.size ?? msg.matched_size ?? msg.shares);
  if (!assetId || !side || !Number.isFinite(price) || !Number.isFinite(shares)) return null;
  return {
    assetId,
    side,
    price,
    shares,
    traderSide: typeof msg.trader_side === "string" ? msg.trader_side : undefined,
    orderId: typeof msg.order_id === "string" ? msg.order_id : undefined
  };
}

export function normalizeOrderUpdate(msg: Record<string, unknown>): UserOrderUpdate | null {
  const eventType = String(msg.event_type ?? msg.type ?? "");
  if (eventType !== "ORDER_UPDATE") return null;
  return {
    assetId: typeof msg.asset_id === "string" ? msg.asset_id : undefined,
    orderId: typeof msg.order_id === "string" ? msg.order_id : undefined,
    side: normalizeSide(msg.side),
    type: typeof msg.update_type === "string" ? msg.update_type : typeof msg.status === "string" ? msg.status : undefined,
    status: typeof msg.status === "string" ? msg.status : undefined,
    sizeMatched: Number(msg.size_matched ?? msg.sizeMatched ?? 0)
  };
}

function normalizeSide(value: unknown): Side | undefined {
  const side = String(value ?? "").toUpperCase();
  if (side === "BUY" || side === "SELL") return side;
  return undefined;
}
