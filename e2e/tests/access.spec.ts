/** Passphrases, sign-in with 2FA, shared computers, the vault, invites and the Server tab. */
import { expect, test, type Page } from '@playwright/test';
import { OWNER, OWNER_TOTP } from '../global-setup';
import { totp, withCode } from '../totp';
import { createLink, fake, fakeFreshServer, FIXED_TOTP, owner, sendText, stranger } from './helpers';

test('passphrase: 5 wrong tries destroy the secret, and the sender sees why', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/');
  await page.locator('#composer').fill('passphrase canary');
  await page.locator('.cmp-title input').fill('Root recovery codes');
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByRole('checkbox', { name: /Ask for a passphrase/ }).check();
  await page.getByLabel('Passphrase', { exact: true }).fill('copper-lantern-river-42');
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
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByRole('checkbox', { name: /Ask for a passphrase/ }).check();
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveValue(''); // nothing is filled in until asked
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const box = page.getByLabel('Passphrase', { exact: true });
  await expect(box).toHaveValue(/^[A-HJ-NP-Za-km-z2-9#%+\-=@_]{20}$/);
  const pass = await box.inputValue();
  const link = await createLink(page);
  const r = await stranger(browser);
  await r.page.goto(link);
  await r.page.locator('#pass').fill(pass);
  // Enter twice asks the server once: the one-time secret stays on screen, not "already opened".
  await r.page.locator('#pass').focus();
  await r.page.keyboard.press('Enter');
  await r.page.keyboard.press('Enter');
  await expect(r.page.locator('.out')).toContainText('right passphrase canary');
  await r.page.waitForTimeout(500);
  await expect(r.page.locator('.out')).toContainText('right passphrase canary');
});

test('sign in with a password, then sign out', async ({ browser }) => {
  // Its own session: signing out must not end the shared owner session other tests use.
  const { page } = await stranger(browser);
  await page.goto('/signin');
  await page.getByLabel('Username', { exact: true }).fill(OWNER.username);
  await page.getByLabel('Password', { exact: true }).fill('nope nope nope');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('That username and password don’t match.');
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await signInCode(page, OWNER_TOTP);
  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveText('S');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Account menu' })).not.toHaveText('S');
});

/** Second sign-in step; retries on the next 30-second step if this code was already used. */
async function signInCode(page: Page, secret: string) {
  await withCode(secret, async (code) => {
    await page.getByLabel('2FA code').fill(code);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    return page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 3000 }).then(() => true, () => false);
  });
}

async function signInPassword(page: Page, opts: { shared?: boolean } = {}) {
  await page.goto('/signin');
  await page.getByLabel('Username', { exact: true }).fill(OWNER.username);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  if (opts.shared) await page.getByRole('checkbox', { name: /This is a shared computer/ }).check();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await signInCode(page, OWNER_TOTP);
}

/** How many vault-key copies this browser keeps (IndexedDB cryptex → keys). */
const keptKeys = (page: Page) => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const r = indexedDB.open('cryptex');
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const q = r.result.transaction('keys').objectStore('keys').count();
    q.onsuccess = () => resolve(q.result);
  };
}));

test('a shared computer keeps nothing, even after a reload, and never takes this browser\'s links', async ({ browser }) => {
  const { page } = await stranger(browser);
  await sendText(page, 'left by someone else'); // an anonymous link already in this browser
  await signInPassword(page, { shared: true });
  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveText('S');
  await expect(page.getByRole('heading', { name: 'Add links from this browser to your account?' })).toBeHidden();
  expect(await keptKeys(page)).toBe(0);
  // The server remembers the choice: after a reload the vault asks for the password again.
  await page.reload();
  const unlock = page.getByRole('dialog');
  await expect(unlock.getByRole('heading', { name: 'Unlock your links' })).toBeVisible();
  // A wrong password is refused by the server before it's used as a key.
  await unlock.getByLabel('Password', { exact: true }).fill('not the password');
  await unlock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(unlock.getByRole('alert')).toContainText('That password didn’t work.');
  await unlock.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await unlock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your links' })).toBeHidden();
  expect(await keptKeys(page)).toBe(0);
});

