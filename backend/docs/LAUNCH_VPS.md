# Launch on the VPS (46.62.247.67) — alongside the .NET gateway

> **⚠️ The production VPS has no Docker.** The actual deployment is the **native
> Windows binary** — see [`../deploy/windows/README.md`](../deploy/windows/README.md)
> (`install-postgresql.ps1` → ACL-protected `gateway.env` + `run.ps1` →
> `setup-service.ps1`). This document's
> Docker/compose steps are the path for a **Linux** host. Both deploy the same
> coexistence config below.


Goal: run the **Go gateway in Docker on the existing Windows Server 2022 VPS**,
**API-only**, **without touching** the .NET service, the local SQL Server, or any
other service. Both gateways run at the same time:

| | Port | Status |
|---|---|---|
| .NET gateway (unchanged) | **5063** | keeps running |
| Go gateway (new) | **5070** | this guide |

The `.env.prod.example` is tuned for **behavioral parity** with .NET (so existing
clients keep working): unauthenticated `/ws`, username login, any CORS origin,
and the **same JWT secret** so a token works on both. Harden after .NET is retired
(notes are inline in the env file).

## Prerequisites (already true on this VPS)

- The VPS egress IP is **whitelisted** by the MT5 broker (the .NET service uses it).
- **Docker** with Linux-container support (Docker Desktop / WSL2 backend).
- The repo is on the VPS (or copy `deploy/` + the source). Pull the branch:
  `git fetch && git checkout phase3-scaffold`.

## Steps

### 1. Configure

```powershell
cd <repo>\deploy\compose
copy .env.prod.example .env.prod
# edit .env.prod and set:
#   MT5_PASSWORD       = (from the .NET appsettings.json -> MT5Config:password)
#   JWT_SECRET_KEY     = (from the .NET appsettings.json -> Jwt:SecretKey)  ← same value = shared tokens
```

`.env.prod` already has `HTTP_ADDR=:5063` (container-internal), `ENVIRONMENT=production`,
API-only, and the coexistence parity settings. Do not change the port mapping
(`5070:5063`) — that's what keeps it off the .NET port.

### 2. Build + run

**Easiest — the one-shot script** (elevated PowerShell; builds, runs, opens the
Windows firewall for 5070, and self-checks):

```powershell
cd <repo>\deploy\vps
.\deploy.ps1
```

It refuses to start if `.env.prod` still has placeholder secrets, and prints the
container logs if startup fails — so you get a clear reason, not a silent crash.

**Or manually:**

```powershell
cd <repo>\deploy\compose
docker compose -f docker-compose.prod.yml up -d --build
```

This builds the image from source (Go 1.26 multi-stage → distroless) and starts
`opotrade-gateway-go` on host port **5070**, `restart: unless-stopped`.

> **In a browser:** `http://46.62.247.67:5070/` now shows a live status page
> (green/red liveness + readiness), and `http://46.62.247.67:5070/swagger` is a
> full API console. Use these to confirm it's up — **not** `/` expecting the API.

> **Offline / no build deps?** Use the prebuilt binary instead:
> 1. Copy `bin/gateway-linux` (provided) to `deploy\docker\gateway` on the VPS.
> 2. `docker build -f ..\docker\Dockerfile.prebuilt -t opotrade-gateway:prod ..\docker`
> 3. In `docker-compose.prod.yml` remove the `build:` block (keep `image:`), then
>    `docker compose -f docker-compose.prod.yml up -d`.

### 3. Open the firewall for the new port (does not touch the 5063 rule)

```powershell
New-NetFirewallRule -DisplayName "OpoMTSocket Go 5070" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 5070
```

### 4. Verify (the VPS IP is whitelisted, so MT5 data works here)

```powershell
# liveness + readiness (ready once the MT5 session authenticates)
curl http://localhost:5070/healthz      # {"status":"alive"}
curl http://localhost:5070/readyz       # {"status":"ready"}

# logs
docker logs --tail 50 opotrade-gateway-go

# a real authed call — login is CRM-only, so exchange a CRM token first:
$crm = (curl -s -X POST http://localhost:5070/api/Authentication/crmlogin `
  -H "Content-Type: application/json" -d '{\"email\":\"<crm-email>\",\"password\":\"<crm-password>\"}' `
  | ConvertFrom-Json).token
$tok = (curl -s -X POST http://localhost:5070/api/Authentication/login `
  -H "Content-Type: application/json" -d ('{\"Username\":\"smoke\",\"CRMToken\":\"' + $crm + '\"}') `
  | ConvertFrom-Json).token
curl -s -H "Authorization: Bearer $tok" "http://localhost:5070/api/Tick/last?symbol=EURUSD&source=tv"
```

Externally: `http://46.62.247.67:5070/healthz` and the same `/api/...` paths the
.NET service exposes — now also served by the Go gateway on `:5070`.

If `/readyz` stays `not_ready`: check `docker logs` for MT5 auth errors (403 =
the broker rejected the source IP; should not happen on this whitelisted VPS).

## Run both gateways in parallel (cutover plan)

1. Point a **small slice** of client traffic (or a test client) at `:5070` and
   compare responses to `:5063` — they should be byte-identical (`source=mt5`) or
   the documented TV shapes (`source=tv`). The shared JWT secret means tokens
   work on both.
2. Increase the `:5070` share gradually (LB/DNS weight).
3. When confident, cut over fully, then **harden** `.env.prod`
   (`WS_REQUIRE_AUTH=true`,
   `CORS_ALLOWED_ORIGINS=<allowlist>`, `JWT_VALIDATE_ISSUER/AUDIENCE=true`) and
   restart: `docker compose -f docker-compose.prod.yml up -d`.
4. Optionally add TimescaleDB later for price-history ingestion (set
   `TIMESCALE_DSN`, run the `jobs` role) — see [`LAUNCH.md`](LAUNCH.md).

## Operate

```powershell
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f
docker compose -f docker-compose.prod.yml restart
docker compose -f docker-compose.prod.yml down      # stop/remove (does not affect .NET)
```

Updating: `git pull` → `docker compose -f docker-compose.prod.yml up -d --build`.

## Safety: what this does NOT touch

- The .NET `OpoMTSocketProd` scheduled task and its port **5063** — untouched.
- The local SQL Server / `OpoFinance` DB — not used (API-only).
- Any firewall rule other than the new **5070** inbound rule.
- Rollback: `docker compose ... down` removes only the Go container; the .NET
  service is unaffected.
