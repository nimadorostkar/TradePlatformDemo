import { expect, signIn, test } from './fixtures/gateway';

/**
 * Acceptance checks for the three launch blockers in the 2026-08-24 readiness
 * report. They encode the report's own measurements as assertions so the
 * regressions they describe cannot quietly return.
 */

test.describe('BLK-02: no horizontal document scroll on a phone', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1600) > 500, 'phone viewports only');

  test('every mobile tab keeps the document at viewport width', async ({ page, gateway }) => {
    void gateway;
    await signIn(page);

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();

    for (const tab of ['Markets', 'Chart', 'Trade', 'Positions', 'Account']) {
      await nav.getByRole('button', { name: tab }).click();
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      // The report measured scrollWidth 920 on a 390 px phone. The document
      // must never be wider than the viewport; the header scrolls internally.
      expect(widths.scroll, `${tab} tab stretches the document`).toBeLessThanOrEqual(widths.client);
    }
  });
});

test.describe('BLK-03: the 768–1024 band gets the single-column shell', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1600) < 1000, 'desktop browser project only');

  test('iPad-portrait width renders the mobile shell, not a crushed desktop', async ({
    page,
    gateway,
  }) => {
    void gateway;
    await page.setViewportSize({ width: 820, height: 1180 });
    await signIn(page);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  });

  test('1024 px still renders the desktop shell', async ({ page, gateway }) => {
    void gateway;
    await page.setViewportSize({ width: 1024, height: 768 });
    await signIn(page);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    // The dock floors may push total minimums past 1024, but the shell itself
    // must not stretch the document.
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  });
});

test.describe('BLK-01: watchlist symbol names survive a narrow window', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1600) < 1000, 'desktop browser project only');

  test('at 1100 px every symbol name renders in full', async ({ page, gateway }) => {
    void gateway;
    await page.setViewportSize({ width: 1100, height: 800 });
    await signIn(page);

    // The default layout docks the watchlist on the left.
    const names = page.locator('.watchlist-root [role="row"] span.truncate.font-medium');
    await expect(names.first()).toBeVisible();
    const measured = await names.evaluateAll((spans) =>
      spans.map((s) => ({
        text: s.textContent,
        truncated: s.scrollWidth > s.clientWidth,
        title: s.getAttribute('title'),
      })),
    );
    expect(measured.length).toBeGreaterThan(0);
    for (const m of measured) {
      // The report saw USDJPY and USDCAD both render as "US…". Never again.
      expect(m.truncated, `${m.text} is truncated`).toBe(false);
      // And even if a future layout squeezes it, the tooltip names the row.
      expect(m.title).toBe(m.text);
    }
  });
});
