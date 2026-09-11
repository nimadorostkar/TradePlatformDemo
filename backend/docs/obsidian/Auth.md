---
tags: [component, security]
---
# Auth (JWT + CRM)

`internal/auth`.

- **JWT** — HS256, ASCII key bytes (same secret as .NET → cross-compatible
  tokens). Claims: `accounts` (CSV) or `name`. Issuer/audience validated
  (hardened; gated for migration).
- **CRM** — `/client-api/login` + `/client-api/accounts`; filters typeIds
  `{11,26,57..67}` to build the accounts claim.
- Enforced by [[Middleware]] (`JWTAuth`, `AccountsAuthorize`).

Related: [[Security]] · [[REST API]] (Authentication endpoints)
