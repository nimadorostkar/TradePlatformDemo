# Review Fixes & Production Deployment

**Date:** 2026-07-06

Everything done on the Go gateway (`backend/`) in this cycle: the code-review
fixes (5 blockers + 4 pre-launch items from `NIMA.txt`), the validation
work, a full production-shape end-to-end test, and the redeploy to the
production VPS. All work is on `main` (commit `49703d5` deployed).

---

## 1. Context

A code review (`NIMA.txt`) identified **5 blockers** and **4 pre-launch
items** that had to be fixed before deployment. All nine were fixed,
tested, and are now running in production.

---

## 2. The five blockers

### 2.1 Go version (`go.mod` said `go 1.26`)

- **Review asked for:** change to Go **1.24**.
- **What actually happened:** 1.24 is impossible — `go mod tidy` proved that
  `pgx v5.10`, `nats.go v1.52`, and all `golang.org/x/*` dependencies declare
  **Go 1.25** as their minimum. The build refuses to resolve on 1.24.
- **Fix:** `go.mod` → `go 1.25.0`, `deploy/docker/Dockerfile` →
  `FROM golang:1.25`, README requirement updated to "Go 1.25+".
- **Verified:** `go build ./...`, `go vet ./...`, full test suite green.

### 2.2 Launch-day mass logout (JWT issuer/audience validation)

- **Problem:** .NET issues JWTs with only `name` + `exp` — no `iss`/`aud`
  claims (confirmed by reading `JwtTokenHelper.cs` and `Program.cs` in the
  .NET repo, which itself validates with both flags off). The Go default
  validates both → every existing token 401s at cutover.
- **Debugging finding:** the compose and Windows prod templates were already
  correct, but **`deploy/k8s/configmap.yaml` had both flags `"true"`** — the
  exact launch-day trap. Worse, **`docs/LAUNCH.md`'s go-live checklist
  actively instructed "JWT iss/aud validation on"** — the "if we forget it"
  failure encoded in the docs.
- **Fix:** ConfigMap flipped to `"false"` with an explanatory comment; the
  LAUNCH.md checklist item rewritten into an explicit cutover step
  (keep `false` until all clients hold Go-issued tokens ≥ `JWT_EXPIRY` after
  cutover); warning comment added to `.env.example`.
- **Test added:** `TestLegacyDotNetTokenDuringTransition` forges an exact
  .NET-shaped token (HS256, `name`+`exp` only) and asserts it validates with
  the flags off and is rejected with them on. Tightening later is safe
  because Go-issued tokens always embed `iss`/`aud`.
- **Proven in production:** a Go-issued JWT was accepted by the live .NET
  service on port 5063 — shared-secret coexistence works for real.

### 2.3 Rate-limiter goroutine leak

- **Problem:** the cleanup (janitor) goroutine in
  `internal/httpapi/middleware/ratelimit.go` looped on a ticker forever —
  no stop channel, no context.
- **Fix:** `RateLimit` and `newIPLimiter` take a `context.Context`;
  `janitor(ctx)` selects on both `ctx.Done()` and the ticker. `main.go`
  passes the SIGINT/SIGTERM lifecycle context, so the goroutine dies during
  graceful shutdown.
- **Test added:** `TestRateLimit_JanitorStopsOnCancel` — starts a limiter,
  cancels the context, asserts the goroutine count drops back. Passes under
  `-race`.

### 2.4 Blocking sleeps in trade endpoints

- **Problem:** `domain/trade.go` had `time.Sleep(200ms)` after
  `send_request` and `time.Sleep(100ms)` in the result-poll retry loop —
  request-handling goroutines held hostage after client disconnect.
