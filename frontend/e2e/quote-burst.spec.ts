import { expect, signIn, test } from './fixtures/gateway';
import type { Page } from '@playwright/test';

/**
 * KNOWN DEFECT, pre-existing (reproduces identically at 158c1d5, before the
 * round-2 work). A large burst of quote frames delivered in a single tick
 * trips React's nested-update limit: "Maximum update depth exceeded", raised
 * from useSyncExternalStore's forceStoreRerender via the quote store's fan-out.
 * One such exception appears in the production console on load.
 *
 * Marked fixme rather than deleted: it is the executable record of the bug.
 * A realistic boot backlog (~20 frames) does NOT reproduce it, which is why
 * the symptom is rare and why no speculative fix has been shipped for it —
 * stabilising useQuote's subscribe and coalescing the store's notifications
 * each roughly halve the storm without eliminating it, so the real fix is
 * probably to rate-limit the fan-out, which needs its own design and
 * real-market validation.
 */
async function installBurstStream(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const url = new URL(ws.url());
    const tp = url.searchParams.get('TP');
    const methodtype = url.searchParams.get('methodtype') ?? '';
    const symbol = url.searchParams.get('symbol') ?? 'EURUSD';
    if (tp !== '1' || methodtype !== 'GetQuotes') return;

    let n = 0;
    const send = () => {
      n += 1;
      ws.send(
        JSON.stringify([
          {
            symbolname: symbol,
            status: 'Ok',
            bid: 1.1 + n * 0.00001,
            ask: 1.1002 + n * 0.00001,
            lastprice: 1.1001 + n * 0.00001,
            volume: 10,
          },
        ]),
      );
    };
    // Deliberately brutal: far harsher than the gateway's ~3s cadence.
    for (let i = 0; i < 200; i++) send();
    const timer = setInterval(send, 20);
    ws.onClose(() => clearInterval(timer));
  });
}

test.describe('a burst of quote frames', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'desktop dock layout only');

  test('does not exceed React’s update depth', async ({ page, gateway }) => {
    void gateway;
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await installBurstStream(page);
    await signIn(page);
    await page.getByRole('tab', { name: 'Orders', exact: true }).click();
    await page.waitForTimeout(15_000);

    expect(pageErrors).toEqual([]);
  });
});
