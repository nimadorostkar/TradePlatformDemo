#!/usr/bin/env bash
# Authenticated READ-ONLY sweep. Takes a JWT; never sees a password.
#
# EXPLICITLY NOT CALLED, anywhere in this file:
#   POST /api/Trade/send_request      (submits a real order)
#   POST /api/Alert/create            DELETE /api/Alert/delete
#   POST /api/Workspace/save
#   any /api/Order|Position|Deal|History mutation (delete/update/restore/cancel/reopen/fix)
# Every request below is a GET that reads state.
set -u
B="${BASE_URL:-https://example.com}"
T="${TOKEN:?set TOKEN to the JWT}"
WSPROBE="${WSPROBE:-./bin/wsprobe}"
P=0; F=0; N=0
pass(){ echo "  PASS  $1"; P=$((P+1)); }
fail(){ echo "  FAIL  $1"; F=$((F+1)); }
note(){ echo "  note  $1"; N=$((N+1)); }
get(){ curl -s -m 25 -o /tmp/ab -w "%{http_code}" -H "Authorization: Bearer $T" "$B$1" 2>/dev/null; }
chk(){ local n="$1" p="$2"; local c; c=$(get "$p"); if [ "$c" = "200" ]; then pass "$n [200]"; else fail "$n: HTTP $c $(head -c 120 /tmp/ab)"; fi; }
has(){ if grep -q "$2" /tmp/ab; then pass "  ↳ $1"; else fail "  ↳ $1 (field '$2' absent)"; fi; }

# Which account does this token actually own? (decoded locally from the JWT
# payload — no secret involved, the payload is not encrypted.)
LOGIN="${LOGIN:-$(python3 - "$T" <<'PYEOF'
import sys, json, base64
try:
    payload = sys.argv[1].split('.')[1]
    payload += '=' * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
except Exception:
    sys.exit()
acc = None
for k in claims:
    if k.lower().endswith('accounts') or k.lower() == 'accounts':
        acc = claims[k]; break
if acc is None:
    sys.exit()
if isinstance(acc, list):
    acc = ','.join(str(x) for x in acc)
first = str(acc).split(',')[0].strip()
if first:
    print(first)
PYEOF
)}"
echo "token accounts claim → first login: ${LOGIN:-<none found>}"
[ -z "$LOGIN" ] && { echo "Could not read an account from the token; set LOGIN=<number> explicitly."; exit 2; }
echo

echo "════ Symbols ════"
chk "symbol/getlist"                    "/api/Symbol/getlist"
chk "symbol/getsymbolsbyname (tv)"      "/api/Symbol/getsymbolsbyname?name=EURUSD&source=tv"
has "volume_min_lots present"           "volume_min_lots"
has "volume_step_lots present"          "volume_step_lots"
chk "symbol/getGroup"                   "/api/Symbol/getGroup"

echo "════ Quotes / chart ════"
chk "tick/last (tv)"                    "/api/Tick/last?symbol=EURUSD&source=tv"
chk "tick/last_group"                   "/api/Tick/last_group?group=*"
chk "tick/stat"                         "/api/Tick/stat?symbol=EURUSD"
chk "tick/get (chart bars)"             "/api/Tick/get?symbol=EURUSD&resolution=1D"
chk "tick/getHistoryby1Dresolution"     "/api/Tick/getHistoryby1Dresolution?symbol=EURUSD"

echo "════ Market depth (honesty flags) ════"
if [ "$(get "/api/Tick/get_marketdepth?symbol=EURUSD")" = "200" ]; then
  pass "tick/get_marketdepth [200]"
  grep -q '"volumeUnit":"lots"' /tmp/ab && pass "  ↳ volumeUnit stated as lots" || note "  ↳ volumeUnit not stated (empty book?)"
  if grep -q '"crossed":true' /tmp/ab; then
    fail "  ↳ crossed:true — MT5_BOOK_SIDE_CONVENTION is wrong for this broker (flip mql5 ⇄ manager)"
  else
    pass "  ↳ crossed:false (book side convention correct)"
  fi
  grep -q '"unknownSideCodes":\[\]' /tmp/ab && pass "  ↳ no unknown side codes" || note "  ↳ unknownSideCodes: $(python3 -c "
import json,sys
try: print(json.load(open('/tmp/ab'))['data'].get('unknownSideCodes'))
except Exception: print('(unreadable)')" 2>/dev/null)"
else
  fail "tick/get_marketdepth"
fi

echo "════ Account ════"
chk "user/get (tv)"                     "/api/User/get?login=$LOGIN&source=tv"
chk "user/get_trade_state"              "/api/User/get_trade_state?login=$LOGIN"

