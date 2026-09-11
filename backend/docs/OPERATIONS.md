# Operations

Running and operating the gateway in production. Config: [`CONFIGURATION.md`](CONFIGURATION.md).
Launch: [`LAUNCH.md`](LAUNCH.md).

## Release provenance

The GitHub Actions workflow reads the minimum Go version from `go.mod`, sets
`GOTOOLCHAIN=local` so the runner cannot silently select a different compiler,
and fails unless the active runtime is exactly Go 1.26.6. It then runs module
canonicalization, formatting, vet, the full race-detector suite, and the
official Go vulnerability scanner before producing Windows and Linux artifacts.

Each artifact bundle contains `SHA256SUMS`, `toolchain.txt`, and the output of
`go version -m` for both binaries. Compare the Windows checksum before upload;
the production `update.ps1` independently verifies the copied artifact and
rejects/rolls back a running Go runtime older than 1.26.6.

CI receives no production credentials or endpoint configuration. Its tests use
only in-memory/mock dependencies and cannot submit a real trading mutation.

## Observability

**Logging** — structured `log/slog` JSON to stdout (`LOG_FORMAT=json`,
`LOG_LEVEL=info`). One line per request (`msg=http_request` with method, path,
status, duration). Secrets are never logged. Ship stdout to your log stack
(Loki/ELK/CloudWatch).

**Health/readiness**
- `GET /healthz` — liveness; 200 while the process runs.
- `GET /readyz` — readiness; **200 only when the MT5 session is authenticated**,
  503 otherwise. Wire this to the k8s readinessProbe and the LB so pods mid
  re-auth are pulled from rotation.

**Metrics** — Prometheus at `GET http://<METRICS_ADDR>/metrics` (private listener):

| Metric | Type | Use |
|---|---|---|
| `http_requests_total{method,route,status}` | counter | request rate, error ratio per route |
| `http_request_duration_seconds{method,route}` | histogram | latency SLOs |
| `mt5_requests_total{result=ok|error|open}` | counter | upstream health; `open` = circuit breaker tripped |
| `gateway_build_info{module_version,revision,modified,go_version}` | gauge | exact source/runtime identity; always 1 |
| `ws_active_connections` | gauge | WS scale / HPA signal |
| `ws_messages_dropped_total` | counter | backpressure (slow consumers) |
| `go_*`, `process_*` | — | runtime/process |

**Suggested alerts:** `rate(mt5_requests_total{result="open"}[5m]) > 0` (breaker
open); readiness flapping; `rate(http_requests_total{status=~"5.."}[5m])` high;
`ws_messages_dropped_total` climbing; `gateway_build_info` changing unexpectedly,
reporting `modified="true"` for a CI artifact, or reporting a `go_version` below
the deployment minimum.

## Common failure modes & remediation

| Symptom | Likely cause | Remediation |
|---|---|---|
| `/readyz` 503, logs loop on auth | MT5 manager auth failing; broker rejects source IP (403) | Confirm `MT5_PASSWORD`/`MT5_LOGIN`; ensure the egress IP is on the broker allowlist (the .NET deployment hit this — see source `MT5-403-IP-Whitelist-Report.md`). The session auto-retries every 3s. |
| `mt5_requests_total{result="open"}` > 0 | upstream down/slow → circuit breaker open | Breaker recovers after 30s; check broker reachability and latency; clients get `success:false`. |
| REST 401 everywhere | bad/expired JWT, or `iss/aud` mismatch | Re-issue token; if migrating from .NET tokens, set `JWT_VALIDATE_ISSUER/AUDIENCE=false` temporarily. |
| REST 403 on account endpoints | `login` not in the token's `accounts` claim | Use a CRM-issued token whose accounts include that login. |
| `/ws` 401 | missing/invalid JWT or legacy query-token transport disabled | Browsers send `opotrade.v1` and `opotrade.jwt.<JWT>` subprotocols; CLI clients use Bearer. Do not disable `WS_REQUIRE_AUTH`. |
| `/ws` 501 | (regression) middleware not forwarding Hijack | Fixed; if reintroduced, ensure response wrappers implement `http.Hijacker`. |
| Startup refuses (production) | missing `JWT_SECRET_KEY`/`MT5_PASSWORD` | Provide the secrets; `Validate()` is fatal in `ENVIRONMENT=production`. |
| 429 responses | rate limit hit | Expected under abuse; tune `RATE_LIMIT_RPS/BURST`; ops paths are exempt. |
| Timescale "unavailable" warning | DB unreachable | Service runs API-only (no DB-backed history); fix DSN/connectivity; history endpoints fall back to live MT5. |
| WS clients see no data across pods | `NATS_URL` unset or no poller | Set `NATS_URL` and run a `poller` role; otherwise fan-out is per-pod. |

## Scaling & tuning knobs

- **API/WS pods** — stateless; scale on CPU/RPS (`api`) and `ws_active_connections`
  (`ws`, via prometheus-adapter). HPA example in `deploy/k8s/hpa.yaml`.
- **MT5 load** — the WS hub already collapses per-connection polling to
  per-subscription. With `NATS_URL` set, a single leader poller does **one** poll
  per subscription cluster-wide (O(symbols)). `MT5_POOL_SIZE` raises upstream
  parallelism if the broker permits concurrent manager sessions (default 1).
- **Cadence** — `WS_PUSH_CADENCE` trades freshness vs upstream load.
- **Backpressure** — `WS_SEND_BUFFER`; watch `ws_messages_dropped_total`.
- **Rate limit** — `RATE_LIMIT_RPS/BURST`; distributed when `REDIS_ADDRS` set.
- **DB** — `DB_MAX_CONNS`; Timescale retention policy (7d) applied by migration;
  `MT5_READ_DATA_FROM_DB=true` serves M1 history from the store.
- **Timeouts** — `MT5_REQUEST_TIMEOUT`, `HTTP_*_TIMEOUT`, `WS_WRITE_TIMEOUT`.

## Graceful shutdown

On SIGINT/SIGTERM: stop accepting, drain in-flight HTTP within
`HTTP_SHUTDOWN_TIMEOUT`, unwind WS connections, stop pollers/scheduler, close DB/
Redis/NATS. Set the k8s `terminationGracePeriodSeconds` ≥ the shutdown timeout.

## Windows crash and hang recovery

The production gateway scheduled task retains its native crash-restart policy.
`OpoGatewayWatchdog` additionally probes only the loopback `/healthz` liveness
endpoint every minute and restarts the scoped gateway task after three consecutive
failures. It deliberately ignores `/readyz`: an MT5 outage must remove the gateway
from service without creating a restart storm. The watchdog log is capped at 1 MiB
and retains one prior file. Caddy uses service recovery delays of 5, 15, and 60
seconds, resets its failure count daily, and applies recovery to non-crash failures.

Inspect the active recovery configuration with:

```powershell
schtasks /query /tn OpoGatewayWatchdog /fo LIST /v
sc.exe qfailure Caddy
sc.exe qfailureflag Caddy
```

These same-host safeguards are not external monitoring. Operate an independent
HTTPS probe and alert receiver outside the Windows server.

## Roles

One binary, role-gated by `ROLES`. Run `all` per pod for simple deployments, or
split `api` / `ws` / `poller` / `mt5` / `jobs` for independent scaling
(`deploy/k8s/README.md`). The price-history `jobs` and the `poller` leader are
de-duplicated cluster-wide via Postgres advisory locks, so it's safe to run them
on multiple replicas.
