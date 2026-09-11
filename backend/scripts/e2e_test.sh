#!/usr/bin/env bash
# End-to-end production-shape test: exercises EVERY documented REST endpoint,
# the WebSocket contract (all TPs + auth/ownership), security behaviors
# (401/403, CORS, rate limiting, XFF spoofing), and observability.
#
# Run against a gateway wired to scripts/mockmt5 (or a staging MT5):
#   go run ./scripts/mockmt5 &          # :5199
#   MT5_HOST_URL=http://127.0.0.1 MT5_PORT=5199 CRM_URL=http://127.0.0.1:5199 ... ./bin/gateway &
#   BASE_URL=http://localhost:5063 ./scripts/e2e_test.sh
#
# Requires: curl, and bin/wsprobe (go build -o bin/wsprobe ./scripts/wsprobe).
set -u

BASE_URL="${BASE_URL:-http://localhost:5063}"
METRICS_URL="${METRICS_URL:-http://127.0.0.1:9090/metrics}"
WS_URL="$(echo "$BASE_URL" | sed 's/^http/ws/')"
WSPROBE="${WSPROBE:-./bin/wsprobe}"
CRM_EMAIL="${CRM_EMAIL:-trader@opofinance.com}"
CRM_PASSWORD="${CRM_PASSWORD:-correct-password}"
OWNED_LOGIN="${OWNED_LOGIN:-1010}"      # in the token's accounts claim
FOREIGN_LOGIN="${FOREIGN_LOGIN:-9999}"  # NOT in the accounts claim
MANAGER_API_KEY="${MANAGER_API_KEY:-}"

PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

# expect <name> <want-status> <method> <path> [body]
expect() {
  local name="$1" want="$2" method="$3" path="$4" body="${5:-}"
  local args=(-s -o /tmp/e2e_body -w '%{http_code}' -X "$method" -H "Authorization: Bearer ${TOKEN:-}")
  [ -n "$MANAGER_API_KEY" ] && args+=(-H "X-Manager-Key: $MANAGER_API_KEY")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  local code; code=$(curl "${args[@]}" "$BASE_URL$path")
  if [ "$code" = "$want" ]; then ok "$name [$code]"; else bad "$name: got $code want $want ($(head -c 120 /tmp/e2e_body))"; fi
}

# expect_body <name> <substring> — checks the body of the previous expect()
expect_body() {
  if grep -q "$2" /tmp/e2e_body; then ok "$1"; else bad "$1: body missing '$2' ($(head -c 160 /tmp/e2e_body))"; fi
}

echo "════ 1. Operational endpoints ════"
expect "GET /healthz" 200 GET /healthz;                          expect_body "healthz alive" '"status":"alive"'
expect "GET /readyz (MT5 session up)" 200 GET /readyz;           expect_body "readyz ready" '"status":"ready"'
expect "public GET /metrics is not exposed" 404 GET /metrics
code=$(curl -s -o /dev/null -w '%{http_code}' "$METRICS_URL")
[ "$code" = 200 ] && ok "private metrics listener [200]" || bad "private metrics listener: got $code want 200"
body=$(curl -s -w '\n%{http_code}' "$BASE_URL/")
echo "$body" | tail -1 | grep -q 200 && echo "$body" | grep -qi "swagger\|opo" && ok "GET / serves landing page [200]" || bad "GET /: $(echo "$body" | tail -1)"

echo "════ 2. Authentication (production CRM flow) ════"
TOKEN=""
expect "crmlogin rejects bad password" 401 POST /api/Authentication/crmlogin '{"email":"trader@opofinance.com","password":"wrong"}'
expect "crmlogin accepts good creds" 200 POST /api/Authentication/crmlogin "{\"email\":\"$CRM_EMAIL\",\"password\":\"$CRM_PASSWORD\"}"
CRMTOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' /tmp/e2e_body)
[ -n "$CRMTOKEN" ] && ok "crm token extracted" || bad "no crm token in response"
expect "login (username only) rejected in hardened mode" 401 POST /api/Authentication/login '{"Username":"trader"}'
expect "login with CRMToken issues JWT" 200 POST /api/Authentication/login "{\"Username\":\"trader\",\"CRMToken\":\"$CRMTOKEN\"}"
TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' /tmp/e2e_body)
[ -n "$TOKEN" ] && ok "JWT extracted (len ${#TOKEN})" || bad "no JWT issued"

