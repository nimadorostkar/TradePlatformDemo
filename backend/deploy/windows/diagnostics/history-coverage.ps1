$pgpassLine = (Get-Content C:\opomtsocket-go\gateway.env) | Where-Object { $_ -match '^TIMESCALE_DSN=' }
if ($pgpassLine -match 'postgres://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/([^?]+)') {
  $env:PGPASSWORD = $Matches[2]
  & 'C:\PostgreSQL\pgsql\bin\psql.exe' -h localhost -U $Matches[1] -d $Matches[5] -t -A -c "select count(*)||' rows | '||to_timestamp(min(timestamp))||' -> '||to_timestamp(max(timestamp)) from daily_data where symbol='EURUSD!';" 2>&1
}
Get-Content C:\opomtsocket-go\logs\gateway.log -Tail 100 | Where-Object { $_ -match 'banked' } | Select-Object -Last 4
