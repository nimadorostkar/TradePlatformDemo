# Opofinance

A broker-branded web trading terminal: TradingView is the charting engine, and
everything around it — docks, widgets, order entry, position management — is
ours, driven by the Go **OpoMTSocket** gateway and MetaTrader 5.

> **This is a real-money interface.** Correctness, explicit state, and safe
> failure come before visual polish. If you are changing anything under
> `src/domain/orders/` or `src/integrations/gateway/`, read
> [`docs/integration/contract-discrepancies.md`](docs/integration/contract-discrepancies.md)
> first.

---

## Quick start

```bash
npm install
cp .env.example .env          # point VITE_GATEWAY_* at your gateway

# Copy the LICENSED TradingView package. It is not in this repository.
npm run tv:sync -- --source=/path/to/licensed/package
# (defaults to ../trading-view-integration if that checkout is present)

npm run dev                   # http://localhost:3100
```

Without `tv:sync` the chart will not load and the build will fail its asset
check — deliberately. There is no fallback to a public TradingView widget,
because a public widget shows TradingView's own prices rather than the broker's
MT5 prices, and a chart that disagrees with execution is worse than an error.

### Running against a local gateway

```bash
cd ../backend && make run                 # listens on :5063
```

Then in `.env`:

```
VITE_GATEWAY_HTTP_URL=http://localhost:5063
VITE_GATEWAY_WS_URL=ws://localhost:5063
```

---

## Commands

| Command                           | What it does                                                        |
| --------------------------------- | ------------------------------------------------------------------- |
| `npm run dev`                     | dev server on :3100                                                 |
| `npm run build`                   | typecheck + production build                                        |
| `npm run preview`                 | serve the production build                                          |
| `npm test`                        | unit + component tests — **never touches a network**                |
| `npm run test:coverage`           | the same, with coverage                                             |
| `npm run e2e`                     | Playwright; every gateway call intercepted — **cannot trade**       |
| `npm run test:contract`           | opt-in READ-ONLY checks against a configured non-production gateway |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                   |
| `npm run tv:sync`                 | copy the licensed TradingView package                               |
| `npm run tv:check`                | fail if the licensed assets are missing                             |

**No default command can place a trade.** The E2E suite answers
`/api/Trade/send_request` from a fixture and asserts the payload; nothing leaves
the browser. `test:contract` calls read endpoints only.

---

## Architecture

```
src/
├─ app/            providers, config (env + brand), header, palette, shells
├─ domain/         canonical models, trading service, validation, risk
├─ integrations/
│  ├─ gateway/     REST client · contracts · mappers · WebSocket pool · auth
│  └─ tradingview/ chart controller · datafeed · broker adapter · persistence
├─ features/       one folder per widget
├─ workspace/      widget registry · dock layout · versioned persistence
├─ stores/         quotes · trading · session · diagnostics
└─ components/ui/  primitives
```

The rules that matter most:

- **No React component sees a raw gateway DTO.** All casing, encoded JSON,
  suffixes, volume units, and code tables resolve in `integrations/gateway/mappers`.
- **One trading path.** The order ticket and the TradingView Broker API both
  call the same `TradingService`. Two implementations would diverge, and the
  failure mode is a real trade for the wrong size.
- **Decimal-safe money.** Prices, volumes, and P/L are decimal strings computed
  with `decimal.js`. Ticket ids are strings end to end — MT5 tickets exceed 2^53.
- **`null` means unavailable.** A field the gateway did not send renders as
  `Unavailable`, never as `0`.
- **The chart is created once.** Symbol, interval, theme, and layout changes go
  through the widget's API; nothing remounts the iframe.

Full detail:

- [Frontend architecture](docs/architecture/frontend-architecture.md)
- [Real-time reconciliation](docs/architecture/realtime-reconciliation.md) — what
  we can and cannot guarantee
