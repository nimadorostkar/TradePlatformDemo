# LegacyMTSocket — Deep Analysis (Phase 1)

**Purpose:** A faithful, behavior-level reconstruction of the existing .NET 8 gateway (`LegacyMTSocket`) that will be re-implemented in Go. This document is the source of truth for *what the system does today*. The Go port must preserve every externally observable behavior described here (routes, payloads, status codes, WS contract) unless a deviation is explicitly approved in `ARCHITECTURE.md`.

**Inputs analyzed (read-only):**
- `/Users/nima/Projects/tradeplatform-mt-socket` — the live .NET 8 gateway (behavior source of truth)
- `/Users/nima/Projects/tradeplatform-review-main` — review/analysis of the old gateway
- `/Users/nima/Projects/TradePlatform-Issues-NewArchitectural-main` — guidance for the new architecture

> **Convention used in this doc:** “LIVE” = compiled and reachable at runtime. “DEAD” = present in source but excluded from compilation, commented out of DI/pipeline, or never invoked. Preserving LIVE behavior is mandatory; DEAD code is documented for completeness but **must not** be reproduced as functionality.

---

## 1. Executive Summary

LegacyMTSocket is a **stateful reverse-proxy / API gateway** that sits between client apps (web frontends, a TradingView charting UI, a `ClientWS` console app) and the **MetaTrader 5 Manager Web API** at `https://mt5.example.com:443`. It:

1. Authenticates clients with its **own JWT** (issued from an TradePlatform CRM login, or — in the live fallback path — from just a username with no password check).
2. Authenticates **once** to the MT5 Manager Web API using a manager login (`7898`) via an HTTP challenge/response handshake, and keeps that session alive on a **single pinned keep-alive connection** guarded by a background ping loop.
3. Exposes ~60 **REST endpoints** that translate 1:1 to MT5 Web API calls (`/api/order/get`, `/api/tick/last`, …), optionally reshaping MT5 JSON into **TradingView (“TV”) payloads** when `source=tv`.
4. Exposes a single raw **WebSocket** endpoint `/ws` that re-polls MT5 every 3 seconds and pushes the serialized result to the client. The “subscription” is encoded entirely in the connect URL query string; there is no message protocol.
5. Runs a **Hangfire** daily job that pulls per-symbol M1 price history from MT5 into **SQL Server** and aggregates it into daily candles.

**Architectural reality vs. apparent design:** A large fraction of the codebase is DEAD. The native MT5 *binary TCP* protocol stack, a SignalR hub, a second auth service, a keep-alive hosted service, three controllers, and ~180 lines of duplicate WS handler are all present but inert. The **live** request path is narrow and uniform:

```
client → [JWT auth] → Controller → I<Domain>Service → AuthenticateServices
        → MT5HttpClient (singleton, pinned socket + cookie) → MT5 Manager Web API
        → raw JSON → (optional MT5→TV transform) → GlobalResponse envelope → client
```

### 1.1 End-to-end request flow (REST, live path)

1. Client calls `POST /api/Authentication/login` (anonymous) → receives a JWT (HS256, 1h, claim `accounts` = comma-joined MT5 logins, or claim `name` = username in the fallback).
2. Client calls e.g. `GET /api/Order/get_page?login=...&offset=0&total=50&source=tv` with `Authorization: Bearer <jwt>`.
3. JWT bearer middleware validates the signature + lifetime (issuer/audience **not** validated). `[Authorize]` passes; `[AccountsAuthorize]` (on a few endpoints) checks the `login` arg is in the token’s `accounts` claim.
4. The controller calls the domain service, which formats an `APIUrl.*` template into a path and calls `AuthenticateServices.GlobalMT5RequestProcess(url)`.
5. `AuthenticateServices` issues the GET through the singleton `MT5HttpClient` (which prepends `https://mt5.example.com:443`), riding the already-authenticated keep-alive connection + cookie.
6. On HTTP 200 + non-empty body → `GlobalResponse{ success=true, data=<raw JSON or transformed TV object> }`; otherwise `success=false`. Success/failure also feeds the auth manager’s consecutive-failure counter (re-auth after 3 failures).
7. Controller returns `Ok(globalResponse)` (HTTP 200) on `success`, else `BadRequest(globalResponse)` (HTTP 400).

### 1.2 End-to-end flow (WebSocket, live path)

1. Client opens `ws://<host>/ws?symbol=EURUSD&id=0&methodtype=GetQuotes&TP=1&source=mt5` (no auth check at all).
2. Server accepts, then loops while open: each iteration builds a fresh DI scope, dispatches on `TP` (`1`=Tick, `2`=Position, `3`=User, `4`=Order) and `methodtype`, calls the same domain service as REST, serializes `GlobalResponse.data` to JSON, sends it as a text frame, then `await Task.Delay(3000)`.
3. There is no MT5 push; it is fixed 3-second HTTP polling per connection.

---

## 2. Solution Layout

| Project | Role | Notes |
|---|---|---|
| `LegacyMTSocket` | ASP.NET Core 8 web host | `Program.cs` (god file: DI + middleware + `/ws` handler + Hangfire bootstrap + MT5 auth bootstrap), controllers, middleware, attributes, (dead) SignalR hub |
| `LegacyMTSocket.Core` | Contracts + DTOs | Interfaces, MT5 + TV models, `APIUrl` (upstream paths), `AppConstants`, `GlobalResponse`, `JwtTokenHelper`, enums, mapping helpers |
| `LegacyMTSocket.InfraService` | Implementation | Domain services, `AuthenticateServices`, `MT5HttpClient`, `MT5AuthenticationManager`, EF Core `PriceHistoryContext` + migrations, Hangfire `PriceHistoryJob`, **DEAD** native MT5 binary protocol stack (`Services/Common/Protocol/*`) |
| `Opo.WebSocket.Client` | .NET console test client (`ClientWS`) | Demonstrates the `/ws` query-string contract; points at `ws://tradeplatform.azurewebsites.net/ws` by default |

Targets `net8.0`, `Nullable` + `ImplicitUsings` enabled. JSON via **Newtonsoft.Json 13.0.3** (System.Text.Json not used).

---

## 3. Complete REST Endpoint Inventory

**Routing:** controllers use `[Route("api/[controller]")]` (TV controller uses `api/tv/[controller]`). Actions return `Task<IActionResult>`; the universal pattern is `return Ok(resp)` when `resp.success`, else `return BadRequest(resp)` → **200 / 400**. `[Authorize]` = JWT required; `[AccountsAuthorize]` = per-account filter (see §5). `source` defaults to `AppConstants.mt5` (`"mt5"`); pass `source=tv` for TradingView shapes. Several optional query params default to constants: `source=mt5`, `resolution=1D` (`AppConstants.resolution`), `data` default `"dhloc"`.

