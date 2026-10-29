/** The session ending elsewhere reloads the page (lib/state.ts): on a 401 `ended` to a request sent as the signed-in
 *  person (so a link is never made without the account behind it), on another tab's sign-out message, or when the
 *  tab is shown again and the server names someone else. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let listeners: Record<string, (e: unknown) => void> = {};
const reload = vi.fn();
let sessionUser: string | null = 'A';
vi.stubGlobal('window', {});
vi.stubGlobal('BroadcastChannel', class { postMessage() {} addEventListener(_t: string, fn: (e: unknown) => void) { listeners.message = fn; } });
vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; } });
vi.stubGlobal('location', { reload });
vi.stubGlobal('fetch', async (url: string) => {
  const body = url.endsWith('/auth/session') ? { user: sessionUser && { id: sessionUser } } : { error: { code: 'sign_in_required', reason: 'ended' } };
  return new Response(JSON.stringify(body), { status: url.endsWith('/auth/session') ? 200 : 401, headers: { 'content-type': 'application/json' } });
});

beforeEach(async () => {
  reload.mockClear();
  (await import('../api/client')).setSignedInAs('A');
});

describe('a session that ended elsewhere', () => {
  it('a create refused with 401 ended reloads the page', async () => {
    await import('./state');
    const { api } = await import('../api/client');
    await expect(api('POST', '/secrets', { body: {} })).rejects.toMatchObject({ code: 'sign_in_required' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('another tab\'s sign-out of this account reloads; of another account, doesn\'t', async () => {
    await import('./state');
    listeners.message({ data: { type: 'signed-out', uid: 'B' } });
    expect(reload).not.toHaveBeenCalled();
    listeners.message({ data: { type: 'signed-out', uid: 'A' } });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shown again, it reloads only if the server names someone else or nobody', async () => {
    const { checkSession } = await import('./state');
    await checkSession();
    expect(reload).not.toHaveBeenCalled();
    sessionUser = null;
    await checkSession();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(listeners.visibilitychange).toBeTypeOf('function');
  });
});
