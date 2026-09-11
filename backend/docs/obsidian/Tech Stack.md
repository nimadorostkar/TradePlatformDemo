---
tags: [core]
---
# Tech Stack

Go 1.26, stdlib-first.

| Concern | Library |
|---|---|
| Router | go-chi/chi |
| WebSocket | coder/websocket |
| Config | caarlos0/env |
| Logging | slog + lumberjack |
| JWT | golang-jwt/jwt v5 |
| DB | jackc/pgx v5 |
| Jobs | robfig/cron v3 |
| Cache/limit | redis/go-redis v9 |
| Messaging | nats-io/nats.go |
| Breaker | sony/gobreaker |
| Metrics | prometheus/client_golang |
| Tests | testify, miniredis, golden files |

Related: [[Architecture]] · [[Testing]]
