# Polymarket Weather Bot

Weather-confirmed directional trading on Polymarket's daily temperature markets.

## Strategy (v10)

When actual temperature observations (from METAR airport stations —
Polymarket's resolution source) have **already exceeded the market's
threshold with a 0.5°C buffer**, the NO outcome is near-certain (max-temp
is monotonic during a day — once exceeded, can't go back below).

We enter NO at current price (0.70-0.99), place a limit sell at 0.999 as
an opportunistic exit, and **hold to resolution** for $1.00 settlement
otherwise. Disabled stop-loss since weather fact doesn't change.

**Backtest results (Mar-Apr 2026, 47.6 days)**:
- **98.8% strict WR** (1,272/1,288 trades)
- **1.2% loss rate** (15 trades; 13 from station-mapping mismatches on
  Buenos Aires / Wellington / Hong Kong — can be fixed)
- **$122.62/day at $40 sizing** (projected $1,533/day at $500/trade)

## Pipeline

### 0. One-time setup
```bash
npm install
```

### 1. Fetch market + data (1-time, ~3 hours total)
```bash
# Catalog all weather markets in last 1 year (~5 min)
npm run fetch-weather-markets

# Fetch tick history for each market (~2-3 hours)
npm run fetch-tick-history

# Fetch hourly weather observations (~10 min)
npm run fetch-weather-history

# Fetch METAR (airport observations) — matches Polymarket's resolver
npm run fetch-metar

# Build resolution ground-truth index
npm run build-resolution-index
```

### 2. Run backtest
```bash
npm run backtest
```

### 3. Live detection (no capital at risk)
```bash
npm run detect                # scan every 5 min
npm run detect -- --once      # single scan
```

Produces `data/detect-log.jsonl` with every opportunity the engine
identifies. Use this to validate signals fire in real time before
committing capital.

### 4. Live trading (WIP)

Coming next: `live-bot.mjs` that uses the same detection logic and
places real orders via Polymarket CLOB.

## File structure

```
scripts/
  backtest.mjs                 # Main backtest engine (v10)
  detect.mjs                   # Live opportunity detection (shadow mode)
  build-resolution-index.mjs   # Derive/lookup market resolutions
  fetch-*.mjs                  # Data acquisition scripts
  analyze-wallets.mjs          # Wallet-strategy research tool
  validate-backtest.mjs        # Cross-check backtest vs actual wallet PnL

data/
  tick-history/                # Per-market tick data (from Polymarket)
  metar-observations/          # METAR airport observations
  weather-history/             # Open-Meteo hourly temps
  weather-markets-catalog/     # Gamma API market catalog
  resolved-market-cache/       # Polymarket price-history + resolution
  wallet-trades/               # Winning-wallet trade history (research)
  resolution-index.json        # Merged resolution truth per market
  market-titles.json           # Title lookup per conditionId
  metar-stations.json          # City → ICAO airport mapping
  detect-log.jsonl             # Live detection signals
```

## Key parameters (in `npm run backtest`)

| Flag | Value | Meaning |
|---|---|---|
| `--minentry` | 0.70 | Minimum NO price to enter |
| `--maxentry` | 0.99 | Maximum NO price to enter |
| `--ttrmin` | 1800 | Min time-to-resolution (30 min) |
| `--ttrmax` | 28800 | Max time-to-resolution (8 hours) |
| `--maxhold` | 240 | Max position hold time (4 hours) |
| `--crossedbuf` | 0.5 | °C buffer for threshold-crossed check |
| `--tradesize` | 40 | USDC per trade |
| `--filtertype` | exact | Market type filter |
| `--filterunit` | C | Unit filter (C only) |
| `--asymmetric` | false | Symmetric check (catches both directions) |

## Deployment plan

1. **Refactor + detect engine** — DONE (this state)
2. **Run detect for 24-48h** — confirm signals appear on live markets
3. **Build live-bot.mjs** with nano sizing ($1-2/trade)
4. **Deploy with $50 exposure** — validate fills
5. **Scale up** once live ≈ backtest within ±20%

Do NOT skip step 4 — paper trading can't validate maker fill rates.
