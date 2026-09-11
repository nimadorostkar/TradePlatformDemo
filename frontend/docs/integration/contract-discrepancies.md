# Contract discrepancies

Every place the sources disagree, what this app does, and why. Resolution
follows the stated priority: gateway code/tests → working TradingView
integration → gateway docs → product spec → assumptions.

Audited 2026-07-30 against `tradeplatform-mt-socket-new` and `trading-view-integration`.
Re-verified 2026-07-31 after the gateway changes described below shipped to
production. Items marked **RESOLVED** were fixed in the gateway and the
corresponding client workaround has been REMOVED — a workaround left in place
after the underlying bug is fixed becomes a bug of its own.

---

## D1 — The trade response has three different shapes ⚠️ HIGH

**Sources disagree.**

- The Go gateway's `POST /api/Trade/send_request` with `source=tv` returns
  `transform.PlacedOrder` — `{id, symbol, side, type, qty, status, message,
avgPrice, filledQty, limitPrice, stopPrice, stopLoss, takeProfit, updateTime}`
  (`internal/domain/trade.go#SendRequest` → `transform.PlacedOrderFromAnswer`).
- Without `source=tv` it returns the raw `PlaceOrderAnswer`, which carries
  `ResultRetcode` — the authoritative MT5 code.
- The working broker adapter reads a **third** shape:
  ```ts
  const response = await this.post<{ order; mTresult; answer }>('/api/Trade/send_request', …);
  return { data: { order: response.data.order, MTStatus: response.data.mTresult, MTMessage: response.data.answer } };
  ```
  (`broker-sample/src/BrokerApiClient.ts#requestTradeAction`)

Against the current Go gateway, `response.data.order` would be `undefined`,
`MTStatus` would be `undefined`, and `_validateMTRequestStatus` compares
`undefined == 0` → `false`, so a **rejected trade would be treated as
successful** and `_createPositionFromOrder(undefined)` would then throw. The
working integration points at `example.com`, which
evidently still returns the .NET-era shape.

**Resolution (revised 2026-08-06).** `interpretTradeResult` accepts four shapes
— the three above plus the gateway's `{order: 0, status: 5, outcome: "unknown"}`
fallback — and derives the verdict by AUTHORITY, not by shape:

| Order | Signal                              | Source                                       |
| ----- | ----------------------------------- | -------------------------------------------- |
| 1     | `outcome`                           | the gateway states it and says to branch on it |
| 2     | `ResultRetcode` / `resultRetcode`   | MT5's own code                                 |
| 3     | `mTresult`                          | .NET-era                                       |
| 4     | `status`                            | derived, and wrong — see below                 |

Two corrections behind that ordering, both verified by running the shipped
gateway against `scripts/mockmt5`:

1. **MT5 retcodes carry text.** The wire value is `"10009 Done"`, never
   `"10009"`. Matching the raw string against `MT5_SUCCESS_RETCODES` recognised
   nothing, so every success fell through to "unrecognised rejection".
   `parseRetcode` now splits the code off before any lookup.
2. **`status` cannot be trusted.** `transform/enums.go#GetStatusType` is an
   exact-match table keyed on the bare number, so every real retcode misses and
   defaults to `5` — Rejected. Branching on it first reported accepted orders as
   refused. It is now consulted only when nothing authoritative is present.

Anything not positively recognised as accepted is `unknown` — **not** a
rejection. An undecided submission may be live, and calling it a failure invites
a resubmit that opens a second position. Covered by
`src/integrations/gateway/api/trading-api.test.ts`.

**To close this:** fix `GetStatusType` in the gateway to parse the retcode
rather than exact-match it, so `status` stops contradicting `outcome`.

---

## D2 — Trade action codes: docs say `0`, working code says `200`

`GATEWAY/docs/USAGE.md` shows:

```bash
-d '{"Login":1001,"Symbol":"EURUSD","Volume":0.1,"Type":0,"TypeFill":0,"Action":"0","source":"tv"}'
```

The working adapter sends `action: "200"` and camelCase field names
(`broker-sample/src/types.ts#MT5ActionCode`). The gateway forwards the body
verbatim to MT5's `/api/dealer/send_request` without reading `Action` itself,
so only MT5's own convention matters — and `200`–`204` are the MT5 Manager
API's trade-action codes.

**Resolution.** The working integration wins. `MT5_ACTION` uses `200`–`204`;
`docs/USAGE.md` is treated as illustrative, not normative.

---

## D3 — WebSocket order `status` used the WRONG mapping table ✅ RESOLVED 2026-07-31

Two mappings, one field:

- REST `/Order/get_page` → `OrdersToTVStd`: `Status: MT5ToTVStatus(State)` ✓
- WebSocket `GetPagebyPageOrder` → `OrdersToTVV2`: `Status: MT5ToTVType(State)` ✗

(`GATEWAY/internal/transform/funcs.go`)

`MT5ToTVType` is an **order-type** table, not a status table. Applied to a
state it collapses distinct meanings:

