[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$Archive,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://')]
  [string]$HealthUrl,

  # Site root on this host. Defaults to the conventional install location so
  # existing invocations keep working; pass it to relocate the deployment
  # without editing this script.
  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$Root = $(if ($env:OPOTRADE_SITE_ROOT) { $env:OPOTRADE_SITE_ROOT } else { 'C:\sites\opotrade-ui-new' }),

  # Version-matched Caddy config uploaded alongside the release. It is NOT
  # placed inside the release directory: everything under the release is served
  # publicly, and a web server's own configuration must never be.
  [Parameter(Mandatory = $false)]
  [string]$CaddyConfigSource = '',

  # Where Caddy actually reads its configuration on this host. BOTH this and
  # -CaddyConfigSource must be supplied before the config is touched; with
  # either missing the deployment leaves the web server alone, which is the
  # behaviour every release before this one had.
  [Parameter(Mandatory = $false)]
  [string]$CaddyConfigPath = '',

  [Parameter(Mandatory = $false)]
  [ValidateNotNullOrEmpty()]
  [string]$CaddyExe = 'caddy'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Releases = Join-Path $Root 'releases'
$Release = Join-Path $Releases $Version
$Current = Join-Path $Root 'current'
$Next = Join-Path $Root 'current-next'
$Previous = Join-Path $Root 'current-previous'
$Failed = Join-Path $Root 'current-failed'

function Remove-Junction {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (Test-Path -LiteralPath $Path) {
    & cmd.exe /d /c rmdir "`"$Path`""
    if ($LASTEXITCODE -ne 0) {
      throw "Could not remove junction: $Path"
    }
  }
}

function New-Junction {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Target
  )

  & cmd.exe /d /c mklink /J "`"$Path`"" "`"$Target`""
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create junction $Path -> $Target"
  }
}

function Invoke-Caddy {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  # Native output goes to the HOST stream, never the pipeline: anything written
  # to the pipeline would be captured as a function's return value and corrupt
  # the backup path this returns.
  $Output = & $Exe @Arguments 2>&1
  if ($Output) { Write-Host ($Output | Out-String).TrimEnd() }
  return $LASTEXITCODE
}

function Install-CaddyConfig {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Exe
  )

  # Validate BEFORE the new file reaches disk. A config that is written and
  # only then fails to load leaves the file on disk disagreeing with the
  # running server — the worst state to debug an outage from.
  if ((Invoke-Caddy -Exe $Exe -Arguments @('validate', '--adapter', 'caddyfile', '--config', $Source)) -ne 0) {
    throw "The new Caddy configuration failed validation; the live configuration was not touched."
  }

  $Backup = ''
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    $Backup = "$Destination.bak"
    Copy-Item -LiteralPath $Destination -Destination $Backup -Force
  }

  Copy-Item -LiteralPath $Source -Destination $Destination -Force

  if ((Invoke-Caddy -Exe $Exe -Arguments @('reload', '--adapter', 'caddyfile', '--config', $Destination)) -ne 0) {
    if ($Backup) {
      Copy-Item -LiteralPath $Backup -Destination $Destination -Force
      [void](Invoke-Caddy -Exe $Exe -Arguments @('reload', '--adapter', 'caddyfile', '--config', $Destination))
    }
    throw "Caddy reload failed; the previous configuration was restored."
  }

  return $Backup
}

function Restore-CaddyConfig {
  param(
    [string]$Backup,
    [string]$Destination,
    [string]$Exe
  )

  if (-not $Backup) { return }
  if (-not (Test-Path -LiteralPath $Backup -PathType Leaf)) { return }
  Copy-Item -LiteralPath $Backup -Destination $Destination -Force
  [void](Invoke-Caddy -Exe $Exe -Arguments @('reload', '--adapter', 'caddyfile', '--config', $Destination))
}

New-Item -ItemType Directory -Force -Path $Releases | Out-Null

if (Test-Path -LiteralPath $Release) {
  # Releases are keyed by commit SHA, and a release can land out-of-band (a
  # manual deploy during a CI outage). When the version on disk is the one
  # CURRENTLY SERVING, this invocation is a replay of work already done:
  # verify health and succeed as a no-op, so the pipeline goes green on the
  # outcome instead of failing over bookkeeping. Any other pre-existing
  # release directory is still an error — activating stale bits silently is
  # exactly what this guard exists to prevent.
  $VersionFile = Join-Path $Root 'current-version.txt'
  $Active = ''
  if (Test-Path -LiteralPath $VersionFile -PathType Leaf) {
    $Active = ([string](Get-Content -LiteralPath $VersionFile -TotalCount 1)).Trim()
  }
  if ($Active -eq $Version) {
    Write-Output "Release $Version is already the active release; verifying health."
    $Response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 10
    $Content = if ($Response.Content -is [byte[]]) {
      [System.Text.Encoding]::UTF8.GetString($Response.Content)
    } else {
      [string]$Response.Content
    }
    if ($Response.StatusCode -ne 200 -or $Content -notmatch '"status"\s*:\s*"ok"') {
      throw "Release $Version is active but failed its health check."
    }
    if (Test-Path -LiteralPath $Archive) {
      Remove-Item -LiteralPath $Archive -Force
    }
    Write-Output "Deployed $Version (already active)"
    exit 0
  }
  throw "Release already exists: $Version"
}