echo "════ 3. Auth enforcement ════"
SAVED="$TOKEN"; TOKEN=""
expect "no token → 401" 401 GET /api/Test/getServerTime
TOKEN="garbage.token.here"
expect "garbage token → 401" 401 GET /api/Test/getServerTime
TOKEN="$SAVED"
expect "valid token → 200" 200 GET /api/Test/getServerTime

echo "════ 4. Order endpoints ════"
SAVED_MANAGER_KEY="$MANAGER_API_KEY"; MANAGER_API_KEY=""
expect "manager route rejects retail JWT" 403 GET "/api/Order/get?ticket=100001"
MANAGER_API_KEY="$SAVED_MANAGER_KEY"
expect "order/get" 200 GET "/api/Order/get?ticket=100001"
expect "order/get_total" 200 GET "/api/Order/get_total?login=$OWNED_LOGIN"
expect "order/get_page" 200 GET "/api/Order/get_page?login=$OWNED_LOGIN&offset=0&total=10"
expect "order/get_page (tv)" 200 GET "/api/Order/get_page?login=$OWNED_LOGIN&offset=0&total=10&source=tv"
expect "order/get_page foreign login → 403" 403 GET "/api/Order/get_page?login=$FOREIGN_LOGIN&offset=0&total=10"
expect "order/get_batch" 200 GET "/api/Order/get_batch?login=$OWNED_LOGIN&group=&ticket=100001&symbol=EURUSD"
expect "order/delete" 200 DELETE "/api/Order/delete?ticket=100001"
expect "order/update_order" 200 POST /api/Order/update_order '{"Order":100001,"Login":1010,"Symbol":"EURUSD","PriceOrder":1.08}'
expect "order/cancel" 200 GET "/api/Order/cancel?ticket=100001"
expect "order/list" 200 GET "/api/Order/list?from=0&to=9999999999&server=main"
expect "order/getbackup" 200 GET "/api/Order/getbackup?backup=b1&login=$OWNED_LOGIN&ticket=100001&from=0&to=9999999999&server=main"
expect "order/restore" 200 POST /api/Order/restore '{"Order":100001}'
expect "order/reopen" 200 GET "/api/Order/reopen?ticket=100001"

echo "════ 5. Position endpoints ════"
expect "position/get" 200 GET "/api/Position/get?login=$OWNED_LOGIN&symbol=EURUSD"
expect "position/get (tv)" 200 GET "/api/Position/get?login=$OWNED_LOGIN&symbol=EURUSD&source=tv"
expect "position/get_total" 200 GET "/api/Position/get_total?login=$OWNED_LOGIN"
expect "position/get_page" 200 GET "/api/Position/get_page?login=$OWNED_LOGIN&offset=0&total=10"
expect "position/get_page (tv)" 200 GET "/api/Position/get_page?login=$OWNED_LOGIN&offset=0&total=10&source=tv"
expect "position/get_page foreign login → 403" 403 GET "/api/Position/get_page?login=$FOREIGN_LOGIN&offset=0&total=10"
expect "position/get_batch" 200 GET "/api/Position/get_batch?login=$OWNED_LOGIN&group=&ticket=555001&symbol=EURUSD"
expect "position/update_position" 200 POST /api/Position/update_position '{"Position":555001,"Login":1010}'
expect "position/delete" 200 DELETE "/api/Position/delete?ticket=555001"
expect "position/backup_list" 200 GET "/api/Position/backup_list?from=0&end=9999999999&server=main"
expect "position/backup_get" 200 GET "/api/Position/backup_get?backup=b1&login=$OWNED_LOGIN&from=0&end=9999999999&server=main"
expect "position/restore" 200 POST /api/Position/restore '{"Position":555001}'
expect "position/checkPosition" 200 GET "/api/Position/checkPosition?login=$OWNED_LOGIN"
expect "position/fixPosition" 200 GET "/api/Position/fixPosition?login=$OWNED_LOGIN"

