# TradePlatform gateway — Architecture Proposal (Phase 2)

**Status:** Proposal for review. **No Go code is written until this document is approved.**

**Decisions locked with the product owner (drive this design):**
1. Proceed directly to Phase 2 (this doc).
2. **Datastore → PostgreSQL + TimescaleDB** (replace SQL Server; migrate price-history schema + procs).
3. **Security posture → "Preserve API, harden defaults"** — identical routes/payloads/status codes, but secure defaults ON (JWT required on `/ws`, CORS allowlist, Hangfire-equivalent dashboard authenticated, JWT issuer/audience validated). Where a hardened default could break an existing client, it is gated by config so parity can be restored per-deployment.
4. **Scale target → full 1M-user architecture** (Kubernetes + NATS JetStream + Redis Cluster + Timescale/Postgres, multi-replica, symbol-fan-out for realtime).

> **Prime directive (unchanged from ANALYSIS.md):** external behavior — routes, request/response payloads (incl. exact JSON field casing), status codes, JWT semantics, and the `/ws` wire contract — stays **byte-for-byte identical** to the live .NET service. Every change below is either (a) internal/non-observable, or (b) additive (new endpoints/headers that don't collide), or (c) a hardened default explicitly gated by config. Each change in §9 carries an explicit compatibility guarantee.

---

## 1. Design Goals & Constraints

| Goal | Source | Implication |
|---|---|---|
| Drop-in client compatibility | Hard requirement | Same router paths, same DTO JSON, same 200/400/401/500, same `/ws` query-string contract |
| Scale to ~1M users / tens-of-thousands concurrent WS | New-arch spec | Decouple per-connection polling; stateless API pods; symbol-level fan-out; horizontal scale |
| Preserve the MT5 session model | ANALYSIS §7 | MT5 auth is bound to a keep-alive connection+cookie; must keep a warm, ping-maintained, auto-reauth session — now as a **pool**, not a single pinned socket |
| Harden security by default | Decision #3 | Close the defects from ANALYSIS §13 with config escape hatches |
| Idiomatic, testable Go | Hard requirement | Interfaces at boundaries, context everywhere, no global mutable state, table-driven tests, golden-file parity tests |
| Operability | New-arch spec | Structured logs, Prometheus metrics, OTel traces, health/readiness, graceful shutdown, configurable timeouts |

**Non-goals for the first implementation (documented, deferred):** the native MT5 *binary TCP* protocol (DEAD in source — not reproduced); SignalR (DEAD); multi-region active-active and the AI/ML feature store (designed-for in seams, but built later). These are called out in §11 (roadmap).

---

## 2. Topology (1M-target)

```
                         ┌────────────────────────── Edge ──────────────────────────┐
   clients ──TLS──▶ Cloudflare/DNS ─▶ Envoy / Ingress (TLS1.3, JWT pre-check,        │
   (web, TV UI,                       rate-limit, circuit-break, WS sticky or hubless)│
    ClientWS)                         └───────────────┬───────────────────────────────┘
                                                      │
                 ┌────────────────────────────────────┼─────────────────────────────────────┐
                 ▼                                     ▼                                      ▼
        ┌─────────────────┐                  ┌──────────────────┐                  ┌──────────────────┐
        │  api-gateway     │  (stateless,    │  ws-hub          │ (stateless,      │ market-poller    │ (sharded by
        │  REST handlers   │   HPA 3–20)     │  /ws fan-out     │  HPA on conns)   │  per-symbol poll │  symbol; HPA on
        └───────┬─────────┘                  └────────┬─────────┘                  └────────┬─────────┘  symbol count)
                │  domain services                    │ subscribe                            │ publish
                │                                     ▼                                      ▼
                │                              ┌────────────────────────── NATS JetStream ──────────────────────────┐
                │                              │  market.tick.{symbol}  market.depth.{symbol}  account.*.{login} ... │
                │                              └────────────────────────────────────────────────────────────────────┘
                ▼
        ┌──────────────────────────────── mt5-session-manager ────────────────────────────────┐
        │  StatefulSet, leader+hot-standby; owns the authenticated MT5 connection POOL          │
        │  (keep-alive + cookie per conn, 20s ping, re-auth on failure) — single egress to MT5  │
        └───────────────┬───────────────────────────────────────────────────────────────────────┘
                         │ HTTPS (pinned keep-alive conns)
                         ▼
                 MT5 Manager Web API  (mt5.example.com:443)

   Shared state:  Redis Cluster (WS session registry, hot tick cache, JWT revocation, dist. rate-limit, dist. locks)
                  PostgreSQL 16 (trading_ops/audit)  +  TimescaleDB (OHLC hypertables)
                  jobs: river (Postgres-backed) — daily price-history fetch + aggregate (replaces Hangfire)
```

**Deployment unit for v1 ("modular monolith, cluster-ready"):** a single Go binary that can run **all roles** (`api`, `ws-hub`, `poller`, `mt5-session`, `jobs`) selected by a `--role`/`ROLES` env, so day-1 it deploys as one Deployment and scales out by splitting roles into separate Deployments **without code changes**. This is the pragmatic path to the 1M target: same codebase, role-gated wiring, true horizontal scale when needed.

> **Why a dedicated `mt5-session-manager` role:** the MT5 manager session is the one genuinely stateful, hard-to-shard resource (ANALYSIS §7.3). Concentrating all MT5 egress behind a small, leader-elected service (1 active + standby) keeps the connection pool bounded and the broker's source-IP allowlist stable (recall the 403 IP-whitelist issue). API/ws/poller pods reach it via internal gRPC. For v1 single-binary mode it's an in-process module; at scale it's its own StatefulSet.

---

## 3. Package / Module Layout

Standard Go layout; `internal/` for everything not meant to be imported externally. Interfaces defined at the **consumer** boundary.

```
backend/
├── cmd/
│   └── gateway/main.go            # entrypoint: load config, wire DI, select roles, run, graceful shutdown
├── internal/
│   ├── config/                    # env→typed config, validation, defaults (mirrors MT5Config etc.)
│   ├── httpapi/
│   │   ├── router.go              # chi router; mounts the EXACT .NET routes (api/Order/... etc.)
│   │   ├── middleware/            # jwt, accounts-authorize, requestlog, recover, cors, ratelimit, metrics
│   │   ├── handlers/              # one file per controller: order.go, position.go, tick.go, ... tvorder.go, auth.go
│   │   └── response/              # GlobalResponse envelope + Ok/BadRequest helpers (exact shape & status codes)
│   ├── auth/
│   │   ├── jwt.go                 # HS256 issue/validate, claims (accounts/name) — parity-exact
│   │   └── crm.go                 # TradePlatform CRM login + account discovery
│   ├── mt5/
│   │   ├── session.go             # SessionManager: pool of authenticated conns, ping, re-auth, failure tracking
│   │   ├── client.go              # low-level HTTP caller (pinned keep-alive transport, cookie jar, retry)
│   │   ├── handshake.go           # /api/auth/start + /api/auth/answer, MD5 challenge (ProcessAuth)
│   │   └── apiurl.go              # the canonical upstream path templates (ANALYSIS §7.5), verbatim
│   ├── domain/                    # one service per MT5 domain; pure orchestration over mt5.Client
│   │   ├── order.go position.go deal.go history.go symbol.go tick.go trade.go user.go login.go
│   │   └── ports.go               # interfaces (OrderService, TickService, ...) for handlers & ws to depend on
│   ├── transform/                 # MT5→TV mappings (ANALYSIS §7.6, §11) — pure funcs, exhaustively unit-tested
│   │   ├── order.go position.go symbol.go tick.go user.go trade.go enums.go session_converter.go
│   ├── realtime/
│   │   ├── ws/                     # /ws server: accept, parse query, dispatch (TP/methodtype), backpressure
│   │   ├── hub.go                  # per-symbol fan-out; subscribes NATS, pushes to client conns
│   │   ├── poller.go               # market-data poller: one loop per symbol → publish to NATS
│   │   └── bus.go                  # NATS JetStream publish/subscribe wrapper (+ in-proc fallback bus)
│   ├── store/
│   │   ├── postgres/               # pgxpool, trading_ops + audit queries (sqlc-generated)
│   │   ├── timescale/              # OHLC hypertable read/write, bulk COPY, daily aggregate
│   │   └── migrations/             # goose SQL migrations (schema + continuous aggregates)
│   ├── jobs/
│   │   └── pricehistory.go         # river worker(s): FetchAndSave + FetchAndAggregate (daily) + 7d prune
│   ├── cache/
│   │   ├── redis.go                # go-redis cluster client; tick cache, sessions, revocation, locks
│   │   └── memory.go               # in-proc cache (SymbolService parity) behind same interface
│   ├── resilience/                 # circuit breaker, retry, timeout helpers (used by mt5.Client)
│   └── observability/
│       ├── logging.go              # slog setup (JSON), request logging
│       ├── metrics.go              # Prometheus collectors
│       ├── tracing.go              # OpenTelemetry tracer
│       └── health.go               # /healthz, /readyz, /metrics handlers
├── api/openapi.yaml                # generated/maintained OpenAPI (parity record)
├── migrations/                     # (symlink/colocated with store/migrations)
├── deploy/
│   ├── docker/Dockerfile           # multi-stage, distroless static binary
│   ├── compose/docker-compose.yml  # local: gateway + postgres/timescale + redis + nats
│   └── k8s/                        # Helm chart / manifests: Deployments per role, HPA, StatefulSet, Services
├── test/
│   ├── golden/                     # captured .NET responses for byte-parity assertions
│   └── e2e/                        # smoke + contract tests (mirror testing/ postman + smoke-test.sh)
├── Makefile
├── .env.example
├── go.mod
└── docs/ (ANALYSIS.md, ARCHITECTURE.md)
```

**Dependency direction:** `handlers → domain (ports) → mt5.Client / store / cache`. `transform` is leaf-pure. `realtime` depends on `domain` ports + `bus`. Nothing depends on `httpapi`. No package-level mutable globals; all state lives in structs constructed in `main` and injected.

---

## 4. Library Choices (minimal, well-maintained, stdlib-first)

| Concern | Choice | Why / alternative rejected |
|---|---|---|
| HTTP router | **`go-chi/chi`** | Tiny, `net/http`-native, composable middleware, exact route control. (Gin/Echo: heavier, own context types; stdlib 1.22 mux: weaker middleware ergonomics for this many routes.) |
| WebSocket | **`coder/websocket`** (formerly nhooyr) | Context-native, simple, good backpressure; minimal API. (gorilla/websocket: battle-tested fallback — kept as an option behind our `ws` interface.) |
| HTTP client to MT5 | **stdlib `net/http`** with custom `Transport` | We need precise control of connection pinning, cookie jar, keep-alive — exactly what `Transport` + `cookiejar` give. No third-party client. |
| Config | **`caarlos0/env`** + `joho/godotenv` (local only) | Struct-tag env binding; supports the `MT5Config__x` double-underscore style via mapping. Minimal. (Viper: too large for our needs.) |
| Logging | **stdlib `log/slog`** (JSON handler) | Structured, zero-dep, replaces Serilog cleanly. Compact JSON to stdout (container-native) + optional file. |
| JWT | **`golang-jwt/jwt/v5`** | De-facto standard; HS256 to match exactly. |
| Postgres/Timescale | **`jackc/pgx/v5`** (+ `pgxpool`) | Fastest, most correct PG driver; `CopyFrom` for bulk insert. |
| Typed queries | **`sqlc`** | Compile-time-checked SQL from `.sql` files; no runtime ORM. (No GORM — keeps SQL explicit and fast.) |
| Migrations | **`pressly/goose`** | Simple SQL migrations incl. Timescale hypertable/continuous-aggregate DDL. |
| Jobs/scheduler | **`riverqueue/river`** | Postgres-backed durable jobs + cron; replaces Hangfire, reuses our PG, gives a queryable job history + a (authenticated) UI. (asynq: needs Redis as source of truth — we prefer PG for durability.) |
| Cache / shared state | **`redis/go-redis/v9`** | Cluster client for tick cache, WS session registry, JWT revocation, distributed rate-limit + locks. |
| Messaging | **`nats-io/nats.go`** (JetStream) | Tick/account fan-out hot path; low latency, subject wildcards per symbol/login. In-proc fallback bus for single-binary mode. |
| Rate limiting | **`go-redis/redis_rate`** (distributed) + `golang.org/x/time/rate` (local) | Per-IP/token limits across replicas; local limiter for in-proc. |
| Circuit breaker | **`sony/gobreaker`** | Wrap MT5 egress; trip on sustained upstream failure (complements the re-auth logic). |
| Validation | **`go-playground/validator/v10`** | Struct-tag request validation (additive; rejects with the same 400 envelope). |
| Metrics | **`prometheus/client_golang`** | `/metrics`. |
| Tracing | **`go.opentelemetry.io/otel`** | OTLP traces; sampled. |
| Tests | stdlib `testing` + **`stretchr/testify`** (asserts) + golden files | Table-driven; parity via golden JSON. |

Total third-party surface is small and all are widely-used, actively-maintained libraries.

---

## 5. Concurrency Model

**5.1 MT5 session pool (the crux).** The .NET service pins *all* traffic to one socket (`MaxConnectionsPerServer=1`). That is a correctness device (auth is per-connection) and a throughput ceiling. Design:

- `mt5.SessionManager` owns a **bounded pool of `N` authenticated connections** (`N=1` by default for exact parity; configurable). Each `conn` = a dedicated `http.Client` with its own single-connection `Transport` + `cookiejar`, independently handshaken and ping-maintained (20s) with auto re-auth and the 3-consecutive-failure trip (ANALYSIS §7.2), guarded per-conn by a mutex; the manager hands out conns via a buffered channel (semaphore) with context-aware acquire.
- Rationale: if the broker permits multiple concurrent manager sessions, `N>1` lifts the single-socket bottleneck linearly; if it permits only one, `N=1` reproduces today's behavior exactly. **Assumption flagged:** broker concurrency limit unknown → default `N=1`, document, allow ops to raise after testing. Observable behavior is identical at `N=1`.
- All MT5 egress flows through this one component (one egress IP set → keeps the broker allowlist stable).

**5.2 Realtime fan-out (replaces per-connection 3s polling).**
- **Broadcast data (ticks, market depth — same for all clients of a symbol):** `poller` runs **one goroutine per subscribed symbol**, polls MT5 at the configured cadence (default 3s to match), writes the latest value to Redis (hot cache, short TTL) and publishes to NATS `market.tick.{symbol}` / `market.depth.{symbol}`. `ws-hub` pods keep a registry of which local connections want which symbol; on each NATS message they push to those connections. Net effect for the client: **identical JSON, same ~3s cadence**, but MT5 is polled **once per symbol** instead of once per (connection×symbol) — collapsing O(clients×symbols) to O(symbols).
- **Per-login data (positions, user, orders — vary per client):** kept as a polling loop **per connection**, but executed through a bounded worker pool with a short Redis cache (de-dupes identical concurrent requests) and the MT5 session pool. Cadence and shape unchanged.
- **Subscription lifecycle:** symbols are reference-counted across the hub; the poller starts a symbol loop on first subscriber, stops it after the last unsubscribes (with a small linger).

**5.3 Per-connection WebSocket handling & backpressure.**
- Each accepted `/ws` connection runs a reader goroutine (detect Close) + a writer goroutine fed by a **bounded buffered channel**. If the client is slow and the buffer fills, policy = drop-oldest (for tick streams, latest-wins is correct) and emit a metric; repeated overflow → close with a status. This is the "backpressure on WS" the spec requires; the .NET version had none.
- `coder/websocket` write is context-bound with a per-write timeout (configurable).

**5.4 Context & graceful shutdown.** `context.Context` threads from request/connection down to MT5 calls and DB queries (every external call has a timeout from config). `main` installs a signal handler → cancels a root context → stops accepting, drains in-flight requests, closes WS connections with a going-away code, flushes jobs, closes pools, within a shutdown deadline. A `sync.WaitGroup`/`errgroup` tracks role goroutines.

**5.5 Bounded goroutines.** No unbounded `go func()` per request for upstream work: worker pools (sized from config) cap concurrency to MT5 and DB; the WS hub uses one goroutine per connection (cheap, ~few KB) plus one per active symbol — bounded by symbol count, not client count.

---

## 6. Preserving Exact External Compatibility

**6.1 Routes.** `httpapi/router.go` registers the production paths from ANALYSIS §3 with the same verbs where their contracts are safe and non-duplicative. `[Authorize]`/`[AccountsAuthorize]` map to middleware per route. The hardcoded-account `tv/TVOrder` duplicate controller, duplicate Test aliases, and localhost Deal WebSocket demo are deliberately not registered. `GET /` serves a landing page and Swagger UI is available from the embedded OpenAPI; dead controllers are **not** registered.

**6.2 Payloads & casing.** DTO structs carry explicit `json:"..."` tags reproducing the (inconsistent) .NET casing verbatim — `retcode`, `priceOrder` vs `PriceOrder`, `timeCreate`, `Token`, lowercase TV fields (ANALYSIS §11). We use Go's `encoding/json` with struct tags; where Newtonsoft emitted specific null/casing behavior, golden tests pin it. `source=mt5` passes the upstream JSON through **unmodified** (we forward the raw bytes in `data`, not a re-marshaled object, to guarantee byte-identity); `source=tv` runs the `transform` funcs.

**6.3 Status codes.** `response.Ok(data)`→200, `response.Bad(resp)`→400 (on `success=false`), auth→401, Test endpoints→500-on-error. A single helper enforces the success→200/failure→400 rule so it can't drift.

**6.4 `/ws` contract.** Same URL `/ws`, same query params, same `TP`(1–4)+`methodtype` dispatch table (ANALYSIS §6.1), same serialized-`data` text frames, same ~3s cadence, the `from==0 && to==1` live-window trick preserved in `transform`/tick logic. (Hardened default: JWT now required pre-accept — see §9/Compat note, gated by `WS_REQUIRE_AUTH`, default ON per decision #3, can be set OFF for exact legacy parity.)

**6.5 Parity test harness.** `test/golden/` stores real captured responses from the running .NET service (via the existing `testing/LegacyMTSocket.postman_collection.json` + `smoke-test.sh`). A Go test replays each request against a mocked MT5 upstream (recorded fixtures) and asserts the Go output equals the golden bytes (modulo volatile fields like timestamps, which are asserted structurally). This is the objective gate for "behavior identical."

---

## 7. Data Layer (PostgreSQL + TimescaleDB)

**7.1 Mapping from SQL Server (ANALYSIS §10).**

| .NET (SQL Server) | Go (Postgres/Timescale) |
|---|---|
| `Symbolwisepricehistorydata` (PK id) | **Timescale hypertable** `price_history(symbol text, time bigint, open/high/low/close/volume double precision)`, partitioned on `time`; unique `(symbol, time)` |
| `Symboldailydata` (PK id) | hypertable or table `daily_data(symbol, ts bigint, open/high/low/close)`; can be a **continuous aggregate** over `price_history` |
| `Logs` (LogHistory) | `logs(...)` in `trading_ops` (or shipped to Loki) |
| SP `InsertSymbolHistoryData` (MERGE) | `INSERT ... ON CONFLICT (symbol,time) DO UPDATE` via pgx; batched with `CopyFrom` for bulk |
| SP `AggregateDailyDataNew` (MERGE + STRING_SPLIT) | SQL `INSERT ... SELECT ... GROUP BY ON CONFLICT`, or a Timescale **continuous aggregate** refreshed daily |
| SP `GetLatestSymbolwisePriceHistoryData` (dead) | not ported |
| 7-day prune (`DeleteOldRecords`) | Timescale **retention policy** (`add_retention_policy`) or scheduled `DELETE` |

**7.2 Client-facing impact (critical to preserve).** Price-history rows feed two client-visible paths: `GET /api/Tick/getHistoryby1Dresolution` (D/W/M roll-ups) and any call with `ReadDataFromDbOrAPI=true`. The Go queries must return the **same bucketing and ordering** (Open=first, Close=last, High=max, Low=min; daily timestamp at 00:00 UTC seconds). Golden tests cover these specifically. Default `ReadDataFromDbOrAPI=false` keeps live-API behavior, so for v1 the DB primarily backs the job + 1D endpoint — limiting risk.

**7.3 Connections.** `pgxpool` sized from config; statements via sqlc. Two logical databases/schemas: `market` (Timescale, OHLC) and `trading_ops` (audit/logs/jobs). River uses its own tables in `trading_ops`.

**7.4 Migration of existing data.** A one-shot migration job copies existing `TradePlatform` price-history into Timescale (out of scope for code parity, planned as an ops runbook). Until cut-over, an optional dual-write/read-through can be enabled.

---

## 8. Background Jobs (river replaces Hangfire)

- `jobs/pricehistory.go` registers two river workers mirroring ANALYSIS §10:
  - **`fetch-price-history`** — cron `@daily`: get symbol list from MT5 (`/api/symbol/list`, fallback `DefaultSymbolList`), per symbol fetch `/api/chart/get`, bulk-upsert to Timescale, apply 7-day retention.
  - **`aggregate-daily`** — chained after fetch (river job dependency / `InsertTx`): aggregate intraday → `daily_data`.
- One-shot-on-startup behavior (the `BackgroundJob.Enqueue` + `ContinueJobWith`) is reproduced by enqueuing both jobs at boot **once across the cluster** (guarded by a Redis/PG advisory lock so N replicas don't double-fire — fixing the .NET double-fire bug; observable result: the data is the same, just not duplicated).
- River's job state lives in Postgres → durable, retryable, observable; its dashboard is mounted behind auth (the hardened equivalent of the open `/hangfire`).

---

## 9. Changes vs. .NET — each with rationale + compatibility guarantee

| # | Change | Rationale | Compatibility guarantee |
|---|---|---|---|
| 1 | Remove DEAD code (native TCP MT5 stack, SignalR hub, NewAuthenticateService, dead middleware/services, dup `/ws` block, excluded controllers) | They never run; carrying them adds risk/confusion | None of it is reachable today → zero observable change |
| 2 | `/ws` realtime: per-connection polling → **per-symbol poll + NATS fan-out** | Collapses MT5 load O(clients×symbols)→O(symbols); enables 1M scale | Client still connects to `/ws` with same query string, receives same JSON frames at same ~3s cadence; cadence is config (default 3s) |
| 3 | Single pinned MT5 socket → **bounded session pool** (`N`, default 1) | Lifts throughput ceiling while keeping per-conn auth semantics | At `N=1`, identical to today; `N>1` only changes internal parallelism, not responses |
| 4 | SQL Server → **Postgres/Timescale**, row-by-row → **bulk COPY**, SP MERGE → `ON CONFLICT`/continuous aggregate | Decision #2; far better ingest + compression at scale | Client-facing query results (1D resolution, tick history) pinned by golden tests to identical shape/bucketing |
| 5 | Hangfire → **river**; double-fire on boot fixed via distributed lock | Reuse PG, durable/observable jobs; correctness | Resulting price data identical (just not duplicated); no client-facing endpoint changes |
| 6 | **Harden security defaults** (decision #3): JWT required on `/ws`; CORS allowlist; dashboard authenticated; JWT `ValidateIssuer/Audience=true`; TLS1.2+ to MT5; no-password login disabled | Close ANALYSIS §13 defects | **Each gated by config** (`WS_REQUIRE_AUTH`, `CORS_ALLOWED_ORIGINS`, `JWT_VALIDATE_ISSUER`, …). The no-password login path is removed outright (not gated). Defaults ON (secure); setting them to legacy values reproduces exact old behavior for clients that need it. Routes/payloads unchanged either way |
| 7 | Add **rate limiting, circuit breaker, explicit timeouts** on MT5 egress | Resilience; spec requirement | Additive; under normal load no observable change. Throttled/over-limit responses use the same `GlobalResponse` envelope + standard status (429 only when limit configured) |
| 8 | Add **`/healthz`, `/readyz`, `/metrics`**, OTel traces, structured slog | Operability; spec requirement | New paths that don't collide with existing surface; no change to existing endpoints |
| 9 | Secrets via **env/secret store**, none in code/logs; redaction in logger | Security; spec requirement | No client-facing change; same config values, different source |
| 10 | `source=mt5` forwards **raw upstream bytes** in `data` | Guarantees byte-identity (no re-marshal drift) | Strictly improves fidelity vs re-serializing |
| 11 | Quirks preserved deliberately: `history/delete?ticket=tickets`, `(UTCUnix+3h)*1000`, `Token` casing, success→200/fail→400 | Parity | Reproduced verbatim; a corrected `history/delete` is available **only** behind an opt-in flag (default = buggy/legacy) |

---

## 10. Performance, Memory, Maintainability

- **Memory/concurrency:** goroutine-per-connection (~few KB) replaces thread/scope-per-3s-tick; no per-tick DI scope allocation (the .NET GC-pressure issue). Bounded pools cap peak concurrency.
- **MT5 load:** fan-out makes broker request volume independent of client count for market data — the single biggest scalability win.
- **Ingest:** `CopyFrom` bulk insert + Timescale compression replaces per-candle `EXEC` round-trips.
- **Latency:** Redis hot-cache for ticks lets WS pushes serve from cache between polls; circuit breaker fails fast instead of 100s hangs.
- **Maintainability:** `Program.cs` god file → small wired packages; pure `transform` funcs are exhaustively table-tested; sqlc gives compile-checked SQL; interfaces at boundaries make MT5/store/cache mockable; golden-file parity tests prevent contract drift. Single static binary (distroless), <50ms start, trivial container.
- **Config:** every timeout, pool size, cadence, and security toggle is configurable with safe defaults.

---

## 11. Phasing (build order maps to Phase 3)

1. **Scaffold:** `go.mod`, config, logging, health, router skeleton, Docker/compose, Makefile, `.env.example`. *(review gate)*
2. **Core:** `mt5` session/client/handshake, `auth` (JWT+CRM), middleware, `response` envelope.
3. **REST:** domain services + handlers + `transform`, wired to MT5; golden parity tests green.
4. **Realtime:** `/ws` server, hub, poller, NATS bus (in-proc fallback first, then JetStream).
5. **Data + jobs:** Timescale/Postgres store, sqlc queries, goose migrations, river price-history jobs.
6. **Hardening/ops:** rate limit, circuit breaker, metrics/traces, Redis cluster, secrets.
7. **Deploy:** Dockerfile, compose, k8s/Helm (per-role Deployments, HPA, StatefulSet), README + run instructions.

Single-binary all-roles mode is usable from step 4; role-split for the 1M target lands in step 7. Multi-region and AI/ML feature store are seams now, future work later.

---

## 12. Open Questions for Approval

1. **MT5 manager concurrency:** may we open `N>1` concurrent authenticated manager sessions to `mt5.example.com` (broker-side limit?), or must we keep `N=1` and scale only the fan-out? (Default `N=1` until confirmed.)
2. **Legacy parity switches:** confirm the hardened defaults in §9/#6 are acceptable as **defaults ON** (clients may need the no-password login or unauthenticated `/ws` during transition — those remain available via config). Any client we must not break?
3. **Timescale cut-over:** is migrating existing `TradePlatform` price history required for v1, or can v1 start fresh and backfill later?
4. **WS cadence:** keep the exact 3s push, or is a faster/configurable cadence (e.g. on-tick push from NATS) acceptable as long as the message shape is unchanged?

---

**End of Phase 2 proposal. Per the agreed process, I will NOT write any Go code until you approve this architecture (and the open questions in §12).** Reply with approval, or with changes you want folded in first.
