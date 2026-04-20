import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { findActiveWeatherEvents } from "./adapters/weatherDiscovery.js";
import { fetchOpenMeteoForecast } from "./adapters/weatherFeed.js";
import { forecastToProbabilities } from "./core/weatherFairValue.js";
import { buildBuyQuotes } from "./core/multiMarketQuoter.js";
import { DryRunBroker } from "./execution/dryRunBroker.js";

const log = new Logger("weather-mm");

async function main() {
  const config = loadConfig();
  if (!config.dryRunLive) {
    throw new Error("Real live trading path is intentionally disabled until CEO review clears DRY_RUN_LIVE evidence");
  }

  log.info("starting weather dry-run-live", {
    maxEvents: config.maxEvents,
    maxOutcomesPerEvent: config.maxOutcomesPerEvent,
    dryRunLive: config.dryRunLive
  });

  const events = await findActiveWeatherEvents(config);
  if (events.length === 0) throw new Error("No active weather temperature events discovered");

  const broker = new DryRunBroker(join(config.dataDir, "dry-run-orders.jsonl"));
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
    const receipts = await broker.placeMany(quotes);

    log.info("weather event quoted", {
      event: event.title,
      city: event.city,
      date: event.date,
      forecastTempC: forecast.temperatureMaxC,
      outcomes: event.markets.length,
      quoteCount: quotes.length,
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
      quotes,
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
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error("fatal", { error: message });
  process.exitCode = 1;
});
