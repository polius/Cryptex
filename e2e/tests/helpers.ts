import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { STATE } from '../global-setup';

export async function owner(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ storageState: STATE, ...opts });
  return { ctx, page: await ctx.newPage() };
}

export async function stranger(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(opts);
  return { ctx, page: await ctx.newPage() };
}

/** Paste like a person does: a clipboard event on the composer. */
export async function paste(page: Page, text: string): Promise<void> {
  await page.locator('#composer').evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

/** Creates the link from the composer; one-time by default, as most tests check what happens after the open. */
export async function createLink(page: Page, oneTime = true): Promise<string> {
  if (oneTime) {
    const box = page.getByRole('checkbox', { name: /Destroy it after it’s opened/ });
    if (!(await box.isVisible())) await page.getByRole('button', { name: 'Change', exact: true }).click();
    await box.check();
  }
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  // The link's box comes first; a passphrase, when there is one, has a box of its own below it.
  await expect(page.locator('.linkbox').first()).toBeVisible({ timeout: 30_000 });
  return (await page.locator('.linkbox .url .sr').textContent())!.trim();
}

export async function sendText(page: Page, text: string, title?: string): Promise<string> {
  await page.goto('/');
  await page.locator('#composer').fill(text);
  if (title) await page.locator('.cmp-title input').fill(title);
  return createLink(page);
}

/** Answer one API route from the test (no server state changes): JSON with a status, or an API error. */
export async function fake(page: Page, path: string, status: number, body?: unknown, method?: string): Promise<void> {
  await page.route(`**/api/v1${path}`, (route) => {
    if (method && route.request().method() !== method) return route.fallback();
    return status === 204 ? route.fulfill({ status }) : route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/** A fresh server as /setup sees it: the real config, but with setup still to do and nobody signed in. */
export async function fakeFreshServer(page: Page): Promise<void> {
  await page.route('**/api/v1/config', async (route) => {
    const res = await route.fetch();
    const c = await res.json();
    await route.fulfill({ response: res, json: { ...c, setup_needed: true, signed_in: false, user: null, brand: { ...c.brand, name: '', logo_url: null } } });
  });
  await fake(page, '/setup', 200, { needed: true, brand_locked: false, access_locked: false, code_command: 'docker exec cryptex cryptex setup-code' }, 'GET');
}

/** A fixed authenticator key, so pages that show one (and its QR code) look the same on every run. */
export const FIXED_TOTP = { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Acme%20Cryptex:lisa?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Acme%20Cryptex' };
