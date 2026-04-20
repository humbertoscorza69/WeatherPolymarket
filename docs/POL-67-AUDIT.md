# POL-67 Audit: Weather Market Maker

Audit date: 2026-04-20

## Summary

```
CHECK  1: FAIL    - Crypto bot dead / account flat
CHECK  2: PASS    - Weather discovery
CHECK  3: PASS    - Multi-outcome parsing
CHECK  4: PASS    - Weather forecast
CHECK  5: PASS    - Probability distribution
CHECK  6: PASS    - Quoting logic
CHECK  7: FAIL    - postOnly live order path
CHECK  8: FAIL    - Fill handler + SELL
CHECK  9: PASS    - Risk limits per-outcome
CHECK 10: LIST    - Missing live-trading items
CHECK 11: PASS    - Test coverage

OVERALL: 7/10 pass, 1 list item, 3 fail
```

Do not go live. The dry-run path is working, but real CLOB placement, User WS fill handling, and authenticated account-flat verification are not implemented.

## CHECK 1: Crypto Bot Is Dead

The requested bash command could not run because this adapter is Windows and `bash` is not installed.

Windows-equivalent process output:

```json
[
  {
    "ProcessId": 10056,
    "CommandLine": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Program Files\\nodejs/node_modules/npm/bin/npx-cli.js\" paperclipai run"
  },
  {
    "ProcessId": 27312,
    "CommandLine": "\"node\" \"C:\\Users\\tico_\\AppData\\Local\\npm-cache\\_npx\\43414d9b790239bb\\node_modules\\.bin\\\\..\\paperclipai\\dist\\index.js\" run"
  },
  {
    "ProcessId": 31600,
    "CommandLine": "\"node\" \"C:\\Users\\tico_\\AppData\\Roaming\\npm\\\\node_modules\\@openai\\codex\\bin\\codex.js\" exec ..."
  }
]
```

Pid files:

```text
data/bot.pid: no pid
data/live.pid: no pid
```

Polymarket account audit:

```text
Get-ChildItem Env:POLYMARKET* -> no variables returned
```

Result: FAIL. There is no `node dist` bot process and no pid file, but open orders/positions cannot be queried without Polymarket account credentials.

## CHECK 2: Weather Discovery

Exact URL:

```text
https://gamma-api.polymarket.com/events?tag_id=84&active=true&closed=false&limit=100&order=volume24hr&ascending=false
```

Raw API sample, first two events truncated:

```json
[
  {
    "title": "Highest temperature in Shanghai on April 20?",
    "eventDate": "2026-04-20",
    "volume24hr": 324345.6662690001,
    "markets": [
      {
        "question": "Will the highest temperature in Shanghai be 12C or below on April 20?",
        "conditionId": "0xbfafc310e741b43af9b4b39c954698c9345e992e61c4ce78ba58504b9e717268",
        "groupItemTitle": "12C or below",
        "outcomePrices": "[\"0\", \"1\"]",
        "enableOrderBook": true,
        "closed": true
      }
    ]
  },
  {
    "title": "Highest temperature in Seoul on April 20?",
    "eventDate": "2026-04-20",
    "volume24hr": 210126.821334,
    "markets": [
      {
        "question": "Will the highest temperature in Seoul be 7C or below on April 20?",
        "conditionId": "0xeeb3ad6274407c51a7d4c7df58d1de53ed0ec4a83706d713e70d08569804a735",
        "groupItemTitle": "7C or below",
        "outcomePrices": "[\"0\", \"1\"]",
        "enableOrderBook": true,
        "closed": true
      }
    ]
  }
]
```

Filter/parser code:

