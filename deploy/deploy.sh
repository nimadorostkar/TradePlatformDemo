#!/usr/bin/env bash
# Deploy the whole platform to a Docker host over SSH.
#
#   deploy/deploy.sh                       # defaults below
#   SSH_HOST=root@1.2.3.4 SSH_KEY=~/.ssh/k PUBLIC_ORIGIN=http://1.2.3.4:8080 deploy/deploy.sh
#
# What it does:
#   1. builds the terminal here with the public URLs compiled in as fallbacks;
#   2. rsyncs deploy/ (+ the built SPA) and backend/ source to REMOTE_DIR;
#   3. on the host: writes .env (database password, admin token) and
#      gateway.env once with fresh random secrets, writes frontend.env, then
#      `docker compose up -d --build`;
#   4. smoke-tests the public origin: /healthz, /gateway/readyz, a mock login.
#
# Safe to run from CI and a laptop at the same time: the host side takes a
# lock, so two deploys serialise instead of racing `docker compose up`, and
# the first SSH connection is retried for a couple of minutes because a
# fresh runner occasionally cannot reach the host on the first try.
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

SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30)
ssh_() { ssh "${SSH_OPTS[@]}" "$SSH_HOST" "$@"; }
LOCK=/run/lock/tradeplatform-deploy.lock

echo "▸ reaching ${SSH_HOST}"
for attempt in $(seq 1 8); do
  ssh_ true 2>/dev/null && break
  [ "$attempt" -lt 8 ] || { echo "cannot reach ${SSH_HOST} over SSH after 8 attempts" >&2; exit 1; }
  echo "  ssh attempt $attempt failed; retrying in 15s"; sleep 15
done

echo "▸ building terminal (${APP_ENV}, ${PUBLIC_ORIGIN}, ${VERSION})"
( cd "$ROOT/frontend"
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
# Do not rewrite the source tree under a deploy that is still building from
# it: wait until no other deploy holds the lock (the build step below takes
# it for real).
ssh_ "mkdir -p '$REMOTE_DIR' /run/lock && flock -w 900 '$LOCK' true"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude 'frontend.env' --exclude 'gateway.env' --exclude '.env' \
  "$ROOT/deploy/" "$SSH_HOST:$REMOTE_DIR/deploy/"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.git' --exclude 'bin' --exclude 'dist' --exclude '.env' --exclude '.env.*' \
  --exclude '.claude' --exclude 'docs' --exclude '.DS_Store' \
  "$ROOT/backend/" "$SSH_HOST:$REMOTE_DIR/backend/"

echo "▸ configuring + starting on host"
ssh_ bash -s <<REMOTE
set -euo pipefail
# One deploy at a time on the host, whoever started it (CI or a laptop):
# two concurrent \`compose up\` calls collide on container names.
exec 9>'$LOCK'
flock -w 900 9 || { echo "another deploy still holds $LOCK after 15 min" >&2; exit 1; }
cd '$REMOTE_DIR/deploy'
if [ ! -f .env ]; then
  printf 'POSTGRES_PASSWORD=%s\nADMIN_TOKEN=%s\n' "\$(openssl rand -hex 24)" "\$(openssl rand -hex 24)" > .env
  chmod 600 .env
  echo "  .env created (database password, admin token)"
fi
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
# A deploy interrupted mid-recreate leaves the old container renamed
# <hash>_tradeplatform-<svc>-1; the next recreate then fails on that name.
docker ps -aq --filter 'name=^/[0-9a-f]{12}_tradeplatform-' | xargs -r docker rm -f >/dev/null
EDGE_PORT='$EDGE_PORT' docker compose up -d --build --remove-orphans
# edge/nginx.conf is bind-mounted: a changed file is not re-read until nginx
# reloads, so an upstream rename would otherwise 502 until the next restart.
docker compose exec -T edge nginx -c /etc/nginx/edge/nginx.conf -t >/dev/null \
  && docker compose exec -T edge nginx -c /etc/nginx/edge/nginx.conf -s reload
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
