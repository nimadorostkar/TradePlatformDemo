---
tags: [component, ops]
---
# Observability

`internal/observability`.

- **Health:** `/healthz` (liveness), `/readyz` (tracks [[MT5 Session]] auth).
- **Metrics:** `/metrics` Prometheus — `http_requests_total`/duration by route,
  `mt5_requests_total`, `ws_active_connections`, `ws_messages_dropped_total`.
- **Logging:** `log/slog` JSON, **rotating files** (lumberjack) when `LOG_FILE` set.

Related: [[Operations]] · [[Configuration]]
