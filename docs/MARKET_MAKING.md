# Market-making strategy: theory, risks, simulation

This doc is the engineering-level reasoning behind the bot. It explains what
edges we are trying to capture, what can kill us, and how the three
risk-management layers (fair-value cap, inventory skew, stop-loss) actually
interact under Monte Carlo stress. Read this before changing any of the
pricing or risk env vars.

---

## 1. Where the edge comes from

A Polymarket maker-only strategy on weather markets has three real edges and
two imaginary ones.

Real:
1. **Tick spread capture.** Buy at `mid − halfSpread`, sell at `entry + 1 tick`.
   Profit per round-trip = `tickSize × shares` minus nothing (no taker fees,
   postOnly-enforced). On a 0.01-tick market at $2 per order ≈ 7 shares,
   that's $0.07 per round-trip.
2. **Taker-fee rebate.** Polymarket passes 25% of the 1.25% taker fee paid by
   our counterparty back to us as makers. On a $2 fill that's ≈ $0.006 extra.
3. **Liquidity Rewards Program.** Polymarket pays daily USDC to makers whose
   resting orders sit close to midpoint, proportional to size × time-on-book.
   Reward decays to zero past a per-market threshold (commonly ±3¢).

Imaginary (tempting but dangerous):
- **"Better forecast than the market."** Possible on long-tail outcomes, but
  in practice the market consolidates forecast information from many sources.
  Don't bet on it being consistently wrong. See `docs/FAIR_VALUE.md`.
- **"Capturing wider spreads with wider quotes."** Profit per round-trip is
  fixed at 1 tick regardless of how far below mid we bid. Widening our quote
  just reduces fill rate, with no P&L benefit.

## 2. Expected value of one round-trip

```
E[profit] = tickSize × shares × P(BUY fills) × P(SELL fills | BUY filled)
          + rebate_from_BUY_counterparty × P(BUY fills)
          + rebate_from_SELL_counterparty × P(BUY filled) × P(SELL fills | …)
          + E[LP_rewards over time-on-book]
          − E[stop-loss cost]
          − E[unrealized loss at resolution]
```

Optimization levers:
- **Maximize P(fill):** stay close to mid, keep orders resting instead of
  churning cancels, quote during high-activity hours.
- **Minimize stop-loss cost:** cut losers fast (next section) so they don't
  become 100% losses at resolution.
- **Minimize unrealized loss at resolution:** this is the real tail risk —
  if we hold shares at 0.30 and the outcome resolves NO, we lose 100% of
  that capital. Stop-loss exists to cap this.

## 3. What actually kills us (the "mean-reversion trap")

When the market mid starts far from the true probability `p_true` and then
reverts, our first BUY gets filled near the initial mid, our SELL sits at
`entry + 1 tick` above, and the market walks down toward `p_true` without
ever revisiting our SELL. That position stays open until resolution, where
the outcome resolves NO and we lose 100% of the position's cost.

This is the classic "picking up pennies in front of a steamroller" failure
mode of naive MM. The longer we rest without stopping out, the worse it
gets.

We defend against it with three independent layers, each off-or-on via env:

### Layer A — Fair-value cap (`ENABLE_FAIR_VALUE_CAP`, default OFF)
Skip outcomes where the market mid is far above our forecast-derived fair
value. Prevents entering the trap in the first place when our forecast is
confident. Off by default because (a) we're market making, not forecasting,
and (b) a bad forecast silently shuts us out of real edge.

See `docs/FAIR_VALUE.md`.

### Layer B — Inventory skew (`INVENTORY_SKEW_CENTS`, default 2)
As current open exposure approaches `MAX_TOTAL_EXPOSURE_USDC`, widen the BUY
spread linearly. At 0% utilization we quote at `mid − HALF_SPREAD_CENTS`;
at 100% utilization we quote at `mid − (HALF_SPREAD_CENTS + INVENTORY_SKEW_CENTS)`.
This slows down concurrent-position accumulation during extended adverse
moves, without shutting down the strategy completely.

