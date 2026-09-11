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

## Quick start

```bash
make setup                        # npm ci + go mod download

# Backend — Go gateway on :5063
cp backend/.env.example backend/.env   # fill in MT5_* / JWT_SECRET_KEY
make backend

# Frontend — Vite dev server on :3100
cp frontend/.env.example frontend/.env # point VITE_GATEWAY_* at the gateway
cd frontend && npm run tv:sync -- --source=/path/to/licensed/tradingview
make frontend
```

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
└── Makefile           # root fan-out: setup / build / test / check
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
