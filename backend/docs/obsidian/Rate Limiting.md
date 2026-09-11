---
tags: [component]
---
# Rate Limiting

Per-client-IP token bucket (`RATE_LIMIT_RPS`/`BURST`). Ops paths exempt; 429 on exceed.

- **In-process** limiter (single node).
- **Redis-distributed** (`internal/cache`) when `REDIS_ADDRS` set — atomic Lua
  token bucket shared across replicas; fails open on Redis error.

Applied by [[Middleware]]. Related: [[Optimizations]], [[Configuration]].
