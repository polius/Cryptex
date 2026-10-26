/// <reference lib="webworker" />
/**
 * The crypto worker (frontend.md §4). Chunk encryption and decryption, Argon2id and the
 * demo proof of work run here, so the page never freezes on large files or slow hashing.
 * Keys arrive as raw bytes per call and are never kept between calls.
 */
import { argon2id, b64u, decryptChunk, encryptChunk, streamKey } from './format';

export type Job =
  | { op: 'encrypt'; key: Uint8Array; id: string; stream: number; prefix: Uint8Array; i: number; last: boolean; data: ArrayBuffer }
  | { op: 'decrypt'; key: Uint8Array; id: string; stream: number; prefix: Uint8Array; i: number; last: boolean; data: ArrayBuffer }
  | { op: 'argon2'; password: string; salt: Uint8Array }
  | { op: 'pow'; challenge: string; bits: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function zeroBits(d: Uint8Array): number {
  let n = 0;
  for (const byte of d) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

async function pow(challenge: string, bits: number): Promise<string> {
  const { createSHA256 } = await import('hash-wasm');
  const h = await createSHA256();
  const enc = new TextEncoder();
  for (let n = 0; ; n++) {
    h.init();
    h.update(enc.encode(`${challenge}:${n}`));
    if (zeroBits(h.digest('binary')) >= bits) return String(n);
  }
}

async function run(job: Job): Promise<unknown> {
  switch (job.op) {
    case 'encrypt': {
      const key = await streamKey(job.key, 'encrypt');
      return (await encryptChunk(key, job.id, job.stream, job.prefix, job.i, job.last, new Uint8Array(job.data))).buffer;
    }
    case 'decrypt': {
      const key = await streamKey(job.key, 'decrypt');
      try {
        return (await decryptChunk(key, job.id, job.stream, job.prefix, job.i, job.last, new Uint8Array(job.data))).buffer;
      } catch {
        throw new Error('tampered');
      }
    }
    case 'argon2':
      return b64u(await argon2id(job.password, job.salt));
    case 'pow':
      return pow(job.challenge, job.bits);
  }
}

ctx.onmessage = async (e: MessageEvent<{ n: number; job: Job }>) => {
  const { n, job } = e.data;
  try {
    const result = await run(job);
    ctx.postMessage({ n, ok: true, result }, result instanceof ArrayBuffer ? [result] : []);
  } catch (err) {
    ctx.postMessage({ n, ok: false, error: (err as Error).message });
  }
};
