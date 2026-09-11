# Why Go — Advantages over the .NET Gateway

A short technical comparison of the new Go gateway vs the previous .NET 8 service.
External behavior is identical (that was the goal); the gains are in **resource
footprint, scalability, resilience, and operability**.

## Observed on the production VPS (both running side-by-side)

| Metric | .NET (`dotnet.exe`) | Go (`gateway.exe`) | Result |
|---|---|---|---|
| Working-set RAM (idle/light load) | ~18 MB | ~8 MB | **~2.2× lower** |
| Deploy artifact | runtime + DLLs + IIS/host | **1 static `.exe` (~23 MB)** | no runtime to install |
| Cold start | seconds (JIT/runtime warmup) | **< 50 ms** | near-instant |
| Runtime deps | .NET 8 runtime | **none** | trivial deploy/rollback |

> Working-set is a light-load snapshot; the structural advantages below dominate
> under real load.

## The dominant efficiency win — WebSocket fan-out

The .NET `/ws` polled MT5 **per connection** every ~3 s. The Go hub polls **once
per subscription** (and, with NATS, once per symbol **cluster-wide**):

- Upstream MT5 load drops from **O(connections × symbols)** to **O(symbols)**.
- Example: 1,000 clients watching EURUSD = **1,000 polls/3s in .NET → 1 poll/3s
  in Go** (~1000× fewer upstream calls). This is what makes ~1M users feasible.

## Language / runtime advantages

| Area | Why it's better in Go |
|---|---|
| **Concurrency** | Goroutines (~few KB each) vs threads/async-state; 50k WS connections ≈ a few hundred MB, not GBs. |
| **GC / latency** | Go's low-pause GC (sub-ms) gives steadier tail latency than server-GC pauses. |
| **Memory** | Value types + tight structs, no per-object header overhead; lower allocation rate. |
| **Deployment** | One CGO-free static binary; cross-compiles to win/linux/arm; container image ~23 MB distroless vs hundreds of MB for the .NET runtime image. |
| **Startup** | No JIT warmup → fast autoscaling and rolling restarts. |
| **Backpressure** | Bounded per-connection queues with drop metrics — slow consumers can't balloon memory. |

## Engineering / resilience improvements (built into the Go version)

- **Circuit breaker** on MT5 egress — fails fast instead of 100 s hangs.
- **Connection pooling** with auto re-auth + keep-alive ping.
- **Pooled `CopyFrom` bulk ingest** + indexed Timescale/Postgres store.
- **Prometheus metrics**, structured rotating logs, health/readiness, graceful
  shutdown — first-class.
- **Horizontal scale** via a role-gated binary (api/ws/poller/mt5/jobs) + Redis +
  NATS — no rewrite to scale out.

## Honest caveats

- Some gains (fan-out, circuit breaker, metrics) are **architectural** and could
  also be retrofitted into .NET; the rewrite was the opportunity to do them right.
- The RAM/startup/deploy advantages are **language/runtime-inherent**.

## Bottom line

Same API, **~2× lighter at rest, far lighter and steadier under load**, a
**~1000×** reduction in upstream MT5 traffic at scale via fan-out, single-binary
deployment, and production-grade resilience/observability — built for ~1M users
where the per-connection .NET model would not scale economically.
