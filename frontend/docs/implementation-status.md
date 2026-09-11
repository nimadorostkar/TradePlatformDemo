# Implementation status

Evidence, not percentages. Last verified 2026-07-31.

## Production posture

Deployed at `https://46.62.247.67`, serving a **production** MT5 gateway
(whitelisted server, production OpoMTSocket). There is no demo environment.

The shipped bundle is production-configured **on its own**: `VITE_APP_ENV`,
the HTTPS/WSS gateway URLs, trade confirmation, and the legacy-token-storage
refusal are all compiled in. `runtime-config.js` overrides them so one artifact
can serve other environments, but it is no longer load-bearing — if it fails to
load, the terminal stays production-configured instead of silently dropping to
development mode against localhost.

## Verification results

Every command below was run in this repository at the stated commit.

| Check            | Command                                 | Result                                                                                           |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Typecheck        | `npx tsc --noEmit -p tsconfig.app.json` | **PASS** — 0 errors, strict mode with `noUncheckedIndexedAccess`                                 |
| Lint             | `npx eslint .`                          | **PASS** — 0 errors, 6 warnings (all `react-refresh/only-export-components`, dev-only HMR hints) |
| Format           | `npx prettier --check`                  | **PASS**                                                                                         |
| Unit + component | `npx vitest run`                        | **PASS** — 228 tests, 18 files                                                                   |
| End-to-end       | `npx playwright test`                   | **PASS** — 23 desktop specs, plus the mobile project                                             |
| Production build | `npm run build`                         | **PASS** — 6.0 s                                                                                 |
| Licensed assets  | `npm run tv:check`                      | **PASS**                                                                                         |

### Bundle

| Chunk                    | Raw            | gzip            |
| ------------------------ | -------------- | --------------- |
| `index` (app shell)      | 430 kB         | **129 kB**      |
| `query` (TanStack)       | 71 kB          | 22 kB           |
| `decimal`                | 32 kB          | 13 kB           |
| CSS                      | 20 kB          | 5 kB            |
| Lazy widgets (12 chunks) | 0.5–14 kB each | 0.3–4.7 kB each |

The licensed TradingView library is served as static assets and is **not**
bundled, so its cost is measured separately.

---

## Milestone 0 — audit and foundation ✅

- [x] Contract audit against gateway **source** — `docs/integration/gateway-contract.md`
- [x] Current-state audit — `docs/integration/current-state.md`
- [x] 10 discrepancies documented with resolutions — `docs/integration/contract-discrepancies.md`
- [x] Strict React 19 + TypeScript + Vite scaffold
- [x] ESLint, Prettier, Vitest, Playwright, Husky/lint-staged
- [x] Runtime-validated env with production HTTPS/WSS enforcement
- [x] Semantic design tokens, dark + light, WCAG-AA colours
- [x] Error boundaries at root and per widget
- [x] `.env.example` with no credentials
- [x] Licensed-asset workflow that **fails the build** when assets are absent
- [x] ADR 0001 (layout engine), architecture + reconciliation docs

## Milestone 1 — workspace shell ✅

- [x] Header: account selector, server, **worst-of** connection state, balance,
      equity, P/L, free margin, margin level
- [x] Widget registry with `allowedRegions`, capabilities, lazy loading
- [x] Resizable + collapsible left/right/bottom docks
- [x] Tab groups; drag between docks; reorder; collapse to icon rail
- [x] Versioned workspace schema (v2) with a v1→v2 migration
- [x] Corrupt-layout recovery that never blocks startup
- [x] Save / rename / duplicate / load / delete / reset layouts
- [x] Dark, light, and system themes; three densities
- [x] Runtime brand config with validation and safe fallback
- [x] Command palette (⌘K) — including keyboard widget movement
- [x] Mobile five-tab navigation (`Markets · Chart · Trade · Positions · Account`)
- [x] Virtualised watchlist subscribing **only to visible rows**

## Milestone 2 — gateway and TradingView ✅

- [x] Typed HTTP client: timeout, cancellation, correlation id, envelope
      parsing, schema validation, normalised errors, **no retry on mutations**
- [x] `decodeGatewayData` — exactly one layer, never recursive
- [x] Zod contracts for every consumed endpoint, citing gateway source
- [x] Mappers: suffix policy, ×10000 volume, side/type/status/action codes
- [x] Auth: CRM login → JWT exchange; host `postMessage` with origin allowlist;
      no token from URL; in-memory token store
- [x] `GatewaySubscriptionPool`: ref-counted sharing, jittered backoff,
      staleness, generation guards, token redaction
- [x] Snapshot-gated reconciliation with session generations
- [x] `TradingChart` — created once per pane, driven imperatively
- [x] Gateway datafeed (bars, quotes, symbol search, server time)
- [x] Broker API adapter reusing the shared `TradingService`
- [x] Chart save/load adapter (prevents the `/undefined/undefined/charts` bug)
- [x] Broker-host race protection preserved

## Milestone 3 — safe trading ✅

- [x] Order ticket: market / limit / stop, live bid-ask buttons
- [x] Decimal-safe validation: volume min/max/step, price side, SL/TP side
- [x] Confirmation dialog — focus starts on **Cancel**, focus trapped, Esc closes
- [x] One-click trading behind explicit opt-in with a persistent armed badge
- [x] Positions table with close and SL/TP modify
- [x] Pending orders table with cancel
- [x] Risk calculator that **refuses to size** when tick data is unavailable
- [x] Account summary, symbol details
- [x] `Accepted` / `unknown — reconciling` / `rejected` states; **never `Filled`**
- [x] Read-only accounts blocked in the UI **and** in `TradingService`