### Layer B′ — Realized-volatility widening (`VOL_MULTIPLIER`, default 1.0)
Classical MM theory (Avellaneda-Stoikov, Cartea-Jaimungal) says the optimal
half-spread should scale with σ. The intuition: when the book is calm, a 1¢
spread earns the maker rebate and the bid rests in the queue. When the book
is swinging 2-3¢ between refreshes, 1¢ is a hair-trigger: adverse micro-moves
fill us just before the market re-prices against us.

We track per-market realized stddev of mid returns (cent-denominated) over
a rolling window (`VOL_WINDOW_SIZE`, default 60 samples = 30 min at 30s
refresh). The effective half-spread becomes:

```
  utilization  = totalExposure / MAX_TOTAL_EXPOSURE_USDC
  volExtra     = min(VOL_MAX_EXTRA_CENTS, VOL_MULTIPLIER × stddevCents)
  halfSpread_c = HALF_SPREAD_CENTS + INVENTORY_SKEW_CENTS × utilization + volExtra
```

MC shows this is the single most valuable tweak in adverse regimes: going
from `VOL_MULTIPLIER=0` to `VOL_MULTIPLIER=1.0` lifts adverse-regime mean
from $0.591 → $0.728 per session (24% improvement) with near-identical
mixed-regime performance. The cost is slightly fewer fills in volatile
moments, which is a feature, not a bug — those fills tend to be the
adversely-selected ones.

### Layer C — Stop-loss (`STOP_LOSS_ENABLED`, default TRUE)
Four independent triggers; any one fires → exit via the hybrid ladder.

| rule                      | condition                                                              | urgency | default           |
|---------------------------|------------------------------------------------------------------------|---------|-------------------|
| `CATASTROPHIC_DROP`       | `mid / entry ≤ 0.30`                                                   | urgent  | 30%               |
| `DEEP_DROP_STALE`         | `mid / entry ≤ 0.60` AND held > 120 min                                | patient | 60% / 2h          |
| `NEAR_RESOLUTION_ADVERSE` | `hoursToResolution ≤ 1` AND `mid / entry < 0.70`                       | urgent  | 1h / 70%          |
| `MAX_HOLDING`             | `held > 12h` regardless of price                                       | patient | 12h               |

#### Why taker, not "limit stop" like TP?

Take-profit and stop-loss look symmetric (both are a SELL) but the
execution problem is asymmetric:

| | TP | SL |
|---|---|---|
| Price level | above mid | below mid |
| Market drift's relationship to us | helps us (mid can oscillate up into our limit) | works against us (adverse drift moves mid away) |
| What happens if it doesn't fill | nothing bad — keep earning LP rewards, wait | **100% loss at resolution** |
| Urgency | none | high |

The failure mode of a pure-limit stop-loss is the **chasing trap**: place a
SELL at bestAsk, market drops 1¢, bestAsk is now below our SELL, we cancel
and re-place at new bestAsk, market drops again, repeat. Net exit price
ends up *worse* than simply crossing with a taker once.

But pure-taker-always is also wrong. On `MAX_HOLDING` where we're timing out
rather than cratering, we have time to try a maker exit first. So we run a
**hybrid ladder**:

- **Urgent** (`CATASTROPHIC_DROP`, `NEAR_RESOLUTION_ADVERSE`): immediate taker
  SELL (FAK, postOnly=false) at bestBid. Certainty > slippage.
- **Patient** (`DEEP_DROP_STALE`, `MAX_HOLDING`): cancel TP, place a
  **maker SELL at bestAsk** (the new best ask). Wait
  `STOP_LOSS_MAKER_EXIT_WAIT_SECONDS` (default 90). If a buyer lifts us in
  that window → no taker fee, possibly small gain. If we time out → escalate
  to taker.

MC numbers (adverse regime, 5000 episodes):
- `aggressive 0¢ + SL`: mean **-$0.034** / session, p05 **-$3.03**. 1¢ is
  too tight with any informed flow — the reason "quote as tight as the tick"
  is wrong advice on Polymarket.
- `SL hybrid (maker→taker)` and `SL only (taker)` have nearly identical
  adverse p05 (both ≈ $0). Hybrid doesn't hurt; in mixed/stale markets it
  saves taker fees when it's not urgent.

## 4. Per-conditionId inventory isolation