New-Item -ItemType Directory -Path $Release | Out-Null

try {
  Expand-Archive -LiteralPath $Archive -DestinationPath $Release

  $RequiredFiles = @(
    'index.html',
    'runtime-config.js',
    'healthz',
    'charting_library\charting_library.js',
    'charting_library\charting_library.standalone.js'
  )

  foreach ($RelativePath in $RequiredFiles) {
    $RequiredPath = Join-Path $Release $RelativePath
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
      throw "Release is missing required file: $RelativePath"
    }
  }

  Remove-Junction -Path $Next
  Remove-Junction -Path $Previous
  Remove-Junction -Path $Failed
  New-Junction -Path $Next -Target $Release

  $HadCurrent = Test-Path -LiteralPath $Current
  if ($HadCurrent) {
    Rename-Item -LiteralPath $Current -NewName (Split-Path $Previous -Leaf)
  }
  Rename-Item -LiteralPath $Next -NewName (Split-Path $Current -Leaf)

  # ── Web server configuration ────────────────────────────────────────────
  #
  # Only touched when BOTH the uploaded source and the live path are supplied.
  # With either missing this is a no-op, which is exactly how every release
  # before this one behaved — so enabling it is a deliberate act, not a
  # side effect of upgrading the script.
  $CaddyBackup = ''
  $CaddyManaged = ($CaddyConfigSource -ne '') -and ($CaddyConfigPath -ne '')
  if ($CaddyManaged) {
    if (-not (Test-Path -LiteralPath $CaddyConfigSource -PathType Leaf)) {
      throw "Caddy configuration source not found: $CaddyConfigSource"
    }
    $CaddyBackup = Install-CaddyConfig -Source $CaddyConfigSource -Destination $CaddyConfigPath -Exe $CaddyExe
    Write-Output "Caddy configuration updated: $CaddyConfigPath"
  }
  else {
    Write-Output 'Caddy configuration left unchanged (not configured).'
  }

  $Healthy = $false
  for ($Attempt = 1; $Attempt -le 10; $Attempt++) {
    try {
      $Response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 10
      $Content = if ($Response.Content -is [byte[]]) {
        [System.Text.Encoding]::UTF8.GetString($Response.Content)
      } else {
        [string]$Response.Content
      }
      if ($Response.StatusCode -eq 200 -and $Content -match '"status"\s*:\s*"ok"') {
        $Healthy = $true
        break
      }
    } catch {
      if ($Attempt -eq 10) {
        Write-Warning $_.Exception.Message
      }
    }
    Start-Sleep -Seconds 3
  }

  if (-not $Healthy) {
    Rename-Item -LiteralPath $Current -NewName (Split-Path $Failed -Leaf)
    if ($HadCurrent) {
      Rename-Item -LiteralPath $Previous -NewName (Split-Path $Current -Leaf)
    }
    Remove-Junction -Path $Failed
    # The release and the web server configuration went out together, so they
    # roll back together. Restoring one without the other could leave a
    # configuration pointing at a layout the restored release does not have.
    if ($CaddyManaged) {
      Restore-CaddyConfig -Backup $CaddyBackup -Destination $CaddyConfigPath -Exe $CaddyExe
    }
    throw "Health check failed; the previous release and configuration were restored."
  }

  if ($HadCurrent) {
    Remove-Junction -Path $Previous
  }

  Set-Content -LiteralPath (Join-Path $Root 'current-version.txt') -Value $Version -Encoding ascii
  Write-Output "Deployed $Version"
} catch {
  if ((Test-Path -LiteralPath $Release) -and -not (Test-Path -LiteralPath $Current)) {
    Remove-Item -LiteralPath $Release -Recurse -Force
  }
  throw
} finally {
  if (Test-Path -LiteralPath $Archive) {
    Remove-Item -LiteralPath $Archive -Force
  }
  if ($CaddyConfigSource -and (Test-Path -LiteralPath $CaddyConfigSource)) {
    Remove-Item -LiteralPath $CaddyConfigSource -Force
  }
}
