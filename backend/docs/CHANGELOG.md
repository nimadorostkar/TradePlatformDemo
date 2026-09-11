# Changelog

## 2026-08-12 — Production remediation: one clock, restorable sessions, honest environment

Implements the backend half of the 2026-08-10 production-readiness findings
(`OPOTRADE_PRODUCTION_REMEDIATION_PLAN.md`): TIME-001, DATA-001, AUTH-001,
ENV-001, OBS-001. No breaking config change; two new env vars are optional.

### TIME-001/DATA-001 — account data joins the chart on UTC

The chart path already converted between MT5's broker clock (UTC+3 here) and
UTC at the gateway boundary. The account-data paths did not: deal, closed-order
(history), position and order times went out broker-stamped, and client
from/to windows went to MT5 uninterpreted. Two production symptoms, one cause:

- the same trade displayed 3 hours apart in different panels;
- a fresh trade was invisible to History/Deals/"today" queries for exactly the
  broker offset, because its broker-stamped time sat in the client's future.

Now every service holds the shared broker-clock resolver (`BrokerClock`,
resolved off live ticks with the hardened .NET-parity rules): windows are
shifted onto the broker clock on the way in, timestamps restated in UTC on the
way out — REST and WS both, since they share the domain services. The
hard-coded `+3h` in the placed-order `updateTime` is gone, and a client GTD
`TimeExpiration` (UTC) is now restated on the broker clock before it reaches
the dealer. Contract: **no public timestamp of this API is broker-local; all
epochs are UTC.**

### AUTH-001 — sessions survive a reload

`POST /api/Authentication/login` now also leaves the session in `HttpOnly`,
`Secure`, `SameSite=Lax` cookies (`opotrade_session`, `opotrade_crm`,
`opotrade_user`). Two new anonymous routes:

- `GET  /api/Authentication/session` — returns `{token, crmToken?, username?}`
  while the cookie-held JWT validates; 401 (and clears cookies) otherwise.
- `POST /api/Authentication/logout` — clears the cookies.

Bearer auth on every API route is unchanged; the cookies are a restoration
channel only, and no credentialed CORS exists, so they are unreachable
cross-origin.

### ENV-001 — trusted runtime identity

`GET /api/Capabilities` now carries `environment` (`name`, `tradingMode`,
`mt5Server`, `buildSha`, `apiVersion`) and `sessionCookies`. New env var
`TRADING_MODE` (default `"live"` — the deployment that forgets it gets the
real-money warning, never a false "demo"). The terminal renders its LIVE
banner from this block.

### OBS-001 — every trade submission is one audit line and a metric

`POST /api/Trade/send_request` logs `login`, `symbol`, `client_request_id`,
`outcome`, `retcode`, `order_id`, `replayed`, `dealer_ms` per submission, and
`trade_submissions_total{outcome,replayed}` counts them. Alert on the
`unknown` rate: each one is a trader told to reconcile against Positions.

### TV-001 (backend share) — chart volume

`/api/Tick/get` bars map MT5 tick volume from row index 5 when the broker
publishes it, instead of pinning `volume` to 0.

---

## 2026-07-31 — Terminal backend requirements

Closes the thirteen gaps the trading terminal had gated off or degraded
(`docs/integration/backend-requirements.md` in the UI repo), plus three issues
found while deploying. Live on staging (`opotrade-stage-backend.opofinance.com`)
and verified against the production broker.

