# Gateway contract matrix

Verified against source, not documentation. Every row cites the file that
produces the behaviour, in these repositories:

- `GATEWAY` = `/Users/nima/Projects/opotrade-mt-socket-new` (Go OpoMTSocket)
- `TV` = `/Users/nima/Projects/trading-view-integration` (working integration)

Audited 2026-07-30.

---

## 1. Transport and envelope

| Property                  | Value                                                 | Source                                                                          |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| REST base (local default) | `:5063`                                               | `GATEWAY/internal/config/config.go` — `HTTP_ADDR`                               |
| Envelope                  | `{ data, errorMessage, message, success }`            | `GATEWAY/internal/httpapi/response/response.go`                                 |
| Status convention         | `success` → 200, failure → 400                        | `response.Write`                                                                |
| Auth (REST)               | `Authorization: Bearer <gateway-jwt>`                 | `GATEWAY/internal/httpapi/middleware/auth.go#JWTAuth`                           |
| Account scoping           | requested `login` must be in the JWT `accounts` claim | `middleware/auth.go#AccountsAuthorize` — missing claim → 401, wrong login → 403 |
| WS push cadence           | ~3s (`WS_PUSH_CADENCE`)                               | `config.go`                                                                     |

### The `data` polymorphism

This is the single most important thing to get right at the boundary.
`GATEWAY/internal/domain/domain.go#toEnvelope` sets `Data: string(body)` for
every endpoint that does not override it. So `data` is one of:

| Shape                     | When                                                      | Handling         |
| ------------------------- | --------------------------------------------------------- | ---------------- |
| **JSON-encoded string**   | "RAW_STRING" endpoints (no transform)                     | one `JSON.parse` |
| **Object / array**        | service assigns `json.RawMessage(body)` or a typed struct | use directly     |
| **`{answer: …}` wrapper** | raw MT5 passthrough                                       | unwrap one level |

`decodeGatewayData` (`src/integrations/gateway/contracts/envelope.ts`) decodes
**at most one** layer, and only when the string starts with `{` or `[`.
Recursively parsing would corrupt a trade comment that happens to look like JSON.

---

## 2. Authentication

| Route                                     | Method | Auth       | Body                             | Response                               | Consumer                      |
| ----------------------------------------- | ------ | ---------- | -------------------------------- | -------------------------------------- | ----------------------------- |
| `/api/Authentication/crmlogin`            | POST   | anonymous  | `{email, password}`              | **`{token}` — NOT enveloped**, 200/401 | `CrmAuthSession.signIn`       |
| `/api/Authentication/login`               | POST   | anonymous  | `{Username, Password, CRMToken}` | **`{token}` — NOT enveloped**          | `CrmAuthSession.exchange`     |
| `{CRM}/client-api/accounts?version=1.0.0` | POST   | CRM bearer | `{}`                             | `UserAccount[]`                        | `CrmAuthSession.listAccounts` |

Verified in `GATEWAY/internal/httpapi/handlers/handlers.go` — both routes use
`response.WriteStatus(w, 200, tokenResponse{...})`, bypassing the envelope.

**There is no refresh endpoint.** `mount.go` registers only `/login` and
`/crmlogin`. When the gateway JWT expires we re-run the CRM exchange if a CRM
token is still held, otherwise we require reauthentication. Do not invent one.

`/login` requires a `CRMToken`; the legacy "mint a JWT from a bare username"
path was **removed** in the Go gateway because it issued valid tokens without
credentials.

JWT claims: `accounts` (comma-joined logins), `exp`, `iat`, and `iss`/`aud`
when configured. Signing is HS256 over the ASCII secret bytes
(`GATEWAY/internal/auth/jwt.go`).

---

## 3. REST endpoints in use

