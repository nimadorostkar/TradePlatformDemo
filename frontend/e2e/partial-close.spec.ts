import { expect, installLiveStreams, signIn, test } from './fixtures/gateway';

/**
 * Partial close — the gap the launch-readiness report could not exercise.
 *
 * QA's note: "the dialog supports it, but a 0.01-lot position is already the
 * minimum, so a fractional close could not be exercised. Needs a position of
 * 0.05 lots or more." Real money cannot be put on the table to prove a UI
 * behaves, and would not be a repeatable test if it were: the fixture holds a
 * 1.00-lot position, so the whole path can be driven here instead — including
 * the payload that would have reached the trading server.
 *
 * Every route is intercepted; /api/Trade/send_request is recorded and never
 * forwarded.
 */

test.describe('closing part of a position', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop dock layout only');

  test.beforeEach(async ({ page, gateway }) => {
    void gateway;
    await installLiveStreams(page);
    await signIn(page);
    await page.getByRole('tab', { name: 'Positions', exact: true }).click();
  });

  test('states the size it can close and what would remain', async ({ page }) => {
    await page.getByRole('button', { name: /close position 30001/i }).click();

    // The dialog must say what the limits ARE, not merely reject a bad number.
    await expect(page.getByText(/max 1/i)).toBeVisible();
    // Opens on the whole position, so the default action is the common one.
    await expect(page.getByLabel(/volume to close/i)).toHaveValue('1');
    await expect(page.getByText(/closes the entire position/i)).toBeVisible();
  });

  test('sends the PART that was asked for, on the opposite side', async ({ page, gateway }) => {
    await page.getByRole('button', { name: /close position 30001/i }).click();

    await page.getByLabel(/volume to close/i).fill('0.25');
    await expect(page.getByText(/0\.75 lots will remain open/i)).toBeVisible();

    await page.getByRole('button', { name: 'Close position', exact: true }).click();
    await expect.poll(() => gateway.trades.length, { timeout: 15_000 }).toBe(1);

    const body = gateway.trades[0]!.body;
    // 0.25 lots in MT5's 1/10000-lot units, and a SELL against the long —
    // MT5 nets it against the open position rather than opening a second one.
    expect(body).toMatchObject({ symbol: 'EURUSD', volume: 2500 });
    expect(String(body.type)).toBe('1');
    expect(body.position ?? body.positionId ?? body.Position).toBeTruthy();
  });

  test('refuses a size off the instrument’s volume step', async ({ page, gateway }) => {
    await page.getByRole('button', { name: /close position 30001/i }).click();

    // 0.995 is not a multiple of 0.01. Note this is also why the dialog's
    // "would leave an uncloseable scrap" guard cannot fire on EURUSD: its
    // minimum EQUALS its step, so any on-step close leaves an on-step
    // remainder. That guard is for instruments whose minimum exceeds their
    // step, and is covered by the unit tests rather than here.
    await page.getByLabel(/volume to close/i).fill('0.995');

    await expect(page.getByText(/multiple of 0\.01/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close position', exact: true })).toBeDisabled();
    expect(gateway.trades).toHaveLength(0);
  });

  test('refuses a size the position does not hold', async ({ page, gateway }) => {
    await page.getByRole('button', { name: /close position 30001/i }).click();
    await page.getByLabel(/volume to close/i).fill('2');

    await expect(page.getByRole('button', { name: 'Close position', exact: true })).toBeDisabled();
    expect(gateway.trades).toHaveLength(0);
  });
});
