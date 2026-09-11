# Operations runbook

## Deploy

### Two supported topologies

There are two ways this terminal is served. Know which one you are touching.

| | **Container** | **Windows + Caddy** |
| --- | --- | --- |
| Files | `Dockerfile`, `deploy/nginx.conf`, `deploy/entrypoint.sh` | `deploy/caddy/opotrade-ui.caddy`, `deploy/windows/deploy.ps1` |
| Configured by | container env vars, applied at start | `runtime-config.js` written by the CI deploy job |
| Gateway/CRM | cross-origin, `connect-src` widened at start | proxied **same-origin** under `/gateway` and `/crm` |
| Used by | portable/reference deployment | **what CI currently ships to production** |

Both serve the same `dist/`, and both must stay working. The important
consequence: **the Content-Security-Policy is written twice** — once in
`deploy/nginx.conf` and once in the Caddy snippet. They are necessarily
separate files in two different config languages, so a change to one **must** be
mirrored in the other. Verify with the `curl -sI ... | grep -i
content-security-policy` check below against whichever origin you deployed.

Everything environment-specific in the Caddy file is an env var
(`OPOTRADE_PUBLIC_ADDRESS`, `OPOTRADE_STAGE_ADDRESS`, `OPOTRADE_SITE_ROOT`,
`OPOTRADE_GATEWAY_UPSTREAM`, `OPOTRADE_CRM_UPSTREAM`, `OPOTRADE_CRM_HOST`) with
the current production value as its default, so moving to another server means
setting variables rather than editing config.

### Prerequisites

1. **Licensed TradingView package.** Not in this repository. CI restores it from
   a private artifact via `TRADINGVIEW_ARTIFACT_URL`, or from a read-only
   artifact host via `TRADINGVIEW_SSH_KEY` + `TRADINGVIEW_HOST` +
   `TRADINGVIEW_USER` + `TRADINGVIEW_KNOWN_HOSTS`. Without one of those the
   build fails its asset check — by design.
2. A reachable Go OpoMTSocket gateway over **HTTPS/WSS**.
3. The CRM base URL.

#### CI credentials and variables

Repository **variables**: `PUBLIC_BASE_URL` (e.g. `https://terminal.example.com`)
and `PUBLIC_HOST` (e.g. `terminal.example.com`) are **required** — the build
job fails fast without them, because these values are compiled into the bundle
as the fallback used when `runtime-config.js` fails to load, and a default would
silently point a new deployment at the previous environment's gateway.
Optional: `DEPLOY_ROOT`, `TRADINGVIEW_ARTIFACT_PATH`.

Repository **secrets** — note the deliberate split:

- `TRADINGVIEW_*` — **read-only** artifact access. Used by `verify`, `build` and
  `e2e`, which run on pull requests.
- `DEPLOY_SSH_KEY` / `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_KNOWN_HOSTS` —
  write access to the production web root. Used **only** by the `deploy` job.

Never reuse the deploy key for artifact restore. A pull request can modify the
restore script, so any secret reachable from it is a secret a contributor can
exfiltrate before review.

> **Transitional state.** No read-only artifact credential is provisioned yet,
> so the workflow currently falls back to `DEPLOY_*` for asset restore — but
> **only on `push`**, never on `pull_request`. The consequence: pull requests
> cannot restore the licensed package and their `verify` job fails at that step.
> Provision `TRADINGVIEW_ARTIFACT_URL` (simplest) or a read-only
> `TRADINGVIEW_SSH_KEY`, then delete the `DEPLOY_*` fallback from
> `.github/workflows/ci.yml`.

#### What the deploy job ships

CI uploads three things, so the host is no longer a place configuration can
drift from the repository:

| Uploaded | To | Notes |
| --- | --- | --- |
| `release.zip` (`dist/`) | `incoming/<sha>.zip` | extracted to `releases/<sha>`, activated by junction swap |
| `deploy/windows/deploy.ps1` | `<DEPLOY_ROOT>/deploy.ps1` | uploaded **before** it is invoked, so the host always runs the script matching the commit |
| `deploy/caddy/opotrade-ui.caddy` | `incoming/<sha>.caddy` | only when `CADDY_CONFIG_PATH` is set |

The Caddy file is deliberately **not** inside the release archive. Everything
under the release directory is served publicly, and a web server's own
configuration must never be reachable over HTTP.

#### Bringing the web server config under CI control

Set the repository variable `CADDY_CONFIG_PATH` to the path Caddy actually
reads on the host (for example `C:/sites/caddy/Caddyfile`). **While it is
unset, deployments do not touch the web server at all** — the behaviour every
release before this had.

