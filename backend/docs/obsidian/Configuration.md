---
tags: [component]
---
# Configuration

`internal/config` — typed env vars with safe defaults; fatal validation when
`ENVIRONMENT=production`.

Key groups: Server · MT5 · CRM · JWT · Security toggles · DB · Redis · NATS · WS ·
Rate limit · Logging (rotation) · Roles. Template: `.env.example`.

Hardened toggles (legacy values for migration): `WS_REQUIRE_AUTH`,
`CORS_ALLOWED_ORIGINS`, `JWT_VALIDATE_ISSUER/AUDIENCE`. The username-only login path is removed.

Related: [[Security]] · [[Deployment - VPS]]
