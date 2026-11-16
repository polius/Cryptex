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

/** V3: at phone width with touch, any axe result fails (target size is only "serious" at most), on the screens the
 *  desktop pass skips too: the answer page, an open dialog, a broken link, invite and reset without a token. */
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function auditAll(page: Page, name: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
}

test('phone screens have no accessibility issues, and touch targets are 44 px', async ({ browser }) => {
  const { page } = await owner(browser, PHONE);
  await page.goto('/');
  await paste(page, 'DB_HOST=db\nDB_PASSWORD=x');
  await auditAll(page, 'send-fields');
  await page.getByRole('button', { name: 'Ask for a secret' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await auditAll(page, 'ask-dialog');
  await page.locator('#ask-note').fill('a11y request');
  await page.getByRole('button', { name: 'Create request link' }).click();
  await page.waitForURL(/\/r\//);
  const ask = (await page.locator('.linkbox .url .sr').first().textContent())!.trim();
  await page.goto('/links');
  await auditAll(page, 'links');
  const small = await page.locator('main button:visible, main a.btn:visible').evaluateAll((els) => els
    .map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.height < 44).map(({ el }) => el.textContent?.trim()));
  expect(small).toEqual([]);
  const r = await stranger(browser, PHONE);
  await r.page.goto(ask);
  await expect(r.page.getByRole('button', { name: 'Send securely' })).toBeVisible();
  await auditAll(r.page, 'answer');
  await r.page.goto('/s/AAAAAAAAAA#short');
  await auditAll(r.page, 'reveal-broken');
  for (const p of ['/invite', '/reset', '/signin']) {
    await r.page.goto(p);
    await auditAll(r.page, p);
  }
});
