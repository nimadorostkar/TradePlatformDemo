# Production audit and hardening — 2026-08-01

## Scope and safety

Audited the Go MT5 gateway, React/TradingView terminal, and the Windows/Caddy
deployment. Production validation remained read-only for all trading state. No
live order, position, balance, or account mutation endpoint was called. The
complete mutation-shaped workflow was exercised only against the bundled local
mock MT5 and CRM services.

## Issues fixed

| Area | Problem and root cause | Fix | Verification |
|---|---|---|---|
| WebSocket hub | The last unsubscribe could cancel a topic while a concurrent subscribe attached to it, leaving a permanently stale socket. Topic and hub locks did not make the transition atomic. | Enforced hub→topic lock ordering and made last-leave/new-join atomic. | Race-detector suite and a concurrent regression test pass. |
| WebSocket backpressure | A full client queue dropped the newest snapshot while claiming “latest wins,” allowing a slow browser to drain increasingly stale prices. | On overflow, evict one oldest queued snapshot and retain the newest without blocking the shared poller; preserve per-client/global drop metrics. | Latest-snapshot regression, full race suite, and 100-client fan-out load test pass. |
| WebSocket credential exposure | The browser placed its bearer JWT in `access_token` on every WebSocket URL. Query strings are routinely retained by proxies, observability systems, and diagnostics, turning ordinary connection metadata into a credential leak. | Added `opotrade.jwt.<JWT>` as a credential-bearing subprotocol while negotiating only non-secret `opotrade.v1`; migrated the React socket pool to credential-free URLs; made legacy query transport an explicit, fail-closed setting. | Backend tests cover subprotocol auth, account ownership, ambiguity rejection, and disabled query tokens; frontend URL/protocol, reconnect, and rotation tests pass. A synthetic account-less public WSS quote stream negotiated `opotrade.v1` and returned JSON with no URL credential; the same valid short-lived JWT was rejected through the legacy query transport. |
| Idempotency performance | The in-memory trade idempotency store scanned every key on every request, creating O(n)-per-request CPU work at sustained unique-key volume. | Check the requested key immediately but amortize full expiry sweeps to a bounded interval. | Replay, concurrent-claim, expiry, account scoping, fail-closed, and amortized-sweep tests pass under the race detector. |
| MT5 retry safety | The transport retried every upstream request three times, including dealer POSTs and legacy mutations implemented as GETs. A connection loss after MT5 applied an action could therefore apply it again. | Automatic retries now use an explicit fail-closed allowlist of read-only MT5 paths. POSTs, balance changes, cancel/delete/reopen/fix, and unknown future paths receive exactly one attempt and return an ambiguous outcome for reconciliation. | Regression injects a connection loss after a dealer POST write and proves exactly one upstream attempt; read-only retry/backoff tests and the full race suite pass. |
| MT5 session stability | Every non-2xx MT5 response incremented the shared connection's authentication-failure counter. Repeated invalid symbol/ticket/volume requests could therefore force needless Manager reauthentication even though ordinary business 4xx responses prove the session is alive. | Separate business responses from session failures: ordinary 4xx resets the session-failure streak, 401/403 invalidates authentication immediately, and transport/5xx failures retain threshold-based recovery. | Twenty race-detector repetitions pass for business-error isolation, immediate auth rejection, repeated 5xx handling, circuit behavior, mutation non-replay, and a mock expired session that reauthenticates exactly once. |
| HTTP resource bounds | Public requests had no header timeout. Body readers silently truncated oversized payloads, account middleware imposed a conflicting 1 MiB limit, and MT5/CRM response reads were unbounded. | Added a 5 s header timeout, a router-level 4 MiB body buffer/413 guard (including chunked bodies), removed the conflicting second truncation, capped CRM replies at 8 MiB, and capped configurable MT5 replies at 32 MiB. | Content-Length/chunked/preservation regressions, oversized-upstream regression, configuration validation, race suite, vet, Windows build, and 120/120 mock E2E pass. |
| Account authorization | Several login-scoped routes were protected only by JWT, and an omitted login could become an unscoped request. | Applied account ownership middleware consistently; missing login is 400 and a foreign login is 403. | Middleware tests and local E2E ownership checks pass. |
| MT5 Manager and duplicate routes | Ticket-only maintenance routes cannot prove retail account ownership. Legacy TVOrder routes duplicated the canonical flow and could mutate hardcoded accounts; two time aliases and a localhost WebSocket demo added no behavior. | Added a constant-time `X-Manager-Key` guard to remaining Manager routes. Removed the TVOrder controller, duplicate time aliases, demo endpoint, and their dead hardcoded service methods. | Unit/OpenAPI tests and mock E2E manager/retail separation/removal checks pass. Production manager key is empty, so remaining Manager routes are disabled. |
| Metrics exposure | Prometheus data, Go runtime details, and MT5 counters were public at `/metrics`. | Moved Prometheus to a dedicated `METRICS_ADDR`, defaulting to `127.0.0.1:9090`; public `/metrics` is no longer mounted. | Public endpoint returns 404; private loopback endpoint returns 200. |
| Build observability | Production exposed the Go runtime but not the exact module version, source revision, or dirty-worktree state, so operators could not unambiguously identify a running artifact. | Added a constant `gateway_build_info` metric labelled with module version, revision, modified state, and Go version. | Collector regression tests pass; production reports revision `d3e61f70c8b03374cdabf16edda43ebaa838cd1b`, `modified="true"`, and `go_version="go1.26.5"`. |
| Raw gateway exposure | Windows firewall exposed plaintext ports 5063 and 5070, bypassing TLS/Caddy controls. | Bound the Go gateway to `127.0.0.1:5070` and disabled both inbound allow rules. | Both ports time out externally; HTTPS reverse proxy health remains 200. |
| Rate limiting | Production explicitly disabled rate limiting (`RATE_LIMIT_RPS=0`). | Enabled 50 requests/s with burst 100 and trusted only loopback proxies. | Mock E2E exhausts burst, rejects spoofed XFF, and records 429 metrics. Production config confirms the limits. |
| Windows logging | `ReadToEndAsync` buffered process output for the lifetime of the gateway and did not expose launcher logs until exit. | Redirected child stdout/stderr directly to files with `Start-Process`, keeping memory bounded and logs visible. | PowerShell parses the launcher and the scheduled task restarted healthy. |
| Windows update rollback | The updater accepted `/healthz` while `/readyz` was still failing, did not actually roll back a failed capabilities check, used a collision-prone staging filename, broadly killed every process named `gateway`, and resolved the wrong repository when its optional server-build mode ran from the install root. Failed preflight could also strand staged executables, and artifact hashes alone did not prevent a build with a vulnerable Go standard library. | Create a unique, always-cleaned staging artifact and a hash-verified rollback copy before downtime; accept an explicit validated `RepoRoot`; stop only the executable installed in this environment; verify the installed hash and private `go_info` runtime version; and roll back unless the minimum Go runtime, liveness, MT5 readiness, task activation, and capabilities all succeed. | Final script parsed successfully with Windows PowerShell and its local/production SHA-256 matches `1377F3A07DB9CD11E4AD573B9DF20777F47423F24DED69391992B4E7761533A7`. The final activation explicitly reported `Go runtime 1.26.5 (minimum 1.26.5)`. |
| Legacy production process | The retired .NET gateway still ran as `OpoMTSocketProd` and listened on all interfaces at port 5063 despite Caddy, IIS, monitoring, and firewall no longer using it. It retained an unnecessary live Manager session and duplicate attack surface. | Exported its scheduled-task XML, disabled the task, and stopped only its idle process. | No established clients existed before retirement; port 5063 now has no listener, the Go task remained running, and the task definition is restorable from the exported XML. |
| Windows crash and hang recovery | The gateway task could recover from a process exit but not a hung process, and Caddy had no service failure actions. The local monitoring dashboard probes only when opened or manually rechecked. | Installed a SYSTEM watchdog that probes loopback liveness every minute and restarts only the gateway task after three consecutive failures; configured Caddy recovery at 5/15/60 seconds with non-crash failure handling. Readiness is deliberately excluded to prevent MT5 outages from causing restart storms. | PowerShell parsing and healthy-state clearing passed; two isolated failures against unused port 59999 produced state 2 without touching the real gateway. The registered watchdog returned 0, and Caddy recovery settings query correctly. |
| Graceful shutdown | HTTP and metrics listeners drained sequentially on one timeout. The history scheduler continued walking symbols after cancellation and emitted 1,162 circuit-breaker warnings during the prior deployment stop. | Drain both listeners concurrently; stop symbol iteration and aggregation immediately on context cancellation. | Cancellation regression test passes; the new deployment shut down/restarted without the warning burst. |
| Stage frontend | The stage hostname proxied to a stale IIS build. Missing `runtime-config.js` produced a detailed IIS 404 that disclosed filesystem paths. | Caddy now serves the atomic `opotrade-ui-new/current` release and same-origin `/gateway` and `/crm` proxies with CSP and security headers. | Stage UI/runtime/gateway health return 200 and no IIS detailed error is exposed. |
| Trading confirmation | Production confirmation defaulted off when the variable was omitted, and a persisted workspace `false` could bypass the required confirmation. | Production omission now fails safe to confirmation-on; workspace preference cannot override a production-required confirmation. | React regression tests pass. |
| TradingView intraday bars | All advertised intraday timeframes received raw M1 data; higher-timeframe realtime candles were incomplete. | Aggregate M1 history and keep a timestamp-keyed active M1 bucket seeded from history, replacing repeated samples to avoid double-counted volume. | Tests verify aligned 5-minute OHLCV and exact live merging without increasing MT5 polling windows. |
| Frontend reconciliation | Buffered WebSocket frames were always discarded after the initial REST fetch because they were compared with a later `Date.now()`. Concurrent older REST requests could also overwrite newer live/account state. | Always apply the newest buffered frame, sequence concurrent reconciliations, and reject REST snapshots when a live frame arrived after the request began. | Reconciliation policy regressions and the complete frontend suite pass. |
| Frontend reconnect recovery | Browser offline left half-open sockets alive; online only reopened null sockets. A socket that remained open without frames stayed stale forever, and non-JSON proxy/error traffic reset freshness before parsing. Recovered account/order/position streams did not trigger an authoritative refresh, and a failed initial REST fetch dropped its buffered frames. | Tear sockets down offline, replace them online, replace silent half-open sockets after surfacing stale state, reconnect on contract-invalid frames without treating them as fresh, coalesce recovered streams into a REST reconciliation, and release/apply buffered frames even on REST failure. | WebSocket pool recovery/contract regressions and the complete frontend suite pass. |
| TradingView broker state | The broker adapter reported connected/tradable from the account stream alone while order or position streams could be stale. A failed TradingView script load also poisoned the cached loader until page refresh. | Derive broker connectivity/tradability from all three streams and clear/remove failed loader state so a transient failure can retry. | Broker adapter and library loader regressions pass. |
| Container startup | The image switched to the unprivileged `nginx` user but copied the Nginx config and static root as root-owned; its startup configuration rewrite could not succeed. Inline runtime configuration was also incompatible with the strict CSP. | Copy runtime files as `nginx`, rewrite Nginx through `/tmp`, and emit an external `runtime-config.js`. | Shell syntax and an unprivileged-shape entrypoint simulation pass. The local Docker daemon was unavailable for image execution. |
| Deployment cache coherence | Caddy did not prevent caching of the HTML shell or runtime configuration. Existing browsers could remain on an old bundle after an atomic release, and Cloudflare retained the fixed-name runtime config. | Mark HTML/SPA fallbacks and runtime config no-store, and version the runtime-config script URL with the release ID. | A fresh controlled browser loaded the current hashed bundle and versioned runtime config with no console errors; root, fallback, and config responses now bypass cache. |
| Frontend session lifecycle | Gateway JWTs were never renewed, missing account claims exposed all CRM accounts in the selector, rejected URL credentials remained in history, token clearing left authenticated sockets alive, and global account state survived logout. | Renew JWTs one minute before expiry using the retained CRM token; retry only while the old JWT is valid; fail closed on claims; scrub credential parameters; replace/close sockets on every token change; reload claims/accounts after renewal; replace a removed active account; wipe snapshots, quotes, capabilities, symbol metadata, and query cache outside an authenticated session. | New renewal, changed-claim, account-reselection, claim-filter, URL-scrub, socket-token, and app-boundary regressions pass. The rendered release candidate loaded the sign-in boundary with zero console warnings/errors; the exact final artifact passed its atomic health check and public asset/version verification. |
| Dependency security | The initial Go toolchain/dependency scan found four reachable advisories in Go 1.26.3 and `x/text` 0.35.0. The module and Docker builder still permitted Go 1.25, so a later build silently regressed to Go 1.26.3. | Require Go 1.26.5 in `go.mod`, use `golang:1.26.5` for container builds, enforce the minimum runtime during Windows activation, and upgrade `x/text` to 0.39.0 (`x/sync` to 0.21.0). | The ordinary system `go` launcher now selects `go1.26.5`; full race/vet/Windows build pass under that enforced version; the official scanner reports zero reachable vulnerabilities; and production `go_info` is `go1.26.5`. Full npm audit reports zero vulnerabilities. |
| CI and artifact provenance | The backend had no CI workflow, while the frontend referenced nonexistent checkout/setup/download action majors, preventing its pipeline from starting. Backend Windows artifacts also had no automated checksum or embedded-build-info record. | Add a credential-free backend workflow with an exact Go-version assertion, module/format/vet/race/vulnerability gates, Windows/Linux builds, SHA-256 manifests, and `go version -m` provenance. Align frontend actions to the current supported majors. | Pinned actionlint 1.7.12 accepts both workflows; every backend CI command was reproduced locally; both temporary artifacts report Go 1.26.5 and have generated SHA-256 hashes. |
| API documentation | Swagger described manager operations as bearer-only and omitted the manager credential. | Added the `managerKey` OpenAPI scheme and marked manager routes as JWT **and** manager-key protected. | OpenAPI structure test passes. |

