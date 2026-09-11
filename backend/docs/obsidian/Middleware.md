---
tags: [component]
---
# Middleware

`internal/httpapi/middleware` — the request chain (order):
Recoverer → RequestLogger → Metrics → CORS → [[Rate Limiting]] → routes.

- **JWTAuth** — validates Bearer token → claims in context ([[Auth]]).
- **AccountsAuthorize** — `login` must be in the `accounts` claim (401/403).
- **CORS** — allowlist, fail-closed by default.
- **Metrics** — per-route counters/latency ([[Observability]]).
- Response wrapper forwards `http.Hijacker` so [[WebSocket]] can upgrade.

Related: [[Security]] · [[REST API]]
