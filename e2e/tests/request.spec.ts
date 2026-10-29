/** Ask for a secret: a request link, answered once by someone without an account, opened only by whoever asked. */
import { expect, test, type Page } from '@playwright/test';
import { owner, stranger } from './helpers';

/** The dialog behind "Ask for a secret": pick how long, create, then read the link and its code off its ready page.
 *  Done leaves that page for the request's status, at the same address. */
async function ask(page: Page, note = ''): Promise<{ link: string; code: string }> {
  await page.locator('.send-head, .page-head').getByRole('button', { name: 'Ask for a secret' }).click();
  const dialog = page.getByRole('dialog');
  if (note) await dialog.getByLabel(/Note for them/).fill(note);
  await dialog.getByRole('radio', { name: '1 hour' }).click();
  await dialog.getByRole('button', { name: 'Create request link' }).click();
  await expect(page.getByRole('heading', { name: 'Your request link is ready' })).toBeVisible();
  await expect(page).toHaveURL(/\/r\/[0-9A-Za-z]{10}$/);
  const link = (await page.locator('.linkbox .url .sr').textContent())!.trim();
  const code = (await page.locator('.facts > div').first().locator('b').textContent())!.trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Waiting for an answer').first()).toBeVisible();
  expect(link).toMatch(/\/a\/[0-9A-Za-z]{10}#[A-Za-z0-9_-]{22}$/);
  expect(code).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
  return { link, code };
}

test('someone without an account answers once, with a passphrase, and only the requester opens it', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  const { link, code } = await ask(page, 'Sam from IT: the VPN password for the new laptop, please.');

  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.getByRole('heading', { name: 'Someone is asking you for a secret' })).toBeVisible();
  await expect(r.page.locator('.ask-facts')).toContainText(code); // the same request, and nobody named
  await expect(r.page.locator('.ask-said blockquote')).toHaveText('Sam from IT: the VPN password for the new laptop, please.'); // their words only
  await expect(r.page.getByText(/\bsam\b/)).toHaveCount(0);
  await r.page.locator('#composer').fill('vpn-canary-7');
  await r.page.getByRole('checkbox', { name: /Ask for a passphrase/ }).check();
  await r.page.getByLabel('Passphrase', { exact: true }).fill('copper-lantern-river-42');
  await r.page.getByRole('button', { name: 'Send securely' }).click();
  await expect(r.page.getByRole('heading', { name: 'Sent', exact: true })).toBeVisible();
  await expect(r.page.locator('.pass-ready')).toContainText('copper-lantern-river-42');
  // One answer per request.
  const again = await stranger(browser);
  await again.page.goto(link);
  await expect(again.page.getByRole('heading', { name: 'This request was already answered' })).toBeVisible();

  await page.goto('/links');
  const row = page.locator('.r', { hasText: 'Answered' }).first();
  await row.getByRole('button', { name: 'Open answer' }).click();
  await page.locator('#pass').fill('copper-lantern-river-42');
  await page.getByRole('button', { name: /Reveal/ }).click();
  await expect(page.getByText('vpn-canary-7')).toBeVisible();
});

test('destroying a request closes its link', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/links');
  const { link, code } = await ask(page);
  await page.goto('/links');
  await expect(page.getByRole('link', { name: new RegExp(`Request ${code}`) })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`Request ${code}`) }).click();
  await expect(page.getByText('Waiting for an answer').first()).toBeVisible();
  await page.getByRole('button', { name: 'Destroy' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Destroy' }).click();
  await expect(page).toHaveURL(/\/links$/);

  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.getByRole('heading', { name: 'This request was closed' })).toBeVisible();
});
