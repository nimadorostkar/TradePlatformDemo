# Liveness watchdog for the native Windows gateway.
#
# It deliberately ignores /readyz: the MT5 Manager owns readiness recovery and
# restarting during a broker outage would make recovery worse. Only three
# consecutive failures of the local /healthz listener trigger a restart.
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\opomtsocket-go",
  [string]$GatewayTask = "OpoGatewayGo",
  [int]$Port = 5070,
  [ValidateRange(2, 20)]
  [int]$FailureThreshold = 3,
  [int]$RecoveryTimeoutSeconds = 90,
  [string]$StateFile = "",
  [string]$LogFile = ""
)
$ErrorActionPreference = "Stop"

if (-not $StateFile) { $StateFile = Join-Path $InstallDir "watchdog-failures.txt" }
if (-not $LogFile) { $LogFile = Join-Path $InstallDir "logs\watchdog.log" }
$gatewayExe = Join-Path $InstallDir "gateway.exe"

New-Item (Split-Path $StateFile -Parent) -ItemType Directory -Force | Out-Null
New-Item (Split-Path $LogFile -Parent) -ItemType Directory -Force | Out-Null

function Write-WatchdogLog {
  param([string]$Message)
  # Keep this operational fallback bounded even when no log shipper exists.
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -ge 1MB) {
    Move-Item $LogFile "$LogFile.1" -Force
  }
  Add-Content $LogFile ("{0:o} {1}" -f (Get-Date), $Message)
}

function Reset-Failures {
  Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
}

try {
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 5
  if ($health.status -eq "alive") {
    Reset-Failures
    exit 0
  }
  $failureReason = "unexpected health status '$($health.status)'"
} catch {
  $failureReason = $_.Exception.Message
}

$failures = 0
if (Test-Path $StateFile) {
  [void][int]::TryParse((Get-Content $StateFile -Raw).Trim(), [ref]$failures)
}
$failures++
Set-Content $StateFile $failures -Encoding ascii
Write-WatchdogLog "liveness failure $failures/${FailureThreshold}: $failureReason"

if ($failures -lt $FailureThreshold) { exit 0 }

Write-WatchdogLog "threshold reached; restarting scheduled task $GatewayTask"
schtasks /End /TN $GatewayTask 2>$null | Out-Null
Start-Sleep -Seconds 3

# End may leave the child behind. Stop only this installation's executable;
# never kill every process named gateway on a shared host.
Get-CimInstance Win32_Process -Filter "Name='gateway.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq [IO.Path]::GetFullPath($gatewayExe)) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

schtasks /Run /TN $GatewayTask | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-WatchdogLog "restart command failed with exit code $LASTEXITCODE"
  exit 1
}

$deadline = (Get-Date).AddSeconds($RecoveryTimeoutSeconds)
do {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 5
    if ($health.status -eq "alive") {
      Reset-Failures
      $ready = "unknown"
      try { $ready = (Invoke-RestMethod "http://127.0.0.1:$Port/readyz" -TimeoutSec 5).status } catch { $ready = "not-ready" }
      Write-WatchdogLog "gateway recovered; liveness=alive readiness=$ready"
      exit 0
    }
  } catch { }
} while ((Get-Date) -lt $deadline)

Write-WatchdogLog "gateway did not recover liveness within ${RecoveryTimeoutSeconds}s"
exit 1
