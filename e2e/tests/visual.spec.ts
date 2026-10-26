/**
 * Visual regression (CX-91): every main screen at 1440 px and 390 px, light and dark, compared with
 * approved baselines in __screenshots__ (reviewed against design/v3/proto). Values that change per run
 * (IDs, keys, times, counts) are masked. Update with: PW_ARGS="--project=visual --update-snapshots".
 */
import { expect, test, type Page } from '@playwright/test';
import { createLink, owner, paste, sendText, stranger } from './helpers';

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;
const THEMES = ['light', 'dark'] as const;

async function snap(page: Page, name: string, mask: string[] = []) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    mask: [page.locator('.toasts'), ...mask.map((m) => page.locator(m))],
  });
}

for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
  for (const theme of THEMES) {
    test.describe(`${vp} ${theme}`, () => {
      const opts = { viewport, colorScheme: theme, deviceScaleFactor: vp === 'mobile' ? 2 : 1, isMobile: vp === 'mobile', hasTouch: vp === 'mobile' } as const;
      const tag = `${vp}-${theme}`;

      test('send', async ({ browser }) => {
        const { page } = await owner(browser, opts);
        await page.goto('/');
        await snap(page, `send-empty-${tag}`, ['.count']);
        await paste(page, 'DB_HOST=db-staging.internal:5432\nDB_USER=app_rw\nDB_PASSWORD="k7#Qp2-vR9mL"');
        await page.locator('.cmp-title input').fill('Staging database');
        await page.locator('.cmp-title input').blur();
        await snap(page, `send-filled-${tag}`, ['.count']);
        await page.getByRole('button', { name: 'Change' }).click();
        await snap(page, `send-options-${tag}`, ['.count']);
        await page.getByRole('button', { name: 'Done' }).first().click();
        await createLink(page);
        await snap(page, `send-sent-${tag}`, ['.count', '.linkbox .url', '.facts > div:nth-child(2)']);
      });

      test('reveal', async ({ browser }) => {
        const { page } = await owner(browser);
        const link = await sendText(page, 'db-staging.internal:5432', 'Staging database');
        const r = await stranger(browser, opts);
        await r.page.goto(link);
        await expect(r.page.getByRole('button', { name: 'Reveal secret' })).toBeVisible();
        await snap(r.page, `reveal-sealed-${tag}`, ['.list li:nth-child(3)', '.domain', '.fine .mono']);
        await r.page.getByRole('button', { name: 'Reveal secret' }).click();
        await expect(r.page.locator('.out')).toBeVisible();
        await snap(r.page, `reveal-open-${tag}`, ['.timer', '.domain']);
        const g = await stranger(browser, opts);
        await g.page.goto(link);
        await expect(g.page.locator('h1')).toBeVisible();
        await snap(g.page, `reveal-gone-${tag}`, ['h1', '.domain']);
        await g.page.goto(link.slice(0, link.indexOf('#') + 6));
        await expect(g.page.locator('h1')).toBeVisible();
        await snap(g.page, `reveal-broken-${tag}`, ['.broken-url', '.domain']);
        await g.page.goto('/no/such/page');
        await snap(g.page, `not-found-${tag}`, ['.domain']);
      });

      test('request and respond', async ({ browser }) => {
        const { page } = await owner(browser, opts);
        await page.goto('/?mode=request');
        await page.getByLabel('What you need').fill('AWS read-only keys');
        await page.locator('#req-message').fill('Read-only on the billing account is enough. Thanks!');
        await snap(page, `request-new-${tag}`, ['.count']);
        await page.getByRole('button', { name: 'Create request link' }).click();
        await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
        await snap(page, `request-sent-${tag}`, ['.count', '.linkbox .url', '.facts > div:nth-child(1)']);
        const qlink = (await page.locator('.linkbox .url .sr').textContent())!.trim();
        const v = await stranger(browser, opts);
        await v.page.goto(qlink);
        await expect(v.page.getByRole('heading', { name: 'AWS read-only keys' })).toBeVisible();
        await snap(v.page, `respond-${tag}`, ['.fine', '.domain']);
      });

      test('your links and server', async ({ browser }) => {
        const { page } = await owner(browser, opts);
        await page.goto('/links');
        await expect(page.locator('.rows')).toBeVisible();
        await snap(page, `links-${tag}`, ['.count', '.rows', '.tab .n']);
        for (const s of ['access', 'limits', 'branding', 'notifications']) {
          await page.goto(`/server/${s}`);
          await expect(page.locator('.srv-main h1')).toBeVisible();
          await snap(page, `server-${s}-${tag}`, ['.count', '.domain', '.metric', 'td.mono', '.k small', '.hook']);
        }
        await page.goto('/server');
        await expect(page.locator('.health')).toBeVisible();
        await snap(page, `server-overview-${tag}`, ['.count', '.lede', '.metric', '.card:last-of-type tbody']);
      });

      test('sign in and empty links', async ({ browser }) => {
        const s = await stranger(browser, opts);
        await s.page.goto('/signin');
        await snap(s.page, `signin-${tag}`, ['.domain']);
        await s.page.goto('/links');
        await expect(s.page.getByRole('heading', { name: 'Nothing sent yet' })).toBeVisible();
        await snap(s.page, `links-empty-${tag}`);
      });
    });
  }
}
