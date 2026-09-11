# Migration rehearsal: SQL Server price history -> PostgreSQL (Phase-1, item 4).
#
# Exports Symbolwisepricehistorydata and Symboldailydata from the .NET service's
# SQL Server DB, DEDUPLICATES on (Symbol, Time) keeping the latest row (highest
# Id — the .NET schema has no unique constraint, the Postgres schema does),
# imports into PostgreSQL, then verifies row counts and spot-checks values.
#
# Defaults target a STAGING database (market_staging). Point -PgDb at the real
# `market` DB only after a clean rehearsal.
#
# Requirements on this machine: sqlcmd (SQL Server tools), psql (PostgreSQL).
#
# Usage (on the VPS, from an elevated shell):
#   .\migrate-price-history.ps1 -PgPassword $env:PGPASSWORD
#   .\migrate-price-history.ps1 -SqlServer localhost -SqlDb OpoFinance `
#       -PgHost localhost -PgUser opo -PgDb market_staging -PgPassword ...
#
# Idempotent: re-runs upsert (ON CONFLICT DO UPDATE), so a partial run can be
# repeated safely.

param(
    [string]$SqlServer  = "localhost",
    [string]$SqlDb      = "OpoFinance",
    [string]$PgHost     = "localhost",
    [int]   $PgPort     = 5432,
    [string]$PgUser     = "opo",
    [string]$PgDb       = "market_staging",
    [Parameter(Mandatory = $true)][string]$PgPassword,
    [int]   $SpotChecks = 20,
    [string]$WorkDir    = "$env:TEMP\opo-migration"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$env:PGPASSWORD = $PgPassword

function Invoke-Sql([string]$Query) {
    # -h -1: no headers; -W: trim; -s "|": pipe-delimited (symbols never contain |)
    $out = sqlcmd -S $SqlServer -d $SqlDb -E -h -1 -W -s "|" -Q "SET NOCOUNT ON; $Query"
    if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $Query" }
    return $out
}

function Invoke-Pg([string]$Query) {
    $out = psql -h $PgHost -p $PgPort -U $PgUser -d $PgDb -t -A -F "|" -c $Query
    if ($LASTEXITCODE -ne 0) { throw "psql failed: $Query" }
    return $out
}

Write-Host "== 1. Ensure PostgreSQL schema exists in $PgDb =="
Invoke-Pg @"
CREATE TABLE IF NOT EXISTS price_history (
    symbol text NOT NULL, time bigint NOT NULL,
    open double precision NOT NULL, high double precision NOT NULL,
    low double precision NOT NULL, close double precision NOT NULL,
    volume double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, time));
CREATE TABLE IF NOT EXISTS daily_data (
    symbol text NOT NULL, timestamp bigint NOT NULL,
    open double precision NOT NULL, high double precision NOT NULL,
    low double precision NOT NULL, close double precision NOT NULL,
    PRIMARY KEY (symbol, timestamp));
"@ | Out-Null

# ── price_history ─────────────────────────────────────────────────────────────
Write-Host "== 2. Export Symbolwisepricehistorydata (dedup: latest Id per Symbol,Time) =="
$phCsv = Join-Path $WorkDir "price_history.csv"
# ROW_NUMBER keeps exactly one row per (Symbol, Time): the latest write wins.
$export = @"
WITH ranked AS (
  SELECT Symbol, [Time], [Open], High, Low, [Close], Volume,
         ROW_NUMBER() OVER (PARTITION BY Symbol, [Time] ORDER BY Id DESC) AS rn
  FROM dbo.Symbolwisepricehistorydata
)
SELECT Symbol, [Time], [Open], High, Low, [Close], Volume FROM ranked WHERE rn = 1;
"@
Invoke-Sql $export | Where-Object { $_ -match '\S' } | Set-Content -Encoding utf8 $phCsv

$srcTotal   = [int64](Invoke-Sql "SELECT COUNT(*) FROM dbo.Symbolwisepricehistorydata;" | Select-Object -First 1).Trim()
$srcDistinct = [int64](Invoke-Sql "SELECT COUNT(*) FROM (SELECT DISTINCT Symbol, [Time] FROM dbo.Symbolwisepricehistorydata) d;" | Select-Object -First 1).Trim()
$csvRows = (Get-Content $phCsv | Measure-Object -Line).Lines
Write-Host "   source rows: $srcTotal | distinct (Symbol,Time): $srcDistinct | exported: $csvRows"
if ($csvRows -ne $srcDistinct) { throw "export row count $csvRows != distinct key count $srcDistinct" }

Write-Host "== 3. Import into PostgreSQL price_history (upsert) =="
Invoke-Pg "CREATE TABLE IF NOT EXISTS _staging_ph (symbol text, time bigint, open float8, high float8, low float8, close float8, volume float8); TRUNCATE _staging_ph;" | Out-Null
psql -h $PgHost -p $PgPort -U $PgUser -d $PgDb -c "\copy _staging_ph FROM '$phCsv' WITH (FORMAT csv, DELIMITER '|')"
if ($LASTEXITCODE -ne 0) { throw "\copy into _staging_ph failed" }
Invoke-Pg @"
INSERT INTO price_history (symbol, time, open, high, low, close, volume)
SELECT symbol, time, open, high, low, close, volume FROM _staging_ph
ON CONFLICT (symbol, time) DO UPDATE SET
  open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
  close = EXCLUDED.close, volume = EXCLUDED.volume;
