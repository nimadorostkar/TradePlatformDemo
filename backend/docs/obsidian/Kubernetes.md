---
tags: [infra]
---
# Kubernetes

`deploy/k8s/` — the 1M-target topology.

- Role-split Deployments: api · ws · poller · mt5 · jobs.
- HPA (CPU, or `ws_active_connections` via prometheus-adapter).
- NATS backplane for cross-pod [[Hub and Fan-out]]; Redis for [[Rate Limiting]].
- ConfigMap + Secret; Service with ClientIP affinity for WS.

Related: [[Infrastructure]] · [[Optimizations]] · [[Roadmap]]