```ts
const GAMMA_WEATHER_URL =
  "https://gamma-api.polymarket.com/events?tag_id=84&active=true&closed=false&limit=100&order=volume24hr&ascending=false";

const meta = parseWeatherTitle(title, rawEvent.eventDate);
if (!meta) continue;
if (meta.date <= todayIso()) continue;

const markets = (rawEvent.markets ?? [])
  .map((market) => parseMarket(market))
  .filter((market): market is WeatherMarket => market !== null)
  .filter((market) => market.enableOrderBook && !market.closed && !market.resolved)
  .filter((market) => market.volume24hr >= options.minMarketVolumeUsdc)
  .slice(0, options.maxOutcomesPerEvent);

export function parseWeatherTitle(title: string, eventDate?: string): { city: string; date: string } | null {
  const match = title.match(/temperature in (.+?) on ([A-Za-z]+ \d{1,2})\??$/i);
  if (!match?.[1] || !match[2]) return null;
  const year = new Date().getUTCFullYear();
  const date = new Date(`${match[2]}, ${year} UTC`);
  if (Number.isNaN(date.getTime())) return null;
  return { city: match[1].trim(), date: eventDate?.slice(0, 10) ?? date.toISOString().slice(0, 10) };
}
```

Result: PASS. It uses the Weather tag id, parses city/date, skips same-day markets, and excludes closed/resolved markets.

## CHECK 3: Multi-Outcome Parsing

Seoul April 21 output:

```text
Event title: "Highest temperature in Seoul on April 21?"
Number of active outcome markets: 11
```

| Outcome | conditionId | YES token ID | NO token ID | YES price | Volume 24h | enableOrderBook | closed |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| 8C or below | 0x921cf00ff4970087f0168d3f9b17ee443953cd814815c24fabcffaea87ccb272 | 86054824894310389172828622274122646100272503245057720482721104835376460764709 | 43828890744160972232139247102815014383667085854993141706915803495606467220646 | 0.0005 | 14632.816662 | true | false |
| 9C | 0x9da42d7db7b54129140e75979c3388c89004ba79349ac02a463d0ef14f5c1e0b | 50080115946069932526148516244924602413980443185174695673097396948114774725343 | 7028240146672414128347179832169353189813194951216813269280832556465938177187 | 0.0005 | 6266.581477 | true | false |
| 10C | 0x7408b3e30ab72690bee3169e1821af9bc1d259854e04f89ed0379eed2bd8e303 | 24688029691775016221264417849009470635171594672322617671568637964936047420283 | 77087217844329456093792282249294570531325246405195943206513092676149202183736 | 0.0015 | 2222.934392 | true | false |
| 11C | 0x747c1e2a8ee89b548c748ad8aadec8670fcc41745f325f64b93ce0652236fbbc | 97591466951863925265740333626086921805930240592997594799190597340723519659807 | 21502364137541268631948214775947672549374526835989675108572960427922609934575 | 0.0035 | 7282.514764 | true | false |
| 12C | 0xe3dee1e6b2cd66b4cb3101f85a32007a773a5f9e54921cad92abe6d3ccab14c2 | 50034616006351149617496552286200818487116897203304226380969254235007938735305 | 20551764949451056018569711346159602791975958909100959502361198089055430026441 | 0.0125 | 10699.456647 | true | false |
| 13C | 0xf57d8e6f12d9e95f045eda34bab5957a6101dd05eabcda5a589096d2ff39c926 | 82471479283940203636986161889881690908844330043977612210935641699351651182412 | 9318164978806593576586663433209745582815421649784185058534337167994621878666 | 0.0105 | 8445.211052 | true | false |
| 14C | 0x81cddb9f7c7c17e33223a3f3ac277b7cd61c10c047a2ee509f4b5dc64a032644 | 85895330942999837422471031702723431107581249589607064198224265024582220910176 | 65756840183947935886488855275788430526915193270594182007811110112751339947559 | 0.045 | 8772.22438 | true | false |
| 15C | 0x61b421e10c98d64ca223a41976245beeb69f97c6b5a326948bbdbcabdcf03015 | 54607536929952421551571926148598524912523061510949489751513325812999918787892 | 567855073018983973563071909080495731161940445539517342125111979853607853936 | 0.225 | 4148.830618 | true | false |
| 16C | 0x05189eaed0c13cc5765073906e9fb3ef98165f3ea1bf1c1e298189d46621923c | 55956956881730881326306523653445023122783382083468989842915851706569971275296 | 101783931645603602621560413023477697609406142095196428710633623193014285920721 | 0.285 | 3918.124381 | true | false |
| 17C | 0x53eb157c9a61b835104f2f42be59302894d0637c57787ab8aa36a3138c7990ad | 84373494489264200472532113984913549365546910866031080424999254704275810011769 | 41435974679738772138458263561890524275253478408521521754939292660642778643795 | 0.175 | 4490.344721 | true | false |
| 18C or higher | 0xe216b76886f3da9f66886fdb2c7ea5bc99f0d02b5e2891c54fc3f28e3701f659 | 92622619496372769384875470427880342244991045006015456458665121350251485876323 | 29371940617044714317298070277935480509471602247526256869921247468913944247725 | 0.255 | 14379.040934 | true | false |

