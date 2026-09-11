# Configuration

All configuration is via environment variables (12-factor). Defaults are in
`internal/config/config.go`; a template is in [`.env.example`](../.env.example).
Secrets must come from the environment / a secret store — never commit them.

**Required in every deployment:** `JWT_SECRET_KEY`, `MT5_HOST_URL`, `CRM_URL`,
`MT5_PASSWORD` + `MT5_LOGIN` (whenever this process runs the `mt5` role), and
`JWT_ISSUER` / `JWT_AUDIENCE` (whenever the matching `JWT_VALIDATE_*` flag is
`true`).

The endpoint variables carry **no built-in default**. A compiled-in broker or
CRM host meant a gateway stood up on a new server silently talked to the
original firm's production instead of refusing to start; an unset value is now
a startup error naming the variable.

**When validation is fatal:** everywhere except an explicit
`ENVIRONMENT=development`, which is the only value that downgrades
configuration errors to warnings. Previously only `ENVIRONMENT=production`
failed fast, so `staging`, `prod`, or an unset value would start a
misconfigured gateway — exactly where the mistake is least likely to be
noticed. Degraded startup is now opt-in by name.

> A process that starts without `JWT_SECRET_KEY` cannot mount the REST API at
> all. It therefore reports **`/readyz` → 503**, so a load balancer never routes
> to a gateway that would answer `501` on every `/api` call. Liveness stays
> `200`: the process is healthy, just misconfigured, and restarting will not
> help.

## Server

| Var | Type | Default | Notes |
|---|---|---|---|
| `HTTP_ADDR` | string | `:5063` | API + WS listen address |
| `HTTP_READ_HEADER_TIMEOUT` | duration | `5s` | bounds slow/incomplete request headers |
| `HTTP_READ_TIMEOUT` | duration | `15s` | |
| `HTTP_WRITE_TIMEOUT` | duration | `30s` | keep ≥ WS cadence headroom |
| `HTTP_IDLE_TIMEOUT` | duration | `120s` | |
| `HTTP_SHUTDOWN_TIMEOUT` | duration | `20s` | graceful-drain deadline |
| `HTTP_MAX_BODY_BYTES` | bytes | `4194304` | hard cap applied before API auth/parsing; oversize = 413 |
| `ENVIRONMENT` | string | `development` | any value other than `development` makes config validation fatal |
| `ROLES` | csv | `all` | `all` or any of `api,ws,poller,mt5,jobs` |

## MT5 upstream

| Var | Type | Default | Notes |
|---|---|---|---|
| `MT5_HOST_URL` | string | — | **required**, no default (per-deployment) |
| `MT5_PORT` | int | `443` | |
| `MT5_LOGIN` | uint | — | manager login (**secret**) |
| `MT5_PASSWORD` | string | — | **secret**; required when this process runs the `mt5` role |
| `MT5_VERSION` | string | `4410` | |
| `MT5_AGENT` | string | `WebManager` | |
| `MT5_TYPE` | string | `Manager` | |
| `MT5_POOL_SIZE` | int | `1` | authenticated connections; `1` = parity with .NET. **Every MT5 call serialises through this pool** — production measured a 3.9x speedup on the account-switch burst at `3` (940ms → 242ms). Verify `authenticated` equals `pool_size` in the startup log: a broker may cap manager sessions. |
| `MT5_PING_INTERVAL` | duration | `20s` | keep-alive ping |
| `MT5_MAX_CONSECUTIVE_FAILURES` | int | `3` | re-auth threshold |
| `MT5_REQUEST_TIMEOUT` | duration | `30s` | per upstream request |
| `MT5_MAX_RESPONSE_BYTES` | bytes | `33554432` | bounds one upstream response in memory |
| `MT5_READ_DATA_FROM_DB` | bool | `false` | serve M1 history from Timescale instead of live API |
| `MT5_DEFAULT_SYMBOL_LIST` | csv | (20 symbols) | fallback symbol list |
| `MT5_DEFAULT_CHART_DATA` | string | `dhloc` | |
| `MT5_DEFAULT_RESOLUTION` | string | `1D` | |
| `MT5_SYMBOL_DEFAULT_COUNT` | int | `10` | |

