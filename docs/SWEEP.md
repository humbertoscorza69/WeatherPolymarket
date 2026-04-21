# Parameter sweep (multi-city, grid-searched, staged)

The sweep is how a real quant picks parameters: brute-force every plausible
combination across every available market, rank by a risk-adjusted metric,
then iterate around the winners.

Usage:
```
npm run sweep                         # defaults: 3 days, 5-min samples
npm run sweep -- --days=1 --fidelity=1    # high-resolution short-window sanity check
npm run sweep -- --days=7 --fidelity=30   # long-window coarse check
npm run sweep -- --max-events=50 --max-outcomes=15
npm run sweep -- --refresh-cache      # ignore cache, re-fetch from Polymarket
npm run sweep -- --top=5              # refine around the top 5 winners
```

### Fidelity vs the live refresh cadence

`--fidelity=N` means the historical tape has ONE sample every N minutes.
That is NOT the same as our live refresh cadence (default 30s); it's the
resolution Polymarket's `/prices-history` endpoint returns. We can't get
tick-by-tick history from any public endpoint.

The effect: during a backtest our simulated quote sits stale between
samples. At `fidelity=5` that's 5 minutes between re-prices — 10× slower
than live. This biases backtest fill rate DOWN relative to live (our quote
misses micro-moves that would have repriced it live), while the mid-reaches-
our-quote fill model biases fill rate UP (real queue depth not modeled).
The two effects partially cancel. Read the sweep as directional guidance,
not exact P&L forecast.

The real live-speed upgrade is wiring the Polymarket market WebSocket
(`wss://ws-subscriptions-clob.polymarket.com/ws/market`) so we re-price on
every book event. That's roadmap item 2 in `docs/ROADMAP.md`.

Output: top-10 leaderboards after each stage, plus a single "RECOMMENDED
CONFIG" block you can paste into `.env`.

---

## What it does

1. **Discovery.** Pulls every active weather event from Gamma (`MAX_EVENTS`
   defaults to 50, i.e., all of them).
2. **Fetch + cache.** For each outcome: resolves tickSize, pulls
   `getPricesHistory` at the requested fidelity, writes
   `data/backtest-cache/<tokenId>-<days>d-<fidelity>m.json`. Cache is valid
   for 6 hours; re-runs are instant.
3. **Stage 1: coarse grid.** Cartesian product of:
   - `HALF_SPREAD_TICKS`: 1, 2, 3
   - `INVENTORY_SKEW_CENTS`: 0, 2
   - `VOL_MULTIPLIER`: 0, 0.5, 1.0
   - `MIN_OUTCOME_MID`: 0.05, 0.10
   - `MAX_OUTCOME_MID`: 0.90, 0.95
   - `MAX_FORECAST_DIVERGENCE`: 0.15, 0.30
   - `STOP_LOSS_ENABLED`: true
   - `STOP_LOSS_CATASTROPHIC_DROP`: 0.30
   - `STOP_LOSS_DEEP_DROP`: 0.60
   - `ORDER_SIZE_USDC`: 2, 3

   That's 3·2·3·2·2·2·1·1·1·2 = **288 configs**. Each runs against every
   market that passes its band filter — so on ~500 outcomes × 288 configs
   ≈ 144 000 backtests. Takes 5-30s on a laptop.

4. **Rank by composite metric.** `0.5 × mean_rank + 0.5 × p05_rank`
   (lower = better). This balances expected return with tail protection.
   Pure-mean ranking would let high-variance strategies win; pure-p05 would
   pick strategies that never trade. 50/50 is the quant default.

5. **Stage 2: refine around top-N.** Takes the top `topN` (default 3)
   configs. For each, builds a neighbourhood grid (±1 step on every
   numeric parameter) and runs again. Catches fine-grained local optima
   the coarse grid missed.

6. **Print recommended config.** The stage-2 rank-1 config's env-var block.

---

## Ranking metric details

```
for each config:
  rank_by_mean = index when sorted by meanPnL descending
  rank_by_p05  = index when sorted by p05 descending
  composite    = 0.5 × rank_by_mean + 0.5 × rank_by_p05
sort by composite ascending → lowest wins
```

Why composite rather than raw Sharpe? Sharpe assumes symmetric risk, which
isn't what we care about — we can't lose more than our capital at risk, and
tail losses matter more than tail gains. Composite rank is robust to
distributional assumptions.

---

## When to trust the output

The backtest is an **optimistic upper bound** on what the strategy could
have achieved. Real fills are slower because queue position is not modeled.
Reading the leaderboard:

- If the #1 config shows **mean P&L ≈ $0 and p05 ≈ $0**: the strategy is
  roughly flat even in the optimistic case. Live will be worse. Don't
  deploy.
- If #1 shows **mean $0.05-$0.20 per market**: that's our target zone. Live
  returns will be some fraction of this — validate with a live dry-run.
- If #1 shows **mean > $0.50 per market**: suspicious. Either the backtest
  has a bug, the market is wildly illiquid (so every price move fills us),
  or the markets in the cache all resolved favourably by luck. Check the
  per-market distribution before believing it.

- If **winRate < 50%** but mean is positive: the strategy is bimodal —
  most sessions break even with a few big winners. Acceptable in theory,
  scary on a $29 bankroll. Prefer higher winRate configs with similar mean.

- If **totalStopLosses is very high** (e.g., > 0.5 per market): the thresholds
  are too tight. Loosen `STOP_LOSS_CATASTROPHIC_DROP` or the deep-drop hold
  time.

---

## Cache management

Caches live in `data/backtest-cache/*.json`, keyed by `<tokenId>-<days>-<fidelity>`.
They expire after 6 hours. Manually clear with:
```
rm -rf data/backtest-cache/
```
Or pass `--refresh-cache` to force a re-fetch in one run.

---

## Rate-limiting note

Polymarket's REST API allows ~100 req/s for unauthenticated reads. The
sweep fetches 2 endpoints per market (`getTickSize` + `getPricesHistory`),
so 500 markets × 2 = 1000 requests in the first run. The sweep doesn't
throttle — if you see 429 errors, break the sweep into two runs by
`--max-events` and let the cache carry over.
