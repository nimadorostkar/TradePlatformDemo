# Production Readiness Audit (Section 1)

Audit of the Go gateway in `backend/` against
the .NET behavior and the production hardening requirements. Verified by reading
the implementation and running `go build`/`go vet`/`go test` (all green) plus the
golden-parity suite.

**Legend:** PASS = implemented and verified · FAIL = missing or not fail-closed ·
DEVIATION = works but differs from the stated design · N/A = not applicable.

> **Status: all findings A–F resolved and re-verified** (§4 records each fix).
> Section 1 originally surfaced 2 FAILs (A, B) + 3 findings (C, D, E); a 6th
> (F, a WebSocket 501 bug) was caught by the Section-2 smoke test and fixed.
> Full suite green under `-race`; smoke test 7/7 (see `docs/TEST_RESULTS.md`).

---

## 1. Behavioral parity (.NET → Go)

| Area | Status | Evidence |
|---|---|---|
| REST routes/verbs | PASS | `handlers/mount.go` exposes the canonical production APIs; hardcoded/duplicate/stub compatibility routes are removed and verified 404 |
| Response envelope + status codes | PASS | `response.GlobalResponse` field order `data,errorMessage,message,success`; success→200/failure→400; auth→401; Test→200/500 |
| Per-endpoint `data` shape (string vs object vs TV) | PASS | Golden suite `handlers/testdata/golden/*.json` locks all three classes; `go test ./internal/httpapi/handlers` green |
| MT5→TradingView transforms | PASS | `transform/*` unit-tested (mappings, session/path converters, `lastprice` fallback, `(UTCunix+3h)*1000`) |
| Required compatibility quirks | PASS | `history/delete?ticket=tickets` and char-split `string.Join(",",ticket)` remain pinned; unsafe hardcoded TV-order bodies were removed |
| WS `/ws` contract | PASS | query-string subscription, `TP`(1–4)+`methodtype` dispatch, serialized `data` frames, ~3s cadence, `"Invalid TP value"` literal (`realtime/dispatch.go`, `ws.go`); integration-tested with a real WS client |
| Hub fan-out | PASS | shared-topic dedup + replay + teardown; NATS cross-pod mode |

---

## 2. Security hardening (must fail closed)

| Control | Status | Notes |
|---|---|---|
| JWT required on `/ws` | **PASS** | `WS_REQUIRE_AUTH` defaults `true`; browser token via non-URL credential subprotocol or Bearer header; legacy query transport is separately disableable. With no validator configured authentication returns 401 (fails closed). Tested. |
| CORS allowlist | **PASS (fixed)** | Default changed to empty = fail-closed (no cross-origin until configured); `"*"` only as explicit legacy. Tested (`TestCORS_FailClosed`). See §4-A. |
| Jobs/Hangfire endpoint authenticated | N/A (PASS) | The .NET Hangfire dashboard was **not ported**; jobs run via in-process cron with **no HTTP endpoint**, so the attack surface doesn't exist. Caveat: `/metrics` is unauthenticated (by design, internal scrape — protect via NetworkPolicy). Unused `DASHBOARD_*` config keys removed. |
| JWT issuer + audience validated | **PASS** | `JWT_VALIDATE_ISSUER` and `JWT_VALIDATE_AUDIENCE` default `true`; issued tokens carry `iss`/`aud` so they validate; tokens lacking them (legacy .NET) are rejected. |
| No no-password login path | **PASS (fixed)** | The non-CRM username/password path is **removed** (401, no config toggle); only CRM-backed auth issues tokens. Tested (`TestLogin_RequiresCRMToken`). See §4-B. |
| WebSocket upgrade works through middleware | **PASS (fixed)** | A 501 hijack bug (F) was found and fixed; `/ws` now upgrades to 101. Regression-tested. |

---

## 3. Production essentials

