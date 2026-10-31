/** When the account can't take a new link, a copy may stay in this browser only if the server said this isn't a
 *  shared computer (R4, W3): the next person must never find a link and its manage token here. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const local: Array<{ link?: string }> = [];
let uid: string | null = 'u1';
let keepHere = false;
let sealAnswer: Response = new Response(null, { status: 204 });

vi.mock('../store/db', async () => {
  const { ApiError } = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    receipts: { put: async () => { throw new ApiError('invalid', 400); } },
    localReceipts: { put: async (r: { link?: string }) => { local.push(r); } },
  };
});
vi.mock('../store/vault', () => ({ mayKeepOnDevice: () => keepHere }));
vi.mock('../crypto/client', async () => {
  const f = await import('../crypto/format');
  return {
    encrypt: async (key: Uint8Array, id: string, stream: number, prefix: Uint8Array, i: number, last: boolean, data: ArrayBuffer) =>
      f.encryptChunk(await f.streamKey(key, 'encrypt'), id, stream, prefix, i, last, new Uint8Array(data)),
    argon2: async () => new Uint8Array(32),
  };
});
vi.mock('../api/client', async () => {
  const real = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...real,
    signedInUid: () => uid,
    api: async (_m: string, p: string) => (p === '/secrets' ? { id: 'AAAAAAAAAA', upload_token: 'u', manage_token: 'MANAGE', expires_at: '2030-01-01T00:00:00Z' } : undefined),
    request: async (_m: string, p: string) => (p.endsWith('/seal') ? sealAnswer : new Response(null, { status: 204 })),
  };
});

const send = async () => {
  (globalThis as { location?: unknown }).location = { origin: 'https://cx.example' };
  const { sendSecret } = await import('./send');
  const cfg = { demo: false, brand: { name: '' } } as never;
  return sendSecret(cfg, { title: 'prod db', items: [{ t: 'note', v: 'hunter2' }], files: [] }, { views: null, expires_in: 3600 }, () => {});
};

beforeEach(() => {
  local.length = 0;
  sealAnswer = new Response(null, { status: 204 });
});

describe('saving a new link when the account can\'t', () => {
  it('keeps nothing in this browser on a shared computer, or before the server said', async () => {
    keepHere = false; // mayKeepOnDevice(): only once the server said the session isn't shared
    uid = 'u1';
    const sent = await send();
    expect(sent.saved).toBe('none');
    expect(local).toEqual([]);
    expect(sent.link).toMatch(/#[A-Za-z0-9_-]{22}$/); // still shown on the page
  });

  it('keeps it in this browser when the session isn\'t shared', async () => {
    uid = 'u1';
    keepHere = true;
    expect((await send()).saved).toBe('local');
    expect(local[0].link).toMatch(/#[A-Za-z0-9_-]{22}$/);
  });

  it('keeps it in this browser, as asked, when signed out', async () => {
    uid = null;
    keepHere = false;
    expect((await send()).saved).toBe('ok'); // this browser is where a signed-out sender's links live
    expect(local[0].link).toMatch(/#[A-Za-z0-9_-]{22}$/);
  });

  it('takes the expiry from the seal, which starts it', async () => {
    keepHere = true;
    sealAnswer = new Response(JSON.stringify({ expires_at: '2031-02-03T04:05:06Z' }), { headers: { 'content-type': 'application/json' } });
    expect((await send()).expires_at).toBe('2031-02-03T04:05:06Z');
    sealAnswer = new Response(null, { status: 204 });
    const at = Date.parse((await send()).expires_at);
    expect(Math.abs(at - (Date.now() + 3600_000))).toBeLessThan(10_000);
  });
});
