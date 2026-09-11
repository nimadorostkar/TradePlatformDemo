# Current state audit

What exists today across the three repositories, audited 2026-07-30 before any
code was written here.

## Repositories

| Role                                          | Path                                  | State                                                  |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Gateway (read-only reference)                 | `~/Projects/opotrade-mt-socket-new`   | Production Go service. Not modified.                   |
| TradingView integration (read-only reference) | `~/Projects/trading-view-integration` | Working webpack app deployed to staging. Not modified. |
| **This project**                              | `frontend/` (TradePlatformDemo)          | New. Was an empty git repo with a GitHub remote.       |

> **Target-path note.** `CLAUDE_CODE_PROMPT.md` names
> `TARGET_PROJECT=~/Projects/opotrade-web-terminal`. The user directed the work
> to `frontend/` (TradePlatformDemo) instead, and that instruction was followed.

## Gateway (Go OpoMTSocket)

A faithful Go port of a prior .NET service, with hardened defaults. Structure:

- `internal/httpapi/` — chi router, JWT + per-account middleware, handlers
- `internal/domain/` — one service per MT5 domain, each reproducing the .NET
  envelope and `data` shape exactly
- `internal/transform/` — MT5 → TradingView transforms; the integer tables here
  are load-bearing
- `internal/realtime/` — `/ws`, shared-topic fan-out, per-connection backpressure
- `internal/mt5/` — pooled MT5 Manager connection with a circuit breaker
- `internal/auth/` — HS256 JWT, CRM client

Hardened defaults observed: `WS_REQUIRE_AUTH=true`, CORS fails closed, JWT
issuer/audience validation on, and the credential-free login path removed.

Test coverage in the gateway is meaningful — `golden_test.go`, transform tests,
realtime tests — which is why gateway **code** outranks gateway **docs** in the
resolution order.

## TradingView integration

Webpack + TypeScript, no framework. Loads the licensed Trading Platform and
wires it to the gateway.

What works and was preserved:

| Area                 | File                                           | Kept                                        |
| -------------------- | ---------------------------------------------- | ------------------------------------------- |
| Datafeed             | `src/datafeed.ts`                              | resolutions, suffix handling, bar windowing |
| Realtime bars        | `src/TickSubscription.class.ts`                | intraday `TP=1`, daily `TP=5`               |
| Realtime quotes      | `src/QuoteSubscription.ts`                     | `GetQuotes` shape                           |
| Broker API           | `broker-sample/src/broker.ts` (1850 lines)     | bracket model, position/order sync          |
| Trade payloads       | `broker-sample/src/BrokerApiClient.ts`         | **action codes 200–204, ×10000 volume**     |
| Account init         | `AccountInitializer.class.ts`                  | type ids, suffix map                        |
| Chart save/load      | `src/save.ts`                                  | localStorage adapter                        |
| Host race protection | `src/main.ts`                                  | promise-based broker-host sync              |
| History fixes        | `BrokerApiClient.getPositionsHistoryByAccount` | deal pairing, ledger exclusion, ×10000      |

Weaknesses that were deliberately **not** carried over:

- `BASE_URL` / `WEB_SOCKET_URL` as compile-time `DefinePlugin` globals — one
  build could serve exactly one environment.
- `@ts-nocheck` in `helpers.ts` and `token_manager.ts`; `any` throughout.
- Auth read directly from `localStorage` inside the API client's
  `getHeaders()`, coupling every request to browser storage.
- Singletons (`BrokerApiClient`, `DatafeedApiClient`, `SymbolSuffixManager`)
  holding cross-account state — the suffix in particular is a global that
  survives an account switch.
- Linear reconnect (`retryCount * 1000`, max 5) with no jitter and no stale
  detection.
- `window.tvWidget` used as application architecture.
- Hardcoded `client.opofinance.com` / `myaccount.opofinance.com` URLs and
  OpoFinance branding inside reusable code.
- `BaseApiClient` calls `window.location.reload()` on a 401 from inside a
  request — losing unsaved state and any in-flight context.

## Verified facts carried into this build

- Gateway REST base defaults to `:5063`; WS push cadence ~3 s.
- Envelope `{data, errorMessage, message, success}`; success→200, failure→400.
- `data` may be an object, an array, **or JSON encoded as a string**.
- The WebSocket subscription **is** the query string; browser auth uses the
  credential-bearing `opotrade.jwt.<JWT>` subprotocol, not a URL token.
- Order and position WS payloads are **arrays after one `JSON.parse`**.
- `TP=5` works despite the docs listing only 1–4.
- The licensed package is the **Trading Platform**, not Advanced Charts.
- Trade construction uses MT5 action codes, MT5 order types, symbol suffixing,
  and a ×10000 volume conversion.
- Account type ids and their suffixes live in `AccountInitializer.class.ts`.
- Chart save/load is localStorage-backed; there is no server endpoint.

Each of these is now covered by a test in this repository.

## Backend gaps found

Recorded in full in [contract-discrepancies.md](./contract-discrepancies.md).
The two that most affect what users can see:

1. **D1** — three possible trade-result shapes; the working adapter reads a
   shape the current Go gateway does not produce.
2. **D3** — the WebSocket order stream reports status through an order-**type**
   table, making "filled" and "rejected" indistinguishable over that channel.
