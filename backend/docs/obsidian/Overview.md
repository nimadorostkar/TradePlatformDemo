---
tags: [core]
---
# Overview

A stateful **API gateway** between TradePlatform clients (web, TradingView UI,
console) and the **MetaTrader 5 Manager Web API**. Exposes MT5 as [[REST API]]
endpoints and a [[WebSocket]] stream. Faithful Go port of the .NET service —
see [[Parity with .NET]].

- **Prime directive:** identical external behavior (routes, payloads, status
  codes, WS contract); only auth/CORS posture hardened.
- **Scale target:** ~1,000,000 users — see [[Optimizations]], [[Concurrency Model]].
- **Status:** deployed in production — see [[Deployment - VPS]].

Related: [[Architecture]] · [[Request Flow]] · [[Tech Stack]]
