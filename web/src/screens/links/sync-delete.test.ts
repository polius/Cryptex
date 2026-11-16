/** Your links reads the statuses while a link is deleted (Delete, or Clear expired): when the read ends, its newer
 *  status must not write the deleted link back into the account's vault. */
import { describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '../../store/fake-idb';

installFakeIndexedDB();
const item = { id: 'AAAAAAAAAA', manage_token: 'MANAGE', title: 'prod', created_at: '2026-10-28T00:00:00Z', link: 'https://x/s/AAAAAAAAAA#KKKKKKKKKKKKKKKKKKKKKK',
  last_status: 'waiting', fields: 0, files: 0, views: null };
const vault = new Map<string, unknown>([[item.id, item]]);
let started: () => void = () => undefined;
const lookupStarted = new Promise<void>((r) => (started = r));
let answer: () => void = () => undefined;

vi.mock('../../store/vault', () => ({
  mayKeepOnDevice: () => false,
  vaultItems: {
    isOpen: () => true,
    all: async () => [...vault.values()],
    get: async (id: string) => vault.get(id),
    put: async (r: { id: string }) => void vault.set(r.id, r),
    remove: async (id: string) => void vault.delete(id),
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
        started();
        await new Promise<void>((done) => (answer = done)); // answers once the test says so
        return { items: [{ id: item.id, status: 'expired', max_views: null, views_left: null, views: 0 }] };
      }
      return { items: [] };
    },
  };
});

describe('deleting a link while Your links reads the statuses', () => {
  it('keeps it deleted', async () => {
    const { deleteRow, loadRows } = await import('./sync');
    const reading = loadRows();
    await lookupStarted;
    const deleting = deleteRow({ local: item as never, remote: { id: item.id, status: 'expired' } as never, id: item.id });
    answer();
    await Promise.all([reading, deleting]);
    expect(vault.has(item.id)).toBe(false);
  });
});
