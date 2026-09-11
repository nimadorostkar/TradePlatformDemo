---
tags: [concept, security]
---
# Security

- **[[Auth]]:** JWT HS256; AccountsAuthorize scoping.
- **Hardened defaults:** JWT on [[WebSocket]], CRM-only login, issuer/audience
  validated, CORS fail-closed, [[Circuit Breaker]], [[Rate Limiting]] — each gated
  for coexistence with .NET.
- **Secrets:** env only (never logged); Postgres localhost-only.
- Audit: all findings resolved (incl. a WS-hijack 501 bug and the live
  string-number bug).

Related: [[Parity with .NET]] · [[Deployment - VPS]] · [[Middleware]]