## Validation evidence

- Go: `go test -race ./...`, `go vet ./...`, and `go build ./...` pass.
- React: **340 tests pass**; TypeScript, formatting, licensed TradingView asset
  verification, lint (zero errors), and production Vite build pass. The main
  application chunk is 457.39 kB (136.86 kB gzip).
- Dependency scans: official Go `govulncheck` reports no vulnerabilities with
  Go 1.26.5; full `npm audit --audit-level=low` reports zero vulnerabilities.
- WebSocket load/race test: 100 concurrent clients over 20 cadences caused
  exactly 20 upstream MT5 polls (1.00 poll per cadence), and the concurrent
  last-leave/new-join regression passed under the race detector.
- Five race-detector fault repetitions passed for cancellation-aware MT5
  polling/backoff, mutation non-replay, rate-limit fail-open and janitor stop,
  scheduler cancellation/locking, latest-wins backpressure, concurrent topic
  handoff, and the 100-client fan-out benchmark.
- Local production-shape E2E: **120 passed, 0 failed**, including REST,
  WebSocket reconnect/push contract, JWT/account ownership, CORS, rate limiting,
  private metrics, and mock-only trade workflow.
- Production after deployment:
  - backend `/healthz` and `/readyz`: 200;
  - final loopback production smoke suite: 7 passed, 0 failed, 1 authenticated
    section intentionally skipped because no customer/demo credential was used;
  - same-origin stage `/gateway/healthz`: 200;
  - unauthenticated protected REST and WebSocket: 401; removed TVOrder paths: 404;
  - public `/metrics`: 404; loopback metrics: 200;
  - gateway and metrics listeners: `127.0.0.1:5070` and `127.0.0.1:9090`;
  - raw public 5063/5070: unreachable;
  - stage UI: HTTP/2 with HSTS, CSP, COOP, permissions policy, referrer policy,
    `nosniff`, and no-store deployment metadata;
  - active gateway binary SHA-256:
    `5C49BB3477F81A9696472E161ED50BE6DED2E641234AACBF593C5CC456CF48BF`;
  - active Go runtime: `go1.26.5`, verified from the private Prometheus
    `go_info` metric and enforced by the deployment rollback gate;
  - active build identity: revision
    `d3e61f70c8b03374cdabf16edda43ebaa838cd1b`, module version
    `v0.0.0-20260731185357-d3e61f70c8b0+dirty`, and `modified="true"`;
  - active frontend release: `76bfb617e842240c16b2076daeb05e71adfed0b4`;
  - WebSocket authentication: `WS_REQUIRE_AUTH=true` and
    `WS_ALLOW_QUERY_TOKEN=false`; a synthetic account-less read-only quote
    handshake passed through public WSS using the credential subprotocol, and
    the legacy query-token handshake was rejected;
  - rendered release-candidate browser check: sign-in screen, versioned runtime
    configuration, and zero console errors; exact final asset/version verified
    over HTTPS after the last permission-refresh regression;
  - `gateway.env` ACL: inheritance disabled; only SYSTEM and Administrators
    have access.
  - legacy `.NET` task disabled and port 5063 has no listener; exported task
    backup: `C:\opomtsocket\backups\audit-retired-task-20260801-044010.xml`;
  - gateway footprint after the session-hardening restart: 21.7 MB working
    set, 11 threads, and 310 handles;
  - latest restart log window: zero warnings and zero errors.
  - Windows task result `0x41301` (running), unlimited execution time, 999
    one-minute failure restarts, and `StartWhenAvailable`; rotating gateway log
    was 5.1 MB with 44.9 GB disk free during the latest audit.

