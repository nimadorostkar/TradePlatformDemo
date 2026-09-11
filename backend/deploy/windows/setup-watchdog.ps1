# Register bounded gateway liveness supervision and Caddy crash recovery.
# Run from elevated PowerShell after setup-service.ps1.
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\opomtsocket-go",
  [string]$GatewayTask = "OpoGatewayGo",
  [string]$WatchdogTask = "OpoGatewayWatchdog",
  [int]$Port = 5070
)
$ErrorActionPreference = "Stop"

$watchdog = Join-Path $InstallDir "watchdog.ps1"
if (-not (Test-Path $watchdog)) { throw "$watchdog not found" }
if (-not (Get-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue)) {
  throw "gateway task $GatewayTask is not registered"
}

# Prove the script sees the currently healthy listener before scheduling it.
& $watchdog -InstallDir $InstallDir -GatewayTask $GatewayTask -Port $Port
if ($LASTEXITCODE -ne 0) { throw "watchdog healthy-path preflight failed" }

$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallDir "{1}" -GatewayTask "{2}" -Port {3}' -f $watchdog, $InstallDir, $GatewayTask, $Port
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

$definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $WatchdogTask -InputObject $definition -Force | Out-Null
Start-ScheduledTask -TaskName $WatchdogTask

# Windows does not restart an ordinary auto-start service after a crash unless
# failure actions are explicit. This changes recovery policy only; it does not
# restart the currently running reverse proxy.
if (Get-Service -Name "Caddy" -ErrorAction SilentlyContinue) {
  sc.exe failure Caddy reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not configure Caddy failure actions" }
  sc.exe failureflag Caddy 1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not enable Caddy non-crash failure actions" }
}

Write-Host "Gateway watchdog registered (three consecutive local liveness failures)." -ForegroundColor Green
Write-Host "Caddy crash recovery configured; no service was restarted." -ForegroundColor Green
