import type { Page } from '@playwright/test';
import { expect, installLiveStreams, signIn, switchAccount, test } from './fixtures/gateway';

/** The command palette's search box, disambiguated from the page's selects. */
function paletteInput(page: Page) {
  return page.getByPlaceholder('Search panels, layouts, symbols…');
}

/**
 * The palette's result rows, scoped to its listbox. A bare `getByRole('option')`
 * would also match the `<option>` elements inside the account and watchlist
 * `<select>`s, which are not clickable.
 */
function paletteOptions(page: Page) {
  return page.locator('#command-list').getByRole('option');
}

/**
 * Terminal shell, workspace, and trading flows.
 *
 * Every gateway call is intercepted by the fixture, so nothing here can reach a
 * real trading server. The trade specs assert the PAYLOAD the app would send.
 */

test.describe('authentication and shell', () => {
  test('signs in and renders the terminal with truthful account values', async ({
    page,
    gateway,
  }) => {
    void gateway;
    await signIn(page);

    await expect(page.getByRole('banner')).toBeVisible();

    // The phone shell keeps the figures in the Account tab, not the header —
    // a 458 px metrics strip is what used to stretch a 390 px phone to a
    // 920 px document (BLK-02). Same truth, different address.
    const mobileNav = page.getByRole('navigation', { name: 'Main navigation' });
    if (await mobileNav.isVisible()) {
      await mobileNav.getByRole('button', { name: 'Account' }).click();
      // The header keeps a hidden copy of the strip, so scope to the tab.
      const summary = page.getByRole('main');
      await expect(summary.getByText('Balance')).toBeVisible();
      await expect(summary.getByText('10,320.00')).toBeVisible();
      await expect(summary.getByText('Equity')).toBeVisible();
      return;
    }
    await expect(page.getByText('Balance')).toBeVisible();
    await expect(page.getByText('10,320.00')).toBeVisible();
    await expect(page.getByText('Equity')).toBeVisible();
  });

  test('rejects a credential passed in the URL', async ({ page, gateway }) => {
    void gateway;
    // A token in the URL leaks into history, referrers, and server logs.
    await page.goto('/?access_token=leaked-token');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('shows a non-connected state when the stream is unavailable', async ({ page, gateway }) => {
    void gateway;
    await signIn(page);

    // The fixture closes every WebSocket, so the header must NOT claim
    // "Connected" — a frozen feed that looks live is the worst failure mode.
    const banner = page.getByRole('banner');
    await expect(banner).not.toContainText('Connected');
  });

  test('renders the chart with candles and no page errors', async ({ page, gateway }) => {
    void gateway;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await signIn(page);

    const pane = page.locator('[data-testid^="chart-pane-"]').first();
    await expect(pane.locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('chart-legend').first()).toContainText(/\d+\.\d+/);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('workspace', () => {
  // Docks, tab strips, and the command palette are desktop-only by design;
  // mobile uses the five-tab model asserted at the bottom of this file.
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop shell only');

  test.beforeEach(async ({ page, gateway }) => {
    void gateway;
    await signIn(page);
  });

  test('collapses and expands the left dock', async ({ page }) => {
    const collapse = page.getByRole('button', { name: /collapse left panel/i }).first();
    if (await collapse.isVisible()) {
      await collapse.click();
      await expect(page.getByRole('button', { name: /expand left panel/i }).first()).toBeVisible();
    }
  });

  test('moves a panel between docks from the command palette', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    await paletteInput(page).fill('Move Watchlist to right');
    await paletteOptions(page).first().click();

    await expect(palette).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Watchlist', exact: true })).toBeVisible();
  });

  test('switches chart layout to two charts', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    await paletteInput(page).fill('two charts, side by side');
    await paletteOptions(page).first().click();

    await expect(page.locator('[data-testid^="chart-pane-"]')).toHaveCount(2);
  });

  test('persists the layout across a reload', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    await paletteInput(page).fill('Density: compact');
    await paletteOptions(page).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

    // Saves are debounced. Wait for the write rather than racing it — this
    // test is about persistence, not about the debounce interval.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('tradeplatform.workspace.v3.default') ?? '{}')
              .density ?? null,
        ),
      )
      .toBe('compact');

    await page.reload();
    // Tokens are held IN MEMORY by design, so a reload requires signing in
    // again. The workspace, by contrast, is persisted and must come back.
    await signIn(page);
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  });

  test('recovers from a corrupt saved layout instead of failing to start', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('tradeplatform.workspace.v3.default', '{{{ not json');
      localStorage.setItem('tradeplatform.workspace.active', 'default');
    });

    await page.reload();
    await signIn(page);

    // The terminal still opens, on the default layout.
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Watchlist', exact: true })).toBeVisible();
  });

  test('switches theme', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: /switch to light theme/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('market data and trading', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop dock layout only');

  test.beforeEach(async ({ page, gateway }) => {
    void gateway;
    // Quotes reach the order ticket over the gateway's /ws stream — the same
    // path production uses — so these specs do not depend on the (licensed,
    // optional) chart library being present.
    await installLiveStreams(page);
    await signIn(page);
  });

  test('searches symbols and selects one', async ({ page }) => {
    await page.getByRole('tab', { name: 'Search', exact: true }).click();
    await page.getByLabel('Search symbols').fill('EUR');
    await expect(page.getByText('Euro vs US Dollar')).toBeVisible();
  });

  test('lists open positions with lot volume, not MT5 units', async ({ page }) => {
    await page.getByRole('tab', { name: 'Positions', exact: true }).click();
    // 10000 MT5 units must display as 1 lot.
    await expect(page.getByRole('button', { name: 'EURUSD' }).first()).toBeVisible();
    await expect(page.getByText('1', { exact: true }).first()).toBeVisible();
  });

  test('lists pending orders', async ({ page }) => {
    await page.getByRole('tab', { name: 'Orders', exact: true }).click();
    await expect(page.getByRole('button', { name: 'XAUUSD' }).first()).toBeVisible();
  });

  test('excludes ledger entries from closed-position history', async ({ page }) => {
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    // The fixture includes a deposit; it must not appear as a closed position.
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('table')).not.toContainText('Deposit');
  });

  test('requires confirmation and sends a correctly-shaped market order', async ({
    page,
    gateway,
  }) => {
    await page.getByRole('tab', { name: 'Order', exact: true }).click();

    await page.getByRole('button', { name: /buy/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(gateway.trades).toHaveLength(0);

    await page.getByRole('button', { name: /place market order/i }).click();

    await expect.poll(() => gateway.trades.length).toBe(1);
    const trade = gateway.trades[0]!;

    // The verified MT5 payload: action 200 (ExecutePosition), type 0 (buy),
    // volume in MT5 units (0.01 lot × 10000), and source=tv.
    expect(trade.body).toMatchObject({
      action: '200',
      login: '1001',
      type: 0,
      volume: 100,
      source: 'tv',
    });
    expect(String(trade.body.symbol)).toMatch(/^XAUUSD/);
  });

  test('never reports an accepted order as filled', async ({ page, gateway }) => {
    void gateway;
    await page.getByRole('tab', { name: 'Order', exact: true }).click();
    await page.getByRole('button', { name: /buy/i }).click();
    await page.getByRole('button', { name: /place market order/i }).click();

    const status = page.getByRole('status');
    await expect(status).toContainText(/accepted by the trading server/i);
    await expect(status).not.toContainText(/filled/i);
  });

  test('surfaces a rejection without retrying', async ({ page, gateway }) => {
    gateway.setTradeResponse({ Order: '0', ResultRetcode: '10019', Comment: 'Not enough money' });

    await page.getByRole('tab', { name: 'Order', exact: true }).click();
    await page.getByRole('button', { name: /buy/i }).click();
    await page.getByRole('button', { name: /place market order/i }).click();

    // Two alerts can legitimately coexist here since HGH-06: the client-side
    // "not enough free margin" estimate AND the server's own rejection. The
    // assertion targets the server's answer specifically.
    await expect(page.getByRole('alert').filter({ hasText: /not enough money/i })).toBeVisible();
    // Exactly one attempt: a trade mutation is never auto-retried.
    await expect.poll(() => gateway.trades.length).toBe(1);
  });

  test('blocks an invalid volume before the confirmation step', async ({ page, gateway }) => {
    await page.getByRole('tab', { name: 'Order', exact: true }).click();

    // Named exactly: the trading grids now carry "Sort by Volume" buttons,
    // so a loose /volume/i matches the header as well as the ticket.
    const volume = page.getByLabel('Volume (lots)');
    await volume.fill('0.015');

    await expect(page.getByText(/multiple of/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /buy/i })).toBeDisabled();
    expect(gateway.trades).toHaveLength(0);
  });
});

