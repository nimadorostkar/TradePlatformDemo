import {
  CHART_LIBRARY_PRESENT,
  CHART_LIBRARY_SKIP_REASON,
  expect,
  signIn,
  test,
} from './fixtures/gateway';

/**
 * The datafeed's safety net, proven end to end (2026-08-24 fix-plan, issue 2
 * acceptance criteria): when every history request stalls, the chart must show
 * a visible "Chart data unavailable — Retry" panel within ~15 s (5 s timeout +
 * one bounded retry + margin) instead of an indefinite blank canvas — and the
 * Retry button must repaint the chart WITHOUT a page reload.
 *
 * Routes registered later take precedence in Playwright, so the stall below
 * overrides the fixture's normal history answers until unrouted.
 */

const STALL_PATTERNS = ['**/api/Tick/getHistoryby1Dresolution**', '**/api/Tick/get?**'];

test.describe('history stall surfaces a recoverable error, never a blank pane', () => {
  test.skip(!CHART_LIBRARY_PRESENT, CHART_LIBRARY_SKIP_REASON);
  test('stalled history shows the unavailable panel; Retry repaints in place', async ({
    page,
    gateway,
  }) => {
    void gateway;
    test.setTimeout(120_000);

    // Stall BEFORE the terminal boots so the very first page request hangs.
    const pending: Array<() => void> = [];
    for (const pattern of STALL_PATTERNS) {
      await page.route(pattern, (route) => {
        // Held forever (until the test unroutes); fulfilling would defeat the
        // stall, aborting would fail fast instead of hanging.
        pending.push(() => route.abort('timedout').catch(() => {}));
      });
    }

    await signIn(page);

    // 5 s timeout + one retry with backoff + rendering margin.
    await expect(page.getByText(/Chart data unavailable/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    // The endpoint recovers; the trader clicks Retry — no reload involved.
    for (const pattern of STALL_PATTERNS) await page.unroute(pattern);
    for (const abort of pending) abort();
    const reloads: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) reloads.push(frame.url());
    });

    await page.getByRole('button', { name: 'Retry' }).click();

    const chartFrame = page.frameLocator('iframe[title="Financial Chart"]');
    await expect
      .poll(
        async () => {
          const texts = await chartFrame
            .locator('[class*=valueValue]')
            .allInnerTexts()
            .catch(() => [] as string[]);
          return texts.some((text) => /\d/.test(text));
        },
        { message: 'Retry did not repaint the chart', timeout: 20_000 },
      )
      .toBe(true);

    expect(reloads, 'Retry must not reload the page').toEqual([]);
  });
});
