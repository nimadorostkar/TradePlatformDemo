#!/usr/bin/env bash
# Deploy the whole platform to a Docker host over SSH.
#
#   deploy/deploy.sh                       # defaults below
#   SSH_HOST=root@1.2.3.4 SSH_KEY=~/.ssh/k PUBLIC_ORIGIN=http://1.2.3.4:8080 deploy/deploy.sh
#
# Subdomains (optional): with DNS for both names pointing at the host,
#   TERMINAL_HOST=trade.example.com CLIENT_AREA_HOST=my.example.com EDGE_PORT=80 deploy/deploy.sh
# serves the terminal on the first, the client area on the second (each from
# its root, with the gateway and CRM same-origin under it), keeps the bare IP
# working as before, and shares one sign-in across both through a session
# cookie on their common parent domain.
#
# What it does:
#   1. builds the terminal here (service URLs are same-origin paths);
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
TERMINAL_HOST="${TERMINAL_HOST:-}"
CLIENT_AREA_HOST="${CLIENT_AREA_HOST:-}"

# The subdomains' origins share PUBLIC_ORIGIN's scheme and port; the session
# cookie domain is their longest common parent (example.com for
# trade.example.com + my.example.com), empty when only one or none is set.
# A default port (:80 on http, :443 on https) is dropped everywhere: the
# browser's own idea of its origin never carries one, and the SPA compares
# origins verbatim to know which application it is.
scheme_port() { local o="$1"; local scheme="${o%%://*}"; local rest="${o#*://}"; local port=""; case "$rest" in *:*) port=":${rest##*:}" ;; esac
  if { [ "$scheme" = http ] && [ "$port" = ":80" ]; } || { [ "$scheme" = https ] && [ "$port" = ":443" ]; }; then port=""; fi
  printf '%s|%s' "$scheme" "$port"; }
IFS='|' read -r PUBLIC_SCHEME PUBLIC_PORT <<<"$(scheme_port "$PUBLIC_ORIGIN")"
PUBLIC_ORIGIN="${PUBLIC_SCHEME}://${PUBLIC_ORIGIN#*://}"; PUBLIC_ORIGIN="${PUBLIC_ORIGIN%%:80}"; [ "$PUBLIC_SCHEME" = https ] && PUBLIC_ORIGIN="${PUBLIC_ORIGIN%%:443}"
TERMINAL_ORIGIN=""; CLIENT_AREA_ORIGIN=""
[ -n "$TERMINAL_HOST" ] && TERMINAL_ORIGIN="${PUBLIC_SCHEME}://${TERMINAL_HOST}${PUBLIC_PORT}"
[ -n "$CLIENT_AREA_HOST" ] && CLIENT_AREA_ORIGIN="${PUBLIC_SCHEME}://${CLIENT_AREA_HOST}${PUBLIC_PORT}"
COOKIE_DOMAIN=""
if [ -n "$TERMINAL_HOST" ] && [ -n "$CLIENT_AREA_HOST" ]; then
  COOKIE_DOMAIN="$(python3 - "$TERMINAL_HOST" "$CLIENT_AREA_HOST" <<'PY'
import sys
a, b = (h.lower().split('.') for h in sys.argv[1:3])
common = []
for x, y in zip(reversed(a), reversed(b)):
    if x != y: break
    common.append(x)
common.reverse()
# Need at least a registrable domain (two labels) that is a proper parent of both.
print('.'.join(common) if len(common) >= 2 and (len(common) < len(a) or len(common) < len(b)) else '')
PY
)"
fi

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