## Rollback

- Gateway/config/launcher backup:
  `C:\opomtsocket-go\backups\audit-20260801-044948`
- Latest Caddy backups:
  `C:\Caddy\Caddyfile.audit-health-20260801-1102.bak` and
  `C:\Caddy\sites\opotrade-ui-new.audit-health-20260801-1102.bak`
  (the earlier cache-policy backups are retained with the `audit-cache` name).
- Frontend uses a health-checked atomic junction deployment; prior release
  remains under `C:\sites\opotrade-ui-new\releases`.

## Requirement-to-evidence matrix

| Requested area | Evidence and outcome | Status |
|---|---|---|
| Architecture and codebase inspection | Gateway composition, MT5 session/circuit layers, REST mounting/middleware, WebSocket hub/poller, persistence, React providers/stores, broker adapter, datafeed, order widgets, deployment scripts, and CI were traced and hardened. | Complete for both repositories |
| Production deployment | Caddy/IIS routing, loopback listeners, Windows task activation, firewall rules, TLS/security headers, CORS, WebSocket route, health/readiness, private metrics, file ACLs, and rollback paths were checked read-only. | Complete; service healthy |
| API validation | The mock-only production-shape suite exercises every documented REST family, all auth/ownership/manager boundaries, status codes, transforms, CORS, rate limiting, and metrics: 120/120 pass. | Complete without live mutation |
| WebSocket validation | JWT/account ownership, all four stream families, invalid subscriptions, continuous push, reconnect/offline recovery, stale reporting, queue backpressure, shutdown, fan-out, and race behavior have automated coverage. | Complete in safe scope |
| TradingView integration | Symbol/quote/history contracts, M1 aggregation, realtime OHLCV merge, timeframe changes, loader retry, broker connectivity, order/position mapping, and confirmation gating have regression coverage; licensed assets and rendered startup were verified. | Complete in safe scope |
| Trading lifecycle | Login → accounts → symbols → quotes → chart → place/modify/cancel/close-shaped requests → history/positions/account/deals → logout is covered by mocks and component tests. Production validation stopped at unauthenticated/read-only boundaries. | Broker execution certification gated on demo account |
| Stability and concurrency | Full Go race suite, 100-client shared-poll load, atomic topic handoff, nonblocking latest-wins queues, bounded/amortized idempotency cleanup, frontend socket teardown/recovery, and state sequencing all pass. | Complete for tested load; soak remains gated |
| Security | JWT issuer/audience, account ownership, manager-key isolation, secure confirmation, CORS, TLS, headers, raw-port closure, private metrics, rate limiting, secret ACLs, tracked-secret review, and dependency scans were verified. | Complete; no known critical/high finding |
| Performance | One upstream poll per subscription cadence regardless of 100 clients, nonblocking fan-out, amortized idempotency expiry, lazy React chunks, state freshness guards, and production bundle sizing were verified. | Complete for benchmarked paths |
| UX and recovery | Safe confirmations, accepted-vs-filled wording, rejection feedback, loaders, connection/stale states, offline/online replacement, browser refresh cache coherence, and current rendered sign-in were verified. | Authenticated broker UX review gated on demo account |
| Production reliability | Atomic frontend release, rollback scripts, concurrent listener drain, scheduler cancellation, MT5 readiness, browser/CDN cache coherence, and restart health were exercised. | Complete for single-node production topology |
| Code quality and operations | Configuration/docs/OpenAPI/CI/Caddy templates were aligned; tests, typecheck, format, lint, vet, build, audits, hashes, backups, and residual limits are documented. | Complete |

