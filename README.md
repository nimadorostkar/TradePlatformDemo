# TradePlatformDemo

A full-stack trading platform in one repository:

| Package                    | What it is                                                                                              | Stack                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [`frontend/`](frontend/)   | Broker-branded web trading terminal — TradingView is the charting engine, everything around it is ours. | React 19, TypeScript, Vite, Tailwind  |
| [`backend/`](backend/)     | MT5 gateway — exposes the MetaTrader 5 Manager Web API as REST + a `/ws` streaming endpoint.            | Go, PostgreSQL/TimescaleDB, Redis, NATS |

Each package has its own README with the full story:

- [`frontend/README.md`](frontend/README.md) — terminal architecture, commands, the licensed TradingView asset policy
- [`backend/README.md`](backend/README.md) — gateway design, endpoint parity, deployment

> **This is a real-money system.** Read
> [`frontend/docs/integration/contract-discrepancies.md`](frontend/docs/integration/contract-discrepancies.md)
> and [`backend/docs/VOLUME-UNITS.md`](backend/docs/VOLUME-UNITS.md) before touching
> order entry on either side.

## Quick start (full stack, no broker needed)

```bash
make setup                        # npm ci + go mod download
cd frontend && npm run tv:sync -- --source=/path/to/licensed/tradingview && cd ..
make dev                          # mock MT5/CRM :5199 → gateway :5063 → terminal :3100
```

Open <http://localhost:3100> and sign in with `trader@opofinance.com` /
`correct-password` (the mock CRM's user). Everything the terminal does — login,
account list, quotes, chart history, positions, orders, the `/ws` stream — goes
through the real Go gateway; only MetaTrader and the CRM are stand-ins
(`backend/scripts/mockmt5`). Ctrl-C stops all three processes.

How it is wired: the browser talks only to the Vite origin, which proxies
`/gateway` → gateway and `/crm` → CRM exactly like the production edge
(`frontend/deploy/caddy/`). The gateway runs from `backend/.env.mock` — every
value there is a placeholder; nothing can reach a broker.

### Against a real broker

```bash
cp backend/.env.example backend/.env       # MT5_* credentials, JWT_SECRET_KEY, CRM_URL,
                                           # CRM_ACCOUNT_TYPE_SUFFIXES for your account types
make backend                               # gateway on :5063 (sources nothing — export .env yourself)
make frontend                              # terminal on :3100, proxying to the gateway
```

The broker IP-whitelists its Manager API, so real MT5 data only flows from a
whitelisted host — locally you will see the sign-in screen but no accounts.

The licensed TradingView package is **never committed**; `tv:sync` copies it in
locally and CI restores it from a private artifact. Without it the chart will not
load and the build fails on purpose — see
[`frontend/docs/architecture/tradingview-asset-strategy.md`](frontend/docs/architecture/tradingview-asset-strategy.md).

## Layout

```
.
├── frontend/          # web terminal (Vite app; own package.json, tests, deploy/)
├── backend/           # Go gateway (own go.mod, Makefile, deploy/, docs/)
├── .github/workflows/
│   ├── frontend.yml   # typecheck · lint · unit · build · e2e · deploy   (paths: frontend/**)
│   └── backend.yml    # fmt · vet · race · govulncheck · store · e2e · artifacts (paths: backend/**)
├── scripts/dev.sh     # `make dev`: mock MT5/CRM + gateway + Vite, one Ctrl-C
└── Makefile           # root fan-out: setup / dev / build / test / check
```

The two workflows are path-filtered, so a change in one package does not run the
other's pipeline. All `run:` steps use `working-directory`, and every path handed to
an action is repo-relative (`frontend/…`, `backend/…`).

## Verifying locally

```bash
make check    # gofmt + vet + go test, then tsc + eslint + prettier + vitest
make test     # just the unit suites
make build    # bin/gateway + frontend/dist
```

## Configuration

Both packages read a local `.env` (gitignored) and ship an annotated
`.env.example`. The backend refuses to start with unsafe defaults when
`ENVIRONMENT=production`; the frontend bakes production origins into the bundle
and overrides them at load time with `runtime-config.js`. Details live in each
package's README and `docs/`.
