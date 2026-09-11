# Launch Guide

Step-by-step to build, configure, and deploy the gateway, with first-run
verification and rollback. See also [`CONFIGURATION.md`](CONFIGURATION.md),
[`OPERATIONS.md`](OPERATIONS.md), and `deploy/k8s/`.

## 0. Prerequisites

- Go 1.26+ (build) and Docker (image/local stack).
- **MT5 manager credentials** (`MT5_LOGIN`, `MT5_PASSWORD`) and the gateway's
  **egress IP allow-listed** on the MT5 broker (`tradeapp.opofinance.com`).
- A strong `JWT_SECRET_KEY` (reuse the .NET one to keep tokens cross-compatible).
- **PostgreSQL 16 + TimescaleDB** (price history). Optional: **Redis** (distributed
  rate limiting), **NATS JetStream** (cross-pod WS fan-out).
- Edge TLS (Ingress/Envoy) terminating HTTPS and allowing WebSocket upgrades.

## 1. Build

```bash
# binary
make build            # → bin/gateway
# or container image
make docker-build     # → tradeplatform-gateway:dev
```

## 2. Configure

```bash
cp .env.example .env   # then set, at minimum:
#   JWT_SECRET_KEY, MT5_LOGIN, MT5_PASSWORD
#   POSTGRES_DSN, TIMESCALE_DSN
#   CORS_ALLOWED_ORIGINS (real allowlist — empty = deny cross-origin)
#   ENVIRONMENT=production   (makes missing secrets fatal)
#   RATE_LIMIT_RPS=50        (recommended)
#   REDIS_ADDRS / NATS_URL   (if used)
```

Hardened defaults are already on: JWT required on `/ws`, CRM-only login,
issuer/audience validation. See [`CONFIGURATION.md`](CONFIGURATION.md).

## 3. Database migration + hypertables

Migrations are **idempotent and run automatically at startup** (`store/timescale`
creates `price_history`, `daily_data`, `logs`, then — best-effort — the
TimescaleDB extension, the `price_history` hypertable, and the 7-day retention
policy). No separate migration step is required.

To verify after first start:

```sql
-- tables exist
\dt
-- price_history is a hypertable (Timescale)
SELECT hypertable_name FROM timescaledb_information.hypertables;
-- retention policy present
SELECT * FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention';
```

(If the DB is plain PostgreSQL without TimescaleDB, the plain tables still work;
the hypertable/retention steps are skipped.)

## 4. Run

**Local (Docker Compose — gateway + Postgres/Timescale + Redis + NATS):**

```bash
make compose-up
```

**Single binary:**

```bash
set -a; source .env; set +a
./bin/gateway
```

**Kubernetes:**

```bash
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/secret.yaml      # from secret.example.yaml / your secret store
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/hpa.yaml
```

Point your Ingress/Envoy at the `opotrade-gateway` Service (TLS + WS upgrade;
sticky sessions for `/ws` unless NATS fan-out is enabled).

## 5. First-run verification

```bash
# probes
curl -fsS http://<host>/healthz     # {"status":"alive"}
curl -fsS http://<host>/readyz      # {"status":"ready"}  (200 once MT5 auth succeeds)
curl -fsS http://<host>/metrics | head

# full smoke (health, authed REST, WS upgrade)
BASE_URL=http://<host> TOKEN=<jwt> ./scripts/smoke_test.sh
# expect: 7 passed, 0 failed
```

If `/readyz` stays 503: the MT5 session isn't authenticating — check
credentials and the broker IP allowlist (see [`OPERATIONS.md`](OPERATIONS.md)).

## 6. Go-live checklist

- [ ] `ENVIRONMENT=production`; secrets from a secret store (not ConfigMap/git).
- [ ] `JWT_SECRET_KEY`, `MT5_LOGIN`, `MT5_PASSWORD` set; egress IP allow-listed.
- [ ] `CORS_ALLOWED_ORIGINS` = real allowlist (not empty for browser clients, not `*`).
- [ ] `WS_REQUIRE_AUTH=true`. (The username-only login path no longer exists.)
- [ ] **Cutover from .NET:** `JWT_VALIDATE_ISSUER=false` and `JWT_VALIDATE_AUDIENCE=false`
      — .NET tokens carry no `iss`/`aud`, so validating them 401s every existing
      client on launch day. Set both to `true` only after all clients hold
      Go-issued tokens (≥ `JWT_EXPIRY` after full cutover).
- [ ] `RATE_LIMIT_RPS` enabled; `REDIS_ADDRS` set if multi-replica.
- [ ] Timescale reachable; hypertable + retention verified.
- [ ] `NATS_URL` set + a `poller` running if cross-pod WS fan-out is required.
- [ ] Ingress: TLS, WebSocket upgrade, `/metrics` + `/healthz` restricted (NetworkPolicy).
- [ ] readiness/liveness probes wired; `terminationGracePeriodSeconds ≥ HTTP_SHUTDOWN_TIMEOUT`.
- [ ] Prometheus scraping `/metrics`; alerts for breaker-open / 5xx / readiness flap.
- [ ] Smoke test green against the deployed instance.
- [ ] Existing clients verified against hardened auth/CORS (or transition flags set).

## 7. Rollback

The service is stateless except the Timescale store, whose **migrations are
additive** (CREATE IF NOT EXISTS; no destructive changes) — rolling back the
image needs no DB rollback.

```bash
# Kubernetes
kubectl rollout undo deployment/opotrade-gateway
kubectl rollout status deployment/opotrade-gateway

# Compose / binary: redeploy the previous image/tag or git revision.
```

If migrating from the .NET service, you can run both in parallel behind the LB
and shift traffic gradually (tokens are cross-compatible when the JWT secret is
shared); roll back by shifting traffic back. No data migration is required to
start (Timescale begins fresh; backfill is optional).