> **DEAD controllers — NOT live** (excluded via `<Compile Remove>` in `LegacyMTSocket.csproj`): `LoginController` (`POST /api/Login/CRM_login`), `TestMT5Controller` (`/api/v1/TestMT5/*`), `WeatherForecastController` (`GET /WeatherForecast`). Do not port as endpoints.

### 3.1 AuthenticationController — `api/Authentication` — **anonymous**
| Verb | Path | Body | Response | Codes |
|---|---|---|---|---|
| POST | `/api/Authentication/login` | `UserLogin { Username, Password, CRMToken? }` | `{ "token": "<jwt>" }` (anonymous object; ASP.NET Core camel-cases it on the wire) | 200 / 401 |
| POST | `/api/Authentication/crmlogin` | `CRMLogin { email, password, rememberMe? }` | `{ "token": "<crm-or-jwt>" }` | 200 / 401 |

Logic: `login` → if `CRMToken` present calls `GenerateTokenWithCRMAccounts` (CRM `/client-api/accounts`, filters account `typeId ∈ {11,26,57..67}`, builds JWT with `accounts` claim); else falls back to `GenrateOpoSocketToken(Username)` (JWT with `name` claim, **no password validation**). `crmlogin` → CRM `/client-api/login`, returns CRM `accessToken`. Secret from `Jwt:SecretKey`.

### 3.2 OrderController — `api/Order` — **[Authorize]**
| Verb | Path | Params | Body | Extra auth |
|---|---|---|---|---|
| GET | `/api/Order/get` | `ulong ticket` (required) | | |
| GET | `/api/Order/get_total` | `int login` (required) | | |
| GET | `/api/Order/get_page` | `int login, int offset, int total, string source=mt5` | | **[AccountsAuthorize]** |
| GET | `/api/Order/get_batch` | `int login, string group, string ticket, string symbol` | | |
| DELETE | `/api/Order/delete` | `string ticket` (required) | | |
| POST | `/api/Order/update_order` | | `OrderRequest` | |
| GET | `/api/Order/cancel` | `string ticket` (required) | | |
| GET | `/api/Order/list` | `ulong from, ulong to, string server` | | |
| GET | `/api/Order/getbackup` | `DateTime backup, long login, long ticket, ulong from, ulong to, string server` | | |
| POST | `/api/Order/restore` | | `OrderRequest` | |
| GET | `/api/Order/reopen` | `ulong ticket` (required) | | |

### 3.3 PositionController — `api/Position` — **[Authorize]**
| Verb | Path | Params | Body | Extra |
|---|---|---|---|---|
| GET | `/api/Position/get` | `long login, string symbol, string source=mt5` | | |
| GET | `/api/Position/get_total` | `long login` (required) | | |
| GET | `/api/Position/get_page` | `long login, int offset, int total, string source=mt5` | | **[AccountsAuthorize]** |
| GET | `/api/Position/get_batch` | `long login, string group, ulong ticket, string symbol` | | |
| POST | `/api/Position/update_position` | | `PositionRequest` | |
| DELETE | `/api/Position/delete` | `ulong ticket` (required) | | |
| GET | `/api/Position/backup_list` | `long from, long end, string server` | | |
| GET | `/api/Position/backup_get` | `DateTime backup, long login, long from, long end, string server` | | |
| POST | `/api/Position/restore` | | `PositionRequest` | |
| GET | `/api/Position/checkPosition` | `long login` (required) | | |
| GET | `/api/Position/fixPosition` | `long login` (required) | | |

### 3.4 DealController — `api/Deal` — **[Authorize]**
| Verb | Path | Params | Body |
|---|---|---|---|
| GET | `/api/Deal/get` | `ulong ticket` (required) | |
| GET | `/api/Deal/GetDataByWebSocket` | — | (test helper, opens an internal WS to localhost) |
| GET | `/api/Deal/get_total` | `long login, DateTime from, DateTime to` | |
| GET | `/api/Deal/get_page` | `long login, DateTime from, DateTime to, int offset, int index` | |
| GET | `/api/Deal/get_batch` | `long login, string group, ulong ticket, DateTime from, DateTime to, string symbol` | |
| POST | `/api/Deal/update_deal` | | `DealRequest` |
| DELETE | `/api/Deal/delete` | `ulong ticket` (required) | |
| GET | `/api/Deal/backup_list` | `long from, long to, string server` | |
| GET | `/api/Deal/backup_get` | `DateTime backup, long login, long from, long to, string server` | |
| POST | `/api/Deal/restore_deal` | | `DealRequest` |

### 3.5 HistoryController — `api/History` — **[Authorize]** (MT5 “history” = closed orders)
| Verb | Path | Params | Body |
|---|---|---|---|
| GET | `/api/History/get` | `ulong ticket` (required) | |
| GET | `/api/History/get_total` | `long login, DateTime from, DateTime to` | |
| GET | `/api/History/get_page` | `long login, long from, long to, int offset, int total, string source=mt5` | |
| GET | `/api/History/get_batch` | `long login, string groups, string tickets, DateTime from, DateTime to, string symbol` | |
| DELETE | `/api/History/delete` | `ulong ticket` (required) | |
| POST | `/api/History/update_history` | | `OrderRequest` |

> **Bug to preserve verbatim:** `APIUrl.MT5_DeleteClosedOrder = "/api/history/delete?ticket=tickets"` — a literal `tickets`, no `{0}` placeholder. The `ticket` argument is ignored upstream. The Go port must reproduce this exact string to remain behavior-identical (flagged in §13 as a candidate fix pending approval).

### 3.6 SymbolController — `api/Symbol` — **[Authorize]** (results cached, see §9)
| Verb | Path | Params |
|---|---|---|
| GET | `/api/Symbol/getlist` | — |
| GET | `/api/Symbol/getsymbolsbyname` | `string symbol, string source=mt5` |
| GET | `/api/Symbol/getsymbolsbymask` | `string? mask, string source=mt5` |
| GET | `/api/Symbol/getsymbolsbygroup` | `string symbol, string group, string source=mt5` |
| GET | `/api/Symbol/getGroup` | `string group` |

### 3.7 TickController — `api/Tick` — **[Authorize]**
| Verb | Path | Params |
|---|---|---|
| GET | `/api/Tick/last` | `string symbol, long Id=0, string source=mt5` |
| GET | `/api/Tick/last_group` | `string symbol, string group, long Id` |
| GET | `/api/Tick/stat` | `string symbol, long Id` |
| GET | `/api/Tick/history` | `string symbol, long from, long to, string data` |
| GET | `/api/Tick/get` | `string symbol, long from, long to, string data, string source=mt5` |
| GET | `/api/Tick/getHistoryby1Dresolution` | `string symbol, long from, long to, string resolution=1D` |
| GET | `/api/Tick/get_marketdepth` | `string symbol` |

