# Data sources — what we have, what we use, what we don't

Authoritative map of the Polymarket data we pull, the fields we actually
consume from each response, and the endpoints that exist but we haven't
wired yet. Derived from `@polymarket/clob-client` v5.8.1 (the version in
`package.json`).

---

## REST — CLOB (`https://clob.polymarket.com`)

### In use

| endpoint | where | fields we use |
|---|---|---|
| `GET /book?token_id=X` | `src/execution/orderBookClient.ts:fetchOrderBookTop` | `bids[]`, `asks[]`, `tick_size`, `neg_risk` — now parsed into full depth arrays. |
| `GET /tick-size` (SDK `getTickSize`) | `ClobDriver.resolveTickSize` | returned as `TickSize` union (`"0.1" \| "0.01" \| "0.001" \| "0.0001"`). |
| `GET /neg-risk` (SDK `getNegRisk`) | `ClobDriver.resolveNegRisk` | boolean. Critical for order signing. |
| `GET /data/orders` (SDK `getOpenOrders`) | startup reconcile + missed-fill detection | `id`, `asset_id`, `side`, `price`. |
| `GET /balance-allowance` (SDK `getBalanceAllowance`) | `ClobDriver.fetchTokenBalance` + startup-position load | `balance` string (parsed to float). |
| `POST /order` | `ClobDriver.placePostOnlyOrder` / `placeTakerExit` | `success`, `status`, `orderId`, `errorMsg`. |
| `POST /order` (cancel-by-id) | `ClobDriver.cancelOrder` | ack only. |

### Available, not wired yet

| endpoint | what it gives us | why wire it |
|---|---|---|
| `GET /prices-history` (SDK `getPricesHistory`) | `{t, p}[]` at interval `1h`/`6h`/`1d`/`1w`/`max` | **Backtest fuel.** Wired in `scripts/backtest.mjs` and `src/simulation/backtest.ts`. Used to validate live strategy against real history. |
| `GET /data/trades` (SDK `getTrades`) | full fill tape for our account with fee rates and maker/taker | reconcile realized PnL end-of-session; confirm rebates paid. |
| `GET /midpoint` (SDK `getMidpoint`) | scalar midpoint | same as averaging top-of-book, cheap alternative if we want finer-grained sampling. |
| `GET /last-trade-price` | most recent trade price | useful for "is this book stale?" checks. |
| `GET /rewards/*` | per-market LP reward config and our historical earnings | let us compute expected LP reward precisely instead of the crude proxy in the MC sim. |
| `GET /live-activity/events/` | activity feed | low priority; WS is better. |
| `GET /simplified-markets` | condensed market directory | alternative to Gamma for discovery. |
| `GET /markets/<id>` | single-market metadata including reward config | could replace parts of the Gamma discovery call. |

---

## REST — Gamma (`https://gamma-api.polymarket.com`)

### In use

| endpoint | where | fields we use |
|---|---|---|
| `GET /events?tag_id=84&...` | `src/adapters/weatherDiscovery.ts:findActiveWeatherEvents` | events[].{id, title, eventDate, markets[].{conditionId, clobTokenIds, outcomePrices, volume24hr, enableOrderBook, closed, resolved}}. |

### Available, not wired yet

- `GET /events/<id>` — single event metadata
- `GET /markets` — flat market list
- `GET /tags` — category taxonomy

---

## WebSocket

### In use

| stream | URL | fields we consume |
|---|---|---|
| **User** | `wss://ws-subscriptions-clob.polymarket.com/ws/user` | `TRADE`/`FILL` events (side, price, size, trader_side) and `ORDER_UPDATE` events (status=CANCELLED). Subscribed by `conditionIds`. |

### Available, not wired yet

| stream | URL | what it gives us |
|---|---|---|
| **Market** | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Incremental L2 book updates per asset. **The one missing feed.** Would let us keep a live local book without polling REST every refresh cycle; foundation for queue-position modeling. |

---

## Open-Meteo (`https://api.open-meteo.com/v1/forecast`)

In use via `src/adapters/weatherFeed.ts:fetchOpenMeteoForecast`.
Consumes only `daily.temperature_2m_max[index matching event date]`.

Available extras we don't use:

- `temperature_2m_min` — could widen the fair-value model for overnight-resolved markets.
- Ensemble models (`ecmwf_ifs04`, `gfs_seamless` etc.) — multiple forecasts for uncertainty estimation instead of the fixed `WEATHER_UNCERTAINTY_C`.
- `precipitation`, `windspeed` — irrelevant for weather *temperature* markets but needed if Polymarket adds precipitation markets.

---

## What we deliberately can't / don't scrape

- **On-chain trade tape from Polygon subgraph.** Alternative to `/data/trades` for cross-verification. Not needed while CLOB REST works.
- **Bookmap-style L3 data** (individual order ids in queue). Polymarket doesn't publish this; you'd need to reverse it from WS L2 increments, which is fragile. Out of scope.
- **Other market-maker flow.** Cannot attribute fills to specific counterparties.

---

## Network access requirements

All endpoints require outbound HTTPS. The user's PyCharm environment has
it; the sandbox environment this repo was developed in does not (403 on
all Polymarket hosts). That's why runtime testing and the `scripts/*.mjs`
runners are expected to be executed on the user's machine.
