# Production hardening — 2026-08-01

## Safety boundary

Production checks were read-only. No authenticated order, position, balance,
or account mutation was sent. Mutation-shaped UI/API behavior was verified only
with unit tests, Playwright mocks, and the gateway's bundled mock services.

## Changes

- Production trade confirmation now fails safe when configuration is omitted,
  and a persisted workspace preference cannot disable a required confirmation.
- Higher TradingView intraday resolutions aggregate M1 history and realtime
  samples into aligned, stateful OHLCV buckets. Repeated M1 samples replace the
  active minute rather than double-counting volume.
- REST/WebSocket reconciliation now preserves frames received during a fetch,
  prevents older concurrent responses from rolling state backward, refreshes
  after recovered streams, and retains buffered live state when REST fails.
- Browser offline/online events tear down and replace sockets deterministically;
  silent half-open sockets replace themselves after surfacing stale state, and
  non-JSON proxy/error frames reconnect without refreshing data timestamps.
  Retry, stale, and stability timers are scoped to their physical socket.
- Browser WebSocket JWTs no longer appear in connection URLs. The pool sends
  `opotrade.jwt.<JWT>` as a credential subprotocol while the gateway negotiates
  only `opotrade.v1`; production rejects the legacy `access_token` query path.
- TradingView broker connectivity and tradability require the account, order,
  and position streams to all be connected. Failed library script loads can be
  retried without refreshing the page.
- Runtime configuration is an external CSP-compatible script. Container files
  are owned by the unprivileged Nginx user, and Nginx config substitution writes
  through `/tmp` without granting write access to `/etc/nginx`.
- Windows Caddy serves both public origins from the same atomic release with
  same-origin gateway/CRM proxies. HTML, SPA fallbacks, and runtime metadata are
  no-store; the runtime-config URL is release-versioned to avoid stale CDN or
  browser pairings.
- The production CI runtime config derives HTTP, WebSocket, and CRM routes from
  `window.location`, so one release works consistently on the hostname and IP.
- Long-running sessions renew the gateway JWT before expiry using the retained
  CRM credential. Transient renewal failures retry only while the current JWT
  remains valid, and every token change replaces or tears down authenticated
  WebSockets.
- Account discovery now fails closed when the JWT account claim is absent or
  malformed. Renewal invalidates and reloads the account list, and replaces an
  active login removed by the new claim before further scoped requests.
- Rejected credential query parameters are removed from browser history. Logout
  clears trading snapshots, quotes, capabilities, symbol metadata, and query
  cache so data cannot flash across sessions.
- Corrected invalid GitHub Actions references to the current supported checkout,
  Node setup, and artifact-download major versions so verification, build, E2E,
  and atomic deployment jobs can start successfully.

## Verification

- 340 unit/component tests passed.
- TypeScript, Prettier, licensed TradingView asset verification, production
  Vite build, and ESLint passed (zero errors; eight pre-existing Fast Refresh
  organization warnings).
- Full npm audit: zero vulnerabilities.
- Pinned actionlint 1.7.12 validates the complete CI/deployment workflow.
- Production main application chunk: 457.39 kB, 136.86 kB gzip.
- A fresh rendered-browser check loaded the release-candidate sign-in page,
  versioned runtime configuration, and hashed bundle with zero console errors.
  The exact final artifact then passed atomic health and public asset/version
  verification after the last permission-refresh regression.
- Active production release:
  `76bfb617e842240c16b2076daeb05e71adfed0b4`.
- A synthetic account-less read-only quote stream passed through public WSS,
  negotiated `opotrade.v1`, returned JSON, and kept the credential out of the
  URL. The same valid short-lived JWT was rejected through the disabled legacy
  query-token transport.

## Remaining certification boundary

Broker execution, authenticated long-session soak, and MT5 disaster recovery
still require an approved demo account and maintenance window. They must not be
run against customer accounts.

Cloudflare currently injects its JavaScript-detection snippet into the stage
hostname's HTML. The terminal's strict CSP blocks that inline detector while the
external application scripts continue to load. Disable that bot/challenge
injection for the trading hostname in Cloudflare; do not weaken the terminal CSP
with `unsafe-inline`.
