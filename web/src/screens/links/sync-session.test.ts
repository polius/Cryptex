/** C1 (round 3): Your links refreshes while signed in on a shared computer, and the session ends while the status
 *  lookup is in flight (the vault locks, and the page is about to reload). Writing the new status afterwards must not
 *  put the account's item (link and manage token) in this browser's IndexedDB. Real store/db.ts over an in-memory
 *  IndexedDB. */
import { describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB, stores } from '../../store/fake-idb';

installFakeIndexedDB();
const s = { open: true };
const item = { id: 'AAAAAAAAAA', manage_token: 'MANAGE', title: 'prod', created_at: '2026-10-28T00:00:00Z', link: 'https://x/s/AAAAAAAAAA#KKKKKKKKKKKKKKKKKKKKKK',
  last_status: 'waiting', fields: 0, files: 0, views: null };
const vaultPuts: string[] = [];

vi.mock('../../store/vault', () => ({
  mayKeepOnDevice: () => false, // a shared computer (and, after lockVault, unknown)
  vaultItems: {
    isOpen: () => s.open,
    all: async () => [item],
    get: async () => (s.open ? item : undefined),
    put: async (r: { id: string }) => {
      if (!s.open) throw new Error('locked');
      vaultPuts.push(r.id);
    },
  },
}));
vi.mock('../../lib/state', async () => {
  const { signal } = await import('@preact/signals');
  return { config: signal({ signed_in: true }), setLinksCount: () => undefined };
});
vi.mock('../../api/client', async () => {
  const real = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return {
    ...real,
    signedInUid: () => 'u1',
    api: async (_m: string, p: string) => {
      if (p === '/receipts/lookup') {
        s.open = false; // the session ended meanwhile: lockVault(), then a reload
        return { items: [{ id: item.id, status: 'opened', max_views: null, views_left: null, views: 1 }] };
      }
      return { items: [] };
    },
  };
});

describe('Your links refreshing while the session ends', () => {
  it('writes the account\'s link nowhere', async () => {
    const { loadRows } = await import('./sync');
    await loadRows();
    expect([...(stores.get('receipts')?.values() ?? [])]).toEqual([]);
    expect(vaultPuts).toEqual([]);
  });
});
