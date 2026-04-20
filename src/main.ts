import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { findActiveWeatherEvents } from "./adapters/weatherDiscovery.js";
import { fetchOpenMeteoForecast } from "./adapters/weatherFeed.js";
import { forecastToProbabilities } from "./core/weatherFairValue.js";
import { buildBuyQuotes } from "./core/multiMarketQuoter.js";
import { QuoteIntent } from "./types.js";
import { InventoryEngine } from "./core/inventoryEngine.js";
import { DryRunBroker } from "./execution/dryRunBroker.js";
import { fetchOrderBookTop } from "./execution/orderBookClient.js";
import { createClobDriverFromConfig } from "./execution/clobDriver.js";
import { WeatherExecutionEngine } from "./execution/weatherExecutionEngine.js";
import { UserWebSocket } from "./execution/userWebSocket.js";

const log = new Logger("weather-mm");

async function main() {
  const config = loadConfig();
  if (!config.dryRunLive && !config.liveApiEnabled) {
    throw new Error("LIVE_API_ENABLED=true is required when DRY_RUN_LIVE=false");
  }

  log.info("starting weather dry-run-live", {
    maxEvents: config.maxEvents,
    maxOutcomesPerEvent: config.maxOutcomesPerEvent,
    dryRunLive: config.dryRunLive
  });

  const discoveryConfig = { ...config, maxOutcomesPerEvent: Math.max(config.maxOutcomesPerEvent, 20) };
  const events = await findActiveWeatherEvents(discoveryConfig);
  if (events.length === 0) throw new Error("No active weather temperature events discovered");

  const broker = new DryRunBroker(join(config.dataDir, "dry-run-orders.jsonl"));
  const execution = config.dryRunLive ? undefined : createLiveExecution(config, events);
  if (execution) {
    await execution.engine.startupCleanup();
    execution.userWs.connect();
  }
  const evidence = {
    generatedAt: new Date().toISOString(),
    dryRunLive: config.dryRunLive,
    takerCritical: 0,
    events: [] as unknown[]
  };

  for (const event of events) {
    const forecast = await fetchOpenMeteoForecast(event);
    const distribution = forecastToProbabilities(
      forecast.temperatureMaxC,
      config.weatherUncertaintyC,
      event.markets.map((market) => market.temperatureC)
    );
    const books = [];
    for (const market of event.markets) {
      try {
        books.push({ tokenId: market.yesTokenId, outcomeLabel: market.outcomeLabel, ...(await fetchOrderBookTop(market.yesTokenId, config.clobHost)) });
      } catch (error) {
        books.push({ tokenId: market.yesTokenId, outcomeLabel: market.outcomeLabel, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const { quotes, skipped: skippedQuotes } = buildBuyQuotes(event, forecast, config, books);
    const selectedQuotes = selectQuotesClosestToForecast(quotes, event, forecast.temperatureMaxC, config.maxOutcomesPerEvent);
    const receipts = execution ? await execution.engine.placeBuyQuotes(selectedQuotes) : await broker.placeMany(selectedQuotes);

    log.info("weather event quoted", {
      event: event.title,
      city: event.city,
      date: event.date,
      forecastTempC: forecast.temperatureMaxC,
      outcomes: event.markets.length,
      quoteCount: selectedQuotes.length,
      skippedQuoteCount: skippedQuotes.length,
      takerCritical: 0
    });

    evidence.events.push({
      title: event.title,
      city: event.city,
      date: event.date,
      forecast,
      markets: event.markets.map((market) => ({
        conditionId: market.conditionId,
        outcomeLabel: market.outcomeLabel,
        yesTokenId: market.yesTokenId
      })),
      fairValue: distribution,
      quotes: selectedQuotes,
      skippedQuotes,
      books,
      receiptCount: receipts.length
    });
  }

  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, "weather-dry-run-evidence.json"), JSON.stringify(evidence, null, 2));
  log.info("dry-run-live complete", {
    eventCount: events.length,
    evidencePath: join(config.dataDir, "weather-dry-run-evidence.json"),
    takerCritical: 0
  });

  if (execution) {
    void scheduleRefreshLoop(config, execution.engine);
  }
}

function createLiveExecution(config: ReturnType<typeof loadConfig>, events: Awaited<ReturnType<typeof findActiveWeatherEvents>>) {
  const driver = createClobDriverFromConfig(config);
  const inventory = new InventoryEngine();
  const engine = new WeatherExecutionEngine(events, driver, inventory, config);
  const userWs = new UserWebSocket({
    auth: {
      apiKey: config.polymarketApiKey as string,
      secret: config.polymarketApiSecret as string,
      passphrase: config.polymarketApiPassphrase as string
    },
    conditionIds: engine.conditionIds(),
    handlers: {
      onFill: (fill) => engine.onUserFill(fill),
      onOrderUpdate: (update) => engine.onOrderUpdate(update),
      onError: (error) => log.error("user websocket error", { error: error.message }),
      onOpen: () => log.info("user websocket subscribed", { markets: engine.conditionIds().length })
    }
  });
  return { engine, userWs };
}

async function refreshLiveQuotes(config: ReturnType<typeof loadConfig>, engine: WeatherExecutionEngine): Promise<void> {
  try {
    await engine.startupCleanup();
    const positions = engine.getPositionSnapshots();
    const events = await findActiveWeatherEvents({ ...config, maxOutcomesPerEvent: Math.max(config.maxOutcomesPerEvent, 20) });
    for (const event of events) {
      const forecast = await fetchOpenMeteoForecast(event);
      const books = [];
      for (const market of event.markets) {
        try {
          books.push({ tokenId: market.yesTokenId, ...(await fetchOrderBookTop(market.yesTokenId, config.clobHost)) });
        } catch {
          books.push({ tokenId: market.yesTokenId });
        }
      }
      const { quotes, skipped } = buildBuyQuotes(event, forecast, config, books, positions);
      if (skipped.length > 0) {
        log.info("skipped outcomes", { event: event.title, skipped });
      }
      const selectedQuotes = selectQuotesClosestToForecast(quotes, event, forecast.temperatureMaxC, config.maxOutcomesPerEvent);
      await engine.placeBuyQuotes(selectedQuotes);
    }
    log.info("live quote refresh complete", { refreshIntervalMs: config.refreshIntervalMs });
  } catch (error) {
    log.error("live quote refresh failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function scheduleRefreshLoop(config: ReturnType<typeof loadConfig>, engine: WeatherExecutionEngine): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, config.refreshIntervalMs));
  await refreshLiveQuotes(config, engine);
  void scheduleRefreshLoop(config, engine);
}

function selectQuotesClosestToForecast(
  quotes: QuoteIntent[],
  event: Awaited<ReturnType<typeof findActiveWeatherEvents>>[number],
  forecastTempC: number,
  limit: number
) {
  if (quotes.length <= limit) return quotes;
  const marketByConditionId = new Map(event.markets.map((market) => [market.conditionId, market]));
  return [...quotes]
    .sort((left, right) => {
      const leftTemp = marketByConditionId.get(left.conditionId)?.temperatureC ?? Number.POSITIVE_INFINITY;
      const rightTemp = marketByConditionId.get(right.conditionId)?.temperatureC ?? Number.POSITIVE_INFINITY;
      return Math.abs(leftTemp - forecastTempC) - Math.abs(rightTemp - forecastTempC);
    })
    .slice(0, limit);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error("fatal", { error: message });
  process.exitCode = 1;
});
