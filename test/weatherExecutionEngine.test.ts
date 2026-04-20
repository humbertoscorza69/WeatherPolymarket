import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/config.js";
import { InventoryEngine } from "../src/core/inventoryEngine.js";
import { WeatherExecutionEngine } from "../src/execution/weatherExecutionEngine.js";
import { QuoteIntent, WeatherEvent } from "../src/types.js";

const config: Config = {
  mode: "live",
  liveApiEnabled: false,
  dryRunLive: true,
  maxEvents: 1,
  maxOutcomesPerEvent: 10,
  minMarketVolumeUsdc: 0,
  weatherApi: "open-meteo",
  weatherUncertaintyC: 1.5,
  halfSpreadCents: 1,
  maxForecastDivergence: 0.15,
  orderSizeUsdc: 2,
  clobMinShares: 5,
  maxSharesPerMarket: 5,
  maxPositionPerMarketUsdc: 3,
  maxTotalExposureUsdc: 10,
  tickSize: 0.01,
  refreshIntervalMs: 30_000,
  orderPostOnly: true,
  dataDir: "data",
  clobHost: "https://clob.polymarket.com",
  polymarketSignatureType: 1
};

const event: WeatherEvent = {
  id: "event-1",
  title: "Highest temperature in Seoul on April 21?",
  city: "Seoul",
  date: "2026-04-21",
  markets: [
    {
      conditionId: "0x17",
      question: "Will the high be 17C?",
      outcomeLabel: "17C",
      temperatureC: 17,
      yesTokenId: "yes-17",
      noTokenId: "no-17",
      volume24hr: 100,
      enableOrderBook: true,
      closed: false,
      resolved: false
    }
  ]
};

test("WeatherExecutionEngine maps BUY fill to inventory and immediate SELL", async () => {
  const placed: QuoteIntent[] = [];
  const inventory = new InventoryEngine();
  const engine = new WeatherExecutionEngine(
    [event],
    {
      cancelAll: async () => ({}),
      cancelOrder: async () => ({}),
      getOpenOrders: async () => [],
      fetchTokenBalance: async () => 0,
      placeQuote: async (quote: QuoteIntent) => {
        placed.push(quote);
        return { success: true, status: "live", orderId: `order-${placed.length}`, raw: {} };
      }
    },
    inventory,
    config
  );

  await engine.onUserFill({ assetId: "yes-17", side: "BUY", price: 0.29, shares: 6, traderSide: "MAKER" });

  assert.equal(inventory.getPosition("0x17").shares, 6);
  assert.equal(placed.length, 1);
  assert.equal(placed[0]?.side, "SELL");
  assert.equal(placed[0]?.price, 0.30);
  assert.equal(placed[0]?.postOnly, true);
});

test("WeatherExecutionEngine requeues cancelled SELL when inventory remains", async () => {
  const placed: QuoteIntent[] = [];
  const inventory = new InventoryEngine();
  inventory.applyFill({ conditionId: "0x17", tokenId: "yes-17", side: "BUY", price: 0.29, shares: 6 });
  const engine = new WeatherExecutionEngine(
    [event],
    {
      cancelAll: async () => ({}),
      cancelOrder: async () => ({}),
      getOpenOrders: async () => [],
      fetchTokenBalance: async () => 0,
      placeQuote: async (quote: QuoteIntent) => {
        placed.push(quote);
        return { success: true, status: "live", orderId: `order-${placed.length}`, raw: {} };
      }
    },
    inventory,
    config
  );

  await engine.onOrderUpdate({ assetId: "yes-17", side: "SELL", status: "CANCELLED", sizeMatched: 0 });

  assert.equal(placed.length, 1);
  assert.equal(placed[0]?.side, "SELL");
  assert.equal(placed[0]?.price, 0.30);
});
