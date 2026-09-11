import { expect, installLiveStreams, signIn, test } from './fixtures/gateway';

/**
 * An alert that has FIRED — the other gap the report could not exercise.
 *
 * QA's note: "an alert was created and deleted, but not held until the market
 * reached its level, so the notification path is unverified." Holding a real
 * alert until a real market crosses it is not a repeatable test. The trading
 * server owns alert state and the terminal only reports it, so the honest
 * equivalent is to have the server say an alert fired and check what the
 * trader is then shown.
 *
 * Worth stating plainly, because it IS the notification path: a fired alert
 * surfaces in the Alerts panel — warning badge, the time it fired, and the
 * price that crossed it — and nowhere else. There is no toast and no sound.
 * The panel says alerts "keep working after you close this tab", which is
 * true of the SERVER-side alert; the notice waits for the trader to look.
 */

const FIRED_AT = '2026-08-24T15:43:11.000Z';

test.describe('an alert that has fired', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop dock layout only');

  test('is shown as triggered, with the time and the price that crossed it', async ({
    page,
    gateway,
  }) => {
    void gateway;
    await installLiveStreams(page);

    // The shared fixture reports no broker offset, so times would render in
    // plain UTC and the conversion would go untested. This deployment's broker
    // runs UTC+3, so say so and assert the clock the trader actually sees.
    await page.route('**/api/Test/getServerTime**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          unixTimestamp: String(Math.floor(Date.now() / 1000)),
          brokerOffsetSeconds: 10800,
        }),
      }),
    );

    // Registered after the fixture's own handler, so it takes precedence.
    await page.route('**/api/Alert/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: '9001',
              login: '1001',
              symbol: 'EURUSD',
              condition: 'above',
              price: 1.101,
              note: 'breakout watch',
              status: 'triggered',
              createdAt: '2026-08-24T09:00:00.000Z',
              triggeredAt: FIRED_AT,
              triggeredPrice: 1.10125,
            },
          ],
          success: true,
        }),
      }),
    );

    await signIn(page);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByPlaceholder('Search panels, layouts, symbols…').fill('Open Price Alerts');
    await page.locator('#command-list').getByRole('option').first().click();

    const alerts = page.getByRole('tabpanel', { name: 'Alerts' });
    await expect(alerts.getByText('Triggered')).toBeVisible();
    await expect(alerts.getByText(/breakout watch/i)).toBeVisible();
    // Broker time (UTC+3), big-endian, matching every other stamped time in
    // the product — 15:43:11Z is 18:43:11 on the broker's clock.
    await expect(alerts.getByText(/2026-08-24 18:43:11/)).toBeVisible();
    // The crossing price, not the level: it shows how far past it went — and
    // at EURUSD's own five digits, though gold is the active symbol. Rendered
    // with the active symbol's precision this read "at 1.10", which is a
    // different number from the one that fired (2026-08-26).
    await expect(alerts.getByText(/at 1\.10125/)).toBeVisible();
    // The LEVEL is the trader's own number and must survive intact too.
    await expect(alerts.getByText(/≥\s*1\.10100/)).toBeVisible();
  });
});
