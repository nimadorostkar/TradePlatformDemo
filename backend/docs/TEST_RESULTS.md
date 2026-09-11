# Test Results (Section 2)

Real output from the commands below, run at finalization. Reproduce with:

```bash
go build ./... && go vet ./... && gofmt -l ./internal/ ./cmd/
go test -race -cover ./...
./scripts/smoke_test.sh        # against a running instance
```

## Build / vet / format

```
go build ./...   → OK (no output)
go vet ./...     → OK (no output)
gofmt -l         → clean (no files listed)
```

## Unit + integration tests (`go test -race -cover ./...`)

All 10 test packages PASS under the race detector.

| Package | Coverage | What it covers |
|---|---:|---|
| `internal/transform` | **98.7%** | All MT5→TV mappings, converters, bucketing, every transform fn |
| `internal/cache` | **90.0%** | Redis token-bucket limiter (miniredis), fail-open |
| `internal/httpapi/response` | **83.3%** | Envelope shape + status convention |
| `internal/realtime` | **80.6%** | Hub fan-out/replay/cleanup, dispatch, WS handler (incl. through-middleware regression), in-proc bus, distributed hub↔poller, leader gate |
| `internal/httpapi/middleware` | **64.2%** | JWTAuth (401 cases), AccountsAuthorize (401/403, query+body), CORS fail-closed, rate-limit + exempt paths |
| `internal/jobs` | **52.4%** | Live-vs-fallback symbol list, lock-skip |
| `internal/auth` | **50.0%** | JWT round-trips (user/accounts), wrong secret, alg=none reject, MD5 handshake vector |
| `internal/mt5` | **20.3%** | Auth handshake vector, circuit breaker (business vs transport vs open) |
| `internal/httpapi/handlers` | **16.8%** | Golden parity suite (7 endpoints, 3 data-shape classes), hardened login |
| `internal/domain` | **12.9%** | Order/Tick DB-path + envelope-shape parity (representative) |

**Coverage notes (honest):**
- `domain` (12.9%) and `handlers` (16.8%) have many near-identical endpoint
  methods (raw-string passthrough). The **golden suite** exercises the
  data-shape logic across representative endpoints of each class; the long tail
  of passthrough handlers is low-risk boilerplate. `mt5` (20.3%) covers the
  crypto/breaker logic; the socket/session networking needs a live broker.
- `internal/store/timescale` shows **0.0%** — its queries require a live
  PostgreSQL/Timescale and are exercised by the compose stack / smoke, not unit
  tests. `config`, `httpapi` (router), `observability`, and `cmd/gateway` are
  wiring/glue with no dedicated unit tests.

## Smoke test (`scripts/smoke_test.sh`)

Run against a local instance backed by a demo market server:

```
== 1. Liveness /healthz ==               PASS: /healthz
== 2. Readiness /readyz ==               PASS: /readyz ready
== 3. Metrics /metrics ==                PASS: /metrics
== 4. Obtain JWT ==                      PASS: token acquired (len 297)
== 5. Authenticated REST call ==         PASS: authed REST 200
                                         PASS: unauthed REST -> 401 (auth enforced)
== 6. WebSocket /ws connect ==           PASS: /ws upgraded (101)

== Result: 7 passed, 0 failed ==   (exit 0)
```

> The WS check (#6) is the regression guard for the 501 hijack bug fixed in
> Section 1 (finding F) — it now upgrades to HTTP 101 through the full middleware
> chain.

## Test inventory (key cases added/rounded out in Section 2)

- `auth`: token round-trips, wrong-secret reject, `alg=none` reject, MD5 vector.
- `middleware`: `TestJWTAuth`, `TestAccountsAuthorize` (query + body + 401/403),
  `TestCORS_FailClosed`, `TestRateLimit_InProc` (+ health exempt).
- `handlers`: `TestGolden` (byte-parity), `TestLogin_HardenedDisablesUnvalidatedPath`,
  `TestLogin_LegacyModeIssuesToken`.
- `transform`: mapping tables, orders V1/V2, positions page/ws/single, user,
  account, modify, chart, placed-order (+3h ms), symbol by-name/mask/group,
  bucket starts.
- `realtime`: hub fan-out/replay/cleanup, dispatch, WS auth + stream,
  through-middleware upgrade (501 regression), in-proc bus, hub↔poller
  end-to-end, leader gate.
- `cache`: Redis token bucket (burst/deny, per-IP, fail-open).
- `jobs`: symbol-list fallback, lock-skip.
- `mt5`: breaker business/transport/open.
