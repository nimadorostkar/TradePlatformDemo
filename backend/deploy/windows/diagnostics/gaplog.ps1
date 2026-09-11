Get-Content C:\opomtsocket-go\logs\gateway.log -Tail 250 | Where-Object { $_ -match 'segment failed|stored daily|pre-coverage|getHistoryby1D' } | Select-Object -Last 12