**Read first if you are deploying this:** [Deploying it](#deploying-it) — one
config setting will lock traders out if it is missed.

---

## Correctness fixes

### WebSocket order status reported the wrong table

`OrdersToTVV2` (the WS path) ran an order *state* through `MT5ToTVType`, an
order-**type** table. Distinct states collapsed onto one number:

| WS `status` | could mean |
|---|---|
| `1` | CANCELED **or** PARTIALLY FILLED |
| `3` | FILLED **or** REJECTED |

Over the WebSocket a filled order and a rejected one were indistinguishable. It
now uses `MT5ToTVStatus`, the same table the REST path uses. Treat the WS
`status` as authoritative.

### Trade responses did not state MT5's verdict

`send_request` could return any of three shapes and the client had to guess
whether a trade was accepted. It now returns **one** documented shape per
`source`, always carrying `resultRetcode`, plus a derived tri-state:

```json
{ "resultRetcode": "10009 Done", "outcome": "accepted",
  "retcodeDescription": "Request completed" }
```

| `outcome` | Meaning | Retcodes |
|---|---|---|
| `accepted` | MT5 took the order | `10008`, `10009`, `10010` |
| `rejected` | MT5 refused it | everything else readable |
| `unknown` | **result could not be read** | `10012` timeout, absent/unparseable |

**Branch on `outcome`, never on the shape.** `unknown` is a real answer: the
order may be live. Reconcile against Positions — do not report failure and do
not resubmit. The legacy `status: 5` on the unreadable-result fallback reads as
"rejected" on its own and is retained only for wire compatibility.

### Volume units were undocumented — and had caused an outage

MT5 reports volume at two scales (`1/10000` lot, and `1/100000000` lot for
`…Ext` fields). Reading one as the other once made the order ticket demand a
100-lot minimum and blocked all trading.

Every conversion now goes through `internal/transform/volume.go`, and the wire
carries explicit lot-denominated fields alongside the originals — **additive, so
no existing client breaks**:

- orders: `qtyLots`, `filledQtyLots`
- positions: `qtyLots`
- trade results: `qtyLots`, `filledQtyLots`
- symbols: `volume_min_lots`, `volume_max_lots`, `volume_step_lots`
- market depth and executions: volumes already in lots

⚠️ **`volume_precision` is not a lot value and never was.** It carries the .NET
service's raw `VolumeMin` under a TradingView field name; reading it as lots is
what caused the outage. Build order tickets from the `_lots` fields.

Full per-field table: **[VOLUME-UNITS.md](VOLUME-UNITS.md)**.

---

## Missing fields

**Swap and commission on positions** — `swap` (MT5 `Storage`) and `commission`
on every position shape. Both are **nullable on purpose**: `null` means the
broker did not send a value, `0` means a real zero. Do not render `null` as
`0` — a trader reconciling costs reads those as different facts. MT5 carries
`Storage` on every build and `Commission` only on some, so commission is
commonly `null`.

**SL/TP on the WebSocket position stream** — `PositionsToTVWs` omitted
`priceSL`/`priceTP`, so protective levels were unknowable between REST
snapshots. The WS and REST position shapes are now identical; a stream that
reports less than the snapshot it interleaves with makes the two disagree.

**Order expiration** — orders carry `expiration` (unix seconds, `0` = GTC),
`typeTime`, and the TradingView-native `duration` block. `send_request` accepts
`typetime` + `expiration`, `expiration` alone, or a `duration` block, and
translates to MT5's `TypeTime`/`TimeExpiration`. A GTD with no deadline is
downgraded to GTC rather than sent as an expiry of 1970, which MT5 answers with
`INVALID_EXPIRATION` — a rejection that reads to a trader as unexplained. A body
with no duration fields is forwarded byte-for-byte unchanged.

---

## New capabilities

**Market depth** — `/api/Tick/get_marketdepth` returns a normalized ladder
(bids best-first, asks best-first, volumes in lots, `"volumeUnit":"lots"` stated
on the wire) instead of an undocumented raw passthrough. Two honesty flags:

- `crossed: true` — best bid ≥ best ask, which a healthy book never is. It means
  `MT5_BOOK_SIDE_CONVENTION` does not match this broker. **Reported, not
  silently repaired**: showing liquidity a trader cannot hit is worse than
  showing none.
- `unknownSideCodes` — the distinct side codes that were skipped, so a partial
  ladder is diagnosable rather than merely flagged.

**Price alerts** — `/api/Alert/{list,create,delete}`, Postgres-backed and
evaluated server-side, so an alert keeps working after the browser tab closes.
Delivered over WS `TP=6` with a `fromtime` cursor. Comparison is inclusive.
`login` is required on delete and matched in the `DELETE` itself — an id alone
would let any authenticated trader delete another trader's alert.

**Executions** — `GET /api/Deal/since?login=&after=` and WS `TP=7`. The cursor
is **exclusive**, so polling with the newest `timeSeconds` never re-delivers a
fill. Balance operations are excluded; they carry no price and must never become
chart markers.

**Trade idempotency** — `Idempotency-Key` header or `clientRequestId` body
field. A repeat inside the window replays the original result (marked with the
`Idempotent-Replay: true` response header) and never reaches the dealer twice; a
repeat while the original is in flight is answered `unknown` rather than
submitted again. Keys are scoped per account. Redis-backed across replicas,
per-process otherwise.

**Workspace persistence** — `/api/Workspace/{get,save}`, one opaque versioned
JSON document per login. A login that has never saved is a **success** with
`document: null, version: 0` — a normal state for a new trader, not an error.

**News / economic calendar** — `/api/News/list`, `/api/Calendar/list`, proxies
to whichever provider is licensed. The API key stays server-side and only an
allowlist of query parameters is forwarded upstream.

**`GET /api/Capabilities`** — feature-detection, so the terminal gates on an
answer rather than on a 404. Every disabled feature carries the reason.

---

## Account-type policy

Which CRM account types may trade is configuration now, not a constant. A type
may only trade when its symbol suffix is known — a wrong suffix sends a wrong
symbol name to MT5.

`POST /api/Authentication/accounts` returns each account with `suffix` and
`suffixKnown`. **Do not build symbol names for an account with
`suffixKnown: false`.**

Confirmed against the live broker by reading each account's MT5 group and
cross-checking the symbol namespace, where the same instrument exists under each
suffix (`AUDNOK.` / `AUDNOK!` / `AUDNOK#`):

| Tier | Suffix | typeIds | Group contains |
|---|---|---|---|
| ECN | `.` | 57, 61 | `ECN-…` |
| Standard | `!` | 58, 62 | `STD-…` |
| Social / COPY | `#` | 60 | `COPY-…` |
| ECNPRO | *(none)* | 11, 59, 63 | `ECNPRO-…` |

**typeId 64** (`COPY-ECNPRO-APP-USD-B`) is deliberately unmapped: the group name
carries both qualifiers, so the suffix is ambiguous. It stays
`suffixKnown: false` — two accounts lose symbol names, which beats routing their
orders to the wrong instrument. **Confirm with the broker.**

---

## Issues found while deploying

### An unreachable Redis killed the gateway at startup

The first deploy started, authenticated MT5, connected both stores, then
vanished — no panic, nothing in the log.

`REDIS_ADDRS` was unset, so it defaulted to `localhost:6379`; the new
idempotency store built a client whenever that is non-empty; no Redis was
installed; go-redis wrote dial failures to **stderr**; and `run.ps1` ran the exe
under `$ErrorActionPreference = "Stop"` with PowerShell stream redirection —
which surfaces a native program's stderr as its *error* stream. The first retry
notice became a terminating error and took the gateway with it.

The previous build never tripped this because it only built a Redis client when
`RATE_LIMIT_RPS > 0`, which is `0` in production. **This regression was
introduced by the idempotency work.**

Fixed at both layers, because either alone leaves the trap armed:

- `cache.SetLogger` routes go-redis diagnostics into slog, so stderr stays
  empty. An optional dependency the gateway degrades past must never be able to
  terminate it.
- `run.ps1` redirects the child's streams at the process level and drops to
  `ErrorActionPreference = "Continue"` before launching. Config validation stays
  fail-fast; *running* does not. Pipes are drained asynchronously so a full
  buffer cannot block the gateway.

Note: **`REDIS_ADDRS=` does not disable Redis on Windows.** Setting an
environment variable to an empty string deletes it, so the value never reaches
the process and the default applies anyway. On a host without Redis, three retry
warnings at startup are expected and harmless.

### Anonymous order cancellation on a public host

An audit of all 76 operations found 8 anonymous, three of which mutate real
orders:

| Endpoint | Unauthenticated caller could |
|---|---|
| `GET /api/tv/TVOrder/cancelOrder/{orderId}` | **cancel any order** by ticket, `200` either way |
| `POST /api/tv/TVOrder/placeOrder` | submit a trade on login `1010` |
| `POST /api/tv/TVOrder/modifyOrder` | modify an order on login `1020` |
| `GET /api/tv/TVOrder/orders` | read that login's book |

Ticket numbers are sequential, so this let anyone who could reach the host walk
the broker's book. Inherited .NET behavior, not a regression — but live.

The gateway log showed **zero calls** to `placeOrder`, `cancelOrder`, and
`modifyOrder` for the life of the file, so nothing depended on anonymous access.

They were first moved behind the JWT filter behind a `TVORDER_REQUIRE_AUTH`
flag. That was superseded during the 2026-08-01 audit: the whole controller
**was removed**, because every one of its routes duplicated a canonical
account-scoped endpoint and two of them mutated hardcoded logins. All five
paths now return **404**, and the flag no longer exists — there is nothing to
switch back on. Use the canonical `/api/Order/*` and `/api/Trade/*` routes,
which are account-scoped and enforce ownership.

Anonymous operations: **8 → 4** (the three login routes and `Capabilities`).

---

## Deploying it

### ⚠️ Set `CRM_ALLOWED_ACCOUNT_TYPES` before the first start

The code default admits types **57–67 only**. The previous build also admitted
**11 and 26**. On the staging CRM, **typeId 11 is the most common type** — 6 of
17 accounts, including the primary test login. Without the override those
traders get a token with no accounts claim and are **401'd on every protected
endpoint**.

```
CRM_ALLOWED_ACCOUNT_TYPES=11,26,57,58,59,60,61,62,63,64,65,66,67
```

`update.ps1` and `update.bat` refuse to proceed silently if it is missing.

### Steps

```powershell
make build-windows                       # on a dev machine
# copy bin\gateway.exe to the server as C:\opomtsocket-go\gateway.new.exe
.\update.ps1 -BinaryPath C:\opomtsocket-go\gateway.new.exe
.\smoke-test.ps1 -CrmEmail <email> -CrmPassword <pw>
```

`update.ps1` validates the binary **before** stopping the service, keeps the
previous one, and rolls back automatically if `/healthz` does not return.
`update.bat` is the cmd-native equivalent for a host administered from `cmd`.

`smoke-test.ps1` is read-only — no trade, no alert, no workspace write.

### New tables

Alerts and workspaces create `price_alerts` and `workspaces` in `POSTGRES_DSN`
on first start — additive `CREATE TABLE IF NOT EXISTS`, no existing table
touched. With no DSN both features report themselves off through
`/api/Capabilities` rather than accepting data they cannot keep.

### Verify

| Check | Failure means |
|---|---|
| `/api/Capabilities` returns 200 | a 404 means the **old binary** is still running |
| `crossed: false` on market depth | a wrong `MT5_BOOK_SIDE_CONVENTION` — flip `mql5` ⇄ `manager` |
| `volume_min_lots` is a plausible lot size | volume scaling is wrong — this is the outage that already happened |

---

## Configuration added

| Var | Default | Purpose |
|---|---|---|
| `CRM_ALLOWED_ACCOUNT_TYPES` | `57…67` | tradable account types — **see the warning above** |
| `CRM_ACCOUNT_TYPE_SUFFIXES` | *(empty)* | `typeId:suffix` map |
| `TRADE_IDEMPOTENCY_TTL` | `10m` | replay window for a submission with a key |
| `MT5_BOOK_SIDE_CONVENTION` | `mql5` | book side numbering (`mql5` \| `manager`) |
| `ALERTS_ENABLED` | `true` | run the alert evaluator in this process |
| `ALERTS_EVAL_INTERVAL` | `3s` | alert sweep cadence |
| `NEWS_PROVIDER_URL` / `_API_KEY` / `_API_KEY_HEADER` | *(empty)* | news proxy |
| `CALENDAR_PROVIDER_URL` / `_API_KEY` / `_API_KEY_HEADER` | *(empty)* | calendar proxy |
| `CONTENT_CACHE_TTL` | `60s` | provider response cache |
| `CONTENT_TIMEOUT` | `10s` | per provider request |

Details in **[CONFIGURATION.md](CONFIGURATION.md)**.

---

## Verification performed

- Unit tests and golden files across 12 packages, plus `-race` on the
  concurrent ones
- Store SQL exercised against PostgreSQL 16 (schema, the compare-and-set that
  stops an alert firing twice, the advisory lock, the jsonb round-trip)
- End-to-end run against the mock MT5
- **All 76 live operations probed: 0 anomalies**, every protected route `401`
  unauthenticated, no 5xx
- Live smoke test against the production broker: **16/16**, including the
  crossed-book and volume-scaling checks
- Runtime on staging: 0 ERROR lines, 0 5xx served, 0 bytes on stderr

### Not verified

- **typeId 64's suffix** — needs the broker; safe-failing as `suffixKnown: false`
- The remaining 8 suffix mappings are inferred from three agreeing sources
  (group tier names, symbol namespace, the requirements doc) — strong, but still
  inference. Worth one confirmation on an ECN account before trading on it.
