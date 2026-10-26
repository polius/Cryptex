import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { STATE } from '../global-setup';

export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

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

export async function createLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  return (await page.locator('.linkbox .url .sr').textContent())!.trim();
}

export async function sendText(page: Page, text: string, title?: string): Promise<string> {
  await page.goto('/');
  await page.locator('#composer').fill(text);
  if (title) await page.locator('.cmp-title input').fill(title);
  return createLink(page);
}

export async function latestMail(to: string, since = 0): Promise<{ subject: string; text: string }> {
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = (await r.json()) as { messages: Array<{ ID: string; Subject: string; Created: string }> };
    const m = list.messages.find((x) => Date.parse(x.Created) >= since);
    if (m) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { Text: string };
      return { subject: m.Subject, text: full.Text };
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`no mail to ${to}`);
}
