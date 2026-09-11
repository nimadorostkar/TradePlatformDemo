$all = Get-Content 'C:\opomtsocket-go\logs\gateway.log'
$ev = foreach ($l in $all) {
  if ($l -match '"msg":"mt5 ping re-auth failed"' -and $l -match '"time":"([^"]+)"') { [datetime]::Parse($matches[1]) }
}
$ev = $ev | Sort-Object
Write-Host ("total re-auth failures: " + $ev.Count)
Write-Host ""
Write-Host "=== episodes (new episode when gap > 5 min) ==="
$start = $ev[0]; $prev = $ev[0]; $n = 1; $gaps = @()
for ($i = 1; $i -lt $ev.Count; $i++) {
  $gap = ($ev[$i] - $prev).TotalSeconds
  if ($gap -gt 300) {
    Write-Host ("  {0} -> {1}  attempts={2}  duration={3:N0} min" -f $start.ToString('MM-dd HH:mm'), $prev.ToString('MM-dd HH:mm'), $n, ($prev-$start).TotalMinutes)
    $start = $ev[$i]; $n = 1
  } else { $n++; $gaps += $gap }
  $prev = $ev[$i]
}
Write-Host ("  {0} -> {1}  attempts={2}  duration={3:N0} min" -f $start.ToString('MM-dd HH:mm'), $prev.ToString('MM-dd HH:mm'), $n, ($prev-$start).TotalMinutes)
Write-Host ""
$g = $gaps | Sort-Object
Write-Host ("retry gap within an episode: min={0:N1}s  median={1:N1}s  max={2:N1}s" -f $g[0], $g[[int]($g.Count/2)], $g[-1])
Write-Host "  (a constant gap = no backoff: the gateway retries auth at a fixed rate for the whole outage)"
