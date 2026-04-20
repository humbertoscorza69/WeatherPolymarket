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
  // Separate maps — SELLs must never be touched by cancelActiveBuys
  private readonly activeBuys = new Map<string, ActiveOrder>();  // keyed by conditionId
  private readonly activeSells = new Map<string, ActiveOrder>(); // keyed by conditionId

  constructor(
    events: WeatherEvent[],
    private readonly driver: Pick<ClobDriver, "placeQuote" | "cancelAll" | "cancelOrder" | "getOpenOrders">,
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
    this.activeBuys.clear();
    this.activeSells.clear();
    this.logger.info("cancelled open orders", { result });
  }

  async cancelActiveBuys(): Promise<void> {
    // Log every SELL order we are preserving — proof we are NOT touching them
    for (const [conditionId, order] of this.activeSells) {
      this.logger.error("[CANCEL-SKIP-SELL]", { conditionId, orderId: order.orderId, price: order.price });
    }

    const buyConditions = [...this.activeBuys.keys()];
    for (const conditionId of buyConditions) {
      const order = this.activeBuys.get(conditionId)!;
      this.logger.error("[CANCEL-CHECK]", { conditionId, side: order.side, orderId: order.orderId });
      try {
        await this.driver.cancelOrder(order.orderId);
        this.logger.error("[CANCEL-BUY]", { orderId: order.orderId, conditionId });
      } catch (err) {
        this.logger.error("[CANCEL-ERROR]", { orderId: order.orderId, error: String(err) });
      }
      this.activeBuys.delete(conditionId);
    }
    this.logger.info("cancelActiveBuys done", { cancelled: buyConditions.length, activeSells: this.activeSells.size });
  }

  /**
   * REST-based fill detection: query CLOB open orders and find any BUY
   * that disappeared without us cancelling it — that means it was filled
   * and the User WS missed the event.
   */
  async detectMissedFills(): Promise<void> {
    if (this.activeBuys.size === 0) return;

    let openOrders: Array<{ id: string }>;
    try {
      openOrders = (await this.driver.getOpenOrders()) as Array<{ id: string }>;
    } catch (err) {
      this.logger.error("[REST-DETECT-ERROR]", { error: String(err) });
      return;
    }

    const openIds = new Set(openOrders.map((o) => o.id));

    for (const [conditionId, buyOrder] of this.activeBuys) {
      if (openIds.has(buyOrder.orderId)) continue; // still resting, no fill

      const market = this.marketByConditionId.get(conditionId);
      if (!market) continue;
      if (this.inventory.hasPosition(conditionId)) continue; // WS already handled it

      this.logger.error("[FILL-DETECTED-REST]", {
        outcome: market.outcomeLabel,
        conditionId,
        orderId: buyOrder.orderId,
        price: buyOrder.price
      });

      const shares = Math.floor((this.config.orderSizeUsdc / buyOrder.price) * 10000) / 10000;
      const fillEvent: FillEvent = {
        conditionId,
        tokenId: market.yesTokenId,
        side: "BUY",
        price: buyOrder.price,
        shares
      };
      this.inventory.applyFill(fillEvent);
      this.activeBuys.delete(conditionId);

      await this.placeSellForFill(market, fillEvent);
    }
  }

  async placeBuyQuotes(quotes: QuoteIntent[]): Promise<PostOrderResult[]> {
    const results: PostOrderResult[] = [];
    for (const quote of quotes) {
      if (this.activeBuys.has(quote.conditionId)) {
        this.logger.debug("[SKIP-DUPLICATE] already have resting BUY", { conditionId: quote.conditionId });
        continue;
      }
      const result = await this.driver.placeQuote(quote, true);
      results.push(result);
      if (result.status === "live" && result.orderId) {
        this.activeBuys.set(quote.conditionId, {
          orderId: result.orderId,
          conditionId: quote.conditionId,
          side: "BUY",
          price: quote.price
        });
      }
    }
    return results;
  }

  async onUserFill(fill: UserFill): Promise<void> {
    this.logger.error("[FILL-RECEIVED]", {
      side: fill.side,
      assetId: fill.assetId,
      price: fill.price,
      shares: fill.shares,
      traderSide: fill.traderSide
    });

    const market = this.marketByAssetId.get(fill.assetId);
    if (!market) {
      this.logger.error("[FILL-ERROR] cannot find market for asset", { assetId: fill.assetId });
      return;
    }

    this.logger.error("[FILL-MARKET]", { outcome: market.outcomeLabel, conditionId: market.conditionId });

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
      this.activeBuys.delete(market.conditionId);
      this.logger.error("[FILL-BUY] BUY filled, removed from activeBuys, placing SELL now", {
        outcome: market.outcomeLabel
      });
      await this.placeSellForFill(market, normalized);
    }
  }

  async onOrderUpdate(update: UserOrderUpdate): Promise<void> {
    const side = update.side;
    if (!side || update.sizeMatched !== 0) return;
    const market = update.assetId ? this.marketByAssetId.get(update.assetId) : undefined;
    if (!market) return;
    if (update.type !== "CANCELLATION" && update.status !== "CANCELLED") return;

    if (side === "BUY") {
      this.activeBuys.delete(market.conditionId);
    } else if (side === "SELL") {
      this.activeSells.delete(market.conditionId);
      // SELL was cancelled externally — re-queue it if we still hold the position
      if (this.inventory.hasPosition(market.conditionId)) {
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
          this.logger.error("[SELL-REQUEUE]", { outcome: market.outcomeLabel, price: retry.price });
          await this.placeSellForFill(market, retryFill);
        }
      }
    }
  }

  private async placeSellForFill(market: WeatherMarket, fill: FillEvent): Promise<void> {
    const sell = buildSellOnFill(fill, this.config.halfSpreadCents);
    if (!sell) {
      this.logger.error("[SELL-SKIP] buildSellOnFill returned null — price too high?", {
        outcome: market.outcomeLabel,
        entryPrice: fill.price
      });
      return;
    }
    sell.eventId = "fill";
    sell.city = "unknown";
    sell.date = "unknown";
    sell.outcomeLabel = market.outcomeLabel;
    const exitPrice = fill.price + (this.config.halfSpreadCents * 2) / 100;
    this.logger.error("[SELL-COMPUTING]", {
      outcome: market.outcomeLabel,
      entry: fill.price,
      fullSpread: (this.config.halfSpreadCents * 2) / 100,
      exit: exitPrice,
      price: sell.price,
      shares: sell.shares
    });
    const result = await this.driver.placeQuote(sell, true);
    this.logger.error("[SELL-RESULT]", {
      outcome: market.outcomeLabel,
      success: result.success,
      status: result.status,
      orderId: result.orderId,
      errorMsg: result.errorMsg,
      raw: result.raw
    });
    if (result.status === "live" && result.orderId) {
      this.activeSells.set(market.conditionId, {
        orderId: result.orderId,
        conditionId: market.conditionId,
        side: "SELL",
        price: sell.price
      });
      this.logger.error("[SELL-PLACED]", { outcome: market.outcomeLabel, orderId: result.orderId, price: sell.price });
    }
  }
}