echo "════ 6. Deal endpoints ════"
expect "deal/get" 200 GET "/api/Deal/get?ticket=1"
expect "deal/get_total" 200 GET "/api/Deal/get_total?login=$OWNED_LOGIN&from=0&to=9999999999"
expect "deal/get_page" 200 GET "/api/Deal/get_page?login=$OWNED_LOGIN&from=0&to=9999999999&offset=0&index=10"
expect "deal/get_batch" 200 GET "/api/Deal/get_batch?login=$OWNED_LOGIN&group=&ticket=1&from=0&to=9999999999&symbol=EURUSD"
expect "deal/update_deal" 200 POST /api/Deal/update_deal '{"Deal":1}'
expect "deal/delete" 200 DELETE "/api/Deal/delete?ticket=1"
expect "deal/backup_list" 200 GET "/api/Deal/backup_list?from=0&to=9999999999&server=main"
expect "deal/backup_get" 200 GET "/api/Deal/backup_get?backup=b1&login=$OWNED_LOGIN&from=0&to=9999999999&server=main"
expect "deal/restore_deal" 200 POST /api/Deal/restore_deal '{"Deal":1}'
expect "removed deal WebSocket demo" 404 GET /api/Deal/GetDataByWebSocket

echo "════ 7. History endpoints ════"
expect "history/get" 200 GET "/api/History/get?ticket=100001"
expect "history/get_total" 200 GET "/api/History/get_total?login=$OWNED_LOGIN&from=0&to=9999999999"
expect "history/get_page (tv)" 200 GET "/api/History/get_page?login=$OWNED_LOGIN&from=0&to=9999999999&offset=0&total=10&source=tv"
expect "history/get_batch" 200 GET "/api/History/get_batch?login=$OWNED_LOGIN&groups=&tickets=1&from=0&to=9999999999&symbol=EURUSD"
expect "history/delete" 200 DELETE "/api/History/delete?ticket=1"
expect "history/update_history" 200 POST /api/History/update_history '{"Order":100001}'

echo "════ 8. Symbol endpoints ════"
expect "symbol/getlist" 200 GET /api/Symbol/getlist
expect "symbol/getsymbolsbyname" 200 GET "/api/Symbol/getsymbolsbyname?symbol=EURUSD"
expect "symbol/getsymbolsbyname (tv)" 200 GET "/api/Symbol/getsymbolsbyname?symbol=EURUSD&source=tv"
expect_body "tv symbol transform present" '"ticker"'
expect "symbol/getsymbolsbymask (tv)" 200 GET "/api/Symbol/getsymbolsbymask?mask=EUR&source=tv"
expect "symbol/getsymbolsbygroup" 200 GET "/api/Symbol/getsymbolsbygroup?symbol=EURUSD&group=Forex"
expect "symbol/getGroup" 200 GET "/api/Symbol/getGroup?group=demo"

echo "════ 9. Tick endpoints ════"
expect "tick/last" 200 GET "/api/Tick/last?symbol=EURUSD&Id=0"
expect "tick/last (tv)" 200 GET "/api/Tick/last?symbol=EURUSD&Id=0&source=tv"
expect_body "tv quote fields" '"symbolname"'
expect "tick/last_group" 200 GET "/api/Tick/last_group?symbol=EURUSD&group=Forex&Id=0"
expect "tick/stat" 200 GET "/api/Tick/stat?symbol=EURUSD&Id=0"
expect "tick/history" 200 GET "/api/Tick/history?symbol=EURUSD&from=0&to=9999999999&data=M1"
expect "tick/get (chart bars)" 200 GET "/api/Tick/get?symbol=EURUSD&from=0&to=9999999999&data=M1"
expect "tick/getHistoryby1Dresolution" 200 GET "/api/Tick/getHistoryby1Dresolution?symbol=EURUSD&from=0&to=9999999999&resolution=1D"
expect "tick/get_marketdepth" 200 GET "/api/Tick/get_marketdepth?symbol=EURUSD"

echo "════ 10. Trade endpoints (full execution flow) ════"
expect "trade/balance" 200 GET "/api/Trade/balance?login=$OWNED_LOGIN&type=2&balance=100&comment=test"
expect "trade/calc_buy_rate" 200 GET "/api/Trade/calc_buy_rate?basecurrency=USD&currency=EUR&group=demo&symbol=EURUSD&price=1.08"
expect "trade/calc_sell_rate" 200 GET "/api/Trade/calc_sell_rate?basecurrency=USD&currency=EUR&group=demo&symbol=EURUSD&price=1.08"
expect "trade/check_margin" 200 GET "/api/Trade/check_margin?login=$OWNED_LOGIN&symbol=EURUSD&type=0&volume=10000&price=1.08"
expect "trade/calc_profit" 200 GET "/api/Trade/calc_profit?group=demo&symbol=EURUSD&type=0&volume=10000&price_open=1.08&price_close=1.09"
expect "trade/send_request (place order)" 200 POST /api/Trade/send_request "{\"Action\":\"200\",\"Login\":$OWNED_LOGIN,\"Symbol\":\"EURUSD\",\"Volume\":10000,\"TypeFill\":0,\"Type\":0,\"PriceOrder\":1.08,\"Digits\":5}"
expect_body "placed order in response" '"Order"'
expect "trade/send_request foreign login → 403" 403 POST /api/Trade/send_request "{\"Action\":\"200\",\"Login\":$FOREIGN_LOGIN,\"Symbol\":\"EURUSD\",\"Volume\":10000}"
expect "trade/get_request_result" 200 GET "/api/Trade/get_request_result?id=777"

