import { InventoryEngine } from "../core/inventoryEngine.js";
import { buildSellOnFill, hoursUntilResolution, PositionSnapshot } from "../core/multiMarketQuoter.js";
import { EventLog } from "../core/eventLog.js";
import { evaluateStopLoss, exitUrgency, StopLossConfig, StopLossRule } from "../core/stopLoss.js";
import { VolatilityTracker } from "../core/volatilityTracker.js";
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
  // Track the event date for each conditionId so we can compute hoursToResolution
  private readonly eventDateByConditionId = new Map<string, string>();
  // Track when each position was opened for stop-loss time-based rules
  private readonly positionEntryTime = new Map<string, number>();
  // Per-market realized-volatility tracker for vol-aware spread widening.
  private readonly volTracker: VolatilityTracker;
  // When we placed a maker-exit, record the moment — if not filled within the
  // maker wait window, the stop-loss escalates to taker.
  private readonly makerExitStartedAt = new Map<string, number>();

  constructor(
    events: WeatherEvent[],
    private readonly driver: Pick<
      ClobDriver,
      | "placeQuote"
      | "placeTakerExit"
      | "cancelAll"
      | "cancelOrder"
      | "getOpenOrders"
      | "fetchTokenBalance"
      | "resolveTickSize"
    >,
    private readonly inventory: InventoryEngine,
    private readonly config: Config,
    private readonly logger = new Logger("weather-execution"),
    private readonly eventLog: EventLog = new EventLog()
  ) {
    for (const event of events) {
      for (const market of event.markets) {
        this.marketByAssetId.set(market.yesTokenId, market);
        this.marketByAssetId.set(market.noTokenId, market);
        this.marketByConditionId.set(market.conditionId, market);
        this.eventDateByConditionId.set(market.conditionId, event.date);
      }
    }
    this.volTracker = new VolatilityTracker({
      windowSize: config.volWindowSize,
      volMultiplier: config.volMultiplier,
      maxExtraCents: config.volMaxExtraCents
    });
  }

  conditionIds(): string[] {
    return [...this.marketByConditionId.keys()];
  }

  /** Called by the refresh loop with the latest book for each tracked market. */
  recordMid(conditionId: string, mid: number): void {
    this.volTracker.update(conditionId, mid);
  }

  /** Per-market stddev of recent mid returns (cents). For the quoter and dashboard. */
  volExtraCents(conditionId: string): number {
    return this.volTracker.snapshot(conditionId).extraCents;
  }

  volSnapshots() {
    return this.volTracker.allSnapshots();
  }

  /** Expose snapshot data for the dashboard. */
  snapshot() {
    return {
      activeBuys: [...this.activeBuys.entries()].map(([conditionId, order]) => {
        const market = this.marketByConditionId.get(conditionId);
        return {
          conditionId,
          orderId: order.orderId,
          price: order.price,
          city: undefined as string | undefined,
          outcome: market?.outcomeLabel,
          temperatureC: market?.temperatureC
        };
      }),
      activeSells: [...this.activeSells.entries()].map(([conditionId, order]) => {
        const market = this.marketByConditionId.get(conditionId);
        return {
          conditionId,
          orderId: order.orderId,
          price: order.price,
          outcome: market?.outcomeLabel,
          temperatureC: market?.temperatureC
        };
      }),
      positions: [...this.marketByConditionId.entries()]
        .filter(([cid]) => this.inventory.hasPosition(cid))
        .map(([cid, market]) => {
          const pos = this.inventory.getPosition(cid);
          const sell = this.activeSells.get(cid);
          return {
            conditionId: cid,
            outcome: market.outcomeLabel,
            temperatureC: market.temperatureC,
            shares: pos.shares,
            avgEntryPrice: pos.avgEntryPrice,
            realizedPnl: pos.realizedPnl,
            activeSellPrice: sell?.price,
            activeSellOrderId: sell?.orderId
          };
        }),
      markets: [...this.marketByConditionId.values()].map((market) => ({
        conditionId: market.conditionId,
        outcome: market.outcomeLabel,
        temperatureC: market.temperatureC,
        tickSize: market.tickSize,
        volume24hr: market.volume24hr
      }))
    };
  }

  /**
   * Resolve per-market tickSize from the exchange and cache it on the market.
   * This lets buildBuyQuotes / buildSellOnFill price at the market's true tick
   * (0.001 markets get 0.1-cent quotes instead of being flattened to 0.01).
   * Safe to call multiple times; results are cached in-memory on the market.
   */
  async resolveMarketTickSizes(): Promise<void> {
    for (const [conditionId, market] of this.marketByConditionId) {
      if (market.tickSize !== undefined) continue;
      try {
        const tick = await this.driver.resolveTickSize(market.yesTokenId);
        market.tickSize = tick;
        this.logger.info("[TICK-RESOLVED]", {
          outcome: market.outcomeLabel,
          conditionId,
          tickSize: tick
        });
      } catch (err) {
        this.logger.error("[TICK-RESOLVE-ERROR]", {
          outcome: market.outcomeLabel,
          error: String(err)
        });
      }
    }
  }

  getPositionSnapshots(): PositionSnapshot[] {
    return [...this.marketByConditionId.keys()].map((conditionId) => {
      const pos = this.inventory.getPosition(conditionId);
      return {
        conditionId,
        exposureUsdc: pos.shares * pos.avgEntryPrice,
        shares: pos.shares
      };
    });
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
        this.logger.info("[STARTUP-PRESERVE-SELL]", {
          outcome: market.outcomeLabel,
          orderId: id,
          price
        });
        continue;
      }

      if (side === "BUY") {
        try {
          await this.driver.cancelOrder(id);
          this.logger.info("[STARTUP-CANCEL-STALE-BUY]", { outcome: market.outcomeLabel, orderId: id });
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

        this.logger.info("[STARTUP-POSITION]", {
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
        // On restart we don't know the true entry time; use "now" so the
        // stop-loss holding-time counter starts fresh.
        this.positionEntryTime.set(conditionId, Date.now());

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
      this.logger.info("[CANCEL-SKIP-SELL]", { conditionId, orderId: order.orderId, price: order.price });
    }

    const buyConditions = [...this.activeBuys.keys()];
    for (const conditionId of buyConditions) {
      const order = this.activeBuys.get(conditionId)!;
      this.logger.debug("[CANCEL-CHECK]", { conditionId, side: order.side, orderId: order.orderId });
      try {
        await this.driver.cancelOrder(order.orderId);
        this.logger.info("[CANCEL-BUY]", { orderId: order.orderId, conditionId });
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
      this.logger.warn("[SELL-MISSING] position held but no active SELL — re-placing", {
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
      this.logger.info("[INVENTORY]", { positions, total: positions.length });
    }
  }

  /**
   * Evaluate stop-loss rules for every held position and execute taker
   * exits where rules fire. Call from the refresh loop.
   */
  async evaluateStopLosses(): Promise<void> {
    if (!this.config.stopLossEnabled) return;
    const stopCfg: StopLossConfig = {
      enabled: this.config.stopLossEnabled,
      catastrophicDropRatio: this.config.stopLossCatastrophicDropRatio,
      deepDropRatio: this.config.stopLossDeepDropRatio,
      deepDropMaxMinutes: this.config.stopLossDeepDropMaxMinutes,
      resolutionStopHours: this.config.stopLossResolutionHours,
      resolutionDropRatio: this.config.stopLossResolutionDropRatio,
      maxHoldingHours: this.config.stopLossMaxHoldingHours,
      makerExitWaitSeconds: this.config.stopLossMakerExitWaitSeconds
    };
    const now = Date.now();

    for (const [conditionId, market] of this.marketByConditionId) {
      if (!this.inventory.hasPosition(conditionId)) continue;
      const position = this.inventory.getPosition(conditionId);
      const entryTime = this.positionEntryTime.get(conditionId) ?? now;
      const eventDate = this.eventDateByConditionId.get(conditionId) ?? "";
      const hoursToResolution = hoursUntilResolution(eventDate, new Date(now));

      let book: { bestBid?: number; bestAsk?: number };
      try {
        book = await fetchOrderBookTop(market.yesTokenId, this.config.clobHost);
      } catch (err) {
        this.logger.error("[STOP-LOSS-BOOK-ERROR]", { outcome: market.outcomeLabel, error: String(err) });
        continue;
      }
      if (book.bestBid === undefined || book.bestAsk === undefined) continue;
      const mid = (book.bestBid + book.bestAsk) / 2;

      const decision = evaluateStopLoss(
        {
          conditionId,
          outcomeLabel: market.outcomeLabel,
          avgEntryPrice: position.avgEntryPrice,
          shares: position.shares,
          currentMid: mid,
          entryTime,
          now,
          hoursToResolution
        },
        stopCfg
      );
      if (!decision.shouldStop) continue;

      this.logger.warn("[STOP-LOSS-TRIGGERED]", {
        outcome: market.outcomeLabel,
        rule: decision.rule,
        urgency: exitUrgency(decision.rule),
        detail: decision.detail
      });
      this.eventLog.record({
        type: "ERROR",
        outcome: market.outcomeLabel,
        conditionId,
        message: `STOP_LOSS:${decision.rule}`,
        data: { ...decision.detail, urgency: exitUrgency(decision.rule) }
      });

      await this.executeStopLossExit(market, position, book, decision.rule);
    }
  }

  /**
   * Exit ladder.
   *   Urgent rules (CATASTROPHIC_DROP, NEAR_RESOLUTION_ADVERSE) → taker now.
   *   Patient rules (DEEP_DROP_STALE, MAX_HOLDING) → maker SELL at bestAsk for
   *     makerExitWaitSeconds; if still resting next tick, escalate to taker.
   *
   * Maker attempt replaces the existing TP SELL (we cancel the TP first).
   * We record the start time in makerExitStartedAt; on the next refresh cycle,
   * if the replacement SELL is still resting AND the wait window has
   * elapsed, we escalate — the next `evaluateStopLosses` pass will see the
   * same trigger and route as urgent.
   */
  private async executeStopLossExit(
    market: WeatherMarket,
    position: { shares: number; avgEntryPrice: number },
    book: { bestBid?: number; bestAsk?: number },
    rule: StopLossRule
  ): Promise<void> {
    const urgency = exitUrgency(rule);
    const now = Date.now();

    // If a maker-exit was already placed and the wait window has elapsed, escalate.
    const makerStarted = this.makerExitStartedAt.get(market.conditionId);
    const escalate =
      urgency === "patient" &&
      makerStarted !== undefined &&
      (now - makerStarted) / 1000 >= this.config.stopLossMakerExitWaitSeconds;

    const routeUrgent = urgency === "urgent" || escalate;

    // Cancel any resting SELL first so whatever we place next owns the shares
    const existingSell = this.activeSells.get(market.conditionId);
    if (existingSell) {
      try {
        await this.driver.cancelOrder(existingSell.orderId);
      } catch (err) {
        this.logger.error("[STOP-LOSS-CANCEL-ERROR]", { error: String(err) });
      }
      this.activeSells.delete(market.conditionId);
    }

    const tick = market.tickSize ?? this.config.tickSize;
    const shares = Math.floor(position.shares * 10_000) / 10_000;
    if (shares < this.config.clobMinShares) return;

    if (routeUrgent) {
      await this.takerExit(market, position, book, shares, tick, rule);
      this.makerExitStartedAt.delete(market.conditionId);
      return;
    }

    // Patient: place a maker SELL at bestAsk (our new best ask) and record the time.
    if (book.bestBid === undefined || book.bestAsk === undefined) {
      // No book — fall back to taker to be safe.
      await this.takerExit(market, position, book, shares, tick, rule);
      this.makerExitStartedAt.delete(market.conditionId);
      return;
    }
    const makerPrice = roundToTickAbove(book.bestBid + tick, tick);
    // Make sure it's strictly above bestBid and at most bestAsk (resting, not taking)
    const safePrice = Math.min(Math.max(makerPrice, book.bestBid + tick), book.bestAsk);
    const quote: QuoteIntent = {
      eventId: "stop-loss-maker",
      city: "stop-loss",
      date: this.eventDateByConditionId.get(market.conditionId) ?? "",
      conditionId: market.conditionId,
      tokenId: market.yesTokenId,
      outcomeLabel: market.outcomeLabel,
      side: "SELL",
      price: safePrice,
      sizeUsdc: safePrice * shares,
      shares,
      postOnly: true,
      reason: `stop_loss_maker ${rule}`
    };
    try {
      const result = await this.driver.placeQuote(quote, true);
      if (result.status === "live" && result.orderId) {
        this.activeSells.set(market.conditionId, {
          orderId: result.orderId,
          conditionId: market.conditionId,
          side: "SELL",
          price: safePrice
        });
        this.makerExitStartedAt.set(market.conditionId, now);
        this.logger.warn("[STOP-LOSS-MAKER-EXIT]", {
          outcome: market.outcomeLabel,
          rule,
          price: safePrice,
          waitSec: this.config.stopLossMakerExitWaitSeconds
        });
      } else {
        // postOnly rejected or other — fall back to taker immediately
        await this.takerExit(market, position, book, shares, tick, rule);
      }
    } catch (err) {
      this.logger.error("[STOP-LOSS-MAKER-ERROR]", { error: String(err) });
      await this.takerExit(market, position, book, shares, tick, rule);
    }
  }

  private async takerExit(
    market: WeatherMarket,
    position: { shares: number; avgEntryPrice: number },
    book: { bestBid?: number; bestAsk?: number },
    shares: number,
    tick: number,
    rule: StopLossRule
  ): Promise<void> {
    if (book.bestBid === undefined) return;
    const exitPrice = book.bestBid;
    const exit: QuoteIntent = {
      eventId: "stop-loss-taker",
      city: "stop-loss",
      date: this.eventDateByConditionId.get(market.conditionId) ?? "",
      conditionId: market.conditionId,
      tokenId: market.yesTokenId,
      outcomeLabel: market.outcomeLabel,
      side: "SELL",
      price: exitPrice,
      sizeUsdc: exitPrice * shares,
      shares,
      postOnly: true, // literal type requirement; taker path sends postOnly=false
      reason: `stop_loss_taker ${rule} tick=${tick}`
    };
    try {
      const result = await this.driver.placeTakerExit(exit);
      this.logger.warn("[STOP-LOSS-TAKER-EXIT]", {
        outcome: market.outcomeLabel,
        rule,
        exitPrice,
        shares,
        success: result.success,
        status: result.status
      });
      if (result.success) {
        this.inventory.applyFill({
          conditionId: market.conditionId,
          tokenId: market.yesTokenId,
          side: "SELL",
          price: exitPrice,
          shares
        });
        this.positionEntryTime.delete(market.conditionId);
        const realizedPerShare = exitPrice - position.avgEntryPrice;
        this.eventLog.record({
          type: "ROUND_TRIP",
          outcome: market.outcomeLabel,
          conditionId: market.conditionId,
          price: exitPrice,
          shares,
          profitUsdc: Number((realizedPerShare * shares).toFixed(4)),
          message: `STOP_LOSS_TAKER:${rule}`,
          data: { entry: position.avgEntryPrice, exit: exitPrice }
        });
      }
    } catch (err) {
      this.logger.error("[STOP-LOSS-EXIT-ERROR]", {
        outcome: market.outcomeLabel,
        error: String(err)
      });
    }
  }

  /**
   * REST-based fill detection: query CLOB open orders and find any tracked
   * order that disappeared without us cancelling it — that means it was
   * filled and the User WS missed the event. Covers both BUYs and SELLs.
   */
  async detectMissedFills(): Promise<void> {
    if (this.activeBuys.size === 0 && this.activeSells.size === 0) return;

    let openOrders: Array<{ id: string }>;
    try {
      openOrders = (await this.driver.getOpenOrders()) as Array<{ id: string }>;
    } catch (err) {
      this.logger.error("[REST-DETECT-ERROR]", { error: String(err) });
      return;
    }

    const openIds = new Set(openOrders.map((o) => o.id));

    for (const [conditionId, buyOrder] of this.activeBuys) {
      if (openIds.has(buyOrder.orderId)) continue;

      const market = this.marketByConditionId.get(conditionId);
      if (!market) continue;
      if (this.inventory.hasPosition(conditionId)) continue; // WS already handled it

      this.logger.info("[FILL-DETECTED-REST]", {
        outcome: market.outcomeLabel,
        conditionId,
        orderId: buyOrder.orderId,
        price: buyOrder.price,
        side: "BUY"
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

    for (const [conditionId, sellOrder] of this.activeSells) {
      if (openIds.has(sellOrder.orderId)) continue;

      const market = this.marketByConditionId.get(conditionId);
      if (!market) continue;

      // SELL no longer open — either filled or externally cancelled.
      // Check on-chain balance: 0 means the round-trip completed.
      let balance = 0;
      try {
        balance = await this.driver.fetchTokenBalance(market.yesTokenId);
      } catch (err) {
        this.logger.error("[REST-BAL-ERROR]", { error: String(err) });
        continue;
      }

      const position = this.inventory.getPosition(conditionId);
      if (balance < this.config.clobMinShares) {
        // Round-trip confirmed by zero balance.
        const realizedPerShare = sellOrder.price - position.avgEntryPrice;
        const realizedUsdc = realizedPerShare * position.shares;
        this.logger.info("[FILL-DETECTED-REST]", {
          outcome: market.outcomeLabel,
          conditionId,
          orderId: sellOrder.orderId,
          price: sellOrder.price,
          side: "SELL"
        });
        this.logger.info("[ROUND-TRIP]", {
          outcome: market.outcomeLabel,
          entry: position.avgEntryPrice,
          exit: sellOrder.price,
          shares: position.shares,
          profitUsdc: Number(realizedUsdc.toFixed(4)),
          source: "REST"
        });
        this.inventory.applyFill({
          conditionId,
          tokenId: market.yesTokenId,
          side: "SELL",
          price: sellOrder.price,
          shares: position.shares
        });
        this.activeSells.delete(conditionId);
      } else {
        // Balance still present — the SELL vanished but we still hold shares.
        // Treat as cancellation and re-queue.
        this.logger.warn("[SELL-VANISHED]", {
          outcome: market.outcomeLabel,
          balance,
          positionShares: position.shares
        });
        this.activeSells.delete(conditionId);
        const retryFill: FillEvent = {
          conditionId,
          tokenId: market.yesTokenId,
          side: "BUY",
          price: position.avgEntryPrice,
          shares: position.shares
        };
        await this.placeSellForFill(market, retryFill);
      }
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
        this.eventLog.record({
          type: "BUY_PLACED",
          city: quote.city,
          outcome: quote.outcomeLabel,
          conditionId: quote.conditionId,
          orderId: result.orderId,
          side: "BUY",
          price: quote.price,
          shares: quote.shares,
          sizeUsdc: quote.sizeUsdc,
          data: { reason: quote.reason }
        });
      } else {
        this.eventLog.record({
          type: "BUY_REJECTED",
          city: quote.city,
          outcome: quote.outcomeLabel,
          conditionId: quote.conditionId,
          side: "BUY",
          price: quote.price,
          shares: quote.shares,
          message: result.errorMsg ?? result.status,
          data: { reason: quote.reason }
        });
      }
    }
    return results;
  }

  async onUserFill(fill: UserFill): Promise<void> {
    this.logger.info("[FILL-RECEIVED]", {
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

    this.logger.info("[FILL-MARKET]", { outcome: market.outcomeLabel, conditionId: market.conditionId });

    if (fill.traderSide === "TAKER") {
      this.logger.error("[TAKER-CRITICAL]", { conditionId: market.conditionId, outcome: market.outcomeLabel });
      this.eventLog.record({
        type: "TAKER_CRITICAL",
        outcome: market.outcomeLabel,
        conditionId: market.conditionId,
        side: fill.side,
        price: fill.price,
        shares: fill.shares
      });
    }

    // Capture cost-basis BEFORE applying the fill so SELL P&L uses the actual entry
    const preFillPosition = this.inventory.getPosition(market.conditionId);
    const entryBasis = preFillPosition.avgEntryPrice;

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
      // Record entry time on first BUY only — partial fills shouldn't reset it
      if (!this.positionEntryTime.has(market.conditionId)) {
        this.positionEntryTime.set(market.conditionId, Date.now());
      }
      this.logger.info("[FILL-BUY] BUY filled, removed from activeBuys, placing SELL now", {
        outcome: market.outcomeLabel
      });
      this.eventLog.record({
        type: "BUY_FILLED",
        outcome: market.outcomeLabel,
        conditionId: market.conditionId,
        side: "BUY",
        price: fill.price,
        shares: fill.shares
      });
      await this.placeSellForFill(market, normalized);
      return;
    }

    // SELL side — round-trip completed (or partial). Clear the resting SELL,
    // log realized P&L, and let the next refresh cycle quote a fresh BUY.
    if (fill.side === "SELL") {
      this.activeSells.delete(market.conditionId);
      // If SELL closes the position fully, forget the entry timestamp
      const remainingShares = this.inventory.getPosition(market.conditionId).shares;
      if (remainingShares < this.config.clobMinShares) {
        this.positionEntryTime.delete(market.conditionId);
      }
      const realizedPerShare = fill.price - entryBasis;
      const realizedUsdc = realizedPerShare * fill.shares;
      const remaining = this.inventory.getPosition(market.conditionId).shares;
      this.logger.info("[ROUND-TRIP]", {
        outcome: market.outcomeLabel,
        conditionId: market.conditionId,
        entry: entryBasis,
        exit: fill.price,
        shares: fill.shares,
        profitUsdc: Number(realizedUsdc.toFixed(4)),
        remainingShares: remaining
      });
      this.eventLog.record({
        type: "SELL_FILLED",
        outcome: market.outcomeLabel,
        conditionId: market.conditionId,
        side: "SELL",
        price: fill.price,
        shares: fill.shares
      });
      this.eventLog.record({
        type: "ROUND_TRIP",
        outcome: market.outcomeLabel,
        conditionId: market.conditionId,
        price: fill.price,
        shares: fill.shares,
        profitUsdc: Number(realizedUsdc.toFixed(4)),
        data: { entry: entryBasis, exit: fill.price, remainingShares: remaining }
      });
      // Partial fill: inventory still holds shares → re-place SELL for the remainder
      if (remaining >= this.config.clobMinShares) {
        this.logger.info("[SELL-PARTIAL-REMAINDER]", {
          outcome: market.outcomeLabel,
          remainingShares: remaining
        });
        const retryFill: FillEvent = {
          conditionId: market.conditionId,
          tokenId: market.yesTokenId,
          side: "BUY",
          price: entryBasis,
          shares: remaining
        };
        await this.placeSellForFill(market, retryFill);
      }
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
        this.logger.info("[SELL-REQUEUE]", { outcome: market.outcomeLabel });
        await this.placeSellForFill(market, retryFill);
      }
    }
  }

  private tickSizeFor(market: WeatherMarket): number {
    return market.tickSize ?? this.config.tickSize;
  }

  private async placeSellForFill(market: WeatherMarket, fill: FillEvent): Promise<void> {
    const tickSize = this.tickSizeFor(market);
    // Compute take-profit ticks. Default = config.tpTicksBase (1 = classic MM).
    // If vol-adjustment is on, scale TP up in proportion to current realized vol,
    // capped at tpTicksMax. Calm markets: TP=1; volatile: 2-5.
    const volMul = this.config.tpVolMultiplier;
    const tpBase = Math.max(1, Math.floor(this.config.tpTicksBase));
    let tpTicks = tpBase;
    if (volMul > 0) {
      const volCents = this.volTracker.snapshot(market.conditionId).stddevCents;
      const tickCents = tickSize * 100;
      const extra = Math.floor((volMul * volCents) / tickCents);
      tpTicks = Math.min(this.config.tpTicksMax, tpBase + Math.max(0, extra));
    }
    const sell = buildSellOnFill(fill, tickSize, tpTicks);
    if (!sell) {
      this.logger.warn("[SELL-SKIP] buildSellOnFill returned null — price too high?", {
        outcome: market.outcomeLabel,
        entryPrice: fill.price
      });
      return;
    }
    sell.eventId = "fill";
    sell.city = "unknown";
    sell.date = "unknown";
    sell.outcomeLabel = market.outcomeLabel;
    this.logger.info("[SELL-COMPUTING]", {
      outcome: market.outcomeLabel,
      entry: fill.price,
      tickSize,
      exit: sell.price,
      shares: sell.shares
    });
    const result = await this.driver.placeQuote(sell, true);
    this.logger.info("[SELL-RESULT]", {
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
      this.logger.info("[SELL-PLACED]", { outcome: market.outcomeLabel, orderId: result.orderId, price: sell.price });
      this.eventLog.record({
        type: "SELL_PLACED",
        outcome: market.outcomeLabel,
        conditionId: market.conditionId,
        orderId: result.orderId,
        side: "SELL",
        price: sell.price,
        shares: sell.shares
      });
    } else {
      this.eventLog.record({
        type: "SELL_REJECTED",
        outcome: market.outcomeLabel,
        conditionId: market.conditionId,
        side: "SELL",
        price: sell.price,
        shares: sell.shares,
        message: result.errorMsg ?? result.status,
        data: { raw: result.raw }
      });
    }
  }
}

/** Round a price UP to the nearest tick (for SELL side — maker-safe). */
function roundToTickAbove(value: number, tickSize: number): number {
  const factor = Math.round(1 / tickSize);
  return Math.ceil(value * factor - 1e-9) / factor;
}