## CRM

| Var | Type | Default | Notes |
|---|---|---|---|
| `CRM_URL` | string | — | **required**, no default (per-deployment); login / account discovery |
| `CRM_ALLOWED_ACCOUNT_TYPES` | csv of int | `57,58,59,60,61,62,63,64,65,66,67` | account types admitted to the selector |
| `CRM_ACCOUNT_TYPE_SUFFIXES` | `id:suffix,…` | *(empty)* | symbol suffix per type, e.g. `57:.,58:!,59:#,60:` |

An account type may only trade here when its symbol suffix is known — a wrong
suffix sends a wrong symbol name to MT5. A type that is admitted but missing
from the suffix map is reported to the client as `suffixKnown: false`, and the
client must not build symbol names from it. An empty suffix is a valid answer
(ECNPRO uses none) — that is why "unknown" and "empty" are separate states.

### Confirmed mapping (staging, 2026-07-31)

Derived by reading each account's MT5 group and cross-checking the symbol
namespace, where the same instrument exists under each suffix
(`AUDNOK.` / `AUDNOK!` / `AUDNOK#`):

| Tier | Suffix | typeIds | Group name contains |
|---|---|---|---|
| ECN | `.` | 57, 61 | `ECN-…` |
| Standard | `!` | 58, 62 | `STD-…` |
| Social / COPY | `#` | 60 | `COPY-…` |
| ECNPRO | *(none)* | 11, 59, 63 | `ECNPRO-…` |

```
CRM_ACCOUNT_TYPE_SUFFIXES=11:,57:.,58:!,59:,60:#,61:.,62:!,63:
```

**typeId 64** (`COPY-ECNPRO-APP-USD-B`) is intentionally omitted — the group
carries both qualifiers, so its suffix is ambiguous. It stays `suffixKnown:
false` until the broker confirms it.

**typeId 11 is the most common account type in production** (6 of 17 accounts on
the staging CRM). It is *not* in the code's default allowlist because its suffix
was historically unconfirmed, so `CRM_ALLOWED_ACCOUNT_TYPES` must include it
explicitly — omitting it locks those traders out of every protected endpoint.

## JWT (client tokens)

| Var | Type | Default | Notes |
|---|---|---|---|
| `JWT_SECRET_KEY` | string | — | **secret**, required; HS256 (ASCII bytes) |
| `JWT_ISSUER` | string | — | required when `JWT_VALIDATE_ISSUER=true`; no default |
| `JWT_AUDIENCE` | string | — | required when `JWT_VALIDATE_AUDIENCE=true`; no default |
| `JWT_VALIDATE_ISSUER` | bool | `true` | hardened; `false` = accept tokens without `iss` |
| `JWT_VALIDATE_AUDIENCE` | bool | `true` | hardened; `false` = accept tokens without `aud` |
| `JWT_EXPIRY` | duration | `1h` | |

> Keeping the same `JWT_SECRET_KEY` as the .NET service makes tokens
> cross-compatible during migration. Note: legacy .NET tokens lack `iss`/`aud`;
> set the `JWT_VALIDATE_*` flags `false` during transition if you must accept them.

## Security (hardened defaults — set legacy values only to ease migration)

| Var | Type | Default | Notes |
|---|---|---|---|
| `WS_REQUIRE_AUTH` | bool | `true` | JWT required before `/ws` upgrade. Legacy: `false` |
| `WS_ALLOW_QUERY_TOKEN` | bool | `false` | migration-only support for `?access_token=`; enabling it can expose bearer credentials because URLs are commonly logged |
| `CORS_ALLOWED_ORIGINS` | csv | *(empty)* | **fail-closed**: empty = no cross-origin. Set a real allowlist; `*` = legacy any-origin |
| `MANAGER_API_KEY` | string | *(empty)* | second server-side credential for ticket-only manager routes; empty disables them; minimum 32 characters |