Until then the host is hand-maintained, and its real `C:\Caddy\Caddyfile` is
more than this repository's site file: a global `trusted_proxies` block the
gateway's throttle depends on, the tokenised TradingView-artifact path CI
fetches from, a second site on the same box, and the stage site block written
inline rather than imported. `deploy/caddy/Caddyfile.example` is a redacted
copy of that whole file as it was live on 2026-09-04. Any header or cache change
made on the host must be mirrored into `deploy/caddy/opotrade-ui.caddy` (and
`deploy/nginx.conf`) by hand, or the next CI-driven config deploy will silently
undo it.

Once set, each deploy will, in order: validate the new config with
`caddy validate` *before* the live file is touched, back it up to `<path>.bak`,
copy the new one in, `caddy reload`, then run the health check. A validation
failure leaves the live config untouched. A reload failure or a failed health
check restores the backup and reloads again, alongside the release rollback —
the release and the config go out together, so they roll back together.

Requirements on the host: `caddy` on `PATH` (override with `-CaddyExe`), and
the deploy user able to write `CADDY_CONFIG_PATH`. Verify the CSP afterwards
with the `curl -sI` check above — that is the fastest signal that the right
config is live.

### Build and run

```bash
docker build \
  --build-arg TRADINGVIEW_SOURCE_DIR=/tradingview \
  -t web-trading-terminal:$(git rev-parse --short HEAD) .

docker run -d -p 8080:8080 \
  -e APP_ENV=production \
  -e GATEWAY_HTTP_URL=https://gateway.example.com \
  -e GATEWAY_WS_URL=wss://gateway.example.com \
  -e CRM_HTTP_URL=https://crm.example.com \
  -e APP_VERSION="$(git rev-parse --short HEAD)" \
  -e ALLOWED_HOST_ORIGINS="https://client.example.com" \
  web-trading-terminal:$(git rev-parse --short HEAD)
```

`ALLOWED_HOST_ORIGINS` sets both the postMessage allowlist and the CSP
`frame-ancestors`. Leave it unset unless the terminal is genuinely embedded —
unset means "not embeddable", which is the clickjacking protection.

### Verify a deploy

```bash
curl -f https://terminal.example.com/healthz               # {"status":"ok"}
curl -sI https://terminal.example.com | grep -i content-security-policy
curl -sI https://terminal.example.com/charting_library/charting_library.js | head -1
```

Then in a browser: sign in, confirm the chart renders with **broker** prices,
confirm the header connection badge reads Connected, and open System Messages to
confirm no errors.

### Rollback

Images are tagged by commit SHA; roll back by redeploying the previous tag.

The frontend is stateless. The only client-side state is the workspace layout in
localStorage, which is versioned and migrated forward — a rollback to a build
with an older schema will find a `schemaVersion` it does not recognise, discard
the document, and start from the default layout. Users keep working; they lose
custom panel arrangements. `migrateWorkspace` returns `null` for any future
version specifically so this is safe rather than corrupting.

---

## Troubleshooting

### The chart does not load

Symptom: "The chart could not be loaded", or a blank centre pane.

1. `curl -I https://terminal.example.com/charting_library/charting_library.js`
   → 404 means the licensed assets were never synced. Rebuild with
   `TRADINGVIEW_SOURCE_DIR` set. `npm run tv:check` should have caught this in CI.
2. Browser console reporting a CSP violation → the library needs
   `script-src 'unsafe-eval'`, `style-src 'unsafe-inline'`, and
   `worker-src blob:`. Check that a proxy or CDN is not rewriting the header.
3. `VITE_TRADINGVIEW_LIBRARY_PATH` must match where nginx serves the library
   (`/charting_library/` by default).

### Prices are frozen but the UI looks alive

It should not look alive — the header and each panel show a `Stale` badge with
an age after 4 missed cadences. If it genuinely looks live:

1. Open **System Messages** → the subscription table lists every channel with
   its state and retry count. (It shows canonical keys, never URLs, because a
   URL would carry the access token.)
2. `auth-expired` → the gateway JWT expired. There is no refresh endpoint; the
   app re-exchanges the CRM token or asks for reauthentication.
3. `failed` after repeated retries → check the gateway's `/readyz` and whether
   MT5 is connected upstream.

### Users see "Session expired" repeatedly

1. Check `JWT_EXPIRY` on the gateway (default 1 h).
2. Confirm the CRM account list call still succeeds — the re-exchange needs the
   CRM token.
3. Confirm `JWT_VALIDATE_ISSUER` / `JWT_VALIDATE_AUDIENCE` on the gateway match
   the tokens actually being issued. A mismatch produces a token that validates
   at issue time and fails on use.

### A user cannot see their account

The selector applies two filters, both intentional:

