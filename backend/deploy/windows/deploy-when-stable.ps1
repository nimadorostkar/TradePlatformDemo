# Deploy a staged gateway build as soon as it is BOTH present and safe.
#
#   .\deploy-when-stable.ps1 -Binary C:\opomtsocket-go\incoming\gateway-<sha>.exe
#
# Written during the 2026-08-24 broker outage: the gateway only reports ready
# after an MT5 authentication succeeds, so deploying while the broker farm is
# dropping this box's SYNs would fail readiness and trigger a rollback loop.
# This watcher waits for the staged binary to appear in incoming\, then for the
# broker to answer TCP 443 on several consecutive checks (one reachable probe
# during a flap is not a window), and only then hands off to update.ps1 — which
# keeps its own hash-verified rollback.
param(
  [Parameter(Mandatory = $true)][string]$Binary,
  [string]$BrokerHost = 'tradeapp.opofinance.com',
  [int]$StableChecks = 3,
  [int]$CheckIntervalSeconds = 20,
  [int]$MaxWaitHours = 24
)
Start-Transcript -Path 'C:\opomtsocket-go\logs\deploy-when-stable.log' -Append
try {
  $deadline = (Get-Date).AddHours($MaxWaitHours)

  while (-not (Test-Path $Binary)) {
    if ((Get-Date) -gt $deadline) { Write-Host 'gave up: binary never arrived'; exit 1 }
    Start-Sleep -Seconds 30
  }
  Write-Host ("{0} staged binary present: {1} ({2} bytes)" -f (Get-Date -Format s), $Binary, (Get-Item $Binary).Length)

  $streak = 0
  while ($streak -lt $StableChecks) {
    if ((Get-Date) -gt $deadline) { Write-Host 'gave up: no stable broker window'; exit 1 }
    $ok = (Test-NetConnection $BrokerHost -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded
    if ($ok) { $streak++ } else { $streak = 0 }
    Write-Host ("{0} broker reachable={1} streak={2}/{3}" -f (Get-Date -Format s), $ok, $streak, $StableChecks)
    Start-Sleep -Seconds $CheckIntervalSeconds
  }

  Write-Host ("{0} broker window stable; deploying" -f (Get-Date -Format s))
  & 'C:\opomtsocket-go\update.ps1' -BinaryPath $Binary -ReadyTimeoutSeconds 120
} finally {
  Stop-Transcript
}
