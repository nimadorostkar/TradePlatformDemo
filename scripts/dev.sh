#!/usr/bin/env bash
# Run the whole platform locally against the in-repo demomarket:
#
#   demomarket (real prices + demo broker)   127.0.0.1:5199   (backend/cmd/demomarket)
#   Go gateway       127.0.0.1:5063   (backend/.env.demo)
#   web terminal     http://localhost:3100  (Vite; proxies /gateway and /crm)
#
# Sign in with  trader@example.com / correct-password  (demo CRM users).
# Ctrl-C stops all three. Logs go to .dev-logs/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/.dev-logs"; mkdir -p "$LOGS"
PIDS=()
cleanup() { trap - EXIT INT TERM; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

for port in 5199 5063 3100; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — stop that process first" >&2; exit 1
  fi
done

if [ ! -f "$ROOT/frontend/.env" ]; then
  cp "$ROOT/frontend/.env.example" "$ROOT/frontend/.env"
  echo "created frontend/.env from .env.example (local defaults)"
fi

echo "▸ building gateway + mock"
( cd "$ROOT/backend" && go build -o bin/gateway ./cmd/gateway && go build -o bin/demomarket ./cmd/demomarket )

# User management needs a database. With Docker available a local PostgreSQL
# is started (data kept in the tradeplatform-dev-pg volume); without it the
# user store runs in memory with the same seed and everything still works.
USERS_DSN=""
if docker info >/dev/null 2>&1; then
  if ! docker ps --format '{{.Names}}' | grep -qx tradeplatform-dev-postgres; then
    docker rm -f tradeplatform-dev-postgres >/dev/null 2>&1 || true
    docker run -d --name tradeplatform-dev-postgres -p 127.0.0.1:55432:5432 \
      -e POSTGRES_USER=tradeplatform -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=tradeplatform \
      -v tradeplatform-dev-pg:/var/lib/postgresql/data postgres:16-alpine >/dev/null
  fi
  for _ in $(seq 1 40); do docker exec tradeplatform-dev-postgres pg_isready -U tradeplatform -d tradeplatform >/dev/null 2>&1 && break; sleep 0.5; done
  sleep 1
  USERS_DSN="postgres://tradeplatform:dev@127.0.0.1:55432/tradeplatform?sslmode=disable"
  echo "▸ postgres      127.0.0.1:55432 (docker: tradeplatform-dev-postgres)"
else
  echo "▸ postgres      not available (Docker not running) — user store runs in memory"
fi

echo "▸ demomarket  :5199"
( cd "$ROOT/backend" && USERS_DSN="$USERS_DSN" ADMIN_TOKEN=dev-admin-token exec ./bin/demomarket -addr 127.0.0.1:5199 ) >"$LOGS/demomarket.log" 2>&1 &
PIDS+=($!)
# The gateway authenticates its MT5 session at startup and only retries on
# its 20 s ping loop, so the mock must be listening before the gateway starts.
for _ in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:5199/ && break; sleep 0.25; done

echo "▸ gateway       :5063"
( cd "$ROOT/backend" && set -a && . ./.env.demo && set +a && exec ./bin/gateway ) >"$LOGS/gateway.log" 2>"$LOGS/gateway.err" &
PIDS+=($!)
for _ in $(seq 1 120); do curl -fsS http://127.0.0.1:5063/readyz >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS http://127.0.0.1:5063/readyz >/dev/null || { echo "gateway did not become ready — see $LOGS/gateway.log" >&2; exit 1; }

echo "▸ web terminal  http://localhost:3100"
( cd "$ROOT/frontend" && exec npm run dev --silent ) >"$LOGS/vite.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do curl -fsS http://localhost:3100/ >/dev/null 2>&1 && break; sleep 0.5; done

cat <<MSG

  ✔ running — open http://localhost:3100
    sign in: trader@example.com / correct-password  (or create a demo account on the sign-in screen)
    admin:   curl -H 'Authorization: Bearer dev-admin-token' http://127.0.0.1:5199/admin/users
    logs:    $LOGS/{demomarket,gateway,vite}.log

MSG
wait -n "${PIDS[@]}" 2>/dev/null || wait
