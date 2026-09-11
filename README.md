# TradePlatformDemo

A full-stack **demo** trading platform in one repository. It never connects to a
real broker: the gateway's only upstream is the built-in `demomarket` service, which
serves **real market prices** (live FX, tick-level crypto, years of history) from
Yahoo Finance and Binance's public endpoints — no account, no key — in front of a demo account whose
position and equity follow those prices. Nothing real is ever traded.

| Package                    | What it is                                                                                              | Stack                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [`frontend/`](frontend/)   | Broker-branded web trading terminal — TradingView is the charting engine, everything around it is ours. | React 19, TypeScript, Vite, Tailwind  |
| [`backend/`](backend/)     | Trading gateway (REST + `/ws` streaming) in front of `cmd/demomarket`: real market data + a demo broker/CRM, speaking the MT5 Manager API contract. | Go, PostgreSQL/TimescaleDB, Redis, NATS |

Each package has its own README with the full story:

- [`frontend/README.md`](frontend/README.md) — terminal architecture, commands, chart data flow
- [`backend/README.md`](backend/README.md) — gateway design, endpoint parity, deployment

> **Demo only.** No real broker, CRM, or money is involved anywhere in this
> repository or its deployment. The code paths are production-shaped (the
> gateway speaks the MT5 Manager API contract to demomarket), so the usual
> care still applies: read
> [`frontend/docs/integration/contract-discrepancies.md`](frontend/docs/integration/contract-discrepancies.md)
> and [`backend/docs/VOLUME-UNITS.md`](backend/docs/VOLUME-UNITS.md) before touching
> order entry on either side.

## Quick start

```bash
make setup                        # npm ci + go mod download
make dev                          # demomarket :5199 → gateway :5063 → terminal :3100
```

Open <http://localhost:3100> and sign in with `trader@example.com` /
`correct-password`. Everything the terminal does — login, account list, quotes,
chart history, positions, orders, the `/ws` stream — goes through the Go gateway;
prices come from `backend/cmd/demomarket`, which serves **real data** for ten
instruments without any key: seven FX majors and gold futures from Yahoo Finance
(live FX, true 1-minute candles for the last week, daily candles for years; gold
is exchange-delayed ~10 min and labelled so), and BTC/ETH tick-by-tick from
Binance's public WebSocket, falling back to Yahoo wherever Binance is unreachable.
`-source synthetic` runs it offline on a deterministic generator instead.
Ctrl-C stops all three processes.

How it is wired: the browser talks only to the Vite origin, which proxies
`/gateway` → gateway and `/crm` → simulator exactly like the deployed edge
(`deploy/edge/nginx.conf`). The gateway runs from `backend/.env.demo` with
`TRADING_MODE=demo`; every value there is a placeholder.

## Layout

```
.
├── frontend/          # web terminal (Vite app; own package.json, tests, deploy/)
├── backend/           # Go gateway (own go.mod, Makefile, deploy/, docs/)
├── scripts/dev.sh     # `make dev`: demomarket + gateway + Vite, one Ctrl-C
├── deploy/            # docker compose stack + deploy.sh (edge nginx, prebuilt SPA, gateway, mock)
└── Makefile           # root fan-out: setup / dev / build / test / check
```

There is no CI/CD in this repository; `make check` is the full verification
suite and is run locally.

## Deploying to a server

```bash
deploy/deploy.sh                                   # → http://217.65.145.161:8080 (defaults)
SSH_HOST=root@1.2.3.4 SSH_KEY=~/.ssh/key EDGE_PORT=8080 deploy/deploy.sh
```

One Docker Compose project (`deploy/docker-compose.yml`) on a single public port:
an nginx **edge** serving the SPA at `/` and proxying `/gateway/` (REST + WebSocket)
and `/crm/` same-origin — the production layout — in front of the **frontend**
(prebuilt SPA, unprivileged nginx), the Go **gateway** (distroless) and **demomarket**.

- The terminal is built on the machine running the script; only `dist/` is
  shipped, so the host needs no Node toolchain.
- `gateway.env` is generated on the host on first deploy with fresh random
  `JWT_SECRET_KEY` / `MANAGER_API_KEY` and never overwritten; nothing secret leaves
  your machine. It points the gateway at the `demomarket` service only.
- Served over plain HTTP on an IP: the gateway's session-restore cookies are
  `Secure`-only, so a page reload asks for sign-in again. Put a domain + TLS in
  front (`PUBLIC_ORIGIN=https://…` switches the terminal to production mode) and
  that goes away.
- Every container restarts with Docker; the stack survives a reboot.

### CI/CD

`.github/workflows/deploy.yml` runs on every push and pull request:

1. **Verify** — legacy-reference guard (`scripts/check-no-legacy-refs.sh`), Go
   fmt/vet/tests, TypeScript typecheck, ESLint, Prettier, Vitest.
2. **Deploy** (push to `main` only, GitHub environment `production`) — runs
   `deploy/deploy.sh` against the server over SSH.

One-time setup with a key that exists **only** for this pipeline (never reuse a
personal or previous key):

```bash
ssh-keygen -t ed25519 -N '' -C tradeplatform-github-actions -f /tmp/ci_deploy_key
ssh-copy-id -i /tmp/ci_deploy_key.pub -o IdentityFile=~/.ssh/<your-admin-key> root@<server>

gh secret set DEPLOY_HOST        --body '<server ip>'
gh secret set DEPLOY_USER        --body 'root'
gh secret set DEPLOY_SSH_KEY     < /tmp/ci_deploy_key
gh secret set DEPLOY_KNOWN_HOSTS --body "$(ssh-keyscan -t ed25519 <server ip> 2>/dev/null)"
gh variable set PUBLIC_ORIGIN    --body 'http://<server ip>:8080'
rm /tmp/ci_deploy_key /tmp/ci_deploy_key.pub      # the private key now lives only in GitHub
```

The deploy job fails with an explicit message until the
secrets above exist — it never deploys half-configured.

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
