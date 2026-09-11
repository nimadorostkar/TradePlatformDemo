$log = 'C:\opomtsocket-go\logs\gateway.log'
Write-Host ("log size: " + [math]::Round((Get-Item $log).Length/1MB,2) + " MB")
Write-Host ("rotated siblings: " + ((Get-ChildItem 'C:\opomtsocket-go\logs' -Filter 'gateway-*.log*' -ErrorAction SilentlyContinue | Measure-Object).Count))
$all = Get-Content $log

Write-Host ""
Write-Host "=== first occurrence of each distinct WARN/ERROR message (full text) ==="
$seen = @{}
foreach ($l in $all) {
  if ($l -match '"level":"(WARN|ERROR)"' -and $l -match '"msg":"([^"]+)"') {
    $m = $matches[1]
    if (-not $seen.ContainsKey($m)) {
      $seen[$m] = $true
      Write-Host ("  " + $l.Substring(0, [Math]::Min(300, $l.Length)))
      Write-Host ""
    }
  }
}
