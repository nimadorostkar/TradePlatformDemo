param(
  [string]$Dir = $PSScriptRoot,
  [string]$Config = "$PSScriptRoot\gateway.env"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path "$Dir\gateway.exe")) { throw "$Dir\gateway.exe not found" }
if (-not (Test-Path $Config)) { throw "$Config not found" }

foreach ($rawLine in [IO.File]::ReadAllLines($Config)) {
  $line = $rawLine.Trim()
  if ($line.Length -eq 0 -or $line.StartsWith("#")) { continue }

  $separator = $line.IndexOf("=")
  if ($separator -lt 1) { throw "Invalid gateway.env line (expected NAME=value)" }

  $name = $line.Substring(0, $separator).Trim()
  $value = $line.Substring($separator + 1)
  if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid environment variable name: $name" }
  # Any __…__ token is an unfilled placeholder. Matching the shape rather than
  # one specific spelling means a newly added placeholder cannot reach MT5 as if
  # it were a real hostname or credential.
  if ($value -match '^__.*__$') { throw "Production value $name is still a placeholder" }

  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

New-Item "$Dir\logs" -ItemType Directory -Force | Out-Null

# Config validation above is fail-fast; running the gateway is NOT.
#
# PowerShell surfaces a native program's stderr through its error stream, so
# under $ErrorActionPreference = "Stop" the first byte any dependency writes to
# stderr becomes a terminating error and kills the gateway. That is how a
# "cannot reach Redis" retry notice — from an optional dependency the gateway
# degrades past perfectly well — took the whole service down at startup.
#
# Redirection is done by the OS rather than through PowerShell's error stream,
# so stderr is captured as text and never interpreted as an error.
$ErrorActionPreference = "Continue"

# Do not use ReadToEndAsync for a lifetime process: it buffers every byte in
# memory until exit. Start-Process connects the child handles directly to files,
# keeping memory bounded and making diagnostics visible while the service runs.
$proc = Start-Process `
  -FilePath "$Dir\gateway.exe" `
  -WorkingDirectory $Dir `
  -RedirectStandardOutput "$Dir\gateway-stdout.log" `
  -RedirectStandardError "$Dir\boot-err.log" `
  -NoNewWindow `
  -Wait `
  -PassThru

exit $proc.ExitCode
