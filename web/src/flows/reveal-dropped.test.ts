// @vitest-environment jsdom
/** F9 (round 4): POST /reveal counts the view; if its answer is lost (the connection dropped), a later "already
 *  opened" must not blame someone else. The tab notes that it asked before asking, and forgets it only when the
 *  server said no (nothing counted) or once the answer arrived (then it's "opened here"). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';

let reply: () => unknown = () => ({});
vi.mock('../api/client', async () => {
  const real = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...real, api: async () => reply() };
});
vi.mock('../crypto/client', () => ({ argon2: async () => new Uint8Array(32) }));

const opened = { meta: { passphrase: false }, keys: { revealToken: new Uint8Array(32), contentKey: new Uint8Array(32) } } as never;
const ok = { read_session: 'R', views_left: 0, streams: [{ stream: 0, prefix: 'AAAAAAAAAA', chunks: 1, size: 16 }] };

beforeEach(() => sessionStorage.clear());

describe('a reveal whose answer was lost', () => {
  it('is remembered as asked here, so a later "already opened" points to this tab', async () => {
    const r = await import('./reveal');
    reply = () => { throw new ApiError('offline', 0); };
    await expect(r.startReveal('AAAAAAAAAA', new Uint8Array(16), opened, {})).rejects.toThrow();
    expect(r.askedHere('AAAAAAAAAA')).toBeTruthy();
    expect(r.openedHere('AAAAAAAAAA')).toBeNull();
    const at = r.askedHere('AAAAAAAAAA');
    reply = () => { throw new ApiError('internal', 502); }; // a proxy's error page: it may have been counted
    await expect(r.startReveal('AAAAAAAAAA', new Uint8Array(16), opened, {})).rejects.toThrow();
    expect(r.askedHere('AAAAAAAAAA')).toBe(at); // still when it was first asked
    reply = () => { throw new ApiError('gone', 410, 'gone', { reason: 'opened' }); }; // trying again: it's used up
    await expect(r.startReveal('AAAAAAAAAA', new Uint8Array(16), opened, {})).rejects.toThrow();
    expect(r.askedHere('AAAAAAAAAA')).toBe(at); // the lost answer still explains it
  });

  it('is forgotten when the server said no, and becomes "opened here" when the answer arrives', async () => {
    const r = await import('./reveal');
    reply = () => { throw new ApiError('wrong_passphrase', 403); };
    await expect(r.startReveal('BBBBBBBBBB', new Uint8Array(16), opened, {})).rejects.toThrow();
    expect(r.askedHere('BBBBBBBBBB')).toBeNull();
    reply = () => ok;
    await r.startReveal('BBBBBBBBBB', new Uint8Array(16), opened, {});
    expect(r.openedHere('BBBBBBBBBB')).toBeTruthy();
    expect(r.askedHere('BBBBBBBBBB')).toBeNull();
  });
});
