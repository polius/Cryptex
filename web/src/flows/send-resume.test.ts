/** S9: Try again continues a failed upload from the chunk it stopped at, with the same ID and key; a changed draft
 *  starts over and drops the old upload. */
import { describe, expect, it, vi } from 'vitest';
import { CHUNK } from '../crypto/format';

const puts: string[] = [];
const creates: number[] = [];
const deletes: string[] = [];
let failAt: string | null = null;

vi.mock('../store/db', () => ({ receipts: { put: async () => undefined }, localReceipts: { put: async () => undefined } }));
vi.mock('../store/vault', () => ({ mayKeepOnDevice: () => true }));
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
    signedInUid: () => null,
    api: async (m: string, p: string) => {
      if (p === '/secrets') {
        creates.push(creates.length);
        return { id: `AAAAAAAAA${creates.length}`, upload_token: 'u', manage_token: 'MANAGE', expires_at: '2030-01-01T00:00:00Z' };
      }
      if (m === 'DELETE') deletes.push(p);
      return undefined;
    },
    request: async (_m: string, p: string) => {
      if (p === failAt) {
        failAt = null;
        throw new real.ApiError('invalid', 400); // not retried: the send fails here
      }
      puts.push(p);
      return new Response(null, { status: 204 });
    },
  };
});

describe('Try again after a failed upload', () => {
  it('continues at the chunk that failed, and starts over for a changed draft', async () => {
    (globalThis as { location?: unknown }).location = { origin: 'https://cx.example' };
    const { sendSecret } = await import('./send');
    const cfg = { demo: false, brand: { name: '' } } as never;
    const file = new File([new Uint8Array(CHUNK * 2 + 10)], 'big.bin');
    const draft = { title: '', items: [], files: [file] };
    const policy = { views: null, expires_in: 3600 };
    const upload = { current: null };
    failAt = '/secrets/AAAAAAAAA1/chunks/1/1';
    await expect(sendSecret(cfg, draft, policy, () => {}, undefined, undefined, upload)).rejects.toThrow();
    expect(puts).toEqual(['/secrets/AAAAAAAAA1/chunks/0/0', '/secrets/AAAAAAAAA1/chunks/1/0']);
    puts.length = 0;
    const sent = await sendSecret(cfg, draft, policy, () => {}, undefined, undefined, upload);
    expect(creates).toHaveLength(1); // the same upload
    expect(puts).toEqual(['/secrets/AAAAAAAAA1/chunks/1/1', '/secrets/AAAAAAAAA1/chunks/1/2', '/secrets/AAAAAAAAA1/seal']);
    expect(sent.id).toBe('AAAAAAAAA1');
    expect(upload.current).toBeNull();

    failAt = '/secrets/AAAAAAAAA2/chunks/1/0';
    await expect(sendSecret(cfg, draft, policy, () => {}, undefined, undefined, upload)).rejects.toThrow();
    await sendSecret(cfg, { ...draft }, policy, () => {}, undefined, undefined, upload); // edited meanwhile
    expect(creates).toHaveLength(3);
    expect(deletes).toEqual(['/secrets/AAAAAAAAA2/upload']);
  });
});
