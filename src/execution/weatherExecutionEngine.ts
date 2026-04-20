import { InventoryEngine } from "../core/inventoryEngine.js";
import { buildSellOnFill, PositionSnapshot } from "../core/multiMarketQuoter.js";
import { Config } from "../config.js";
import { Logger } from "../logger.js";
import { FillEvent, QuoteIntent, WeatherEvent, WeatherMarket } from "../types.js";
import { ClobDriver, PostOrderResult } from "./clobDriver.js";
import { UserFill, UserOrderUpdate } from "./userWebSocket.js";

interface ActiveOrder {
  orderId: string;
  conditionId: string;
  side: "BUY" | "SELL";
  price: number;
}

export class WeatherExecutionEngine {
  private readonly marketByAssetId = new Map<string, WeatherMarket>();
  private readonly marketByConditionId = new Map<string, WeatherMarket>();
  private readonly activeOrders = new Map<string, ActiveOrder>();

  constructor(
    events: WeatherEvent[],
    private readonly driver: Pick<ClobDriver, "placeQuote" | "cancelAll" | "cancelOrder">,
    private readonly inventory: InventoryEngine,
    private readonly config: Config,
    private readonly logger = new Logger("weather-execution")
  ) {
    for (const event of events) {
      for (const market of event.markets) {
        this.marketByAssetId.set(market.yesTokenId, market);
        this.marketByAssetId.set(market.noTokenId, market);
        this.marketByConditionId.set(market.conditionId, market);
      }
    }
  }

  conditionIds(): string[] {
    return [...this.marketByConditionId.keys()];
  }

  getPositionSnapshots(): PositionSnapshot[] {
    return [...this.marketByConditionId.keys()].map((conditionId) => ({
      conditionId,
      exposureUsdc: this.inventory.hasPosition(conditionId) ? 1 : 0
    }));
  }

  async startupCleanup(): Promise<void> {
    const result = await this.driver.cancelAll();
    this.activeOrders.clear();
    this.logger.info("cancelled open orders", { result });
  }

  async cancelActiveBuys(): Promise<void> {
    const buyEntries = [...this.activeOrders.entries()].filter(([, o]) => o.side === "BUY");
    for (const [key, order] of buyEntries) {
      try {
        await this.driver.cancelOrder(order.orderId);
      } catch {
        // order may already be filled or cancelled
      }
      this.activeOrders.delete(key);
    }
    this.logger.info("cancelled active BUY orders", { count: buyEntries.length });
  }

  async placeBuyQuotes(quotes: QuoteIntent[]): Promise<PostOrderResult[]> {
    const results: PostOrderResult[] = [];
    for (const quote of quotes) {
      const key = orderKey(quote.conditionId, quote.side);
      if (this.activeOrders.has(key)) {
        this.logger.debug("[SKIP-DUPLICATE] already have resting order", {
          conditionId: quote.conditionId,
          side: quote.side
        });
        continue;
      }
      const result = await this.driver.placeQuote(quote, true);
      results.push(result);
      if (result.status === "live" && result.orderId) {
        this.activeOrders.set(key, {
          orderId: result.orderId,
          conditionId: quote.conditionId,
          side: quote.side,
          price: quote.price
        });
      }
    }
    return results;
  }

  async onUserFill(fill: UserFill): Promise<void> {
    const market = this.marketByAssetId.get(fill.assetId);
    if (!market) return;

    this.logger.info("[FILL]", {
      outcome: market.outcomeLabel,
      side: fill.side,
      price: fill.price,
      shares: fill.shares,
      traderSide: fill.traderSide
    });

    if (fill.traderSide === "TAKER") {
      this.logger.error("[TAKER-CRITICAL]", { conditionId: market.conditionId, outcome: market.outcomeLabel });
    }

    const normalized: FillEvent = {
      conditionId: market.conditionId,
      tokenId: fill.assetId,
      side: fill.side,
      price: fill.price,
      shares: fill.shares
    };
    this.inventory.applyFill(normalized);

    if (fill.side === "BUY") {
      // Remove filled BUY from tracking so cancelActiveBuys won't try to cancel it
      this.activeOrders.delete(orderKey(market.conditionId, "BUY"));

      const sell = buildSellOnFill(normalized, this.config.halfSpreadCents);
      if (!sell) return;
      sell.eventId = "fill";
      sell.city = "unknown";
      sell.date = "unknown";
      sell.outcomeLabel = market.outcomeLabel;
      this.logger.info("[SELL-ATTEMPT]", { outcome: market.outcomeLabel, price: sell.price, shares: sell.shares });
      const result = await this.driver.placeQuote(sell, true);
      this.logger.info("[SELL-RESULT]", { outcome: market.outcomeLabel, status: result.status, orderId: result.orderId, errorMsg: result.errorMsg });
      if (result.status === "live" && result.orderId) {
        this.activeOrders.set(orderKey(market.conditionId, "SELL"), {
          orderId: result.orderId,
          conditionId: market.conditionId,
          side: "SELL",
          price: sell.price
        });
      }
    }
  }

  async onOrderUpdate(update: UserOrderUpdate): Promise<void> {
    const side = update.side;
    if (!side || update.sizeMatched !== 0) return;
    const market = update.assetId ? this.marketByAssetId.get(update.assetId) : undefined;
    if (!market) return;
    if (update.type !== "CANCELLATION" && update.status !== "CANCELLED") return;
    this.activeOrders.delete(orderKey(market.conditionId, side));
    if (side === "SELL" && this.inventory.hasPosition(market.conditionId)) {
      const position = this.inventory.getPosition(market.conditionId);
      const retryFill: FillEvent = {
        conditionId: market.conditionId,
        tokenId: market.yesTokenId,
        side: "BUY",
        price: position.avgEntryPrice,
        shares: position.shares
      };
      const retry = buildSellOnFill(retryFill, this.config.halfSpreadCents);
      if (retry) {
        retry.outcomeLabel = market.outcomeLabel;
        await this.driver.placeQuote(retry, true);
      }
    }
  }
}

function orderKey(conditionId: string, side: "BUY" | "SELL"): string {
  return `${conditionId}:${side}`;
}
