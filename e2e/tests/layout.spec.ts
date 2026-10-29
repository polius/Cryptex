/** Phones: no page scrolls sideways (wide tables scroll inside their own card instead). */
import { expect, test } from '@playwright/test';
import { owner, sendText, stranger } from './helpers';

const PAGES = ['/', '/links', '/account', '/privacy', '/server', '/server/access', '/server/limits', '/server/branding',
  '/server/language', '/server/audit', '/signin'];

for (const width of [320, 390]) {
  test(`nothing overflows sideways at ${width} px`, async ({ browser }) => {
    const opts = { viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
    const { page } = await owner(browser, opts);
    const check = async (where: string) => {
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(r.sw, `${where} is ${r.sw} px wide on a ${r.cw} px screen`).toBeLessThanOrEqual(r.cw);
    };
    for (const path of PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await check(path);
    }
    const link = await sendText(page, 'layout canary', 'A rather long title for a secret that has to wrap nicely');
    await check('link ready');
    const r = await stranger(browser, opts);
    await r.page.goto(link);
    await expect(r.page.getByRole('button', { name: 'Reveal secret' })).toBeVisible();
    const w = await r.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(w, 'sealed page overflows').toBeLessThanOrEqual(0);
    // Scrolled to the end, the pinned Reveal bar covers nothing: the address check under it stays readable.
    await r.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const bar = (await r.page.locator('.sealed-body .actions-m').boundingBox())!;
    const fine = (await r.page.locator('.sealed-body > p.fine').first().boundingBox())!;
    expect(fine.y, 'the Reveal bar covers the line under it').toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  });
}
