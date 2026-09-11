# TradePlatform Gateway (backend)

A production-grade **Go** rewrite of the .NET 8 **LegacyMTSocket** gateway — the service
that sits between TradePlatform client apps (web, TradingView UI, the `ClientWS` console)
and the **MetaTrader 5 Manager Web API** (`mt5.example.com`). It exposes the MT5
API as REST endpoints, a `/ws` streaming endpoint, and is designed to scale to ~1,000,000
users.

> **Backward compatibility is the prime directive.** Routes, payloads (incl. exact JSON
> field casing), status codes, JWT semantics, and the `/ws` wire contract match the .NET
> service exactly. Clients must not need changes. See [`docs/ANALYSIS.md`](docs/ANALYSIS.md).
>
> Two deliberate departures, both because parity would have been unsafe:
> `/api/tv/TVOrder/*` is **removed** (anonymous, it could cancel any order by
> ticket, and every route duplicated a canonical account-scoped endpoint — all
> five paths now 404, with no flag to restore them), and unknown-suffix account
> types are excluded from the account selector (restorable via
> `CRM_ALLOWED_ACCOUNT_TYPES` / `CRM_ACCOUNT_TYPE_SUFFIXES`). See

backend-requirements work (13 items), the two production issues found while
deploying it, and the deployment steps.
**Volume units:** [`docs/VOLUME-UNITS.md`](docs/VOLUME-UNITS.md) — read before
building an order ticket.

## Status

| Phase | Deliverable | State |
|-------|-------------|-------|
| 1 | [`docs/ANALYSIS.md`](docs/ANALYSIS.md) — behavior reconstruction of the .NET service | ✅ done |
| 2 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Go design proposal | ✅ approved |
| 3 | Implementation | ✅ feature-complete (see below) |

Implemented:

- **MT5 session** — pooled keep-alive connection + cookie, the MD5/UTF-16LE auth
  handshake, 20s ping, re-auth on failure, behind a circuit breaker.
- **Auth** — JWT (HS256, parity claims, hardened-but-gated issuer/audience), CRM login.
- **REST** — all ~60 endpoints with exact per-endpoint data-shape parity
  (raw-string vs object vs TradingView transform); see [`docs/PARITY-NOTES.md`](docs/PARITY-NOTES.md).
- **WebSocket** — `/ws` with shared-topic fan-out, backpressure, JWT gate; and
  **cross-pod fan-out over NATS** (leader-elected poller → bus → hub) when
  `NATS_URL` is set.
- **Data** — PostgreSQL/TimescaleDB price store + the daily price-history job
  (distributed-lock guarded).
- **Ops** — Prometheus `/metrics`, per-IP **and Redis-distributed** rate limiting,
  circuit breaker, structured logging, health/readiness, graceful shutdown,
  Kubernetes manifests.

Deferred increments (seams in place): Redis symbol cache; central `mt5-session`
role over gRPC. See `docs/ARCHITECTURE.md` §11.

## Architecture at a glance

```
client → [JWT] → api-gateway → domain service → mt5.SessionManager (pooled keep-alive
        conns + cookie, 20s ping, auto re-auth) → MT5 Manager Web API
realtime: per-symbol poller → NATS fan-out → ws-hub → clients   (replaces per-conn polling)
data: PostgreSQL (trading_ops) + TimescaleDB (OHLC) · jobs: river · cache/state: Redis
```

One role-gated binary runs everything on a single node and splits into per-role
Deployments (api / ws / poller / mt5 / jobs) for horizontal scale without code changes.

## Requirements

- Go 1.25+
- Docker (for the local stack: Postgres, TimescaleDB, Redis, NATS)

## Quick start

```bash
cp .env.example .env          # then set JWT_SECRET_KEY and MT5_PASSWORD
make tidy                     # resolve dependencies
make run                      # run the gateway (defaults to :5063)

# probes
curl localhost:5063/healthz   # {"status":"alive"}
curl localhost:5063/readyz    # {"status":"ready"}

# full local stack (DB + Redis + NATS + gateway)
make compose-up
```

## Common tasks

```bash
make build        # build bin/gateway
make test         # unit tests
make check        # fmt + vet + test
make docker-build # build the container image
./scripts/smoke_test.sh   # health + authed REST + WS against a running instance
```

## Documentation

**Start here:** [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) — the complete
master document (overview, architecture + diagrams, how it works, API list,
WebSocket, optimizations, infrastructure, Docker, run/check, security). The
focused docs below go deeper.

| Doc | Contents |
|---|---|
| [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) | **master reference with diagrams** (everything) |
| [`docs/TECH_PLAN.md`](docs/TECH_PLAN.md) | architecture, package layout, libraries, concurrency, scaling |
| [`docs/WHY_GO.md`](docs/WHY_GO.md) | why Go vs the .NET service (efficiency, scalability) |
| [`docs/API.md`](docs/API.md) | every REST endpoint + the WebSocket contract |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | every env var: type, default, required, security notes |
| [`docs/USAGE.md`](docs/USAGE.md) | client guide (curl + WebSocket examples) |
| [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md) | build/vet/test/coverage + smoke output |
| [`docs/ANALYSIS.md`](docs/ANALYSIS.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/PARITY-NOTES.md`](docs/PARITY-NOTES.md) | .NET behavior reconstruction, design rationale, deviations |

## Observability & deploy

- Liveness `/healthz`, readiness `/readyz` (tracks the MT5 session), Prometheus
  `/metrics` (HTTP, WS, and MT5 counters).
  Local stack via `make compose-up`.

## Configuration

All configuration is environment-based with safe defaults; see
[`.env.example`](.env.example) for the full list. Security-hardening toggles
(`WS_REQUIRE_AUTH`, `CORS_ALLOWED_ORIGINS`, JWT issuer/audience
validation) default to the secure value and can be set to their legacy values for exact
parity with the old service during a client transition.

## Layout

```
cmd/gateway        entrypoint
internal/config    typed env configuration
internal/httpapi   router, middleware, response envelope, (later) handlers
internal/mt5       MT5 session pool + client (later stage)
internal/domain    per-domain services (later stage)
internal/transform MT5→TradingView mappings (later stage)
internal/realtime  /ws server, hub, poller, bus (later stage)
internal/store     Postgres + Timescale (later stage)
internal/jobs      price-history jobs (later stage)
internal/observability  logging, health, metrics, tracing
deploy/            Dockerfile, docker-compose, k8s (later stage)
docs/              ANALYSIS.md, ARCHITECTURE.md
```
