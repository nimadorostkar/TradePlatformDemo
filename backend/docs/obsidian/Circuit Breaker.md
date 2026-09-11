---
tags: [component]
---
# Circuit Breaker

`gobreaker` wrapping [[MT5 Session]] egress.

- **Transport failures** trip it → fail fast (no 100 s hangs).
- **Business errors** (4xx with a body) do **not** trip — they're valid responses.
- Feeds `mt5_requests_total{result=ok|error|open}` ([[Observability]]).

Related: [[Optimizations]] · [[Operations]]
