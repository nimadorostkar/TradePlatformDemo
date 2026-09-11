import {
  CHART_LIBRARY_PRESENT,
  CHART_LIBRARY_SKIP_REASON,
  expect,
  signIn,
  test,
} from './fixtures/gateway';

/**
 * Regression: the chart must paint candles on EVERY load, not most of them.
 *
 * The 2026-08-24 empty-chart report: ~2 of 8 cold loads mounted the chart,
 * fetched history successfully, and still showed a permanently blank series —
 * OHLC legend stuck at "∅" for 82+ seconds with no error, no retry, and no
 * further network. A silently empty chart on a trading terminal reads as a
 * market with no data, which is worse than any visible failure.
 *
 * Each iteration is a full reload racing the same async paths (history fetch,
 * broker connect, widget boot) the report implicates. The assertion is the
 * user-visible truth — numeric values in the chart's own OHLC legend — plus
 * console silence from the series-dropped recovery ladder: a load that only
 * painted because the watchdog tore the widget down and rebuilt it is a
 * failing load for this spec's purposes.
 */

const RELOAD_ITERATIONS = 8;
const LEGEND_DEADLINE_MS = 10_000;

test.describe('chart first paint is deterministic', () => {
  test.skip(!CHART_LIBRARY_PRESENT, CHART_LIBRARY_SKIP_REASON);
  test('paints candles within 10s on every one of 8 consecutive loads', async ({
    page,
    gateway,
  }) => {
    void gateway;
    test.setTimeout(RELOAD_ITERATIONS * 30_000);

    const recoveries: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      // The bounded recovery ladder logs before recreating the widget; the
      // held-push warning marks account data racing the connect. Neither may
      // appear on a load this spec calls successful.
      if (text.includes('series-dropped') || text.includes('chart never became ready')) {
        recoveries.push(text);
      }
    });

    for (let iteration = 0; iteration < RELOAD_ITERATIONS; iteration++) {
      // The mock gateway holds no session cookies, so every iteration is a
      // full sign-in — which is exactly the cold boot the report races.
      await signIn(page);

      const chartFrame = page.frameLocator('iframe[title="Financial Chart"]');
      const legendValues = chartFrame.locator('[class*=valueValue]');

      // The legend renders "∅" until the series applies bars. Poll until at
      // least one value is numeric — the exact probe from the bug report.
      await expect
        .poll(
          async () => {
            const texts = await legendValues.allInnerTexts().catch(() => [] as string[]);
            return texts.some((text) => /\d/.test(text));
          },
          {
            message: `load ${iteration + 1}/${RELOAD_ITERATIONS}: OHLC legend never showed numeric values`,
            timeout: LEGEND_DEADLINE_MS,
          },
        )
        .toBe(true);

      expect(
        recoveries,
        `load ${iteration + 1}: the chart only painted via the recovery ladder`,
      ).toEqual([]);

      // The critical path must STAY parallel (2026-08-24 fix-plan, regression
      // test 3): the chart library request must start immediately — never
      // gated behind the auth chain again. Absolute budgets are generous for
      // a local mock; what they catch is re-serialization, which multiplies
      // these numbers, not nudges them.
      const libraryStart = await page.evaluate(() => {
        const entry = performance
          .getEntriesByType('resource')
          .find((r) => r.name.includes('charting_library.standalone'));
        return entry ? Math.round(entry.startTime) : null;
      });
      expect(
        libraryStart,
        `load ${iteration + 1}: chart library was requested at ${libraryStart}ms — it must start well before the auth chain resolves`,
      ).not.toBeNull();
      expect(libraryStart!).toBeLessThan(3_000);
    }
  });
});
