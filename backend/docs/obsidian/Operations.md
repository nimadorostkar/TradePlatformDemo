---
tags: [ops]
aliases: [Ops]
---
# Operations

Run/monitor the gateway. See [[Observability]] (metrics/health/logs),
[[Deployment - VPS]] (scheduled task, restart), [[Circuit Breaker]] (upstream).

Quick: `/healthz`, `/readyz`, `/metrics`; `scripts/smoke_test.sh`;
the gateway log + `/metrics` for failure modes + tuning.

Related: [[Configuration]] · [[Infrastructure]]
