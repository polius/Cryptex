/** Claims the fresh server once (setup code from compose.yml) and saves the owner's session for tests. */
import { request, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';

export const OWNER = { email: 'sam@acme.example', name: 'Sam Rivera', password: 'correct horse battery staple' };
export const STATE = '.auth/owner.json';

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects.find((p) => p.name === 'flows')!.use.baseURL!;
  const ctx = await request.newContext({ baseURL });
  const setup = await (await ctx.get('/api/v1/setup')).json();
  let csrf: string;
  if (setup.needed) {
    const r = await ctx.post('/api/v1/setup/owner', { data: { setup_code: 'E2E-SETUP-CODE', ...OWNER } });
    if (!r.ok()) throw new Error(`setup failed: ${r.status()} ${await r.text()}`);
    csrf = (await r.json()).csrf;
    await ctx.post('/api/v1/setup/brand', { data: { name: 'Acme' }, headers: { 'X-CSRF': csrf } });
    await ctx.post('/api/v1/setup/access', { data: { mode: 'anyone' }, headers: { 'X-CSRF': csrf } });
  } else {
    const r = await ctx.post('/api/v1/auth/login', { data: { email: OWNER.email, password: OWNER.password } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
  }
  mkdirSync('.auth', { recursive: true });
  await ctx.storageState({ path: STATE });
  await ctx.dispose();
}
