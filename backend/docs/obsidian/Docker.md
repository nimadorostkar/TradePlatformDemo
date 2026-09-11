---
tags: [infra]
---
# Docker

For Linux hosts (not used on the Windows VPS).

- `deploy/docker/Dockerfile` — multi-stage (Go 1.26 → distroless static, ~23 MB).
- `deploy/docker/Dockerfile.prebuilt` — copy a prebuilt binary (offline).
- `deploy/compose/docker-compose.yml` — full stack: gateway + Postgres/Timescale
  + Redis + NATS.
- `deploy/compose/docker-compose.prod.yml` — gateway-only, API-only, port 5070.

`make docker-build` · `make compose-up`. Related: [[Kubernetes]] · [[Infrastructure]].
