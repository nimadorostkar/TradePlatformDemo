# API Reference

Base URL (default): `http://<host>:5063`. All REST responses use the envelope:

```json
{ "data": <any>, "errorMessage": null, "message": "Success: Action performed successfully.", "success": true }
```

**Status convention:** `success:true` → **200**; `success:false` → **400**;
auth failures → **401**; account mismatch → **403**; `Test/*` errors → **500**.

**`data` shape (per-endpoint, preserved from the .NET service):**
- **string** — raw upstream JSON as a JSON-encoded string (passthrough endpoints)
- **object** — typed object (`source=mt5` on TV-capable endpoints)
- **TV shape** — TradingView model(s) when `source=tv`

The `source` query param (default `mt5`) selects raw vs TradingView output on
endpoints that support it. See `docs/PARITY-NOTES.md` for the exact per-endpoint
classification; `internal/httpapi/handlers/testdata/golden/*.json` are frozen
examples.

> **Volume units:** MT5 reports volume at two different scales and mixing them is
> silent — it has already caused one production incident. Every field ending in
> `Lots` is in lots; everything else is in MT5 units. **[docs/VOLUME-UNITS.md](VOLUME-UNITS.md)
> states the unit of every volume field** — read it before building an order ticket.

> **Timestamp contract (TIME-001, 2026-08-12):** every epoch this API emits —
> quotes, chart bars, deals, closed orders, positions, order setup times,
> executions, placed-order `updateTime` — is **UTC** (seconds unless the field
> name says `Msc`/the endpoint documents milliseconds). Every `from`/`to`
> window a client sends is interpreted as **UTC** and restated on the broker's
> clock at the MT5 boundary by the shared broker-clock resolver. MT5's own
> broker-local stamps never cross the public API. Display timezone is entirely
> the client's concern. (Non-numeric date-string windows pass through
> unconverted for .NET-era callers.)

## Capabilities — `GET /api/Capabilities` (anonymous)

Feature-detect here rather than by calling an endpoint and interpreting the
failure. Each entry is `{ "enabled": bool, "reason": "…" }`; a disabled feature
always carries the reason it is off.

```json
{ "alerts": {"enabled": false, "reason": "No database is configured on this gateway."},
  "workspace": {"enabled": true}, "news": {"enabled": false, "reason": "…"},
  "calendar": {"enabled": false, "reason": "…"}, "executions": {"enabled": true},
  "marketDepth": {"enabled": true}, "tradeIdempotency": {"enabled": true} }
```

## Auth

- **Scheme:** `Authorization: Bearer <jwt>` (HS256). Obtain a token from the
  Authentication endpoints.
- **`[Authorize]`** = JWT required. **`[AccountsAuthorize]`** = JWT must carry an
  `accounts` claim that contains the requested `login` (else 401/403). Anonymous
  endpoints: `Authentication/*` and `Capabilities`.

---

## Authentication (anonymous)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/Authentication/login` | `{ "Username", "CRMToken", "Remember"? }` | `{ "token": "<jwt>" }` (200) / 401 |
| POST | `/api/Authentication/crmlogin` | `{ "email", "password", "Remember"? }` | `{ "token": "<crm-token>" }` (200) / 401 |
| POST | `/api/Authentication/accounts` | `{ "CRMToken" }` | `Account[]` (200) / 401 |
| GET | `/api/Authentication/session` | — (cookie-authenticated) | `{ "token", "crmToken"?, "username"? }` (200) / 401 |
| POST | `/api/Authentication/logout` | — | `{ "loggedOut": true }` (200) |

`login` issues a token only when a `CRMToken` is supplied (CRM-validated).
The username/password-only path is removed entirely and always returns 401.

`Remember` is the trader's "keep me signed in" choice, and BOTH routes need it.
On `login` it decides the session cookies' MaxAge (`SESSION_RESTORE_TTL` vs
browser-session-only). On `crmlogin` it is forwarded to the CRM as `rememberMe`,
which sets how long the CRM token itself lives — and that is the credential the
restore in the next section re-presents, so a long cookie holding a short CRM
token ends the session early no matter what MaxAge says. Omitted means false.

### Session restoration (AUTH-001)

