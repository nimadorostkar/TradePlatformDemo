---
tags: [infra, ops]
---
# Deployment — VPS (Windows native)

Production on `46.62.247.67` (Windows Server 2022), **alongside the .NET service**.

```mermaid
flowchart TB
  net[Internet] -->|5063| dotnet[.NET gateway unchanged]
  net -->|5070| go[Go gateway.exe scheduled task]
  go --> pg[(PostgreSQL 16 localhost)]
  go -->|whitelisted IP| MT5[(MT5 broker)]
```

- Go on **5070**, .NET keeps **5063** (untouched). Shared JWT secret → tokens
  work on both.
- Native `gateway.exe` in `C:\opomtsocket-go\`; scheduled task `OpoGatewayGo`
  (onstart, SYSTEM, 60 s delay so [[Database]] is up first).
- [[Price-History Jobs]] ingesting; rotating logs.
- Scripts: `deploy/windows/` (`install-postgresql.ps1`, `setup-service.ps1`,
  `run.ps1`, `gateway.env.example`, `protect-config.ps1`).

Related: [[Configuration]] · [[Security]] · [[Infrastructure]]
