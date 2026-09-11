import { expect, installLiveStreams, signIn, test } from './fixtures/gateway';

const SHOTS = process.env.SWEEP_DIR ?? 'test-results/sweep';

/**
 * The save button must show exactly one label in both themes.
 *
 * TradingView's header save button appends a blue "Save" call-to-action when
 * the layout is dirty; with the untitled layouts this terminal uses, that
 * rendered a stacked "Save Save" after every theme change (the change marks
 * the layout dirty, and the workspace store — not TV's save service — is what
 * actually persists it). Hidden via custom_css_url; this pins it.
 */
test.describe('chart save button', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('single label in dark and after switching to light', async ({ page, gateway }) => {
    void gateway;
    test.setTimeout(180_000);
    await installLiveStreams(page);
    await signIn(page);
    await page.getByRole('button', { name: 'Chart', exact: true }).click();
    await page.waitForTimeout(2500);

    const visibleSaveStrings = async () => {
      let count = 0;
      for (const frame of page.frames()) {
        count += await frame
          .evaluate(() => {
            let n = 0;
            for (const el of document.querySelectorAll<HTMLElement>(
              '[class^="saveString-"], [class*=" saveString-"]',
            )) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none') n++;
            }
            return n;
          })
          .catch(() => 0);
      }
      return count;
    };

    expect(await visibleSaveStrings(), 'dark theme').toBe(0);

    await page.getByLabel(/Switch to light theme/).click();
    await page.waitForTimeout(4000);
    expect(await visibleSaveStrings(), 'light theme after switch').toBe(0);
    await page.screenshot({ path: `${SHOTS}/chart-light-fixed.png` });
  });
});
