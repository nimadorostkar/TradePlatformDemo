# Licensed TradingView asset strategy

## The constraint

The TradingView Charting Library / Trading Platform is distributed under a
per-licensee agreement. It is **not** downloadable from a public source, and it
must not be redistributed to anyone without a licence.

`/Users/nima/Projects/trading-view-integration` holds the licensed package.
`charting_library/broker-api.d.ts` and `trading_terminal.d.ts` confirm it is the
**Trading Platform**, not Advanced Charts — so the Broker API, order/position
lines, drag-to-modify, and the account manager are all available.

## What this repository does

**Copies, never downloads.** `scripts/sync-tradingview-assets.mjs` copies from a
configured local path. It makes no network request of any kind.

Source resolution order:

1. `--source=<path>`
2. `$VITE_TRADINGVIEW_SOURCE_DIR`
3. `$TRADINGVIEW_SOURCE_DIR`
4. `../trading-view-integration` (the known local checkout)

Destinations:

| Destination                 | Contents                                               | Served at            |
| --------------------------- | ------------------------------------------------------ | -------------------- |
| `public/charting_library/`  | the runtime library                                    | `/charting_library/` |
| `public/datafeeds/`         | bundled UDF helpers (unused; we have our own datafeed) | `/datafeeds/`        |
| `vendor/tradingview/types/` | `.d.ts` files the app compiles against                 | —                    |

The source package is **never modified**.

## Git policy: ignored, not vendored

All three destinations are in `.gitignore`.

Vendoring licensed binaries into a repository that may be cloned by anyone
without a licence would breach the agreement. The cost is that a fresh clone
cannot build a working chart until `npm run tv:sync` runs — which is the correct
trade-off, and the failure is loud rather than silent.

## Failing loudly

`npm run tv:check` verifies the required files exist and **exits non-zero** when
they do not. It runs in:

- the Dockerfile build stage, before `npm run build`
- the CI `build` job

There is **no fallback to a public TradingView widget**. A public widget would
show TradingView's own market data rather than the broker's MT5 prices, so the
chart would disagree with execution — worse than showing an error.

## Why the library is not bundled

It is loaded as a classic script from `library_path` and resolves its own chunk
URLs at runtime relative to that path. Bundling it would break chunk loading.
It is therefore served as static assets and loaded once via
`loadTradingView()`, which is the only place that touches `window.TradingView`.

This also keeps its cost measurable separately from application JS.

## CSP requirements

The library needs three directives that would otherwise be tightened. Each is
required, not convenience:

| Directive                              | Why                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `script-src 'unsafe-eval'`             | compiles study and formula expressions at runtime; will not start without it |
| `style-src 'unsafe-inline'`            | writes inline styles for chart elements every frame                          |
| `worker-src blob:` / `child-src blob:` | spawns rendering workers from blobs                                          |

Everything else stays locked down: `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`, and `frame-ancestors` defaulting to `'none'` unless a host
origin is explicitly allowed. See `deploy/nginx.conf`.

## Upgrading

1. Update the licensed package in its own checkout.
2. `npm run tv:sync`
3. `npx tsc --noEmit -p tsconfig.app.json` — the `.d.ts` files come with the
   package, so an API change surfaces as a type error here rather than at runtime.
4. Run the unit and E2E suites.
5. Note the version in `vendor/tradingview/SYNC_INFO.json` (written by the sync).

## Type-declaration note

Broker types are imported from `charting_library.d.ts`, **not** from
`broker-api.d.ts`. Both declare the same shapes, but as separate nominal
declarations — mixing them makes `broker_factory` fail to typecheck because the
two `IBrokerConnectionAdapterHost` types are considered unrelated. Everything
flows through `src/integrations/tradingview/types.ts`, so no feature file
imports from a vendor path.
