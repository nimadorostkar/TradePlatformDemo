---
tags: [core]
---
# Architecture

One **role-gated Go binary** (roles: api, ws, poller, mt5, jobs) that runs on a
single node or splits per-role for scale.

```mermaid
flowchart LR
  C[Clients] --> MW[Middleware]
  MW --> H[REST handlers]
  MW --> WS[/ws hub/]
  H --> D[Domain services]
  WS --> D
  D --> T[Transforms]
  D --> M[MT5 session pool]
  M --> MT5[(MT5 Web API)]
  D -.tick history.-> DB[(PostgreSQL)]
  J[Jobs] --> M
  J --> DB
```

Layers: [[Middleware]] → [[REST API]] / [[WebSocket]] → [[Domain Services]] →
[[Transforms]] + [[MT5 Session]] (via [[Circuit Breaker]]). Cross-cutting:
[[Observability]], [[Configuration]]. Data: [[Database]], [[Price-History Jobs]].

See [[Request Flow]] · [[Concurrency Model]] · the full [[Architecture Board.canvas|board]].
