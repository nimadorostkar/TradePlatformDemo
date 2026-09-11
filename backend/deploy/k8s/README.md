# Kubernetes deployment

Manifests for OpoMTSocket-Go. The service is a single **role-gated binary**; this
set runs `ROLES=all` and scales horizontally.

## Apply

```bash
# 1. Create the secret from your secret store (do NOT commit real values).
cp secret.example.yaml secret.yaml   # edit, or generate via External Secrets
kubectl apply -f secret.yaml
kubectl apply -f configmap.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f hpa.yaml
```

Point an Ingress / Envoy at the `opotrade-gateway` Service (port 80 → `http`).
Terminate TLS at the edge; enable WebSocket upgrade and (until the NATS backplane
is on) sticky sessions for `/ws`.

## Topology

- **Each replica holds its own MT5 session** (pool size 1 by default). The
  price-history **job is safe across replicas** — the Postgres advisory lock
  ensures only one replica's daily run fires.
- **Readiness** (`/readyz`) tracks the MT5 session, so a pod mid-reauth is pulled
  from rotation automatically.
- **Metrics** are scraped from `/metrics` on the HTTP port (Prometheus
  annotations are set on the pod).

## Scaling notes

- **HPA** uses CPU out of the box (3–50 replicas). For connection-aware scaling,
  install `prometheus-adapter` and target the `ws_active_connections` Pods metric
  (~5000/pod).
- **WebSocket fan-out**: with `NATS_URL` unset, the in-process hub polls per pod.
  With `NATS_URL` set, fan-out is **cross-pod** — hub pods subscribe to the bus
  and publish demand; a leader-elected `poller` (advisory-lock gated, so one is
  active cluster-wide) does the single poll per subscription and publishes
  results. Run a `poller` role set (or `ROLES=all`) for this.

## Splitting roles (optional, for large scale)

Copy `deployment.yaml` and override `ROLES` per workload, scaling each
independently:

| Workload   | `ROLES` | Notes |
|------------|---------|-------|
| api        | `api`   | stateless REST; scale on RPS/CPU |
| ws-hub     | `ws`    | scale on `ws_active_connections` |
| poller     | `poller`| one set; publishes per-symbol to NATS |
| mt5-session| `mt5`   | StatefulSet, 1 active + standby (broker IP allowlist) |
| jobs       | `jobs`  | 1 replica (or any; the advisory lock dedupes) |

The current build runs all roles in-process; the table is the target split as
NATS/gRPC seams are filled in.
