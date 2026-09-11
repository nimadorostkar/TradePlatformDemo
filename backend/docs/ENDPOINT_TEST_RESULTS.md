# Mock Endpoint Test Results

Every REST endpoint and every WebSocket dispatch driven through the **running
gateway** against a full mock MT5 + CRM upstream (all `/api/*` and `/client-api/*`
paths stubbed with valid payloads). Token obtained via the CRM login path
(account-scoped JWT with `accounts=1001,1002`), so `[AccountsAuthorize]`
endpoints are exercised for real.

Reproduce: start the mock + gateway (`MT5_HOST_URL`/`CRM_URL` → mock), then drive
the endpoint list. Summary below is the actual captured output.

## Production-shape suite — 120/120 passed

| Group | Endpoints | Result |
|---|---|---|
| Authentication | `login` (CRM), `crmlogin` | 200 (token issued) |
| Order | get, get_total, get_page (mt5+tv), get_batch, delete, update_order, cancel, list, getbackup, restore, reopen | all 200 / success=true |
| Position | get (mt5+tv), get_total, get_page, get_batch, update_position, delete, backup_list, backup_get, restore, checkPosition, fixPosition | all 200 / success=true |
| Deal | get, get_total, get_page, get_batch, update_deal, delete, backup_list, backup_get, restore_deal, since | canonical routes pass; removed demo route is 404 |
| History | get, get_total, get_page (mt5+tv), get_batch, delete, update_history | all 200 / success=true |
| Symbol | getlist, getsymbolsbyname (mt5+tv), getsymbolsbymask, getsymbolsbygroup, getGroup | all 200 / success=true |
| Tick | last (mt5+tv), last_group, stat, history, get, getHistoryby1Dresolution, get_marketdepth | all 200 / success=true |
| Trade | balance, calc_buy_rate, calc_sell_rate, check_margin, calc_profit, send_request, get_request_result | all 200 / success=true |
| User | get, get_trade_state | all 200 / success=true |
| Test | getServerTime, getUTCTime | both 200; removed duplicate aliases are 404 |
| Legacy TVOrder | gethistory, cancelOrder/{id}, modifyOrder, orders, placeOrder | duplicate hardcoded-account surface removed; all 404 |

Non-envelope responses (`crmlogin` → `{token}`, `Test/*` → `{unixTimestamp}`)
correctly have no `success` field.

## WebSocket /ws — 14/14 dispatch combos returned a valid frame

| TP | methodtype | Frame |
|---|---|---|
| 1 | GetQuotes | `[{"symbolname":"EURUSD","status":"Ok","bid":1.1,...}]` (TV Quote) |
| 1 | GetMarketDepth | raw upstream string (dispatcher passthrough — matches .NET) |
| 1 | GetStatistics | raw string |
| 1 | GetQuotesByGroup | raw string |
| 1 | GetM1History | `[{"time":1700,"open":1.1,...,"volume":0}]` (TV bars) |
| 1 | GetHistoryBy1DResolution | bucketed `[{"time":...,"open":...}]` |
| 2 | GetPosition | object (dispatcher does not forward `source` — matches .NET) |
| 2 | GetTotalPosition | raw string |
| 2 | GetPagebyPagePositionWs | TV list **serialized as a string** (matches .NET) |
| 2 | GetPositionBatch | raw string |
| 3 | Getbylogin | raw string (user dispatcher does not transform — matches .NET) |
| 3 | GetTradeState | raw string |
| 4 | GetPagebyPageOrder | TV list **serialized as a string** |
| 9 | (invalid) | `Invalid TP value` |

Each frame's shape matches the documented per-method dispatch behavior in
[`API.md`](API.md) and the .NET quirks in [`PARITY-NOTES.md`](PARITY-NOTES.md)
(dispatcher `GetMarketDepth`/user methods return raw vs the deserialized REST
method; Ws/Order page variants emit the TV list as a JSON string).

## Operational

`/healthz` 200, `/readyz` 200 (MT5 session authenticated against the mock),
public `/metrics` 404, private metrics listener 200. `GET /` serves the landing
page linking to `/swagger`.

## Findings

- **FIXED — `/swagger` + landing page.** `GET /` now serves a live status page
  (liveness/readiness indicators), `/swagger` serves a Swagger UI console, and
  `/openapi.json` serves the spec (66 paths). The base URL is now a working
  "it's alive" signal in a browser.

## Verdict

**All 74 REST endpoints and 14 WebSocket dispatch paths function correctly**
end-to-end through the live server (auth, account scoping, transforms, and the
.NET data-shape quirks all behave as specified). Combined with the golden
byte-parity suite and the unit/integration tests (`docs/TEST_RESULTS.md`), the
API surface is verified.
