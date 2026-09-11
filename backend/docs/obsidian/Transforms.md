---
tags: [component]
---
# Transforms (MT5 → TradingView)

`internal/transform` — pure functions mapping MT5 responses to TradingView shapes.

- Quote, order, position, symbol, user, account, chart, placed-order mappings;
  side/status/type tables; session + path converters; 1D/1W/1M bucketing.
- **Lenient JSON numbers** — the live MT5 API returns numbers as strings
  (`"Bid":"1.0854"`); `Float/Int` types decode number **or** string (Go's strict
  JSON otherwise breaks every `source=tv` transform). 98.7% test coverage.

Used by [[Domain Services]]. Related: [[Parity with .NET]], [[Optimizations]].
