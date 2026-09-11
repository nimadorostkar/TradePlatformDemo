import { expect, signIn, test } from './fixtures/gateway';

/**
 * When history never arrives the pane must SAY so and offer a retry that
 * repaints in place — never a silent blank canvas, never a page reload.
 */

const STALL_PATTERNS = ['**/api/Tick/getHistoryby1Dresolution**', '**/api/Tick/get?**'];

test.describe('history stall surfaces a recoverable error, never a blank pane', () => {
  test('stalled history shows the error panel; Try again repaints in place', async ({
    page,
    gateway,
  }) => {
    void gateway;
    test.setTimeout(120_000);

    // Stall BEFORE the terminal boots so the very first page request hangs.
    const pending: Array<() => void> = [];
    for (const pattern of STALL_PATTERNS) {
      await page.route(pattern, (route) => {
        pending.push(() => route.abort('timedout').catch(() => {}));
      });
    }

    await signIn(page);

    // History timeout + one retry with backoff + rendering margin.
    await expect(page.getByText('The chart could not be loaded')).toBeVisible({ timeout: 30_000 });
    const retry = page.getByRole('button', { name: /try again/i });
    await expect(retry).toBeVisible();

    // The endpoint recovers; the trader clicks retry — no reload involved.
    for (const pattern of STALL_PATTERNS) await page.unroute(pattern);
    for (const abort of pending) abort();
    const reloads: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) reloads.push(frame.url());
    });

    await retry.click();

    await expect(page.getByTestId('chart-legend').first()).toContainText(/\d+\.\d+/, {
      timeout: 20_000,
    });
    expect(reloads, 'Retry must not reload the page').toEqual([]);
  });
});
