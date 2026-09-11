import { expect, installLiveStreams, signIn, test } from './fixtures/gateway';
import type { Page } from '@playwright/test';

/**
 * The two residues the 26 Aug retest could not close from a desktop browser.
 *
 * BLK-02: it measured clean on every width it could produce, but its browser
 * would not give a page viewport narrower than 444px, so 390 and 360 — the
 * widths the finding is actually about — went untested. A real window cannot
 * go that narrow on macOS either (Chrome floors around 400px); emulation can,
 * and CSS layout does not care whether a viewport is emulated.
 *
 * HGH-05: `env(safe-area-inset-bottom)` resolves to 0 on every desktop
 * browser, so the declaration was confirmed and its EFFECT was not. That gap
 * hid a real bug — see the nav in MobileTerminal.tsx. The inset is supplied
 * here through the custom property the nav reads, which is the same code path
 * an iPhone drives through env().
 *
 * What this still does not prove: that iOS reports 34px. That is a fact about
 * the device, not about this code, and it needs a real handset or the iOS
 * Simulator.
 */

const PHONES = [
  { name: 'iPhone 12/13/14', width: 390, height: 844 },
  { name: 'iPhone SE / small Android', width: 360, height: 800 },
] as const;

const TABS = ['Markets', 'Chart', 'Trade', 'Positions', 'Account'] as const;

/** The inset a home-indicator iPhone reports. */
const HOME_INDICATOR_PX = 34;

async function overflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    // The widest thing that is not inside something allowed to scroll.
    widest: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= document.documentElement.clientWidth) return false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== 'visible') return false;
        }
        return true;
      })
      .map((el) => `${el.tagName}.${el.className.toString().slice(0, 40)}`)
      .slice(0, 3),
  }));
}

for (const phone of PHONES) {
  test.describe(`${phone.name} — ${phone.width}px`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height }, isMobile: true });

    test('no horizontal overflow on any of the five tabs', async ({ page, gateway }) => {
      void gateway;
      test.setTimeout(120_000);
      await installLiveStreams(page);
      await signIn(page);

      for (const label of TABS) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.waitForTimeout(600);

        const measured = await overflow(page);
        expect(measured.widest, `${label}: rigid element wider than the viewport`).toEqual([]);
        expect(measured.scrollWidth, `${label}: page scrolls sideways`).toBe(measured.clientWidth);
        expect(measured.clientWidth).toBe(phone.width);
      }
    });

    test('the tab bar clears the home indicator without crushing its buttons', async ({
      page,
      gateway,
    }) => {
      void gateway;
      test.setTimeout(120_000);
      await installLiveStreams(page);
      await signIn(page);

      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      const before = (await nav.boundingBox())!;

      // What an iPhone reports and no desktop browser ever will.
      await page.addStyleTag({
        content: `:root { --safe-area-bottom: ${HOME_INDICATOR_PX}px; }`,
      });
      await page.waitForTimeout(200);

      const after = (await nav.boundingBox())!;
      const padding = await nav.evaluate((el) => getComputedStyle(el).paddingBottom);

      // The gap is ADDED to the bar. Taken out of a fixed height instead, the
      // bar would stay 56px and the buttons would collapse to 22px.
      expect(padding).toBe(`${HOME_INDICATOR_PX}px`);
      expect(Math.round(after.height - before.height)).toBe(HOME_INDICATOR_PX);

      // The invariant that names the bug: the CONTENT box is unchanged by the
      // inset. `h-14` plus padding-bottom under border-box sizing would leave
      // 56 - 34 = 22px here, which is what an iPhone would have rendered.
      expect(Math.round(after.height - HOME_INDICATOR_PX)).toBe(Math.round(before.height));

      // Every tab keeps a usable target, and none of them reaches into the
      // indicator's strip at the bottom of the screen.
      const indicatorTop = after.y + after.height - HOME_INDICATOR_PX;
      for (const label of TABS) {
        const box = (await page.getByRole('button', { name: label, exact: true }).boundingBox())!;
        expect(box.height, `${label} button height`).toBeGreaterThanOrEqual(44);
        expect(box.y + box.height, `${label} sits above the home indicator`).toBeLessThanOrEqual(
          indicatorTop + 1,
        );
      }
    });
  });
}