test('signing in asks before adding this browser\'s links to the account', async ({ browser }) => {
  const { page } = await stranger(browser);
  await sendText(page, 'adopt canary', 'Sent before signing in');
  await signInPassword(page);
  const ask = page.getByRole('dialog');
  await expect(ask.getByRole('heading', { name: 'Add links from this browser to your account?' })).toBeVisible();
  await ask.getByRole('button', { name: 'Add to my account' }).click();
  await expect(ask).toBeHidden();
  await page.goto('/links');
  await expect(page.locator('.rows')).toContainText('Sent before signing in');
});

test('the 2FA step has a way back, and says why a code failed', async ({ browser }) => {
  const { page } = await stranger(browser);
  await page.goto('/signin');
  await page.getByLabel('Username', { exact: true }).fill(OWNER.username);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('2FA code')).toBeFocused(); // the step changes in place: focus moves with it
  await page.getByLabel('2FA code').fill('000000');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('That code didn’t work.');
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused(); // the username is still filled in
  await expect(page.getByText('No account, or locked out?')).toBeVisible();
  // Anyone can send on this server: the page offers a way to do that without an account.
  await page.getByRole('link', { name: 'Send without signing in' }).click();
  await expect(page.getByRole('heading', { name: 'Send a secret' })).toBeVisible();
});

test('the last wrong 2FA code goes back to the password step and says why', async ({ browser }) => {
  const { page } = await stranger(browser);
  await page.goto('/signin');
  await page.getByLabel('Username', { exact: true }).fill(OWNER.username);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('2FA code')).toBeVisible();
  // The server's answer to the ticket's last wrong code (faked: real wrong codes count against the account's limit).
  await fake(page, '/auth/login/totp', 400, { error: { code: 'wrong_code', message: 'That code didn’t work.', tries_left: 0 } });
  await page.getByLabel('2FA code').fill('000000');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('that was the last try');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue(OWNER.username);
});

test('setup checks the code first, keeps every answer through Back, and saves it all at Finish', async ({ browser }) => {
  const { page } = await stranger(browser);
  await fakeFreshServer(page);
  let finished: Record<string, unknown> | null = null;
  await page.route('**/api/v1/setup', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    finished = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 409, json: { error: { code: 'setup_done', message: 'Setup is already finished.' } } });
  });
  await fake(page, '/setup/check', 400, { error: { code: 'invalid', field: 'setup_code', message: 'That setup code isn’t right.' } });
  await page.goto('/setup');
  await page.getByLabel('Setup code').fill('WRONG-CODE');
  await page.getByLabel('Username', { exact: true }).fill('sam');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#code-err')).toContainText('That setup code isn’t right.');
  await page.unroute('**/api/v1/setup/check');
  await fake(page, '/setup/check', 204);
  await page.getByLabel('Setup code').fill('E2E-SETUP-CODE');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel(/Organization name/).fill('Globex');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review and finish' })).toBeVisible();
  await page.locator('.summary').getByRole('button', { name: 'Change' }).first().click();
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('sam'); // everything as typed
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('correct horse battery staple');
  await page.getByLabel('Username', { exact: true }).fill('kim');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.summary')).toContainText('kim');
  expect(finished).toBeNull(); // nothing saved before Finish
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Setup is already finished.')).toBeVisible();
  expect(finished).toMatchObject({ setup_code: 'E2E-SETUP-CODE', username: 'kim', brand_name: 'Globex', access: 'signed_in' });
  expect(finished).not.toHaveProperty('password');
});

test('a reset link sends the shared-computer choice, and says when the code was wrong too often', async ({ browser }) => {
  const { page } = await stranger(browser);
  await fake(page, '/auth/reset', 200, { username: 'lisa', by: 'sam', expires_at: '2030-01-01T12:00:00Z', tries_left: 1, ...FIXED_TOTP });
  let sent: Record<string, unknown> = {};
  await page.route('**/api/v1/auth/reset/accept', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 410, json: { error: { code: 'gone', reason: 'reset_tries', message: 'Too many wrong codes.' } } });
  });
  await page.goto('/reset#a-reset-token');
  await page.getByLabel('Code', { exact: true }).fill('K7QP-2VR9');
  await page.getByLabel('New password').fill('lisa long passphrase');
  await page.getByRole('checkbox', { name: /Use 2FA/ }).uncheck();
  await page.getByRole('checkbox', { name: /This is a shared computer/ }).check();
  await page.getByRole('button', { name: 'Save and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
  await expect(page.getByText('The code was entered wrong too many times')).toBeVisible();
  expect(sent.shared).toBe(true);
});