Already documented in `docs/FAIR_VALUE.md §0`, repeating here because it's
central to multi-market scaling:

- `InventoryEngine.positions: Map<conditionId, Position>` — one entry per
  outcome, shared across all events.
- `activeBuys: Map<conditionId, OrderInfo>` — one resting BUY per outcome.
- `activeSells: Map<conditionId, OrderInfo>` — one resting SELL per outcome.
- `buildBuyQuotes` skips any outcome with `shares > 0` (`has_position`).
- `placeBuyQuotes` refuses duplicate BUYs on the same conditionId.

100 markets scale with no architectural changes. The Monte Carlo below models
a *single* market; the multi-market result is the sum of independent markets.

## 5. Monte Carlo results

Run `npm run simulate [episodes=1000]`. Simulator lives in
`src/simulation/marketMakerSim.ts`, CLI in `scripts/simulate.mjs`.

### 5a. What the simulator does

Each episode:
1. Draws a `p_true` ∈ [0, 1] uniformly.
2. Picks a regime: 60% friendly, 25% stale, 15% adverse.
3. Simulates a 10-hour session in 30-second steps:
   - Mid diffuses with drift toward `p_true` (regime-dependent) plus noise.
   - Counterparty orders arrive as a Poisson process; half are sellers (hit
     our BUY), half are buyers (hit our SELL).
   - Our strategy refreshes BUY quotes, places SELLs on fill, evaluates
     stop-loss each step.
4. Resolves the market at end of session: outcome is YES with probability
   `p_true`, so unresolved inventory is worth 1.0 or 0.0.
5. Reports realized P&L including fees, rebates (approximated), and LP
   rewards (approximated).

Assumptions that limit the simulator:
- No queue position modeling (we assume uniform fill probability conditional
  on depth-ahead draining).
- No informed-trader adverse selection specifically — we capture it indirectly
  via the "adverse" regime.
- LP rewards use a simple linear-decay proxy, not Polymarket's exact formula.
- One market per episode; no cross-market portfolio effects.

Use the output for *relative* strategy comparison, not absolute P&L
forecasts.

### 5b. Results (5000 episodes, mixed regime)

```
strategy                            mean   std    win%    p05    rtrips  stops  mkrSL takSL
baseline (1¢, no features)          0.191  1.125  99.6%   0.00    1.97   0.00   0.00   0.00
SL only (taker)                     0.172  0.868  99.7%   0.00    1.98   0.00   0.00   0.00
SL hybrid (maker→taker)             0.178  0.935  99.7%   0.00    1.95   0.00   0.00   0.00
skew 2¢ + SL hybrid                 0.199  1.079  99.5%   0.00    2.22   0.00   0.00   0.00
skew 2¢ + SL + vol×0.5              0.181  1.010  99.6%   0.00    1.97   0.00   0.00   0.00
skew 2¢ + SL + vol×1.0  ★           0.198  1.064  99.7%   0.00    2.03   0.00   0.00   0.00
skew 2¢ + SL + vol×2.0              0.222  1.392  99.7%   0.00    2.11   0.00   0.00   0.00
wider 2¢ + SL + vol×0.5             0.188  0.919  99.9%   0.00    2.05   0.00   0.00   0.00
aggressive 0¢ + SL                  0.143  1.191  97.4%   0.00    1.94   0.03   0.00   0.03
```

In calm/stale markets the strategies are hard to tell apart. The differences
show up in adverse.

### 5c. Pure-adverse stress (3000 episodes, informed-trader fraction 25-50%)

```
strategy                            mean   std    win%    p05    rtrips  stops  takSL
baseline (1¢, no features)          0.698  2.521  95.2%   0.001   5.01   0.00   0.00
SL only (taker)                     0.591  2.013  96.2%   0.001   4.86   0.09   0.09
SL hybrid (maker→taker)             0.606  2.118  95.5%   0.001   5.06   0.09   0.09
skew 2¢ + SL hybrid                 0.628  2.127  95.5%   0.001   4.80   0.09   0.09
skew 2¢ + SL + vol×0.5              0.643  2.432  96.3%   0.001   4.78   0.07   0.07
skew 2¢ + SL + vol×1.0  ★           0.728  2.316  97.1%   0.001   5.10   0.06   0.06
skew 2¢ + SL + vol×2.0              0.718  2.135  98.4%   0.001   4.97   0.03   0.03
wider 2¢ + SL + vol×0.5             0.821  2.353  99.2%   0.000   5.06   0.02   0.02
aggressive 0¢ + SL                 -0.034  2.631  80.6%  -3.031   4.20   0.53   0.52
```