Result: PASS.

## CHECK 4: Weather Forecast

Exact Open-Meteo URL:

```text
https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978&daily=temperature_2m_max&timezone=Asia/Seoul&forecast_days=2
```

Raw output:

```json
{
  "latitude": 37.55,
  "longitude": 127.0,
  "timezone": "Asia/Seoul",
  "daily_units": {"time":"iso8601","temperature_2m_max":"C"},
  "daily": {"time":["2026-04-21","2026-04-22"],"temperature_2m_max":[16.9,16.6]}
}
```

Code uses Seoul coords/timezone and `daily=temperature_2m_max`:

```ts
Seoul: { lat: 37.5665, lon: 126.978, tz: "Asia/Seoul" }

const params = new URLSearchParams({
  latitude: String(coords.lat),
  longitude: String(coords.lon),
  daily: "temperature_2m_max",
  timezone: coords.tz,
  forecast_days: "7"
});
```

Result: PASS.

## CHECK 5: Probability Distribution

Function:

```ts
export function forecastToProbabilities(forecastTempC: number, uncertaintyC: number, outcomesC: number[]): ProbabilityPoint[] {
  const weights = outcomesC.map((temperatureC) => {
    const z = (temperatureC - forecastTempC) / uncertaintyC;
    return { temperatureC, weight: Math.exp(-0.5 * z * z) };
  });
  const total = weights.reduce((sum, point) => sum + point.weight, 0);
  return weights.map((point) => ({ temperatureC: point.temperatureC, probability: point.weight / total }));
}
```

Uncertainty: `WEATHER_UNCERTAINTY_C=1.5`.

Computed Seoul distribution for forecast high `16.9C`:

```text
8C: 0.0000%
9C: 0.0000%
10C: 0.0008%
11C: 0.0135%
12C: 0.1487%
13C: 1.0511%
14C: 4.7633%
15C: 13.8407%
16C: 25.7860%
17C: 30.8030%
18C: 23.5929%
sum: 100.00000000%
```

Result: PASS.

## CHECK 6: Quoting Logic

For 17C:

```text
fairValue = 0.308030
halfSpreadCents = 2
halfSpread = 0.02
bid = roundPrice(0.308030 - 0.02) = 0.29
ask target = roundPrice(0.308030 + 0.02) = 0.33
ORDER_SIZE_USDC = 2
shares = floor((2 / 0.29) * 10000) / 10000 = 6.8965
CLOB_MIN_SHARES = 5
6.8965 >= 5 -> true
```

Relevant code:

```ts
const bid = roundPrice(fair - halfSpread);
const shares = roundShares(config.orderSizeUsdc / bid);
if (shares < config.clobMinShares) continue;
```

After audit patch, SELL-on-fill uses full spread from entry:

```ts
const fullSpread = (halfSpreadCents * 2) / 100;
const price = roundPrice(fill.price + fullSpread);
```

Result: PASS for dry-run quote computation.

## CHECK 7: postOnly: true Live Order Path

Dry-run path:

```ts
const broker = new DryRunBroker(join(config.dataDir, "dry-run-orders.jsonl"));
const quotes = buildBuyQuotes(event, forecast, config);
const receipts = await broker.placeMany(quotes);
```