test('an invite link sets a password and 2FA', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/server/access');
  await page.getByRole('button', { name: 'Add person' }).click();
  const username = `lisa${Date.now() % 1e6}`;
  await page.getByRole('dialog').getByLabel('Username', { exact: true }).fill(username);
  // The server asks to confirm identity once (as it does 5 minutes after signing in; forced here, so this always runs).
  let asked = false;
  await page.route('**/api/v1/server/users', (route) => {
    if (asked || route.request().method() !== 'POST') return route.fallback();
    asked = true;
    return route.fulfill({ status: 403, json: { error: { code: 'reauth_required', message: 'Confirm it’s you to make this change.' } } });
  });
  await page.getByRole('button', { name: 'Add and get invite link' }).click();
  await expect(page.locator('#reauth-title')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(1); // no hidden twin for Enter
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await withCode(OWNER_TOTP, async (code) => {
    await page.getByLabel('2FA code').fill(code);
    await page.getByLabel('2FA code').press('Enter'); // the footer's Confirm submits the form
    return page.locator('#inv-title').waitFor({ timeout: 3000 }).then(() => true, () => false);
  });
  const invite = (await page.locator('.linkbox .url').textContent())!.trim();
  expect(invite).toContain('/invite#');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add person' })).toBeFocused(); // back where it started
  await expect(page.locator('table')).toContainText(username);

  // The invited person sets a password and an authenticator app.
  const lisa = await stranger(browser);
  await lisa.page.goto(invite);
  await expect(lisa.page.getByRole('heading', { name: `Welcome, ${username}` })).toBeVisible();
  await expect(lisa.page).toHaveURL(/\/invite$/); // the token left the address bar
  await lisa.page.getByLabel('Password', { exact: true }).fill('lisa long passphrase');
  const secret = (await lisa.page.locator('.totp-key .key').textContent())!.replace(/\s/g, '');
  await lisa.page.locator('#totp-code').fill(totp(secret));
  await lisa.page.getByRole('button', { name: 'Create account' }).click();
  // A new account gets its vault without a step to answer: straight in.
  await expect(lisa.page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 15_000 });
  await expect(lisa.page.getByRole('dialog')).toHaveCount(0);
  await lisa.ctx.close();
  // The link works once.
  const again = await stranger(browser);
  await again.page.goto(invite);
  await expect(again.page.getByRole('heading', { name: 'This invite link doesn’t work' })).toBeVisible();
  await expect(again.page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible(); // a way on

});

test('Server tab: limits validate, branding shows to recipients, audit records it', async ({ browser }) => {
  const { page } = await owner(browser);
  await page.goto('/server/limits');
  await page.getByLabel('Longest expiry').fill('40000');
  await expect(page.getByRole('alert')).toContainText('Use 36,500 days or less.');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.getByLabel('Longest expiry').fill('7');
  await page.getByLabel('File size').fill('200');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.goto('/server/branding');
  await page.getByLabel('Name', { exact: true }).fill('Globex');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused(); // the bar went away: focus is back on the field
  await page.goto('/');
  await page.locator('#composer').fill('brand canary');
  const link = await createLink(page);
  const r = await stranger(browser);
  await r.page.goto(link);
  await expect(r.page.locator('.hd .op-name')).toHaveText('Globex');
  await page.goto('/server/branding');
  await page.getByLabel('Name', { exact: true }).fill('Acme');
  await page.getByRole('button', { name: 'Save changes' }).click();

  // Language saves like Limits and Branding: nothing changes until Save.
  await page.goto('/server/language');
  await page.getByText('Always the same language').click();
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toBeHidden();
  await expect(page.getByRole('radio', { checked: true })).toBeFocused();

  await page.goto('/server/audit');
  await expect(page.getByText('Kept 365 days', { exact: false })).toBeVisible(); // the real retention setting
  await expect(page.locator('table')).toContainText('Setting changed · file size 100 MB → 200 MB');
  await expect(page.locator('table')).not.toContainText('brand canary');
});

test('members and visitors get the 404 page for the Server tab', async ({ browser }) => {
  const s = await stranger(browser);
  await s.page.goto('/server');
  await expect(s.page.getByRole('heading', { name: 'There’s nothing at this address' })).toBeVisible();
});
