// @vitest-environment jsdom
/** F3 (round 4): /r/:id opened while the vault is locked (a reload on a shared computer: the unlock prompt is up)
 *  doesn't find the link, so the page says "not found". Once the vault opens it's found: the old code kept saying
 *  "not found", since nothing reset it. */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '../../store/fake-idb';

installFakeIndexedDB();
const item = { id: 'AAAAAAAAAA', manage_token: 'MANAGE', title: 'prod db', created_at: '2026-10-28T00:00:00Z',
  link: 'https://x/s/AAAAAAAAAA#KKKKKKKKKKKKKKKKKKKKKK', last_status: 'waiting', fields: 1, files: 0, views: null };
const s = { open: false };
vi.mock('../../store/vault', async () => {
  const { signal } = await import('@preact/signals');
  return {
    vault: signal({ state: 'locked' }), adoptOffer: signal(0), mayKeepOnDevice: () => false,
    vaultItems: { isOpen: () => s.open, all: async () => [item], get: async () => (s.open ? item : undefined), put: async () => undefined },
  };
});
vi.mock('../../api/client', async () => {
  const real = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return {
    ...real,
    signedInUid: () => 'A',
    api: async (_m: string, p: string, o: { headers?: Record<string, string> } = {}) => {
      if (p === '/me/requests') return { items: [] };
      if (p.startsWith('/receipts/') && !o.headers?.Authorization) throw new real.ApiError('not_found', 404);
      if (p.startsWith('/receipts/')) return { id: item.id, status: 'waiting', max_views: null, views_left: null, views: 0, expires_at: '2030-01-01T00:00:00Z', events: [] };
      return {};
    },
  };
});
const tick = () => new Promise<void>((r) => setTimeout(r, 30));

describe('a link\'s page while the vault is locked', () => {
  it('shows the link once the vault opens', async () => {
    const { config } = await import('../../lib/state');
    (config as { value: unknown }).value = { signed_in: true, demo: false, brand: { name: '' }, user: { id: 'A', username: 'alice', role: 'member' }, mode: 'anyone', features: { sign_in: true }, limits: {}, defaults: {} };
    const { Receipt } = await import('./Receipt');
    const v = await import('../../store/vault');
    const root = document.createElement('div');
    document.body.append(root);
    await act(() => render(<Receipt id={item.id} />, root));
    await act(tick);
    expect(root.querySelector('h1')?.textContent).toBe('There’s nothing at this address.');
    s.open = true;
    await act(() => { (v.vault as { value: unknown }).value = { state: 'ready' }; });
    await act(tick);
    await act(tick);
    expect(root.querySelector('h1')?.textContent).toContain('prod db');
    render(null, root);
  });
});
