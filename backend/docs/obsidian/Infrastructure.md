---
tags: [infra]
---
# Infrastructure

The gateway is one static binary; three deployment shapes:

- **[[Deployment - VPS]]** — native Windows exe (production), no Docker.
- **[[Docker]]** — Linux host / local stack.
- **[[Kubernetes]]** — per-role scaling, HPA, NATS, Redis.

Dependencies: [[Database]] (PostgreSQL), optional Redis ([[Rate Limiting]]),
optional NATS ([[Hub and Fan-out]]). External: MT5 Web API + CRM.

Related: [[Architecture]] · [[Operations]]