`login` additionally stores the session in `HttpOnly; SameSite=Lax; Path=/`
cookies — `Secure` as well whenever the request arrived over TLS (directly or
per the edge's `X-Forwarded-Proto`), so a plain-HTTP deployment keeps a
restorable session instead of a cookie the browser discards — (`tradeplatform_session` = the JWT, `tradeplatform_crm` = base64url CRM
token, `tradeplatform_user` = base64url username), with `Max-Age` equal to
`JWT_EXPIRY`. `GET /session` hands them back to the app after a reload; an
invalid/expired cookie earns a 401 and the cookies are cleared. The cookies are
a **restoration channel only** — every API route still authenticates with the
Bearer token, the gateway grants no credentialed CORS, and `Lax` keeps the
cookies off every cross-site request. Sessions remain stateless signed JWTs;
`logout` clears the cookies but cannot revoke a JWT a client still holds
(documented limitation — revocation requires a server-side session store).

### Accounts and symbol suffixes

```json
[{ "login": "1010", "typeId": 57, "suffix": ".", "suffixKnown": true }]
```

Only account types whose symbol suffix is known may trade through this terminal —
a wrong suffix sends a wrong symbol name to MT5. The admitted types and their
suffixes are configuration (`CRM_ALLOWED_ACCOUNT_TYPES`,
`CRM_ACCOUNT_TYPE_SUFFIXES`); the default admits **57–67** only.

**Types 11 and 26** are returned by the CRM but have no confirmed suffix, so they
are excluded by default. Once their suffix is confirmed, add them to both env
vars — no code change and no redeploy of the client.

**Do not build symbol names for an account with `suffixKnown: false`.**

## Order — `/api/Order` (JWT)

| Method | Path | Query / Body | `source` | data |
|---|---|---|---|---|
| GET | `/get` | `ticket` (uint) | — | string |
| GET | `/get_total` | `login` (int) | — | string |
| GET | `/get_page` ⟨AccountsAuthorize⟩ | `login,offset,total` | yes | object / TV array |
| GET | `/get_batch` | `login,group,ticket,symbol` | — | string |
| DELETE | `/delete` | `ticket` (string) | — | string |
| POST | `/update_order` | `OrderRequest` | — | TVResponseModifyOrder |
| GET | `/cancel` | `ticket` (string) | — | string |
| GET | `/list` | `from,to,server` | — | string |
| GET | `/getbackup` | `backup,login,ticket,from,to,server` | — | string |
| POST | `/restore` | `OrderRequest` | — | string |
| GET | `/reopen` | `ticket` (uint) | — | string |

## Position — `/api/Position` (JWT)

| Method | Path | Query / Body | data |
|---|---|---|---|
| GET | `/get` | `login,symbol,source` | object / TVPosition |
| GET | `/get_total` | `login` | string |
| GET | `/get_page` ⟨AccountsAuthorize⟩ | `login,offset,total,source` | object / TVPosition[] |
| GET | `/get_batch` | `login,group,ticket,symbol` | string |
| POST | `/update_position` | `PositionRequest` | UpdatePositionResponse |
| DELETE | `/delete` | `ticket` | string |
| GET | `/backup_list` | `from,end,server` | string |
| GET | `/backup_get` | `backup,login,from,end,server` | string |
| POST | `/restore` | `PositionRequest` | string |
| GET | `/checkPosition` | `login` | string |
| GET | `/fixPosition` | `login` | string |

## Deal — `/api/Deal` (JWT)

Passthrough (string): `/get?ticket`, `/get_total?login&from&to`,
`/get_page?login&from&to&offset&index`,
`/get_batch?login&group&ticket&from&to&symbol`, `POST /update_deal`,
`DELETE /delete?ticket`, `/backup_list?from&to&server`,
`/backup_get?backup&login&from&to&server`, `POST /restore_deal`,
The legacy `/GetDataByWebSocket` localhost demo endpoint is not registered.

### Executions (per-fill feed)

| Method | Path | Query | data |
|---|---|---|---|
| GET | `/since` ⟨AccountsAuthorize⟩ | `login`, `after` (unix s), `limit` (≤500) | `TVExecution[]` |

```json
[{ "id": "9002", "orderId": "1", "positionId": "7", "symbol": "EURUSD",
   "price": 1.1003, "qty": 3, "qtyMt5": 30000, "side": 1,
   "time": 1750000, "timeSeconds": 1750,
   "commission": -1.05, "swap": 0, "profit": 0, "entry": 0, "comment": "" }]
```

- `qty` is in **lots**, `qtyMt5` in MT5 units. `side` is `1` buy / `-1` sell.
- `time` is unix **milliseconds** (TradingView's convention for execution
  markers); `timeSeconds` is the cursor to send back as `after`.
- `after` is **exclusive**, so polling with the newest `timeSeconds` seen never
  re-delivers a fill. Omitting it returns the last 24 hours.
- Balance operations (deposits, credits, corrections) are excluded — they carry
  no price and must never become chart markers.

## History — `/api/History` (JWT) — closed orders

`/get?ticket`, `/get_total?login&from&to`,
`/get_page?login&from&to&offset&total&source` (object / TV array),
`/get_batch?login&groups&tickets&from&to&symbol`, `DELETE /delete?ticket`
(ignores ticket — quirk), `POST /update_history`. All but `get_page` → string.

## Symbol — `/api/Symbol` (JWT)

| Path | Query | data |
|---|---|---|
| `/getlist` | — | object (MT5SymbolResponse) |
| `/getsymbolsbyname` | `symbol,source` | object / TVSymbol[1] |
| `/getsymbolsbymask` | `mask,source` | object / TVSymbol[] / string |
| `/getsymbolsbygroup` | `symbol,group,source` | object / TVSymbol[1] |
| `/getGroup` | `group` | string |

## Tick — `/api/Tick` (JWT)

| Path | Query | data |
|---|---|---|
| `/last` | `symbol,Id,source` | object / Quote[] |
| `/last_group` | `symbol,group,Id` | string |
| `/stat` | `symbol,Id` | string |
| `/history` | `symbol,from,to,data` | string |
| `/get` | `symbol,from,to,data` | TVTickResponse[] (chart bars) |
| `/getHistoryby1Dresolution` | `symbol,from,to,resolution` | TVTickResponse[] (1D/1W/1M buckets) |
| `/get_marketdepth` | `symbol` | object (MarketDepth) |

### Chart time base — everything is UTC

`from`, `to`, and the `time` on every bar returned by `/get`,
`/getHistoryby1Dresolution` and their WebSocket equivalents are **unix seconds
in UTC**. Send UTC; you get UTC back.

MT5 itself does not work in UTC — it selects and stamps chart data on the trade
server's own clock (Opogroup-Server1 runs UTC+3). The gateway shifts each window
onto that clock on the way out and shifts every bar back on the way in, so the
broker's timezone never reaches a client. The offset is read from the last
tick's `Datetime` (cached ~30s) and rounded to the nearest quarter hour, so a
tick that printed a few seconds ago cannot knock M1 bars off their minute
boundaries. If the broker clock cannot be read, no shift is applied.

Two things stay on the **broker's calendar**, because a trading day is the
broker's day and not UTC's: the `1D`/`1W`/`1M` bucket boundaries, and the
"today" window of the daily realtime bar. Their `time` values are still
returned in UTC — a daily candle is stamped at broker midnight *expressed in
UTC*, not at UTC midnight.

Quotes carry the same clock. Every `/last?source=tv` quote has a `time` — when
the broker printed it, in UTC seconds — so a tick can be placed on the same
axis as the bars. That is what lets a client drive the forming candle from the
quote stream instead of stamping ticks with its own clock and hoping the two
agree.

### Live chart window

`to=1` is the live sentinel: "up to now". It pairs with `from` as follows.

| `from` | Window served | Use |
|---|---|---|
| `0` | the last **5 minutes** | the normal live edge; covers a brief stall with no client change |
| `T` (unix seconds, UTC) | `[T, now]`, capped at 24h | a client that missed pushes backfills its own hole |

The push cadence (`WS_PUSH_CADENCE`, default 3s) is the chart's update
resolution: the gateway polls MT5, so nothing arrives faster than that. Anything
older than the served window is never re-sent, which is why a client that has
been away — a backgrounded tab, a dropped socket, a market reopening — should
send `from` = its newest bar rather than relying on the default lookback.

> Before this was fixed, a client's UTC window was passed to MT5 unconverted
> while the live subscription built its window from the broker clock. History
> was fetched from three hours earlier and mislabelled as current, live bars
> arrived stamped three hours ahead, and the chart opened with a three-hour gap
> between the two on every login.

### Market depth (DOM)

```json
{ "symbol": "EURUSD", "volumeUnit": "lots",
  "bids": [{ "price": 1.0850, "volume": 10, "market": false }],
  "asks": [{ "price": 1.0852, "volume": 12, "market": false }],
  "crossed": false, "unclassified": 0 }
```

- **Volumes are in lots**, and the payload says so in `volumeUnit`.
- `bids` are ordered best (highest) first, `asks` best (lowest) first.
- `market` marks the market-order side of the book — liquidity with no
  meaningful limit price.
- **`crossed: true` means do not trust this ladder.** A healthy book never has
  best bid ≥ best ask; when it does, the configured book-side convention does
  not match this broker (see `MT5_BOOK_SIDE_CONVENTION`). It is reported rather
  than silently repaired — showing liquidity a trader cannot hit is worse than
  showing none.
- `unclassified > 0` means some entries had a side code outside the convention
  and were dropped, so the ladder is partial. `unknownSideCodes` lists the
  distinct codes that were skipped (omitted when there are none) — that is the
  value to account for, and the difference between a diagnosable gap and a
  standing mystery.

## Trade — `/api/Trade` (JWT)

| Method | Path | Query / Body | data |
|---|---|---|---|
| GET | `/balance` | `login,type,balance,comment` | string |
| GET | `/calc_buy_rate` | `basecurrency,currency,group,symbol,price` | string |
| GET | `/calc_sell_rate` | (same) | string |
| GET | `/check_margin` | `login,symbol,type,volume,price` | string |
| GET | `/calc_profit` | `group,symbol,type,volume,price_open,price_close` | string |
| POST | `/send_request` ⟨AccountsAuthorize⟩ | `TradeRequest` (incl. `source`) | object / PlacedOrder |
| GET | `/get_request_result` | `id` | string / `{order,status,outcome,…}` |

### Trade response shape (settled)

`send_request` returns **one** shape per `source`, and MT5's own verdict is
always on it:

- **`source=tv` → `PlacedOrder`**, with `resultRetcode` (MT5's raw string, e.g.
  `"10009 Done"`) **always present**, plus the parsed `outcome` and a
  human-readable `retcodeDescription`.
- **otherwise → the raw MT5 `PlaceOrderAnswer`**, which carries `ResultRetcode`.

```json
{ "id": "100002", "symbol": "EURUSD", "qty": 10000, "qtyLots": 1,
  "filledQty": 10000, "filledQtyLots": 1, "status": 5,
  "resultRetcode": "10009 Done", "outcome": "accepted",
  "retcodeDescription": "Request completed",
  "expiration": 0, "typeTime": 0, "duration": { "type": "GTC", "datetime": null } }
```

**Branch on `outcome`, never on the shape.**

| `outcome` | Meaning | Retcodes |
|---|---|---|
| `accepted` | MT5 took the order | `10008` placed, `10009` done, `10010` partial |
| `rejected` | MT5 refused it | everything else with a readable code |
| `unknown` | **The result could not be read** | `10012` timeout, absent/unparseable retcode |
| `not_submitted` | The gateway refused the request; nothing reached the dealer | — |

`unknown` is a real answer, not a failure to compute one. Reconcile against
Positions; do **not** report a failure and do **not** resubmit. Note that the
legacy `status: 5` on the unreadable-result fallback is the .NET literal and
reads as "rejected" on its own — `outcome` is the field that tells the truth.

`not_submitted` is the opposite guarantee: no order can exist, so retry rather
than reconcile. Today it means the idempotency store was unreachable and the
submission was refused instead of risking a duplicate position.

Every one of these fallbacks is `success: false`, carries
`{order, status, outcome, message}` in `data`, and repeats the same sentence in
the envelope's `message` and `errorMessage`. Once `/send_request` has reached
MT5, the gateway never answers `success: true` without a real trade result —
an empty or unparseable MT5 response, an unrecognized `get_request_result`
payload, and a missing answer are all `outcome: "unknown"`.

### Order duration (GTC / DAY / GTD)

`send_request` accepts any of these, case-insensitively, and translates them to
MT5's `TypeTime` / `TimeExpiration` pair:

| Client field | Example |
|---|---|
| `typetime` + `expiration` | `{"typetime": 2, "expiration": 1800000000}` |
| `expiration` alone | implies good-till-specified |
| `duration` block | `{"duration": {"type": "GTD", "datetime": 1800000000}}` |

`expiration` is unix **seconds**; `0` means good-till-cancelled. A GTD with no
deadline is downgraded to GTC rather than sent as an expiry of 1970, which MT5
answers with `INVALID_EXPIRATION`. A body with no duration fields is forwarded
byte-for-byte unchanged.

Order shapes carry `expiration`, `typeTime`, and the TradingView-native
`duration` block on the way back.

### Idempotency

A trade that times out has genuinely unknown outcome, and a retry can open a
second position. Supply a key and the retry is safe:

- Header `Idempotency-Key: <uuid>`, or body `clientRequestId` / `idempotencyKey`.
- A repeat inside the window (`TRADE_IDEMPOTENCY_TTL`, default 10m) **replays the
  original result** and never reaches the dealer again. Replays are marked with
  the `Idempotent-Replay: true` response header.
- A repeat arriving while the original is still in flight waits briefly, then
  answers `outcome: "unknown"` — it is never submitted twice.
- Keys are scoped per account, so two traders using the same key cannot see each
  other's result. Keys longer than 128 chars are ignored (the submission is then
  simply not idempotent) rather than truncated.