Read the last row carefully: **a naive 0¢-spread strategy has mean P&L
of NEGATIVE $0.034 per session in adverse regimes, with p05 = -$3.03**.
Informed flow eats it alive. This is why "quote as tight as the tick" is
textbook wrong on Polymarket.

### 5d. Recommended defaults (MC-chosen)

Picked from the top-3 adverse-Sharpe strategies, cross-checked for sane
mixed-regime performance:

```
HALF_SPREAD_CENTS=1
INVENTORY_SKEW_CENTS=2
VOL_MULTIPLIER=1.0
VOL_MAX_EXTRA_CENTS=3
VOL_WINDOW_SIZE=60
STOP_LOSS_ENABLED=true
STOP_LOSS_CATASTROPHIC_DROP=0.30
STOP_LOSS_DEEP_DROP=0.60
STOP_LOSS_DEEP_DROP_MINUTES=120
STOP_LOSS_RESOLUTION_HOURS=1
STOP_LOSS_RESOLUTION_DROP=0.70
STOP_LOSS_MAX_HOLDING_HOURS=12
STOP_LOSS_MAKER_EXIT_WAIT_SECONDS=90
ENABLE_FAIR_VALUE_CAP=false
```

This is the `skew 2¢ + SL + vol×1.0` row (★). Adaptive: 1¢ quotes when the
book is calm, widens on its own when realized vol spikes, stop-loss ladder
protects the tail. Strong Sharpe in adverse (0.31), competitive mean in
mixed ($0.198), adverse p05 = $0.001 (tail fully protected).

## 6. Operating the bot

1. Pull, rebuild, run `npm test` (57/57 expected).
2. Start with `DRY_RUN_LIVE=true` on `MAX_EVENTS=1 MAX_OUTCOMES_PER_EVENT=5`
   to verify discovery, forecast, and quoting logic.
3. Run `npm run simulate` to see current strategy's MC expectations on your
   machine. Re-run whenever you tune a risk parameter.
4. Flip `DRY_RUN_LIVE=false` only after the dry-run logs look clean.
5. Scale to 50-100 markets by raising `MAX_EVENTS` / `MAX_OUTCOMES_PER_EVENT`.
   Bump `MAX_TOTAL_EXPOSURE_USDC` proportionally or the inventory skew will
   pin the spread near max immediately.
6. Watch `data/events.jsonl` + the dashboard (`http://127.0.0.1:8787`). If
   `STOP_LOSS_TRIGGERED` fires repeatedly on a single outcome, the forecast
   might be consistently wrong there — consider `ENABLE_FAIR_VALUE_CAP=true`
   for that session.

## 8. Cross-side hedged MM (YES + NO)

On Polymarket, every binary outcome has two tokens trading on **independent
order books**: a YES token that pays $1 if the outcome wins, and a NO token
that pays $1 if it loses. By no-arb, `price(YES) + price(NO) ≈ 1`.

Today we only quote on YES. Cross-side MM means running a second,
independent market-making loop on NO. Key observation:

```
BUY YES @ 0.29 + BUY NO @ 0.69  cost = $0.98 per share-pair
  outcome YES wins:  YES = $1.00, NO = $0     → payout = $1.00
  outcome NO  wins:  YES = $0,    NO = $1.00  → payout = $1.00
  risk-free profit at resolution  = $0.02 per share-pair
```

A completed YES-and-NO pair locks in **guaranteed** $0.02, regardless of
the resolution. On top of that, each side's SELL at entry+tick gives us a
faster way to exit with 1 tick of profit.

### Why we haven't shipped it yet