### Removed TradingView compatibility controller

The .NET `/api/tv/TVOrder/*` controller duplicated the canonical trading APIs,
used hardcoded accounts for several operations, and included stubs. It is not
registered by the Go gateway; all of those paths return 404. `MANAGER_API_KEY`
now protects only the remaining ticket-only MT5 Manager maintenance routes.

## Data stores

| Var | Type | Default | Notes |
|---|---|---|---|
| `POSTGRES_DSN` | string | *(empty)* | trading_ops/audit + price alerts + workspaces (**secret** in prod); no credentials compiled in |
| `TIMESCALE_DSN` | string | *(empty)* | OHLC store; empty = no DB (API-only, warned at startup). Required when `MT5_READ_DATA_FROM_DB=true` |
| `DB_MAX_CONNS` | int | `20` | pgx pool size |

Price alerts and workspace persistence use `POSTGRES_DSN`, falling back to
`TIMESCALE_DSN` (a small deployment usually runs both on one server). With
neither set, those endpoints report the feature unavailable **with the reason**
rather than accepting data they cannot keep — see `GET /api/Capabilities`.

## Trade

| Var | Type | Default | Notes |
|---|---|---|---|
| `TRADE_IDEMPOTENCY_TTL` | duration | `10m` | how long a submission with an `Idempotency-Key` is replayable |
| `MT5_BOOK_SIDE_CONVENTION` | `mql5`\|`manager` | `mql5` | market-depth side codes: `mql5` = SELL 1 / BUY 2; `manager` = SELL 0 / BUY 1 |
| `MT5_BOOK_SUBSCRIBE` | bool | `true` | subscribe to a symbol's book before reading it; MT5 pushes depth to subscribers only |

A wrong `MT5_BOOK_SIDE_CONVENTION` flips every bid and ask. It shows up
immediately as `"crossed": true` on any two-sided book from
`/api/Tick/get_marketdepth` — if you see that, switch the value.

An **empty** book from that endpoint has two possible causes, and the gateway
log tells them apart. MT5 delivers depth to subscribers only, so the gateway
subscribes before every read (at most once per symbol per minute). If the trade
server has no subscribe command you get one
`market-depth subscribe failed` warning per symbol — that means the empty book
is the gateway's problem, and `MT5_BOOK_SUBSCRIBE=false` silences the attempt.
With no such warning, the subscription succeeded and the book really is empty:
the broker publishes no Level 2 for that instrument, which is common on FX and
aggregated feeds.

Trade idempotency is distributed when `REDIS_ADDRS` is reachable, and
per-process otherwise.

## Alerts

| Var | Type | Default | Notes |
|---|---|---|---|
| `ALERTS_ENABLED` | bool | `true` | run the server-side alert evaluator in this process (needs the `jobs` role and a database) |
| `ALERTS_EVAL_INTERVAL` | duration | `3s` | how often active alerts are checked against quotes |

The evaluator holds a Postgres advisory lock, so only one replica sweeps at a
time. The lock is an optimization, not a correctness requirement: the
triggered-flip is a compare-and-set, so an alert can never fire twice.

## News / economic calendar (optional)

| Var | Type | Default | Notes |
|---|---|---|---|
| `NEWS_PROVIDER_URL` | string | *(empty)* | empty = feature off, with the reason reported |
| `NEWS_PROVIDER_API_KEY` | string | *(empty)* | **secret**; never reaches the client |
| `NEWS_PROVIDER_API_KEY_HEADER` | string | `X-API-Key` | empty = send the key as an `apikey` query param instead |
| `CALENDAR_PROVIDER_URL` | string | *(empty)* | |
| `CALENDAR_PROVIDER_API_KEY` | string | *(empty)* | **secret** |
| `CALENDAR_PROVIDER_API_KEY_HEADER` | string | `X-API-Key` | |
| `CONTENT_CACHE_TTL` | duration | `60s` | one upstream call serves every open terminal |
| `CONTENT_TIMEOUT` | duration | `10s` | per provider request |

