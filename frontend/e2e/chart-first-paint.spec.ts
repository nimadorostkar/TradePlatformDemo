import { expect, signIn, test } from './fixtures/gateway';

/**
 * A blank chart on a live-money terminal is indistinguishable from a dead one.
 * Every cold boot must paint candles promptly: the pane's legend shows the
 * last bar's OHLC once data is applied, and the canvas the library draws into
 * must exist. Repeated because the original defect was intermittent.
 */

const RELOAD_ITERATIONS = 4;
const PAINT_DEADLINE_MS = 10_000;

test.describe('chart first paint is deterministic', () => {
  test('paints candles within 10s on every one of 4 consecutive loads', async ({
    page,
    gateway,
  }) => {
    void gateway;
    test.setTimeout(RELOAD_ITERATIONS * 30_000);

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    for (let iteration = 0; iteration < RELOAD_ITERATIONS; iteration++) {
      // The mock gateway holds no session cookies, so every iteration is a
      // full sign-in — exactly the cold boot that used to race.
      await signIn(page);

      const pane = page.locator('[data-testid^="chart-pane-"]').first();
      await expect(pane.locator('canvas').first()).toBeVisible({ timeout: PAINT_DEADLINE_MS });
      await expect(page.getByTestId('chart-legend').first()).toContainText(/\d+\.\d+/, {
        timeout: PAINT_DEADLINE_MS,
      });
      await expect(page.getByRole('status')).toHaveCount(0);
    }

    expect(pageErrors).toEqual([]);
  });
});
