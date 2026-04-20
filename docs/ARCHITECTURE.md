# Architecture

## Runtime Flow

1. Discover active Weather-tagged Gamma events with `tag_id=84`.
2. Parse each temperature event into binary YES/NO outcome markets.
3. Fetch Open-Meteo daily max temperature for the exact event city/date.
4. Convert forecast high plus configured uncertainty into a normalized probability distribution.
5. Emit post-only BUY YES quote intents at `fair - halfSpread`.
6. In `DRY_RUN_LIVE=true`, write receipts to JSONL instead of calling the CLOB.

## Components

- `src/adapters/weatherDiscovery.ts`: Gamma API integration and multi-outcome parsing.
- `src/adapters/weatherFeed.ts`: Open-Meteo forecast integration.
- `src/core/weatherFairValue.ts`: normal-distribution fair value.
- `src/core/multiMarketQuoter.ts`: quote generation and SELL-on-fill construction.
- `src/execution/dryRunBroker.ts`: safe dry-run execution sink.
- `src/main.ts`: one-shot dry-run-live runner.

## Boundaries

Real exchange mutation is deliberately disabled until CEO review. When `LIVE_API_ENABLED=true` and `DRY_RUN_LIVE=false`, config validation requires CLOB credentials and the current runner fails closed rather than placing unreviewed orders.

## Success Criteria

- `npm test` passes.
- `npm run dry-run-live` discovers at least one future weather event.
- Evidence file contains event, markets, forecast, fair values, post-only quotes, and `[TAKER-CRITICAL] = 0`.
