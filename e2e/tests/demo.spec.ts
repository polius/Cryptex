/** DEMO=true (DEMO_SEALS_PER_DAY=3 in compose.yml): banner, fixed policy, quota, limit page, reports. */
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function demoSend(page: import('@playwright/test').Page, text: string) {
  await page.goto('/');
  await page.locator('#composer').fill(text);
  await page.getByRole('button', { name: 'Create link' }).click();
}

test('banner, fixed policy and quota', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.demo-bar')).toContainText('Public demo.');
  await expect(page.getByRole('heading', { name: 'Try Cryptex' })).toBeVisible();
  await expect(page.locator('.policy')).toContainText('Fixed in the demo');
  await expect(page.getByRole('button', { name: 'Change' })).toHaveCount(0);
  await expect(page.getByText('3 of 3 links left today')).toBeVisible();
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
});

test('sending works with proof of work; the recipient sees the demo warning and can report', async ({ page, browser }) => {
  await demoSend(page, 'demo canary');
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  const link = (await page.locator('.linkbox .url .sr').textContent())!.trim();
  await expect(page.locator('.facts')).toContainText('Once');
  const r = await (await browser.newContext()).newPage();
  await r.goto(link);
  await expect(r.locator('.demo-bar')).toContainText('This came from a public demo.');
  await r.getByRole('button', { name: 'Report abuse' }).click();
  await r.getByRole('alertdialog').getByRole('button', { name: 'Report and delete' }).click();
  await expect(r.getByRole('heading', { name: 'The sender destroyed this secret' })).toBeVisible();
});

test('after the daily quota, the limit page offers self-hosting', async ({ page }) => {
  await demoSend(page, 'two');
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  await demoSend(page, 'three');
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  await demoSend(page, 'four');
  await expect(page.getByRole('heading', { name: 'You’ve used today’s 3 demo links' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.terminal')).toContainText('docker run');
});

test('the Server tab is a read-only tour', async ({ page }) => {
  await page.goto('/server/limits');
  await expect(page.getByText('read-only tour with sample data')).toBeVisible();
  await expect(page.getByLabel('Most opens per link')).toBeDisabled();
});
