/** Passphrases, email-only links (code via Mailpit), requests, sign-in and the Server tab. */
import { expect, test } from '@playwright/test';
import { OWNER } from '../global-setup';
import { createLink, latestMail, owner, stranger } from './helpers';

test('passphrase: 5 wrong tries destroy the secret, and the sender sees why', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await page.locator('#composer').fill('passphrase canary');
  await page.locator('.cmp-title input').fill('Root recovery codes');
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByRole('switch', { name: 'Passphrase' }).click();
  await page.getByRole('textbox', { name: 'Passphrase' }).fill('copper-lantern-river-42');
  const link = await createLink(page);
  const id = link.split('/s/')[1].split('#')[0];

  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.getByText('Needs a passphrase')).toBeVisible();
  for (const left of [4, 3, 2, 1]) {
    await r.page.locator('#pass').fill(`wrong-${left}`);
    await r.page.getByRole('button', { name: /Reveal secret|Try again/ }).click();
    await expect(r.page.getByRole('alert')).toContainText(`${left} ${left === 1 ? 'try' : 'tries'} left`);
  }
  await r.page.locator('#pass').fill('wrong-final');
  await r.page.getByRole('button', { name: 'Try again' }).click();
  await expect(r.page.getByRole('heading', { name: 'This secret was destroyed' })).toBeVisible();
  await page.goto(`/r/${id}`);
  await expect(page.locator('.status')).toContainText('too many wrong passphrases');
});

test('passphrase: the right one reveals', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await page.locator('#composer').fill('right passphrase canary');
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByRole('switch', { name: 'Passphrase' }).click();
  await page.getByRole('button', { name: 'Generate words' }).click();
  const pass = await page.getByRole('textbox', { name: 'Passphrase' }).inputValue();
  expect(pass).toMatch(/^[a-z-]+-[a-z-]+-[a-z-]+-[a-z-]+-\d\d$/);
  const link = await createLink(page);
  const r = await stranger(browser);
  await r.page.goto(link);
  await r.page.locator('#pass').fill(pass);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toContainText('right passphrase canary');
});

test('email-only: the recipient confirms a 6-digit code from their inbox', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await page.locator('#composer').fill('email canary');
  await page.locator('.cmp-title input').fill('Contract, signed');
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByText('Only a specific email').click();
  const to = `lisa+${Date.now()}@globex.example`;
  await page.getByLabel('Email that can open it').fill(to);
  const link = await createLink(page);
  await expect(page.locator('.facts')).toContainText(`Only ${to}`);

  const since = Date.now() - 1000;
  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.getByText('Sealed for one person')).toBeVisible();
  await expect(r.page.getByText('We just emailed a 6-digit code there.')).toBeVisible();
  const mail = await latestMail(to, since);
  expect(mail.text).not.toContain('Contract, signed');
  expect(mail.text).not.toContain('email canary');
  const code = mail.subject.slice(0, 6);
  expect(code).toMatch(/^\d{6}$/);
  await r.page.locator('#code').fill(code);
  await r.page.getByRole('button', { name: 'Confirm and reveal' }).click();
  await expect(r.page.locator('.out')).toContainText('email canary');
});

test('request → answer → the requester reveals the answer', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/?mode=request');
  await page.getByLabel('What you need').fill('AWS read-only keys');
  await expect(page.getByText('Suggested from your title')).toBeVisible();
  await page.getByRole('button', { name: 'Allow files' }).click();
  await page.locator('#req-message').fill('Read-only on billing is enough.');
  await page.getByRole('button', { name: 'Create request link' }).click();
  await expect(page.locator('.linkbox')).toBeVisible({ timeout: 30_000 });
  const qlink = (await page.locator('.linkbox .url .sr').textContent())!.trim();
  expect(qlink).toMatch(/\/q\/[0-9A-Za-z]{10}#[A-Za-z0-9_-]{32}$/);

  const v = await stranger(browser);
  await v.page.goto(qlink);
  await expect(v.page.getByRole('heading', { name: 'AWS read-only keys' })).toBeVisible();
  await expect(v.page.getByText('Sam Rivera')).toBeVisible();
  await v.page.getByLabel('Access key ID').fill('AKIAIOSFODNN7EXAMPLE');
  await v.page.getByLabel('Secret access key').fill('wJalrXUtnFEMI/K7MDENG');
  await v.page.getByRole('button', { name: 'Add a note or a file' }).click();
  await v.page.locator('input[type=file]').setInputFiles({ name: 'policy.json', mimeType: 'application/json', buffer: Buffer.from('{"ok":true}') });
  await v.page.getByRole('button', { name: /Send to Sam/ }).click();
  await expect(v.page.getByRole('heading', { name: 'Sent to Sam' })).toBeVisible();

  const again = await stranger(browser);
  await again.page.goto(qlink);
  await expect(again.page.getByRole('heading', { name: 'This request was already answered.' })).toBeVisible();

  await page.goto('/links');
  await page.getByRole('tab', { name: /Needs you/ }).click();
  await page.getByRole('button', { name: 'Reveal answer' }).click();
  await expect(page.locator('.out')).toContainText('policy.json');
  await page.getByRole('button', { name: 'Show' }).first().click();
  await expect(page.locator('.out')).toContainText('AKIAIOSFODNN7EXAMPLE');
  await expect(page.locator('.out')).toContainText('policy.json');
});

test('sign in with a password, then sign out', async ({ browser }) => {
  // Its own session: signing out must not end the shared owner session other tests use.
  const { page } = await stranger(browser);
  await page.goto('/signin');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill('nope nope nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('That email and password don’t match.');
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveText('SR');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Account menu' })).not.toHaveText('SR');
});

test('Server tab: limits validate, branding shows to recipients, audit records it', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/server/limits');
  await page.getByLabel('File size').fill('20000');
  await expect(page.getByRole('alert')).toContainText('Use 10,240 MB');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.getByLabel('File size').fill('200');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.goto('/server/branding');
  await page.getByLabel('Name').fill('Globex');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.goto('/');
  await page.locator('#composer').fill('brand canary');
  const link = await createLink(page);
  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.locator('.hd .op-name')).toHaveText('Globex');
  await page.goto('/server/branding');
  await page.getByLabel('Name').fill('Acme');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await page.goto('/server/audit');
  await expect(page.locator('table')).toContainText('Setting changed · file size');
  await expect(page.locator('table')).not.toContainText('brand canary');
});

test('members and visitors get the 404 page for the Server tab', async ({ browser }) => {
  const s = await stranger(browser);
  await s.page.goto('/server');
  await expect(s.page.getByRole('heading', { name: 'There’s nothing at this address' })).toBeVisible();
});

test('API token is shown once', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/tokens');
  await page.getByRole('button', { name: 'New token' }).click();
  await page.getByLabel('Name').fill('CI deploys');
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = (await page.locator('.secret-once span').textContent())!;
  expect(token).toMatch(/^cx_live_/);
  await page.getByRole('button', { name: 'I’ve stored it' }).click();
  await expect(page.locator('table')).toContainText('CI deploys');
  await expect(page.locator('body')).not.toContainText(token);
});