echo "════ 11. User endpoints (AccountsAuthorize) ════"
expect "user/get owned" 200 GET "/api/User/get?login=$OWNED_LOGIN"
expect "user/get (tv)" 200 GET "/api/User/get?login=$OWNED_LOGIN&source=tv"
expect "user/get foreign → 403" 403 GET "/api/User/get?login=$FOREIGN_LOGIN"
expect "user/get_trade_state (tv)" 200 GET "/api/User/get_trade_state?login=$OWNED_LOGIN&source=tv"

echo "════ 12. Test endpoints ════"
expect "test/getServerTime" 200 GET /api/Test/getServerTime; expect_body "unix ts shape" '"unixTimestamp"'
expect "test/getUTCTime" 200 GET /api/Test/getUTCTime
expect "removed duplicate testMethod" 404 GET /api/Test/testMethod
expect "removed duplicate testMethod1" 404 GET /api/Test/testMethod1

echo "════ 13. Removed duplicate TradingView order surface ════"
SAVED="$TOKEN"; SAVED_MANAGER_KEY="$MANAGER_API_KEY"; TOKEN=""; MANAGER_API_KEY=""
expect "removed tv surface is 404 anonymously" 404 GET /api/tv/TVOrder/orders
TOKEN="$SAVED"; MANAGER_API_KEY="$SAVED_MANAGER_KEY"
expect "removed tv/gethistory" 404 GET /api/tv/TVOrder/gethistory
expect "removed tv/orders" 404 GET /api/tv/TVOrder/orders
expect "removed tv/cancelOrder/{id}" 404 GET /api/tv/TVOrder/cancelOrder/100001
expect "removed tv/modifyOrder" 404 POST /api/tv/TVOrder/modifyOrder '{"symbol":"EURUSD","qty":10000,"limitPrice":1.08}'
expect "removed tv/placeOrder" 404 POST /api/tv/TVOrder/placeOrder '{"symbol":"EURUSD","qty":10000,"limitPrice":1.08}'

echo "════ 14. WebSocket contract ════"
# Authenticate with the opotrade.jwt.<JWT> subprotocol — the production
# transport. This section previously used ?access_token=, which the server only
# accepts when WS_ALLOW_QUERY_TOKEN=true, so the suite silently required a
# legacy insecure setting and never covered the default path at all.
ws() { "$WSPROBE" -token "$TOKEN" "$@"; }

out=$(ws -n 1 -print-subprotocol "$WS_URL/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv")
echo "$out" | grep -q '"symbolname":"EURUSD"' && ok "TP=1 tick stream (tv quote frame)" || bad "TP=1: $out"
# The JWT-bearing subprotocol must never be echoed back as the negotiated one.
echo "$out" | grep -q "^SUBPROTOCOL opotrade.v1$" && ok "negotiates opotrade.v1, never echoes the credential" || bad "subprotocol: $(echo "$out" | head -1)"
out=$(ws -n 1 "$WS_URL/ws?TP=2&methodtype=GetPagebyPagePositionWs&login=$OWNED_LOGIN&offset=0&total=10")
[ -n "$out" ] && ! echo "$out" | grep -q "ERROR\|HTTP" && ok "TP=2 position stream" || bad "TP=2: $out"
out=$(ws -n 1 "$WS_URL/ws?TP=3&methodtype=Getbylogin&login=$OWNED_LOGIN")
[ -n "$out" ] && ! echo "$out" | grep -q "ERROR\|HTTP" && ok "TP=3 user stream" || bad "TP=3: $out"
out=$(ws -n 1 "$WS_URL/ws?TP=4&methodtype=GetPagebyPageOrder&login=$OWNED_LOGIN&offset=0&total=10")
[ -n "$out" ] && ! echo "$out" | grep -q "ERROR\|HTTP" && ok "TP=4 order stream" || bad "TP=4: $out"
out=$(ws -n 1 "$WS_URL/ws?TP=9")
echo "$out" | grep -q "Invalid TP value" && ok "invalid TP streams literal error" || bad "TP=9: $out"
out=$("$WSPROBE" -n 1 "$WS_URL/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD")
echo "$out" | grep -q "HTTP 401" && ok "no token → 401 before upgrade" || bad "ws no-token: $out"
out=$(ws -n 1 "$WS_URL/ws?TP=2&methodtype=GetPagebyPagePositionWs&login=$FOREIGN_LOGIN")
echo "$out" | grep -q "HTTP 403" && ok "foreign account → 403 (ownership guard)" || bad "ws foreign: $out"
out=$(ws -n 2 "$WS_URL/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv")
[ "$(echo "$out" | grep -c symbolname)" -ge 2 ] && ok "continuous push (2+ frames)" || bad "continuous push: $out"

