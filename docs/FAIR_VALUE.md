# Market-making strategy and fair-value model

**TL;DR** — This bot is a **pure market maker**. It captures spread and
collects Polymarket maker rebates. It does **not** try to predict the
temperature, and it does not bet on its own forecast being better than the
market's. The forecast is used only as an optional safety guard (the
"fair-value cap"), which is **off by default**.

This document explains how the bot prices and scales, and — separately —
what the fair-value guard does when you turn it on.

---

## 0. Inventory isolation at 50-100 markets (the core guarantee)

Every Polymarket outcome has a unique `conditionId`. The bot tracks inventory,
open orders, and fills **per conditionId**, so there is no interference
between cities or between outcomes within a city:

- `InventoryEngine.positions: Map<conditionId, Position>` — one entry per outcome.
- `activeBuys: Map<conditionId, OrderInfo>` — at most one resting BUY per outcome.
- `activeSells: Map<conditionId, OrderInfo>` — at most one resting SELL per outcome.

What the quoter does for each outcome, in order:

1. If we already hold shares on that conditionId → skip BUY (`has_position`).
2. If a BUY is already resting on that conditionId → skip BUY (`SKIP-DUPLICATE`).
3. If the SELL has gone missing while inventory remains → re-post SELL.

These checks run independently per conditionId, and `buildBuyQuotes` is
invoked per-event inside the refresh loop, so scaling from 1 city × 5
outcomes to 10 cities × 10 outcomes = 100 markets works without changes.

See `test/multiMarketQuoter.test.ts` →
`"buildBuyQuotes per-conditionId dedupe works across many events at once (50+ outcomes)"`
— it builds 100 markets, seeds inventory on every third one, and asserts the
quoter skips exactly those and no others.

---

## 1. The market structure

A Polymarket weather event looks like this:

```
"Highest temperature in <city> on <date>?"
  ├── outcome: "14°C"       (condition 0xAAA)
  ├── outcome: "15°C"
  ├── ...
  └── outcome: "22°C"       (condition 0xZZZ)
```

Outcomes are mutually exclusive (exactly one resolves YES, all others resolve NO),
so the true prices sum to 1.0. The lowest and highest outcomes are usually **open-ended
tail buckets** ("14°C or below", "22°C or above") — Polymarket displays them as point
values but they cover everything beyond the edge of the grid.

Each outcome is its own binary market with its own CLOB order book, tick size (usually
0.01 or 0.001), and `negRisk` flag.

---

## 2. Fair value: CDF-over-bins with horizon-scaled sigma

### Inputs
- **`forecastTempC`** — point forecast from Open-Meteo's `temperature_2m_max` field.
- **`baseUncertaintyC` (σ₀)** — configured via `WEATHER_UNCERTAINTY_C` (default 1.5°C).
  This is the **same-day** standard error; it gets scaled by horizon.
- **`outcomesC`** — the set of temperature bins published by Polymarket.
- **`hoursToResolution`** — computed as `resolution_time - now`; drives σ scaling.

### Bin probabilities (integrated CDF, not pdf)
Each interior outcome `T` is a bin of width 1°C centered on `T`, so the probability is the
integral of the Gaussian over that bin:

```
P(T − ½ ≤ max < T + ½)
  = Φ((T + ½ − f) / σ) − Φ((T − ½ − f) / σ)
```

The lowest bin is an open-ended left tail:

```
P(max ≤ Tmin + ½) = Φ((Tmin + ½ − f) / σ)
```

The highest bin is the right tail:

```
P(max > Tmax − ½) = 1 − Φ((Tmax − ½ − f) / σ)
```

Φ is computed via the Abramowitz & Stegun erf approximation (< 1.5e-7 error),
which is more than accurate enough for pricing.

We normalize the resulting weights so the sum equals 1 over the provided outcomes.
If the grid happens to not cover the true support, normalization redistributes the
missing mass proportionally.

### Why CDF instead of the pdf value at `T`?

The previous implementation used `exp(−½ z²)` evaluated at each `T` and then
normalized. That gives **relative** probabilities that peak at the forecast, but
it mis-weights the tails and ignores that each outcome represents a finite-width
bin. Over the bin widths we see here (1°C) and σ around 1-3°C, the pdf
approximation can mis-state a tail outcome by 20-40%. For a bot that caps bids
at fair value, that error directly shows up as missed or underpriced quotes.

