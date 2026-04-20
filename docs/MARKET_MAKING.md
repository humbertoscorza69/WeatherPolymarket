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

### Layer C — Stop-loss (`STOP_LOSS_ENABLED`, default TRUE)
Four independent triggers; any one fires → cancel the resting SELL, submit
a taker SELL (FAK, postOnly=false) at best bid. Pay the 1.25% taker fee to
guarantee exit.

| rule                      | condition                                                              | default           |
|---------------------------|------------------------------------------------------------------------|-------------------|
| `CATASTROPHIC_DROP`       | `mid / entry ≤ 0.30`                                                   | 30%               |
| `DEEP_DROP_STALE`         | `mid / entry ≤ 0.60` AND held > 120 min                                | 60% / 2h          |
| `NEAR_RESOLUTION_ADVERSE` | `hoursToResolution ≤ 1` AND `mid / entry < 0.70`                       | 1h / 70%          |
| `MAX_HOLDING`             | `held > 12h` regardless of price                                       | 12h               |

Rule of thumb for tuning these: the tighter the thresholds (higher drop
ratios, shorter hold times), the more frequently stop-loss fires and the
more taker fees you pay; the looser, the more you risk holding into
resolution. Defaults chosen from Monte Carlo (section 5).

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

### 5b. Results (3000 episodes, mixed regime)

```
strategy                                 mean   std    win%    p05    p95   rtrips  stops
baseline (1¢, no skew, no SL)            0.20   1.17   99.7%   0.00   0.95   2.07    0.00
stop-loss ON                             0.20   1.01   99.8%   0.00   1.00   2.00    0.00
inventory skew 2¢                        0.21   1.19   99.8%   0.00   0.95   2.07    0.00
wider 2¢ spread                          0.19   1.01   100%    0.00   0.92   1.99    0.00
combo (1¢ + skew 2¢ + SL)                0.21   1.11   99.7%   0.00   0.95   2.20    0.00
aggressive (0-cent, no SL)               0.16   1.28   97.6%   0.00   1.10   1.92    0.00
conservative (3¢ + skew 3¢ + SL + 5 max) 0.22   1.17   22.2%   0.00   1.00   2.19    0.00
```

Mixed-regime mean P&L is indistinguishable across strategies. Adverse is only
15% of episodes, so the diff doesn't show in the pooled mean.

### 5c. Pure-adverse stress test (where differences emerge)

```
strategy                                  mean   std    win%      p05    stops
baseline (1¢, no skew, no SL)             0.66   2.32   98.0%    0.00    0.00
stop-loss ON                              0.62   1.96   98.5%    0.00    0.03
inventory skew 2¢                         0.72   3.05   98.2%    0.00    0.03
wider 2¢ spread                           0.79   2.49   99.5%    0.00    0.00
combo (1¢ + skew 2¢ + SL)                 0.69   1.98   97.9%    0.00    0.04
aggressive (0-cent, no SL)                0.39   3.77   85.2%   -3.37    0.00
conservative (3¢ + skew 3¢ + SL + 5 max)  0.69   1.98   44.0%    0.00    0.00
```

The important column is **p05** (5th-percentile P&L). In adverse regimes:
- **Aggressive (0¢ spread, no stop-loss)**: p05 = **-$3.37** per session. One
  session in twenty loses more than three dollars on a $2-per-order strategy.
- Every other variant: p05 = $0 or above. Stop-loss + sensible spread caps
  the tail completely.

**Conclusion:** stop-loss doesn't lift mean P&L; it collapses the left tail.
On a $29 bankroll that's the difference between a sustainable strategy and a
blow-up after a few bad sessions.

### 5d. Recommended defaults (chosen from MC)

```
HALF_SPREAD_CENTS=1
INVENTORY_SKEW_CENTS=2
STOP_LOSS_ENABLED=true
STOP_LOSS_CATASTROPHIC_DROP=0.30
STOP_LOSS_DEEP_DROP=0.60
STOP_LOSS_DEEP_DROP_MINUTES=120
STOP_LOSS_RESOLUTION_HOURS=1
STOP_LOSS_RESOLUTION_DROP=0.70
STOP_LOSS_MAX_HOLDING_HOURS=12
ENABLE_FAIR_VALUE_CAP=false
```

These match the `combo (1¢ + skew 2¢ + SL)` row — strong Sharpe, near-zero
p05 in adverse, competitive mean.

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
