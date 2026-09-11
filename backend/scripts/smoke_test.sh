#!/usr/bin/env bash
# Smoke test: health, readiness, an authenticated REST call, and a /ws connect.
#
# Usage:
#   BASE_URL=http://localhost:5063 ./scripts/smoke_test.sh
#
# Auth: set TOKEN=<jwt> to use an existing token. Otherwise the script attempts
# the legacy username login, which only works when LOGIN_REQUIRE_PASSWORD=false
# (in hardened/production mode, supply TOKEN from your CRM login instead).
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5063}"
WS_URL="${WS_URL:-$(echo "$BASE_URL" | sed 's/^http/ws/')}"
PASS=0 FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "== 1. Liveness /healthz =="
if curl -fsS "$BASE_URL/healthz" | grep -q '"status":"alive"'; then ok "/healthz"; else bad "/healthz"; fi

echo "== 2. Readiness /readyz =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/readyz")
if [ "$code" = "200" ]; then ok "/readyz ready"; else bad "/readyz not ready ($code)"; fi

echo "== 3. Metrics /metrics =="
if curl -fsS "$BASE_URL/metrics" | grep -q 'http_requests_total'; then ok "/metrics"; else bad "/metrics"; fi

echo "== 4. Obtain JWT =="
if [ -z "${TOKEN:-}" ]; then
  TOKEN=$(curl -fsS -X POST "$BASE_URL/api/Authentication/login" \
    -H 'Content-Type: application/json' \
    -d '{"Username":"smoke","Password":"smoke"}' 2>/dev/null \
    | sed -n 's/.*"Token":"\([^"]*\)".*/\1/p' || true)
fi
if [ -n "${TOKEN:-}" ]; then ok "token acquired (len ${#TOKEN})"; else bad "no token (set TOKEN=… for hardened mode)"; fi

echo "== 5. Authenticated REST call (GET /api/Test/getServerTime) =="
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN:-x}" "$BASE_URL/api/Test/getServerTime")
if [ "$code" = "200" ]; then ok "authed REST 200"; else bad "authed REST returned $code"; fi
# And confirm auth is enforced (no token → 401)
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/Test/getServerTime")
if [ "$code" = "401" ]; then ok "unauthed REST -> 401 (auth enforced)"; else bad "unauthed REST returned $code (expected 401)"; fi

echo "== 6. WebSocket /ws connect (expect HTTP 101) =="
# curl speaks the upgrade over http://, not ws://; a fixed 16-byte key avoids
# newline issues from base64 of random bytes.
key=$(printf '%s' "1234567890123456" | base64)
ws_line=$(curl -s -i -N --http1.1 --max-time 5 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $key" \
  "$BASE_URL/ws?symbol=EURUSD&methodtype=GetQuotes&TP=1&source=tv&access_token=${TOKEN:-}" \
  2>/dev/null | head -1 || true)
if echo "$ws_line" | grep -q "101"; then ok "/ws upgraded (101)"; else bad "/ws status: ${ws_line:-none}"; fi

echo
echo "== Result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