- With `REDIS_ADDRS` set the guarantee holds across replicas; without it, only
  within one process.

## Alerts — `/api/Alert` (JWT + AccountsAuthorize)

Server-side price alerts: they keep working after the browser tab closes.

| Method | Path | Query / Body | data |
|---|---|---|---|
| GET | `/list` | `login` | `Alert[]` |
| POST | `/create` | `{ login, symbol, condition, price, note }` | `Alert` |
| DELETE | `/delete` | `id`, `login` | `{ id, deleted }` |

```json
{ "id": 4, "login": "1010", "symbol": "EURUSD", "condition": "below",
  "price": 1.2, "note": "smoke test", "status": "triggered",
  "createdAt": "…", "triggeredAt": "…", "triggeredPrice": 1.0851 }
```

- `condition` is `"above"` or `"below"`; comparison is **inclusive** (a quote
  landing exactly on the level has reached it).
- Alerts are evaluated server-side against the same "last price" the terminal
  displays (`Last` when the venue publishes one, `Bid` otherwise).
- `triggeredPrice` is the quote that crossed the level, not the level itself.
- `login` is required on delete and is matched in the DELETE itself — an id
  alone would let any authenticated trader delete another trader's alert.
- Max 200 active alerts per account.
- With no database configured these endpoints **fail with the reason** rather
  than returning an empty list a trader would read as "you have no alerts".
  Check `/api/Capabilities` first.

