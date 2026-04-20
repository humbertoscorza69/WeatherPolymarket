# Technical Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Gamma API shape drift | Discovery misses markets or mislabels outcomes | Unit tests cover current shapes; parser ignores incomplete markets and fails dry-run if none found. |
| Same-day weather markets stale | Forecast date can roll past event date | Discovery skips same-day events and forecast fetch requires exact date match. |
| Unknown city coordinates | Forecast fetch fails | City map includes current top weather cities; add cities as Gamma lists them. |
| Real live order placement unreviewed | Capital loss or taker fills | Runner fails closed unless `DRY_RUN_LIVE=true`; live CLOB path remains gated for CEO review. |
| Fill-triggered SELL delay | Inventory remains exposed after BUY fill | `buildSellOnFill` constructs immediate maker SELL; next step is User WS wiring. |
