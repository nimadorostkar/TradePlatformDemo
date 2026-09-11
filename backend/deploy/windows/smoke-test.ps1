# Production smoke test for the Go gateway.
#
#   .\smoke-test.ps1                                    # against localhost:5070
#   .\smoke-test.ps1 -BaseUrl https://<this-deployment's-backend-host>
#   .\smoke-test.ps1 -CrmEmail a@b.com -CrmPassword ... # also runs authed checks
#
# READ-ONLY: it never places a trade, creates an alert, or writes a workspace.
# Every check states what a failure means, so a red line is actionable rather
# than just red.
param(
  [string]$BaseUrl     = "http://localhost:5070",
  [string]$CrmEmail    = "",
  [string]$CrmPassword = "",
  [string]$Login       = ""
)
$ErrorActionPreference = "Continue"
$pass = 0; $fail = 0; $skip = 0

function Check($name, $scriptBlock, $whyItMatters) {
  try {
    $result = & $scriptBlock
    if ($result -eq $true) {
      Write-Host "  PASS  $name" -ForegroundColor Green; $script:pass++
    } else {
      Write-Host "  FAIL  $name" -ForegroundColor Red
      Write-Host "        $result" -ForegroundColor DarkGray
      Write-Host "        why it matters: $whyItMatters" -ForegroundColor DarkGray
      $script:fail++
    }
  } catch {
    Write-Host "  FAIL  $name" -ForegroundColor Red
    Write-Host "        $($_.Exception.Message)" -ForegroundColor DarkGray
    Write-Host "        why it matters: $whyItMatters" -ForegroundColor DarkGray
    $script:fail++
  }
}
function Skip($name, $reason) {
  Write-Host "  SKIP  $name - $reason" -ForegroundColor DarkYellow; $script:skip++
}

Write-Host "Smoke testing $BaseUrl" -ForegroundColor Cyan
Write-Host ""

# ── Anonymous ───────────────────────────────────────────────────────────────
Write-Host "Anonymous:" -ForegroundColor Cyan

Check "/healthz alive" {
  $h = Invoke-RestMethod "$BaseUrl/healthz" -TimeoutSec 10
  if ($h.status -eq "alive") { $true } else { "status=$($h.status)" }
} "the process is not serving at all."

Check "/readyz ready" {
  $r = Invoke-RestMethod "$BaseUrl/readyz" -TimeoutSec 10
  if ($r.status -eq "ready") { $true } else { "status=$($r.status) - MT5 session is down" }
} "not ready means the MT5 manager session failed; every data endpoint will error."

$caps = $null
Check "/api/Capabilities present (new build is live)" {
  $script:caps = Invoke-RestMethod "$BaseUrl/api/Capabilities" -TimeoutSec 10
  if ($caps.data) { $true } else { "no data field" }
} "a 404 here means the OLD binary is still running and none of the new features exist."

if ($caps) {
  Write-Host "        capabilities:" -ForegroundColor DarkGray
  $caps.data.PSObject.Properties | ForEach-Object {
    $state = if ($_.Value.enabled) { "on" } else { "OFF ($($_.Value.reason))" }
    Write-Host "          $($_.Name): $state" -ForegroundColor DarkGray
  }
}

Check "/openapi.json lists the new endpoints" {
  $spec = Invoke-RestMethod "$BaseUrl/openapi.json" -TimeoutSec 10
  $names = $spec.paths.PSObject.Properties.Name
  $missing = @("/api/Alert/list","/api/Workspace/get","/api/Deal/since","/api/Capabilities") |
             Where-Object { $names -notcontains $_ }
  if ($missing.Count -eq 0) { $true } else { "missing: $($missing -join ', ')" }
} "the API console would not show the new surface to integrators."

# ── Auth required ───────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Auth enforcement:" -ForegroundColor Cyan

foreach ($path in @("/api/Alert/list?login=1", "/api/Workspace/get?login=1", "/api/Deal/since?login=1")) {
  Check "401 without a token: $path" {
    try {
      Invoke-RestMethod "$BaseUrl$path" -TimeoutSec 10 | Out-Null
      "returned data without a token"
    } catch {
      $code = $_.Exception.Response.StatusCode.value__
      if ($code -eq 401) { $true } else { "expected 401, got $code" }
    }
  } "an unauthenticated caller could read or write another trader's data."
}

# ── Authenticated ───────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Authenticated:" -ForegroundColor Cyan