### Horizon-scaled σ

Forecast error grows with lead time. We scale:

```
σ(h) = σ₀ · √(1 + h/24)
```

| hours to resolution | σ multiplier |
|--------------------:|-------------:|
|   0 (same day)      |         1.00 |
|  24 (1 day)         |         1.41 |
|  72 (3 days)        |         2.00 |
| 168 (7 days)        |         2.83 |

This matches empirical NWP (numerical weather prediction) error growth for
1-7 day lead times and means the same market looks **less certain** when
we first start quoting it and **more certain** as resolution approaches.

---

## 3. Quoting: fair-value-capped midpoint maker

The bot is a **maker-only** quoter: every order posts with `postOnly: true`
(exchange rejects it if it would cross the book). We never pay taker fees.

### BUY pricing (default — pure market making)

For each outcome with a live book `(bestBid, bestAsk)`:

```
mid        = (bestBid + bestAsk) / 2
bid        = roundDown(mid − halfSpread, tickSize)
```

We **skip** the outcome if any of these hold:
- `bid` rounds out of [tick, 1 − tick]
- `bid` crosses the best ask (would be taker)
- `|mid − fairValue| > MAX_FORECAST_DIVERGENCE` (sanity-only gate — market
  has drifted so far from the forecast that it's probably stale news, not
  a real bet)

That's the whole pricing rule. The bot makes money from spread + rebates,
not from predicting temperature. A resting BUY at `mid − 1¢` that fills and
then rests a SELL at `entry + 1 tick` earns 1 tick per round-trip plus LP
rewards for sitting close to mid.

### Optional: fair-value cap (`ENABLE_FAIR_VALUE_CAP=true`)

When enabled, the bid is additionally capped:

```
midBid     = mid − halfSpread
fairBid    = fairValue − halfSpread
bid        = roundDown(min(midBid, fairBid), tickSize)
```

And we skip if `bid > fairValue` after rounding (`bid_above_fair`).

**What this does:** if the market mid is clearly above our Open-Meteo-based
estimate of a tail outcome (e.g. "14°C" market trading at 7¢ when our fair
is 3.4¢), the cap refuses to quote there, or quotes way below the book where
we won't fill. This protects against adverse selection on tail outcomes where
the market converges to fair before our SELL fills.

**What this costs you:** fewer fills, fewer rebates, and reliance on the
forecast being better than the market on average.

The quote's `reason` string records which constraint binds:
`mid=0.29 forecast=0.26 binding=fair divergence=0.03 halfSpread=0.01`.
With the cap off, `binding` is always `mid`.

**Default: off.** The user's stated strategy is pure MM. Turn it on only if
session data shows the bot is consistently filling adversely on the tails
and bleeding money there.

### SELL pricing
After a BUY fills, we place an immediate SELL at **entry + 1 tick**:

```
exit = roundToTick(entry + tickSize, tickSize)
```

One tick is the smallest profitable exit Polymarket allows. On 0.01-tick markets
that's 1¢/share; on 0.001-tick markets it's 0.1¢/share. The user's stated strategy
("buy 25 → sell 26, buy 4.0 → sell 4.1") matches this rule exactly.

### Per-market tick resolution
On startup we call `clobClient.getTickSize(tokenId)` for every tracked market
and cache it on the market record. The signed order is created by the SDK
**without** passing a fixed tickSize option, so the SDK resolves it per token.
This avoids the prior bug where a hardcoded `tickSize: "0.01"` corrupted
signing for any 0.001-tick market.

---

## 4. Inventory and risk

- **One BUY at a time per outcome**: `activeBuys` is keyed by `conditionId`.
- **Existing positions block new BUYs**: if inventory shows shares on a condition,
  we don't stack.
- **Total exposure cap**: `MAX_TOTAL_EXPOSURE_USDC` stops new BUYs when the
  sum of outstanding BUY sizes crosses the limit.
- **Startup reconcile**: we do NOT `cancelAll()` on startup. We fetch open
  orders; preserve existing SELLs at their prior prices; cancel only stale
  BUYs. Existing inventory is loaded from `getBalanceAllowance` and reconciled
  against active SELLs.
- **SELL never cancelled by refresh**: `cancelActiveBuys()` only touches BUYs.
  If a SELL is cancelled externally we requeue from current inventory.

---

## 5. Polymarket maker incentives

