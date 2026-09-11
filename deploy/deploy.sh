#!/usr/bin/env bash
# Deploy the whole platform to a Docker host over SSH.
#
#   deploy/deploy.sh                       # defaults below
#   SSH_HOST=root@1.2.3.4 SSH_KEY=~/.ssh/k PUBLIC_ORIGIN=http://1.2.3.4:8080 deploy/deploy.sh
#
# What it does:
#   1. builds the terminal HERE (the licensed TradingView bundle lives on the
#      licence holder's machine, never in git) with the public URLs compiled in
#      as fallbacks;
#   2. rsyncs deploy/ (+ the built SPA) and backend/ source to REMOTE_DIR;
#   3. on the host: writes gateway.env once with fresh random secrets, writes
#      frontend.env, then `docker compose up -d --build`;
#   4. smoke-tests the public origin: /healthz, /gateway/readyz, a mock login.
#
# Nothing secret is read from this machine; secrets are generated on the host.
set -euo pipefail

SSH_HOST="${SSH_HOST:-root@217.65.145.161}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/server_new_ed25519}"
EDGE_PORT="${EDGE_PORT:-8080}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://${SSH_HOST#*@}:${EDGE_PORT}}"
REMOTE_DIR="${REMOTE_DIR:-/opt/tradeplatform}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
PUBLIC_WS_ORIGIN="${PUBLIC_ORIGIN/http:\/\//ws://}"; PUBLIC_WS_ORIGIN="${PUBLIC_WS_ORIGIN/https:\/\//wss://}"
case "$PUBLIC_ORIGIN" in https://*) APP_ENV=production ;; *) APP_ENV=staging ;; esac

ssh_() { ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$SSH_HOST" "$@"; }

echo "▸ building terminal (${APP_ENV}, ${PUBLIC_ORIGIN}, ${VERSION})"
( cd "$ROOT/frontend"
  if ! npm run tv:check >/dev/null 2>&1; then
    echo "  ⚠ TradingView Charting Library not installed — the terminal will run without a chart."
    echo "    Obtain your own licence (tradingview.com/charting-library), then: npm run tv:sync -- --source=<package>"
  fi
  VITE_APP_ENV="$APP_ENV" \
  VITE_GATEWAY_HTTP_URL="${PUBLIC_ORIGIN}/gateway" \
  VITE_GATEWAY_WS_URL="${PUBLIC_WS_ORIGIN}/gateway" \
  VITE_CRM_HTTP_URL="${PUBLIC_ORIGIN}/crm" \
  VITE_CONFIRM_TRADES=true VITE_ENABLE_ONE_CLICK_TRADING=false VITE_ENABLE_LEGACY_AUTH_STORAGE=false \
  VITE_APP_VERSION="$VERSION" \
  npm run build --silent )

echo "▸ assembling frontend image context"
BUILD="$ROOT/deploy/frontend-build"
rm -rf "$BUILD"; mkdir -p "$BUILD"
cp -R "$ROOT/frontend/dist" "$BUILD/dist"
cp "$ROOT/frontend/deploy/nginx.conf" "$ROOT/frontend/deploy/entrypoint.sh" "$ROOT/deploy/frontend/Dockerfile" "$BUILD/"

echo "▸ syncing to ${SSH_HOST}:${REMOTE_DIR}"
ssh_ "mkdir -p '$REMOTE_DIR'"
rsync -az --delete -e "ssh -i $SSH_KEY" \
  --exclude 'frontend.env' --exclude 'gateway.env' \
  "$ROOT/deploy/" "$SSH_HOST:$REMOTE_DIR/deploy/"
rsync -az --delete -e "ssh -i $SSH_KEY" \
  --exclude '.git' --exclude 'bin' --exclude 'dist' --exclude '.env' --exclude '.env.*' \
  --exclude '.claude' --exclude 'docs' --exclude '.DS_Store' \
  "$ROOT/backend/" "$SSH_HOST:$REMOTE_DIR/backend/"

echo "▸ configuring + starting on host"
ssh_ bash -s <<REMOTE
set -euo pipefail
cd '$REMOTE_DIR/deploy'
if [ ! -f gateway.env ]; then
  jwt=\$(openssl rand -hex 32); mgr=\$(openssl rand -hex 24)
  sed -e "s|^JWT_SECRET_KEY=.*|JWT_SECRET_KEY=\$jwt|" \
      -e "s|^MANAGER_API_KEY=.*|MANAGER_API_KEY=\$mgr|" \
      -e "s|__PUBLIC_ORIGIN__|$PUBLIC_ORIGIN|g" gateway.env.example > gateway.env
  chmod 600 gateway.env
  echo "  gateway.env created with fresh secrets"
fi
sed -e "s|__PUBLIC_ORIGIN__|$PUBLIC_ORIGIN|g" -e "s|__PUBLIC_WS_ORIGIN__|$PUBLIC_WS_ORIGIN|g" \
    -e "s|^APP_ENV=.*|APP_ENV=$APP_ENV|" -e "s|__VERSION__|$VERSION|g" frontend.env.example > frontend.env
EDGE_PORT='$EDGE_PORT' docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps
REMOTE

echo "▸ smoke test ${PUBLIC_ORIGIN}"
for _ in $(seq 1 30); do curl -fsS "$PUBLIC_ORIGIN/healthz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$PUBLIC_ORIGIN/healthz"; echo
curl -fsS "$PUBLIC_ORIGIN/gateway/readyz"; echo
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  "$PUBLIC_ORIGIN/gateway/api/Authentication/crmlogin" -d '{"email":"trader@example.com","password":"wrong"}')
[ "$code" = 401 ] && echo "auth path OK (bad password → 401)" || { echo "unexpected crmlogin status $code" >&2; exit 1; }
echo "✔ deployed ${VERSION} → ${PUBLIC_ORIGIN}"
