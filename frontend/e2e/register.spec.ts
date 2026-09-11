import { expect, test } from './fixtures/gateway';

/**
 * Self-service registration: a visitor creates a demo account on the sign-in
 * screen and lands in the terminal signed in with it. The CRM's register
 * endpoint is mocked like every other upstream; the sign-in that follows
 * runs through the gateway fixture.
 */
test.describe('registration', () => {
  test('creates a demo account and signs in with it', async ({ page, gateway }) => {
    void gateway;
    const registrations: unknown[] = [];
    await page.route('**/client-api/register', async (route) => {
      registrations.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        json: { id: 42, email: 'new@example.test', name: 'New Trader', accounts: [100042] },
      });
    });

    await page.goto('/');
    await page.getByRole('button', { name: /create a demo account/i }).click();
    await expect(page.getByText(/create your .* demo account/i)).toBeVisible();

    await page.getByLabel('Name').fill('New Trader');
    await page.getByLabel('Email').fill('new@example.test');
    await page.getByLabel('Password').fill('longenough1');
    await page.getByRole('button', { name: 'Create demo account' }).click();

    await page.waitForSelector('header', { timeout: 30_000 });
    expect(registrations).toEqual([
      { email: 'new@example.test', password: 'longenough1', name: 'New Trader' },
    ]);
  });

  test('shows the CRM refusal without leaving the form', async ({ page, gateway }) => {
    void gateway;
    await page.route('**/client-api/register', (route) =>
      route.fulfill({ status: 409, json: { error: 'email already registered' } }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: /create a demo account/i }).click();
    await page.getByLabel('Email').fill('taken@example.test');
    await page.getByLabel('Password').fill('longenough1');
    await page.getByRole('button', { name: 'Create demo account' }).click();

    await expect(page.getByRole('alert')).toContainText(/already registered/i);
    await expect(page.getByRole('button', { name: 'Create demo account' })).toBeVisible();
  });
});
