import type { FrameLocator, Page } from '@playwright/test';
import {
  CHART_LIBRARY_PRESENT,
  CHART_LIBRARY_SKIP_REASON,
  expect,
  installLiveStreams,
  signIn,
  switchAccount,
  test,
} from './fixtures/gateway';

/**
 * TradingView chart trading: context-menu orders, instant placement, and the
 * built-in DOM.
 *
 * These specs drive the REAL licensed library against the mocked gateway. The
 * fixture records every trade mutation, so each spec can assert not just that
 * an order went out, but that it went out ONCE, with the exact price the user
 * clicked — the properties that make instant placement safe with real money.
 *
 * TradingView persistence used to arrange the UI before load:
 *   - `tradingview.trading.chart.proterty` `{"noConfirmEnabled":1}` is the
 *     "Instant orders placement" setting (verified against the library's
 *     settings storage).
 *   - `tradingview.trading.tradingPanelOpened` / `…tradingPanelActivePage`
 *     open the trading panel on its DOM page.
 */

const CHART_IFRAME = 'iframe[title="Financial Chart"]';

function chartFrame(page: Page): FrameLocator {
  return page.frameLocator(CHART_IFRAME);
}

/** Collects uncaught page errors; specs assert none occurred. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function openTradableChart(page: Page): Promise<FrameLocator> {
  await signIn(page);
  const frame = chartFrame(page);
  await expect(frame.locator('.chart-gui-wrapper').first()).toBeVisible({ timeout: 60_000 });
  // The Trade button renders once the broker adapter reports Connected.
  await expect(frame.locator('[data-name="trade-panel-button"]').first()).toBeVisible({
    timeout: 30_000,
  });
  // Give the trading side a beat to take its first quote snapshot; the
  // context-menu actions are hidden until it exists.
  await page.waitForTimeout(2_000);
  return frame;
}

/**
 * Right-clicks the chart and opens the Trade submenu. Returns the Buy action
 * item (e.g. "Buy 0.01 XAUUSD @ 1,168.90 limit") without clicking it.
 */
async function openChartBuyAction(page: Page, frame: FrameLocator) {
  // Proportional, not a magic pixel: where the market sits in the pane
  // depends on how the auto-scale fits the fixture's bars, so no fixed y is
  // reliably above OR below it. The upper third is dependably AWAY from the
  // market for any sane scale — which side is irrelevant to the callers: they
  // assert pending-order mechanics (kind + price), not the direction of the
  // offset.
  const canvas = frame.locator('.chart-gui-wrapper canvas').last();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('chart canvas has no bounding box');
  await canvas.click({
    button: 'right',
    position: { x: Math.round(box.width * 0.4), y: Math.round(box.height * 0.3) },
  });

  const tradeEntry = frame
    .locator('[class*="menuWrap"]')
    .locator('div, tr')
    .filter({ hasText: /^\s*Trade\s*$/ })
    .last();
  await tradeEntry.hover();

  const buyAction = frame
    .locator('[class*="menuWrap"]')
    .locator('div, tr')
    .filter({ hasText: /^\s*Buy .*XAUUSD.*(limit|stop)\s*$/ })
    .last();
  await expect(buyAction).toBeVisible({ timeout: 10_000 });
  return buyAction;
}

/** Parses "Buy 0.01 XAUUSD @ 1,168.90 limit" → { price: 1168.9, kind: "limit" }. */
function parseActionLabel(label: string): { price: number; kind: 'limit' | 'stop' } {
  const match = /@\s*([\d,]+(?:\.\d+)?)\s*(limit|stop)/i.exec(label);
  if (!match) throw new Error(`Unparseable trade action label: ${label}`);
  return { price: Number(match[1]!.replace(/,/g, '')), kind: match[2]!.toLowerCase() as never };
}