if (-not $CrmEmail -or -not $CrmPassword) {
  Skip "authenticated checks" "pass -CrmEmail and -CrmPassword to run them"
} else {
  $token = $null; $accounts = $null
  Check "CRM login issues a token" {
    $crm = Invoke-RestMethod "$BaseUrl/api/Authentication/crmlogin" -Method Post `
             -ContentType "application/json" `
             -Body (@{ email = $CrmEmail; password = $CrmPassword } | ConvertTo-Json) -TimeoutSec 20
    $jwt = Invoke-RestMethod "$BaseUrl/api/Authentication/login" -Method Post `
             -ContentType "application/json" `
             -Body (@{ Username = $CrmEmail; CRMToken = $crm.token } | ConvertTo-Json) -TimeoutSec 20
    $script:token = $jwt.token
    $script:crmToken = $crm.token
    if ($token) { $true } else { "no token returned" }
  } "nobody can log in."

  if ($token) {
    $auth = @{ Authorization = "Bearer $token" }

    Check "accounts carry a symbol suffix" {
      $a = Invoke-RestMethod "$BaseUrl/api/Authentication/accounts" -Method Post `
             -ContentType "application/json" `
             -Body (@{ CRMToken = $script:crmToken } | ConvertTo-Json) -TimeoutSec 20
      $script:accounts = $a.data
      if (-not $accounts -or $accounts.Count -eq 0) {
        "no tradable accounts returned - check CRM_ALLOWED_ACCOUNT_TYPES; if this trader's accounts are type 11/26 they are now excluded"
      } else {
        $unknown = $accounts | Where-Object { -not $_.suffixKnown }
        if ($unknown) {
          Write-Host "        note: $($unknown.Count) account(s) have suffixKnown=false; set CRM_ACCOUNT_TYPE_SUFFIXES" -ForegroundColor DarkYellow
          # Print the census so the suffix map can actually be written. Without
          # knowing which typeIds are in play, "set CRM_ACCOUNT_TYPE_SUFFIXES"
          # is advice nobody can act on.
          Write-Host "        account types in use (fill these into CRM_ACCOUNT_TYPE_SUFFIXES):" -ForegroundColor DarkYellow
          $accounts | Group-Object typeId | Sort-Object { [int]$_.Name } | ForEach-Object {
            $sample  = $_.Group[0]
            $suffix  = if ($sample.suffixKnown) { "'$($sample.suffix)'" } else { "UNKNOWN" }
            Write-Host ("          typeId {0,-4} x{1,-3} suffix={2}  e.g. login {3}" -f `
                        $_.Name, $_.Count, $suffix, $sample.login) -ForegroundColor DarkGray
          }
        }
        $true
      }
    } "the client cannot build correct symbol names without the suffix."

    if (-not $Login -and $accounts) { $Login = $accounts[0].login }

    if (-not $Login) {
      Skip "per-account checks" "no login available"
    } else {
      Write-Host "        using login $Login" -ForegroundColor DarkGray

      Check "market depth is a normalized, uncrossed ladder" {
        $d = Invoke-RestMethod "$BaseUrl/api/Tick/get_marketdepth?symbol=EURUSD" -Headers $auth -TimeoutSec 15
        if (-not $d.success) { return "request failed: $($d.errorMessage)" }
        if ($d.data.volumeUnit -ne "lots") { return "volumeUnit=$($d.data.volumeUnit), expected lots" }
        if ($d.data.crossed) {
          return "CROSSED book - MT5_BOOK_SIDE_CONVENTION is wrong for this broker; switch mql5 <-> manager"
        }
        if ($d.data.unclassified -gt 0) {
          Write-Host "        note: $($d.data.unclassified) entries had an unknown side code" -ForegroundColor DarkYellow
        }
        $true
      } "a crossed or mis-scaled DOM misstates available liquidity to a trader."

      Check "positions expose swap and lot volumes" {
        $p = Invoke-RestMethod "$BaseUrl/api/Position/get_page?login=$Login&offset=0&total=10&source=tv" -Headers $auth -TimeoutSec 15
        if (-not $p.success) { return "request failed: $($p.errorMessage)" }
        if (-not $p.data -or $p.data.Count -eq 0) {
          Write-Host "        note: no open positions to inspect" -ForegroundColor DarkGray
          return $true
        }
        $row = $p.data[0]
        $missing = @("qtyLots","swap","commission","priceSL","priceTP") |
                   Where-Object { -not ($row.PSObject.Properties.Name -contains $_) }
        if ($missing.Count -gt 0) { "missing fields: $($missing -join ', ')" } else { $true }
      } "the cost and protective-level columns stay Unavailable in the terminal."

      Check "symbols expose lot-denominated volume bounds" {
        $s = Invoke-RestMethod "$BaseUrl/api/Symbol/getsymbolsbyname?symbol=EURUSD&source=tv" -Headers $auth -TimeoutSec 15
        if (-not $s.success) { return "request failed: $($s.errorMessage)" }
        $sym = $s.data[0]
        if ($null -eq $sym.volume_min_lots) { return "volume_min_lots absent" }
        # A sane forex minimum is 0.01-1 lot. Anything like 100+ is the old
        # unit confusion that once blocked all trading.
        if ($sym.volume_min_lots -le 0 -or $sym.volume_min_lots -gt 10) {
          return "volume_min_lots=$($sym.volume_min_lots) is not a plausible lot size - unit scaling is wrong"
        }
        $true
      } "an implausible minimum volume blocks the order ticket entirely - this is the outage that already happened."

      Check "executions feed responds" {
        $after = [int][double]::Parse((Get-Date -UFormat %s)) - 86400
        $e = Invoke-RestMethod "$BaseUrl/api/Deal/since?login=$Login&after=$after" -Headers $auth -TimeoutSec 15
        if (-not $e.success) { return "request failed: $($e.errorMessage)" }
        $true
      } "TradingView execution markers stay empty."

      Check "alerts endpoint answers (or states why it is off)" {
        if (-not $caps.data.alerts.enabled) {
          Write-Host "        note: alerts are off - $($caps.data.alerts.reason)" -ForegroundColor DarkYellow
          return $true
        }
        $a = Invoke-RestMethod "$BaseUrl/api/Alert/list?login=$Login" -Headers $auth -TimeoutSec 15
        if ($a.success) { $true } else { "request failed: $($a.errorMessage)" }
      } "price alerts are unavailable to the trader."

      Check "workspace endpoint answers (or states why it is off)" {
        if (-not $caps.data.workspace.enabled) {
          Write-Host "        note: workspace is off - $($caps.data.workspace.reason)" -ForegroundColor DarkYellow
          return $true
        }
        $w = Invoke-RestMethod "$BaseUrl/api/Workspace/get?login=$Login" -Headers $auth -TimeoutSec 15
        if ($w.success) { $true } else { "request failed: $($w.errorMessage)" }
      } "layouts do not follow the trader between devices."

      # Diagnostic, not a pass/fail check. An account's MT5 group is what
      # actually determines its symbol suffix, so reading one group per typeId
      # turns "the suffix is unknown" into a table someone can act on.
      if ($accounts) {
        Write-Host ""
        Write-Host "  typeId -> MT5 group (for CRM_ACCOUNT_TYPE_SUFFIXES):" -ForegroundColor Cyan
        $accounts | Group-Object typeId | Sort-Object { [int]$_.Name } | ForEach-Object {
          $sample = $_.Group[0]
          try {
            $u = Invoke-RestMethod "$BaseUrl/api/User/get?login=$($sample.login)&source=mt5" -Headers $auth -TimeoutSec 15
            $text  = if ($u.data -is [string]) { $u.data } else { $u.data | ConvertTo-Json -Depth 6 -Compress }
            $group = if ($text -match '"Group"\s*:\s*"([^"]+)"') { $matches[1] } else { "(group not in response)" }
            Write-Host ("    typeId {0,-4} login {1,-12} group = {2}" -f $_.Name, $sample.login, $group)
          } catch {
            Write-Host ("    typeId {0,-4} login {1,-12} lookup failed: {2}" -f `
                        $_.Name, $sample.login, $_.Exception.Message) -ForegroundColor DarkYellow
          }
        }
        Write-Host ""
      }

      Check "another account's data is refused (403)" {
        try {
          Invoke-RestMethod "$BaseUrl/api/Position/get_page?login=999999999&offset=0&total=1&source=tv" -Headers $auth -TimeoutSec 15 | Out-Null
          "a login outside the token's accounts claim was served"
        } catch {
          $code = $_.Exception.Response.StatusCode.value__
          if ($code -eq 403 -or $code -eq 401) { $true } else { "expected 403, got $code" }
        }
      } "one trader could read another trader's positions."
    }
  }
}

Write-Host ""
Write-Host "pass $pass  fail $fail  skip $skip" -ForegroundColor $(if ($fail -gt 0) { "Red" } else { "Green" })
if ($fail -gt 0) { exit 1 }
