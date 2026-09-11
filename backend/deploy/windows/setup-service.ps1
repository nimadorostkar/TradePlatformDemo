# Register the gateway as a durable Windows scheduled task and start it. The
# gateway stays behind the TLS reverse proxy unless -ExposePort is explicit.
# Run after placing gateway.exe, run.ps1, gateway.env, and
# protect-config.ps1 in C:\opomtsocket-go\.
# Elevated PowerShell:  .\setup-service.ps1
param(
  [int]$Port    = 5070,
  [string]$Dir  = "C:\opomtsocket-go",
  [string]$Task = "OpoGatewayGo",
  [switch]$ExposePort
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path "$Dir\gateway.exe"))       { throw "$Dir\gateway.exe not found (build with: make build-windows, then copy it here)" }
if (-not (Test-Path "$Dir\run.ps1"))           { throw "$Dir\run.ps1 not found" }
if (-not (Test-Path "$Dir\gateway.env"))       { throw "$Dir\gateway.env not found (copy gateway.env.example and fill the values)" }
if (-not (Test-Path "$Dir\protect-config.ps1")){ throw "$Dir\protect-config.ps1 not found" }

Write-Host "==> Restricting gateway.env to SYSTEM and Administrators"
& "$Dir\protect-config.ps1" -Config "$Dir\gateway.env"

if ($ExposePort) {
  Write-Host "==> Firewall: explicitly exposing inbound TCP $Port" -ForegroundColor Yellow
  if (-not (Get-NetFirewallRule -DisplayName "OpoGatewayGo $Port" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "OpoGatewayGo $Port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  }
} else {
  Write-Host "==> Firewall: keeping TCP $Port private (use the TLS reverse proxy)"
  Get-NetFirewallRule -DisplayName "OpoGatewayGo $Port" -ErrorAction SilentlyContinue | Disable-NetFirewallRule
}

Write-Host "==> Scheduled task '$Task' (startup, SYSTEM, durable restart policy)"
# Do not use `schtasks /create` here. Its default task settings include a
# three-day execution limit, which silently stops a healthy long-running
# gateway with result 0x41306. Build the task explicitly instead.
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}\run.ps1" -Dir "{0}" -Config "{0}\gateway.env"' -f $Dir
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT1M" # let PostgreSQL finish starting after a reboot
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $Task -InputObject $definition -Force | Out-Null

Write-Host "==> Starting now"
Start-ScheduledTask -TaskName $Task

$deadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 2
  try {
    $h = Invoke-RestMethod "http://localhost:$Port/healthz" -TimeoutSec 5
    $r = Invoke-RestMethod "http://localhost:$Port/readyz" -TimeoutSec 5
    if ($h.status -eq "alive" -and $r.status -eq "ready") {
      $registered = Get-ScheduledTask -TaskName $Task
      Write-Host "    /healthz -> $($h.status)" -ForegroundColor Green
      Write-Host "    /readyz  -> $($r.status)" -ForegroundColor Green
      Write-Host "    task     -> $($registered.State), no execution timeout, restart every 1 minute" -ForegroundColor Green
      Write-Host "Up. Browser: http://<server-ip>:$Port/  (status) and /swagger (API console)."
      exit 0
    }
  } catch {
    # Dependencies can take a few seconds to authenticate after boot/deploy.
  }
} while ((Get-Date) -lt $deadline)

Write-Host "    health/readiness check failed - recent logs:" -ForegroundColor Red
Get-Content "$Dir\logs\gateway.log" -Tail 30 -ErrorAction SilentlyContinue
Get-Content "$Dir\boot-err.log" -Tail 30 -ErrorAction SilentlyContinue
throw "Gateway did not become alive and ready within 90 seconds"
