# Polymarket Weather Temperature Market Maker

Minimal TypeScript bot for weather temperature markets.

## Modes

- `DRY_RUN_LIVE=true`: fetches live Gamma weather events and Open-Meteo forecasts, computes fair values, builds post-only maker BUY intents, and writes dry-run receipts.
- `LIVE_API_ENABLED=false`: real CLOB order placement is disabled until CEO review.

## Run

```powershell
npm install
npm test
npm run stop-crypto
$env:DRY_RUN_LIVE="true"; $env:MAX_EVENTS="1"; npm run dry-run-live
```

Dry-run evidence is written to `data/weather-dry-run-evidence.json`.

## Architecture

- `src/adapters/weatherDiscovery.ts`: Gamma API discovery and multi-outcome market parsing.
- `src/adapters/weatherFeed.ts`: Open-Meteo daily max temperature fetch.
- `src/core/weatherFairValue.ts`: normal-distribution fair-value probabilities.
- `src/core/multiMarketQuoter.ts`: post-only BUY quote intents and SELL-on-fill quote construction.
- `src/execution/dryRunBroker.ts`: receipt writer for dry-run live checks.

## Safety

Secrets are read only from environment variables. `.env*`, pid files, and order/evidence artifacts are ignored by git. Real live trading intentionally throws unless `DRY_RUN_LIVE=false` support is implemented and reviewed.
