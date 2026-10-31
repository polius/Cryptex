/** Claims the fresh server once (setup code that compose.yml puts in its data folder) and saves the owner's session for tests.
 *  The owner then signs in once through the page itself, so the saved state holds this browser's
 *  locked copy of the vault key (IndexedDB) and tests start with Your links unlocked. */
import { chromium, request, type FullConfig } from '@playwright/test';
import { argon2id } from 'hash-wasm';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { totp, withCode } from './totp';

export const OWNER = { username: 'sam', password: 'correct horse battery staple' };
export const OWNER_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DP';
export const STATE = '.auth/owner.json';

/** The browser's derivation (web/src/store/vault.ts): Argon2id, then HMAC; only the auth key is sent. */
export async function authKey(password: string, salt: string, kdf = { m: 65536, t: 3, p: 1 }): Promise<string> {
  const master = await argon2id({ password, salt: Buffer.from(salt, 'base64url'), memorySize: kdf.m, iterations: kdf.t, parallelism: kdf.p, hashLength: 32, outputType: 'binary' });
  return createHmac('sha256', Buffer.from(master)).update('cryptex/v1/account|auth').digest('base64url');
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects.find((p) => p.name === 'flows')!.use.baseURL!;
  const ctx = await request.newContext({ baseURL });
  const setup = await (await ctx.get('/api/v1/setup')).json();
  if (setup.needed) {
    const salt = randomBytes(16).toString('base64url');
    const r = await ctx.post('/api/v1/setup', {
      data: { setup_code: 'E2E-SETUP-CODE', username: OWNER.username, salt, auth_key: await authKey(OWNER.password, salt), brand_name: 'Acme', access: 'anyone' },
    });
    if (!r.ok()) throw new Error(`setup failed: ${r.status()} ${await r.text()}`);
    const { csrf } = await r.json(); // then 2FA on, as from Your account (a new session may start it)
    const on = await ctx.put('/api/v1/me/totp', { data: { secret: OWNER_TOTP, code: totp(OWNER_TOTP) }, headers: { 'X-CSRF': csrf } });
    if (!on.ok()) throw new Error(`2FA failed: ${on.status()} ${await on.text()}`);
  }
  await ctx.dispose();

  // Sign in through the page: it derives the keys, opens (or makes) the vault and keeps it on this "device".
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  await page.goto('/signin');
  await page.getByLabel('Username', { exact: true }).fill(OWNER.username);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  // exact: the code step also has "Back to sign in".
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await withCode(OWNER_TOTP, async (code) => {
    await page.getByLabel('2FA code').fill(code);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    return page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 15_000 }).then(() => true, () => false);
  });
  await page.getByRole('button', { name: 'Account menu' }).waitFor();
  mkdirSync('.auth', { recursive: true });
  await page.context().storageState({ path: STATE, indexedDB: true });
  await browser.close();
}
