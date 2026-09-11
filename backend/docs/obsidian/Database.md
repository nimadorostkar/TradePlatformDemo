---
tags: [component, infra]
---
# Database

PostgreSQL 16 (`internal/store/timescale`, pgx). Two DBs: **market** (OHLC),
**trading_ops** (jobs/audit). TimescaleDB optional (best-effort; falls back to
plain Postgres). Tables auto-created on startup (migrations).

```mermaid
erDiagram
  price_history { text symbol PK
    bigint time PK
    float8 open
    float8 high
    float8 low
    float8 close
    float8 volume }
  daily_data { text symbol PK
    bigint timestamp PK
    float8 open
    float8 high
    float8 low
    float8 close }
```

- `price_history` — intraday M1, unique `(symbol,time)`, 7-day retention.
- `daily_data` — aggregated daily OHLC.
- Ingest via pgx **CopyFrom** + ON CONFLICT upsert.

Filled by [[Price-History Jobs]]; read by Tick history. Related: [[Optimizations]].
