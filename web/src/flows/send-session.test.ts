/** C1 (round 3): signed in on a shared computer, the session ends while a link uploads (signed out in another tab,
 *  the shared session's 12 hours). The link and its manage token must not land in this browser for the next person:
 *  whose link it is, and whether this browser may keep it, are decided when the send starts. Real store/db.ts over
 *  an in-memory IndexedDB. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB, stores } from '../store/fake-idb';

installFakeIndexedDB();
const s = { open: true, shared: true, endAt: '/chunks/' };

vi.mock('../store/vault', () => ({
  mayKeepOnDevice: () => s.open && !s.shared, // lockVault() forgets the shared flag: null, so false
  vaultItems: {
    isOpen: () => s.open,
    get: async () => undefined,
    put: async () => {
      if (!s.open) throw new Error('locked');
    },
  },
}));
vi.mock('../crypto/client', async () => {
  const f = await import('../crypto/format');
  return {
    encrypt: async (key: Uint8Array, id: string, st: number, prefix: Uint8Array, i: number, last: boolean, data: ArrayBuffer) =>
      f.encryptChunk(await f.streamKey(key, 'encrypt'), id, st, prefix, i, last, new Uint8Array(data)),
    argon2: async () => new Uint8Array(32),
  };
});
vi.mock('../api/client', async () => {
  const real = await vi.importActual<typeof import('../api/client')>('../api/client');
  const end = () => {
    s.open = false; // lockVault(), before the page reloads
  };
  return {
    ...real,
    signedInUid: () => 'u1',
    api: async (_m: string, p: string) => {
      if (p.includes(s.endAt)) end();
      return p === '/secrets' ? { id: 'AAAAAAAAAA', upload_token: 'u', manage_token: 'MANAGE', expires_at: '2030-01-01T00:00:00Z' } : undefined;
    },
    request: async (_m: string, p: string) => {
      if (p.includes(s.endAt)) end();
      return new Response(null, { status: 204 });
    },
  };
});

const send = async () => {
  (globalThis as { location?: unknown }).location = { origin: 'https://cx.example' };
  const { sendSecret } = await import('./send');
  return sendSecret({ demo: false, brand: { name: '' } } as never, { title: 'prod db', items: [{ t: 'note', v: 'hunter2' }], files: [] },
    { views: null, expires_in: 3600 }, () => {});
};
const kept = () => [...(stores.get('receipts')?.values() ?? [])];

beforeEach(() => {
  stores.get('receipts')?.clear();
  Object.assign(s, { open: true, shared: true, endAt: '/chunks/' });
});

describe('the session ends while a link is sent', () => {
  it('keeps nothing in this browser on a shared computer, and says the link was saved nowhere', async () => {
    const sent = await send();
    expect(sent.saved).toBe('none');
    expect(kept()).toEqual([]);
    expect(sent.link).toMatch(/#[A-Za-z0-9_-]{22}$/);
  });

  it('keeps nothing in this browser either when it may keep things: the vault was locked', async () => {
    s.shared = false;
    expect((await send()).saved).toBe('none');
    expect(kept()).toEqual([]);
  });

  it('still saves to the account when nothing ended', async () => {
    s.endAt = '/never/';
    expect((await send()).saved).toBe('ok');
    expect(kept()).toEqual([]); // the account's vault took it, not this browser
  });
});