1. **Capital is 2×.** A paired position costs `$1 × shares` independent of
   price. Our $29 wallet supports ~10 concurrent YES-only positions; with
   cross-side that drops to ~5 pairs. Worth it only if fill rate is our
   binding constraint, which we haven't shown yet.
2. **Fill asymmetry.** We might fill YES but not NO, leaving directional
   exposure. Needs explicit gating: "only place NO BUY after YES BUY has
   filled" (hedge-on-demand) or accept the unhedged window.
3. **Tail-outcome illiquidity.** If YES = 0.05, NO = 0.95 — the NO book at
   0.95 has very thin volume. Cross-side works at midpoint outcomes, not
   tails (exactly where our weather markets have the most interesting fair
   values).
4. **Rewards don't double.** Polymarket's LP reward formula is per-market,
   not per-side.

### When to turn it on

- One-side live profitability demonstrated (positive backtest + positive
  first ~50 live round-trips)
- Capital increased past ~$100 so 2× per-pair doesn't cut concurrency
- Book depth on both sides of the target markets is non-trivial

### Implementation shape when we get there

See `docs/ROADMAP.md` item 4: extend `InventoryEngine` to track paired
hedges, duplicate the BUY/SELL loop on `market.noTokenId`, update stop-loss
to compute NET exposure (long-YES + long-NO ≈ zero), gate the NO leg on
the YES fill.

## 9. Spread × frequency — the capital-constrained version

Sharpe scales as `√N × edge_per_trade / stddev`. So *in principle* a
strategy with lots of tiny edges beats one with few big edges — HFT shops
live here. **But at small capital the math doesn't apply** because we're
constrained by capital-cycling, not statistics.

```
max_trades_per_day = (capital / order_size) × (24h / round_trip_duration)
```

At $29 with $2 orders and 30-min round trips: ~14 concurrent positions ×
48 slots/day ≈ 672 theoretical, 20-50 realistic. We can't grind 1¢ edges
often enough to let √N work. We need **meaningful edge per trade**.

Implication for market selection:

| market profile | fit at $29-$500 | fit at $5k+ |
|---|---|---|
| wide-spread low-volume (3-8¢, 5-20 trades/day) | ✓ | marginal (capacity-constrained) |
| medium-spread medium-volume (2-3¢, 20-50/day) | ✓ best | ✓ |
| tight-spread high-volume (0.5-1¢, 500+/day) | ✗ capital-constrained | ✓ |

At our scale, target the **2-5¢ spread / 5-50 round-trips per day** band.
The `npm run analyze-markets` command scores every active outcome on this
profile. Use it to pick markets before running the sweep.

## 10. Overfitting defense

See `docs/SWEEP.md §"Overfitting defense"` for walk-forward cross-validation
(the sweep runs it automatically in stage 3).

Minimum bar for deploying a swept config:
- OOS mean PnL ≥ $0.05/market
- Train-test gap ≤ $0.05 (≤ 25% of OOS mean)
- Stability ≥ 50% (rank-1 lands in test top-10 on ≥ half the folds)

If any of these fails, don't deploy. Retarget the market universe (sports,
entertainment), gather more data (longer window or finer fidelity), or
conclude the strategy has no edge at the current scale.

## 11. Round-trip duration — what to expect per market type

Real MM wants fast capital rotation, but round-trip duration is determined
by **counterparty order flow**, not by our infrastructure. A perfect WS-driven
bot on a thin market is still bounded by how often retail arrives.

| market | typical round-trip duration | why |
|---|---|---|
| Binance BTC perp (pro HFT)          | **5-500 ms**   | constant flow, sub-tick spreads |
| Polymarket NFL spread during game   | **10-60 sec**  | retail hammering in 3-hour window |
| Polymarket politics during news     | **1-30 min**   | news-driven flow clusters |
| Polymarket weather (current)        | **15 min - 2 h** | thin flow, slow books |
| Polymarket long-horizon (1y+)       | **hours - days** | patient market, wide spreads |

If the analyzer (`npm run analyze-markets`) shows most outcomes with
expected round-trip > 30 min, that's a signal the market is too slow for
our capital. Retarget to sports / politics-news-cycle windows where the
flow is bursty — those give the 10-60 sec round-trips that actually rotate
capital.

## 12. Win rate benchmarks — what's realistic