- **Fix:** added `sleepCtx(ctx, d)` (timer + `ctx.Done()` select; used
  `time.NewTimer` + `Stop()` instead of the review's `time.After`, which
  can't release its timer on the cancel path). The retry loop aborts to the
  existing `{order:0,status:5}` fallback on cancellation; the settle delay
  returns the same fallback a dead poll would have produced. Happy-path
  timing (the .NET-parity 200ms settle) is unchanged.
- **Tests added:** cancelled `GetRequestResult` returns in <50ms; cancelled
  `SendRequest` in <100ms; happy path still waits out the settle and polls
  (measurably ~0.2s).

### 2.5 WebSocket account-ownership leak

- **Problem:** `ws.go:authorized()` validated the JWT signature but never
  checked whether the subscribed `login` belonged to the token holder — a
  valid token for account A could stream account B's positions/orders.
- **Fix:** `authorized()` became `authenticate()` returning the claims;
  `ServeHTTP` now rejects with **403 before the upgrade** any `login`-scoped
  subscription where `claims.HasAccount(login)` is false — the same policy
  as the REST `AccountsAuthorize` middleware. A token with no accounts claim
  owns no accounts (public tick streams without `login` still work).
- **Tests added:** the exact A-reads-B leak → 403; owned account → accepted;
  name-only token with any `login` → 403.
- **Operational caveat:** the guard activates when `WS_REQUIRE_AUTH=true`.
  Production currently runs `false` (legacy .NET parity during coexistence);
  the ownership guarantee begins the moment WS auth is hardened.

---

## 3. The four pre-launch items

1. **Hardcoded DSN credentials** — `POSTGRES_DSN`/`TIMESCALE_DSN` defaults
   changed from `postgres://opo:opo@localhost/...` to empty. Unset
   `TIMESCALE_DSN` now logs a loud startup warning ("API-only mode") instead
   of silently dialing baked-in credentials, and `Validate()` hard-fails on
   the incoherent combination `MT5_READ_DATA_FROM_DB=true` with no DSN.
2. **Rate limiter fails open silently on Redis errors** — new Prometheus
   counter `rate_limit_fail_open_total` (increments on every fail-open;
   alert on it) plus a warning log throttled to once per 30s. Wired via an
   `onFailOpen` callback so the middleware stays free of metrics imports.
   Test: erroring limiter passes traffic AND reports.
3. **No backoff between MT5 retries** — `executeWithRetry` now waits
   50ms → 100ms (exponential, context-aware) between its 3 attempts.
   Tests pin both the backoff (≥150ms total on a dead upstream) and prompt
   abort on cancellation.
4. **X-Forwarded-For trusted blindly** — new `RATE_LIMIT_TRUSTED_PROXIES`
   env (CIDRs/IPs). Default empty = trust no proxy: requests are keyed by
   the TCP peer and spoofed XFF is ignored. From a trusted proxy, the key is
   the rightmost XFF hop that isn't itself trusted (client-prepended fakes
   ignored). Invalid CIDRs fail startup. **Must be set when behind an
   ingress/LB** or all clients share one bucket (documented in
   CONFIGURATION.md / .env.example). Full test matrix added.

---

## 4. Validation work (Phase 1)

- **Race suite:** `go test -race ./...` — all 11 packages pass.
- **WebSocket fan-out proof:** new permanent test
  `TestWS_100ClientsOneSymbol_OnePollPerCadence` drives **100 real WebSocket
  connections** through the actual `/ws` handler: 100 clients × 20 cadences
  = **exactly 20 upstream MT5 polls (1.00/cadence)**. The .NET design would
  have made 2,000.
- **Parity harness:** new `scripts/paritycheck` CLI replays identical
  requests against the .NET and Go services (20 REST checks + WS tick and
  position frames) and separates **structural** diffs (missing/extra/typed
  fields → exit 1) from **value** diffs (live prices — expected). Nested
  JSON strings from passthrough endpoints are parsed and compared
  structurally. Smoke-tested end-to-end. `send_request` is behind an
  explicit `-send-trade` flag (places a real order).
- **DB migration rehearsal script:**
  `deploy/windows/migrate-price-history.ps1` — exports
  `Symbolwisepricehistorydata`/`Symboldailydata` from the .NET `OpoFinance`
  SQL Server DB, **dedupes on (Symbol, Time) keeping the latest `Id`** (the
  old schema allows duplicates; the Postgres PK does not), upserts into
  Postgres, verifies counts, and numerically spot-checks 20 random rows.
  Defaults to `market_staging`; the real `market` DB requires an explicit
  flag. Documented in `deploy/windows/README.md` step 6.

---

