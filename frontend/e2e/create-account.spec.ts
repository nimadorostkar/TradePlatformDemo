import { expect, signIn, test } from './fixtures/gateway';

/**
 * The way out of a screen that says "no account".
 *
 * These three states are dead ends without it: the visitor is told what they do
 * not have and given nothing to do about it. The first is where a brand-new
 * visitor lands and the second is where they stay, so the button is asserted
 * against the real built app rather than only in unit tests — the states need a
 * session, which is exactly what makes them awkward to check by hand in
 * production.
 */

const CREATE_ACCOUNT_URL = 'https://client.opofinance.com/accounts';

test.describe('no tradable account', () => {
  test('offers Create Account instead of a dead end', async ({ page, gateway }) => {
    void gateway;
    // A profile the CRM knows but with nothing the terminal can trade.
    await page.route('**/client-api/accounts**', (route) => route.fulfill({ json: [] }));

    await page.goto('/');
    await page.getByLabel('Email').fill('trader@example.test');
    await page.getByLabel('Password').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('No tradable account')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible();
  });

  test('sends the visitor to the broker in a new tab', async ({ page, gateway, context }) => {
    void gateway;
    await page.route('**/client-api/accounts**', (route) => route.fulfill({ json: [] }));

    await page.goto('/');
    await page.getByLabel('Email').fill('trader@example.test');
    await page.getByLabel('Password').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible();

    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Create Account' }).click();
    const tab = await opened;

    // A new tab, not a navigation: a signed-in terminal is never replaced.
    expect(tab.url()).toBe(CREATE_ACCOUNT_URL);
    expect(page.url()).not.toBe(CREATE_ACCOUNT_URL);
    await tab.close();
  });
});

test.describe('expired session', () => {
  test('offers Create Account beside signing back in', async ({ page, gateway }) => {
    void gateway;
    await signIn(page);

    // The gateway stops accepting the session while the terminal is OPEN. A
    // reload would not do: with no session at boot the app is signed-out and
    // shows the sign-in screen, which is a different state entirely.
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 401, json: { success: false, message: 'No session.' } }),
    );

    // Nothing is clicked to provoke it. The terminal polls constantly, so the
    // first background request after the route goes on is already a 401 and the
    // expired state follows in well under a second — measured at 653-734ms
    // across six runs.
    //
    // This test used to switch account here, on the reasoning that an explicit
    // action beat waiting on a poll. It was the opposite: the poll produces the
    // state either way, and the switch RACED it. Expiring unmounts the account
    // select, so on a slow runner the teardown won, Playwright retried against
    // a detached element for thirty seconds, and the test failed at its setup
    // having never reached an assertion. That was the CI flake of 2026-08-21.
    await expect(page.getByText('Your session has expired')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible();
  });
});
