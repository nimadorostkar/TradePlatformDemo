import { existsSync } from 'node:fs';
import path from 'node:path';
import { test as base, type Page, type Route } from '@playwright/test';

/**
 * Whether the licensed TradingView Charting Library is installed
 * (`npm run tv:sync`). It is never in git — every deployment brings its own
 * licence — so specs that drive the chart itself skip, with this reason,
 * when it is absent. Everything that does not need the chart still runs.
 */
export const CHART_LIBRARY_PRESENT = existsSync(
  path.resolve(import.meta.dirname, '../../public/charting_library/charting_library.standalone.js'),
);
export const CHART_LIBRARY_SKIP_REASON =
  'requires the TradingView Charting Library — bring your own licence, then `npm run tv:sync`';

/**
 * Gateway interceptor.
 *
 * EVERY request to the gateway, the CRM, and the WebSocket is answered from
 * this fixture. Nothing in the E2E suite can reach a real trading server, so
 * `npm run e2e` can never place, modify, or cancel a live order.
 *
 * Trade mutations are recorded here so a spec can assert the exact payload the
 * app would have sent, without anything leaving the browser.
 */

export interface AlertRecord {
  id: string;
  login: string;
  symbol: string;
  condition: 'above' | 'below';
  price: number;
  note: string;
  status: 'active' | 'triggered';
  createdAt: string;
  triggeredAt: string | null;
  triggeredPrice: number | null;
}

interface RecordedTrade {
  url: string;
  body: Record<string, unknown>;
}

export interface GatewayFixture {
  trades: RecordedTrade[];
  /** Overrides the next trade response (e.g. to simulate a rejection). */
  setTradeResponse: (response: unknown, status?: number) => void;
  /**
   * How many times the app exchanged the CRM token for a gateway JWT
   * (`POST /api/Authentication/login`). Each call mints a token with a fresh
   * expiry, so a spec can prove a switch renewed rather than reused.
   */
  authLogins: () => number;
}

const envelope = (data: unknown) => ({
  data,
  errorMessage: null,
  message: 'Success: Action performed successfully.',
  success: true,
});

const SYMBOLS = [
  {
    ticker: 'EURUSD',
    name: 'EURUSD',
    description: 'Euro vs US Dollar',
    type: 'FX',
    session: '24x5',
    timezone: 'Etc/UTC',
    exchange: 'Broker',
    listed_exchange: 'Broker',
    format: 'price',
    pricescale: 100000,
    minmov: 1,
    volume_precision: 2,
    data_status: 'streaming',
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    supported_resolutions: ['1', '5', '15', '60', '1D'],
    intraday_multipliers: ['1'],
    has_empty_bars: false,
    visible_plots_set: 'ohlcv',
    currency_code: 'USD',
    base_name: 'EURUSD',
    full_name: 'EURUSD',
    pro_name: 'EURUSD',
    sector: '',
    industry: '',
    delay: 0,
    volume: 1000,
  },
  {
    ticker: 'XAUUSD',
    name: 'XAUUSD',
    description: 'Gold vs US Dollar',
    type: 'Metals',
    session: '24x5',
    timezone: 'Etc/UTC',
    exchange: 'Broker',
    listed_exchange: 'Broker',
    format: 'price',
    pricescale: 100,
    minmov: 1,
    volume_precision: 2,
    data_status: 'streaming',
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    supported_resolutions: ['1', '5', '15', '60', '1D'],
    intraday_multipliers: ['1'],
    has_empty_bars: false,
    visible_plots_set: 'ohlcv',
    currency_code: 'USD',
    base_name: 'XAUUSD',
    full_name: 'XAUUSD',
    pro_name: 'XAUUSD',
    sector: '',
    industry: '',
    delay: 0,
    volume: 1000,
  },
];

const POSITIONS = [
  {
    Id: '30001',
    profit: 42.5,
    qty: 10000, // 1.00 lot in MT5 units
    side: 1,
    symbol: 'EURUSD',
    type: 0,
    last: 1.1015,
    price: 1.1,
    timeCreate: 1700000000,
    priceSL: 1.09,
    priceTP: 1.12,
  },
];