Dry-run receipt preserves `postOnly: true`, but there is no raw HTTP CLOB order driver yet.

Result: FAIL. It does not use SDK `postOrder()` with `deferExec`, but it also does not yet implement raw HTTP POST with `{ postOnly: true }`.

## CHECK 8: Fill Handler + SELL

Implemented helper:

```ts
export function buildSellOnFill(fill: FillEvent, halfSpreadCents: number): QuoteIntent | null {
  if (fill.side !== "BUY") return null;
  const fullSpread = (halfSpreadCents * 2) / 100;
  const price = roundPrice(fill.price + fullSpread);
  if (price > 0.98) return null;
  return { conditionId: fill.conditionId, tokenId: fill.tokenId, side: "SELL", price, shares: fill.shares, postOnly: true, ... };
}
```

Missing: actual User WS `onFill` handler, inventory mutation, immediate CLOB SELL placement, and retry queue.

Result: FAIL for live trading.

## CHECK 9: Risk Limits

Config:

```ts
clobMinShares: envNum("CLOB_MIN_SHARES", 5),
maxPositionPerMarketUsdc: envNum("MAX_POSITION_PER_MARKET_USDC", 3),
maxTotalExposureUsdc: envNum("MAX_TOTAL_EXPOSURE_USDC", 15),
```

Per-outcome exposure check:

```ts
const exposureByCondition = new Map(positions.map((position) => [position.conditionId, position.exposureUsdc]));
const currentExposure = exposureByCondition.get(market.conditionId) ?? 0;
if (currentExposure + config.orderSizeUsdc > config.maxPositionPerMarketUsdc) continue;
```

Global exposure check:

```ts
if (exposure + quote.sizeUsdc > maxTotalExposureUsdc) break;
```

Result: PASS after audit patch. The tests verify that a 20C position does not block 19C quoting.

## CHECK 10: Missing Live-Trading Items

- Real CLOB order placement with raw HTTP `postOnly: true`: 3-5h
- Authenticated open-order and position reconciliation: 2-3h
- User WS fill detection for weather conditionIds: 2-4h
- Immediate SELL placement and retry queue after BUY fill: 2-3h
- SELL requeue on cancellation/stale order: 2h
- Durable inventory snapshots per conditionId: 2h
- Multiple-event scheduling beyond one-shot `MAX_EVENTS=1`: 2-3h
- Forecast refresh and cancel/replace loop: 3-4h
- Dashboard weather views/metrics: 2-4h
- 15-minute dry-run-live loop transcript: 0.5h after above dry-run loop is added

## CHECK 11: Test Coverage

Command:

```text
npm test -- --list
```

Actual result: 17 tests, 17 pass.

Covered:

- Weather discovery parsing
- Same-day event exclusion
- Closed/resolved market exclusion
- Probability distribution math
- Price rounding
- Quote eligibility
- Global exposure cap
- Per-condition exposure cap
- CLOB min share rejection
- Simultaneous different-outcome quoting
- SELL-on-fill quote calculation
- Non-BUY fill ignored
- Exit price above 98c rejected

Not covered yet:

- Real CLOB post body and signing
- User WS fill handler
- Reconciler
- Dashboard
- Replay simulation

Result: PASS for current dry-run scope; not sufficient for live.

## Date Check

Current date: 2026-04-20.

Live Gamma date output:

```json
{
  "title": "Highest temperature in Seoul on April 21?",
  "eventDate": "2026-04-21",
  "endDate": "2026-04-21T12:00:00Z",
  "startDate": "2026-04-19T04:14:34.436791Z",
  "markets": 11
}
{
  "title": "Highest temperature in Seoul on April 22?",
  "eventDate": "2026-04-22",
  "endDate": "2026-04-22T12:00:00Z",
  "startDate": "2026-04-20T04:16:09.206909Z",
  "markets": 11
}
```

April 21 markets resolve at `2026-04-21T12:00:00Z`, which is 21:00 Seoul time. April 22 markets are already listed on April 20. Discovery skips `eventDate <= today`, so when April 21 becomes same-day it will move to the next future active market on the next run.