### 3.8 TradeController — `api/Trade` — **[Authorize]**
| Verb | Path | Params | Body | Extra |
|---|---|---|---|---|
| GET | `/api/Trade/balance` | `long login, int type, double balance, string comment` | | |
| GET | `/api/Trade/calc_buy_rate` | `string basecurrency, string currency, string? group, string? symbol, double? price` | | |
| GET | `/api/Trade/calc_sell_rate` | (same as buy) | | |
| GET | `/api/Trade/check_margin` | `long login, string symbol, int type, long volume, double price` | | |
| GET | `/api/Trade/calc_profit` | `string group, string symbol, int type, long volume, double price_open, double price_close` | | |
| POST | `/api/Trade/send_request` | | `TradeRequest` | **[AccountsAuthorize]** |
| GET | `/api/Trade/get_request_result` | `long id` | | |

### 3.9 UserController — `api/User` — **[Authorize]**
| Verb | Path | Params | Extra |
|---|---|---|---|
| GET | `/api/User/get` | `long login (required), string source=mt5` | **[AccountsAuthorize]** |
| GET | `/api/User/get_trade_state` | `long login (required), string source=mt5` | **[AccountsAuthorize]** |

### 3.10 TestController — `api/Test` — **[Authorize]**
`GET /api/Test/getServerTime`, `getUTCTime`, `testMethod`, `testMethod1` → `{ "UnixTimestamp": <unix-seconds-string> }`. **200 / 500** (these throw → 500 rather than 400).

### 3.11 TVOrderController — `api/tv/TVOrder` — **anonymous** (no `[Authorize]`)
| Verb | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/tv/TVOrder/gethistory` | | returns bare `Ok()` (empty 200 — **stub**) |
| GET | `/api/tv/TVOrder/cancelOrder/{orderId}` | | `_orderService.Cancel(orderId)` → `Ok()` |
| POST | `/api/tv/TVOrder/modifyOrder` | `ModifyOrderRequest` | `Ok(UpdateOrder(model))` |
| GET | `/api/tv/TVOrder/orders` | | `Ok(GetPage())` (parameterless, partly hardcoded) |
| POST | `/api/tv/TVOrder/placeOrder` | `ModifyOrderRequest` | `_tradeService.Send_request(model)` → 200/400 |

> This controller is partially scaffolded (hardcoded logins, stub `gethistory`) **and unauthenticated**. Behavior must be preserved, but it is a flagged security concern (§13).

### 3.12 Non-controller endpoints (Program.cs)
- `GET /` → 302 redirect to `/swagger`.
- `GET /swagger` (+ `/swagger/v1/swagger.json`) — Swagger UI (enabled in Dev **and** Production; `RoutePrefix="swagger"`).
- `GET /hangfire` — Hangfire dashboard (**no auth filter**).
- `Map("/ws", …)` — raw WebSocket (see §6).

---

## 4. Middleware Pipeline (exact order)

From `Program.cs`, in registration order:

1. `UseMiddleware<ValidateAccountMiddleware>()` — custom account guard (**runs before auth → effectively inert**, see §5).
2. `UseWebSockets()`
3. `UseRouting()`
4. `UseSerilogRequestLogging()`
5. Swagger branch — Dev: `UseSwagger()+UseSwaggerUI()`; Prod: `UseSwagger()+UseSwaggerUI(RoutePrefix="swagger")+UseHsts()`.
6. `UseHangfireDashboard()` (+ startup job registration calls)
7. `UseAuthentication()`
8. `UseAuthorization()`
9. `UseHttpsRedirection()`
10. `MapControllers()`
11. `MapGet("/", → /swagger)`
12. `UseCors("corsapp")`
13. `Map("/ws", …)`

Then, before `app.Run()`, a startup scope resolves `MT5AuthenticationManager` and `await AuthenticateAndMaintainConnection()`.

**Ordering issues (preserve behavior, fix in Go per ARCHITECTURE):**
- `ValidateAccountMiddleware` is **before** `UseAuthentication` → `context.User` is unpopulated → its `accounts`-claim check is bypassed (no-op).
- `UseCors` is **after** `MapControllers` — out of recommended order.
- `AuthenticationMiddleware` (`UseAuthenticationMiddleware`) is **commented out** — DEAD.

**NOT present:** no rate-limiting middleware, no global exception handler / `ProblemDetails`, no health/readiness endpoints, no output caching middleware.

---

## 5. Authentication & Authorization

### 5.1 Client JWT (the gateway’s own auth)
- Scheme: **JWT Bearer**, `Authorization: Bearer <token>`.
- Signing: **HS256** (`HmacSha256Signature`), key = `Encoding.ASCII.GetBytes(Jwt:SecretKey)`. Startup throws if the key is missing.
- Validation params: `ValidateIssuerSigningKey=true`, `ValidateLifetime=true`, **`ValidateIssuer=false`**, **`ValidateAudience=false`**, `RequireHttpsMetadata=false`, `SaveToken=true`.
- Token contents (from `JwtTokenHelper`):
  - `GenerateToken(username, secret)` → claim `ClaimTypes.Name` = username, expiry **+1h**. (Used by the no-password fallback login.)
  - `GenerateJwtToken(accounts, secret)` → claim **`accounts`** = `string.Join(",", accounts)`, expiry **+1h**. (Used after CRM account resolution.)
  - No issuer/audience set on either.

### 5.2 `AccountsAuthorizeAttribute` (LIVE per-endpoint filter)
`IAsyncAuthorizationFilter` applied to: `Order/get_page`, `Position/get_page`, `Trade/send_request`, `User/get`, `User/get_trade_state`. Logic:
- Read claim `accounts` from `HttpContext.User`; missing/empty → **401**.
- Read `login` from query string; if absent, `EnableBuffering()` + read+rewind body, `JsonDocument.Parse` to pull `"login"` (parse errors swallowed).
- Split `accounts` by `,`; if `login` not in the list → **403**.

This is the **functioning** per-account authorization (runs in the MVC authorization stage, after JWT auth).

### 5.3 `ValidateAccountMiddleware` (DEAD-in-effect)
Reads `login` from form/query and `accounts` from `context.User`; if both present and `login ∉ accounts` → writes **403** `"Forbidden: Unauthorized account access."`. But because it runs before `UseAuthentication`, `context.User` is empty → the guard never triggers. Document, do not rely on.

### 5.4 MT5 backend auth (separate from client JWT) — see §7.

---

## 6. WebSocket & SignalR Surface

### 6.1 Live: raw WebSocket `/ws`
- **No authentication** before `AcceptWebSocketAsync()`. Anonymous clients can stream any `login`’s data. (Flagged §13.)
- Non-WebSocket request to `/ws` → **400**.
- **Contract = query string only** (no subscribe/unsubscribe messages). Recognized params: `symbol, id, methodtype, group, login, offset, total, ticket, TP, source, fromtime, totime, data`.
- Dispatch on `TP`:
  | TP | Service | Method dispatcher |
  |---|---|---|
  | `1` | `ITickService.GetTickServiceData` | `GetMarketDepth`, `GetStatistics`, `GetQuotes`, `GetQuotesByGroup`, `GetM1History`, `GetHistoryBy1DResolution` |
  | `2` | `IPositionService.GetPositionServiceData` | `GetPosition`, `GetTotalPosition`, `GetPagebyPagePositionWs`, `GetPositionBatch` |
  | `3` | `IUserService.GetUserServiceData` | `Getbylogin`, `GetTradeState` |
  | `4` | `IOrderServices.GetOrderServiceData` | `GetPagebyPageOrder` (only one wired) |
  | else | — | sends `"Invalid TP value"` |
- **Loop:** each iteration creates a new DI scope, calls the service, `JsonConvert.SerializeObject(response.data)`, `SendAsync` as text, then **`await Task.Delay(3000)`** (3s push). Checks the receive task non-blockingly for a Close frame.
- **Live-window trick:** for chart streaming, `GetM1History` treats `from==0 && to==1` as “live” and anchors `to = broker server time (seconds)`, `from = to-120`. Broker time is derived from the latest tick’s `Datetime`, cached ~30s.
- **Message shape:** the raw serialized `GlobalResponse.data` — its schema depends on `methodtype` + `source` (the TV shapes in §11). There is **no** flat `{symbol,bid,ask,time}` contract in the live service (that JSON appears only in the *target* Go architecture doc).

### 6.2 DEAD: SignalR hub
`Hub/TestTick : Hub<ITestTick>` with `GetData(string symbol, int id)` exists, but there is **no `AddSignalR()`** and **no `MapHub<>()`** — unreachable. SignalR package referenced but unused. Do not port.

### 6.3 Reference client (`Opo.WebSocket.Client/ClientWS`)
Connects with `ClientWebSocket` to `ws://tradeplatform.azurewebsites.net/ws?...` (or `ws://localhost:5063/ws?...`), sets a `Sec-WebSocket-Protocol` header, then only receives and prints. Implements TP 1/2/3 (not TP=4).