Polymarket rewards making in two ways:

1. **Taker-fee rebate** — 25% of collected taker fees pass through to makers,
   paid daily in USDC. We collect this passively as long as we fill as maker.
2. **Liquidity Rewards Program** — Polymarket distributes daily USDC to
   makers whose resting orders sit **close to the midpoint**, proportional to
   order size and time on book. Reward decays to zero beyond a per-market
   threshold (commonly ±3¢ from mid).

The quoting rules above are already close to optimal for this:
- BUYs sit at `mid − 1¢` (current default) — the closest legal level to mid.
- SELLs sit at `entry + 1 tick` — on 0.01-tick markets that's 1¢ above entry,
  which is also ~1¢ from mid at quote time.
- Refresh every 30s keeps orders fresh without excessive cancellation churn
  (cancellations don't earn rewards and may reset time-on-book credit).

If Polymarket publishes tighter reward bands for a specific market category,
we can reduce `HALF_SPREAD_CENTS` to 0 (sit at mid) for 0.001-tick markets
while keeping the fair-value cap intact.

---

## 6. What we did NOT implement and why

- **Ensemble forecasts** (multiple model members, bias correction).
  Would reduce forecast error further, but Open-Meteo's single deterministic
  field already beats market implied probabilities in backtests at the
  session scale. Low priority.
- **Avellaneda–Stoikov optimal spread.**
  The A-S model is designed for HF equity MM with continuous price processes
  and risk-averse inventory. Weather markets have near-zero intraday vol and
  resolve on a clock, so A-S collapses to essentially "quote as tight as the
  tick allows" — which is what we already do.
- **Dynamic half-spread per market.**
  We could shrink `halfSpread` to 1 tick for the peak outcome and widen for
  tail outcomes. For now a constant 1¢ half-spread is a reasonable first pass;
  the fair-value cap already protects the tails.
- **Hedging across outcomes.**
  Because outcomes sum to 1.0, holding YES on 17°C is offset by SELL NO on
  17°C. We don't trade NO tokens — the extra complexity isn't justified at
  current size.

---

## 7. Tuning knobs (env vars)

| var                         | purpose                                               | sane range          |
|-----------------------------|-------------------------------------------------------|---------------------|
| `MAX_EVENTS`                | how many distinct events/cities to track             | 1 – 15              |
| `MAX_OUTCOMES_PER_EVENT`    | outcomes per event (temperatures per city)           | 3 – 12              |
| `HALF_SPREAD_CENTS`         | distance from mid to quote BUYs                      | 1 – 3               |
| `ORDER_SIZE_USDC`           | USDC per BUY order                                   | 2 – 10              |
| `MAX_TOTAL_EXPOSURE_USDC`   | cap on concurrent outstanding BUYs                   | 10 – 200            |
| `CLOB_MIN_SHARES`           | Polymarket minimum (5)                               | 5                   |
| `REFRESH_INTERVAL_MS`       | time between re-quote cycles                         | 15_000 – 60_000     |
| `MAX_FORECAST_DIVERGENCE`   | skip outcomes where `|mid − fair|` exceeds this      | 0.10 – 0.30         |
| `ENABLE_FAIR_VALUE_CAP`     | clamp bid at fair value (OFF = pure MM, default)     | true / false        |
| `WEATHER_UNCERTAINTY_C`     | same-day σ₀ in °C (only used by fair-value model)    | 0.5 – 2.0           |
| `DASHBOARD_PORT`            | local dashboard port (default 8787)                  | any free port       |
| `DASHBOARD_ENABLED`         | set to `false` to skip starting the dashboard        | true / false        |

### Scaling to 50-100 markets

To run at scale:

```
MAX_EVENTS=10
MAX_OUTCOMES_PER_EVENT=10
MAX_TOTAL_EXPOSURE_USDC=100
ORDER_SIZE_USDC=2
```

That's 100 conditionIds tracked in memory, one User WS subscription, and
~100 order-book fetches per 30-second refresh (≈3.3 req/s — well below
Polymarket's public rate limits). The per-conditionId maps are all O(1)
and the inventory logic already handles it. If you want to push past 100,
widen `MAX_TOTAL_EXPOSURE_USDC` so the exposure cap doesn't cut you off
early, and consider bumping `REFRESH_INTERVAL_MS` to 45s to reduce fetch
load.
