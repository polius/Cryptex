/** C2 (round 3): this tab is signed in as A, and an invite link, a reset link or /signin makes a session for B in the
 *  same browser. B's first vault requests must go as B (the server refuses a claimed account that isn't the
 *  cookie's), and A's other tabs are told. Real api/client.ts, lib/state.ts and store/vault.ts. */
import { describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from './fake-idb';

installFakeIndexedDB();
vi.mock('../crypto/client', () => ({ argon2: async () => new Uint8Array(32) }));

const seen: string[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
(globalThis as { fetch: unknown }).fetch = async (url: string, init: { method: string; headers: Record<string, string> }) => {
  const who = init.headers['X-Cryptex-User'];
  seen.push(`${init.method} ${url} as ${who ?? '-'}`);
  // The server (deps.caller): the cookie is B's session now, so a request that says it's from A is refused.
  if (who && who !== 'B') return json(401, { error: { code: 'sign_in_required', reason: 'ended' } });
  if (url.endsWith('/auth/session')) return json(200, { user: { id: 'B' }, shared: false });
  if (url.endsWith('/me/device-key')) return json(200, { key: 'A'.repeat(43) });
  return new Response(null, { status: 204 });
};
(globalThis as { document?: unknown }).document = { title: '', querySelector: () => null, head: { appendChild() {} }, documentElement: { setAttribute() {} }, addEventListener() {} };
(globalThis as { location?: unknown }).location = { pathname: '/invite', origin: 'https://cx.example' };
const posted: unknown[] = []; // this browser's other tabs (BroadcastChannel 'cryptex')
(globalThis as { window?: unknown }).window = {};
(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = class { postMessage(m: unknown) { posted.push(m); } addEventListener() {} };

const bundle = { salt: 'AAAAAAAAAAAAAAAAAAAAAA', kdf: { m: 65536, t: 3, p: 1 }, unlock_share: 'A'.repeat(43), vault_pw: null };

describe('signing in as someone else in a tab signed in as A', () => {
  it('opens B\'s vault as B, and tells A\'s other tabs', async () => {
    const client = await import('../api/client');
    const v = await import('./vault');
    client.setSignedInAs('A'); // what this tab believed before the invite page signed B in
    await v.openAfterSignIn('B', new Uint8Array(32), bundle, { shared: false, authKey: 'x'.repeat(43) });
    expect(seen.filter((r) => r.includes(' as A'))).toEqual([]);
    expect(seen.some((r) => r.startsWith('PUT /api/v1/me/vault/keys as B'))).toBe(true);
    expect(client.signedInUid()).toBe('B');
    expect(v.vault.value.state).toBe('ready'); // B's new vault
    expect(posted).toEqual([{ type: 'signed-out', uid: 'A' }]); // A's other tabs reload
  });
});
