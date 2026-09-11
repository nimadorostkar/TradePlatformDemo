# Usage (client guide)

How to call the REST API and connect to the WebSocket. Full endpoint reference:
[`API.md`](API.md). Replace `$BASE` and `$WS` accordingly.

```bash
BASE=http://localhost:5063
WS=ws://localhost:5063
```

## 1. Get a token

**Production (CRM-backed):** log in via CRM to get a `CRMToken`, then exchange it:

```bash
# crmlogin returns a CRM access token
curl -s -X POST $BASE/api/Authentication/crmlogin \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"••••"}'
# → {"token":"<crm-access-token>"}

# exchange the CRM token for a gateway JWT carrying the account list
TOKEN=$(curl -s -X POST $BASE/api/Authentication/login \
  -H 'Content-Type: application/json' \
  -d '{"Username":"user@example.com","CRMToken":"<crm-access-token>"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
```

## 2. Authenticated REST calls

```bash
AUTH="Authorization: Bearer $TOKEN"

# server time (no MT5 dependency — handy health check of the auth path)
curl -s -H "$AUTH" "$BASE/api/Test/getServerTime"

# last quote, raw MT5 shape (data is a JSON-encoded string)
curl -s -H "$AUTH" "$BASE/api/Tick/last?symbol=EURUSD&Id=0&source=mt5"

# last quote, TradingView shape (data is a Quote array)
curl -s -H "$AUTH" "$BASE/api/Tick/last?symbol=EURUSD&Id=0&source=tv"

# open orders page (TradingView), account-scoped — login must be in the token's accounts claim
curl -s -H "$AUTH" "$BASE/api/Order/get_page?login=1001&offset=0&total=50&source=tv"

# chart bars rolled to 1D / 1W / 1M
curl -s -H "$AUTH" "$BASE/api/Tick/getHistoryby1Dresolution?symbol=EURUSD&from=1700000000&to=1800000000&resolution=1D"

# place a trade (account-scoped; body includes source for TV vs raw output)
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"Login":1001,"Symbol":"EURUSD","Volume":0.1,"Type":0,"TypeFill":0,"Action":"0","source":"tv"}' \
  "$BASE/api/Trade/send_request"
```

Every response is the envelope `{data,errorMessage,message,success}`; check
`success` (HTTP 200 vs 400). `data` is a string, object, or TV shape per
[`API.md`](API.md).

## 3. WebSocket streaming

The subscription is the query string; the server pushes the serialized `data`
every ~3s. Browser JWTs use a WebSocket credential subprotocol so the bearer
credential never enters proxy or application request URLs.

**wscat:**

```bash
npm i -g wscat
wscat -H "Authorization: Bearer $TOKEN" -c "$WS/ws?symbol=EURUSD&id=0&methodtype=GetQuotes&TP=1&source=tv"
# < [{"symbolname":"EURUSD","status":"Ok","bid":1.0854,"ask":1.0856,"lastprice":1.0854,"volume":12}]
```

**Browser:**

```js
const ws = new WebSocket(
  'wss://host/ws?symbol=EURUSD&id=0&methodtype=GetQuotes&TP=1&source=tv',
  ['tradeplatform.v1', `tradeplatform.jwt.${token}`],
);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

**Other streams** (change `TP` + `methodtype`, see [`API.md`](API.md)):

```
# positions for a login
$WS/ws?login=1001&methodtype=GetPosition&TP=2&source=tv
# account summary
$WS/ws?login=1001&methodtype=GetTradeState&TP=3
# live M1 chart window (from=0&to=1 = "last 2 minutes of broker time")
$WS/ws?symbol=EURUSD&from=0&to=1&methodtype=GetM1History&TP=1
```

## 4. Quick smoke

```bash
BASE_URL=$BASE ./scripts/smoke_test.sh
```