| WS `status` | MT5 states it could mean         |
| ----------- | -------------------------------- |
| `2`         | STARTED **or** PLACED            |
| `1`         | CANCELED **or** PARTIALLY FILLED |
| `3`         | FILLED **or** REJECTED           |
| `4`         | EXPIRED                          |

So over WebSocket, **filled and rejected are indistinguishable**.

**Resolved in the gateway.** `internal/transform/funcs.go` now emits
`Status: MT5ToTVStatus(int(order.State))` on the WebSocket path, matching REST.

The client workaround (`statusFromWsOrderStatus`, plus the `source`
discriminator on `mapTvOrder`) has been **deleted**. Keeping it would have been
actively harmful once the gateway was fixed: it read the corrected status codes
through the old ambiguity table, so a genuinely working order (status 6) would
have rendered as "Unknown" and a filled one (status 2) as "working". Both
transports now use `statusFromTvStatus`.

---

## D4 — `TP=5` is implemented but undocumented

`GATEWAY/docs/API.md` documents `TP=1..4`. `internal/realtime/dispatch.go`
handles `case "5"` by routing to the tick service, and
`TickService.GetLastDailyBar` exists specifically for TradingView's daily
realtime subscription. The working integration already uses `TP=5`
(`src/TickSubscription.class.ts`).

**Resolution.** Code wins; `TP=5` is used for the daily bar stream.
`docs/API.md` is out of date.

---

## D5 — Account-type allowlists differ between gateway and frontend

- Gateway CRM filter admits `{11, 26, 57–67}` (`internal/auth/crm.go`).
- The working frontend admits only `{57–67}`
  (`AccountInitializer.class.ts#DEFAULT_VALID_ACCOUNT_TYPE_IDS`), and only
  those ids have a defined symbol suffix.

Types 11 and 26 would receive a JWT that authorises them, but the frontend has
no suffix policy for them — so it would send **unsuffixed** symbol names to a
group that may require a suffix.

**Resolution.** The narrower set. `SUPPORTED_ACCOUNT_TYPE_IDS` is `{57–67}`;
any other account is filtered out of the selector rather than silently
mistraded. This is deliberately conservative.

**To close this:** confirm the suffix policy for types 11 and 26 and add them.

---

## D6 — WebSocket positions omitted stop-loss and take-profit ✅ RESOLVED 2026-07-31

`PositionsToTVWs` emits only `timeCreate`; `PositionsToTVPage` (REST) emits
`timeCreate`, `priceSL` and `priceTP` (`transform/funcs.go`).

A naive mapper would leave SL/TP `undefined` and render them as `0` or blank,
telling a trader their protective stop had been removed.

**Resolved in the gateway.** `PositionsToTVWs` now delegates to
`PositionsToTVPage`, so the stream carries `priceSL`, `priceTP`, swap and
commission.

The client behaviour is unchanged and deliberately so: absent SL/TP still maps
to `null` and renders as `Unavailable`, and MT5's own `0.0` ("no level") still
maps to `null`. The gateway supplying the field is not a reason to stop
distinguishing "no level set" from "level unknown".

---

## D7 — `/api/User/get_trade_state` is case-sensitive about `source`

`GetTradeState` compares `source == "tv"` **exactly**, while `Getbylogin`,
`GetQuotes`, `GetSymbolsByName` and others use `strings.EqualFold`
(`internal/domain/user.go`, `symbol.go`, `tick.go`). `source=TV` therefore
behaves differently across endpoints.

**Resolution.** Always send lowercase `tv` / `mt5`. Never rely on case
insensitivity.

---

## D8 — Position ids are capitalised in the TV shape

`TVPositionResponse` tags the id as `"Id"` while every other field is
lower-camel (`transform/tvmodels.go`). The working integration hedges with
`raw.id ?? raw.Id`.

**Resolution.** The schema reads `Id` (correct for the current build); the
mapper normalises to `id`.

---

## D9 — The gateway's `getRequestResult` puts a JSON **string** in `data`

`internal/domain/trade.go#getRequestResult` returns
`response.GlobalResponse{Data: string(body)}` — the raw upstream body as a
string, not an object.

**Resolution.** This is exactly the case `decodeGatewayData` exists for: one
`JSON.parse`, only when the value looks like JSON, never recursive.

---

## D10 — MT5 field casing varies by build

Deal payloads appear as both `Deal`/`deal`, `PositionID`/`positionId`,
`Volume`/`volume`, etc. The working integration handles this with a
`firstDefined(...)` cascade across a dozen spellings.

**Resolution.** Both casings are accepted **at the schema boundary only**
(`mt5DealSchema`), and `mapDeal` normalises once. No React component ever sees
raw MT5 casing.

---

## D11 — Symbol contract limits are per account GROUP

The symbol suffix (`.` ECN, `!` Standard, `#` Social, none for ECNPRO) selects a
different MT5 instrument, and those instruments can carry different volume
limits, tick values, and spreads.

Two consequences the client must handle, both now covered by tests:

1. **Cached symbol records are account-scoped.** `symbolCache` is keyed by
   DISPLAY name, so a record fetched under ECN would otherwise be reused to
   validate a Standard account's orders. It is cleared on every account switch
   (`use-account-sync.ts`).
2. **Live chart streams must be re-pointed.** The chart is deliberately not
   remounted on an account switch — that would reload the TradingView iframe and
   lose the trader's drawings — so its bar and quote subscriptions would keep
   streaming the PREVIOUS group's instrument. `GatewayDatafeed.resubscribeForAccountChange()`
   tears them down, asks the library to drop its cached bars, and re-opens them
   against the new group's symbols.

The watchlist, order ticket, symbol details, and history paths already keyed on
the suffix, so only the chart needed the explicit hook.

---

## D12 — Symbol volume limits are reported in MT5 UNITS, at two scales

`/api/Symbol/getsymbolsbyname?source=mt5` returns the raw MT5 record, in which
volume limits are **not lots**:

| Field                                             | Scale           | `100` means   |
| ------------------------------------------------- | --------------- | ------------- |
| `VolumeMin` / `VolumeMax` / `VolumeStep`          | 1/10000 lot     | 0.01 lots     |
| `VolumeMinExt` / `VolumeMaxExt` / `VolumeStepExt` | 1/100000000 lot | 0.000001 lots |

The two families are **different scales** and must never be read
interchangeably; using the standard divisor on an `Ext` value understates the
limit by four orders of magnitude.

Reading the raw value as lots made the order ticket reject every realistic
order with _"Minimum volume is 100"_ — observed in production before the fix.
`symbolVolumeToLots` now picks the divisor matching the field actually supplied.

Note this is the same ×10000 convention the trade payload already used for
`volume`; only the symbol-limit path had missed it.

---

## D13 — MT5 `Rights` bit 1 is "may change password", not "trading disabled"

Neither reference repository reads the MT5 `Rights` bitmask; the working
integration derives read-only status solely from the CRM's `isReadOnly`. The
rights-based inference in this app was added here, and its first version read
the WRONG bit.

`EnUsersRights`, confirmed against two independent implementations of the
Manager API protocol:

| Flag                        | Value   | Meaning                                                  |
| --------------------------- | ------- | -------------------------------------------------------- |
| `USER_RIGHT_ENABLED`        | `0x01`  | may connect                                              |
| `USER_RIGHT_PASSWORD`       | `0x02`  | **may change password**                                  |
| `USER_RIGHT_TRADE_DISABLED` | `0x04`  | trading disabled                                         |
| `USER_RIGHT_INVESTOR`       | `0x08`  | investor (read-only) login                               |
| `USER_RIGHT_READONLY`       | `0x200` | read-only                                                |
| `USER_RIGHT_DEFAULT`        | `0x163` | ENABLED \| **PASSWORD** \| TRAILING \| EXPERT \| REPORTS |

Because `USER_RIGHT_DEFAULT` includes `PASSWORD`, bit 1 is set on virtually
every real account. Reading it as a trading restriction marked essentially
every account read-only and disabled trading across the terminal — observed in
production.

Three flags genuinely mean "cannot trade": `TRADE_DISABLED`, `INVESTOR`, and
`READONLY`. All three are now checked; `PASSWORD` is explicitly not.

MT5 remains authoritative either way: an order on a genuinely restricted
account is rejected with retcode `10017`, which maps to "Trading is disabled
for this account". The client-side check is a UX affordance, not the control.

---

## D14 — Trading sessions are per-day, per-timezone, and were never parsed

`transform.ConvertSessionsMt5ToTv` emits, e.g.:

    0000-2359:1|0100-0200,1000-1100:3

- `|` separates segments, `,` separates ranges within a segment
- the digit after `:` is the day, **1 = Sunday … 7 = Saturday**
- times are in the SYMBOL's timezone (`Etc/UTC` by default), not the
  browser's
- a range whose end is not after its start wraps past midnight (`2200-0600`)

The client fetched and displayed this string but never interpreted it, so
`validateOrder` accepted a `marketClosed` flag that nothing ever set. A trader
only discovered a closed market from MT5's rejection.

`src/domain/market/session.ts` now parses it and evaluates open/closed in the
symbol's own timezone. Unparseable input yields `unknown`, never `closed` —
blocking a trade on a guess would be worse than letting the server decide, and
MT5 rejects a genuinely closed market with retcode `10018`.

---

## Open questions for the backend team

1. **D1** — which trade-result shape does each environment return? This is the
   difference between correctly reporting a rejection and silently swallowing
   one.
2. **D3** — can `OrdersToTVV2` be corrected to use `MT5ToTVStatus`? Until then
   order status over WebSocket is genuinely ambiguous.
3. **D5** — what is the suffix policy for account types 11 and 26?
4. Is there an intended path to idempotent trade submission? Today a timeout
   leaves the outcome genuinely unknown and the client must refetch to resolve it.
5. Will `/api/Tick/get_marketdepth`'s response shape be documented, so DOM can
   be enabled?