const ORDERS = [
  {
    id: '40001',
    symbol: 'XAUUSD',
    side: -1,
    type: 1, // limit
    qty: 5000, // 0.50 lot
    limitPrice: 2450,
    stopPrice: 0,
    last: 2400,
    status: 6, // working
    stopLoss: 0,
    takeProfit: 0,
    filledQty: 0,
    timeSetup: 1700000000,
    message: '',
  },
];

const ACCOUNT_STATE = {
  retcode: '0 Done',
  answer: {
    Login: '1001',
    Currency: 'USD',
    Balance: '10320.00',
    Equity: '10362.50',
    Profit: '42.50',
    Margin: '510.00',
    MarginFree: '9852.50',
    MarginLevel: '2031.86',
    MarginLeverage: '100',
  },
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

export async function installGatewayRoutes(
  page: Page,
  state: {
    trades: RecordedTrade[];
    tradeResponse: unknown;
    tradeStatus: number;
    alerts: AlertRecord[];
    loginCount: number;
  },
): Promise<void> {
  // Registered FIRST on purpose: Playwright gives precedence to the route
  // registered LAST, so this net catches anything the specific handlers below
  // do not claim. Nothing may leave the machine.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) =>
    route.abort('blockedbyclient'),
  );

  // Block the WebSocket outright. The app must remain usable on REST snapshots
  // alone and must report the stream state honestly — which is exactly what
  // the reconnect/stale specs assert.
  await page.routeWebSocket(/\/ws/, (ws) => ws.close());

  await page.route('**/api/Authentication/crmlogin', (route) =>
    json(route, { token: 'crm-token-e2e' }),
  );
  // The gateway's authoritative per-account symbol suffixes (deployment
  // config). The client prefers these over its built-in type map.
  await page.route('**/api/Authentication/accounts', (route) =>
    json(
      route,
      envelope([
        { login: '1001', typeId: 57, suffix: '.', suffixKnown: true },
        { login: '1002', typeId: 58, suffix: '!', suffixKnown: true },
      ]),
    ),
  );

  await page.route('**/api/Authentication/login', (route) => {
    // A JWT whose `accounts` claim contains 1001 and 1002. Each exchange mints
    // a DISTINCT token (fresh expiry) so renewal is observable: an account
    // switch must produce a new token, not reuse the old one.
    state.loginCount += 1;
    return json(route, {
      token: [
        'eyJhbGciOiJIUzI1NiJ9',
        Buffer.from(
          JSON.stringify({ accounts: '1001,1002', exp: 4102444800 + state.loginCount }),
        ).toString('base64url'),
        'signature',
      ].join('.'),
    });
  });

  await page.route('**/client-api/accounts**', (route) =>
    json(route, [
      {
        login: '1001',
        currency: 'USD',
        isEnabled: true,
        isReadOnly: false,
        type: { id: 57, description: 'ECN', server: 'Broker-Live' },
      },
      {
        login: '1002',
        currency: 'USD',
        isEnabled: true,
        isReadOnly: false,
        type: { id: 58, description: 'Standard', server: 'Broker-Live' },
      },
    ]),
  );

  await page.route('**/api/Test/getServerTime**', (route) =>
    json(route, { unixTimestamp: String(Math.floor(Date.now() / 1000)) }),
  );

  await page.route('**/api/Symbol/getsymbolsbymask**', (route) => json(route, envelope(SYMBOLS)));

  await page.route('**/api/Symbol/getsymbolsbyname**', (route) => {
    const url = new URL(route.request().url());
    const wanted = (url.searchParams.get('symbol') ?? '').replace(/[.!#]$/, '');
    const match = SYMBOLS.filter((s) => s.name === wanted);

    if (url.searchParams.get('source') === 'mt5') {
      return json(
        route,
        envelope({
          answer: {
            Symbol: wanted,
            Digits: wanted === 'XAUUSD' ? 2 : 5,
            // Gold's real contract is 100 oz. The old flat 100000 priced a
            // 0.01-lot gold ticket at 24,008 USD of margin — an artifact that
            // went unnoticed until insufficient margin started DISABLING the
            // buy/sell buttons (HGH-06) and every confirm-dialog spec froze.
            ContractSize: wanted === 'XAUUSD' ? '100' : '100000',
            // MT5 reports volume in UNITS, not lots: 1 lot = 10000.
            // 100 = 0.01 lots, 10000000 = 1000 lots.
            VolumeMin: '100',
            VolumeMax: '10000000',
            VolumeStep: '100',
            TickSize: wanted === 'XAUUSD' ? '0.01' : '0.00001',
            TickValue: '1',
            CurrencyProfit: 'USD',
          },
        }),
      );
    }
    return json(route, envelope(match));
  });

  await page.route('**/api/Tick/last**', (route) => {
    const url = new URL(route.request().url());
    const symbol = url.searchParams.get('symbol') ?? 'EURUSD';
    const isGold = symbol.startsWith('XAUUSD');
    return json(
      route,
      envelope([
        {
          symbolname: symbol,
          status: 'Ok',
          bid: isGold ? 2400.5 : 1.1,
          ask: isGold ? 2400.8 : 1.1002,
          lastprice: isGold ? 2400.6 : 1.1001,
          volume: 10,
        },
      ]),
    );
  });

  // Symbol-aware like the quote route above — serving ~1.1 bars under a
  // ~2400 gold quote left the legend's close depending on whether a live
  // stream tick happened to land before the assertion ran, which is exactly
  // the flake chart-trading's boot canary kept tripping on.
  const historyBase = (route: Route) => {
    const symbol = new URL(route.request().url()).searchParams.get('symbol') ?? '';
    return symbol.startsWith('XAUUSD') ? 2400 : 1.1;
  };
  await page.route('**/api/Tick/get**', (route) => json(route, envelope(bars(historyBase(route)))));
  await page.route('**/api/Tick/getHistoryby1Dresolution**', (route) =>
    json(route, envelope(bars(historyBase(route)))),
  );

  // ORDER MATTERS: Playwright gives precedence to the route registered LAST,
  // and `**/api/User/get**` also matches `/api/User/get_trade_state`. The
  // broader pattern is therefore registered FIRST so the specific one wins.
  await page.route('**/api/User/get**', (route) =>
    json(route, envelope({ answer: { Login: '1001', Name: 'E2E Trader', Rights: 1 } })),
  );
  await page.route('**/api/User/get_trade_state**', (route) =>
    json(route, envelope(ACCOUNT_STATE)),
  );

  // Login-aware so a spec can prove one account's data never appears under
  // another. Account 1002 deliberately holds nothing.
  await page.route('**/api/Position/get_page**', (route) => {
    const login = new URL(route.request().url()).searchParams.get('login');
    return json(route, envelope(login === '1001' ? POSITIONS : []));
  });
  await page.route('**/api/Order/get_page**', (route) => {
    const login = new URL(route.request().url()).searchParams.get('login');
    return json(route, envelope(login === '1001' ? ORDERS : []));
  });
  await page.route('**/api/Deal/get_page**', (route) =>
    json(
      route,
      envelope([
        {
          Deal: '50001',
          PositionID: '20001',
          Action: 0,
          Entry: 0,
          Symbol: 'EURUSD',
          Volume: 10000,
          Price: 1.095,
          Time: 1699990000,
        },
        {
          Deal: '50002',
          PositionID: '20001',
          Action: 1,
          Entry: 1,
          Symbol: 'EURUSD',
          Volume: 10000,
          Price: 1.1,
          Profit: 50,
          Storage: -1.2,
          Commission: -0.7,
          Time: 1699993600,
        },
        // A ledger entry that must NOT appear as a closed position.
        { Deal: '50003', Action: 2, Profit: 1000, Time: 1699980000, Comment: 'Deposit' },
      ]),
    ),
  );

  // ── Optional, capability-gated surface ─────────────────────────────────────
  // Modelled on what production reports, so the E2E build exercises the same
  // gated paths a trader hits. Anything left unrouted would fall through to the
  // dev server and 401, which the client correctly reads as a dead session.
  await page.route('**/api/Capabilities**', (route) =>
    json(
      route,
      envelope({
        alerts: { enabled: true },
        workspace: { enabled: true },
        news: { enabled: false, reason: 'No news provider is configured.' },
        calendar: { enabled: false, reason: 'No calendar provider is configured.' },
        executions: { enabled: true },
        marketDepth: { enabled: true },
        tradeIdempotency: { enabled: true },
      }),
    ),
  );

  await page.route('**/api/Alert/list**', (route) => json(route, envelope(state.alerts)));
  await page.route('**/api/Alert/create**', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.alerts.push({
      id: String(state.alerts.length + 1),
      login: String(body.login ?? ''),
      symbol: String(body.symbol ?? ''),
      condition: body.condition === 'below' ? 'below' : 'above',
      price: Number(body.price),
      note: String(body.note ?? ''),
      status: 'active',
      createdAt: new Date().toISOString(),
      triggeredAt: null,
      triggeredPrice: null,
    });
    await json(route, envelope({ ok: true }));
  });
  await page.route('**/api/Alert/delete**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    state.alerts = state.alerts.filter((alert) => alert.id !== id);
    await json(route, envelope({ ok: true }));
  });

  await page.route('**/api/Tick/get_marketdepth**', (route) => {
    // Symbol-aware, so a DOM spec can assert the exact clicked level price.
    const symbol = new URL(route.request().url()).searchParams.get('symbol') ?? 'EURUSD';
    const isGold = symbol.startsWith('XAUUSD');
    return json(
      route,
      envelope(
        isGold
          ? {
              symbol,
              volumeUnit: 'lots',
              crossed: false,
              unclassified: 0,
              bids: [
                { price: 2400.5, volume: 12, market: false },
                { price: 2400.25, volume: 30, market: false },
                { price: 2400.0, volume: 22, market: false },
              ],
              asks: [
                { price: 2400.8, volume: 18, market: false },
                { price: 2401.0, volume: 25, market: false },
                { price: 2401.25, volume: 40, market: false },
              ],
            }
          : {
              symbol,
              volumeUnit: 'lots',
              crossed: false,
              unclassified: 0,
              bids: [
                { price: 1.0999, volume: 12, market: false },
                { price: 1.0998, volume: 30, market: false },
              ],
              asks: [
                { price: 1.1001, volume: 18, market: false },
                { price: 1.1002, volume: 25, market: false },
              ],
            },
      ),
    );
  });

  await page.route('**/api/Deal/since**', (route) =>
    json(
      route,
      envelope([
        {
          id: '50001',
          orderId: '40001',
          positionId: '30001',
          symbol: 'EURUSD',
          price: 1.1,
          qty: 1,
          qtyMt5: 10000,
          side: 0,
          time: Date.now() - 3_600_000,
          timeSeconds: Math.floor(Date.now() / 1000) - 3600,
          commission: -0.7,
          swap: 0,
          profit: 0,
          entry: 0,
          comment: '',
        },
      ]),
    ),
  );

  // Workspace sync starts empty: the terminal must open on its local layout.
  await page.route('**/api/Workspace/get**', (route) => json(route, envelope(null)));
  await page.route('**/api/Workspace/save**', (route) => json(route, envelope({ ok: true })));

  // The one route that would move money — recorded, never forwarded.
  await page.route('**/api/Trade/send_request', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.trades.push({ url: route.request().url(), body });
    await json(route, envelope(state.tradeResponse), state.tradeStatus);
  });
}