## Redis (optional — distributed rate limiting)

| Var | Type | Default | Notes |
|---|---|---|---|
| `REDIS_ADDRS` | csv | *(empty)* | optional single node or cluster; empty uses per-process fallbacks |
| `REDIS_PASSWORD` | string | — | **secret** |

When reachable **and** rate limiting is enabled, the limiter is distributed
(shared across replicas); otherwise it is in-process per pod.

## NATS (optional — cross-pod WS fan-out)

| Var | Type | Default | Notes |
|---|---|---|---|
| `NATS_URL` | string | *(empty)* | empty = per-pod hub; set = cluster-wide fan-out via a leader-elected poller |

## Realtime (/ws)

| Var | Type | Default | Notes |
|---|---|---|---|
| `WS_PUSH_CADENCE` | duration | `3s` | server push interval (matches .NET) |
| `WS_MAX_MESSAGE_SIZE` | int | `16384` | read limit (bytes) |
| `WS_WRITE_TIMEOUT` | duration | `10s` | per-frame write deadline |
| `WS_SEND_BUFFER` | int | `32` | per-connection queue (backpressure; latest-wins drop) |

## Rate limiting

| Var | Type | Default | Notes |
|---|---|---|---|
| `RATE_LIMIT_RPS` | float | `0` | per-IP requests/sec; `0` = off. **Enable in prod** (e.g. `50`) |
| `RATE_LIMIT_BURST` | int | `20` | bucket capacity (`.env.example`/ConfigMap recommend `100`) |
| `RATE_LIMIT_TRUSTED_PROXIES` | csv | *(empty)* | CIDRs/IPs of reverse proxies whose `X-Forwarded-For` is honored. Empty = trust none: requests are keyed by the TCP peer, spoofed XFF is ignored. **Set when behind an ingress/LB.** List EVERY hop between client and gateway (behind Caddy behind Cloudflare: loopback + [Cloudflare's ranges](https://www.cloudflare.com/ips/)). When a trusted peer's forwarded chain never yields an untrusted hop — the proxy in front dropped the client entry — the request keys to *no one*: it is exempt from both the volume limiter and the login throttle, and a warning (`client IP not established`, at most hourly) is logged. This replaces the old fallback of keying to the proxy address itself, which silently pooled every user into one bucket: one shared login lockout for the whole site, and a site-wide RPS cap (HGH-02 retest, 2026-08-28). The proxy in front must forward the client hop — for Caddy behind Cloudflare that requires the global option `servers { trusted_proxies static <cloudflare ranges> }` |

The limiter fails open on Redis errors; each such request increments the
`rate_limit_fail_open_total` metric and logs a throttled warning — alert on it.

## Observability

| Var | Type | Default | Notes |
|---|---|---|---|
| `LOG_LEVEL` | string | `info` | `debug,info,warn,error` |
| `LOG_FORMAT` | string | `json` | `json` or `text` |
| `METRICS_ADDR` | string | `127.0.0.1:9090` | private Prometheus listener; use `:9090` inside a pod network |
| `OTLP_ENDPOINT` | string | *(empty)* | reserved for OpenTelemetry export |

## Security notes

- Secrets (`JWT_SECRET_KEY`, `MT5_PASSWORD`, DSN passwords, `REDIS_PASSWORD`) are
  never logged. Provide them via a secret store (k8s Secret / Vault / AWS Secrets
  Manager), not the ConfigMap.
- `/healthz` and `/readyz` are unauthenticated by design. `/metrics` is served
  on the separate `METRICS_ADDR` listener; restrict that listener
  at the ingress / NetworkPolicy.
- Double-underscore env names from the .NET deployment (e.g.
  `MT5Config__password`) are **not** used here; use the flat names above.
