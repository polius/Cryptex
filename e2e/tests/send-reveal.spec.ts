/** Send → reveal with two browsers: the core promise, and the threat-model rows a browser can prove. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createLink, owner, paste, sendText, stranger } from './helpers';

test('send a note and a file, the recipient reveals it once', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await page.locator('#composer').fill('The wifi password is on the fridge.');
  await page.locator('.cmp-title input').fill('Office wifi');
  const file = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('line one\nline two\n'.repeat(500)) };
  await page.locator('input[type=file]').first().setInputFiles(file);
  await expect(page.locator('.file')).toContainText('notes.txt');
  const link = await createLink(page);
  expect(page.url()).toMatch(/\/$/); // the address bar stays on "/"
  expect(link).toMatch(/\/s\/[0-9A-Za-z]{10}#[A-Za-z0-9_-]{22}$/);
  await expect(page.getByText('Link copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.getByRole('heading', { name: 'Office wifi' })).toBeVisible();
  await expect(r.page.getByText('Sam Rivera')).toBeVisible();
  await expect(r.page.getByText('1 file')).toBeVisible();
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toContainText('The wifi password is on the fridge.');
  await expect(r.page.getByText('Deleted from the server. This page is the only copy.')).toBeVisible();
  expect(r.page.url()).not.toContain('#'); // key removed from the address bar after reveal
  const download = r.page.waitForEvent('download');
  await r.page.getByRole('button', { name: 'Save' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('notes.txt');
  const got = readFileSync((await d.path())!);
  expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(file.buffer).digest('hex'));

  // A second visit, from anywhere, sees that it was opened.
  const again = await stranger(browser);
  await again.page.goto(link);
  await expect(again.page.getByRole('heading', { name: /This secret was opened/ })).toBeVisible();
});

test('e2e_scanner_load_does_not_consume: loading the page opens nothing', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'scanner canary', 'Scanner test');
  for (let i = 0; i < 3; i++) {
    const s = await stranger(browser);
    await s.page.goto(link);
    await expect(s.page.getByRole('button', { name: 'Reveal secret' })).toBeVisible();
    await s.ctx.close();
  }
  const r = await stranger(browser);
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toContainText('scanner canary');
});

test('the sender sees "Opened" live, within 2 seconds', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'live canary', 'Live receipt');
  await page.getByRole('link', { name: 'Done' }).click();
  await expect(page.locator('.status')).toContainText('Not opened yet');
  await page.waitForTimeout(1500); // let the live connection open
  const r = await stranger(browser);
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toBeVisible();
  await expect(page.locator('.status')).toContainText('Opened', { timeout: 2_500 });
  await expect(page.locator('.events')).toContainText('Revealed');
});

test('a cut link shows "link incomplete" without asking the server', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'cut canary');
  const r = await stranger(browser);
  const calls: string[] = [];
  r.page.on('request', (q) => q.url().includes('/api/v1/secrets/') && calls.push(q.url()));
  await r.page.goto(link.slice(0, link.indexOf('#') + 12));
  await expect(r.page.getByRole('heading', { name: 'Part of this link is missing' })).toBeVisible();
  expect(calls).toEqual([]);
});

test('destroy now: the recipient learns the sender destroyed it', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'destroy canary', 'To destroy');
  await page.getByRole('button', { name: 'Destroy now' }).filter({ visible: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Destroy' }).click();
  await expect(page.getByText('Destroyed')).toBeVisible();
  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.getByRole('heading', { name: 'The sender destroyed this secret' })).toBeVisible();
});

test('the revealed page clears itself after 5 idle minutes', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'clear canary');
  const r = await stranger(browser);
  await r.page.clock.install();
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toContainText('clear canary');
  await r.page.clock.runFor(5 * 60_000 + 2000);
  await expect(r.page.getByRole('heading', { name: 'Cleared. The secret was deleted from the server.' })).toBeVisible();
  await expect(r.page.locator('body')).not.toContainText('clear canary');
});

test('pasting a .env file becomes fields, and Undo restores the paste', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await paste(page, 'DB_HOST=db\nDB_PASSWORD="x y"');
  await expect(page.getByText('Read as a .env file')).toBeVisible();
  await expect(page.locator('.field.edit')).toHaveCount(2);
  await expect(page.locator('.field.edit input.v').nth(1)).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('#composer')).toHaveValue('DB_HOST=db\nDB_PASSWORD="x y"');
});

test('fields are revealed masked, and copy as .env works', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await paste(page, 'postgres://app:s3cr3t-pw@db:5432/x');
  await page.locator('.cmp-title input').fill('Database URL');
  const link = await createLink(page);
  const r = await stranger(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
  await r.page.goto(link);
  await expect(r.page.getByText('4 fields')).toBeVisible();
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).not.toContainText('s3cr3t-pw');
  await r.page.getByRole('button', { name: 'Show' }).click();
  await expect(r.page.locator('.out')).toContainText('s3cr3t-pw');
  await r.page.getByRole('button', { name: 'Copy all as .env' }).click();
  expect(await r.page.evaluate(() => navigator.clipboard.readText())).toBe('HOST=db:5432/x\nUSERNAME=app\nPASSWORD=s3cr3t-pw\nTYPE=postgres\n');
});

test('keyboard: Cmd/Ctrl+Enter creates; Escape closes a dialog and returns focus', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await expect(page.locator('#composer')).toBeFocused();
  await page.keyboard.type('keyboard canary');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  const qr = page.getByRole('button', { name: 'QR code' });
  await qr.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(qr).toBeFocused();
});