function bars(base: number) {
  // Bars are stamped into the most recent 24x5 SESSION window, never blindly
  // "now": the library validates bar times against the symbol's session and
  // silently DISCARDS out-of-session bars, so weekend-stamped bars render as
  // "No data here" — which turned every chart spec red the first time CI ran
  // on a Saturday. On weekends this also exercises the same empty-window →
  // nextTime pagination the live datafeed performs after a market close.
  let end = Math.floor(Date.now() / 1000);
  const d = new Date(end * 1000);
  const day = d.getUTCDay(); // 0 Sunday … 6 Saturday
  if (day === 6 || day === 0) {
    const daysBack = day === 6 ? 1 : 2;
    end = Math.floor(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysBack, 23, 59, 0) / 1000,
    );
  }
  return Array.from({ length: 200 }, (_, i) => {
    const time = end - (200 - i) * 60;
    const open = base + Math.sin(i / 8) * 0.002;
    return {
      time,
      open,
      high: open + 0.0008,
      low: open - 0.0008,
      close: open + 0.0002,
      volume: 100,
    };
  });
}

/**
 * Opt-in LIVE stream mock for specs that exercise chart trading.
 *
 * The default fixture closes every WebSocket, which is the right posture for
 * the resilience specs — but TradingView only enables chart/DOM trading while
 * the broker reports Connected, and the broker's connection state mirrors the
 * account/positions/orders streams. Registering this AFTER the fixture's
 * routes (Playwright gives the most recent registration precedence) replaces
 * the close-everything handler with one that answers each subscription with
 * the same data the REST snapshots serve. Still nothing leaves the machine:
 * the "server" here is this in-process mock.
 */