## Workspace — `/api/Workspace` (JWT + AccountsAuthorize)

| Method | Path | Query / Body | data |
|---|---|---|---|
| GET | `/get` | `login` | `{ login, document, version, updatedAt }` |
| POST | `/save` | `{ login, document }` | same |

The `document` is an opaque JSON blob — the client versions and migrates its own
layout format, so the server stores it whole and returns it whole. `version`
increments on every save, so a client can tell whether its copy is current. A
login that has never saved is a **success** with `document: null, version: 0`.
Documents must be valid JSON and under 1 MiB.

## News / calendar — `/api/News/list`, `/api/Calendar/list` (JWT)

Pass-throughs to whichever provider the firm licenses, with the API key kept
server-side and responses cached (`CONTENT_CACHE_TTL`, default 60s). Only an
allowlist of query parameters is forwarded upstream: `symbol`, `symbols`,
`from`, `to`, `limit`, `lang`, `country`, `importance`, `category`. With no
provider configured both report the reason; check `/api/Capabilities`.

## User — `/api/User` (JWT + AccountsAuthorize)

| Path | Query | data |
|---|---|---|
| `/get` | `login,source` | object / TVUserResponse[1] |
| `/get_trade_state` | `login,source` | object / TVAccountSummary |

## Test — `/api/Test` (JWT)

