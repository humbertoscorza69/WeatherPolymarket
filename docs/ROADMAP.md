# Roadmap

What's done, what's next, and why — ordered by value × tractability.

---

## Shipped

| commit | feature |
|---|---|
| `e9ac348` | Fix tickSize/negRisk signing bug; preserve SELLs on restart |
| `95ad7da` | Round-trip completion, per-market tick, EventLog, live dashboard |
| `5ab969c` | Fair-value cap (opt-in), `.env` loading, log-level cleanup |
| `fc88883` | CDF-over-bins fair value, horizon-scaled σ, CDF tests |
| `163cedb` | Pure MM by default, per-conditionId inventory isolation proven at 100 markets |
| `13904c6` | Stop-loss, inventory skew, Monte Carlo simulator v1 |
| `269e510` | Hybrid stop-loss ladder, realized-vol spread, MC simulator v2 with vol clustering + informed traders |
| **this** | **Full L2 book depth, historical backtest tool, DATA_SOURCES doc, cross-side theory writeup, ROADMAP** |

---

## Next up (in order)

### 1. Run the backtest against real history — **blocker for live scaling**

On your PyCharm box:
```bash
git pull
npm install
npm run backtest                   # auto-discovers active weather markets
npm run backtest -- --days=14 --interval=1h
```

Expectation: backtest is an OPTIMISTIC upper bound (queue position not
modeled). If it's meaningfully positive across a dozen markets, the MC
tuning survives contact with real data. If it's near zero or negative,
the strategy is not edge-positive before we even factor in queue slippage.

**Decision gate**: if backtest mean PnL per market is less than ~$0.05,
re-tune before going live. If it's above that, the live numbers should
be at least some fraction of it.

### 2. Market WebSocket stream — foundation for everything advanced

Wire `wss://ws-subscriptions-clob.polymarket.com/ws/market` to keep a local
L2 book mirror per market. Replaces the per-refresh REST polling (fewer
request-rate concerns), gives us sub-second reactivity, and enables:
  - Queue-position fill-probability estimator
  - Cross-side quoting without 2× polling load
  - Book-imbalance signal (adverse-selection flag)

Scope: ~400 LOC, one new module mirroring `userWebSocket.ts` shape. Tests
use a fake WS driver similar to the current one.

### 3. Queue-aware quoting

With live L2, estimate expected fill time = depth_ahead_of_us / arrival_rate.
Use it to decide between "sit passively at mid − halfSpread" and
"jump the queue by 1 tick more aggressive" on a per-market basis.
Expected impact: 10-25% lift in fill rate on congested books, slight
reduction on sparse ones.

### 4. Cross-side (YES + NO) market making

Economics (see `docs/MARKET_MAKING.md §8`): a completed YES-and-NO pair
locks in a guaranteed $0.02 profit per pair. Risks: 2× capital, fill
asymmetry, tail-outcome illiquidity. **Not yet** because:
  - $29 wallet makes capital the binding constraint
  - One-side strategy hasn't proven live-profitable yet
  - Need inventory accounting for hedged pairs

When we move on it, scope is:
  - New `InventoryEngine` that tracks {yesShares, noShares, hedgedPairs}
  - Second BUY/SELL loop keyed on `market.noTokenId`
  - Stop-loss rules that check NET exposure (long YES + long NO = zero
    net exposure = no stop needed)
  - Capital gating: only open NO leg if YES has already filled

### 5. Dynamic position sizing (Kelly-lite)

Vary `ORDER_SIZE_USDC` per market based on estimated edge:
```
edge = tickSize × fill_prob(bid) × fill_prob(sell)
size = f × min(bankroll × edge / risk_per_trade, MAX_POSITION_USDC)
```
With `f` ≤ 0.5 (fractional Kelly — full Kelly is too aggressive).
Bigger orders on markets where both legs are likely to fill; smaller on
speculative ones.

### 6. LP-reward-exact accounting

Replace the crude `0.0002 × closeness × size × dt` proxy with Polymarket's
actual per-market reward config (available via `GET /rewards/markets`).
Let the MC / backtest say what the realistic reward component actually is.

### 7. Ensemble / multi-model forecast

Open-Meteo supports multiple NWP models (`ecmwf_ifs04`, `gfs_seamless`).
Use ensemble spread as the natural uncertainty estimator instead of a
fixed σ₀. Only worth it if the fair-value cap becomes important.

---

## Explicitly deferred

- **Full Avellaneda-Stoikov closed form.** The scaling result we already
  use (`halfSpread += k × σ`) captures the main intuition. Full A-S
  requires a risk-aversion calibration that we can't get without a
  long live history.
- **L3 / order-ID queue reconstruction.** Polymarket doesn't publish it;
  trying to reconstruct from L2 deltas is noisy.
- **On-chain trade-tape backtest.** Useful for cross-verification but
  adds significant infra; the CLOB REST history is authoritative.
- **Cross-market arbitrage detection.** Possible but outside the maker
  strategy. Would need taker orders which violate our postOnly discipline.
