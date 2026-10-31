/** Accessibility (definition of done): axe-core finds no serious or critical issues on the main screens, in both themes. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createLink, owner, paste, sendText, stranger } from './helpers';

async function audit(page: Page, name: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`main screens have no serious accessibility issues (${colorScheme})`, async ({ browser }) => {
    const { page } = await owner(browser, { colorScheme });
    await page.goto('/');
    await audit(page, 'send-empty');
    await paste(page, 'DB_HOST=db\nDB_PASSWORD=x');
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    await audit(page, 'send-options');
    await page.getByRole('button', { name: 'Done', exact: true }).first().click();
    await createLink(page);
    await audit(page, 'send-sent');
    await page.goto('/links');
    await audit(page, 'links');
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await audit(page, 'account');
    for (const s of ['', '/access', '/limits', '/branding', '/audit']) {
      await page.goto(`/server${s}`);
      await expect(page.locator('.srv-main h1')).toBeVisible();
      await audit(page, `server${s || '/overview'}`);
    }
    const link = await sendText(page, 'a11y canary', 'Accessibility');
    const r = await stranger(browser, { colorScheme });
    await r.page.goto(link);
    await expect(r.page.getByRole('button', { name: 'Reveal secret' })).toBeVisible();
    await audit(r.page, 'reveal-sealed');
    await r.page.getByRole('button', { name: 'Reveal secret' }).click();
    await expect(r.page.locator('.out')).toBeVisible();
    await audit(r.page, 'reveal-open');
    await r.page.goto('/signin');
    await audit(r.page, 'signin');
    await r.page.goto('/privacy');
    await audit(r.page, 'privacy');
  });
}
