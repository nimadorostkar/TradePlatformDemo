---
tags: [concept]
---
# Parity with .NET

Identical external behavior to the .NET `OpoMTSocket` service.

- **Data shapes** per endpoint preserved: string passthrough vs `source=mt5`
  object vs `source=tv` transform ([[Transforms]]) — golden-tested.
- **Quirks reproduced:** `history/delete?ticket=tickets`, char-split tickets,
  `(UTCunix+3h)*1000`, anonymous controllers, 401/403 logic.
- **Deviations:** hardened auth/CORS (gated), TimescaleDB instead of SQL Server,
  circuit breaker, metrics, NATS fan-out — see PARITY-NOTES.
- Dead .NET code (native TCP protocol, SignalR) **not** ported.

Related: [[Security]] · [[Domain Services]] · [[Testing]]
