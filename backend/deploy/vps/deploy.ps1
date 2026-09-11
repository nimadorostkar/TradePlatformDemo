# One-shot deploy of the Go gateway on the Windows VPS, alongside .NET.
# Run in an ELEVATED PowerShell (needed for the firewall rule):
#   cd <repo>\deploy\vps ; .\deploy.ps1
$ErrorActionPreference = "Stop"
$port = 5070
$composeDir = Resolve-Path (Join-Path $PSScriptRoot "..\compose")
Set-Location $composeDir

# 1. Config sanity ----------------------------------------------------------
if (-not (Test-Path ".env.prod")) {
  Write-Host "ERROR: .env.prod not found." -ForegroundColor Red
  Write-Host "  copy .env.prod.example .env.prod   then set MT5_PASSWORD and JWT_SECRET_KEY"
  exit 1
}
if ((Get-Content ".env.prod" -Raw) -match "__copy_from|__change_me|__set_me") {
  Write-Host "ERROR: .env.prod still has placeholder secrets." -ForegroundColor Red
  Write-Host "  Set MT5_PASSWORD and JWT_SECRET_KEY from the .NET appsettings.json, then re-run."
  exit 1
}

# 2. Build + start ----------------------------------------------------------
Write-Host "==> Building & starting the Go gateway on port $port (alongside .NET on 5063)..." -ForegroundColor Cyan
docker compose -f docker-compose.prod.yml up -d --build

# 3. Windows firewall (does NOT touch the 5063 rule) ------------------------
Write-Host "==> Ensuring Windows firewall allows inbound TCP $port..." -ForegroundColor Cyan
if (-not (Get-NetFirewallRule -DisplayName "OpoMTSocket Go $port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "OpoMTSocket Go $port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
  Write-Host "    added firewall rule 'OpoMTSocket Go $port'."
} else { Write-Host "    firewall rule already present." }

# 4. Self-check -------------------------------------------------------------
Write-Host "==> Waiting for startup..." -ForegroundColor Cyan
Start-Sleep -Seconds 6
try {
  $h = Invoke-RestMethod "http://localhost:$port/healthz" -TimeoutSec 5
  Write-Host "    /healthz -> $($h.status)" -ForegroundColor Green
} catch {
  Write-Host "    /healthz FAILED -- the container likely crashed on startup. Last logs:" -ForegroundColor Red
  docker logs --tail 50 opotrade-gateway-go
  exit 1
}
try {
  $r = Invoke-RestMethod "http://localhost:$port/readyz" -TimeoutSec 5
  Write-Host "    /readyz  -> $($r.status)" -ForegroundColor Green
} catch {
  Write-Host "    /readyz NOT ready yet (MT5 session). Check: docker logs opotrade-gateway-go" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Local checks passed. In a browser on the VPS: http://localhost:$port/" -ForegroundColor Green
# Discovered rather than hardcoded: this script has to work on whichever host it
# is run from, not only the one it was first written for.
$externalHost = $env:PUBLIC_HOSTNAME
if (-not $externalHost) {
  $externalHost = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    Select-Object -First 1 -ExpandProperty IPAddress)
}
if ($externalHost) {
  Write-Host "External: http://${externalHost}:$port/  (set PUBLIC_HOSTNAME to override)" -ForegroundColor Green
} else {
  Write-Host "External: http://<this-host>:$port/" -ForegroundColor Green
}
Write-Host ""
Write-Host "If localhost:$port works but the external URL does NOT, the block is your" -ForegroundColor Yellow
Write-Host "CLOUD provider firewall -- open inbound TCP $port there (e.g. Hetzner Cloud" -ForegroundColor Yellow
Write-Host "console > Firewalls), the same place TCP 5063 is already allowed." -ForegroundColor Yellow