`/getServerTime`, `/getUTCTime` → `{ "unixTimestamp": "<seconds>" }`.
The duplicate `/testMethod` and `/testMethod1` aliases are not registered.

## Removed legacy TradingView Orders — `/api/tv/TVOrder`

The .NET compatibility controller duplicated the canonical trading flow, used
hardcoded account logins, and included an empty history stub. It is not
registered in the production gateway. All paths below it return 404. The React
terminal uses the canonical account-scoped `/api/Trade`, `/api/Order`, and
`/api/Position` routes.

## Operational (additive, not in the .NET service)

| Path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | liveness |
| `GET /readyz` | none | readiness (200 ready / 503 not) — tracks MT5 session |
| `GET http://<METRICS_ADDR>/metrics` | private network | Prometheus exposition on the dedicated metrics listener |
| `GET /` | none | HTML landing page (links to `/swagger`) |

---

## WebSocket — `/ws`

JWT is required by default (`WS_REQUIRE_AUTH=true`). Browsers pass protocols
`tradeplatform.v1` and `tradeplatform.jwt.<jwt>` to the `WebSocket` constructor; the server
negotiates only `tradeplatform.v1` and never echoes the credential. Non-browser clients
may send `Authorization: Bearer <jwt>`. Migration-only query authentication is
controlled by `WS_ALLOW_QUERY_TOKEN` and should be disabled because URLs are
commonly logged. **The subscription is the query string** — there is no subscribe
message.

