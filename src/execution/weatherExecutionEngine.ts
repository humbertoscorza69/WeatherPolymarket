import { InventoryEngine } from "../core/inventoryEngine.js";
import { buildSellOnFill, PositionSnapshot } from "../core/multiMarketQuoter.js";
import { Config } from "../config.js";
import { Logger } from "../logger.js";
import { FillEvent, QuoteIntent, WeatherEvent, WeatherMarket } from "../types.js";
import { ClobDriver, PostOrderResult } from "./clobDriver.js";
import { UserFill, UserOrderUpdate } from "./userWebSocket.js";
import { fetchOrderBookTop } from "./orderBookClient.js";

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
    private readonly driver: Pick<ClobDriver, "placeQuote" | "cancelAll" | "cancelOrder" | "getOpenOrders" | "fetchTokenBalance">,
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

  /**
   * Reconcile with the exchange on startup WITHOUT cancelling existing SELLs.
   *
   * - Query open orders; cancel stale BUYs (we'll re-quote them at current mid),
   *   but PRESERVE existing SELLs at their prior exit prices and register them
   *   in activeSells so cancelActiveBuys skips them.
   * - This lets us resume a session without giving away positions at bad prices.
   */
  async startupCleanup(): Promise<void> {
    this.activeBuys.clear();
    this.activeSells.clear();
    let openOrders: Array<Record<string, unknown>> = [];
    try {
      openOrders = (await this.driver.getOpenOrders()) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      this.logger.error("[STARTUP-OPEN-ORDERS-ERROR]", { error: String(err) });
      return;
    }

    for (const order of openOrders) {
      const id = typeof order.id === "string" ? order.id : undefined;
      const assetId = typeof order.asset_id === "string" ? order.asset_id : undefined;
      const side = String(order.side ?? "").toUpperCase();
      const price = Number.parseFloat(String(order.price ?? ""));
      if (!id || !assetId || !Number.isFinite(price)) continue;

      const market = this.marketByAssetId.get(assetId);
      if (!market) {
        // Order on a market we don't know — leave it alone.
        continue;
      }

      if (side === "SELL") {
        this.activeSells.set(market.conditionId, {
          orderId: id,
          conditionId: market.conditionId,
          side: "SELL",
          price
        });
        this.logger.error("[STARTUP-PRESERVE-SELL]", {
          outcome: market.outcomeLabel,
          orderId: id,
          price
        });
        continue;
      }

      if (side === "BUY") {
        try {
          await this.driver.cancelOrder(id);
          this.logger.error("[STARTUP-CANCEL-STALE-BUY]", { outcome: market.outcomeLabel, orderId: id });
        } catch (err) {
          this.logger.error("[STARTUP-CANCEL-ERROR]", { orderId: id, error: String(err) });
        }
      }
    }

    this.logger.info("startup reconcile done", {
      preservedSells: this.activeSells.size,
      openOrderCount: openOrders.length
    });
  }

  /**
   * On startup: query exchange token balances for all markets.
   * If we hold shares from a prior session, load them into inventory and
   * ensure a SELL rests on the book. If an existing SELL was preserved in
   * startupCleanup, use its price as the entry estimate so the inventory
   * reflects the true cost basis. Otherwise use current bestBid as a
   * conservative entry — the SELL rests at bestBid + 1 tick, which is
   * maker-safe and still profitable if filled.
   */
  async loadStartupPositions(): Promise<void> {
    for (const [conditionId, market] of this.marketByConditionId) {
      try {
        const shares = await this.driver.fetchTokenBalance(market.yesTokenId);
        const floored = Math.floor(shares * 10000) / 10000;
        if (floored < this.config.clobMinShares) continue;

        const existingSell = this.activeSells.get(conditionId);
        const tickSize = this.tickSizeFor(market);

        // Determine an entry-price estimate for inventory cost basis.
        let entryEstimate: number;
        if (existingSell) {
          // Existing SELL at price P implies original entry ~= P - tick.
          entryEstimate = Math.max(0, existingSell.price - tickSize);
        } else {
          const book = await fetchOrderBookTop(market.yesTokenId, this.config.clobHost).catch(() => ({
            bestBid: undefined,
            bestAsk: undefined
          }));
          entryEstimate = book.bestBid ?? 0.5;
        }

        this.logger.error("[STARTUP-POSITION]", {
          outcome: market.outcomeLabel,
          conditionId,
          shares: floored,
          entryEstimate,
          existingSellPrice: existingSell?.price ?? null
        });

        const fill: FillEvent = {
          conditionId,
          tokenId: market.yesTokenId,
          side: "BUY",
          price: entryEstimate,
          shares: floored
        };
        this.inventory.applyFill(fill);

        if (!existingSell) {
          await this.placeSellForFill(market, fill);
        }
      } catch (err) {
        this.logger.error("[STARTUP-POSITION-ERROR]", { outcome: market.outcomeLabel, error: String(err) });
      }
    }
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

    // Detect any positions with no active SELL and re-place
    for (const [conditionId] of this.marketByConditionId) {
      if (!this.inventory.hasPosition(conditionId)) continue;
      if (this.activeSells.has(conditionId)) continue;
      const market = this.marketByConditionId.get(conditionId)!;
      const position = this.inventory.getPosition(conditionId);
      this.logger.error("[SELL-MISSING] position held but no active SELL — re-placing", {
        outcome: market.outcomeLabel,
        shares: position.shares
      });
      const retryFill: FillEvent = {
        conditionId,
        tokenId: market.yesTokenId,
        side: "BUY",
        price: position.avgEntryPrice,
        shares: position.shares
      };
      await this.placeSellForFill(market, retryFill);
    }

    // Log inventory summary
    const positions = [...this.marketByConditionId.keys()]
      .filter((cid) => this.inventory.hasPosition(cid))
      .map((cid) => {
        const pos = this.inventory.getPosition(cid);
        const market = this.marketByConditionId.get(cid)!;
        const sellOrder = this.activeSells.get(cid);
        return { outcome: market.outcomeLabel, shares: pos.shares, entry: pos.avgEntryPrice, sellOrderId: sellOrder?.orderId ?? null, sellPrice: sellOrder?.price ?? null };
      });
    if (positions.length > 0) {
      this.logger.error("[INVENTORY]", { positions, total: positions.length });
    }
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
        this.logger.error("[SELL-REQUEUE]", { outcome: market.outcomeLabel });
        await this.placeSellForFill(market, retryFill);
      }
    }
  }

  private tickSizeFor(market: WeatherMarket): number {
    return market.tickSize ?? this.config.tickSize;
  }

  private async placeSellForFill(market: WeatherMarket, fill: FillEvent): Promise<void> {
    const tickSize = this.tickSizeFor(market);
    const sell = buildSellOnFill(fill, tickSize);
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
    this.logger.error("[SELL-COMPUTING]", {
      outcome: market.outcomeLabel,
      entry: fill.price,
      tickSize,
      exit: sell.price,
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
