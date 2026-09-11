---
tags: [concept]
---
# Roadmap / Deferred

Implemented: NATS cross-pod fan-out ([[Hub and Fan-out]]), Redis distributed
[[Rate Limiting]], full [[Database]] + [[Price-History Jobs]].

Deferred (seams in place):
- **TimescaleDB** extension (currently plain Postgres — optional scale opt).
- **Redis symbol cache**.
- Central **mt5-session** role over gRPC.
- **Multi-region** ([[Kubernetes]]).

Related: [[Architecture]] · [[Optimizations]]
