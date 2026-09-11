---
tags: [core]
---
# Request Flow (REST)

```mermaid
sequenceDiagram
  Client->>Middleware: GET /api/Tick/last?source=tv (Bearer JWT)
  Middleware->>Handler: JWT + accounts check
  Handler->>Domain: GetQuotes(...)
  Domain->>MT5: via Circuit Breaker + pooled conn
  MT5-->>Domain: {"Bid":"1.0854",...}
  Domain->>Domain: source=tv -> Transform (lenient numbers)
  Domain-->>Client: 200 {data, message, success}
```

Envelope: `{data, errorMessage, message, success}` — `success:true`→200,
`false`→400. `data` shape per endpoint: **string** (passthrough) / **object**
(`source=mt5`) / **TV shape** (`source=tv`). See [[Transforms]], [[Parity with .NET]].

Related: [[Middleware]] · [[Domain Services]] · [[MT5 Session]]
