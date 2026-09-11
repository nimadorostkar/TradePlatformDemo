---
tags: [core]
---
# Concurrency Model

- **MT5 pool** ([[MT5 Session]]) — buffered-channel semaphore bounds upstream
  concurrency; per-conn ping/re-auth.
- **WebSocket** — goroutine per connection (bounded queue) + one poll loop per
  active subscription ([[Hub and Fan-out]]).
- **Context everywhere** — request/conn contexts thread to upstream/DB with
  configurable timeouts; SIGINT/SIGTERM → graceful drain.
- **No global mutable state**; interfaces at boundaries.

Related: [[Architecture]] · [[Optimizations]]