echo "════ Positions (lots + swap/commission) ════"
chk "position/get_total"                "/api/Position/get_total?login=$LOGIN"
if [ "$(get "/api/Position/get_page?login=$LOGIN&offset=0&total=10&source=tv")" = "200" ]; then
  pass "position/get_page (tv) [200]"
  if grep -q '"qtyLots"' /tmp/ab; then pass "  ↳ qtyLots present"
  elif grep -q '"data":\[\]\|"data":null' /tmp/ab; then note "  ↳ no open positions to inspect"
  else fail "  ↳ qtyLots missing from a non-empty position page"; fi
  grep -q '"swap"' /tmp/ab && pass "  ↳ swap present" || note "  ↳ swap absent (no positions?)"
else fail "position/get_page"; fi

echo "════ Orders ════"
chk "order/get_total"                   "/api/Order/get_total?login=$LOGIN"
if [ "$(get "/api/Order/get_page?login=$LOGIN&offset=0&total=10&source=tv")" = "200" ]; then
  pass "order/get_page (tv) [200]"
  grep -qE '"qtyLots"|"data":\[\]|"data":null' /tmp/ab && pass "  ↳ qtyLots present or book empty" || fail "  ↳ qtyLots missing"
else fail "order/get_page"; fi

echo "════ History / deals / executions ════"
chk "history/get_total"                 "/api/History/get_total?login=$LOGIN"
chk "history/get_page (tv)"             "/api/History/get_page?login=$LOGIN&offset=0&total=10&source=tv"
chk "deal/get_total"                    "/api/Deal/get_total?login=$LOGIN"
chk "deal/get_page"                     "/api/Deal/get_page?login=$LOGIN&offset=0&total=10"
chk "deal/since (execution feed)"       "/api/Deal/since?login=$LOGIN&after=0&limit=5"

echo "════ Trade calculators (read-only — NO order is submitted) ════"
chk "trade/calc_buy_rate"               "/api/Trade/calc_buy_rate?symbol=EURUSD&volume=10000&login=$LOGIN"
chk "trade/calc_sell_rate"              "/api/Trade/calc_sell_rate?symbol=EURUSD&volume=10000&login=$LOGIN"
chk "trade/calc_profit"                 "/api/Trade/calc_profit?symbol=EURUSD&volume=10000&priceopen=1.08&priceclose=1.09&type=0"
chk "trade/check_margin"                "/api/Trade/check_margin?login=$LOGIN&symbol=EURUSD&volume=10000&type=0&price=1.08"

echo "════ Stored features ════"
# A gateway with no database reports these off through /api/Capabilities. That
# is a correct answer, not a failure — only an unexpected status is.
feat(){ # feat <name> <path> <capability-key>
  local c; c=$(get "$2")
  if [ "$c" = "200" ]; then pass "$1 [200]"; return; fi
  if grep -q "unavailable" /tmp/ab; then
    note "$1 reported unavailable by design: $(python3 -c "
import json,sys
try: print(json.load(open('/tmp/ab')).get('errorMessage'))
except Exception: print('(unreadable)')" 2>/dev/null)"
    return
  fi
  fail "$1: HTTP $c $(head -c 120 /tmp/ab)"
}
feat "alert/list (read only)"     "/api/Alert/list?login=$LOGIN"     alerts
feat "workspace/get (read only)"  "/api/Workspace/get?login=$LOGIN"  workspace

echo "════ Ownership guard ════"
c=$(get "/api/User/get?login=999999999"); [ "$c" = "403" ] && pass "foreign login → 403" || fail "foreign login → $c (want 403)"

echo "════ WebSocket streams (subprotocol auth) ════"
if [ -x "$WSPROBE" ]; then
  WS="${B/https:/wss:}"; WS="${WS/http:/ws:}"
  o=$("$WSPROBE" -n 1 -timeout 25s -token "$T" "$WS/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv" 2>&1|head -1)
  echo "$o" | grep -q symbolname && pass "TP=1 quotes" || fail "TP=1: $o"
  o=$("$WSPROBE" -n 1 -timeout 25s -token "$T" "$WS/ws?TP=3&methodtype=Getbylogin&login=$LOGIN" 2>&1|head -1)
  echo "$o" | grep -qE "ERROR|HTTP" && fail "TP=3: $o" || pass "TP=3 account stream"
  o=$("$WSPROBE" -n 1 -timeout 25s -token "$T" "$WS/ws?TP=2&methodtype=GetPagebyPagePositionWs&login=$LOGIN&offset=0&total=10" 2>&1|head -1)
  echo "$o" | grep -qE "ERROR|HTTP" && fail "TP=2: $o" || pass "TP=2 position stream"
else note "wsprobe not found at $WSPROBE; skipped WS"
fi

echo
echo "══════ authenticated read-only sweep: $P passed, $F failed, $N notes ══════"
echo "No order was submitted, and no alert or workspace was written."
