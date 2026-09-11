import { expect, installLiveStreams, signIn, test } from './fixtures/gateway';

/**
 * A price alert that fires has to reach the trader.
 *
 * Until this landed it did not: a fired alert appeared in the Alerts panel and
 * nowhere else — no toast, no log entry — so a trader not watching that one
 * panel was never told. For a feature whose entire purpose is to notify, that
 * was the feature missing (found 2026-08-26 while testing the panel itself).
 */

const ACTIVE = {
  id: '9100',
  login: '1001',
  symbol: 'EURUSD',
  condition: 'above',
  price: 1.101,
  note: 'breakout watch',
  status: 'active',
  createdAt: '2026-08-24T09:00:00.000Z',
  triggeredAt: null,
  triggeredPrice: null,
};

const FIRED = {
  ...ACTIVE,
  status: 'triggered',
  triggeredAt: '2026-08-24T15:43:11.000Z',
  triggeredPrice: 1.10125,
};

test.describe('a price alert that fires', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop dock layout only');

  test('announces itself even with the Alerts panel closed', async ({ page, gateway }) => {
    void gateway;
    test.setTimeout(120_000);
    await installLiveStreams(page);

    // The server owns alert state; this is it flipping to triggered.
    let fired = false;
    await page.route('**/api/Alert/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [fired ? FIRED : ACTIVE], success: true }),
      }),
    );

    await signIn(page);

    // Nothing yet: an alert that has not fired must stay quiet.
    await expect(page.getByText('Price alert triggered')).toHaveCount(0);

    fired = true;

    // The watcher polls on the same cadence the panel would have used.
    const toast = page.getByText('Price alert triggered');
    await expect(toast).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/EURUSD ≥ 1\.101 at 1\.10125/)).toBeVisible();
  });

  test('does not re-announce an alert that fired before the trader arrived', async ({
    page,
    gateway,
  }) => {
    void gateway;
    test.setTimeout(120_000);
    await installLiveStreams(page);

    // Already triggered on the very first answer: history, not news. The panel
    // shows it; a toast on every page load would be noise.
    await page.route('**/api/Alert/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [FIRED], success: true }),
      }),
    );

    await signIn(page);
    await page.waitForTimeout(20_000);

    await expect(page.getByText('Price alert triggered')).toHaveCount(0);
  });
});
