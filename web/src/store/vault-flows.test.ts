/** The account vault around failures and other accounts (W4, W5, W6, W9, R17): nothing of one account stays open
 *  for the next, a new vault opens even without a device copy, an unknown shared flag writes and deletes nothing. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, unknown>();
const puts: Array<Record<string, unknown>> = [];
let session: { shared?: boolean } | 'offline' = { shared: false };
let deviceKeyFails = false;
let serverItems = new Map<string, string>();
const calls: string[] = [];
let localItems: Array<{ id: string; manage_token: string }> = [];
const attached: string[][] = [];

vi.mock('./db', () => ({
  keys: { get: async (u: string) => kv.get('k' + u), put: async (u: string, w: string) => { kv.set('k' + u, w); }, remove: async (u: string) => { kv.delete('k' + u); } },
  prefs: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => { kv.set(k, v); } },
  localReceipts: { all: async () => localItems, remove: async (id: string) => { localItems = localItems.filter((r) => r.id !== id); } },
}));
vi.mock('../crypto/client', () => ({ argon2: async () => new Uint8Array(32) }));
vi.mock('../api/client', async () => {
  const real = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...real,
    api: async (m: string, p: string, o: { body?: Record<string, unknown>; headers?: Record<string, string> } = {}) => {
      calls.push(`${m} ${p}`);
      if (p === '/me/receipts' && m === 'POST') {
        const items = o.body!.items as Array<{ id: string; manage_token: string }>;
        attached.push(items.map((x) => `${x.id}:${x.manage_token}`));
        return { attached: items.filter((x) => x.id !== 'Local00007').map((x) => x.id) }; // one long gone
      }
      if (p === '/me/vault/keys' && m === 'GET') return { salt: bundle.salt, kdf: bundle.kdf };
      if (p === '/me/vault/unlock') return bundle;
      if (p === '/auth/session') {
        if (session === 'offline') throw new real.ApiError('offline', 0);
        return session;
      }
      if (p === '/me/device-key') {
        if (deviceKeyFails) throw new real.ApiError('internal', 503);
        return { key: 'A'.repeat(43) };
      }
      if (p === '/me/vault/keys' && m === 'PUT') puts.push(o.body!);
      if (p.startsWith('/me/vault/items/') && m === 'PUT') {
        const id = p.split('/').pop()!;
        if (o.headers?.['If-Match'] === '*' && !serverItems.has(id)) throw new real.ApiError('deleted', 412); // as the server: replace only
        serverItems.set(id, o.body!.ct as string);
      }
      if (p.startsWith('/me/vault/items/') && m === 'DELETE') serverItems.delete(p.split('/').pop()!);
      if (p === '/me/vault/items') return { items: [...serverItems].map(([id, ct]) => ({ id, ct })) };
      return undefined;
    },
  };
});

const bundle = { salt: 'AAAAAAAAAAAAAAAAAAAAAA', kdf: { m: 65536, t: 3, p: 1 }, unlock_share: 'A'.repeat(43), vault_pw: null };
const item = (id: string) => ({ id, manage_token: 'MT', title: 't', created_at: '', link: `https://x/s/${id}#KEY`, last_status: 'waiting', fields: 0, files: 0 });

beforeEach(async () => {
  kv.clear();
  puts.length = 0;
  serverItems = new Map();
  calls.length = 0;
  localItems = [];
  attached.length = 0;
  session = { shared: false };
  deviceKeyFails = false;
  (await import('./vault')).lockVault();
});

describe('account vault', () => {
  it('makes a new vault, wrapped for the password only, even when this browser can\'t keep a copy', async () => {
    const v = await import('./vault');
    deviceKeyFails = true;
    await v.openAfterSignIn('u1', new Uint8Array(32), bundle, { shared: false });
    expect(Object.keys(puts[0])).toEqual(['vault_pw']);
    expect(v.vault.value.state).toBe('ready');
    expect(v.vaultItems.isOpen()).toBe(true);
    expect(kv.has('ku1')).toBe(false);
  });

  it('forgets one account\'s vault before another account\'s opens', async () => {
    const v = await import('./vault');
    await v.openAfterSignIn('userA', new Uint8Array(32), bundle, { shared: true });
    await v.vaultItems.put(item('Secret0001'));
    expect((await v.vaultItems.get('Secret0001'))?.link).toContain('#');
    // An invite or reset link signs userB in, in the same tab: userB's new vault opens, and userA's items don't.
    await v.openAfterSignIn('userB', new Uint8Array(32), bundle, { shared: true });
    expect(await v.vaultItems.get('Secret0001')).toBeUndefined();
    expect(v.vault.value.state).toBe('ready');
  });

  it('signing out drops this browser\'s copy of the vault key and forgets the key in this tab', async () => {
    const v = await import('./vault');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    await v.openAfterSignIn('u1', new Uint8Array(32), bundle, { shared: false });
    expect(kv.has('ku1')).toBe(true);
    await v.signOut('u1');
    expect(kv.has('ku1')).toBe(false);
    expect(v.vaultItems.isOpen()).toBe(false);
    expect(v.vault.value.state).toBe('off');
    expect(calls).toContain('POST /auth/logout');
    expect(assign).toHaveBeenCalledWith('/'); // the page loads afresh
    vi.unstubAllGlobals();
  });

  it('writes nothing and deletes nothing while the shared flag is unknown', async () => {
    const v = await import('./vault');
    kv.set('ku1', 'an older copy');
    await v.openAfterSignIn('u1', new Uint8Array(32), bundle, { shared: null });
    expect(kv.get('ku1')).toBe('an older copy'); // not deleted, not replaced
    expect(v.mayKeepOnDevice()).toBe(false);
    session = 'offline';
    v.lockVault();
    await v.syncVault('u1');
    expect(kv.has('ku1')).toBe(true);
    await v.noteSession('u1', true); // nothing open: nothing to do
    expect(kv.has('ku1')).toBe(true);
  });

  it('keeps a copy once the server says the session isn\'t shared, and drops it if it is', async () => {
    const v = await import('./vault');
    await v.openAfterSignIn('u1', new Uint8Array(32), bundle, { shared: null });
    expect(kv.has('ku1')).toBe(false);
    await v.noteSession('u1', false);
    expect(kv.has('ku1')).toBe(true);
    await v.noteSession('u1', true);
    expect(kv.has('ku1')).toBe(false);
  });

  it('drops a device copy of an older vault (the password was reset since) and asks for the password', async () => {
    const v = await import('./vault');
    await v.openAfterSignIn('u1', new Uint8Array(32), bundle, { shared: false }); // vault 1, copy kept here
    serverItems.set('Secret0002', 'v1.AAAAAAAAAAAAAAAA.' + 'B'.repeat(40)); // made with another vault key
    v.lockVault();
    await v.syncVault('u1');
    expect(v.vault.value.state).toBe('ready'); // opened from the device copy
    await expect(v.vaultItems.all()).rejects.toThrow('locked');
    expect(v.vault.value.state).toBe('locked');
    expect(kv.has('ku1')).toBe(false);
  });

  it('refuses account KDF settings weaker than its own', async () => {
    const v = await import('./vault');
    for (const kdf of [{ m: 1024, t: 3, p: 1 }, { m: 65536, t: 1, p: 1 }, { m: 65536, t: 3, p: 0 }, { m: 65536.5, t: 3, p: 1 }, null]) {
      await expect(v.deriveAccount('pw', bundle.salt, kdf as never), JSON.stringify(kdf)).rejects.toThrow('weak_kdf');
    }
    await expect(v.deriveAccount('pw', bundle.salt, { m: 131072, t: 4, p: 2 })).resolves.toHaveProperty('authKey');
  });

  it('adds links sent from this browser to the account: proven to the server first, then into the vault (Q1)', async () => {
    const v = await import('./vault');
    localItems = Array.from({ length: 201 }, (_, i) => item(`Local${String(i).padStart(5, '0')}`));
    await v.openAfterSignIn('u1', new Uint8Array(32), bundle, { shared: false });
    expect(v.adoptOffer.value).toBe(201);
    await v.adoptLocal();
    expect(attached.map((a) => a.length)).toEqual([200, 1]); // at most 200 a request
    expect(attached[0][0]).toBe('Local00000:MT');
    expect(calls.indexOf('POST /me/receipts')).toBeLessThan(calls.indexOf('PUT /me/vault/items/Local00000'));
    expect(serverItems.size).toBe(200);
    expect(localItems.map((x) => x.id)).toEqual(['Local00007']); // the server didn't take it: it stays here
    expect(v.adoptOffer.value).toBe(0);
    expect(kv.get('adopt_skip|u1')).toEqual(['Local00007']); // and isn't offered again
  });
  it('doesn\'t write back a link another device deleted after this one read it (Clear expired, Delete)', async () => {
    const v = await import('./vault');
    await v.openAfterSignIn('u1', new Uint8Array(32), bundle, { shared: false });
    await v.vaultItems.put(item('Secret0001'));
    const read = (await v.vaultItems.get('Secret0001'))!; // this tab reads it (Your links' status read)...
    serverItems.delete('Secret0001'); // ...another device deletes it...
    await v.vaultItems.put({ ...read, last_status: 'expired' }, true); // ...and this tab saves the newer status
    expect(serverItems.has('Secret0001')).toBe(false);
    expect(await v.vaultItems.get('Secret0001')).toBeUndefined();
    await v.vaultItems.put(item('Secret0002')); // a new link is still added
    expect(serverItems.has('Secret0002')).toBe(true);
  });
});