---

## 7. Reverse-Proxy / MT5 Upstream Integration (LIVE path)

The gateway talks to MT5 over the **HTTP-based MT5 Manager Web API**, *not* the native binary protocol (which is DEAD — see §8).

### 7.1 Upstream base + URL construction
- Base = `$"{MT5Config.HostUrl}:{MT5Config.Port}"` = `https://mt5.example.com:443`.
- All upstream paths are `string.Format` templates centralized in `Core/Helpers/APIUrl.cs` (the canonical list, §7.5).
- **Suspicious inconsistency:** the named `HttpClient "MT5HttpClient"` is registered with `BaseAddress = https://tradeplatform.azurewebsites.net`, but `MT5HttpClient` **always prepends its own `HostUrl`** to every path, so the named `BaseAddress` is effectively dead. (Flagged §13 ambiguity #1.)

### 7.2 MT5 session auth (HTTP challenge/response)
`MT5AuthenticationManager` (**singleton**, bootstrapped at startup):
1. `GET /api/auth/start?version={ver}&agent={agent}&login={login}&type={type}` → `AuthStart{ retcode, srv_rand }`.
2. Compute `srv_rand_answer = ProcessAuth(srv_rand, password)`:
   `MD5(UTF16LE(password))` → `MD5(that ++ ASCII("WebAPI"))` → `MD5(passwordHash ++ FromHex(srv_rand))`, lowercased hex. Generate 16-byte `cli_rand`.
3. `GET /api/auth/answer?srv_rand_answer={...}&cli_rand={...}` → HTTP 200 means authenticated; **the server sets a cookie** captured by the handler’s `CookieContainer`.
4. No bearer token stored by app code — reuse is at the **connection + cookie** layer.

**Keep-alive & resilience:**
- Background ping task every `PING_INTERVAL_SECONDS = 20` → `GET /api/test/access`. On failure → `_isAuthenticated=false` and re-auth (retry loop every 3s until success). Guarded by `SemaphoreSlim _authLock(1,1)`.
- Failure-driven re-auth: `NotifyRequestFailed/Succeeded` track `_consecutiveFailures` via `Interlocked`; after `MAX_CONSECUTIVE_FAILURES = 3`, one thread atomically forces re-auth.

### 7.3 The HTTP client (the connection-pinning core)
Named client `"MT5HttpClient"` primary handler:
```
HttpClientHandler { MaxConnectionsPerServer = 1, UseCookies = true, CookieContainer = new() }
SetHandlerLifetime(Timeout.InfiniteTimeSpan)
```
Rationale (load-bearing): MT5 auth is bound to a single keep-alive socket; `MaxConnectionsPerServer=1` forces `auth/start`, `auth/answer`, and **all** data requests onto the same authenticated connection, and the infinite handler lifetime stops the factory from recycling (and silently dropping) the session. `MT5HttpClient` (singleton, `IDisposable`) sets `Connection: Keep-Alive`, `Keep-Alive: timeout=600`, `ConnectionClose=false`. `ExecuteWithRetry` retries up to 3× on `HttpRequestException`, recreating the client between attempts. No explicit per-request timeout (default 100s).

### 7.4 The dispatcher: `AuthenticateServices` (Scoped)
Every domain service depends on this, not on `MT5HttpClient` directly:
- `GlobalMT5RequestProcess(url, body="")` — **GET**. Strips the `HostUrl:Port` prefix back off (services build full URLs; this un-builds), calls `MT5HttpClient.GetAsync`. On 2xx + non-empty body → `success=true, data=<raw JSON string>` + `NotifyRequestSucceeded()`; else `success=false, message=AppConstants.ErrorMessage` + `NotifyRequestFailed()`.
- `GlobalMT5RequestProcess_Post(url, body)` — **POST** JSON (`application/json`, UTF-8). Does **not** strip the prefix (asymmetric with GET; works because POST callers pass bare templates).
- `GlobalCRMRequestProcess_Post(url, body, token)` — POST to the **CRM** (`MT5Config.CRMUrl`) with `Authorization: Bearer {token}` on a *separate* client so CRM headers never mutate the shared MT5 client.

### 7.5 Canonical upstream MT5 Web API paths (`APIUrl.cs`)

```
Auth/Test:
  /api/auth/start?version={0}&agent={1}&login={2}&type={3}
  /api/auth/answer?srv_rand_answer={0}&cli_rand={1}
  /api/test/access

Order:
  /api/order/get?ticket={0}
  /api/order/get_total?login={0}
  /api/order/get_page?login={0}&offset={1}&total={2}
  /api/order/get_batch?login={0}&group={1}&ticket={2}&symbol={3}
  /api/order/delete?ticket={0}
  /api/order/cancel?ticket={0}
  /api/order/update                         (POST)
  /api/order/backup/list?from={0}&to={1}&server={2}
  /api/order/backup/get?backup={0}&login={1}&ticket={2}&from={3}&to={4}&server={5}
  /api/order/backup/restore                 (POST)
  /api/order/reopen?ticket={0}

History (closed orders):
  /api/history/get?ticket={0}
  /api/history/get_total?login={0}&from={1}&to={2}
  /api/history/get_page?login={0}&from={1}&to={2}&offset={3}&total={4}
  /api/history/get_batch?login={0}&group={1}&ticket={2}&from={3}&to={4}&symbol={5}
  /api/history/update                       (POST)
  /api/history/delete?ticket=tickets        (BUG: literal 'tickets')

Deal:
  /api/deal/get?ticket={0}
  /api/deal/get_total?login={0}&from={1}&to={2}
  /api/deal/get_page?login={0}&from={1}&to={2}&offset={3}&total={4}
  /api/deal/get_batch?login={0}&group={1}&ticket={2}&from={3}&to={4}&symbol={5}
  /api/deal/update                          (POST)
  /api/deal/delete?ticket={0}
  /api/deal/backup/list?from={0}&to={1}&server={2}
  /api/deal/backup/get?backup={0}&login={1}&from={2}&to={3}&server={4}
  /api/deal/backup/restore                  (POST)

Position:
  /api/position/get?login={0}&symbol={1}
  /api/position/get_total?login={0}
  /api/position/get_page?login={0}&offset={1}&total={2}
  /api/position/get_batch?login={0}&group={1}&ticket={2}&symbol={3}
  /api/position/update                      (POST)
  /api/position/delete?ticket={0}
  /api/position/backup/list?from={0}&to={1}&server={2}
  /api/position/backup/get?backup={0}&login={1}&from={2}&to={3}&server={4}
  /api/position/backup/restore              (POST)
  /api/position/check?login={0}
  /api/position/fix?login={0}

Trade/Dealer:
  /api/trade/balance?login={0}&type={1}&balance={2}&comment={3}
  /api/trade/calc_rate_buy?base={0}&currency={1}&group={2}&symbol={3}&price={4}
  /api/trade/calc_rate_sell?base={0}&currency={1}&group={2}&symbol={3}&price={4}
  /api/trade/check_margin?login={0}&symbol={1}&type={2}&volume={3}&price={4}
  /api/trade/calc_profit?group={0}&symbol={1}&type={2}&volume={3}&price_open={4}&price_close={5}
  /api/dealer/send_request                  (POST)
  /api/dealer/get_request_result?id={0}

Tick/Chart/Book:
  /api/tick/last?symbol={0}&trans_id={1}
  /api/tick/last_group?symbol={0}&group={1}&trans_id={2}
  /api/tick/stat?symbol={0}&trans_id={1}
  /api/tick/history?symbol={0}&from={1}&to={2}&data={3}
  /api/chart/get?symbol={0}&from={1}&to={2}&data={3}
  /api/book/get?symbol={0}

User:
  /api/user/get?login={0}
  /api/user/account/get?login={0}

Symbol/Group:
  /api/symbol/list
  /api/symbol/get?symbol={0}
  /api/symbol/get?mask={0}
  /api/symbol/get_group?symbol={0}&group={1}
  /api/group/get?group={0}

CRM (external auth provider, absolute URL on MT5Config.CRMUrl):
  /client-api/login?version=1.0.0          (POST)
  /client-api/accounts?version=1.0.0       (POST, Bearer)
```

### 7.6 MT5→TV transforms (the gateway’s real value-add)
When `source=tv`, services reshape MT5 JSON into TV models. Key mappings (must be reproduced exactly):
- **Order/History → `TVOrderHistory`:** `side = Type % 2 == 0 ? 1 : -1`; `type = MappingHelper.mT5ToTVTypeMapping(Type)` ({0,1→2 Market; 2,3→1 Limit; 4,5→3 Stop; 6,7→4 StopLimit}); `status = mT5TVStatusMapping(State)` (STARTED→Placing, PLACED→Working, CANCELED→Canceled, PARTIAL→Working, FILLED→Filled, REJECTED→Rejected, EXPIRED→Canceled); `qty=VolumeInitial; limitPrice=stopPrice=PriceOrder; stopLoss=PriceSL; takeProfit=PriceTP; filledQty=VolumeCurrent; id=Order; timeSetup=updateTime=TimeSetup`.
- **Position → `TVPositionResponse`:** `Id=Position; profit=Profit; qty=Volume; side=Action%2==0?1:-1; last=PriceCurrent; price=PriceOpen; type=0` (+ `timeCreate, priceSL, priceTP` in page variant).
- **Tick → `Quote`:** `symbolname=Symbol; status="Ok"; bid=Bid; ask=Ask; lastprice=Last>0?Last:Bid; volume=Volume`.
- **Symbol → `TVSymbolResponse`:** `type = TypeConverter.pathtotypeConveter(Path)` (split `Path` on `\`, take index 1); `session = TradingSessionConverter.ConvertMt5ToTv(SessionsTrades)` (per-day `"HHMM-HHMM,…:DAY"` joined by `|`, days 0–6→"1".."7"); `pricescale=(int)Multiply; volume_precision=VolumeMin; currency_code=CurrencyBase`; plus many constant defaults (timezone `Etc/UTC`, exchange `TradePlatform`, `supported_resolutions=["1","5","15","30","60","240","1D","1W","1M"]`, etc.).
- **User → `TVUserResponse`** (`id, name, currency=null, currencysign=null`) and **`TVAccountSummary`** (`title=Login, balance, equity, pl=Profit`).
- **Trade place → `PlacedOrder`:** `Send_request` POSTs `/api/dealer/send_request` → `answer.Id`, waits 200ms, then polls `/api/dealer/get_request_result?id=` (≤3 retries, 100ms). `updateTime = (UTCUnix + 3h) * 1000`. Status via retcode map (`GetStatusType`, MT5 10001–10010 → TV status int).

### 7.7 Error handling
- Live HTTP path does not surface `MTRetCode` to clients. Upstream non-2xx or empty body → `GlobalResponse{ success=false, message=AppConstants.ErrorMessage(...), data=<error body> }`. Exceptions → `success=false, errorMessage=Format(AppConstants.ErrorMessage, ex.Message)`. The MT5 application-level `retcode` inside the JSON `answer` is passed through opaquely in `data` for raw calls; only Order/Position/Trade transforms interpret it.
- `MTRetCode`/`MTFormat` (full MetaTrader return-code vocabulary) belong to the DEAD binary path; only one constant leaks into the live path: `TradeService.GetRequestResult` retries on “13 not found” (`MT_RET_ERR_NOTFOUND`).

---

## 8. DEAD: Native MT5 Manager Binary Protocol Stack

`LegacyMTSocket.InfraService/Services/Common/Protocol/*` + `Utils/*` + `MT5WebAPI.cs` are a **complete port of MetaQuotes’ reference MT5 Manager API** (native TCP, binary-framed, AES-OFB encrypted), but they are **never invoked at runtime**:
- `MT5WebAPI` is DI-registered and injected into Login/Order/Position/Trade services, but `grep` shows **zero** `_mt5WebAPI.` method calls — the field is assigned and never used.
- The live services use `AuthenticateServices` (HTTP) exclusively.

Summary (for completeness only — **not to be ported as functionality**): 9-byte ASCII frame header `%04x%04x%01x` (size, serial, flag), first packet prefixed `MT5WEBAPI`; UTF-16LE body `COMMAND|KEY=value|...|\r\n<json>`; challenge/response auth (MD5 chain), AES-256 OFB keystream (hand-rolled AES, key `IV[0]||IV[1]`, send seed `IV[2]`, recv seed `IV[3]`); async send/recv/ping threads, 20s ping, serials wrap at 0x3FFF; mostly `static` (process-global) state. Also DEAD: `NewAuthenticateService`, `MT5HttpClientNoHeader`, `UtilityService`, `WebSocketService` (outbound client), `WSClient.cs` (fully commented), `AuthenticationMiddleware`, `AuthenticationBackgroundService`.

> **Risk note:** If at any point the live HTTP MT5 Web API is unavailable and the native TCP Manager API is the only option, this binary protocol would need a real Go reimplementation (hardest part — exact MD5/AES/encoding parity required). The current system does **not** use it, so the Go port will **not** implement it unless requirements change. Captured here so the knowledge isn’t lost.

---

## 9. Caching, Logging, Config

**Caching:** `IMemoryCache` (`AddMemoryCache()`), used only by `SymbolService`: `"GetSymbolList"` (24h sliding), `"GlobalSymbolDetail"` (24h sliding, accumulates TV symbol details deduped by ticker), per-`group` keys (60-min sliding). `TickService` keeps **static** broker-clock offset fields (30s TTL) shared across instances. No distributed cache (no Redis).

**Logging:** **Serilog** (`UseSerilog`, `ReadFrom.Configuration`). Console + rolling daily file `Logs/logs-.txt` (CompactJson). `UseSerilogRequestLogging()`. Min level Information; Microsoft/System → Warning. (Some WS errors are `Console.WriteLine`, bypassing Serilog.)

**Config (`appsettings.json`, plaintext secrets committed):**
- `Jwt:SecretKey` (HS256 key), `Jwt:Issuer`/`Audience` (present but **not validated**).
- `ConnectionStrings:TradePlatformConStr` — active `Server=localhost;Database=TradePlatform;Trusted_Connection=True;TrustServerCertificate=True;MultipleActiveResultSets=true` (prior Azure SQL strings commented out).
- `MT5Config`: `HostUrl=https://mt5.example.com`, `Port=443`, `login=7898`, `password=Opo1234@`, `version=4410`, `agent=WebManager`, `type=Manager`, `SymbolDefaultcount=10`, `DefaultSymbolList=EURUSD,USDJPY,XAUUSD,GBPUSD,AUDUSD,USDCAD,USDCHF,DJIUSD,SPXUSD,NDXUSD,DAXEUR,FTSGBP,NZDUSD,EURJPY,EURGBP,EURCHF,GBPJPY,GBPCHF,AUDJPY,AUDCAD`, `ReadDataFromDbOrAPI="false"`, `CRMUrl=https://crm.example.com`.
- `Serilog`, `Logging:LogLevel`, `AllowedHosts=*`.
- Env overrides via double-underscore (`Jwt__SecretKey`, `ConnectionStrings__TradePlatformConStr`, `MT5Config__password`, …).
- **CORS:** single policy `"corsapp"` = `WithOrigins("*").AllowAnyMethod().AllowAnyHeader()`.
- **Production runtime:** `ASPNETCORE_URLS=http://0.0.0.0:5063`, `ASPNETCORE_ENVIRONMENT=Production`; Windows Scheduled Task `LegacyMTSocketProd` on VPS `203.0.113.10`; Swagger at root/`/swagger`, Hangfire at `/hangfire`. (Docker docs assume internal port `8080`, but **no Dockerfile exists** in the repo.)
- `ServicePointManager.SecurityProtocol = Tls12 | Tls11 | Tls` (downgrades enabled — flagged §13).

**Rate limiting:** none.

---

## 10. Database & Background Jobs

**Engine:** SQL Server (`Microsoft.EntityFrameworkCore.SqlServer` 8.0.8). DB `TradePlatform`, also holds Hangfire tables. `AddDbContext<PriceHistoryContext>` with `CommandTimeout(300)`.

**Schema** (one migration `20240927133640_InitialMigration`; PK-only, **no secondary indexes**):

| Table | Columns |
|---|---|
| `Symbolwisepricehistorydata` (`PriceHistory`) | `Id` int PK identity; `Symbol` nvarchar(max) req; `Time` bigint (unix s); `Open/High/Low/Close/Volume` float |
| `Symboldailydata` (`DailyData`) | `ID` int PK identity; `Timestamp` bigint (00:00 unix); `Symbol` nvarchar(max) req; `Open/High/Low/Close` float (no Volume) |
| `Logs` (`LogHistory`) | `Id` int PK identity; `APIUrl`, `Request` nvarchar(max) req; `StartTime/EndTime` datetime2; `IsSuccess` bit |

**Stored procedures** (`db/create_stored_procedures.sql`, SQL-Server-only `MERGE`/`STRING_SPLIT`):
1. `InsertSymbolHistoryData(@Symbol,@Time,@Open,@High,@Low,@Close,@Volume)` — upsert one candle, `MERGE` on `(Symbol, Time)`.
2. `AggregateDailyDataNew(@StartOfDayUnix,@EndOfDayUnix,@Symbols csv)` — per symbol aggregate intraday→daily OHLC (`Open`=first by Time, `Close`=last, `High`=MAX, `Low`=MIN), `MERGE` into `Symboldailydata` on `(Symbol, Timestamp)`. `NOCOUNT` OFF (returns row count; app treats negative as failure).
3. `GetLatestSymbolwisePriceHistoryData(@Symbol,@FromTime,@ToTime)` — `MAX(Time)` in window. **Not called** (dead helper).

**Background jobs (Hangfire, SQL Server storage):**
- Recurring `"fetch-price-history"` → `IPriceHistoryJob.FetchAndSavePriceHistory()` on `Cron.Daily()`.
- One-shot at startup: `BackgroundJob.Enqueue(FetchAndSavePriceHistory)` + `ContinueJobWith(FetchAndAggregateDailyData)`.
- `FetchAndSavePriceHistory`: from=yesterday, to=now; gets symbol list from MT5 (`/api/symbol/list`, fallback `DefaultSymbolList`); per symbol `TickService.SyncSymbolHistoryData` → reads latest stored `Time`, fetches `/api/chart/get`, `DeleteOldRecords()` (prunes `Time < now-7d`), upserts via `EXEC InsertSymbolHistoryData` (row-by-row).
- `FetchAndAggregateDailyData` → `AggregateDailyData(now)`: distinct symbols, batches of 100, `EXEC AggregateDailyDataNew`.
- Dashboard `/hangfire` has **no** authorization filter.
- `DBOperations.InsertPriceHistory` (EF bulk) and `InsertLogHistory` exist but are commented out of the live path.

---

## 11. Wire Payloads (DTOs) — parity-critical

**Global rule:** no `[JsonProperty]`/`[JsonPropertyName]` anywhere — **C# property names ARE the JSON field names, with their exact (inconsistent) casing**. The Go port must reproduce casing verbatim (`retcode`, `priceOrder` vs `PriceOrder`, `timeCreate`, lowercase TV fields). Serialization is Newtonsoft with default settings.

**Response envelope (`GlobalResponse`):**
```json
{ "data": <any>, "errorMessage": null, "message": "string|null", "success": true }
```
`success` defaults to `true`; failures set `success=false` + `errorMessage`. Paged variant `GlobalSearchResponse` adds `"totalCount": <int|null>`. (A parallel generic `ApiResponse<T>` with the same 4 fields exists in `MT5Common`.)

**Request DTOs (selected):**
- `UserLogin { Username, Password, CRMToken? }`; `CRMLogin { email, password, rememberMe? }`; `CRMRoot { login, typeId }`.
- `OrderRequest { int Order; string ExternalID; int Login; string symbol; double priceOrder, priceSL, priceTP; int volumeInitial }`.
- `PositionRequest { int Position; string ExternalID; int Login; string symbol; double priceSL, priceTP; int volumeInitial }`.
- `DealRequest { string Deal, ExternalID, Login }`.
- `TradeRequest { string Action; long Login; string Symbol; double Volume; int TypeFill; int Type; double? PriceOrder; int? Digits; double? PriceTrigger; int? Typetime=0; string? Order; int? Position; double? PriceSL, PriceTP; string source }`.
- `ModifyOrderRequest { PlacedOrder order; string? confirmId }` (TV).

**Upstream MT5 answer envelopes** are `{ "retcode": "0 Done", "answer": <obj|array> }` (e.g. `OrderHistory`, `PositionResponse`, `MT5UserResponse`, `TicklastRoot`, `MarketDepth`, `TickMT5getResponse` with `answer: List<List<double>>` chart bars, `MT5SymbolResponse` with `answer: List<string>`). Full field lists are large (~145-field symbol record, ~65-field user record); they are passed through opaquely in `data` for `source=mt5` and reshaped only for `source=tv`. See agent reports / source models for exhaustive field lists; the **TV output shapes** are the ones with fixed contracts:

- `TVOrderResponse`, `TVOrderHistory`, `TVPositionResponse`, `UpdatePositionResponse`, `TVSymbolResponse` (with constant defaults), `TVTickResponse { time, open, high, low, close, volume? }`, `Quote { symbolname, status, bid, ask, lastprice, volume }`, `TVUserResponse`, `TVAccountSummary`, `TVResponseModifyOrder`, `PlacedOrder`.

**Enums (integer values — must match):**
- `MT5OrderType`: BUY=0, SELL=1, BUY_LIMIT=2, SELL_LIMIT=3, BUY_STOP=4, SELL_STOP=5, BUY_STOP_LIMIT=6, SELL_STOP_LIMIT=7, CLOSE_BY=8.
- `OrderStateMT5`/`MT5OrderStatus`: STARTED=0, PLACED=1, CANCELED=2, PARTIAL=3, FILLED=4, REJECTED=5, EXPIRED=6 (status adds REQUEST_ADD=7, MODIFY=8, CANCEL=9).
- `TVSide`: Sell=-1, Buy=1. `TVOrderType`: Limit=1, Market=2, Stop=3, StopLimit=4. `TVOrderStatus`/`OrderStateTradingView`: Canceled=1, Filled=2, Inactive=3, Placing=4, Rejected=5, Working=6. `TVStopType`: StopLoss=0, TrailingStop=1. `OrderOrPositionMessageType`: error=0, information=1, warning=2.
- Filling FOK=0/IOC=1/RETURN=2/BOC=3; TypeTime GTC=0/DAY=1/SPECIFIED=2/SPECIFIED_DAY=3; activation/modify flags are hex bitfields.

---

## 12. External Dependencies & Wiring

| Dependency | How wired | Live? |
|---|---|---|
| MT5 Manager Web API (`mt5.example.com:443`) | `MT5HttpClient` singleton (pinned socket+cookie) + `MT5AuthenticationManager` | **LIVE** |
| TradePlatform CRM (`crm.example.com`) | `LoginService` via `AuthenticateServices.GlobalCRMRequestProcess_Post` (Bearer) | **LIVE** |
| SQL Server `TradePlatform` | EF Core `PriceHistoryContext` + 3 stored procs; Hangfire storage | **LIVE** |
| Hangfire | `AddHangfire(UseSqlServerStorage)` + `AddHangfireServer` + dashboard | **LIVE** |
| Serilog | `UseSerilog` console+file | **LIVE** |
| Swagger/Swashbuckle | `AddSwaggerGen` (registered twice) + `UseSwaggerUI` | **LIVE** |
| MemoryCache | `AddMemoryCache` (SymbolService) | **LIVE** |
| SignalR | package only; no `AddSignalR`/`MapHub` | DEAD |
| Native MT5 TCP (`MT5WebAPI`) | DI-registered, never called | DEAD |

**NuGet (host):** Hangfire 1.8.14, Hangfire.MemoryStorage 1.8.1.1 (unused), JwtBearer 8.0.8, AspNetCore.Http 2.2.2, HttpsPolicy 2.2.0, SignalR 1.1.0 (unused), EF Core 8.0.8 (+SqlServer/Tools), Caching.Memory 8.0.0, Newtonsoft.Json 13.0.3, Serilog.AspNetCore 8.0.2, Swashbuckle 6.7.3, System.IdentityModel.Tokens.Jwt 8.0.2.
**NuGet (infra):** EFCore.BulkExtensions 8.1.1, EF Core 8.0.8 (+Relational/SqlServer), Configuration.Binder 8.0.2, Newtonsoft.Json 13.0.3, Serilog.AspNetCore 8.0.2.

**DI lifetimes:** Singletons = `MT5HttpClient`, `MT5HttpClientNoHeader`, `MT5AuthenticationManager`. Scoped = all `I<Domain>Service`, `AuthenticateServices`, `MT5WebAPI`, `WebSocketService`, `PriceHistoryContext`, `IPriceHistoryJob`, `IDBOperations`. **Captive-dependency smell:** singleton `MT5AuthenticationManager` resolves scoped `AuthenticateServices`.

---

## 13. Ambiguities, Quirks & Assumptions (each with a decision)

Each item states the existing behavior, the ambiguity, and the **assumption the Go port will make** (default: preserve observable behavior; never silently change it).

1. **MT5 host: `mt5.example.com` vs hardcoded `tradeplatform.azurewebsites.net`.** The named HttpClient `BaseAddress` is `tradeplatform.azurewebsites.net`, but `MT5HttpClient` prepends `MT5Config.HostUrl` (`mt5.example.com:443`) to every path, so the BaseAddress is unused. **Assumption:** real upstream is `https://mt5.example.com:443` from `MT5Config`; the Go port uses config only and drops the dead Azure base. (Confirm with user.)

2. **Login does no password check (live fallback).** `GenrateOpoSocketToken(Username)` issues a JWT from username alone. **Assumption:** preserve exactly (any username → token) to avoid breaking clients, but flag as a security defect to fix post-parity. CRM path (`CRMToken` present) does validate via CRM.

3. **`/ws` is unauthenticated.** No JWT before accept. **Assumption:** preserve (clients depend on it) but expose a config flag to optionally require JWT; default off for parity.

4. **`TVOrderController` is anonymous + partially stubbed/hardcoded** (`gethistory` returns empty, `orders`/`placeOrder` use hardcoded logins). **Assumption:** reproduce the exact responses (including empty `gethistory`), keep anonymous, flag for follow-up.

5. **`/api/history/delete?ticket=tickets` bug.** Literal `tickets`, ignores arg. **Assumption:** reproduce verbatim for byte-parity; offer a corrected variant behind a flag only if the user approves changing behavior.

6. **Response envelope field casing & `Token` casing.** The C# source writes `Ok(new { Token = ... })`, but ASP.NET Core serializes anonymous objects camelCase, so the wire format is `{ "token": ... }` — CONFIRMED against the CRM/frontend, which reads the lowercase key. The Go port emits `token`.

7. **`source` param semantics.** Default `mt5` = raw passthrough; `tv` = transformed. A handful of endpoints ignore `source`. **Assumption:** replicate per-method exactly as in the services.

8. **WS `TP=4` (Order)** documented but only `GetPagebyPageOrder` wired; reference client never sends TP=4. **Assumption:** wire TP=4 → `GetOrderServiceData` exactly as code does.

9. **Status codes.** REST = 200/400 (BadRequest on `success=false`); `Authentication/*` = 200/401; `Test/*` = 200/500. **Assumption:** match these precisely; do not “improve” to 404/422.

10. **Time semantics.** `updateTime` in `PlacedOrder` = `(UTCUnix + 3h) * 1000` (ms, +3h offset). Broker time derived from latest tick. **Assumption:** reproduce the +3h and the ms multiplier exactly.

11. **No health/readiness, no metrics, no rate limiting today.** These are **additive** (don’t change existing routes) and are required by the new spec for 1M users. **Assumption:** add `/healthz`, `/readyz`, `/metrics` as **new** endpoints (no collision with existing surface) — proposed in ARCHITECTURE, not a behavior change.

12. **Hangfire vs. native scheduler.** The daily price-history job + stored procs are LIVE. **Assumption:** port the job semantics (daily fetch + aggregate, 7-day prune, upsert) using a Go scheduler + the same SQL Server schema/procs initially, to keep the DB contract identical. DB engine swap (e.g. TimescaleDB) is a *new-architecture* option to be decided in ARCHITECTURE, not assumed.

13. **TLS downgrade (`Tls11|Tls`).** **Assumption:** Go uses TLS 1.2+ to the MT5 host; this is an internal client setting with no client-observable effect, so it’s safe to modernize.

14. **Two response envelopes / duplicate models** (`Common.cs` vs `MT5/MT5Common.cs`, duplicate `MT5_getPage`/`MT5_get_Orderpage`). **Assumption:** consolidate internally in Go while keeping identical wire output.

---

## 14. What the Go Port Must Preserve (acceptance checklist)

- [ ] Every LIVE route in §3 at the same method + path, same query/body params, same 200/400/401/500 codes.
- [ ] `GlobalResponse` envelope shape and field casing (§11); `Token` casing on auth.
- [ ] JWT: HS256, ASCII key bytes, 1h expiry, `accounts`/`name` claims, issuer/audience NOT validated; `AccountsAuthorize` 401/403 logic.
- [ ] `source=mt5` passthrough vs `source=tv` transforms, including every mapping/constant in §7.6 and §11.
- [ ] MT5 session: single pinned keep-alive connection + cookie, HTTP challenge/response auth, 20s ping, re-auth after 3 failures.
- [ ] `/ws` query-string contract, `TP`/`methodtype` dispatch table, 3s push cadence, the `from==0&&to==1` live-window trick, unauthenticated by default.
- [ ] DB schema (3 tables), 3 stored procs, daily price-history job (fetch + aggregate + 7-day prune).
- [ ] Quirks: `history/delete?ticket=tickets`, `(UTCUnix+3h)*1000`, anonymous `TVOrder`/`Authentication` controllers.
- [ ] DEAD code (native TCP stack, SignalR hub, dead services/middleware) is **not** reproduced as behavior.

---

## 15. Source Cross-Reference (for the implementer)

- Host/DI/middleware/`/ws`: `LegacyMTSocket/Program.cs`.
- Controllers: `LegacyMTSocket/Controllers/*`, `Controllers/tv/TVOrderController.cs`.
- Auth filter/middleware: `LegacyMTSocket/AttributeValidation/AccountsAuthorizeAttribute.cs`, `Controllers/ValidateAccountMiddleware.cs`.
- Upstream paths + envelope + JWT: `LegacyMTSocket.Core/Helpers/{APIUrl,GlobalResponse,AppConstants,JwtTokenHelper}.cs`.
- Domain services + MT5 client/auth: `LegacyMTSocket.InfraService/Services/*` (esp. `AuthenticateServices.cs`, `MT5HttpClient.cs`, `MT5AuthenticationManager.cs`, `LoginService.cs`).
- DTOs/enums/mappers: `LegacyMTSocket.Core/Models/**`.
- DB/jobs: `LegacyMTSocket.InfraService/{Models/PriceHistoryContext.cs,Jobs/PriceHistoryJob.cs}`, `db/create_stored_procedures.sql`.
- DEAD native protocol: `LegacyMTSocket.InfraService/Services/Common/**`, `Services/MT5WebAPI.cs`.

*End of Phase 1 analysis. Phase 2 (ARCHITECTURE.md) proposes the Go design and will not be started until you have reviewed this document — though per the process I will proceed to draft the architecture proposal next unless you want changes here first.*