DROP TABLE _staging_ph;
"@ | Out-Null

$pgCount = [int64](Invoke-Pg "SELECT COUNT(*) FROM price_history;").Trim()
Write-Host "   postgres price_history rows: $pgCount (expected >= $srcDistinct)"
if ($pgCount -lt $srcDistinct) { throw "postgres has $pgCount rows, expected at least $srcDistinct" }

# ── daily_data ────────────────────────────────────────────────────────────────
Write-Host "== 4. Export Symboldailydata (dedup on Symbol,Timestamp) =="
$ddCsv = Join-Path $WorkDir "daily_data.csv"
$exportDD = @"
WITH ranked AS (
  SELECT Symbol, [Timestamp], [Open], High, Low, [Close],
         ROW_NUMBER() OVER (PARTITION BY Symbol, [Timestamp] ORDER BY ID DESC) AS rn
  FROM dbo.Symboldailydata
)
SELECT Symbol, [Timestamp], [Open], High, Low, [Close] FROM ranked WHERE rn = 1;
"@
Invoke-Sql $exportDD | Where-Object { $_ -match '\S' } | Set-Content -Encoding utf8 $ddCsv
$ddDistinct = [int64](Invoke-Sql "SELECT COUNT(*) FROM (SELECT DISTINCT Symbol, [Timestamp] FROM dbo.Symboldailydata) d;" | Select-Object -First 1).Trim()

Invoke-Pg "CREATE TABLE IF NOT EXISTS _staging_dd (symbol text, ts bigint, open float8, high float8, low float8, close float8); TRUNCATE _staging_dd;" | Out-Null
psql -h $PgHost -p $PgPort -U $PgUser -d $PgDb -c "\copy _staging_dd FROM '$ddCsv' WITH (FORMAT csv, DELIMITER '|')"
if ($LASTEXITCODE -ne 0) { throw "\copy into _staging_dd failed" }
Invoke-Pg @"
INSERT INTO daily_data (symbol, timestamp, open, high, low, close)
SELECT symbol, ts, open, high, low, close FROM _staging_dd
ON CONFLICT (symbol, timestamp) DO UPDATE SET
  open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close;
DROP TABLE _staging_dd;
"@ | Out-Null
$pgDD = [int64](Invoke-Pg "SELECT COUNT(*) FROM daily_data;").Trim()
Write-Host "   postgres daily_data rows: $pgDD (expected >= $ddDistinct)"
if ($pgDD -lt $ddDistinct) { throw "daily_data has $pgDD rows, expected at least $ddDistinct" }

# ── spot checks ───────────────────────────────────────────────────────────────
Write-Host "== 5. Spot-check $SpotChecks random price_history rows =="
$samples = Invoke-Sql @"
WITH ranked AS (
  SELECT Symbol, [Time], [Open], High, Low, [Close], Volume,
         ROW_NUMBER() OVER (PARTITION BY Symbol, [Time] ORDER BY Id DESC) AS rn
  FROM dbo.Symbolwisepricehistorydata
)
SELECT TOP $SpotChecks Symbol, [Time], [Open], High, Low, [Close], Volume
FROM ranked WHERE rn = 1 ORDER BY NEWID();
"@ | Where-Object { $_ -match '\S' }

$mismatch = 0
foreach ($row in $samples) {
    $f = $row.Split("|")
    $sym = $f[0].Trim(); $t = $f[1].Trim()
    $pg = (Invoke-Pg "SELECT open||'|'||high||'|'||low||'|'||close||'|'||volume FROM price_history WHERE symbol='$sym' AND time=$t;").Trim()
    if (-not $pg) { Write-Host "   MISSING $sym@$t in postgres"; $mismatch++; continue }
    $pgF = $pg.Split("|")
    $bad = $false
    for ($i = 0; $i -lt 5; $i++) {
        # tolerate float formatting differences, compare numerically
        if ([math]::Abs([double]$f[$i + 2] - [double]$pgF[$i]) -gt 1e-9) { $bad = $true }
    }
    if ($bad) { Write-Host "   MISMATCH $sym@$t sql=($($row)) pg=($pg)"; $mismatch++ }
}
if ($mismatch -gt 0) { throw "$mismatch spot-check failure(s)" }
Write-Host "   all $SpotChecks spot checks match"

Write-Host ""
Write-Host "== REHEARSAL PASSED =="
Write-Host "   price_history: $srcTotal source rows -> $srcDistinct deduped -> $pgCount in postgres ($PgDb)"
Write-Host "   daily_data:    $ddDistinct deduped -> $pgDD in postgres"
Write-Host "   Re-run against the real 'market' DB with -PgDb market when ready."