- [TradingView asset strategy](docs/architecture/tradingview-asset-strategy.md)
- [ADR 0001 — layout engine](docs/adr/0001-layout-engine.md)
- [Gateway contract matrix](docs/integration/gateway-contract.md)
- [Contract discrepancies](docs/integration/contract-discrepancies.md)
- [Current-state audit](docs/integration/current-state.md)
- [Operations runbook](docs/operations/runbook.md)

---

## The workspace

The layout is **data, not JSX**. Widgets declare which docks they may occupy and
what backend capability they need; the layout engine decides where they are.

- Resize, collapse, reorder, and tab-group the left, right, and bottom docks.
- Move a widget between docks by dragging its tab, or from the command palette
  (`⌘K` / `Ctrl+K`) — the docks are fully keyboard-operable.
- Save, rename, duplicate, load, delete, and reset layouts.
- Chart layouts: single, two side-by-side, two stacked, three, four.
- A corrupt saved layout is discarded in favour of the default rather than
  preventing startup.

Widgets with no backend behind them say so plainly. Market depth and price
alerts are capability-gated off, because the gateway has no verified DOM shape
and no alert persistence — a plausible-looking empty ladder would imply the
feature works.

---

## Branding

One build serves multiple brokers. Set `VITE_BRAND_CONFIG_URL` to a JSON
document validated by `src/app/config/brand.ts`:

```json
{
  "brokerName": "Example Broker",
  "platformName": "Example Terminal",
  "logoUrl": "https://cdn.example.com/logo.svg",
  "primaryColor": "#3772ff",
  "secondaryColor": "#6c8cff",
  "legalLinks": [{ "label": "Terms", "href": "https://example.com/terms" }],
  "defaultTheme": "dark"
}
```

Invalid or unreachable configuration falls back to neutral defaults and records
why in System Messages. Feature components reference semantic CSS variables
only — never a literal brand colour.

---

## Deployment

```bash
docker build -t web-trading-terminal .

docker run -p 8080:8080 \
  -e GATEWAY_HTTP_URL=https://gateway.example.com \
  -e GATEWAY_WS_URL=wss://gateway.example.com \
  -e CRM_HTTP_URL=https://crm.example.com \
  -e APP_ENV=production \
  -e APP_VERSION="$(git rev-parse --short HEAD)" \
  web-trading-terminal
```

The entrypoint injects runtime configuration and builds the CSP `connect-src`
and `frame-ancestors` from the environment, then **refuses to start** on
plaintext URLs in production. nginx runs unprivileged on 8080.

Full procedures — including the licensed-asset step CI needs — are in the
[runbook](docs/operations/runbook.md).

---

## Security posture

- HTTPS/WSS enforced in production by the config validator, at build **and** at
  container start.
- Strict CSP; the three directives the TradingView library requires are
  documented and justified in the asset-strategy doc.
- `frame-ancestors` defaults to `'none'` — the terminal is not embeddable unless
  a host origin is explicitly allowed.
- Tokens are held **in memory** by default. We do not call any browser storage
  "secure": see
  [auth storage](docs/architecture/frontend-architecture.md#auth-storage) for
  the honest trade-off, including the gateway's WebSocket query-token constraint.
- Tokens are never accepted from URL parameters; `postMessage` bootstrap
  validates the origin before reading the payload.
- Diagnostics are redacted at write time — no tokens, no authenticated URLs.
- No `dangerouslySetInnerHTML` anywhere.

### Known advisories

`npm audit --omit=dev` reports no production vulnerabilities.

The full development dependency audit reports **brace-expansion**, a transitive
dependency of ESLint and coverage tooling. It is not present in the production
bundle and currently requires breaking major upgrades of the development
toolchain. Recheck it at each dependency bump.

---

## Contributing rules

1. Never mock backend responses in production code. Tests mock the **network
   boundary** only.
2. Never show an order as `filled` without authoritative confirmation.
3. Never auto-retry a trade mutation.
4. Never coerce a ticket id to `number`.
5. Never render a missing field as `0`.
6. Never recreate the TradingView widget for a render, symbol, theme, or layout
   change.
7. Add a test alongside any change to a mapper, a code table, or validation.
