/** Send → reveal with two browsers: the core promise, and the threat-model rows a browser can prove. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { OWNER } from '../global-setup';
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
  expect(link).toMatch(/\/s\/[0-9A-Za-z]{10}#[A-Za-z0-9_-]{22}$/);
  // The address becomes the link's own page, with no key in it.
  expect(page.url()).toMatch(new RegExp(`/r/${link.match(/\/s\/([0-9A-Za-z]{10})/)![1]}$`));
  await expect(page.getByText('Link copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.getByRole('heading', { name: 'Office wifi' })).toBeVisible();
  await expect(r.page.getByText(OWNER.username, { exact: true })).toBeVisible();
  await expect(r.page.getByText('1 file')).toBeVisible();
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toContainText('The wifi password is on the fridge.');
  await expect(r.page.getByText('The link no longer works. Save what you need before you leave this page.')).toBeVisible();
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

test('the sender sees "Opened" on the next status read', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'poll canary', 'Polled receipt');
  await page.clock.install(); // the link page reads statuses again every 30 s (POLL_MS in web/src/screens/links/sync.ts)
  await page.goto(`/r/${link.match(/\/s\/([0-9A-Za-z]{10})#/)![1]}`);
  await expect(page.locator('.status')).toContainText('Not opened yet');
  const r = await stranger(browser);
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toBeVisible();
  await page.clock.runFor(30_000);
  await expect(page.locator('.status')).toContainText('Opened');
  await expect(page.locator('.events')).toContainText('Revealed');
});

test('"Skip to content" on a revealed link moves focus and keeps the secret', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'skip canary');
  const r = await stranger(browser);
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toBeFocused(); // focus lands on the secret, not the page
  await r.page.locator('a.skip').focus();
  await r.page.keyboard.press('Enter');
  await expect(r.page.locator('#main')).toBeFocused();
  await r.page.waitForTimeout(500);
  await expect(r.page.locator('.out')).toContainText('skip canary');
  expect(r.page.url()).not.toContain('#');
});

test('a download that stops continues with the same read session; the view is counted once', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'resume canary', 'Resume test');
  const r = await stranger(browser);
  const reveals: string[] = [];
  const chunks: string[] = [];
  r.page.on('request', (q) => {
    if (q.method() === 'POST' && q.url().endsWith('/reveal')) reveals.push(q.url());
    if (q.url().includes('/chunks/')) chunks.push(q.headers().authorization ?? '');
  });
  let refused = false;
  await r.page.route('**/api/v1/secrets/*/chunks/**', async (route) => {
    if (refused) return route.continue();
    refused = true; // the first chunk fails once, after the view was counted
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden' } }) });
  });
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.getByRole('heading', { name: 'The download stopped' })).toBeVisible();
  await expect(r.page.getByRole('heading', { name: 'The download stopped' })).toBeFocused(); // the pressed button is gone
  await expect(r.page.locator('body')).not.toContainText('Nothing was opened');
  await r.page.getByRole('button', { name: 'Try again' }).click();
  await expect(r.page.locator('.out')).toContainText('resume canary');
  await expect(r.page.getByRole('heading', { level: 1, name: 'Resume test' })).toBeVisible(); // the revealed secret is the page's heading
  expect(reveals).toHaveLength(1); // continued, never revealed again (a one-time link would be gone)
  expect(new Set(chunks).size).toBe(1); // every chunk with the same read session
  expect(chunks[0]).toMatch(/^Read /);
});

test('after a reveal, a reload or the same link again says it was opened in this tab', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'here canary');
  const r = await stranger(browser);
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toContainText('here canary');
  await r.page.reload(); // the key left the address bar at reveal
  await expect(r.page.getByRole('heading', { name: 'You opened this link in this tab' })).toBeVisible();
  await expect(r.page.getByRole('heading', { name: 'Part of this link is missing' })).toBeHidden();
  await r.page.goto(link); // the original link, in the same tab
  await expect(r.page.getByRole('heading', { name: 'You opened this link in this tab' })).toBeVisible();
  await expect(r.page.locator('body')).not.toContainText('someone else may have seen it');
  // Another browser still gets the warning: it wasn't them.
  const other = await stranger(browser);
  await other.page.goto(link);
  await expect(other.page.getByRole('heading', { name: /This secret was opened/ })).toBeVisible();
});

test('"Send another" starts without the last link\'s passphrase', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await page.locator('#composer').fill('passphrase canary');
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByRole('checkbox', { name: /Ask for a passphrase/ }).check();
  await page.locator('.pass-input input').fill('copper-lantern-river-42');
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.locator('.pass-ready')).toContainText('copper-lantern-river-42');
  await page.getByRole('button', { name: 'Send another' }).click();
  await page.getByRole('button', { name: 'Change' }).click();
  await expect(page.getByRole('checkbox', { name: /Ask for a passphrase/ })).not.toBeChecked();
});

test('a link ID that isn\'t one never reaches the API', async ({ browser }) => {
  const r = await stranger(browser);
  const calls: string[] = [];
  r.page.on('request', (q) => q.url().includes('/api/v1/secrets/') && calls.push(q.url()));
  await r.page.goto(`/s/..%2Fconfig#${'A'.repeat(22)}`);
  await expect(r.page.getByRole('heading', { name: 'There’s nothing at this address' })).toBeVisible();
  expect(calls).toEqual([]);
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

test('destroy: the link stops working, leaves Your links, and the recipient learns why', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'destroy canary', 'To destroy');
  await page.getByRole('button', { name: 'Destroy', exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Destroy', exact: true }).click();
  await expect(page.getByText('Destroyed')).toBeVisible(); // the toast
  await page.goto('/links');
  await expect(page.locator('.rows')).not.toContainText('To destroy');
  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.getByRole('heading', { name: 'The sender destroyed this secret' })).toBeVisible();
  await expect(r.page.getByText('It was deleted before anyone opened it.')).toBeVisible();
});

test('Clear expired removes expired links from Your links, and only those', async ({ browser }) => {
  const { page } = await owner(browser);
  const expired = await sendText(page, 'expired canary', 'Expired one');
  const id = expired.split('/s/')[1].split('#')[0];
  const opened = await sendText(page, 'opened canary', 'Opened one');
  const r = await stranger(browser);
  await r.page.goto(opened);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toContainText('opened canary');
  // Waiting out an expiry takes minutes: the statuses the page reads say this one expired.
  await page.route(/\/api\/v1\/(receipts\/lookup|me\/receipts)/, async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    const mark = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(mark);
      else if (o && typeof o === 'object') {
        if ((o as { id?: string }).id === id) (o as { status?: string }).status = 'expired';
        Object.values(o).forEach(mark);
      }
    };
    mark(body);
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/links');
  await expect(page.locator('.rows')).toContainText('Expired one');
  await page.getByRole('button', { name: 'Clear expired', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear expired', exact: true }).click();
  await expect(page.getByText('Expired links cleared')).toBeVisible(); // the toast
  await expect(page.locator('.rows')).not.toContainText('Expired one');
  await expect(page.locator('.rows')).toContainText('Opened one'); // ended, not expired: it stays
  await expect(page.getByRole('button', { name: 'Clear expired', exact: true })).toHaveCount(0);
});

test('the revealed page clears itself after 5 idle minutes', async ({ browser }) => {
  const { page } = await owner(browser);
  const link = await sendText(page, 'clear canary');
  const r = await stranger(browser);
  await r.page.clock.install();
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toContainText('clear canary');
  // fastForward, not runFor: an idle page jumps ahead in time (runFor would run every animation frame of 4 minutes).
  await r.page.clock.fastForward(4 * 60_000 + 5000);
  await expect(r.page.getByRole('alert')).toContainText('clears itself in under a minute'); // warned first
  await r.page.clock.fastForward(60_000);
  await expect(r.page.getByRole('heading', { name: 'Cleared from this page' })).toBeVisible();
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

test('a paste anywhere on the page adds fields to what\'s there, and Undo keeps it (F6)', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await page.locator('#composer').fill('my earlier note\n');
  await page.locator('body').evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'sam@acme.example\nk7#Qp2-vR9mL');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.field.edit')).toHaveCount(2);
  await expect(page.locator('#composer')).toHaveValue('my earlier note\n');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.field.edit')).toHaveCount(0);
  await expect(page.locator('#composer')).toHaveValue('my earlier note\nsam@acme.example\nk7#Qp2-vR9mL');
});

test('names in any language become fields, and .env never gives two the same name (F5, Q6)', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await paste(page, 'Логин: ivan\nПароль: hunter2');
  await expect(page.locator('.field.edit')).toHaveCount(2);
  await expect(page.locator('.field.edit input.v').nth(1)).toHaveAttribute('type', 'password'); // "Пароль" is a password
  const link = await createLink(page);
  const r = await stranger(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await r.page.getByRole('button', { name: 'Copy all as .env' }).click();
  expect(await r.page.evaluate(() => navigator.clipboard.readText())).toBe('VALUE=ivan\nVALUE_2=hunter2\n');
});

test('a reveal whose answer never arrived: "already opened" points to this tab, not someone else (F9)', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await page.locator('#composer').fill('dropped canary');
  const link = await createLink(page);
  const r = await stranger(browser);
  // The server counts the view, and the answer is lost on the way back.
  await r.page.route('**/api/v1/secrets/*/reveal', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  }, { times: 1 });
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.getByRole('alert')).toBeVisible();
  await r.page.getByRole('button', { name: /Reveal secret|Try again/ }).click();
  await expect(r.page.getByRole('heading', { name: 'This link was most likely opened here' })).toBeVisible();
  await expect(r.page.locator('body')).not.toContainText('someone else may have seen it');
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
  // The options panel: Change keeps its place and state, Esc closes the panel and focus returns to Change.
  const change = page.getByRole('button', { name: 'Change' });
  await change.click();
  await expect(change).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#options')).toBeVisible();
  await expect(page.locator('#options [role=radio][aria-checked=true]').first()).toBeFocused(); // the chosen expiry, not the first
  await page.keyboard.press('Escape');
  await expect(page.locator('#options')).toBeHidden();
  await expect(change).toBeFocused();
  await expect(change).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#composer').focus();
  await page.keyboard.type('keyboard canary');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused(); // the link page takes focus
  const qr = page.getByRole('button', { name: 'QR code' });
  await qr.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(qr).toBeFocused();
});

test('field names a shell acts on are renamed in .env, and a password keeps its "#"', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await paste(page, 'PS1=$(id) $\nPROMPT_COMMAND=echo hi\nDB_PASSWORD=abc #123');
  await expect(page.getByText('Read as a .env file')).toBeVisible();
  await expect(page.locator('.field.edit input.v').nth(2)).toHaveValue('abc #123'); // not cut at the "#"
  const link = await createLink(page);
  const r = await stranger(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await r.page.getByRole('button', { name: 'Copy all as .env' }).click();
  expect(await r.page.evaluate(() => navigator.clipboard.readText())).toBe("_PS1='$(id) $'\n_PROMPT_COMMAND='echo hi'\nDB_PASSWORD='abc #123'\n");
});

test('signed out while a link is made: nothing is kept or shown, and the page reloads signed out', async ({ browser }) => {
  const { page } = await owner(browser);
  let ended = false;
  // The session ends during the send (another tab, a shared session's 12 hours): the account refuses the new link
  // (401 ended), and the config says nobody is signed in. Answered here, so the shared test session stays signed in.
  await page.route('**/api/v1/me/vault/items/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    ended = true;
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'sign_in_required', reason: 'ended' } }) });
  });
  await page.route('**/api/v1/config', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: ended ? { ...(await res.json()), signed_in: false, user: null } : await res.json() });
  });
  await page.goto('/');
  await page.locator('#composer').fill('signed-out canary');
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await reloaded;
  await expect(page.locator('#account-button.anon')).toBeVisible(); // signed out now: nothing is sent as nobody
  await expect(page.locator('#composer')).toHaveValue('');
  await expect(page.locator('.linkbox')).toHaveCount(0); // the link is never shown
  const kept = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const req = indexedDB.open('cryptex');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('receipts')) return resolve(0);
      const c = db.transaction('receipts').objectStore('receipts').count();
      c.onsuccess = () => resolve(c.result);
      c.onerror = () => reject(c.error);
    };
  }));
  expect(kept).toBe(0);
});
