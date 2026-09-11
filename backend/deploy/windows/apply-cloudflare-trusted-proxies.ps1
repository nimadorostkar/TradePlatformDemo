# Applies the two config halves of the HGH-02 fix on the production box:
#
#   1. C:\Caddy\Caddyfile — global `servers { trusted_proxies static <CF> }`
#      so Caddy keeps the client hop Cloudflare puts in X-Forwarded-For
#      instead of replacing the header with the CF edge IP.
#   2. C:\opomtsocket-go\gateway.env — RATE_LIMIT_TRUSTED_PROXIES = loopback
#      plus Cloudflare's ranges, so the gateway walks past Caddy and the CF
#      edge and keys rate limits / the login throttle on the real client.
#
# Without BOTH halves every Cloudflare user shares one bucket (verified live
# 2026-08-28: an IPv6 client was locked out by failures made over IPv4).
# Everything is backed up with a timestamp suffix; the Caddyfile change is
# validated and rolled back automatically if `caddy validate` rejects it.
# The stanza is inserted into an existing global options block when there is
# one; only a pre-existing `servers` block bails to a by-hand instruction.
# Safe to re-run: each half detects when it is already applied.
#
# Run on the box:  powershell -ExecutionPolicy Bypass -File apply-cloudflare-trusted-proxies.ps1
# Afterwards restart the gateway (update.ps1 -BinaryPath ... does it, or:
#   schtasks /End /TN OpoGatewayGo; schtasks /Run /TN OpoGatewayGo)
#
# Ranges: https://www.cloudflare.com/ips/ (re-check if Cloudflare republishes).

$ErrorActionPreference = 'Stop'
$caddyfile = 'C:\Caddy\Caddyfile'
$caddyExe  = 'C:\Caddy\caddy.exe'
$envFile   = 'C:\opomtsocket-go\gateway.env'
$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'

$cfRanges = @(
  '173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22',
  '141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20',
  '197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13',
  '104.24.0.0/14','172.64.0.0/13','131.0.72.0/22',
  '2400:cb00::/32','2606:4700::/32','2803:f800::/32','2405:b500::/32',
  '2405:8100::/32','2a06:98c0::/29','2c0f:f248::/32'
)

# ── 1. Caddyfile ────────────────────────────────────────────────────────────
$caddyLines = @(Get-Content $caddyfile)
$caddyText  = $caddyLines -join "`n"
if ($caddyText -match 'trusted_proxies') {
  Write-Host 'Caddyfile already mentions trusted_proxies - not touching it; review by hand.'
} elseif ($caddyText -match '\bservers\b') {
  # A servers sub-block already exists somewhere; merging into it blindly is
  # how configs get mangled - do this one by hand.
  Write-Host 'Caddyfile already has a servers block. Add this line INSIDE it by hand, then caddy validate + reload:'
  Write-Host "    trusted_proxies static $($cfRanges -join ' ')"
  exit 1
} else {
  Copy-Item $caddyfile "$caddyfile.bak-$stamp"
  $stanza = @("`tservers {", "`t`ttrusted_proxies static $($cfRanges -join ' ')", "`t}")
  # A Caddyfile global options block must be the FIRST block in the file.
  # Find the first code line: if it opens a global options block, insert the
  # servers stanza just inside it; otherwise create a global block on top.
  $firstCodeIdx = -1
  for ($i = 0; $i -lt $caddyLines.Count; $i++) {
    $t = $caddyLines[$i].Trim()
    if ($t -ne '' -and -not $t.StartsWith('#')) { $firstCodeIdx = $i; break }
  }
  if ($firstCodeIdx -ge 0 -and $caddyLines[$firstCodeIdx].Trim() -eq '{') {
    $newLines = $caddyLines[0..$firstCodeIdx] + $stanza
    if ($firstCodeIdx + 1 -lt $caddyLines.Count) {
      $newLines += $caddyLines[($firstCodeIdx + 1)..($caddyLines.Count - 1)]
    }
  } else {
    $newLines = @('{') + $stanza + @('}', '') + $caddyLines
  }
  Set-Content -Path $caddyfile -Value $newLines
  # cmd /c because PS 5.1 with ErrorActionPreference=Stop treats caddy's
  # stderr info-logs as fatal.
  $validateOut = cmd /c "`"$caddyExe`" validate --config `"$caddyfile`" 2>&1"
  if ($LASTEXITCODE -ne 0) {
    Copy-Item "$caddyfile.bak-$stamp" $caddyfile -Force
    Write-Host "caddy validate FAILED - Caddyfile restored from backup. Output:"
    Write-Host ($validateOut -join "`n")
    exit 1
  }
  cmd /c "`"$caddyExe`" reload --config `"$caddyfile`" 2>&1" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Copy-Item "$caddyfile.bak-$stamp" $caddyfile -Force
    Write-Host 'caddy reload FAILED - Caddyfile restored from backup (reload the old config by hand).'
    exit 1
  }
  Write-Host "Caddyfile updated and reloaded (backup: $caddyfile.bak-$stamp)."
}

# ── 2. gateway.env ──────────────────────────────────────────────────────────
$wanted = 'RATE_LIMIT_TRUSTED_PROXIES=' + ((@('127.0.0.1/32','::1/128') + $cfRanges) -join ',')
$lines = @(Get-Content $envFile)
$current = $lines | Where-Object { $_ -match '^RATE_LIMIT_TRUSTED_PROXIES=' } | Select-Object -First 1
if ($current -eq $wanted) {
  Write-Host 'gateway.env already correct - no gateway restart needed for it.'
} else {
  Copy-Item $envFile "$envFile.bak-$stamp"
  if ($null -ne $current) {
    $lines = $lines -replace '^RATE_LIMIT_TRUSTED_PROXIES=.*', $wanted
  } else {
    $lines += $wanted
  }
  Set-Content -Path $envFile -Value $lines
  Write-Host "gateway.env UPDATED (backup: $envFile.bak-$stamp)."
  Write-Host 'RESTART the gateway to apply: schtasks /End /TN OpoGatewayGo ; schtasks /Run /TN OpoGatewayGo'
}