## Milestone 4 — history, hardening, handoff ✅

- [x] Deals + closed-position history with opening/closing pairing
- [x] Ledger entries separated from trades
- [x] Client-side CSV export
- [x] System Messages with redacted diagnostics and live subscription states
- [x] Accessibility: ARIA tabs, focus trapping, live regions, reduced motion,
      visible focus, colour never the sole carrier of meaning
- [x] Multi-stage Dockerfile, unprivileged nginx, CSP + security headers
- [x] Runtime config injection (one image, many environments)
- [x] CI: typecheck, lint, format, tests, build, bundle report, E2E
- [x] README, runbook, contract matrix, discrepancy log, ADR
- [x] Opt-in read-only contract smoke tests

---

## MVP acceptance criteria

| #   | Criterion                                                       | Status | Evidence                                                                |
| --- | --------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| 1   | Authenticate and select an allowed MT5 account                  | ✅     | `e2e` sign-in spec                                                      |
| 2   | Header shows account, balances, margin, honest connection state | ✅     | `e2e` account-values spec                                               |
| 3   | Search symbols, maintain a watchlist, see broker quotes         | ✅     | `e2e` symbol-search spec                                                |
| 4   | TradingView loads from the licensed package via gateway data    | ⚠️     | wiring complete and typechecked; **not yet run against a live gateway** |
| 5   | Existing chart-trading works through shared domain services     | ⚠️     | adapter complete; needs live verification                               |
| 6   | Order ticket submits verified payloads; tests never trade       | ✅     | `e2e` asserts `action:200, type:0, volume:100, source:tv`               |
| 7   | Never presented as filled before confirmation                   | ✅     | unit + component + `e2e` specs                                          |
| 8   | Positions/orders reconcile after mutations and reconnects       | ✅     | `use-account-sync`, store tests                                         |
| 9   | Modify/cancel/close supported actions                           | ✅     | implemented; live verification pending                                  |
| 10  | Widgets resize, reorder, move, collapse, save, restore, reset   | ✅     | 19 workspace-store tests + `e2e`                                        |
| 11  | Default layout plus one alternate chart-focused layout          | ✅     | `createChartFocusedWorkspace`                                           |
| 12  | Invalid persisted layouts recover safely                        | ✅     | migration tests + `e2e`                                                 |
| 13  | Account switches cannot leak old snapshots                      | ✅     | generation tests                                                        |
| 14  | WebSocket failures become stale/reconnecting and recover        | ✅     | 14 pool tests + `e2e`                                                   |
| 15  | No component depends on raw MT5 casing                          | ✅     | mappers own it; enforced by types                                       |
| 16  | No secrets or authenticated URLs in logs or config              | ✅     | redaction tests                                                         |
| 17  | Typecheck, lint, tests, build pass                              | ✅     | table above                                                             |
| 18  | Docs match the implementation                                   | ✅     | this document                                                           |

**16 of 18 fully demonstrated.** Items 4 and 5 are code-complete and
typechecked against the licensed `.d.ts`, but have only been exercised against
the E2E interceptor. They cannot be signed off without a staging gateway.

---

## Remaining work before production rollout

**Blocking**

1. **Run against a staging gateway.** Verify the chart renders live broker bars,
   the Broker API places an order end to end on a **demo** account, and
   reconciliation behaves under a real 3 s cadence.
2. **Resolve discrepancy D1** — confirm which trade-result shape each
   environment returns. The client handles all three, but the ambiguity should
   not be permanent.
3. ~~**Resolve discrepancy D3**~~ — ✅ **done 2026-07-31.** The gateway now uses
   `MT5ToTVStatus` on the WebSocket path. The client's defensive workaround was
   _removed_ rather than kept: against a corrected gateway it would have
   misreported working orders as "Unknown" and filled ones as "working".

**High**

4. Confirm the suffix policy for account types 11 and 26 (**D5**); they are
   currently excluded rather than risk wrong symbol names.
5. ~~Verify the market-depth response shape~~ — ✅ **done 2026-07-31.** The
   gateway classifies the book and states its own volume unit; DOM is enabled
   behind the `marketDepth` capability.
6. Provide the licensed TradingView package to CI via `TRADINGVIEW_ARTIFACT_URL`.
7. Decide the token-storage policy with the security owner — the in-memory
   default means a reload requires re-authentication.

**Medium**

8. Partial-close UI (the service supports a volume argument; no UI yet).
9. ~~Server-backed workspace and chart persistence~~ — ✅ **done 2026-07-31.**
   `SyncedWorkspaceStore` mirrors layouts to `/api/Workspace`, gated on the
   `workspace` capability. Reads stay local, and nothing is pushed until a pull
   has succeeded, so a fresh browser cannot overwrite a real stored layout with
   its default.
10. Trading journal (local-only for now).
11. Multi-chart panes beyond the primary do not yet get independent broker
    connections — by design for MVP; revisit if per-pane trading is wanted.
12. Upstream fixes for the two accepted `npm audit` advisories (see README).

**Low**

13. ~~Price alerts~~ — ✅ **done 2026-07-31**, server-persisted and evaluated
    server-side, so an alert outlives the tab. Economic calendar and news remain
    blocked on backend capability and their panels stay gated off with the
    gateway's own stated reason.
14. Market replay, paper trading.