test.describe('account switching', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop dock layout only');

  /**
   * A switch clears account-scoped data and refetches, so the panel honestly
   * reports "loading" until the new snapshot lands. Wait that out rather than
   * racing it — the loading state is the correct intermediate, not a failure.
   */
  const settled = { timeout: 20_000 };

  test.beforeEach(async ({ page, gateway }) => {
    void gateway;
    await signIn(page);
  });

  test('does not leak the previous account\u2019s positions', async ({ page }) => {
    // Account 1001 holds a EURUSD position; 1002 holds nothing. A frame or a
    // late response from 1001 must never surface under 1002.
    await page.getByRole('tab', { name: 'Positions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'EURUSD' }).first()).toBeVisible();

    await switchAccount(page, '1002');

    await expect(page.getByText(/loading positions/i)).toHaveCount(0, settled);
    await expect(page.getByText(/no open positions/i)).toBeVisible(settled);
    // Scoped to the positions panel: EURUSD also appears in the watchlist,
    // which is account-independent and must NOT be cleared.
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('clears pending orders across the switch', async ({ page }) => {
    await page.getByRole('tab', { name: 'Orders', exact: true }).click();
    await expect(page.getByRole('button', { name: 'XAUUSD' }).first()).toBeVisible();

    await switchAccount(page, '1002');

    await expect(page.getByText(/no pending orders/i)).toBeVisible(settled);
  });

  test('renews the gateway JWT on every switch, with no console errors', async ({
    page,
    gateway,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // Sign-in itself performs the initial exchange.
    const baseline = gateway.authLogins();

    // Each switch must exchange the CRM token for a REPLACEMENT JWT (the
    // fixture mints a distinct expiry per exchange) BEFORE activating the
    // account — extending expiry and re-checking the target's authorization.
    await switchAccount(page, '1002');
    await expect.poll(() => gateway.authLogins(), { timeout: 15_000 }).toBe(baseline + 1);
    await expect(page.getByLabel('Select trading account')).toContainText('1002', settled);

    await switchAccount(page, '1001');
    await expect.poll(() => gateway.authLogins(), { timeout: 15_000 }).toBe(baseline + 2);
    await expect(page.getByLabel('Select trading account')).toContainText('1001', settled);

    expect(pageErrors).toEqual([]);
  });

  test('restores data when switching back', async ({ page }) => {
    await page.getByRole('tab', { name: 'Positions', exact: true }).click();
    await switchAccount(page, '1002');
    await expect(page.getByText(/no open positions/i)).toBeVisible(settled);

    await switchAccount(page, '1001');
    await expect(page.getByRole('table')).toHaveCount(1, settled);
  });
});

test.describe('capability-gated panels', () => {
  // These render only because the mocked gateway reports it serves them; the
  // same panels must say so plainly on a deployment that does not.
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop dock only');

  test.beforeEach(async ({ page, gateway }) => {
    void gateway;
    await installLiveStreams(page);
    await signIn(page);
  });

  test('shows a tradeable ladder with both sides', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    await paletteInput(page).fill('Open Market Depth');
    await paletteOptions(page).first().click();

    await expect(page.getByRole('tab', { name: 'DOM', exact: true })).toBeVisible();
    const dom = page.getByRole('tabpanel', { name: 'DOM' });

    // Buy and Sell are the columns a trader works orders in; the gateway's OWN
    // volume unit is still stated rather than assumed.
    await expect(dom.getByText('Buy', { exact: true })).toBeVisible();
    await expect(dom.getByText('Sell', { exact: true })).toBeVisible();
    await expect(dom.getByText('volume in lots')).toBeVisible();

    // Book volumes enrich the rows where the venue publishes them.
    await expect(dom.getByText('12', { exact: true })).toBeVisible();
    await expect(dom.getByText('18', { exact: true })).toBeVisible();

    // Market execution sits at the foot, as it does on every ladder.
    await expect(dom.getByRole('button', { name: 'Buy Market' })).toBeVisible();
    await expect(dom.getByRole('button', { name: 'Sell Market' })).toBeVisible();
  });

  test('creates a price alert and lists it', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    await paletteInput(page).fill('Open Price Alerts');
    await paletteOptions(page).first().click();

    await expect(page.getByRole('tab', { name: 'Alerts', exact: true })).toBeVisible();
    const alerts = page.getByRole('tabpanel', { name: 'Alerts' });

    await alerts.locator('#alert-price').fill('1.2000');
    await alerts.locator('#alert-note').fill('Resistance retest');
    await alerts.getByRole('button', { name: 'Alert above' }).click();

    // The created alert comes back from the SERVER list, not from local state,
    // which is the whole point of the panel.
    await expect(alerts.getByText('Active')).toBeVisible();
    await expect(alerts.getByText('Resistance retest')).toBeVisible();

    // Activated by keyboard rather than pointer: it proves the control is
    // reachable without a mouse, which matters because it is a small icon
    // button that used to be revealed only on hover.
    const remove = alerts.getByRole('button', { name: /delete alert/i });
    await remove.focus();
    await expect(remove).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(alerts.getByText('No alerts')).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop keyboard paths only');

  test('the confirmation dialog traps focus and starts on Cancel', async ({ page, gateway }) => {
    void gateway;
    await installLiveStreams(page);
    await signIn(page);
    await page.getByRole('tab', { name: 'Order', exact: true }).click();
    await page.getByRole('button', { name: /buy/i }).click();

    // Focus starts on the SAFE option so a stray Enter cannot place a trade.
    await expect(page.getByRole('button', { name: /^cancel$/i })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('the command palette is reachable and dismissable by keyboard', async ({
    page,
    gateway,
  }) => {
    void gateway;
    await signIn(page);

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile navigation only');

  test('uses the five-tab navigation model', async ({ page, gateway }) => {
    void gateway;
    await signIn(page);

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();
    for (const label of ['Markets', 'Chart', 'Trade', 'Positions', 'Account']) {
      await expect(nav.getByRole('button', { name: label })).toBeVisible();
    }
  });
});
