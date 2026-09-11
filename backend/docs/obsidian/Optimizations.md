---
tags: [concept]
---
# Optimizations

- **Connection pooling** to MT5 ([[MT5 Session]]) + [[Circuit Breaker]].
- **WS fan-out** ([[Hub and Fan-out]]) — poll once per subscription, not per conn.
- **Backpressure** — bounded WS queues.
- **Lenient JSON numbers** ([[Transforms]]) — correct + fast.
- **Bulk DB ingest** — CopyFrom + ON CONFLICT; index; 7-day retention ([[Database]]).
- **Distributed [[Rate Limiting]]** (Redis).
- **Bounded goroutines**; static ~23 MB binary, <50 ms start.

Related: [[Concurrency Model]] · [[Tech Stack]]