| Route                                    | Query                                    | `data` shape                                        | Domain mapper                 |
| ---------------------------------------- | ---------------------------------------- | --------------------------------------------------- | ----------------------------- |
| `GET /api/Test/getServerTime`            | —                                        | **bare `{unixTimestamp}`, not enveloped**           | `MarketApi.serverTimeSeconds` |
| `GET /api/Symbol/getsymbolsbymask`       | `mask`, `source=tv`                      | `TVSymbolResponse[]`                                | `mapTvSymbol`                 |
| `GET /api/Symbol/getsymbolsbyname`       | `symbol`, `source=tv`                    | `TVSymbolResponse[1]`                               | `mapTvSymbol`                 |
| `GET /api/Symbol/getsymbolsbyname`       | `symbol`, `source=mt5`                   | raw MT5 symbol in `{answer}`                        | `mt5SymbolDetailSchema`       |
| `GET /api/Tick/last`                     | `symbol`, `id`, `source=tv`              | `Quote[]`                                           | `mapTvQuote`                  |
| `GET /api/Tick/get`                      | `symbol`, `from`, `to`, `data=dhloc`     | `TVTickResponse[]`                                  | datafeed `getBars`            |
| `GET /api/Tick/getHistoryby1Dresolution` | `symbol`, `from`, `to`, `resolution`     | `TVTickResponse[]`                                  | datafeed `getBars`            |
| `GET /api/Tick/get_marketdepth`          | `symbol`                                 | raw MT5 book — **shape unverified**                 | capability-gated              |
| `GET /api/User/get_trade_state`          | `login`, `source=mt5`                    | `{retcode, answer:{Balance,Equity,…}}`              | `mapAccountState`             |
| `GET /api/User/get`                      | `login`, `source=mt5`                    | `{answer:{Login,Name,Rights,…}}`                    | `readOnlyFromRights`          |
| `GET /api/Position/get_page`             | `login`, `offset`, `total`, `source=tv`  | `TVPositionResponse[]` **with** `priceSL`/`priceTP` | `mapTvPosition(…, 'rest')`    |
| `GET /api/Order/get_page`                | `login`, `offset`, `total`, `source=tv`  | `TVOrderHistory[]`, status from `MT5ToTVStatus`     | `mapTvOrder(…, 'rest')`       |
| `GET /api/Deal/get_page`                 | `login`, `from`, `to`, `offset`, `index` | raw MT5 deals                                       | `mapDeal`                     |
| `POST /api/Trade/send_request`           | body + `source=tv`                       | see §5                                              | `interpretTradeResult`        |

`/api/Deal/get_page` reads `index` and falls back to `total` when index is 0
(`handlers.go#DealGetPage`); we send both.

**Not used:** `/api/tv/TVOrder/*`. Those routes are anonymous and build
hardcoded MT5 requests (`Login=1010` / `1020` — `domain/trade.go#PlaceOrderTV`,
`domain/order.go#UpdateOrderTV`). They are unusable for real trading.

---

## 4. WebSocket contract

The subscription **is** the connect-URL query string. There is no
subscribe/unsubscribe message protocol (`GATEWAY/internal/realtime/ws.go`).
Browser auth uses two WebSocket subprotocols: `opotrade.v1` and
`opotrade.jwt.<JWT>`. The server negotiates only `opotrade.v1`, so the credential
is not echoed and never appears in the URL. The server pushes
`JSON.stringify(envelope.data)` — the bare data, not the envelope.

Dispatch by `TP` (`internal/realtime/dispatch.go`):
`1`=Tick · `2`=Position · `3`=User · `4`=Order · `5`=Tick(daily).
An unknown `TP` returns the literal string `Invalid TP value`.

| Family       | Query                                                                                | Frame shape                                                   | Consumer                |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------- |
| quote        | `symbol, id=1, methodtype=GetQuotes, TP=1, source=tv`                                | `Quote[]`                                                     | `quoteStore`            |
| intraday bar | `symbol, fromtime=0, totime=1, data=dhloc, methodtype=GetM1History, TP=1, source=tv` | `TVTickResponse[]` — take the LAST                            | datafeed                |
| daily bar    | `symbol, fromtime=0, totime=1, methodtype=GetLastDailyBar, TP=5`                     | `TVTickResponse[]` — take the LAST                            | datafeed                |
| account      | `login, methodtype=GetTradeState, TP=3`                                              | **raw MT5** `{retcode, answer:{Balance,…}}` — no TV transform | `mapAccountState`       |
| orders       | `login, offset, total, methodtype=GetPagebyPageOrder, TP=4, source=tv`               | `TVOrderHistory[]`, status from **`MT5ToTVType`**             | `mapTvOrder(…,'ws')`    |
| positions    | `login, offset, total, methodtype=GetPagebyPagePositionWs, TP=2, source=tv`          | `TVPositionResponse[]` **without** `priceSL`/`priceTP`        | `mapTvPosition(…,'ws')` |

