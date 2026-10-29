/** A download that stops after POST /reveal continues with the same read session: the view is never counted twice,
 *  chunks already decrypted aren't fetched again, and a gone read session is told apart (R1). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { b64u, deriveLink, hex, random, streamEncrypt, utf8 } from '../crypto/format';

const calls: string[] = [];
let failDecrypt: string | null = null; // "stream/chunk" that fails once (the worker died)
let goneAfter = Infinity; // chunk GETs that succeed before the read session is gone
let chunkGets = 0;
const store = new Map<string, Uint8Array>();
let streams: Array<{ stream: number; prefix: string; chunks: number; size: number }> = [];

vi.mock('../crypto/client', async () => {
  const f = await import('../crypto/format');
  return {
    decrypt: async (key: Uint8Array, id: string, stream: number, prefix: Uint8Array, i: number, last: boolean, data: ArrayBuffer) => {
      if (failDecrypt === `${stream}/${i}`) {
        failDecrypt = null;
        throw new Error('worker');
      }
      return f.decryptChunk(await f.streamKey(key, 'decrypt'), id, stream, prefix, i, last, new Uint8Array(data));
    },
    argon2: async () => new Uint8Array(32),
  };
});

vi.mock('../api/client', async () => {
  const real = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...real,
    api: async (method: string, path: string, o: { headers?: Record<string, string> } = {}) => {
      calls.push(`${method} ${path} ${o.headers?.Authorization?.split(' ')[0] ?? ''}`);
      if (path.endsWith('/reveal')) return { read_session: 'RS1', streams, views_left: 0 };
      return undefined;
    },
    apiBytes: async (path: string, headers: Record<string, string>) => {
      calls.push(`GET ${path} ${headers.Authorization}`);
      if (++chunkGets > goneAfter) throw new real.ApiError('not_found', 404);
      return store.get(path)!;
    },
  };
});

const id = 'AAAAAAAAAA';
const K = random(16);

beforeEach(async () => {
  calls.length = 0;
  failDecrypt = null;
  goneAfter = Infinity;
  chunkGets = 0;
  store.clear();
  const keys = await deriveLink(id, K);
  const file = utf8('0123456789abcdef');
  const man = utf8(JSON.stringify({ v: 1, items: [{ t: 'note', v: 'hello' }, { t: 'file', name: 'f.bin', type: '', size: file.length, stream: 1 }] }));
  streams = [];
  for (const [n, pt, size] of [[0, man, 32], [1, file, 4]] as const) {
    const prefix = random(7);
    const chunks = await streamEncrypt(keys.contentKey, id, n, prefix, pt, size);
    chunks.forEach((c, i) => store.set(`/secrets/${id}/chunks/${n}/${i}`, c));
    streams.push({ stream: n, prefix: b64u(prefix), chunks: chunks.length, size: chunks.reduce((s, c) => s + c.length, 0) });
  }
});

async function opened() {
  const flow = await import('./reveal');
  const keys = await deriveLink(id, K);
  return { flow, o: { meta: { passphrase: false } as never, keys, title: null, from: null, fields: null, notes: null } };
}

describe('resumable reveal', () => {
  it('continues where it stopped, with the same read session, and confirms the read once', async () => {
    const { flow, o } = await opened();
    const r = await flow.startReveal(id, K, o, {});
    failDecrypt = '1/2';
    await expect(flow.finishReveal(r)).rejects.toThrow('worker');
    expect(flow.readingGone(new Error('worker'))).toBe(false);
    const fetched = calls.filter((c) => c.startsWith('GET')).length;
    const out = await flow.finishReveal(r);
    expect(out.items).toEqual([{ t: 'note', v: 'hello' }]);
    expect(await out.files[0].blob.text()).toBe('0123456789abcdef');
    expect(calls.filter((c) => c.includes('/reveal'))).toHaveLength(1); // never revealed twice
    const gets = calls.filter((c) => c.startsWith('GET'));
    expect(new Set(gets).size).toBe(gets.length - 1); // only the chunk that failed was fetched again
    expect(gets.slice(fetched)[0]).toContain(`/chunks/1/2 Read RS1`);
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([`DELETE /secrets/${id}/read Read`]);
  });

  it('tells a gone read session apart', async () => {
    const { flow, o } = await opened();
    const r = await flow.startReveal(id, K, o, {});
    goneAfter = 2;
    const e = await flow.finishReveal(r).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(flow.readingGone(e)).toBe(true);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false); // nothing confirmed
  });

  it('keeps the chunks it has when a reusable link is revealed again', async () => {
    const { flow, o } = await opened();
    const a = await flow.startReveal(id, K, o, {});
    goneAfter = 3;
    await flow.finishReveal(a).catch(() => undefined);
    goneAfter = Infinity;
    const b = flow.carryOver(a, await flow.startReveal(id, K, o, {}));
    expect(b.parts).toBe(a.parts);
    const out = await flow.finishReveal(b);
    expect(await out.files[0].blob.text()).toBe('0123456789abcdef');
    expect(hex(new Uint8Array(await out.files[0].blob.arrayBuffer()))).toBe(hex(utf8('0123456789abcdef')));
  });

  it('marks the link as opened in this tab (ID and time only)', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
    const { flow, o } = await opened();
    expect(flow.openedHere(id)).toBeNull();
    await flow.startReveal(id, K, o, {});
    expect(flow.openedHere(id)).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect([...mem.values()].join()).not.toContain(b64u(K));
    vi.unstubAllGlobals();
  });
});
