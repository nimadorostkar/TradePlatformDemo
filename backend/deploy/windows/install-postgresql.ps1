# Install PostgreSQL 16 on Windows headlessly, from the EDB ZIP binaries.
#
# Why the ZIP method: the EDB graphical installer silently fails (exit 1) on a
# headless Windows Server (no interactive desktop). The ZIP + initdb path is
# deterministic. KEY GOTCHA: let initdb CREATE the data directory itself —
# pre-creating it (owned by the Administrators group) causes
# "initdb: could not change permissions ... Permission denied".
#
# Usage (elevated PowerShell):
#   .\install-postgresql.ps1 -PgSuperPassword '<strong>' -OpoPassword '<strong>'
param(
  [string]$Version       = "16.6-1",
  [string]$Root          = "C:\PostgreSQL",
  [Parameter(Mandatory=$true)][string]$PgSuperPassword,
  [Parameter(Mandatory=$true)][string]$OpoPassword,
  [string]$Port          = "5432"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$bin  = "$Root\pgsql\bin"
$data = "$Root\data"

if (-not (Test-Path "$bin\initdb.exe")) {
  New-Item -ItemType Directory -Force -Path $Root, C:\temp | Out-Null
  $url = "https://get.enterprisedb.com/postgresql/postgresql-$Version-windows-x64-binaries.zip"
  $zip = "C:\temp\pg.zip"
  Write-Host "Downloading $url ..."
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -TimeoutSec 900
  Write-Host "Extracting..."
  Expand-Archive -Path $zip -DestinationPath $Root -Force   # -> $Root\pgsql
}
if (-not (Test-Path "$bin\initdb.exe")) { throw "initdb not found after extract" }

# initdb — let it create the data dir (do NOT pre-create it)
if ((Test-Path $data) -and -not (Test-Path "$data\PG_VERSION")) { Remove-Item $data -Recurse -Force }
if (-not (Test-Path "$data\PG_VERSION")) {
  $pwf = "C:\temp\pgpw.txt"; Set-Content $pwf -Value $PgSuperPassword -NoNewline -Encoding ascii
  Write-Host "Running initdb..."
  & "$bin\initdb.exe" -D $data -U postgres -A scram-sha-256 --pwfile=$pwf -E UTF8 --locale=C
  Remove-Item $pwf -Force
}

# Register + start the Windows service (auto-start so it survives reboot)
if (-not (Get-Service postgresql-16 -ErrorAction SilentlyContinue)) {
  & "$bin\pg_ctl.exe" register -N postgresql-16 -D $data -S auto
  Start-Sleep 2
}
try { Start-Service postgresql-16 } catch { & "$bin\pg_ctl.exe" start -D $data -w -t 60 }
Start-Sleep 5
Write-Host ("Service: " + (Get-Service postgresql-16).Status)

# Role + databases (idempotent). Postgres listens on localhost only (default).
$psql = "$bin\psql.exe"; $env:PGPASSWORD = $PgSuperPassword
$roleSql = 'DO $do$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=''opo'') THEN CREATE ROLE opo LOGIN PASSWORD ''' + $OpoPassword + '''; END IF; END $do$;'
& $psql -U postgres -h localhost -p $Port -c $roleSql
foreach ($db in @("market","trading_ops")) {
  $x = (& $psql -U postgres -h localhost -p $Port -tAc "SELECT 1 FROM pg_database WHERE datname='$db'") -join ''
  if ($x.Trim() -ne '1') { & $psql -U postgres -h localhost -p $Port -c "CREATE DATABASE $db OWNER opo;" }
}
Write-Host "Databases:"; & $psql -U postgres -h localhost -p $Port -tAc "SELECT datname FROM pg_database WHERE datname IN ('market','trading_ops') ORDER BY 1"
Write-Host "DONE. The gateway will create the tables on its next start (auto-migrations)."
