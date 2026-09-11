---
tags: [concept, ops]
---
# Testing

`go test -race ./...` — 12 packages green.

- **Unit/integration:** [[Auth]], [[Middleware]], [[MT5 Session]] handshake +
  [[Circuit Breaker]], [[Transforms]] (98.7%), [[Hub and Fan-out]] + poller + bus,
  [[Price-History Jobs]], Redis limiter (miniredis).
- **Golden parity:** frozen wire output for the three data-shape classes.
- **Live:** demo market simulator (74 REST + 14 WS), then the real broker on the VPS.
- **Smoke:** `scripts/smoke_test.sh`.

Related: [[Parity with .NET]] · [[Optimizations]]
