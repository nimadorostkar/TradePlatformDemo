---
tags: [component]
---
# Price-History Jobs

`internal/jobs` — `robfig/cron` scheduler, leader-elected via a Postgres advisory
lock (replicas don't double-fire).

- **fetch-price-history** (daily + at boot): per-symbol M1 from [[MT5 Session]]
  → bulk COPY into [[Database]].
- **aggregate-daily** (chained): rolls intraday → `daily_data`.

In production: 330k+ rows / 386 symbols ingested. Related: [[Deployment - VPS]].
