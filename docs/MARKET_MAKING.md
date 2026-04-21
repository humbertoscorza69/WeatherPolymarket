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

## 7. What we did NOT build and why

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
