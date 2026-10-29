/** DEMO=true (DEMO_SEALS_PER_DAY=3 in compose.yml): banner, demo limits, quota, limit page, reports. */
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function demoSend(page: import('@playwright/test').Page, text: string) {
  await page.goto('/');
  await page.locator('#composer').fill(text);
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
}

test('demo badge, limits and quota', async ({ page }) => {
  await page.goto('/');
  // A Demo badge by the brand explains the demo's limits; there's no banner.
  await page.getByRole('button', { name: 'Demo', exact: true }).click();
  await expect(page.locator('#demo-pop')).toContainText('Public demo.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Send a secret' })).toBeVisible();
  // Every option is visible; what the demo can't do is greyed out.
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page.getByText('Greyed-out choices aren’t available in the demo.', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Destroy it after it’s opened/ })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: /Destroy it after it’s opened/ })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: '1 day' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /Ask for a passphrase/ })).toBeEnabled();
  await page.getByRole('button', { name: 'Demo', exact: true }).click();
  await expect(page.locator('#demo-pop')).toContainText('3 of 3 links left today');
  await page.keyboard.press('Escape');
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  // No accounts in the demo, and no limit page while links are left: both lead to the send page.
  for (const path of ['/signin', '/demo/limit']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Send a secret' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  }
});

test('sending works with proof of work; the recipient can report', async ({ page, browser }) => {
  await demoSend(page, 'demo canary');
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  const link = (await page.locator('.linkbox .url .sr').textContent())!.trim();
  await expect(page.locator('.facts')).toContainText('Once');
  const r = await (await browser.newContext()).newPage();
  await r.goto(link);
  await r.getByRole('button', { name: 'Report abuse' }).click();
  await r.getByRole('alertdialog').getByRole('button', { name: 'Report and delete' }).click();
  await expect(r.getByRole('heading', { name: 'This link was reported' })).toBeVisible();
  // The next visitor sees the same outcome.
  const next = await (await browser.newContext()).newPage();
  await next.goto(link);
  await expect(next.getByRole('heading', { name: 'This link was reported' })).toBeVisible();
});

test('after the daily quota, the limit page offers self-hosting', async ({ page }) => {
  await demoSend(page, 'two');
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  await demoSend(page, 'three');
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  await demoSend(page, 'four');
  await expect(page.getByRole('heading', { name: 'You’ve used today’s 3 demo links' })).toBeVisible({ timeout: 30_000 });
  // The README has the full setup (HTTPS proxy, TRUSTED_PROXIES): the page links to it instead of a shortcut command.
  await expect(page.getByRole('link', { name: 'Read the setup guide' })).toHaveAttribute('href', /github\.com\/polius\/cryptex/);
  // Your links shows the same quota, and when it comes back.
  await page.goto('/links');
  await expect(page.locator('main .demo-quota')).toContainText(/0 of 3 links left today · resets in/);
});

test('the Server tab is a read-only tour', async ({ page }) => {
  await page.goto('/server/limits');
  await expect(page.getByText('read-only tour with sample data')).toBeVisible();
  await expect(page.getByLabel('File size')).toBeDisabled();
});

test('the menu shows a sample owner, "demo"; Your account is a read-only tour and Sign out does nothing', async ({ page }) => {
  await page.goto('/');
  await page.locator('#account-button').click();
  await expect(page.locator('#account-menu .who')).toContainText('demo');
  const signOut = page.locator('#account-menu').getByRole('button', { name: 'Sign out' });
  await expect(signOut).toHaveAttribute('aria-disabled', 'true');
  await signOut.click({ force: true }); // aria-disabled: still focusable, so its reason is read out, but it does nothing
  await expect(page.locator('#account-menu')).toBeVisible();
  await page.locator('#account-menu').getByRole('button', { name: 'Your account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText('This is a read-only tour.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled();
});

test.describe('language', () => {
  test.use({ locale: 'ca-ES' });

  test('follows the browser, and the menu choice sticks on this device', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Envia un secret' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ca');
    await page.locator('#account-button').click();
    await page.locator('#lang-select').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Send a secret' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Send a secret' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});

test('asking for a secret counts toward today\'s demo links', async ({ page }) => {
  // The quota test above used them all: a request is one more link, so it leads to the limit page too.
  await page.goto('/');
  await page.locator('.send-head').getByRole('button', { name: 'Ask for a secret' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create request link' }).click();
  await expect(page.getByRole('heading', { name: 'You’ve used today’s 3 demo links' })).toBeVisible({ timeout: 30_000 });
});
