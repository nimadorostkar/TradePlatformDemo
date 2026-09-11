---
tags: [component, api]
---
# REST API

`internal/httpapi/handlers` + chi routing. ~60 endpoints, envelope
`{data,errorMessage,message,success}` (200/400). Bearer JWT except Authentication
and Capabilities. The duplicate hardcoded-account `tv/TVOrder` surface is removed.

Groups: Authentication · Order · Position · Deal · History · Symbol · Tick ·
Trade · User · Test. `[AccountsAuthorize]` on get_page, send_request, User/*.
Operational: `/healthz` `/readyz` `/` `/swagger` `/openapi.json`; metrics are on
the private listener.

Backed by [[Domain Services]], gated by [[Middleware]]. Full list in the
DOCUMENTATION master doc. Related: [[WebSocket]].
