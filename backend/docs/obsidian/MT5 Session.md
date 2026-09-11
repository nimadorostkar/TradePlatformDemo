---
tags: [component]
---
# MT5 Session

`internal/mt5` — manages authenticated sessions to the MT5 Manager Web API.

- **Pool** of keep-alive connections (default 1 = .NET parity), each pinned to
  one TCP conn + cookie jar.
- **Auth handshake (MD5/UTF-16LE):** `/api/auth/start` → compute `srv_rand_answer`
  → `/api/auth/answer` (cookie binds the session). See [[Auth]].
- **Keep-alive:** 20 s ping (`/api/test/access`), re-auth after consecutive failures.
- Wrapped by [[Circuit Breaker]]; consumed by [[Domain Services]] and [[Price-History Jobs]].

Related: [[Optimizations]] · [[Concurrency Model]]