export async function installLiveStreams(
  page: Page,
  options: { positions?: () => unknown[] } = {},
): Promise<void> {
  const positions = options.positions ?? (() => POSITIONS);
  await page.routeWebSocket(/\/ws/, (ws) => {
    const url = new URL(ws.url());
    const tp = url.searchParams.get('TP');
    const methodtype = url.searchParams.get('methodtype') ?? '';
    const symbol = url.searchParams.get('symbol') ?? 'EURUSD';
    const isGold = symbol.startsWith('XAUUSD');

    const frame = (): unknown => {
      switch (tp) {
        case '3':
          return ACCOUNT_STATE;
        case '2':
          return positions();
        case '4':
          return ORDERS;
        case '1':
          if (methodtype === 'GetQuotes') {
            return [
              {
                symbolname: symbol,
                status: 'Ok',
                bid: isGold ? 2400.5 : 1.1,
                ask: isGold ? 2400.8 : 1.1002,
                lastprice: isGold ? 2400.6 : 1.1001,
                volume: 10,
              },
            ];
          }
          return bars(isGold ? 2400 : 1.1).slice(-1);
        case '5':
          return bars(isGold ? 2400 : 1.1).slice(-1);
        default:
          return [];
      }
    };

    // The real gateway pushes on a 3s cadence; 2s keeps every stream inside
    // the client's 12s staleness window with margin.
    ws.send(JSON.stringify(frame()));
    const timer = setInterval(() => ws.send(JSON.stringify(frame())), 2_000);
    ws.onClose(() => clearInterval(timer));
  });
}