# The legacy query-string transport must stay rejected under the default
# WS_ALLOW_QUERY_TOKEN=false. Skipped when a run deliberately enables it.
if [ "${WS_ALLOW_QUERY_TOKEN:-false}" = "false" ]; then
  out=$("$WSPROBE" -n 1 "$WS_URL/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&access_token=$TOKEN")
  echo "$out" | grep -q "HTTP 401" && ok "legacy ?access_token= rejected by default" || bad "query token accepted: $out"
fi

echo "════ 15. CORS ════"
hdr=$(curl -s -o /dev/null -D - -H "Origin: https://app.opofinance.com" -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/Test/getServerTime" | grep -i access-control-allow-origin || true)
echo "$hdr" | grep -q "app.opofinance.com" && ok "allowlisted origin reflected" || bad "CORS allow: $hdr"
hdr=$(curl -s -o /dev/null -D - -H "Origin: https://evil.example.com" -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/Test/getServerTime" | grep -i access-control-allow-origin || true)
[ -z "$hdr" ] && ok "unlisted origin NOT reflected" || bad "CORS leak: $hdr"

echo "════ 16. Rate limiting (burst=100, rps=50) — run last ════"
# One curl process, 300 sequential requests over a kept-alive connection —
# fast enough (>1000 rps) to exhaust burst=100 before the 50 rps refill matters.
urls=$(printf "$BASE_URL/api/Test/getServerTime %.0s" $(seq 1 300))
codes=$(curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $urls)
n429=$(echo "$codes" | grep -c 429 || true)
[ "$n429" -gt 0 ] && ok "burst exhaustion produces 429s ($n429/300)" || bad "no 429 in 300 rapid requests"
# Immediately re-burst WITH a spoofed XFF. If XFF were trusted it would key a
# fresh bucket (burst=100 successes); ignored correctly, it inherits the
# exhausted peer bucket and mostly 429s (only ~50 rps refill can pass).
xffurls=$(printf "$BASE_URL/api/Test/getServerTime %.0s" $(seq 1 150))
xcodes=$(curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H "X-Forwarded-For: 9.9.9.9" $xffurls)
x429=$(echo "$xcodes" | grep -c 429 || true)
[ "$x429" -ge 50 ] && ok "spoofed XFF does not bypass limit ($x429/150 still 429)" || bad "XFF spoof looks honored (only $x429/150 got 429)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/healthz")
[ "$code" = "200" ] && ok "operational path exempt from limiting" || bad "healthz limited ($code)"
sleep 2

echo "════ 17. Observability ════"
metrics=$(curl -s "$METRICS_URL")
for m in http_requests_total http_request_duration_seconds ws_active_connections mt5_requests_total rate_limit_fail_open_total; do
  echo "$metrics" | grep -q "^$m\|# TYPE $m" && ok "metric $m exposed" || bad "metric $m missing"
done
echo "$metrics" | grep -q 'http_requests_total{.*status="429"' && ok "429s counted in metrics" || bad "429 not visible in metrics"
echo "$metrics" | grep -q 'mt5_requests_total{result="ok"}' && ok "MT5 upstream calls counted" || bad "mt5_requests_total not incremented"

echo
echo "══════ RESULT: $PASS passed, $FAIL failed ══════"
[ "$FAIL" -eq 0 ]
