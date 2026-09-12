# TradePlatformDemo

A full-stack **demo** trading platform in one repository. It never connects to a
real broker: the gateway's only upstream is the built-in `demomarket` service, which
serves **real market prices** (live FX, tick-level crypto, years of history) from
Yahoo Finance and Binance's public endpoints — no account, no key — in front of a
**demo execution engine**: market and pending orders fill against those prices,
stops and targets fire, margin is checked and equity follows the open book.
Nothing real is ever traded — the counterparty is the `demomarket` process.

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

`make check` is the full verification suite; GitHub Actions runs the same
checks on every push and pull request and deploys `main` to the server
(see [CI/CD](#cicd)).

## Users and accounts

User management lives in **PostgreSQL**, owned by the `demomarket` service and
exposed to the terminal through the CRM contract (`/crm/...`). Schema
(`backend/cmd/demomarket/users.go`, migrated automatically at start):

| table | holds |
|---|---|
| `users` | id, email (unique), bcrypt `password_hash`, `enabled`, created/last-login/updated timestamps, and the profile: `name`, `phone`, `country` (ISO-2), `city`, `language` (BCP 47), `timezone` (IANA), `kyc_status` (unverified / pending / verified) |
| `accounts` | trading `login` (PK), owning `user_id`, `type_id`, currency, balance |
| `sessions` | sha256 `token_hash` (PK), `user_id`, `expires_at` — the CRM access token the client holds is never stored in clear |
| `broker_accounts` | the demo broker's view of each trading account: settled `balance`, `credit`, `leverage`, `currency` |
| `broker_positions` | open positions (ticket, login, symbol, side, volume, open price, SL/TP) |
| `broker_orders` | every order — `working` rows are the pending book, the rest are the trader's order history in final state |
| `broker_deals` | every fill, close and balance operation with its realised `profit` — the trading history |
| `broker_meta` | the ticket and request counters, so nothing is ever reissued after a restart |

- **Sign-up** is self-service on the sign-in screen ("New here? Create a demo
  account"): `POST /client-api/register {email,password,name,phone?,country?,city?,language?,timezone?}`
  creates the user and one funded demo account (login from `account_login_seq`,
  starting 100001), then the normal sign-in runs. Passwords: 8–128 characters;
  the profile fields are validated (real IANA zone, ISO-2 country) and default
  to `en` / `UTC`. Duplicate emails → 409.
- **Sign-in**: `POST /client-api/login` → 30-day session; `POST /client-api/accounts`
  (Bearer) lists the user's accounts with their live figures (balance, equity,
  margin, free margin, leverage, open positions, pending orders).
  Disabled users cannot sign in and their sessions are revoked.
- **Profile**: `GET /client-api/me` returns it (the terminal's Account panel
  shows it under the figures); `PUT /client-api/me {name,phone,country,city,language,timezone}`
  replaces the editable fields; `POST /client-api/password {currentPassword,newPassword}`
  changes the password and signs every other session out.
- **Admin** (`Authorization: Bearer $ADMIN_TOKEN`; 404 without it):
  `GET /admin/users` lists users with their profile, accounts and last login;
  `POST /admin/users/{id}/enabled {"enabled":false}` disables (or re-enables) one;
  `POST /admin/users/{id}/kyc {"status":"verified"}` sets the verification state;
  `POST /admin/users/{id}/reset` empties the user's books (positions, orders,
  history, deals) and refunds each account to its starting balance.
- A fresh database is seeded with `trader@example.com` / `correct-password`
  (accounts 1010, 2020, 3030). The same PostgreSQL also holds the gateway's price
  alerts and saved workspaces (`POSTGRES_DSN`).
- Locally, `make dev` starts a PostgreSQL container when Docker is running
  (`USERS_DSN`) that holds both the users and the broker's book; without Docker
  the user store runs in memory with the same seed and the book falls back to
  a JSON file.

## Trading (the demo broker)

`demomarket` is a complete hedging broker on the MT5 Manager API contract
(`backend/cmd/demomarket/broker.go`) — the gateway and the terminal talk to it
exactly as they would to a trading server:

- **Market orders** fill at the live ask (buy) / bid (sell), with optional SL/TP;
  a close is the opposite side against the position id, in full or in part, and
  the realised profit settles into the balance (mirrored to the user store).
- **Pending orders** — limit, stop and stop-limit — rest until the market reaches
  them (limits never fill worse than their price), can be modified or cancelled,
  and expire on their GTD/day lifetime.
- **Stops and targets** are evaluated every 250 ms against bid (buys) / ask
  (sells); a **stop-out** closes the most losing position while the margin
  level is at or under 50 %.
- **Margin** is notional ÷ account leverage (default 1:100, changeable from the
  terminal's *Adjust* control; choices in `LEVERAGE_CHOICES`), converted to USD
  through the listed USD pairs; gold is a 100 oz contract, crypto a 1-coin one.
- Every fill books an **order** (history) and a **deal**; rejections come back as
  MT5 retcodes (`10019 No money`, `10016 Invalid stops`, `10015 Invalid price`,
  `10014 Invalid volume`, `10018 Market closed`, …) that the terminal explains.
- The book — positions, working orders, order history, deals, balances and
  leverage — is written to **PostgreSQL** (the `broker_*` tables above,
  `backend/cmd/demomarket/store.go`) whenever `USERS_DSN` is set, so a trader's
  history survives restarts and redeploys and can be queried directly. Saves
  happen from the engine loop once a second when something changed, never on
  the request path. Without a database the book falls back to the JSON file in
  `BROKER_STATE_FILE`; a database that has never held a book imports that file
  once at start, so switching backends keeps every trader's history. Use the
  admin reset (or `TRUNCATE broker_deals, broker_orders, broker_positions`) to
  empty an account's history.

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
- `gateway.env` (`JWT_SECRET_KEY`, `MANAGER_API_KEY`) and `.env` (`POSTGRES_PASSWORD`,
  `ADMIN_TOKEN`) are generated on the host on first deploy with fresh random values
  and never overwritten; nothing secret leaves your machine.
- Served over plain HTTP on an IP, a reload still restores the session: the
  gateway's session cookies are `Secure` only when the trader's connection is
  TLS (the edge forwards the scheme). Put a domain + TLS in front
  (`PUBLIC_ORIGIN=https://…` switches the terminal to production mode) for real
  use; until then the bearer token and cookies travel in clear alike.
- Every container restarts with Docker; the stack survives a reboot.

### CI/CD

`.github/workflows/deploy.yml` runs on every push and pull request:

1. **Verify** — legacy-reference guard (`scripts/check-no-legacy-refs.sh`), Go
   fmt/vet/tests, TypeScript typecheck, ESLint, Prettier, Vitest.
2. **Deploy** (push to `main` only, GitHub environment `production`) — runs
   `deploy/deploy.sh` against the server over SSH. The script retries the
   first SSH connection for two minutes (runners occasionally cannot reach the
   host on the first try) and takes a lock on the host, so a deploy from a
   laptop and one from CI serialise instead of racing `docker compose up`.
   Deploys are also queued one at a time on the GitHub side and never
   cancelled mid-flight.

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
