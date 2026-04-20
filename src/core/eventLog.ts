import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type EventType =
  | "STARTUP"
  | "DISCOVERY"
  | "FORECAST"
  | "BOOK"
  | "QUOTE_BUILT"
  | "QUOTE_SKIPPED"
  | "BUY_PLACED"
  | "BUY_REJECTED"
  | "BUY_CANCELLED"
  | "BUY_FILLED"
  | "SELL_PLACED"
  | "SELL_REJECTED"
  | "SELL_CANCELLED"
  | "SELL_FILLED"
  | "SELL_REQUEUED"
  | "ROUND_TRIP"
  | "POSITION_LOADED"
  | "POSITION_SNAPSHOT"
  | "REFRESH"
  | "TAKER_CRITICAL"
  | "ERROR";

export interface EventRecord {
  ts: string;
  type: EventType;
  city?: string;
  outcome?: string;
  conditionId?: string;
  orderId?: string;
  side?: "BUY" | "SELL";
  price?: number;
  shares?: number;
  sizeUsdc?: number;
  profitUsdc?: number;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Structured event log for the weather market maker.
 *
 * - Appends every event as a single JSON line to a file (so you can `tail -f`
 *   it and paste chunks back to the developer).
 * - Keeps an in-memory ring buffer of the last N events for the dashboard.
 * - Tracks aggregate metrics (realized P&L, round-trip count, win rate,
 *   reject counters) so the dashboard can render them without reparsing.
 */
export class EventLog {
  private readonly buffer: EventRecord[] = [];
  private readonly bufferLimit: number;
  private readonly filePath?: string;
  private realizedPnlUsdc = 0;
  private roundTrips = 0;
  private winningRoundTrips = 0;
  private buysPlaced = 0;
  private sellsPlaced = 0;
  private buyRejects = 0;
  private sellRejects = 0;
  private takerFills = 0;

  constructor(options: { filePath?: string; bufferLimit?: number } = {}) {
    this.filePath = options.filePath;
    this.bufferLimit = options.bufferLimit ?? 500;
  }

  record(event: Omit<EventRecord, "ts"> & { ts?: string }): EventRecord {
    const full: EventRecord = { ts: event.ts ?? new Date().toISOString(), ...event };
    this.buffer.push(full);
    if (this.buffer.length > this.bufferLimit) this.buffer.shift();
    this.updateMetrics(full);
    this.appendToFile(full);
    return full;
  }

  private updateMetrics(event: EventRecord): void {
    switch (event.type) {
      case "BUY_PLACED":
        this.buysPlaced += 1;
        break;
      case "SELL_PLACED":
        this.sellsPlaced += 1;
        break;
      case "BUY_REJECTED":
        this.buyRejects += 1;
        break;
      case "SELL_REJECTED":
        this.sellRejects += 1;
        break;
      case "ROUND_TRIP":
        this.roundTrips += 1;
        if ((event.profitUsdc ?? 0) > 0) this.winningRoundTrips += 1;
        this.realizedPnlUsdc += event.profitUsdc ?? 0;
        break;
      case "TAKER_CRITICAL":
        this.takerFills += 1;
        break;
    }
  }

  private appendToFile(event: EventRecord): void {
    if (!this.filePath) return;
    const line = JSON.stringify(event) + "\n";
    const target = this.filePath;
    void (async () => {
      try {
        await mkdir(dirname(target), { recursive: true });
        await appendFile(target, line, "utf-8");
      } catch {
        // swallow — event log is best-effort
      }
    })();
  }

  recent(limit = 100): EventRecord[] {
    if (limit >= this.buffer.length) return [...this.buffer];
    return this.buffer.slice(this.buffer.length - limit);
  }

  metrics() {
    return {
      realizedPnlUsdc: Number(this.realizedPnlUsdc.toFixed(4)),
      roundTrips: this.roundTrips,
      winRate: this.roundTrips > 0 ? this.winningRoundTrips / this.roundTrips : 0,
      buysPlaced: this.buysPlaced,
      sellsPlaced: this.sellsPlaced,
      buyRejects: this.buyRejects,
      sellRejects: this.sellRejects,
      takerFills: this.takerFills
    };
  }
}
