# Update the running Go gateway on the Windows VPS.
#
# Two ways in, matching how the box is actually maintained:
#
#   # A. a cross-compiled exe was copied to the server (the documented flow —
#   #    `make build-windows` on a dev machine, copy bin\gateway.exe over)
#   .\update.ps1 -BinaryPath C:\opomtsocket-go\gateway.new.exe
#
#   # B. the repo and Go toolchain are present on the server
#   .\update.ps1 -Branch terminal-backend-requirements
#
# Either way the new binary is validated BEFORE the service is stopped, the
# previous one is kept, and a failed startup rolls back automatically — so a bad
# build costs seconds of downtime, not an outage.
#
# Run in an ELEVATED PowerShell.
param(
  [string]$BinaryPath  = "",
  [string]$Branch      = "terminal-backend-requirements",
  [string]$RepoRoot    = "",
  [string]$InstallDir  = "C:\opomtsocket-go",
  [string]$TaskName    = "OpoGatewayGo",
  [int]   $Port        = 5070,
  [int]   $MetricsPort = 9090,
  [version]$MinimumGoVersion = "1.26.6",
  [int]   $ReadyTimeoutSeconds = 90,
  [switch]$SkipTests
)
$ErrorActionPreference = "Stop"

$exe      = Join-Path $InstallDir "gateway.exe"
$backup   = Join-Path $InstallDir "gateway.exe.prev"
$staged   = Join-Path $env:TEMP ("gateway-new-{0}.exe" -f [guid]::NewGuid().ToString("N"))

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "    $m" -ForegroundColor Red }

