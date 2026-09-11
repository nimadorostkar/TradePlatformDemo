# Parity Notes — REST Stage

This records the deliberate, bounded deviations from the .NET service made while
porting the REST layer, plus the quirks faithfully reproduced. Each deviation is
either non-observable, low-risk, or scheduled for a later stage. Golden-file
tests against the live .NET service (planned) are the objective check.

## Faithfully reproduced (observable behavior preserved)

- **`data` shape per endpoint.** RAW_STRING passthrough emits `data` as a
  JSON-encoded **string** (e.g. `"data":"{\"retcode\":...}"`); the `source=mt5`
  typed branch emits a nested **object**; `source=tv` emits the transformed
  shape. Two TV branches (`Order.GetPagebyPageOrder`, `Position.GetPagebyPagePositionWs`)
  emit the transformed list re-serialized as a **string**, matching .NET.
- **Envelope + status.** `{data,errorMessage,message,success}` field order;
  `message="Success: Action performed successfully."` on success; the
  un-substituted `"...{0}."` template on upstream failure; success→200/failure→400.
- **TV transforms.** All mapping tables, the `side=Type%2` vs raw-`side` quirk,
  the `GetPagebyPageOrder` status-from-type-map quirk, symbol session/path
  converters, `lastprice = Last>0?Last:Bid`, `updateTime=(UTCunix+3h)*1000`,
  constant `TVSymbolResponse` defaults.
- **Quirks:** `history/delete?ticket=tickets` (ignores the arg); `string.Join(",",
  ticket)` char-splitting on order ticket/delete/cancel; the hardcoded
  `UpdateOrder(ModifyOrderRequest)` body (Login=1020) and parameterless
  `GetPage()` (login=1020); anonymous `Authentication` and `tv/TVOrder`
  controllers; `AccountsAuthorize` 401 (no claim) / 403 (not a member).

## Deliberate deviations (documented)

1. **OBJECT (`source=mt5`) branches forward the raw upstream JSON object** rather
   than deserializing into a typed DTO and re-serializing. Result: structurally
   identical (`data` is a nested object with the same keys/values); the only
   possible difference is **field ordering** and any C#-only default fields the
   .NET typed re-serialization would have added. JSON consumers read by key, so
   this is functionally equivalent. To be tightened with golden tests if exact
   byte-order parity is required.

2. **Date/time query params are forwarded as the raw strings the client sent.**
   The .NET service bound some to `DateTime` and reformatted via culture-specific
   `ToString()` into the upstream URL. Reproducing a server's locale formatting
   is brittle and the upstream expects what clients already send, so we pass the
   original strings through (more faithful to the actual wire value, not less).

3. **`Trade.GetRequestResult` does not reproduce the .NET infinite-loop
   pathology.** In .NET, a persistent non-empty upstream error body causes the
   retry counter never to advance (an unintended infinite loop). We return that
   error envelope instead. Transport/empty failures still use the
   `{order:0,status:5}` fallback with ≤3 attempts / 100ms, as in .NET.

4. **`Login` hardening (permanent).** The username-only login path is removed —
   `POST /api/Authentication/login` requires a `CRMToken` and returns 401
   otherwise. The CRM path is unchanged.

5. **Chart times are UTC on the wire; .NET's are broker-stamped (permanent).**
   This is the one place the port deliberately contradicts the original rather
   than extending it, so it is worth stating plainly.

   MT5 selects and stamps chart data on the trade server's clock (EET/EEST for
   this broker). The .NET service never converts: it forwards a client's
   `from`/`to` to `MT5_get_history` verbatim and returns MT5's stamps unchanged,
   while building the live-chart window (`from==0 && to==1`) from the broker
   clock instead. The two windows therefore sit on different clocks — history is
   fetched from `offset` seconds earlier and mislabelled as current, live bars
   arrive stamped `offset` ahead — and a client that sends UTC windows gets a
   chart with a broker-offset-wide gap between its history and its live edge.
   The .NET gateway still behaves this way; it was left as-is by decision.

   This port converts at the MT5 boundary instead (`fetchChartUTC`): windows are
   shifted onto the broker clock going out, bars shifted back coming in. Every
   `from`/`to` and every bar `time` on `/api/Tick/get`,
   `/getHistoryby1Dresolution` and their WebSocket equivalents is UTC, and the
   rows written to `price_history` / `daily_data` are UTC too.

   Reproducing .NET here was not an option: the terminal renders its chart in
   UTC+3, so a bar for the current minute has to carry a UTC epoch to land on
   the trader's wall clock. Broker-stamped epochs land three hours ahead.

   What *is* reproduced is the broker's **calendar**: `1D`/`1W`/`1M` buckets and
   the daily realtime bar are still cut on broker days, since a trading day is
   the broker's day — the bucket key is computed on broker time and restated in
   UTC. The offset resolver itself follows the .NET one closely (whole-hour
   rounding, ±14h plausibility check, last-known-value and EEST fallbacks,
   `DatetimeMsc` preferred over `Datetime`); see that repo's
   `BUG_REPORT_Chart_Candle_Lag.md` for why each of those exists.

## Deferred to later stages (no data-shape change on the default path)

- **SymbolService `IMemoryCache`** (24h symbol-detail / 60m group caches with
  cross-call accumulation) → caching/Redis stage. The API (cache-miss) path is
  implemented and returns identical shapes.
- **TickService DB paths** — `ReadDataFromDbOrAPI=true` and the pre-aggregated
  daily rows folded into `GetHistoryBy1DResolution` → data stage. The live-API
  path (the production default, `ReadDataFromDbOrAPI=false`) is implemented,
  including the `from==0&&to==1` broker-time live-window trick and 1D/1W/1M
  bucketing over live M1 bars.
- **`Deal.GetDataByWebSocket`** (a localhost WS demo method) returns an empty 200
  rather than reproducing the demo's `while(true)` receive loop.
