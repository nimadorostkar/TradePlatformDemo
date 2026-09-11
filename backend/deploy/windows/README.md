# Native Windows deployment (no Docker)

This is **how the gateway is actually deployed in production** on the VPS
`46.62.247.67` (Windows Server 2022) — a single native `.exe`, alongside the .NET
service, with a local PostgreSQL. Docker isn't installed there and isn't needed:
the gateway is a self-contained static binary.

| Service | Port | Notes |
|---|---|---|
| .NET gateway (unchanged) | 5063 | keeps running |
| **Go gateway (this)** | **5070** | native exe, scheduled task |
| PostgreSQL 16 | 5432 (localhost only) | price-history store |

Layout on the server: `C:\opomtsocket-go\` (`gateway.exe`, `run.ps1`, the
ACL-protected `gateway.env`, `logs\gateway.log`), `C:\PostgreSQL\` (DB binaries
and data).

## Steps

### 1. Build the Windows binary (on a dev machine with Go)
```bash
make build-windows        # -> bin/gateway.exe  (CGO-free static linux→windows cross-compile)
```

### 2. Copy to the server
Copy `bin/gateway.exe`, `gateway.env.example`, and this folder's `*.ps1` to
`C:\opomtsocket-go\` on the VPS. Rename `gateway.env.example` → `gateway.env`.

### 3. Configure and protect production values
Fill `JWT_SECRET_KEY`, `MT5_LOGIN`, `MT5_PASSWORD` (copy from the .NET
`appsettings.json` so tokens are shared and creds match), and the `opo` DB
password (step 4) in `gateway.env`. Then restrict the file:

```powershell
.\protect-config.ps1 -Config C:\opomtsocket-go\gateway.env
```

Only `SYSTEM` and local Administrators retain access. Secrets are no longer
embedded in an executable batch file.

### 4. Install PostgreSQL (elevated PowerShell)
```powershell
.\install-postgresql.ps1 -PgSuperPassword '<strong>' -OpoPassword '<strong-opo>'
```
Installs Postgres 16 from the EDB ZIP binaries (the GUI installer fails headless),
registers an auto-start service, and creates the `market` + `trading_ops`
databases. Put the same `-OpoPassword` into `gateway.env`'s DSNs. The gateway creates
the tables automatically on startup (migrations).

### 5. Register + start the gateway
```powershell
.\setup-service.ps1
.\setup-watchdog.ps1
```
Keeps 5070 private by default, creates the scheduled task `OpoGatewayGo`
(onstart, SYSTEM, **60 s delay** so Postgres is ready first), explicitly removes
the Windows default 72-hour execution limit, retries failures every minute,
starts it, and checks health/readiness.

`setup-watchdog.ps1` adds a once-per-minute local liveness probe. It restarts
the task only after three consecutive `/healthz` failures and intentionally
does not restart on `/readyz`/MT5 outages. It also gives the Caddy Windows
service bounded crash recovery without restarting the running proxy during
installation.

### 6. (Optional) Migrate price history from SQL Server
```powershell
.\migrate-price-history.ps1 -PgPassword '<opo-password>'          # rehearsal → market_staging
.\migrate-price-history.ps1 -PgPassword '<opo-password>' -PgDb market  # real run
```
Exports `Symbolwisepricehistorydata`/`Symboldailydata` from the .NET
`OpoFinance` DB, dedupes on `(Symbol, Time)` keeping the latest row (the old
schema allows duplicates; the Postgres PK does not), upserts into Postgres,
then verifies row counts and spot-checks values. Rehearse against
`market_staging` (the default) first. Not required for launch — the price
store starts empty and the daily job backfills going forward.

### 6. Verify
```powershell
curl http://localhost:5070/healthz   # {"status":"alive"}
curl http://localhost:5070/readyz    # {"status":"ready"}  (once MT5 auth succeeds)
```
External traffic must use the HTTPS reverse proxy. Only pass `-ExposePort` to
`setup-service.ps1` for a time-bounded migration that explicitly requires raw
port access; plaintext 5070 is not a production client endpoint.

## Operate

```powershell
schtasks /query /tn OpoGatewayGo            # status
schtasks /query /tn OpoGatewayWatchdog      # liveness supervisor
schtasks /end  /tn OpoGatewayGo             # stop
schtasks /run  /tn OpoGatewayGo             # start
Get-Content C:\opomtsocket-go\logs\gateway.log -Tail 50
```

### Log diagnostics

`diagnostics\` holds the read-only PowerShell one-offs that have been written on
the box during incidents and are worth keeping. Copy them next to `gateway.exe`
(they hard-code `C:\opomtsocket-go\`) and run in any PowerShell — none of them
change state.

| Script | Answers |
| --- | --- |
| `diagnostics\forensic.ps1` | log size, rotation count, and the first occurrence of every distinct WARN/ERROR message |
| `diagnostics\episodes.ps1` | groups `mt5 ping re-auth failed` events into outage episodes and shows the retry gap (a constant gap means no backoff) — the broker-side 403-flap signature |
| `diagnostics\history-coverage.ps1` | row count and time span banked in `daily_data` for `EURUSD!` plus the last `banked` log lines (reads the DSN from `gateway.env`; needs `psql.exe`) |
| `diagnostics\gaplog.ps1` | the last dozen daily-history segment/backfill log lines |

## Update the binary

Use `update.ps1` rather than the manual swap below — it validates the new binary
before stopping the service, keeps the previous one, and **rolls back
automatically** if `/healthz` does not come up.

```powershell
# On a dev machine:
make build-windows                      # -> bin/gateway.exe
# copy bin\gateway.exe to the server as C:\opomtsocket-go\gateway.new.exe, then
# in an ELEVATED PowerShell on the server:
cd C:\opomtsocket-go
.\update.ps1 -BinaryPath C:\opomtsocket-go\gateway.new.exe
.\smoke-test.ps1
```

If the repo and the Go toolchain are on the server, `.\update.ps1 -Branch <name>`
pulls, tests, and builds there instead.

<details>
<summary>Manual swap (no validation, no rollback)</summary>

```powershell
schtasks /end /tn OpoGatewayGo ; taskkill /F /IM gateway.exe
# copy the new gateway.exe to C:\opomtsocket-go\
schtasks /run /tn OpoGatewayGo
```
</details>

### ⚠️ Before the next update: account types

The gateway's default account-type allowlist is now **57–67 only**. The previous
behavior also admitted **11 and 26**, which have no confirmed symbol suffix.

A trader whose *only* accounts are type 11 or 26 will receive a token with no
accounts claim and be **401'd on every protected endpoint** — locked out.

`gateway.env.example` therefore ships `CRM_ALLOWED_ACCOUNT_TYPES` set to the
**previous** list, so the update itself changes nothing. Tighten it deliberately
once the suffixes for 11/26 are confirmed and added to
`CRM_ACCOUNT_TYPE_SUFFIXES`. `update.ps1` refuses to proceed silently if the
setting is missing from `gateway.env`.

### Post-update verification

`smoke-test.ps1` is read-only — it places no trade, creates no alert, and writes
no workspace.

```powershell
.\smoke-test.ps1                                     # localhost
.\smoke-test.ps1 -BaseUrl https://opotrade-stage-backend.opofinance.com
.\smoke-test.ps1 -CrmEmail <email> -CrmPassword <pw>  # adds the authed checks
```

Two failures it looks for that are otherwise silent:

- **`crossed: true` from `/api/Tick/get_marketdepth`** — `MT5_BOOK_SIDE_CONVENTION`
  is wrong for this broker. Flip it between `mql5` and `manager`. Until then the
  DOM misstates which side of the book has liquidity.
- **an implausible `volume_min_lots`** — the volume unit scaling is wrong. This is
  the failure that once demanded a 100-lot minimum and blocked all trading.

### New in this release

Alerts and workspace persistence create two tables (`price_alerts`,
`workspaces`) in `POSTGRES_DSN` on first start — additive
`CREATE TABLE IF NOT EXISTS`, no existing table is touched. With no DSN set both
features report themselves off through `GET /api/Capabilities` rather than
accepting data they cannot keep.

## Reboot behavior
Postgres service = AUTO_START; the gateway task = onstart + 60 s delay → DB is up
before the gateway connects. The gateway connects to the DB once at startup; if
the DB is unreachable it runs **API-only** (live MT5 only, no price-history) and a
restart re-attaches it.

## Hardening after the .NET service is retired
In `gateway.env`: `WS_REQUIRE_AUTH=true`,
`CORS_ALLOWED_ORIGINS=https://app.opofinance.com,...`,
`JWT_VALIDATE_ISSUER=true`, `JWT_VALIDATE_AUDIENCE=true`; then
`schtasks /end /tn OpoGatewayGo ; schtasks /run /tn OpoGatewayGo`.

> Docker/compose path (for a Linux host) is in [`../compose/`](../compose/) and
> [`../docker/`](../docker/); k8s in [`../k8s/`](../k8s/).
