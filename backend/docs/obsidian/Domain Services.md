---
tags: [component]
---
# Domain Services

`internal/domain` — one service per MT5 domain: order, position, deal, history,
symbol, tick, trade, user, login.

- Build the upstream URL, call [[MT5 Session]] (via [[Circuit Breaker]]), wrap in
  the response envelope, and apply the per-endpoint data shape.
- `source=tv` → [[Transforms]]; `source=mt5` → raw object / passthrough string.
- Depend on interfaces (`MT5Client`, `PriceStore`) — testable.

Powers [[REST API]] and [[WebSocket]]. Related: [[Parity with .NET]], [[Database]].
