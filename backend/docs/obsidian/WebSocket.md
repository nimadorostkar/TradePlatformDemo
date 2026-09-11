---
tags: [component, api]
---
# WebSocket (/ws)

`internal/realtime`. Subscription = **query string** (no subscribe message).
Pushes the serialized `data` every ~3 s. Browser JWT via the
`tradeplatform.jwt.<JWT>` WebSocket subprotocol; the URL remains credential-free.

| TP | Service | methodtype |
|---|---|---|
| 1 | Tick | GetQuotes, GetMarketDepth, GetStatistics, GetQuotesByGroup, GetM1History, GetHistoryBy1DResolution |
| 2 | Position | GetPosition, GetTotalPosition, GetPagebyPagePositionWs, GetPositionBatch |
| 3 | User | Getbylogin, GetTradeState |
| 4 | Order | GetPagebyPageOrder |

Served by [[Hub and Fan-out]], dispatched to [[Domain Services]]. Related: [[Parity with .NET]].