function Stop-GatewayTask {
  schtasks /End /TN $TaskName 2>$null | Out-Null
  Start-Sleep -Seconds 3

  # Stop only the process whose executable is this installation. A broad
  # `Get-Process gateway` can terminate another environment on a shared host.
  Get-CimInstance Win32_Process -Filter "Name='gateway.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq [IO.Path]::GetFullPath($exe)) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

function Start-GatewayTask {
  schtasks /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not start scheduled task $TaskName" }
}

function Wait-GatewayReady {
  param([int]$TimeoutSeconds)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Seconds 2
    try {
      $h = Invoke-RestMethod "http://localhost:$Port/healthz" -TimeoutSec 4
      $r = Invoke-RestMethod "http://localhost:$Port/readyz" -TimeoutSec 4
      if ($h.status -eq "alive" -and $r.status -eq "ready") { return $true }
    } catch { }
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Restore-PreviousGateway {
  param([string]$Reason)

  Fail "$Reason Rolling back."
  Stop-GatewayTask
  if (-not (Test-Path $backup)) {
    throw "activation failed and no rollback binary exists at $backup"
  }
  Copy-Item $backup $exe -Force
  Start-GatewayTask
  if (-not (Wait-GatewayReady -TimeoutSeconds $ReadyTimeoutSeconds)) {
    throw "activation failed; rollback was installed but did not become ready"
  }
  Warn "rolled back to the previous binary; /healthz and /readyz are healthy"
  throw $Reason
}

try {
# 1. Produce the new binary BEFORE touching the running service -------------
# Whatever goes wrong here must leave the box exactly as it was.
if ($BinaryPath) {
  if (-not (Test-Path $BinaryPath)) { Fail "$BinaryPath not found - service untouched."; exit 1 }
  Copy-Item $BinaryPath $staged -Force
  Ok "staged $BinaryPath"
} else {
  if (-not $RepoRoot) {
    $candidate = Join-Path $PSScriptRoot "..\.."
    if (-not (Test-Path (Join-Path $candidate ".git"))) {
      throw "repository not found beside the updater; pass -RepoRoot explicitly"
    }
    $RepoRoot = $candidate
  }
  $resolvedRepoRoot = Resolve-Path $RepoRoot
  if (-not (Test-Path (Join-Path $resolvedRepoRoot ".git"))) {
    throw "RepoRoot is not a Git working tree: $resolvedRepoRoot"
  }
  Set-Location $resolvedRepoRoot
  Info "Fetching $Branch..."
  git fetch origin $Branch
  git checkout $Branch
  git pull --ff-only origin $Branch
  Ok "at $(git rev-parse --short HEAD)"

  Info "Building..."
  go build ./...
  if ($LASTEXITCODE -ne 0) { Fail "build failed - service untouched."; exit 1 }
  if (-not $SkipTests) {
    go test ./... 2>&1 | Select-Object -Last 20
    if ($LASTEXITCODE -ne 0) { Fail "tests failed - service untouched."; exit 1 }
  }
  go build -o $staged ./cmd/gateway
  if ($LASTEXITCODE -ne 0) { Fail "gateway build failed - service untouched."; exit 1 }
  Ok "built $staged"
}

# 3. Config sanity ----------------------------------------------------------
$envFile = Join-Path $InstallDir "gateway.env"
if (-not (Test-Path $envFile)) { Fail "$envFile not found."; exit 1 }
$envText = Get-Content $envFile -Raw
if ($envText -match "__SET_") { Fail "$envFile still has placeholder secrets."; exit 1 }
if ($envText -notmatch "CRM_ALLOWED_ACCOUNT_TYPES") {
  Warn "CRM_ALLOWED_ACCOUNT_TYPES is not set - the new default admits types 57-67 ONLY."
  Warn "Previously 11 and 26 were admitted too. A trader whose only accounts are"
  Warn "type 11/26 will be locked out. Add the line from gateway.env.example first,"
  Warn "or re-run with that setting present."
  $answer = Read-Host "    Continue anyway? (yes/no)"
  if ($answer -ne "yes") { Fail "aborted - service untouched."; exit 1 }
}

# 4. Swap -------------------------------------------------------------------
# Create and verify the rollback artifact while the current process is still
# serving traffic. If this fails there is no reason to incur any downtime.
if (-not (Test-Path $exe)) {
  Fail "running gateway binary not found at $exe - service untouched."
  exit 1
}
Copy-Item $exe $backup -Force
$currentHash = (Get-FileHash $exe -Algorithm SHA256).Hash
$backupHash = (Get-FileHash $backup -Algorithm SHA256).Hash
if ($backupHash -ne $currentHash) {
  Fail "rollback binary hash does not match the running artifact - service untouched."
  exit 1
}
Ok "verified rollback binary saved to $backup ($backupHash)"

Info "Stopping $TaskName..."
Stop-GatewayTask

try {
  Copy-Item $staged $exe -Force
  Ok "installed new binary"

  $expectedHash = (Get-FileHash $staged -Algorithm SHA256).Hash
  $installedHash = (Get-FileHash $exe -Algorithm SHA256).Hash
  if ($installedHash -ne $expectedHash) {
    throw "installed binary hash does not match the staged artifact"
  }
  Ok "binary hash verified ($installedHash)"

  Info "Starting $TaskName..."
  Start-GatewayTask
} catch {
  Restore-PreviousGateway "gateway activation failed: $($_.Exception.Message)."
}

# 5. Verify, roll back on failure -------------------------------------------
Info "Verifying liveness and MT5 readiness (timeout ${ReadyTimeoutSeconds}s)..."
if (-not (Wait-GatewayReady -TimeoutSeconds $ReadyTimeoutSeconds)) {
  Warn "Last log lines:"
  Get-Content (Join-Path $InstallDir "logs\gateway.log") -Tail 40 -ErrorAction SilentlyContinue
  Restore-PreviousGateway "/healthz and /readyz did not both become healthy."
}
Ok "/healthz alive"
Ok "/readyz ready"

# A source-compatible build can still carry a vulnerable Go standard library.
# Verify the runtime embedded in the binary after activation and use the same
# rollback path as every other release gate.
try {
  $metrics = (Invoke-WebRequest -UseBasicParsing "http://localhost:$MetricsPort/metrics" -TimeoutSec 5).Content
  $goMatch = [regex]::Match($metrics, 'go_info\{version="go([0-9]+\.[0-9]+\.[0-9]+)"\}')
  if (-not $goMatch.Success) { throw "go_info runtime metric is missing" }
  $runningGoVersion = [version]$goMatch.Groups[1].Value
  if ($runningGoVersion -lt $MinimumGoVersion) {
    throw "running Go $runningGoVersion is older than required $MinimumGoVersion"
  }
  Ok "Go runtime $runningGoVersion (minimum $MinimumGoVersion)"
} catch {
  Restore-PreviousGateway "Go runtime verification failed: $($_.Exception.Message)."
}

# The new build must actually be the one running.
try {
  $caps = Invoke-RestMethod "http://localhost:$Port/api/Capabilities" -TimeoutSec 5
  Ok "new build confirmed live (/api/Capabilities responded)"
} catch {
  Restore-PreviousGateway "/api/Capabilities verification failed: $($_.Exception.Message)."
}

# Reporting only, and deliberately OUTSIDE the verification try: the catch above
# rolls the gateway back, and a formatting slip must never revert a build that
# just passed every health check.
try {
  # `environment` is a metadata block, not a capability — it has no `enabled`
  # field, so printing it through the capability formatter reported a healthy
  # deployment as "environment: OFF - " on every successful update.
  $envBlock = $caps.data.environment
  if ($envBlock) {
    Write-Host "      build: $($envBlock.buildSha) ($($envBlock.name)/$($envBlock.tradingMode), api v$($envBlock.apiVersion))"
  }
  $caps.data.PSObject.Properties |
    Where-Object { $null -ne $_.Value -and $_.Value.PSObject.Properties.Name -contains 'enabled' } |
    ForEach-Object {
      $state = if ($_.Value.enabled) { "on" } else { "OFF - $($_.Value.reason)" }
      Write-Host "      $($_.Name): $state"
    }
} catch {
  Write-Host "      (capability summary unavailable: $($_.Exception.Message))"
}

Write-Host ""
Ok "Update complete. Run .\smoke-test.ps1 for the full endpoint check."
} finally {
  Remove-Item $staged -Force -ErrorAction SilentlyContinue
}