**Query params:** `symbol, id, methodtype, group, login, offset, total, ticket,
TP, source, fromtime, totime, data`.

**`TP` selects the service; `methodtype` selects the call:**

| TP | Service | `methodtype` values |
|---|---|---|
| 1 | Tick | `GetMarketDepth`, `GetStatistics`, `GetQuotes`, `GetQuotesByGroup`, `GetM1History`, `GetHistoryBy1DResolution` |
| 2 | Position | `GetPosition`, `GetTotalPosition`, `GetPagebyPagePositionWs`, `GetPositionBatch` |
| 3 | User | `Getbylogin`, `GetTradeState` |
| 4 | Order | `GetPagebyPageOrder` |
| 6 | Alerts | — (`login`; optional `fromtime` cursor) |
| 7 | Executions | — (`login`, `fromtime` cursor, optional `total`) |
| other | — | streams the literal `Invalid TP value` |

**TP 6 (alerts):** with `fromtime` set, only alerts that fired *after* that unix
second are pushed, so each trigger renders exactly once; without it, the full
alert list is pushed.

**TP 7 (executions):** same `after`-style cursor as `GET /api/Deal/since`, passed
as `fromtime`.

**Order status over the WebSocket** (`TP=4`) uses the same status table as the
REST path. It previously used the order-*type* table, which collapsed distinct
states onto one number — status `1` meant CANCELED *or* PARTIALLY FILLED and `3`
meant FILLED *or* REJECTED, so a filled order and a rejected one were
indistinguishable. That is fixed; treat the WS `status` as authoritative.

**Position shapes** (`TP=2`) carry `priceSL` / `priceTP` — the WS mapping omitted
them, so protective levels were unknowable between REST snapshots. Both the WS
and REST position shapes also carry `swap` (from MT5 `Storage`) and
`commission`. Those two are **nullable on purpose**: `null` means the broker did
not send the value, `0` means a real zero. Do not render `null` as `0` — a
trader reconciling costs reads them as different facts. (MT5's position record
carries `Storage` on every build; `Commission` only on builds that expose it,
so it is commonly `null`.)

**Message:** the server pushes the serialized `data` field (not the envelope)
every ~3s (configurable `WS_PUSH_CADENCE`). Example connect:

```js
const ws = new WebSocket(
  'wss://host/ws?symbol=EURUSD&id=0&methodtype=GetQuotes&TP=1&source=tv',
  ['tradeplatform.v1', `tradeplatform.jwt.${token}`],
);
```

Example tick frame (`source=tv`, `GetQuotes`):

```json
[{"symbolname":"EURUSD","status":"Ok","bid":1.0854,"ask":1.0856,"lastprice":1.0854,"volume":12}]
```

With `NATS_URL` set, fan-out is cluster-wide (a leader-elected poller does the
single upstream poll per subscription); the client contract is unchanged.
