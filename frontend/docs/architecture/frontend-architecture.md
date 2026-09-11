# Frontend architecture

## Layers

```
features/ · workspace/ · components/      ← React. Domain models only.
        │
domain/                                   ← models, trading service, validation, risk
        │
integrations/gateway/ · integrations/tradingview/
        │                                    ← the ONLY place raw DTOs exist
   Go gateway · TradingView library
```

The boundary rule: **no React component ever sees a raw gateway or MT5 DTO.**
Casing quirks, encoded JSON, symbol suffixes, volume units, timestamps, side and
type codes, and status tables are all resolved in `integrations/gateway/mappers`.

## State ownership

| State                             | Owner                                                       | Why                                                   |
| --------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Quotes                            | `quoteStore` (`useSyncExternalStore`, per-symbol listeners) | ticks several times a second across dozens of symbols |
| Positions / orders / account      | `useTradingStore` (Zustand)                                 | snapshot-replaced, generation-guarded                 |
| Session and accounts              | `useSessionStore`                                           | changes rarely                                        |
| Workspace layout                  | `useWorkspace`                                              | UI-only; never mixed with trading data                |
| Reference data (symbols, history) | TanStack Query                                              | cacheable reads with lifecycle                        |
| Diagnostics                       | `useSystemMessages`                                         | redacted at write time                                |

Deliberately **not** one global store. An order update must not re-render the
watchlist, and a quote tick must not re-render anything but the affected cells.

### Why quotes are not in Zustand or context

A context provider re-renders every consumer on every value change. With a
50-symbol watchlist ticking at ~3 s that is thousands of wasted renders a
minute. `quoteStore` keeps a listener set **per symbol**, so a EURUSD tick
notifies only EURUSD's cells. Proven by
`src/stores/quote-store.test.tsx` — a tick in one symbol produces zero renders
in another.

## The single trading path

Both the custom order ticket and the TradingView Broker API call the same
`TradingService` (`src/domain/orders/trading-service.ts`).

Two independent trade implementations would eventually diverge — a validation
rule fixed in one, a volume conversion wrong in the other — and the failure mode
is a real trade for the wrong size. The Broker API adapter holds **no trading
state**; it reads from the same normalised store the tables render from, so the
chart and the bottom dock cannot disagree about what is open.

## Money, prices, and ids

- Prices, money, and volume are **decimal strings**, computed with `decimal.js`.
  `0.1 + 0.2 !== 0.3` is not acceptable in a P/L column.
- Ticket ids are **strings end to end**, including as object keys. MT5 tickets
  are 64-bit; `Number` loses precision above 2^53.
- `number` appears only where the TradingView library's API demands it, and
  every such conversion is explicit (`toNumber`, `Number(...)`) and localised.
- A field the gateway did not supply is `null` and renders as `Unavailable` —
  never as `0`. A zero stop-loss and an absent stop-loss mean different things.

## Workspace system

The workspace is **data, not JSX**. Widgets declare where they may live and what
capability they need (`src/workspace/registry/types.ts`); the layout engine
decides where they are.

- `react-resizable-panels` for resizing only — see
  [ADR 0001](../adr/0001-layout-engine.md).
- Placement, ordering, and tab grouping are state, so a move is a state edit
  rather than a DOM re-parent. **This is what keeps the TradingView iframe
  alive across every layout change.**
- The document is versioned and migrated forward; an invalid one is discarded
  in favour of the default. A corrupt saved layout must never stop the terminal
  from starting.
- Layouts contain **no account-scoped data**, so switching accounts cannot leak
  one account's view into another's.

## TradingView integration

`ChartController` creates the widget **once per pane**. Symbol, interval,
theme, dock resize, layout restore, and quote ticks are all pushed through the
widget's own API. The effect that creates it depends only on `paneId`,
`isPrimary`, and an explicit retry token.

Recreating the widget costs a full iframe reload and loses the user's drawings
and studies — the most visible way a terminal can feel broken.

Preserved from the working integration:

- **Broker-host race protection.** `broker_factory` and `onChartReady` fire in
  a different order locally than on a server; the host is exposed as a promise.
- Suffix handling, `source=tv` transforms, historical + realtime bars, chart
  save/load, and the Trading Platform feature configuration.

Improved on it: no compile-time `BASE_URL`/`WEB_SOCKET_URL` globals, no
`@ts-nocheck`, no localStorage-coupled auth, no cross-account singletons, no
linear fixed reconnect, no `window.tvWidget` as architecture.

## Auth storage {#auth-storage}

**Default: in memory only.** Tokens do not survive a reload.

We do not describe any browser storage as "secure". The honest position:

- `localStorage` and `sessionStorage` are readable by **any** script in the
  origin. An XSS that reaches either can lift a gateway JWT and trade with it.
- In-memory storage narrows the window to the page's lifetime. It does not
  eliminate the risk; it reduces it.
- The token is **not** in any URL. A browser `WebSocket` constructor cannot set
  an `Authorization` header, so the credential travels as the
  `tradeplatform.jwt.<JWT>` subprotocol; the gateway negotiates only `tradeplatform.v1`,
  so it is never echoed back. This keeps the JWT out of connect URLs, browser
  history, referrers, and proxy access logs, as well as out of every log,
  diagnostic, and UI surface.
  - This replaced an `access_token` query parameter. Production **rejects** that
    legacy transport; `redactUrl` still strips the parameter defensively so a
    mixed-version diagnostic can never print one.

`VITE_ENABLE_LEGACY_AUTH_STORAGE` restores the old `token`/`crm_token`
localStorage keys for migration. It defaults **off** and the env validator
**refuses to boot** with it on in production.

Also enforced: tokens are never accepted from URL parameters
(`assertNoTokenInUrl`), and `postMessage` bootstrap validates the origin against
an allowlist before looking at the payload.

## Error handling

Every failure becomes a `TradingError` with a `kind`, a stable `code`, a
trader-safe `message`, a redacted `detail`, and a `requestId`. Components render
`message`; diagnostics record `code` + `requestId` for correlation with gateway
logs.

MT5 retcodes map to readable text only where the meaning is confirmed. An
unknown rejection shows the code rather than invented friendly text — the number
is more useful to support than a guess.

## Performance

- No full-shell re-render on a tick — enforced by test.
- No TradingView recreation on symbol, theme, or layout change.
- Watchlists and tables are virtualised; **only visible rows are subscribed**,
  so a 500-symbol list does not open 500 sockets.
- Symbol search is deferred and cancels superseded requests.
- Secondary widgets are lazily loaded — the initial bundle carries the shell,
  not every panel.
- Application JS and the licensed TradingView assets are measured separately
  (see the CI bundle-size step).
