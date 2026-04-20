import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { findActiveWeatherEvents } from "./adapters/weatherDiscovery.js";
import { fetchOpenMeteoForecast } from "./adapters/weatherFeed.js";
import { forecastToProbabilities } from "./core/weatherFairValue.js";
import { buildBuyQuotes, filterPostOnlySafeQuotes } from "./core/multiMarketQuoter.js";
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

  const events = await findActiveWeatherEvents(config);
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
    const quotes = buildBuyQuotes(event, forecast, config);
    const books = [];
    for (const quote of quotes) {
      try {
        books.push({ tokenId: quote.tokenId, outcomeLabel: quote.outcomeLabel, ...(await fetchOrderBookTop(quote.tokenId, config.clobHost)) });
      } catch (error) {
        books.push({
          tokenId: quote.tokenId,
          outcomeLabel: quote.outcomeLabel,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const { safeQuotes, skippedQuotes } = filterPostOnlySafeQuotes(quotes, books);
    const receipts = execution ? await execution.engine.placeBuyQuotes(safeQuotes) : await broker.placeMany(safeQuotes);

    log.info("weather event quoted", {
      event: event.title,
      city: event.city,
      date: event.date,
      forecastTempC: forecast.temperatureMaxC,
      outcomes: event.markets.length,
      quoteCount: safeQuotes.length,
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
      quotes: safeQuotes,
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
    setInterval(() => {
      void refreshLiveQuotes(config, execution.engine);
    }, config.refreshIntervalMs);
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
    const events = await findActiveWeatherEvents(config);
    for (const event of events) {
      const forecast = await fetchOpenMeteoForecast(event);
      const quotes = buildBuyQuotes(event, forecast, config);
      const books = [];
      for (const quote of quotes) {
        books.push({ tokenId: quote.tokenId, ...(await fetchOrderBookTop(quote.tokenId, config.clobHost)) });
      }
      const { safeQuotes } = filterPostOnlySafeQuotes(quotes, books);
      await engine.placeBuyQuotes(safeQuotes);
    }
    log.info("live quote refresh complete", { refreshIntervalMs: config.refreshIntervalMs });
  } catch (error) {
    log.error("live quote refresh failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error("fatal", { error: message });
  process.exitCode = 1;
});