## Residual limitations

1. Redis is currently unavailable. The running single gateway uses its tested
   in-process rate limiter and idempotency store. Before horizontal gateway
   replicas are introduced, deploy a durable Redis service and alert on
   `rate_limit_fail_open_total`; otherwise limits and idempotency are not shared
   between replicas.
2. Live trade mutation was intentionally not tested. Order payloads, ownership,
   idempotency, and lifecycle mappings passed against mocks, but a controlled
   demo MT5 account is still required for broker-side execution certification.
3. Frontend lint has eight existing Fast Refresh organization warnings and no
   errors. They do not affect the production bundle.
4. A multi-hour/multi-day authenticated soak and broker disaster-recovery drill
   require approved test accounts and an operational test window; they were not
   simulated against customer accounts.
5. Cloudflare injects its JavaScript-detection snippet into the stage hostname's
   HTML response. The terminal still loads because its own scripts are external,
   but the strict CSP intentionally blocks Cloudflare's inline detector. Disable
   JavaScript Detections/Bot challenge injection for this trading hostname in
   Cloudflare rather than weakening the application's CSP with `unsafe-inline`.
6. `OpoMonitoring` is a same-host dashboard that probes only when opened or
   manually rechecked. An independent external HTTPS probe and alert receiver is
   still required to detect a host, network, TLS, Caddy, or gateway outage.
7. The active production binary was built from the audited dirty worktree and
   therefore reports `modified="true"`. After review and commit, publish a clean,
   checksum-verified CI artifact so the revision is exactly reproducible.