# Service URLs are same-origin paths (see deploy/frontend.env.example), so the
# terminal works through any address that reaches the edge, not just
# PUBLIC_ORIGIN — which remains the address the smoke test uses.
echo "▸ building terminal + client area (${APP_ENV}, ${VERSION})"
[ -n "$TERMINAL_HOST" ] && echo "  terminal     ${TERMINAL_ORIGIN}"
[ -n "$CLIENT_AREA_HOST" ] && echo "  client area  ${CLIENT_AREA_ORIGIN}"
[ -n "$COOKIE_DOMAIN" ] && echo "  one sign-in across *.${COOKIE_DOMAIN}"
( cd "$ROOT/frontend"
  VITE_APP_ENV="$APP_ENV" \
  VITE_GATEWAY_HTTP_URL="/gateway" \
  VITE_GATEWAY_WS_URL="/gateway" \
  VITE_CRM_HTTP_URL="/crm" \
  VITE_TERMINAL_ORIGIN="$TERMINAL_ORIGIN" \
  VITE_CLIENT_AREA_ORIGIN="$CLIENT_AREA_ORIGIN" \
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
    -e "s|__TERMINAL_ORIGIN__|$TERMINAL_ORIGIN|g" -e "s|__CLIENT_AREA_ORIGIN__|$CLIENT_AREA_ORIGIN|g" \
    -e "s|^APP_ENV=.*|APP_ENV=$APP_ENV|" -e "s|__VERSION__|$VERSION|g" frontend.env.example > frontend.env
# Non-secret settings that may change between deploys are kept current in
# the files created once above (secrets in them are never touched).
upsert() { local file="\$1" key="\$2" value="\$3"; if grep -q "^\${key}=" "\$file"; then sed -i "s|^\${key}=.*|\${key}=\${value}|" "\$file"; else printf '%s=%s\n' "\$key" "\$value" >> "\$file"; fi; }
upsert .env TERMINAL_HOST '$TERMINAL_HOST'
upsert .env CLIENT_AREA_HOST '$CLIENT_AREA_HOST'
upsert .env EDGE_PORT '$EDGE_PORT'
upsert gateway.env SESSION_COOKIE_DOMAIN '$COOKIE_DOMAIN'
# The gateway's WebSocket origin allowlist must name every origin the
# terminal is served on; entries added by hand (an upcoming domain) are kept.
merged="$(grep '^CORS_ALLOWED_ORIGINS=' gateway.env | cut -d= -f2-)"
for o in '$PUBLIC_ORIGIN' '$TERMINAL_ORIGIN' '$CLIENT_AREA_ORIGIN'; do
  [ -n "\$o" ] || continue
  case ",\$merged," in *",\$o,"*) ;; *) merged="\${merged:+\$merged,}\$o" ;; esac
done
upsert gateway.env CORS_ALLOWED_ORIGINS "\$merged"
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
# The WebSocket stream must accept every origin the terminal is served on:
# a browser on a subdomain missing from the gateway's allowlist gets a 403
# on /ws and a terminal that never streams. Probed with the documented demo
# sign-in; 101 is the upgrade, anything else is a misconfiguration.
crm=$(curl -s -X POST -H 'Content-Type: application/json' "$PUBLIC_ORIGIN/gateway/api/Authentication/crmlogin" \
  -d '{"email":"trader@example.com","password":"correct-password"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
jwt=$(curl -s -X POST -H 'Content-Type: application/json' "$PUBLIC_ORIGIN/gateway/api/Authentication/login" \
  -d "{\"Username\":\"trader@example.com\",\"CRMToken\":\"$crm\",\"Remember\":false}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
ws_probe() { # $1 origin, $2 host to resolve (empty: as-is)
  local origin="$1" host="$2" port resolve=()
  port="${origin##*:}"; case "$origin" in *://*:*) ;; https://*) port=443 ;; *) port=80 ;; esac
  [ -n "$host" ] && resolve=(--resolve "${host}:${port}:${HOST_IP}")
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${resolve[@]}" \
    -H "Origin: $origin" -H "Authorization: Bearer $jwt" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: tradeplatform.v1' \
    "$origin/gateway/ws?symbol=EURUSD&methodtype=GetQuotes&TP=1" || true
}
HOST_IP="${SSH_HOST#*@}"
code=$(ws_probe "$PUBLIC_ORIGIN" "")
[ "$code" = 101 ] && echo "websocket OK at ${PUBLIC_ORIGIN}" || { echo "websocket at ${PUBLIC_ORIGIN} answered ${code} (origin not allowed?)" >&2; exit 1; }
# Each subdomain answers through the edge by name (resolved to the host, so
# the check works before DNS has propagated to this machine), REST and stream.
for pair in "terminal|$TERMINAL_HOST|$TERMINAL_ORIGIN" "client area|$CLIENT_AREA_HOST|$CLIENT_AREA_ORIGIN"; do
  IFS='|' read -r label host origin <<<"$pair"
  [ -n "$host" ] || continue
  port="${origin##*:}"; case "$origin" in *://*:*) ;; https://*) port=443 ;; *) port=80 ;; esac
  code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "${host}:${port}:${HOST_IP}" "$origin/gateway/readyz" || true)
  [ "$code" = 200 ] && echo "${label} OK at ${origin}" || { echo "${label} at ${origin} answered ${code}" >&2; exit 1; }
  code=$(ws_probe "$origin" "$host")
  [ "$code" = 101 ] && echo "${label} websocket OK" || { echo "${label} websocket at ${origin} answered ${code} (origin not allowed?)" >&2; exit 1; }
done
echo "✔ deployed ${VERSION} → ${PUBLIC_ORIGIN}${TERMINAL_HOST:+  ·  ${TERMINAL_ORIGIN}}${CLIENT_AREA_HOST:+  ·  ${CLIENT_AREA_ORIGIN}}"