test.describe('chart context-menu trading', () => {
  test.skip(!CHART_LIBRARY_PRESENT, CHART_LIBRARY_SKIP_REASON);
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop chart trading only');

  test('instant OFF: chart Buy opens the Order Ticket and nothing is sent before confirmation', async ({
    page,
    gateway,
  }) => {
    test.setTimeout(120_000);
    const pageErrors = trackPageErrors(page);
    await installLiveStreams(page);
    const frame = await openTradableChart(page);

    const buyAction = await openChartBuyAction(page, frame);
    const { price, kind } = parseActionLabel((await buyAction.innerText()).replace(/\n/g, ' '));
    // A PENDING kind — limit or stop by which side of the market the click
    // landed on; either proves the context menu offered a priced order.
    expect(['limit', 'stop']).toContain(kind);
    await buyAction.click();

    // The Order Ticket opens, pre-filled — and NO mutation has left the app.
    const placeButton = frame.locator('[data-name="place-and-modify-button"]');
    await expect(placeButton).toBeVisible({ timeout: 15_000 });
    await expect(placeButton).toContainText(/Buy/i);
    expect(gateway.trades).toHaveLength(0);

    // Confirming submits exactly one correctly-priced pending order.
    await placeButton.click();
    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(1);
    const body = gateway.trades[0]!.body;
    expect(body).toMatchObject({ login: '1001', source: 'tv' });
    expect(String(body.symbol)).toMatch(/^XAUUSD/);
    expect(Number(body.priceOrder)).toBeCloseTo(price, 2);

    // Still exactly one after settling — no duplicate, no retry.
    await page.waitForTimeout(2_000);
    expect(gateway.trades).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  });

  test('instant ON: chart Buy submits once at the clicked price without any ticket', async ({
    page,
    gateway,
  }) => {
    test.setTimeout(120_000);
    const pageErrors = trackPageErrors(page);
    await installLiveStreams(page);
    // TradingView's own "Instant orders placement" setting — enabled exactly
    // as the settings dialog would persist it. The app never flips this.
    await page.addInitScript(() => {
      localStorage.setItem('tradingview.trading.chart.proterty', '{"noConfirmEnabled":1}');
    });
    const frame = await openTradableChart(page);

    const buyAction = await openChartBuyAction(page, frame);
    const { price } = parseActionLabel((await buyAction.innerText()).replace(/\n/g, ' '));
    await buyAction.click();

    // Immediate submission: one pending order at the tick-normalized price
    // where the context menu was opened.
    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(1);
    const body = gateway.trades[0]!.body;
    expect(String(body.symbol)).toMatch(/^XAUUSD/);
    expect(Number(body.priceOrder)).toBeCloseTo(price, 2);

    // No Order Ticket appeared, and no second request followed.
    await page.waitForTimeout(2_000);
    expect(gateway.trades).toHaveLength(1);
    await expect(frame.locator('[data-name="place-and-modify-button"]')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});

test.describe('boot with the trading panel restored', () => {
  test.skip(!CHART_LIBRARY_PRESENT, CHART_LIBRARY_SKIP_REASON);
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop chart trading only');

  test('the chart still becomes ready and renders series data', async ({ page, gateway }) => {
    void gateway;
    test.setTimeout(120_000);
    const pageErrors = trackPageErrors(page);
    await installLiveStreams(page);
    // The production wedge trigger (2026-08-14): the library's trading panel
    // (DOM page) restored open at widget initialisation. Live boots in this
    // state could stall the chart silently; the ready watchdog recovers them.
    // This canary pins the healthy path: booting this way must still produce
    // a ready chart with real series data.
    await page.addInitScript(() => {
      localStorage.setItem('tradingview.trading.tradingPanelOpened', 'true');
      localStorage.setItem('tradingview.trading.tradingPanelActivePage', '"domPanel"');
    });
    const frame = await openTradableChart(page);

    // Series data reached the pane: the legend shows the symbol with a real
    // close value, not the empty-state placeholder.
    const legend = frame.locator('[data-name="legend-series-item"]').first();
    await expect(legend).toContainText('Gold vs US Dollar', { timeout: 30_000 });
    // A real close price in the legend proves the series pipeline completed —
    // the wedge left it valueless while the rest of the app ran normally.
    await expect(legend).toContainText('2,400', { timeout: 30_000 });
    await expect(frame.locator('text=No data here')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});

test.describe('chart context-menu activation', () => {
  test.skip(!CHART_LIBRARY_PRESENT, CHART_LIBRARY_SKIP_REASON);
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop chart trading only');

  /**
   * A trading action that silently does nothing is the worst outcome on this
   * surface — the trader cannot tell whether they traded. The reported failure
   * was a first click being swallowed when it arrives before the item is
   * highlighted, blamed on activation being bound to a hover-driven highlight.
   *
   * It does not reproduce: the click is dispatched straight to the item with no
   * mouseenter and no pointer movement, and the ticket still opens. Kept so
   * that if the library ever DOES bind activation to hover, this fails.
   */
  test('a Trade submenu item activates without ever being hovered', async ({ page, gateway }) => {
    test.setTimeout(120_000);
    await installLiveStreams(page);
    const frame = await openTradableChart(page);
    const buyAction = await openChartBuyAction(page, frame);

    await buyAction.dispatchEvent('mousedown');
    await buyAction.dispatchEvent('mouseup');
    await buyAction.dispatchEvent('click');

    // Instant placement is off here, so the ticket opening IS the activation —
    // and nothing may reach the server before it is confirmed.
    await expect(frame.locator('[data-name="place-and-modify-button"]')).toBeVisible({
      timeout: 15_000,
    });
    expect(gateway.trades).toHaveLength(0);
  });
});

test.describe('chart trading after an account switch', () => {
  test.skip(!CHART_LIBRARY_PRESENT, CHART_LIBRARY_SKIP_REASON);
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop chart trading only');

  /**
   * Switches to account 1002 (Standard group, "!" suffix — account 1001 is
   * ECN "."). The switch changes the whole symbol dialect, so these specs
   * prove the broker reconnects for the NEW account and speaks its suffix.
   */
  async function switchToStandardAccount(page: Page, frame: FrameLocator): Promise<void> {
    await switchAccount(page, '1002');
    // The broker tears down and reconnects for the new account; the Trade
    // button re-renders once it reports Connected again.
    await expect(frame.locator('[data-name="trade-panel-button"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(3_000);
  }

  test('instant OFF: the ticket flow works and the order speaks the NEW account suffix', async ({
    page,
    gateway,
  }) => {
    test.setTimeout(150_000);
    const pageErrors = trackPageErrors(page);
    await installLiveStreams(page);
    const frame = await openTradableChart(page);
    await switchToStandardAccount(page, frame);

    const buyAction = await openChartBuyAction(page, frame);
    const { price } = parseActionLabel((await buyAction.innerText()).replace(/\n/g, ' '));
    await buyAction.click();

    const placeButton = frame.locator('[data-name="place-and-modify-button"]');
    await expect(placeButton).toBeVisible({ timeout: 15_000 });
    expect(gateway.trades).toHaveLength(0);

    await placeButton.click();
    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(1);
    const body = gateway.trades[0]!.body;
    // Account 1002 is a Standard-group login: the gateway symbol MUST carry
    // the "!" suffix. The previous account's "." dialect leaking through here
    // is exactly the "no prices / wrong symbol" class of failure.
    expect(body.symbol).toBe('XAUUSD!');
    expect(body.login).toBe('1002');
    expect(Number(body.priceOrder)).toBeCloseTo(price, 2);

    await page.waitForTimeout(2_000);
    expect(gateway.trades).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  });

  test('instant ON: one immediate submission for the new account, no ticket', async ({
    page,
    gateway,
  }) => {
    test.setTimeout(150_000);
    const pageErrors = trackPageErrors(page);
    await installLiveStreams(page);
    await page.addInitScript(() => {
      localStorage.setItem('tradingview.trading.chart.proterty', '{"noConfirmEnabled":1}');
    });
    const frame = await openTradableChart(page);
    await switchToStandardAccount(page, frame);

    const buyAction = await openChartBuyAction(page, frame);
    const { price } = parseActionLabel((await buyAction.innerText()).replace(/\n/g, ' '));
    await buyAction.click();

    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(1);
    const body = gateway.trades[0]!.body;
    expect(body.symbol).toBe('XAUUSD!');
    expect(body.login).toBe('1002');
    expect(Number(body.priceOrder)).toBeCloseTo(price, 2);

    await page.waitForTimeout(2_000);
    expect(gateway.trades).toHaveLength(1);
    await expect(frame.locator('[data-name="place-and-modify-button"]')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});

test.describe('TradingView DOM trading', () => {
  test.skip(!CHART_LIBRARY_PRESENT, CHART_LIBRARY_SKIP_REASON);
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop chart trading only');

  /** Opens the app with the DOM panel visible and instant placement ON. */
  async function openDom(page: Page): Promise<FrameLocator> {
    await installLiveStreams(page);
    await page.addInitScript(() => {
      localStorage.setItem('tradingview.trading.chart.proterty', '{"noConfirmEnabled":1}');
      localStorage.setItem('tradingview.trading.tradingPanelOpened', 'true');
      localStorage.setItem('tradingview.trading.tradingPanelActivePage', '"domPanel"');
    });
    const frame = await openTradableChart(page);
    // The ladder is populated by the broker adapter's subscribeDOM polling;
    // its totals row appears once the first snapshot lands.
    await expect(frame.locator('[class*="tv-dom-widget-main__row"]').first()).toBeVisible({
      timeout: 20_000,
    });
    return frame;
  }

  /** The ladder row whose price cell shows `price` exactly. */
  function ladderRow(frame: FrameLocator, price: string) {
    return frame.locator('[class*="tv-dom-widget-main__row"]').filter({ hasText: price }).first();
  }

  /**
   * Scrolls the ladder until the row for `price` is visible. The DOM renders
   * one row per tick around the mid, so off-window levels need wheel scrolls
   * (positive delta reveals lower prices).
   */
  async function scrollLadderTo(
    page: Page,
    frame: FrameLocator,
    price: string,
    delta: number,
  ): Promise<void> {
    // Hover a rendered row — the container's class prefix also matches the
    // widget's hidden offscreen arrows, which cannot be hovered.
    await frame.locator('[class*="tv-dom-widget-main__row"]').first().hover();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (
        await ladderRow(frame, price)
          .isVisible()
          .catch(() => false)
      )
        return;
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(120);
    }
    throw new Error(`Ladder row for ${price} did not come into view`);
  }

  test('DOM Limit and Stop submit immediately at the exact clicked level', async ({
    page,
    gateway,
  }) => {
    test.setTimeout(120_000);
    const pageErrors = trackPageErrors(page);
    const frame = await openDom(page);

    // Buy column click BELOW the market → Buy Limit at exactly that level.
    await scrollLadderTo(page, frame, '2,400.25', 240);
    await ladderRow(frame, '2,400.25').locator('[class*="value--buy"]').click();
    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(1);
    expect(Number(gateway.trades[0]!.body.priceOrder)).toBeCloseTo(2400.25, 2);
    expect(String(gateway.trades[0]!.body.symbol)).toMatch(/^XAUUSD/);
    // MT5 type 2 = buy limit.
    expect(Number(gateway.trades[0]!.body.type)).toBe(2);

    // Stop orders come from the ladder cell's own context menu: right-click
    // the buy column ABOVE the market and take the "stop" action.
    await scrollLadderTo(page, frame, '2,401.25', -240);
    await ladderRow(frame, '2,401.25').locator('[class*="value--buy"]').click({ button: 'right' });
    const stopAction = frame
      .locator('[class*="menuWrap"]')
      .locator('div, tr')
      .filter({ hasText: /Buy.*2,401\.25.*stop/i })
      .last();
    await expect(stopAction).toBeVisible({ timeout: 10_000 });
    await stopAction.click();
    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(2);
    expect(Number(gateway.trades[1]!.body.priceOrder)).toBeCloseTo(2401.25, 2);
    // MT5 type 4 = buy stop.
    expect(Number(gateway.trades[1]!.body.type)).toBe(4);

    await page.waitForTimeout(2_000);
    expect(gateway.trades).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  });

  test('DOM Market buy uses the ask and sell uses the bid', async ({ page, gateway }) => {
    test.setTimeout(120_000);
    const pageErrors = trackPageErrors(page);
    const frame = await openDom(page);

    await frame
      .locator('button')
      .filter({ hasText: /^Buy Mkt$/ })
      .click();
    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(1);
    // Ask, never bid or last — the fixture quotes XAUUSD at 2400.50/2400.80.
    expect(Number(gateway.trades[0]!.body.priceOrder)).toBeCloseTo(2400.8, 2);
    expect(gateway.trades[0]!.body).toMatchObject({ action: '200', type: 0 });

    await frame
      .locator('button')
      .filter({ hasText: /^Sell Mkt$/ })
      .click();
    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(2);
    expect(Number(gateway.trades[1]!.body.priceOrder)).toBeCloseTo(2400.5, 2);
    expect(gateway.trades[1]!.body).toMatchObject({ action: '200', type: 1 });

    await page.waitForTimeout(2_000);
    expect(gateway.trades).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  });
});