Both order and position WS payloads are **arrays after one `JSON.parse`** —
confirmed in `domain/order.go#GetPagebyPageOrder` and
`domain/position.go#GetPagebyPagePositionWs`, which assign the transformed slice
directly. Stale parity comments elsewhere suggesting a nested JSON string are
wrong for the current build.

`login` on the WS URL is checked against the token's `accounts` claim
(`ws.go#ServeHTTP`), so a token for account A cannot stream account B.

---

## 5. Trade request and result

Request payload — from `TV/broker-sample/src/BrokerApiClient.ts`, which is the
proven production path:

| Field                              | Value                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `action`                           | `"200"` execute · `"201"` pending · `"202"` modify position · `"203"` modify order · `"204"` remove |
| `login`                            | account login                                                                                       |
| `symbol`                           | **suffixed** gateway symbol                                                                         |
| `type`                             | `0` buy · `1` sell · `2` buy-limit · `3` sell-limit · `4` buy-stop · `5` sell-stop                  |
| `volume`                           | **lots × 10000**                                                                                    |
| `typeFill`                         | `0` market · `2` pending                                                                            |
| `priceOrder`, `priceSL`, `priceTP` | prices; `0` means "no level"                                                                        |
| `digits`                           | decimal places of the price                                                                         |
| `position` / `order`               | ticket id for close/modify/cancel                                                                   |
| `source`                           | `"tv"`                                                                                              |

Response — four shapes are accepted (see discrepancy **D1**):

1. `PlaceOrderAnswer` (raw MT5) — carries `ResultRetcode`.
2. `PlacedOrder` (`transform/tvmodels.go`) — carries `outcome`, `resultRetcode`
   and `retcodeDescription`. **`outcome` is the field to branch on.** Its
   `status` integer is derived by an exact-match retcode table that no real MT5
   value matches, so it is `5` — "rejected" — on perfectly good orders.
3. `{order, mTresult, answer}` (.NET-era) — `mTresult: 0` means rejected.
4. `{order: 0, status: 5, outcome: "unknown", message}` — the gateway submitted
   the request but could not read the result back. The order may be live: this
   resolves to an **unknown** outcome and a reconcile, never to a failure.

Retcodes arrive as `"<code> <text>"` — `"10009 Done"`, `"10019 No money"` — and
must be parsed (`parseRetcode`) before any lookup.
Success: `10008` placed · `10009` done · `10010` partial. Undecided: `10012`
timeout.

A response this app cannot parse at all is also treated as **unknown**, not as
an error: every gateway path that produces one has already sent the request to
MT5.

---

## 6. Normalisation summary

| Concern      | Rule                                                                  |
| ------------ | --------------------------------------------------------------------- |
| Volume       | gateway units ÷ 10000 = lots                                          |
| Ticket ids   | **strings end to end** — MT5 tickets exceed `Number.MAX_SAFE_INTEGER` |
| Times        | gateway seconds × 1000 = ms                                           |
| Side         | MT5 type parity (even = buy); TV `side` 1/−1                          |
| Prices/money | decimal **strings**, never binary floats                              |
| SL/TP of `0` | means "no level" → mapped to `null`, never displayed as `0`           |
| Symbols      | gateway = suffixed, UI/TradingView = unsuffixed                       |

---

## 7. Capability gaps

| Feature                             | Status          | Reason                                                                             |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| Market depth / DOM                  | **gated off**   | `/api/Tick/get_marketdepth` exists but its shape is unverified against a live book |
| Price alerts                        | **gated off**   | no persistence or delivery endpoint                                                |
| Economic calendar, news             | **not offered** | no gateway endpoint                                                                |
| Swap / commission on open positions | `Unavailable`   | neither position shape carries them                                                |
| Order expiration                    | `Unavailable`   | absent from the TV order shape                                                     |
| Executions (per-fill)               | empty list      | no per-fill feed; synthesising from deals would misreport fill prices              |
| Idempotency on trades               | **none**        | `send_request` forwards straight to MT5; a retry can open a second position        |
| Workspace / chart storage           | localStorage    | no server endpoint                                                                 |
| Refresh token                       | **none**        | only `/login` and `/crmlogin` exist                                                |
