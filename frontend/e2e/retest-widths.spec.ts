import { expect, signIn, test } from './fixtures/gateway';

/**
 * The 2026-08-25 re-test's regression matrix: no horizontal document scroll at
 * 332/353/915/986 px, and full symbol names down to 332 px. These passed in
 * that audit and must keep passing.
 */
test.describe('re-test width matrix', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'viewport is set explicitly');

  for (const width of [332, 353, 915, 986]) {
    test(`no horizontal scroll and readable symbols at ${width}px`, async ({ page, gateway }) => {
      void gateway;
      await page.setViewportSize({ width, height: 700 });
      await signIn(page);

      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect(nav).toBeVisible();
      await nav.getByRole('button', { name: 'Markets' }).click();

      const names = page.locator('.watchlist-root [role="row"] span.truncate.font-medium');
      await expect(names.first()).toBeVisible();

      const result = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(result.scroll, 'document must not scroll sideways').toBeLessThanOrEqual(result.client);

      const measured = await names.evaluateAll((spans) =>
        spans.map((s) => ({ t: s.textContent, truncated: s.scrollWidth > s.clientWidth })),
      );
      expect(measured.length).toBeGreaterThan(0);
      for (const m of measured) {
        expect(m.truncated, `${m.t} truncated at ${width}px`).toBe(false);
      }
    });
  }
});