1. The CRM account **type id** must be in `SUPPORTED_ACCOUNT_TYPE_IDS`
   (`{57–67}`). Types 11 and 26 pass the gateway's own filter but have **no
   defined symbol suffix**, so trading them would send wrong symbol names. See
   discrepancy **D5**.
2. The login must appear in the JWT `accounts` claim, or every account-scoped
   call returns 403.

### An order was submitted but nothing appeared

1. System Messages → find the entry and its `requestId`; correlate with gateway
   logs.
2. If the state was **"outcome unknown — reconciling"**, the request timed out.
   The trade may have executed. **Do not resubmit.** Refresh Positions; the
   authoritative snapshot decides.
3. If the order shows status **Unknown** in Pending Orders, that is discrepancy
   **D3** — the WebSocket stream cannot distinguish filled from rejected. The
   REST snapshot resolves it; it refreshes after every mutation.

### Stop-loss / take-profit show as `Unavailable`

Expected on positions sourced from the WebSocket: `PositionsToTVWs` does not
emit `priceSL`/`priceTP` (discrepancy **D6**). The REST snapshot carries them,
so they appear after the next reconciliation. Showing `0` instead would claim a
protective level that does not exist.

### Layouts reset unexpectedly

Check System Messages for `workspace.recovered`. The message states the exact
validation failure. Causes: a rollback to an older schema, manual localStorage
editing, or a genuine bug in a migration.

---

## Monitoring

The frontend is static; `/healthz` reports only that nginx is serving.

What to watch:

| Signal                | Where                               | Meaning                                   |
| --------------------- | ----------------------------------- | ----------------------------------------- |
| `/healthz`            | load balancer                       | container alive                           |
| gateway `/readyz`     | gateway, **not** from every browser | MT5 authenticated readiness               |
| CSP violation reports | if a report endpoint is configured  | a library upgrade needing a new directive |
| 4xx/5xx on `/api/*`   | gateway logs                        | correlate via `X-Request-Id`              |

**Do not poll `/readyz` from every browser.** It is an operational signal. A
failed probe must never erase valid cached state — mark it stale or unavailable
instead.

---

## Runtime configuration reference

Every value below is applied by `deploy/entrypoint.sh` at **container start**,
so one built image can be retuned for another environment without a rebuild.
An unset value is emitted as an empty string, which the client ignores in
favour of its compiled-in default — so leaving one alone is always safe.

| Variable                     | Required | Notes                                               |
| ---------------------------- | -------- | --------------------------------------------------- |
| `GATEWAY_HTTP_URL`           | ✅       | must be `https://` in production                    |
| `GATEWAY_WS_URL`             | ✅       | must be `wss://` in production                      |
| `CRM_HTTP_URL`               | —        | needed for login and the account list               |
| `APP_ENV`                    | —        | `production` enables the strict checks              |
| `APP_VERSION`                | —        | shown in diagnostics; set to the commit SHA         |
| `BRAND_CONFIG_URL`           | —        | broker branding JSON                                |
| `ALLOWED_HOST_ORIGINS`       | —        | postMessage allowlist **and** CSP `frame-ancestors` |
| `TRADINGVIEW_LIBRARY_PATH`   | —        | defaults to `/charting_library/`                    |
| `DEFAULT_TIMEZONE`           | —        | chart and session clock                             |
| `QUOTE_STALE_AFTER_MS`       | —        | stream staleness threshold; default 4× the 3s cadence |
| `CONFIRM_TRADES`             | —        | omit to keep the production fail-safe (**on**)      |
| `ENABLE_ONE_CLICK_TRADING`   | —        | traders must still arm it per workspace             |
| `ENABLE_LEGACY_AUTH_STORAGE` | —        | **refused in production**, at start and in the app  |

The entrypoint refuses to start on a missing gateway URL, a plaintext URL in
production, or legacy auth storage in production. That is intentional: a
terminal that cannot reach its gateway, or one silently downgraded, should not
serve traffic.

Lowering `QUOTE_STALE_AFTER_MS` also tightens the socket-replacement window.
The pool clamps its internal stability deadline to stay inside it, so the retry
budget can always reset — do not reintroduce a fixed deadline there.

---

## Safe testing against a live gateway

```bash
CONTRACT_GATEWAY_URL=https://staging-gateway.example.com \
CONTRACT_GATEWAY_TOKEN=<staging-jwt> \
CONTRACT_LOGIN=<demo-login> \
npm run test:contract
```

Read endpoints only: health, server time, symbols, quotes, bars, account
snapshot, positions, orders. The suite **refuses to run** if the URL looks like
production. There is no transactional contract test; adding one would require a
dedicated disposable demo account and a separate explicit authorisation flag.