export const test = base.extend<{ gateway: GatewayFixture }>({
  gateway: async ({ page }, use) => {
    const state = {
      trades: [] as RecordedTrade[],
      tradeResponse: {
        Order: '99001',
        ResultRetcode: '10009',
        Comment: 'Request executed',
      } as unknown,
      tradeStatus: 200,
      alerts: [] as AlertRecord[],
      loginCount: 0,
    };

    await installGatewayRoutes(page, state);

    await use({
      trades: state.trades,
      setTradeResponse: (response, status = 200) => {
        state.tradeResponse = response;
        state.tradeStatus = status;
      },
      authLogins: () => state.loginCount,
    });
  },
});

import { expect } from '@playwright/test';

export { expect };

/** Signs in through the app's own form using the intercepted CRM flow. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill('trader@example.test');
  await page.getByLabel('Password').fill('not-a-real-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('header', { timeout: 30_000 });
}

/**
 * Switches trading account through the header picker.
 *
 * The picker used to be a native `<select>`, so specs drove it with
 * `selectOption`. It is a searchable listbox now (MED-18): open it, type
 * enough of the login to isolate the account, and press Enter.
 */
export async function switchAccount(page: Page, login: string): Promise<void> {
  await page.getByLabel('Select trading account').click();
  const search = page.getByLabel('Search accounts');
  await search.fill(login);
  await page
    .getByRole('option', { name: new RegExp(login) })
    .first()
    .click();
  await expect(page.getByLabel('Select trading account')).toContainText(login, {
    timeout: 30_000,
  });
}