| operator                   | per-trade win rate | per-day win rate | mean $/trade        |
|----------------------------|--------------------|------------------|---------------------|
| Virtu / Citadel equity MM  | 55-60%             | **99.6%** pub    | fractions of a cent |
| Jane Street options MM     | ~60%               | 95%+             | cents               |
| Retail crypto HFT          | 50-65%             | 70-85%           | $0.10-1             |
| **Our target (weather MM)**| **60-75%**         | **60-80%**       | **$0.02-0.05**      |

Key insight: **per-trade win rate can be 55% and the strategy can still be
wildly profitable.** MM wins small many times (1 tick captured) and loses
small few times (stop-loss-capped tail). Winners are small-but-certain;
losers are small-but-rare. That's the game.

### Diagnostic thresholds (what to watch for after going live)

| observed metric              | diagnosis                                           | action                |
|------------------------------|-----------------------------------------------------|-----------------------|
| Per-trade win rate > 55%     | Stop-loss is saving us from tail losses             | keep current config   |
| Per-trade win rate > 75%     | Stopping too conservatively, leaving P&L on table   | loosen stop thresholds|
| Per-trade win rate < 45%     | Adverse selection / informed flow / bad forecast    | retarget markets      |
| Winner / loser $ ratio < 0.3 | Stops firing too late — losing trades too large     | tighten catastrophic  |
| Round-trips/day < 5          | Market too slow for our capital                     | retarget markets      |

### Minimum-viable-edge test after going live

Run for **one full week** at your chosen bankroll. After that:

- **Net P&L > $5/week at $100 bankroll** → edge is real, scale capital gradually
- **Net P&L $0 to $5/week** → inconclusive, run another week with tuned params
- **Net P&L < $0/week** → no edge at this scale on this market. Retarget or stop.

Key: don't deploy more capital until you've seen at least **100 completed
round-trips** with positive P&L. Variance on small samples lies.

## 13. Take-profit: fixed vs dynamic vs laddered

The default SELL is `entry + 1 tick` — minimum profitable exit, classic MM.
A common question from traders with futures/HFT backgrounds: "shouldn't we
let winners run further with dynamic TP?"

### Short answer

On Polymarket weather: mostly no. On volatile-news markets: yes.

### The three options

**1. Fixed 1-tick TP (current default).** Lock the tick, rotate capital.
Pro: high fill rate, short holding time, predictable.
Con: leaves money on the table during genuine rallies.

**2. Volatility-adjusted TP (`TP_VOL_MULTIPLIER` > 0).** Formula:
```
tp_ticks = TP_TICKS_BASE + floor(TP_VOL_MULTIPLIER × realized_stddev_cents / tick_cents)
         capped at TP_TICKS_MAX
```
Calm markets → TP=1 (same as default). Volatile markets → 2-5 ticks.
The adjustment uses the same realized-vol tracker as the spread widener,
so it responds to actual observed volatility.

**3. Laddered scale-out TP.** Split position into 50% at entry+1, 30% at
entry+2, 20% at entry+3. Not implemented yet — see roadmap.

### The hidden cost nobody talks about

Wider TP = slower fill = longer capital holding = more stop-loss risk:

| TP setting              | typical fill time on weather | fill rate | round-trips/day |
|-------------------------|------------------------------|-----------|-----------------|
| entry + 1 tick          | 15-60 min                    | 85-95%    | 5-15            |
| entry + 3 ticks         | 1-4 hours                    | 50-70%    | 2-5             |
| entry + 5 ticks         | 4-12 hours                   | 20-40%    | 0.5-2           |

Fewer round-trips per day, even if each winner is bigger, often loses on
total daily P&L. And the positions that *don't* fill are exposed to the
stop-loss: if mid drifts down while we're waiting for TP=5, we eat a
stop-out loss bigger than the extra ticks would have earned.

This is why weather-market MM typically uses TP=1: the market doesn't move
fast enough to make wider TPs pay. On sports markets with bursty flow,
TP=2-3 often beats TP=1.

### How the sweep tests this

