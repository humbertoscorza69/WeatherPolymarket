# Operator Runbook

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Keep all secrets in environment variables or `.env`; never commit them.

## Stop Crypto Bot

```powershell
npm run stop-crypto
```

The helper removes `data/bot.pid` and `data/live.pid` if present. Exchange open-order confirmation still requires valid Polymarket credentials and should be done before enabling real live trading.

## Validate

```powershell
npm test
```

## Dry-Run Live

```powershell
$env:DRY_RUN_LIVE="true"
$env:LIVE_API_ENABLED="false"
$env:MAX_EVENTS="1"
npm run dry-run-live
```

Review:

- `data/weather-dry-run-evidence.json`
- `data/dry-run-orders.jsonl`

Expected: post-only BUY intents only, no CLOB order mutation, `[TAKER-CRITICAL] = 0`.

## Production-Hardening Checklist

- Add reviewed CLOB order driver for `DRY_RUN_LIVE=false`.
- Add authenticated open-order cancellation and zero-open-order verification.
- Wire User WebSocket fill events into `buildSellOnFill`.
- Add durable inventory snapshots per conditionId.
- Add Prometheus or JSON metrics export for quote counts, fills, latency, and errors.
- Run CEO-reviewed live canary with one event and hard exposure caps.