## 5. Full production-shape E2E test (local)

Built a complete local production rig, since the real MT5 API only accepts
the whitelisted VPS IP:

- **`scripts/mockmt5`** — a faithful stand-in for the MT5 Manager Web API
  **and** the CRM: real auth-handshake flow (`auth/start` → `auth/answer` +
  session cookie), ping, all ~50 upstream data paths with correctly-shaped
  bodies, CRM login/accounts (including the typeId filtering rule).
- **`scripts/wsprobe`** — tiny WS client printing rejection status or frames.
- **`scripts/e2e_test.sh`** — 117 checks: every documented REST endpoint
  (Order 13, Position 14, Deal 10, History 6, Symbol 7, Tick 9, Trade 9
  incl. the full send_request→poll→PlacedOrder flow, User 4, Test 4,
  TVOrder 5), the production CRM login flow, 401/403 enforcement,
  account-ownership 403s on REST and WS, all four WS TPs + invalid-TP
  literal + auth rejections, CORS allow/deny, rate-limit burst exhaustion
  (197/300 429s), XFF-spoof resistance (146/150 still 429), operational-path
  exemption, and all five metric families.

**Result: 117/117 PASS**, gateway running with `ENVIRONMENT=production`,
hardened auth, and prod rate limits.

Separately verified live:
- **Upstream failure:** killed the mock mid-run → clean 400 error envelope
  in **1.2 ms** (no hang, no goroutine pileup); first request after restart
  succeeded via on-demand re-auth.
- **Graceful shutdown:** SIGTERM with a live streaming WS → drained and
  exited 0 in <1s (`draining → complete` in the log).

**Bugs found during E2E — all three were in the test/docs, not the service:**
1. `docs/API.md` claimed `GET /` returns 302 → `/swagger`; it actually
   serves a landing page (200). Docs fixed.
2. The TV symbol transform outputs `ticker`/`name` (not `symbol`) — test
   expectation corrected.
3. The rate-limit probe originally forked 140 curl processes — too slow to
   outrun the 50 rps token refill, so no 429s; and the follow-up XFF check
   ran after refill (one token available → false "bypass"). Rewrote both to
   sustained single-process bursts (300 and 150 requests over a kept-alive
   connection).

---

## 6. Production deployment (VPS 46.62.247.67)

**Found:** the Go gateway task `OpoGatewayGo` had been **stopped since
2026-06-22** (clean shutdown — someone ended the task; port 5070 not
listening) and the on-disk exe was the June-19 build, predating all nine
fixes. The .NET gateway on 5063 was running normally.

**Deploy procedure (server git can't reach GitHub non-interactively, so the
proven path is binary deploy):**
1. Snapshotted every listening port (the "before" baseline).
2. Cross-compiled `main` (`49703d5`) with `GOOS=windows GOARCH=amd64`.
3. Backed up the old exe → `C:\opomtsocket-go\backups\gateway.exe.pre-20260706`.
4. `scp` the new exe; `schtasks /run /tn OpoGatewayGo`.
5. `run.bat` needed **no changes** — its coexistence config
   (`JWT_VALIDATE_ISSUER/AUDIENCE=false`, shared .NET JWT secret) is exactly
   the transition config blocker #2 requires. SHA-256 of the server binary
   matches the local build byte-for-byte.

**Verified in production (read-only only — no trades):**
- Startup: MT5 authenticated against the real broker instantly, Timescale
  connected, price-history job running (798 symbols).
- `/healthz` alive, `/readyz` ready, landing + `/swagger` 200.
- Live EURUSD via REST raw + TV transform + WS stream (bid 1.14145);
  DB-backed 1D OHLC bars served from Postgres; 401 without token.
- **Go-issued JWT accepted by the .NET service** (coexistence proven live).
- **Other services untouched, verified:** port snapshot before/after
  identical except 5070 appearing; the .NET process kept the same PID
  (never restarted) and still serves; SQL Server, PostgreSQL, RDP, SSH,
  WinRM unchanged; both scheduled tasks Running.

**Known upstream quirk (not a regression):** `/api/Tick/get` (M1 chart)
returns empty in production — the same request through the .NET service
gets `"3 Invalid parameters"` from the real MT5, so both gateways behave
consistently against the same upstream.