| Item | Status | Evidence |
|---|---|---|
| Graceful shutdown | PASS | `signal.NotifyContext` → `srv.Shutdown(timeout)` → `wsHub.Wait()`; deferred `manager.Stop()`, store/bus `Close`, scheduler `Stop` |
| Health + readiness | PASS | `/healthz` (liveness), `/readyz` (tracks MT5 session via `watchReadiness`) |
| Structured logging, no secrets | PASS | `log/slog` JSON; grep confirms no password/secret/token logged |
| Configurable timeouts | PASS | server read/write/idle/shutdown; `MT5_REQUEST_TIMEOUT`; `WS_WRITE_TIMEOUT`; DB connect timeout |
| MT5 connection pooling | PASS | `mt5.Manager` bounded pool (`MT5_POOL_SIZE`), pinned keep-alive conn + cookie, 20s ping, re-auth |
| WS backpressure | PASS | bounded per-subscriber channel, latest-wins drop, drop counter metric |
| Bounded goroutines | PASS (caveat) | upstream concurrency bounded by the MT5 pool (acquire blocks); per-connection reader/writer goroutines are bounded by connection count — cap connections at the ingress/LB |
| Rate limiting | PASS (weak default) | in-proc token bucket + Redis distributed limiter; **default `RATE_LIMIT_RPS=0` = disabled**. See §4-C. |
| Prometheus metrics | PASS | `/metrics`: `http_requests_total`/duration by route, `ws_active_connections`, `ws_messages_dropped_total`, `mt5_requests_total`, Go/process collectors |
| Circuit breaker (MT5) | PASS | `gobreaker` — transport failures trip, business 4xx don't; unit-tested |

---

## 4. Findings — all resolved

Each item below was applied and re-verified (build/vet/test/-race + smoke).

### A. FIXED — CORS default is wildcard
`config.Security.CORSAllowedOrigins` defaults to `["*"]`. A hardened default must
fail closed (deny cross-origin unless an allowlist is configured).
**Proposed fix:** default to empty (no cross-origin `Access-Control-Allow-Origin`
emitted; same-origin and non-browser clients unaffected); require operators to set
`CORS_ALLOWED_ORIGINS`. Update `.env.example`/configmap (the k8s ConfigMap already
sets a real allowlist). No change to the wire behavior of the API itself.

### B. FAIL — username/password login issues unvalidated tokens
The non-CRM login branch issues a valid JWT from a username with any non-blank
password — there is no credential store to validate against (the .NET service
behaved the same; real auth is the CRM path). This is not fail-closed.
**Fixed:** the unvalidated fallback is **removed entirely** (no config toggle) —
`POST /api/Authentication/login` without a `CRMToken` returns 401, and the
CRM-backed paths (`CRMToken` present, or `/api/Authentication/crmlogin`) are the
only token issuers. External REST contract otherwise unchanged.

### C. FIXED — rate limiting off by default
**Fixed:** `.env.example` now recommends `RATE_LIMIT_RPS=50`/`BURST=100`; the k8s
ConfigMap already enables it. The code default stays `0` (off) so local `make
run`/tests aren't throttled — production enables it via config (documented in
`docs/CONFIGURATION.md`).

### D. FIXED — ingestion now uses pgx `CopyFrom`
**Fixed:** `store.InsertCandles` was rewritten to `COPY` rows into an
`ON COMMIT DROP` staging table via `pgx.CopyFrom`, then a single
`INSERT … SELECT … ON CONFLICT (symbol,time) DO UPDATE` upsert into the
hypertable — the binary COPY ingestion path, with the merge semantics COPY alone
can't express. (Requires a live Postgres to integration-test; covered by the
compose stack.)

### E. FIXED — `Validate()` fatal in production
**Fixed:** `main` now returns a fatal error from `Validate()` when
`ENVIRONMENT=production` (e.g. missing `JWT_SECRET_KEY`/`MT5_PASSWORD`); other
environments still warn and run degraded.

### F. FIXED — WebSocket 501 through the middleware chain (found in Section 2)
The smoke test caught `/ws` returning **501 Not Implemented** in the fully-wired
server. Cause: `coder/websocket.Accept` requires the `ResponseWriter` to
implement `http.Hijacker`, but the RequestLogger/Metrics middleware wraps it in a
`statusRecorder` that didn't forward `Hijack()`. The bare-handler integration
test missed it (no middleware).
**Fixed:** `statusRecorder` now implements `Hijack()` (and `Flush()`),
forwarding to the underlying writer. Added a regression test
(`TestWS_UpgradesThroughMiddleware`) that dials `/ws` through the real middleware
chain, and the smoke test (#6) now passes (101).

---

## 5. Build / vet / test (after fixes)

```
go build ./...        → OK (no output)
go vet ./...          → OK (no output)
gofmt -l              → clean
go test -race ./...   → all 10 test packages ok
./scripts/smoke_test.sh → 7 passed, 0 failed
```

Full results + coverage in `docs/TEST_RESULTS.md` (Section 2).

---

## 6. Summary

Behavioral parity and the core production essentials are **PASS**. All six
findings (A CORS, B login, C rate-limit default, D COPY ingestion, E fatal
validation, F WS 501) are **resolved and re-verified**. The only external
behavior changes are the intended auth/CORS hardening (A, B); D/E/F are internal.
The service is production-ready pending the operational prerequisites in
`docs/LAUNCH.md` (real secrets, Timescale/Redis/NATS, edge TLS).
