# OpoTrade Launch Readiness — Task Checklist
Source: Launch Readiness Report 2026-08-24 (build 2eaaecd). Deploy: manual to 46.62.247.67 (CI quota exhausted).

## Phase 1 — Launch Blockers (Batch A: shared root cause — layout assumes ≥1440px)
**DONE — deployed 4822762 to stage 2026-08-25; acceptance spec: e2e/responsive-launch-blockers.spec.ts**
- [x] BLK-01 Watchlist symbol names truncate <1280px, vanish at 960px → `min-width:6ch` on Symbol col, Bid/Ask/Spread absorb, `title` on cell, hide flag <1100px
- [x] BLK-02 920px horizontal scroll on phones → account-metrics strip (fixed 458px, shrink-0) out of header at mobile bp, or `overflow-x:auto` + `min-width:0` wrapper
- [x] BLK-03 Dead zone 768–960px → raise mobile breakpoint to ~1024px; `min-width` on side columns so they collapse not compress

## Phase 2 — High Priority
**DONE — FE build 1529a43 + gateway f135f53 on stage. Gateway-side login throttle live and verified; the optional Cloudflare edge rule needs dashboard access (exact rule documented at the bottom).**
- [x] HGH-01 Login page: add Forgot password / sign-up / support links (Batch C)
- [x] HGH-02 Login rate limiting: exponential backoff + lockout in Go gateway; Cloudflare rule on /gateway/api/Authentication/* (Batch C, BE) — gateway throttle DONE+deployed; CF dashboard rule still needs doing by hand (no CF access here)
- [x] HGH-03 Routing: sync symbol+tab to query string with history.pushState; fix Back button; 404 handling (Batch D)
- [x] HGH-04 Contrast: text color on --brand-primary (Sign in btn 4.19:1) and --text-muted (4.21/4.22:1) → ≥4.5:1 both themes (Batch B)
- [x] HGH-05 Mobile bottom nav: `padding-bottom: env(safe-area-inset-bottom)`; `aria-current="page"` on active tab (Batch B)
- [x] HGH-06 Order info: show "—" while volume invalid; danger color + warning when Margin Used > Margin Available (Batch E)
- [x] HGH-07 Mobile inputs 13px → 16px (kills iOS auto-zoom); field height 36→44px at mobile bp (Batch B)

## Phase 3 — Medium
**DONE. MED-12 closed in full: unavailable panels now hidden from the menu (report's ask), h1 + main landmark + skip link, focus ring. MED-11 parallelization checked: reconnectAll already opens every socket concurrently — the wall time is the deliberate CRM re-authorization. USDCAD quote drop: hardened by fc11ddd's resubscribe fix; monitor via System tab.**
- [x] MED-01 signOut(): clear account-scoped opotrade.* localStorage/sessionStorage keys
- [x] MED-02 "Remember me" checkbox; session-only cookie without it; idle timeout (FE+BE)
- [x] MED-03 Expand hit areas: watchlist star 10×10, panel close 14×14, 67 elements <24px
- [x] MED-04 SL/TP unit button "·00" → "price"
- [x] MED-05 Entry-price error only after blur/submit, helper text before
- [x] MED-06 Table ARIA: role=grid, columnheader, aria-sort
- [x] MED-07 Journal notes: sync server-side (or much louder warning)
- [x] MED-08 Panel min-heights per type; collapse surplus panels instead of compressing
- [x] MED-09 Layout menu: "Save layout as…" or rename "Default" → "Layout"
- [x] MED-10 CSP vs Cloudflare analytics (3 console errors/load); silence expected 401 session probe
- [x] MED-11 Account switch ~8.5s: skeletons + parallelize resubscription
- [x] MED-12 Remove disabled Risk Calculator menu item; login focus ring (DONE); <main> landmark/heading levels; monitor USDCAD quote drop

## Preserve (do not regress)
Volume validation copy · read-only enforcement · reconnect behavior · httpOnly cookie auth · empty states · command palette · themes · 199KB bundle · icon aria-labels · server-side workspace persistence · CSV export · System log


## Cloudflare edge rule (optional defense-in-depth for HGH-02 — needs CF dashboard access)
Security → WAF → Rate limiting rules → Create:
- Name: `login-throttle-edge`
- If incoming requests match: `(http.request.uri.path contains "/gateway/api/Authentication/") and (http.request.method eq "POST")`
- Rate: 10 requests per 1 minute, per IP
- Action: Block for 1 minute
The gateway's own failed-attempt throttle (5 fails → 30s→15m, outcome-aware) is already live; this edge rule only shields the origin from raw request volume.


## 2026-08-26 — QA re-test items (opotradeopenitems.md), all closed
- [x] MED-03 real 24×24 boxes (was ::after only): 104 → 0 undersized of 133 measured on stage
- [x] MED-06 Favorites grids get grid/row/columnheader/gridcell; money tables are real <table> (unmount behind empty states); no sorts exist so no aria-sort is owed
- [x] MED-12 h3→h2 releveling (outline h1→h2, no skips); Risk Calculator removed from menu (earlier build)
- [x] MED-07 journal empty-state copy now follows the gateway's sync capability
- [x] HGH-03 desktop bottom-dock tab in ?tab= (widget ids), cross-shell mapping, Back walks tabs — verified live
- [x] HGH-07 44px min-height for text controls at ≤1023px — verified live (16px font + 44px at 332w)
- [x] Blank-quote watchdog: failed channels with live consumers retry every 60s with restored budget (subscription-pool probation + 2 tests)
- [x] Width matrix 332/353/915/986 pinned in e2e/retest-widths.spec.ts — no h-scroll, full symbol names
- SPA answers unknown paths with HTTP 200 + client 404 view — accepted SPA behavior (QA's own note)


---

# Round 2 — Launch Readiness Report rev. 2026-08-24/25 (builds 2eaaecd → fc11ddd)

Second revision of the report adds a trading round executed on a funded account. Everything it
numbers BLK-01–03 / HGH-01–07 / MED-01–12 is already fixed and deployed (above). New in this
revision: **BLK-04, HGH-08, HGH-09, HGH-10, MED-13 … MED-19**. Those are the tasks below.

Code locations were verified against HEAD (158c1d5) before writing, not taken from the report.

## Phase 4 — Accounting correctness (launch blocker)
**DONE — deployed b2aaf36 to stage 2026-08-26.** Verified live on ECN Pro 15597243, which is the
report's own second ECN case: it reported "+0.12" against a true net of "+0.04", and the tab now
reads `+0.04 net` with `-0.04` commission on both rows (was `0.00`). Headers read `Opened (UTC+3)`,
times render `2026-08-24 19:46:23`. No console errors.

- [x] **R2-01 · BLK-04 — History understates every trade's cost by the entry commission**
  Gateway is innocent: `/api/Deal/get_page` passes both deals through untouched with their own
  `Commission`/`Storage` (`opotrade-mt-socket-new/internal/domain/deal.go:61-84`). The loss is in the
  FE pairing: `src/integrations/gateway/mappers/to-domain.ts:554-569` builds the row when the exit
  deal arrives and reads `swap`/`commission` off the **closing deal only** (`:566-567`) while the
  opening deal is in scope at `:551` and discarded.
  **Trap:** `:541-545` deliberately keeps the entry deal registered after an OUT so partial closes can
  pair against it — a naive `opening.commission + deal.commission` double-counts the entry cost on
  every partial close. Apportion by closed volume, or consume the entry cost once on the first exit.
  Also: the headline at `src/features/history/OrderHistoryWidget.tsx:98-112` sums **gross** profit only
  (`:103`) — never swap or commission — so it must move to net, and the win/loss split at `:104` with it.
  CSV serialiser: `OrderHistoryWidget.tsx:487-493`. Consider adding an explicit `Net` column so the
  export states the number it is claiming.
  *Acceptance:* a closed-position fixture reconciles to the account balance delta (the report's case:
  entry −0.04, close +0.13, true net +0.09); partial-close fixture does not double-count.

- [x] **R2-02 · MED-14 — "before range" erases an open price the gateway can supply**
  `to-domain.ts:568` sets `openedBeforeRange` when no entry deal appears inside the fetched window;
  `OrderHistoryWidget.tsx:453-461` then prints the literal text for both Open price and Opened time.
  The gateway already has the missing data — `/api/Deal/get_batch` and `/api/Deal/get?ticket` are
  mounted (`internal/httpapi/handlers/mount.go:70-72`) but `TradingApi` has no method calling either.
  Back-fill the entry deal per position instead of blanking the row.
  While in here: `volume` (`:560`) and `side` (`:559`) are derived from the *closing* deal, so a partially
  closed position reports the wrong size; and the CSV disagrees with itself — Open price writes
  `'before range'` (`:487`) while Open time writes `''` (`:489`).

- [x] **R2-03 · MED-13 — One clock, named in the header**
  Table renders `new Date(value).toLocaleString()` with no locale and no timeZone
  (`OrderHistoryWidget.tsx:448-451`, same pattern in DealsWidget/Positions/PendingOrders/Journal/
  Alerts/SystemMessages) → browser-local, US ordering on en-US. CSV writes ISO UTC (`:489-490`).
  Filename is the UTC date at click time (`:500`), which is how the report got a file dated a day ahead.
  Broker time is what traders expect: `brokerClock()` already exists
  (`src/integrations/gateway/api/market-api.ts:77-93`) and the gateway serves `brokerOffsetSeconds`
  (`internal/httpapi/handlers/handlers.go:460-471`). There is **no shared date formatter in the FE** —
  create one, use it everywhere, name the zone in the column header, derive the filename from it.
  Bonus bug found while looking: only the `1d` range applies the broker offset
  (`src/features/history/useHistory.ts:47-63`); `7d/30d/90d/1y` are plain `Date.now()` windows.

## Phase 5 — Trading safety (high priority)
**DONE — deployed c1b5605 to stage 2026-08-26.** Verified: deployed bundle carries the new
validator and toast copy; live check confirmed quotes still flow normally after the mapper change
(all watchlist rows, chart, DOM and ticket pricing), no console errors. HGH-08's disabled state and
HGH-10's rules are covered by unit tests — reproducing them live needs a symbol with no feed and an
open position respectively.

- [x] **R2-04 · HGH-08 — BUY/SELL clickable while the ticket reads "—"**
  The buttons *are* guarded (`OrderTicketWidget.tsx:474-477`, `!quote`) and the good label already
  exists (`blockReason()` at `:690-699`). The hole is upstream: `to-domain.ts:167-169` coerces a
  missing bid/ask to the string `"0"` via `toDecimalStringOrZero`, so a tick that arrives without
  prices yields a *truthy* quote object — buttons live, face rendering `0.00000`. `validateOrder`
  only rejects a null entry price (`src/domain/orders/validation.ts:222-231`), so a market order can
  submit at price `"0"`. Same hole on the chart path (`broker-adapter.ts:775-781`).
  Fix at the mapper (`nullIfZero` is right there at `to-domain.ts:590-594`), then let the existing
  disabled path do its job; label "Buy — waiting for prices".

- [x] **R2-05 · HGH-10 — Modify dialog accepts a stop on the wrong side**
  `src/features/positions/ModifyBracketsDialog.tsx:52-79` validates exactly one thing: SL direction
  against `position.openPrice`. **No take-profit check at all**, no comparison to the *current* price,
  no price-step check, and `Number()` instead of the decimal helpers used everywhere else.
  Reuse `validation.ts:262-285` (both legs, decimal-safe) and the current-price pattern at
  `validation.ts:198-221`; `ModifyOrderDialog.tsx:42` shows how to get the live quote into a dialog.

- [x] **R2-06 · MED-19 — The toast reports the floating tick, not the fill**
  `src/app/providers/use-trade-notifications.ts:55-66` diffs the positions map and prints the last
  streamed `position.profit`. The realised number already exists —
  `src/features/positions/close-settlement.ts:40-75` computes gross/commission/swap/net from the
  executions feed — but it only reaches System Messages (`:109-115`), and only for closes started in
  `ClosePositionDialog`, not chart closes (`broker-adapter.ts:1080-1093`).
  Same task, second half: Deals rows for balance/credit print `0` under Volume/Price
  (`DealsWidget.tsx:124-129`) for two reasons — the mapper keeps `"0"` instead of null
  (`to-domain.ts:421-422`) and the guard is a truthiness test on a string, where `"0"` is truthy.

## Phase 6 — Connection reliability
**DONE — deployed c501937 to stage 2026-08-26.** `handshake timed out` confirmed in the deployed
bundle; 29 pool tests including three that reproduce the wedge.

- [x] **R2-07 · HGH-09 — Rapid switching wedges the badge on "Connecting" forever**
  Three separate defects, all in `src/integrations/gateway/websocket/subscription-pool.ts`:
  1. **No connect/handshake timeout.** `:279-291` sets `connecting` and opens the socket; the only
     exits are the socket's own events, and `armStaleTimer` arms *after* `onopen` (`:297`). A hung
     handshake sits in `connecting` with no timer armed, permanently.
  2. **`reconnectAll` (`:242-249`) makes it worse.** It sweeps *every* channel including quote
     channels, which carry no login (`subscription-key.ts:48-55`) and never needed touching; and it
     resets `attempts = 0`, so `maxAttempts` is never reached, so `failed` is never entered, so the
     probation retry never arms. The blank-quote watchdog shipped on 2026-08-26 does **not** cover
     this — it is gated on `state === 'failed'` (`:412`), unreachable from a hang.
  3. **The switch cannot be aborted.** `src/app/account-switch.ts:29-50` takes no signal, and the
     `switching` flag (`TerminalHeader.tsx:90-104`) clears when `renew()` resolves — before the
     sweep it triggered has settled.
  Add a generation/epoch to the pool, a bounded connect timeout that surfaces retry, and stop
  sweeping account-independent channels. Watch the gateway's own limiter: `/ws` is inside the
  50rps/burst-20 per-IP rule (`internal/httpapi/router.go:66-72,98`), so a wide sweep earns 429s.
  Also `use-account-sync.ts:365` has an object (`suffixPolicy`) in its deps, advancing the generation
  twice per switch when the suffix probe rebuilds it.

- [x] **R2-08 · MED-11 remainder + MED-18a — 45-55s switches, 9-10s round-trips, no skeletons**
  Parallelisation was checked last round and is not the bottleneck. The real ones:
  **`MT5_POOL_SIZE=1` in production** (`internal/config/config.go:96`, `deploy/k8s/configmap.yaml:28`)
  serialises every MT5 call in the gateway through one mutex-held conn with a 30s timeout, while a
  single switch fires 4 parallel REST calls (`use-account-sync.ts:250-264`) plus a fifth
  `/api/User/get` (`AccountSummaryWidget.tsx:34-40`) plus a `push()` per new WS topic; CRM
  `/accounts` costs 5.5-13s cold (`internal/auth/crm.go:89-97`) and the FE throws away its own
  60s account cache on every renew (`crm-session.ts:170`).
  Skeletons: header metrics pulse only while `switching` (stops too early), and AccountSummary and
  Alerts render *"No account selected — Choose a trading account."* mid-switch, which is false.

## Phase 7 — Grids and destructive actions
**DONE — deployed c501937 to stage 2026-08-26.** Every chunk fetched from the stage origin and
confirmed to carry the change (table-sort, PositionsWidget, PendingOrdersWidget).

- [x] **R2-09 · MED-15 — No column in any table sorts**
  Five tables (History renders two), all hand-written headers, but `Th`/`Td` are shared — oddly
  exported from `PositionsWidget.tsx:375-399` and imported by the other three files. So: one edit to
  `Th` (optional `sortKey`/`sortState`/`onSort`, a button inside the `<th>`, `aria-sort`) plus four
  local comparator memos. Prices/volume/profit are nullable `DecimalString` — compare numerically,
  never lexically ("9.5" > "10.0"); null-last; stable tiebreak on `id`, because Positions and Orders
  are replaced wholesale on every WS frame (`trading-store.ts:166-181`) and a ticking sort column
  will otherwise reshuffle rows continuously. History and Deals are static per fetch, so they are free.

- [x] **R2-10 · MED-16 — Destructive actions are inconsistent**
  Correction to the report: the bulk actions **do** confirm — all three route through the shared
  `BulkActionDialog` (`PositionsWidget.tsx:191`, `PendingOrdersWidget.tsx:146`). The real gaps:
  - Per-row **order cancel fires with no confirmation at all** (`PendingOrdersWidget.tsx:284-294`),
    and so do three bracket-leg cancels (`BracketCell.tsx:49-51`, `BracketLegRow.tsx:88-96`,
    `PositionBracketRow.tsx:95-105`), all via `useBracketLegCancel.ts:20-49`.
  - The three bulk buttons carry **no aria-label and no title** — a screen reader hears "Close all"
    with no object and no count. Counts are already in scope (`positions.length`, `orders.length`);
    the profitable count is not, because the filter runs only after the click
    (`PositionsWidget.tsx:60-73`) — lift it into its own memo for "Close 2 profitable positions".
  - "Close profitable" is `variant="ghost"` while closing real trades; it should read as destructive.

- [x] **R2-11 · MED-12 last bullet — Pending orders show "—" under Current**
  `PendingOrdersWidget.tsx:234-240` reads `order.currentPrice`, which comes from `dto.last` — and on
  the *order* schema `last` is optional (`schemas.ts:249`) where on the *position* schema it is
  required (`:216`). That is why Positions has a working Current column and this one does not.
  The widget never subscribes to quotes; `visibleSymbols` is already computed at `:51` and
  `useSessionStore` already imported at `:9`, so `useSymbolSubscription` + a per-row `useQuote`
  (pattern at `ModifyOrderDialog.tsx:42`) closes it. Then show distance from the trigger price.

## Phase 8 — Account identity and picker
**R2-13 DONE — deployed 1fd4a4a to stage 2026-08-26**, with 10 component tests and the five
account-switching e2e tests rewritten to drive the listbox. **R2-12 is BLOCKED on the broker.**
- [ ] **R2-12 · MED-17 — "LIVE" is an env var, not a fact about the account**
  Materially different from the report's diagnosis. The badge reads
  `environment.tradingMode !== 'demo'` (`TerminalHeader.tsx:407`) from `GET /api/Capabilities`, fed by
  the deployment-wide `TRADING_MODE` env with `envDefault:"live"` (`internal/config/config.go:284-290`).
  One gateway serves every group, so all 20 accounts necessarily badge the same.
  Also: `grep -- "-SF-"` across both repos returns **zero hits** — nothing parses group substrings, and
  `trading-api.ts:385-387` documents a deliberate policy of making no demo/live judgement because
  "this broker's group names carry no marker". The MT5 `Group` string *is* already fetched
  (`trading-api.ts:389-400`, rendered in AccountSummary).
  **Blocked on an answer from the broker**: which groups are simulated-funds? Get that, then derive
  the badge per account from the group and give demo a distinct treatment. Do not guess from `-SF-`.

- [x] **R2-13 · MED-18b — 17 accounts in a bare `<select>`**
  `TerminalHeader.tsx:148-178` is a native select, no search/grouping/sort, option labels are
  "ECN Pro 600140221" with no balance or currency, order is whatever CRM returned, width capped at
  `max-w-44`. It is the only account picker in the app. Add search + grouping past ~8 accounts.

## Phase 9 — the two that were blocked, and the console exception
**R2-12 DONE (mechanism + today's improvement), deployed e972131.** **R2-14 DONE, deployed 7455e91.**
**R2-15 needs one permission grant — see below.**

- [x] **R2-12 · MED-17 — the badge stops claiming per account what it knows per deployment**
  Investigated against the live gateway rather than reasoning about it. All seventeen accounts on
  the stage login were sampled through `/api/User/get`: `Rights` is 355 or 359, differing by
  TRADE_DISABLED (the read-only flag the terminal already reads) — **there is no demo bit on an MT5
  user**, confirming the badge cannot be derived from MT5 alone. The `-SF-` groups are real
  (`Opoforex\ECNPRO-APP-SF-USD-B` and seven siblings) and every one holds exactly 1,000.00.
  Shipped: per-account derivation behind `VITE_SIMULATED_FUNDS_GROUP_PATTERN`, empty by default so
  nothing is inferred and every account still reports as real money — the safe half of the
  decision. **To finish it: set that variable to `-SF-` once the broker confirms**, e.g.
  `VITE_SIMULATED_FUNDS_GROUP_PATTERN=-SF- SSHPASS=… bash scripts/deploy-stage.sh`.
  Improved with no answer required: the badge now names the MT5 group, which is the identifier a
  trader can quote to their broker — the exact check the report asked for, now answerable from the
  screen where orders are placed.

- [x] **R2-14 — "Maximum update depth exceeded" in the production console on load**
  Found while verifying phase 7; pre-existing (reproduces identically at 158c1d5). The quote store
  notified synchronously per tick, so a burst of frames became a chain of synchronous React renders
  and past fifty React aborts. Fan-out is now throttled to one flush per 16ms across all changed
  symbols. The 200-frames-in-one-tick probe goes from 302 exceptions to none and is a running test
  (`e2e/quote-burst.spec.ts`). Data is never delayed — only the re-render is.

- [x] **R2-15 · `MT5_POOL_SIZE` 1 → 3 — DONE and measured on production 2026-08-26**
  Every MT5 call serialised through one connection, each held for the whole round trip, while a
  single switch fires five REST calls plus a poll per new subscription. The broker permits three
  concurrent manager sessions: the gateway logs `"pool_size":3,"authenticated":3`.
  **Measured on production, the exact five-call switch burst: 940ms serialised → 242ms concurrent,
  a 3.9× speedup.** End to end through the UI, an account switch on the seventeen-account login now
  lands in **725ms** — the report measured 45–55 seconds. Health after heavy switching: 3,962 MT5
  requests ok, 0 reauth failures, 0 ERROR lines; the only two errors are the long-known broker
  quirks (`book/subscribe` 504, a transient `tick/last` 403).
  HGH-09 confirmed in the same session: three switches in quick succession settled on **Connected**
  with quotes streaming, where the report saw the badge pinned on "Connecting" indefinitely.
  Backup at `C:\opomtsocket-go\gateway.env.bak-poolsize`; revert = restore it and restart the
  `OpoGatewayGo` task. The code default stays 1 because another broker may cap manager sessions —
  the value is now in `deploy/windows/gateway.env.example` and `docs/CONFIGURATION.md` (gateway repo
  5409cf8), which previously did not mention it at all, so a reprovision would have restored the
  queue silently. **Verification rule: `authenticated` must equal `pool_size` in the startup log.**

## Phase 10 — the coverage the report could not reach, and what it turned up
**DONE — deployed 3f7cf85.** Real trades cannot be placed to prove a UI behaves, and would not be
repeatable if they could. Both gaps are now driven end to end against the intercepted gateway,
where `/api/Trade/send_request` is recorded and never forwarded.

- [x] **Partial close** (report: "needs a position of 0.05 lots or more") —
  `e2e/partial-close.spec.ts`. The fixture holds 1.00 lot, so the whole path runs: the dialog
  states `max 1`, 0.25 leaves "0.75 lots will remain open", and the recorded payload is 2500 units
  (0.25 lots) on the opposite side against the position id. Off-step and oversized closes are
  refused with the button disabled. Note EURUSD's minimum EQUALS its step, so the "would strand an
  uncloseable remainder" guard cannot fire on it — that one is unit-tested instead
  (`ClosePositionDialog.test.ts:88`).
- [x] **Alert firing** (report: "the notification path is unverified") — `e2e/alert-fired.spec.ts`.
  The gateway owns alert state and the terminal only reports it, so the server says an alert fired
  and the test asserts what the trader sees. **The finding worth recording: that IS the entire
  notification path.** A fired alert appears in the Alerts panel — warning badge, firing time,
  crossing price — and nowhere else. No toast, no sound, no title-bar change. If a trader is not
  looking at that panel, nothing tells them. Worth a product decision before launch.
- [x] **A real bug this uncovered:** the Alerts panel formatted every row with the ACTIVE symbol's
  precision, so with gold selected a EURUSD alert set at 1.10125 displayed as "≥ 1.10". Each row
  now uses its own instrument's digits.
- Not reachable without deliberately risking an account: margin-call and stop-out behaviour. It
  needs a funded account pushed to its margin threshold, which is a trading decision, not a test.

## Carried over / not code
- [ ] Cloudflare edge rate-limit rule on `/gateway/api/Authentication/*` — rule text is written above; needs dashboard access.
- [ ] QA coverage the report lists as unexercised: partial close (needs a ≥0.05-lot position), margin-call/stop-out, alert firing held to its level, and how the UI presents a server rejection — the last one gets easier once R2-05 stops sending invalid brackets.

---

# Round 3 — 26 Aug retest (build `index-pNsJb38H` = 3f7cf85)

That build is the round-2 work, so the retest's eight "NOT REACHABLE" verdicts are fixes it could
not exercise (no open position, no working order, no sign-out), not missing fixes. Its negative
bundle-string evidence is the weak case it flags itself: the messages it searched for are template
literals and never appear as literals in a chunk.

## Part A — confirmed
- [x] **A1 · MED-17** — deployed 83c1910 (client) + gateway 79a7f16. **The prescribed derivation is
  not possible:** `/api/group/get` returns configuration IDENTICAL in every field for the
  demo-signature group and a live one (same PermissionsFlags, Company, ten symbol paths, swaps,
  commissions) — only the NAME differs — and an MT5 user's `Rights` carry no demo bit (355/359
  across all 17, differing by TRADE_DISABLED). So the gateway STATES it from configuration
  (`CRM_DEMO_ACCOUNT_TYPES` / `CRM_LIVE_ACCOUNT_TYPES`, keyed on the CRM typeId already on every
  entry of `/api/Authentication/accounts`). Unset by default ⇒ `accountKind` omitted ⇒ **no badge**.
  Verified live: the word LIVE appears nowhere in the app. **To finish: the broker names which
  typeIds are demo** — 8 accounts across 8 `-SF-` groups vs 4 live groups on the stage login.
- [x] **A2 · MED-03 residual** — deployed 6e0032b. The retest's own console sweep now returns
  exactly one element under 24×24: `Skip to terminal 16×8`, which its report calls correct as-is.
- [x] **A3 · MED-08 residual** — deployed ec05de4. The 0px computed min-height reading was a
  mechanism the retest misread (an overflowing region sizes content to the SUM and scrolls, so
  panels keep their height). The real residual was one level down: six panels declared no minimum
  and inherited the 120px fallback — the number the original report called unusable.

## Part B — audited in source
| Item | Verdict | Where |
|---|---|---|
| MED-01 sign-out storage | **was partially open, now fixed** (83c1910) | `session-store.ts` cleared 3 of 6 keys; now clears by exception with the known keys also removed by name |
| MED-02 "Remember me" | **already fixed** — retest searched the wrong literal | `SignInScreen.tsx:104` "Keep me signed in for 30 days"; idle limit 60 min at `App.tsx:192` |
| HGH-01 sign-in links | **already fixed — now VERIFIED RENDERED at 390px** | all three render: Forgot password? / Open an account / Contact support. "Open an account" IS the sign-up link |
| HGH-07 sign-in fields | **already fixed — now MEASURED at 390px** | both sign-in fields render `font-size 16px` / `height 44px` on the live page; 16px is the iOS no-zoom threshold |
| MED-12 sign-in focus ring | **already fixed — now MEASURED under real keyboard focus** | tabbing to the email field gives `outline: solid 2px rgb(122,162,255)`, offset 1px, `:focus-visible` true — the app's 2px blue ring, where the finding had outline transparent. NB `.focus()` from script does NOT trigger `:focus-visible`; only real Tab does |
| HGH-10 modify dialog | **already fixed** (296c5eb) | `ModifyBracketsDialog.tsx` + `validatePositionBrackets`; retest's string search missed a template literal |
| MED-16 destructive actions | **already fixed** (c501937) | per-row cancel routes through `BulkActionDialog`; bulk buttons carry counts + danger styling |
| MED-19 close toast | **already fixed** (c1b5605) | settlement watch in `use-trade-notifications.ts`; Deals zeros fixed in the mapper |
| MED-18 latency | **fixed** (gateway 5409cf8) | `MT5_POOL_SIZE` 1→3: switch burst 940ms→242ms, UI switch 725ms |
| MED-12 pending Current | **already fixed** (c501937) | `PendingOrdersWidget` subscribes to its own symbols and shows distance to trigger |
| MED-14 before range | **already fixed** (36576b0) | `entry-backfill.ts` walks back for the entry deal; placeholder only when genuinely unresolvable |
| BLK-02 | **fixed/verified at 390 and 360** (`e2e/phone-390.spec.ts`) | emulated viewport; a real macOS window cannot go under ~400px, which is why the retest floored at 444 |
| HGH-05 | **a real bug found and fixed** (4efb19f) | `h-14` + `padding-bottom: env(...)` under border-box took the 34px OUT of the bar: 22px of content on an iPhone, collapsing the touch targets. Height is now the sum. Only "does iOS report 34px" remains unproven — a device fact, needs Xcode/a handset |
| HGH-02 rate limiting | **gateway side already live**; Cloudflare edge rule still needs dashboard access | throttle documented at the top of this file |


## Round 4 — the last of it (2026-08-26)
- [x] **MED-17 COMPLETE** — gateway `ddd9686` + FE. Broker confirmed `-SF-` = demo. **Keyed on MT5
  GROUP, not CRM typeId**: checking first showed three types straddle the line ("ECN Pro" holds both
  `ECNPRO-USD-B` real and `ECNPRO-SF-USD-B` simulated), so typeId would have badged **7 real accounts
  DEMO**. `CRM_DEMO_MT5_GROUPS` = 8 exact full group names. Live: **8 DEMO / 9 LIVE / 0 unbadged**;
  the retest's own case 153457226 now reads DEMO with the group in the tooltip.
- [x] **A fired price alert now notifies** (`11ff5c9`) — it previously surfaced ONLY in the Alerts
  panel: no toast, no log, nothing. Found while testing the panel. Watcher shares the panel's query
  key and capability gate; seeded from the first answer so alerts that fired while away are not
  re-announced on every load.
- [x] **BLK-02** closed at 390 and 360 (`e2e/phone-390.spec.ts`).
- [x] **HGH-05** — the declaration was present but *wrong*: `h-14` + `padding-bottom: env(...)` under
  border-box took the 34px OUT of the bar (22px of content on an iPhone). Height is now the sum.

## Genuinely open — neither is code, and I cannot reach either
1. **Cloudflare edge rule (HGH-02 residue)** — needs dashboard access. Deliberately NOT substituted
   with a gateway-side auth limiter: `LOGIN_THROTTLE` (5 fails → 30s→15m) already stops credential
   stuffing, which was the actual finding; a raw-volume shield only works at the edge by definition;
   and a tight per-IP limit on `/api/Authentication/*` would break account switching, because the
   client renews its token on every switch.
2. **The iOS safe-area VALUE** — whether iOS reports 34px. A device fact, not a code fact; the code
   is now correct for any inset. One person opening the site on an iPhone closes it. No Xcode on this
   Mac (not installed at all), so the Simulator route is unavailable.
3. **Margin-call / stop-out behaviour** — needs an account deliberately pushed to its margin
   threshold. That is a trading decision, and I do not place trades.

## Round 5 — post-launch mobile sweep (2026-08-27)
- [x] **Phone header overlap + clipped account picker** (`78d2155`, deployed) — not in any QA
  round: below lg the header's BLK-02 scroll container forces overflow-y:auto, which CLIPPED the
  picker's absolute panel to the 44px strip ("dropdown opens under the chart"), and the badge
  group's max-lg:min-w-0 let flex shrink it under its content, painting badges beneath the session
  buttons. Panel is position:fixed below the header on the phone now; badge group is shrink-0; the
  brand h1 goes sr-only and the healthy connection state is icon-only, so 390px fits with zero
  overflow. Verified on stage and on a real iPhone.
- [x] **"Save Save" on the chart toolbar** — TradingView's header save button appends a blue
  "Save" call-to-action when the layout is dirty; every layout here is untitled (the workspace
  store is the real persistence), so after changeTheme marks the layout dirty it rendered a stacked
  double label. Reproduced on stage in light theme. Hidden via custom_css_url
  (public/tv-overrides.css, class-prefix selector so the vendored hash can change); pinned by
  e2e/theme-save.spec.ts in both themes.
- [x] **iOS safe-area VALUE (open item 2) closed** — the site was opened on a real iPhone
  (2026-08-27): the tab bar clears the home indicator with full-height buttons. The last device
  fact the code fix (4efb19f) was waiting on.
- Sweep coverage: five tabs, account picker, Limit/Stop tickets, bulk-close dialog, both themes at
  390x844 — screenshots reviewed, nothing else found. Still open and unreachable from here:
  Cloudflare edge rule (dashboard access) and margin-call/stop-out (a trading decision).

## Round 6 — 27 Aug punch list vs build 5c1310dd (OpoTradePunchList5c1310dd.md)
Two of its findings were real; the rest re-report closed items on the same weak bundle-string
evidence Round 3 documented (template literals never appear as literals in a chunk).

- [x] **HGH-06 (real) — BUY/SELL enabled under insufficient margin.** The block computed
  `insufficientMargin` for its red line but the buttons never learned of it. The same
  computeOrderInfo estimate (BUY entry) now feeds the disable + blockReason, so the button and the
  warning state one fact in one voice; requestSubmit/submit carry the same guard. Unit test drives
  50 lots on the punch list's own 93.74-USD account. Exposed a fixture lie on the way: e2e gold
  carried ContractSize 100000 (real: 100 oz), pricing 0.01 lots at 24,008 USD of margin — fixed.
- [x] **§5 deep link (real) — `?tab=` lost on desktop.** The symbol had adoptUrlSymbol to survive
  the sign-in resync; the tab had nothing, so the saved layout's remembered widget clobbered the
  link's tab a moment after applyTab ran. `adoptUrlTab` mirrors the symbol's contract (intent
  survives resync, cleared by the first ordinary tab click); 3 store tests.
- [x] **§5 touch targets** — theme + sign-out get 40px hit areas below lg (icons unchanged).
- **HGH-10 refuted** — validation.ts:274/286 carries the direction messages as template literals
  (`must be ${side === 'buy' ? 'below' : 'above'}`), invisible to the report's regex; the dialog
  routes through validatePositionBrackets (296c5eb) with unit tests.
- **MED-02 refuted** — the checkbox copy is "Keep me signed in for 30 days" (SignInScreen.tsx:104),
  not "Remember me"; unchecked issues a session cookie; 60-min idle sign-out at App.tsx:192.
- **MED-16 refuted** — "Cancel all"/"Close profitable (n)"/"Close all (n)" are aria-labels and
  counted labels built from template literals; the 2026-08-27 sweep screenshots show the buttons
  AND the shared confirm dialog live. Per-row cancel routes through BulkActionDialog (c501937).
- **MED-10 refuted live (this round)** — full reload with console tracking: zero CSP messages; the
  CF beacon answered HTTP 200 and window.__cfBeacon is initialized. transferSize 0 is a
  cross-origin resource without Timing-Allow-Origin, not a block. Pre-login probe returns 204 by
  design (the report's 401 claim carries over from a build several rounds old).
- **§3 (needs a trade)** — MED-19/MED-18/MED-12/MED-19b are code-fixed and unit/e2e-tested;
  the ten-minute 0.05-lot live confirmation remains a trading decision for the account owner.

### Round 6 addendum — the live trade (2026-08-27 02:13–02:15, account 600132510)
The owner placed and closed 0.05 lots XAUUSD; watched live with a toast recorder in the page.
- **MED-19 VERIFIED**: toast reads "Position closed — 0.05 lots · settling…" (no floating tick),
  and the settlement lands 2s later: "closed at 4614.65: net +13.00 USD" — identical to the
  History row's Net and to 5 oz × (4614.65 − 4612.05) exactly; the headline moved by the same.
- **MED-18 VERIFIED**: close accepted 02:15:14 against a server close stamp of 02:15:13, settled
  02:15:16 — a 1–3 s round trip where the report measured 8.7 s.
- **MED-19b VERIFIED**: the Deals balance row renders "—" for Symbol/Side/Volume/Price.
- Commission 0.00 is truthful on this demo group (the server's own deals carry 0.00); the nonzero
  commission path stays covered by the 2026-08-26 ECN verification and the pairing unit tests.
- Still needing a live pass: MED-12's pending-order Current column (place one limit order), and
  margin-call/stop-out.

## Round 7 — response to the 27 Aug retest report (2026-08-28)

The report's verdict was 30 fixed / 2 open / 1 inconclusive. All three remaining items are
now resolved — two were evidence artifacts, one was real and deeper than reported.

- **HGH-05a refuted — the fix is live in the exact build QA tested.** The report grepped
  `assets/index-Cuet89gL.css` for `safe-area` (0 matches) — but the fix (4efb19f) is an
  inline React style, so it lives in the JS bundle: `index-8ROlFjw-.js`, served alongside
  that same CSS file, contains `calc(3.5rem + var(--safe-area-bottom,
  env(safe-area-inset-bottom)))`. And `viewport-fit=cover` staying present is REQUIRED —
  without it every `env(safe-area-inset-*)` is 0 on iPhone. `e2e/phone-390.spec.ts`
  asserts padding == inset and that the content box is unchanged.
- **HGH-09 closed on the criterion the report set.** Three back-to-back switches from a
  stable connection (System log 16:50:44 → 16:50:59 → 16:51:12 UTC+3): each synchronised
  in ≲10 s, ended Connected on the original account with all subscriptions live.
- **HGH-02 was REAL, but the diagnosis was off** — the throttle existed and was mounted;
  the key was broken. Caddy (no `trusted_proxies`) replaces Cloudflare's XFF with the CF
  edge IP; the gateway trusts CF ranges, walks past that hop, dead-ends, and keyed to the
  peer — 127.0.0.1 for EVERY user. One shared bucket: any user's successful sign-in
  resets the failure count (that is why QA's six attempts never tripped it — a live
  system keeps wiping the counter), and five failures by anyone lock the WHOLE site out
  (proven 2026-08-28: an IPv6 client got 429 from a lockout armed over IPv4). Fix in two
  halves: Caddy global `servers { trusted_proxies static <cloudflare ranges> }` +
  gateway `RATE_LIMIT_TRUSTED_PROXIES` = loopback + CF ranges (gateway 365793b also
  makes an unestablishable client identity fail OPEN with an hourly warning instead of
  pooling everyone). Cloudflare-dashboard rate rule on /gateway/api/Authentication/*
  remains open — still no CF access.
  **VERIFIED LIVE 2026-08-28** on gateway 5fdc39f: before the Caddy+env fix six IPv4
  fails all returned 401 (failing open, no hop); after it, five 401s then 429 +
  Retry-After:30 at the sixth, and IPv6 returned 401 while IPv4 was 429 in the same
  breath — per-client keys, not one shared bucket. Caddyfile.bak + gateway.env.bak
  stamped 20260828-070358 on the box.

### Round 7 close-out (2026-08-28) — ALL 33 FINDINGS CLEAR, 0 open
Confirmed on a real home-indicator iPhone (Safari, toolbar hidden) and live probes.
**Note for whoever maintains the retest report:** the HGH-05a evidence line is a
CSS-only grep (`grep 'safe-area' assets/index-*.css`) and will report a false
failure in every future round — the fix is an inline style that lives in the JS
bundle. The check must either grep the JS bundle
(`curl -s .../assets/index-*.js | grep -c safe-area-inset-bottom` → 1) or, better,
assert behavior: with the mobile layout active, set
`document.documentElement.style.setProperty('--safe-area-bottom','34px')` and
assert the bottom nav's computed padding-bottom becomes 34px and its height grows
by 34px (this is exactly what `e2e/phone-390.spec.ts` automates). Also remember
`viewport-fit=cover` is REQUIRED for the inset — its presence is part of the fix.
