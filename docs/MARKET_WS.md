# Market WebSocket integration plan

## What shipped

`src/execution/marketWebSocket.ts` + `test/marketWebSocket.test.ts`. This is
the *client* and the *local book mirror*. It connects to
`wss://ws-subscriptions-clob.polymarket.com/ws/market`, subscribes by
`asset_id`, parses `book` / `price_change` / `tick_size_change` events,
and maintains an L2 book per asset that any consumer can read synchronously
with `ws.book(assetId)`.

What's NOT shipped: wiring it into `WeatherExecutionEngine` / the refresh
loop. That's a deliberate choice — it changes the live behavior materially
and the sandbox this repo was developed in can't reach Polymarket WS to
validate the wiring end-to-end. I'd rather ship the foundation with tests
than ship an untested engine rewrite.

## Current live loop (REST-timer driven)

```
every REFRESH_INTERVAL_MS (30s):
  cancelActiveBuys()
  for each market:
    book = await fetchOrderBookTop(tokenId)   // REST poll
    recordMid(conditionId, mid)
  buildBuyQuotes(...)
  placeBuyQuotes(...)

user-ws onFill(...) → placeSellForFill()
```

## Target live loop (market-WS driven, minimally invasive)

```
on startup:
  marketWs = new MarketWebSocket({ assetIds, handlers })
  marketWs.connect()
  marketWs.onBook = (assetId, book) => engine.onBookUpdate(assetId, book)

engine.onBookUpdate(assetId, book):
  recordMid(...)                               // unchanged
  if timeSinceLastRefresh(condition) >= minQuoteAgeMs:
    rebalanceOneOutcome(conditionId, book)     // per-outcome re-quote

rebalanceOneOutcome:
  cancel existing BUY if stale
  compute new bid via buildBuyQuotes on the ONE market
  place if different from current
```

Key points of the integration:

1. **Event-driven, not timer-driven.** Re-quoting fires when the book
   actually changes, not on a fixed cadence. Good for latency, bad if the
   book changes 10×/sec on a hot market — we'd rate-limit ourselves with
   `minQuoteAgeMs` (default 2000ms) to avoid cancel-churn.
2. **Per-outcome not per-event.** The current refresh re-quotes every
   market in every event on a global timer. WS-driven refresh touches only
   the market whose book changed, so we do less work and react faster.
3. **REST polling becomes a fallback.** Keep the 30s timer for staleness
   detection (if WS hasn't delivered an update for a market in 60s,
   fall back to REST).
4. **User WS stays as-is.** It already handles fill/cancel events for our
   own orders; that piece doesn't change.

Order of operations for the next PR:

1. Add `WeatherExecutionEngine.onBookUpdate(assetId, book)` — a public
   method that performs the per-outcome re-quote decision.
2. Add `minQuoteAgeMs` config (default 2000).
3. Connect `MarketWebSocket` in `main.ts` alongside the existing `UserWebSocket`.
4. Keep the refresh-loop timer but shorten it to a fallback role: skip
   markets whose book was WS-updated within the last 60s.
5. Behavior change: our quote now responds in ~200ms to a book move
   instead of up-to-30s.

## What the market-WS gains us (and what it doesn't)

Gains:
- Sub-second reaction to book moves → less stale-quote adverse selection
- Lower REST load → easier to scale to 100+ markets without rate limits
- Enables queue-position modeling later (we see every book delta in order)
- Enables cross-side quoting later (watching NO-side book is free once
  we're already subscribed to markets)

Doesn't gain:
- It doesn't change EV per round-trip (still 1 tick per pair)
- It doesn't help with LP rewards (those are time-on-book, not speed)
- It doesn't compete against colo'd HFT (we're on retail Node + retail
  internet; we'll never win latency races — just stop losing them as often)

## Gotchas that I know about

- Polymarket's WS occasionally sends `PONG` text frames or bare keepalives;
  the client ignores non-JSON. Confirmed.
- `price_change` deltas use both `BUY`/`BID` and `ASK`/`SELL` labels; both
  handled.
- Tick-size-change events DO happen (mid-market Polymarket re-tiers). The
  local book mirrors the new tick. Verified.
- Reconnect is implemented with capped exponential backoff. No subscription
  replay yet — on reconnect we re-subscribe to the original asset list. If
  we add dynamic market add/remove later, we'll need a sub-state map.