The grid search now searches over `tpTicksBase ∈ {1, 2}` and
`tpVolMultiplier ∈ {0, 0.5}` by default. If TP=1 wins on your market
universe, stick with it. If TP=2 or vol-adjusted TP wins, use it.
Decisions based on backtest numbers, not theory.

### Diagnostic after going live

| symptom                                       | verdict           | action                         |
|-----------------------------------------------|-------------------|--------------------------------|
| TP=1 fills in ~15min, 80%+ hit rate           | perfect for market | keep                           |
| TP=1 fills fast but you see mid move +3¢ after| leaving money      | try TP=2 or vol multiplier     |
| TP=1 fills take > 2h, stops firing often      | market too slow    | retarget markets, not tune TP  |

## 14. Trend-drift filter (addresses the weather-specific failure mode)

The first full sweep against real Polymarket weather data (539 outcomes,
3 days, walk-forward cross-validated) returned a losing result:

```
OOS mean:    -$0.099/market
OOS p05:     -$0.823/market
Stability:   100% (rank-1 losing config stayed rank-1 across all folds)
Win rate:    55.5%
Stop rate:   ~47% of all positions hit the stop-loss
```

The **structural failure mode**: weather markets don't mean-revert. Prices
converge to the true outcome as forecasts update / resolution approaches.
An MM quote sitting at `mid − 1 tick` gets filled when mid drops, then the
market keeps drifting down and the `entry + 1 tick` TP never fills. The
stop-loss eventually fires for a 15-30% loss per position.

Classic MM wins when books oscillate. Weather books don't oscillate —
they drift.

### The fix: trend-drift detector

Before placing a BUY, check if the mid has been drifting *down*
persistently over the recent observation window. If yes, skip the quote
this refresh cycle. Only quote when the book looks oscillating.

Signal: **t-statistic of recent returns**
```
drift_cents = mean(recent_mid_returns) × (N - 1)     # cumulative cent drift
drift_ratio = |drift_cents| / (stddev × √(N-1))      # t-stat: signal-to-noise
```

Skip BUY when `drift_cents ≤ -DRIFT_FILTER_DOWN_DRIFT_CENTS` AND
`drift_ratio ≥ DRIFT_FILTER_RATIO`. The first condition catches the
direction (must be *falling*); the second catches the reliability
(must be persistent, not random noise).

Defaults tuned from sweep diagnostics:
- `DRIFT_FILTER_DOWN_DRIFT_CENTS=2` — skip if mid dropped 2+¢ cumulatively
- `DRIFT_FILTER_RATIO=1.2` — only count as trend if signal/noise > 1.2
  (roughly: "more than a 1σ move")

### Why this should work

- Our losses come from the 45% of positions caught in trending books
- Trending looks statistically different from oscillating (persistent sign
  in the t-stat of recent returns)
- Skipping quotes during down-drifts = fewer fills, but the ones we get
  are in mean-reverting regimes where the TP actually fires
- Expected: win rate climbs to 65-75%, mean P&L turns positive, stop
  rate drops from 47% to 10-15%

### What the backtest will tell us

If `DRIFT_FILTER_ENABLED=true` wins the sweep with positive OOS mean:
the filter addresses the failure mode — we ship it, go live.

If `ENABLED=false` still wins: the filter doesn't help enough. Weather is
structurally wrong for this strategy. Retarget to sports or politics
(markets that oscillate during news cycles).

## 15. What we did NOT build and why

- **Avellaneda-Stoikov optimal spread.** Designed for continuous price
  processes with terminal inventory penalty. Polymarket weather has
  near-zero intraday vol and a hard resolution time; the closed-form
  collapses to "quote as tight as the tick allows" — already what we do.
- **Cartea-Jaimungal.** Same conclusion, more math.
- **Queue position modeling.** Would require L2 book depth + trade tape
  streaming. Worth revisiting if MC shows high p05 loss from missed fills.
- **Cross-side hedging (quote YES and NO both).** Doubles order count and
  capital exposure; complexity isn't justified at current size. Could add
  if LP rewards change significantly.
- **Per-market dynamic spread.** Right now `HALF_SPREAD_CENTS` is global.
  Could optimize per outcome based on book depth and volatility. Worth
  revisiting post-launch once we have real fill data.
