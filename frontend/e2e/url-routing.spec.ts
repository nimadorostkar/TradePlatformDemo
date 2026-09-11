import { expect, signIn, test } from './fixtures/gateway';

/**
 * HGH-03: the URL carries the active symbol (and phone tab), Back stays
 * inside the product, and unknown paths get a 404 view instead of a full
 * terminal pretending the address was real.
 */

test.describe('URL state', () => {
  test('a shared ?symbol link opens on that symbol', async ({ page, gateway }) => {
    void gateway;
    // Arrive via the shared link and sign in IN PLACE — submitting the form
    // does not navigate, so the link's query string survives into the
    // terminal, exactly as it would for a recipient without a session.
    await page.goto('/?symbol=EURUSD');
    await page.getByLabel('Email').fill('trader@example.test');
    await page.getByLabel('Password').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('header', { timeout: 30_000 });
    await expect
      .poll(
        async () => page.evaluate(() => new URL(window.location.href).searchParams.get('symbol')),
        { timeout: 10_000 },
      )
      .toBe('EURUSD');
  });

  test('unknown paths render a 404 view, not the terminal', async ({ page, gateway }) => {
    void gateway;
    await page.goto('/does-not-exist-xyz');
    await expect(page.getByText('Page not found')).toBeVisible();
    await page.getByRole('button', { name: 'Open the terminal' }).click();
    await page.waitForURL('**/');
  });

  test('phone tabs live in the query string and Back stays in the product', async ({
    page,
    gateway,
    viewport,
  }) => {
    void gateway;
    test.skip((viewport?.width ?? 1600) > 500, 'phone shell only');
    await signIn(page);

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('button', { name: 'Positions' }).click();
    await expect
      .poll(async () => page.evaluate(() => new URL(window.location.href).searchParams.get('tab')))
      .toBe('positions');

    // Back must never eject to about:blank.
    await page.goBack();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  });
});