**Rollback if ever needed:**
`copy C:\opomtsocket-go\backups\gateway.exe.pre-20260706 C:\opomtsocket-go\gateway.exe`
then restart the task.

### 6.1 What is live at `http://46.62.247.67:5070` (quick reference)

The Go gateway is up and serving **real MT5 data**. Ready to use now:

| URL | What |
|---|---|
| `http://46.62.247.67:5070/` | landing page |
| `http://46.62.247.67:5070/swagger` | interactive API console (try any endpoint) |
| `/healthz` · `/readyz` · `/metrics` | liveness · readiness (tracks MT5 session) · Prometheus |
| `POST /api/Authentication/login` | get a JWT — coexistence mode: `{"Username":"<name>"}` is enough; .NET-issued tokens also work (shared secret) |
| `/api/Order/*` · `/api/Position/*` · `/api/Deal/*` · `/api/History/*` | trading data (JWT required, `Authorization: Bearer <token>`) |
| `/api/Symbol/*` · `/api/Tick/*` · `/api/User/*` · `/api/Trade/*` · `/api/Test/*` | symbols, live quotes/charts, accounts, trade ops (JWT) |
| `/api/tv/TVOrder/*` | TradingView order surface (anonymous) |
| `ws://46.62.247.67:5070/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv` | live tick stream (~3s push); TP=2 positions, TP=3 user, TP=4 orders — currently anonymous (legacy parity) |

Full endpoint list with parameters: [`API.md`](API.md). Add `&source=tv`
for TradingView-shaped responses. `getHistoryby1Dresolution` serves
DB-backed daily bars from the server's PostgreSQL store.

**Also ready on the server:** PostgreSQL 16 (`market` + `trading_ops`,
price-history job ingesting 798 symbols), auto-restart on reboot
(scheduled task `OpoGatewayGo`, 60s delay after Postgres), rotating logs at
`C:\opomtsocket-go\logs\gateway.log`. The .NET gateway keeps running
unchanged at `http://46.62.247.67:5063` — same JWT works on both.

---

## 7. Files changed / added in this cycle

| Area | Files |
|---|---|
| Blocker fixes | `go.mod`, `deploy/docker/Dockerfile`, `deploy/k8s/configmap.yaml`, `internal/httpapi/middleware/ratelimit.go`, `internal/domain/trade.go`, `internal/realtime/ws.go`, `cmd/gateway/main.go` |
| Pre-launch fixes | `internal/config/config.go`, `internal/observability/metrics.go`, `internal/mt5/conn.go` |
| New tests | `internal/auth/jwt_test.go` (+legacy-token), `internal/httpapi/middleware/middleware_test.go` (+janitor, fail-open, XFF matrix), `internal/domain/trade_test.go` (new), `internal/mt5/conn_test.go` (new), `internal/realtime/ws_test.go` (+3 ownership), `internal/realtime/loadtest_ws_test.go` (new, 100-client fan-out) |
| New tooling | `scripts/paritycheck/`, `scripts/mockmt5/`, `scripts/wsprobe/`, `scripts/e2e_test.sh`, `deploy/windows/migrate-price-history.ps1` |
| Docs | `README.md`, `docs/LAUNCH.md`, `docs/CONFIGURATION.md`, `docs/API.md`, `.env.example`, `deploy/windows/README.md` |

## 8. Current state & what remains

**State:** all 9 review items fixed, tested, and live in production on
`http://46.62.247.67:5070` (coexisting with .NET on 5063). Full suite green
under `-race`; local E2E 117/117.

**Remaining (needs access, one command each):**
- Run `scripts/paritycheck` against the live .NET + Go pair with a real
  account token (needs a test login).
- Run `migrate-price-history.ps1` rehearsal on the VPS (its first execution
  will also validate the PowerShell syntax — no pwsh on the Mac).
- When clients are ready: harden `run.bat`
  (`WS_REQUIRE_AUTH=true`, real CORS
  allowlist, then later `JWT_VALIDATE_*=true`) — this also activates the
  WS account-ownership guard.
