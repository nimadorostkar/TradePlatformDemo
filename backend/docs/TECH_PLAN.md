# Technical Plan

A concise engineering overview. Deep detail lives in
[`ANALYSIS.md`](ANALYSIS.md) (the .NET behavior this reproduces),
[`ARCHITECTURE.md`](ARCHITECTURE.md) (the full design rationale), and
[`PARITY-NOTES.md`](PARITY-NOTES.md) (deliberate deviations).

## What it is

A Go reimplementation of the .NET 8 **LegacyMTSocket** gateway: it sits between
client apps (web, TradingView UI, console) and the **MT5 Manager Web API**,
exposing it as REST + a `/ws` stream. **Prime directive:** external behavior
(routes, payloads incl. exact JSON casing, status codes, WS contract) is
identical to the .NET service; only auth/CORS posture is hardened.

## Architecture

```
client ─[JWT]─▶ api (REST) ─▶ domain service ─▶ mt5 circuit-breaker ─▶ mt5.SessionManager
                                                   (pooled keep-alive conn + cookie,        ─▶ MT5 Web API
                                                    20s ping, auto re-auth)
client ─[JWT]─▶ /ws ─▶ hub ── per-symbol poll ──▶ (same services)        ← single node
                          └── NATS bus ◀── leader poller ◀── (same services)  ← cluster (NATS_URL set)
data: PostgreSQL (trading_ops) + TimescaleDB (OHLC)   jobs: cron + advisory lock
state: Redis (distributed rate limit)
```

One **role-gated binary** (`ROLES=api,ws,poller,mt5,jobs`) runs everything on a
node and splits per-role for scale with no code change.

## Package layout (`internal/`)

| Package | Responsibility |
|---|---|
| `config` | typed env config + production-fatal validation |
| `auth` | JWT (HS256) issue/validate; CRM login + account discovery |
| `mt5` | upstream paths, MD5/UTF-16LE handshake, pooled keep-alive client, circuit breaker |
| `domain` | one service per MT5 domain; envelope + per-endpoint data-shape logic; `MT5Client`/`PriceStore` interfaces |
| `transform` | MT5→TradingView models + mappings + converters (98.7% tested) |
| `httpapi/{response,middleware,handlers}` | envelope, middleware (auth, accounts, CORS, rate-limit, metrics, recover, log), handlers + chi routing |
| `realtime` | `/ws` server, shared-topic hub, demand-driven poller, Bus (in-proc + NATS) |
| `store/timescale` | pgx store: hypertable, COPY ingest, aggregation, advisory lock |
| `jobs` | price-history fetch+aggregate, cron scheduler (lock-guarded) |
| `cache` | Redis client + distributed token-bucket limiter |
| `observability` | slog logging, health/readiness, Prometheus metrics |
| `cmd/gateway` | wiring + lifecycle |

## Library choices (stdlib-first, minimal)

| Concern | Choice | Why |
|---|---|---|
| Router | `go-chi/chi` | tiny, `net/http`-native, exact route control |
| WebSocket | `coder/websocket` | context-native, simple, backpressure |
| HTTP client (MT5) | stdlib `net/http` | precise control of conn pinning + cookie jar |
| Config | `caarlos0/env` | struct-tag env binding |
| Logging | stdlib `log/slog` | structured, zero-dep |
| JWT | `golang-jwt/jwt/v5` | standard; HS256 parity |
| DB | `jackc/pgx/v5` | fastest PG driver; `CopyFrom` bulk |
| Jobs | `robfig/cron/v3` | simple cron; PG advisory lock for dedup |
| Cache/limit | `redis/go-redis/v9` | distributed limiter |
| Messaging | `nats-io/nats.go` | low-latency cross-pod fan-out |
| Breaker | `sony/gobreaker` | wrap MT5 egress |
| Metrics | `prometheus/client_golang` | `/metrics` |
| Tests | stdlib + `testify` + `miniredis` + golden files | |

## Concurrency model

- **MT5 session pool** — N authenticated connections (default 1 = parity), each a
  pinned keep-alive `http.Client` + cookie jar, with a per-conn ping/re-auth
  loop; handed out via a buffered-channel semaphore (acquire bounds upstream
  concurrency).
- **WS** — goroutine per connection (reader detects close; bounded writer queue
  with latest-wins drop = backpressure); one poll loop per **active subscription**
  (not per connection). Cross-pod: hub publishes demand, a single leader poller
  polls per subscription and publishes to the bus.
- **Context everywhere** — request/connection contexts thread to upstream/DB
  calls with configurable timeouts; SIGINT/SIGTERM cancels a root context →
  graceful drain.
- **No global mutable state** — everything constructed in `main` and injected;
  interfaces at boundaries (`MT5Client`, `PriceStore`, `Bus`, `Limiter`).

## Scaling to ~1M users

- **Stateless api/ws pods** behind an HPA (CPU/RPS; `ws_active_connections` via
  prometheus-adapter).
- **MT5 load** is decoupled from client count: the hub collapses per-connection
  polling to per-subscription, and with NATS a single leader poller does one poll
  per subscription cluster-wide → **O(symbols)**, not O(connections).
- **TimescaleDB** hypertables + COPY ingest + retention for OHLC; **Redis** for
  distributed rate limiting (and a seam for session/cache); **NATS JetStream**
  for the realtime backplane.
- **Jobs/poller** are leader-elected via Postgres advisory locks (safe on N
  replicas).

## Deviations from the .NET version

Hardened (auth/CORS only — external API unchanged): JWT required on `/ws`,
CRM-only login by default, issuer/audience validated, CORS fail-closed. Internal
improvements: TimescaleDB instead of SQL Server, circuit breaker + explicit
timeouts, Prometheus metrics, graceful shutdown, NATS fan-out. Dead .NET code
(native MT5 binary protocol, SignalR hub) is **not** reproduced. Full list and
the parity-preserving data-shape decisions: [`PARITY-NOTES.md`](PARITY-NOTES.md).
