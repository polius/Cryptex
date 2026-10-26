/** Chunk upload and download with retries (frontend.md §9): 5 retries at 1, 2, 4, 8, 16 s; offline pauses. */
import { ApiError, apiBytes, request } from '../api/client';
import * as worker from '../crypto/client';
import { CHUNK, TAG, type Bytes } from '../crypto/format';

const BACKOFF = [1, 2, 4, 8, 16];

function waitOnline(signal?: AbortSignal): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener('online', done);
      resolve();
    };
    window.addEventListener('online', done);
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

function sleep(s: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, s * 1000);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

export async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, onWait?: (offline: boolean) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retriable = e instanceof ApiError && (e.code === 'offline' || e.status >= 500 || e.status === 429);
      if (!retriable || attempt >= BACKOFF.length) throw e;
      onWait?.(!navigator.onLine);
      await waitOnline(signal);
      await sleep((e as ApiError).retryAfter && (e as ApiError).status === 429 ? Math.min(60, (e as ApiError).retryAfter!) : BACKOFF[attempt], signal);
    }
  }
}

export interface Source {
  size: number;
  read(start: number, end: number): Promise<ArrayBuffer>;
}

export const bytesSource = (b: Uint8Array): Source => ({
  size: b.length,
  read: async (s, e) => b.slice(s, e).buffer as ArrayBuffer,
});

export const fileSource = (f: File): Source => ({ size: f.size, read: (s, e) => f.slice(s, e).arrayBuffer() });

/** Encrypt and upload one stream chunk by chunk; memory stays around two chunks. */
export async function uploadStream(o: {
  base: string; uploadToken: string; key: Uint8Array; id: string; stream: number; prefix: Uint8Array; src: Source;
  onBytes: (n: number) => void; signal?: AbortSignal;
}): Promise<void> {
  const n = Math.max(1, Math.ceil(o.src.size / CHUNK));
  let next: Promise<Bytes> | null = null;
  const enc = (i: number) => o.src.read(i * CHUNK, Math.min(o.src.size, (i + 1) * CHUNK))
    .then((plain) => worker.encrypt(o.key, o.id, o.stream, o.prefix, i, i === n - 1, plain));
  next = enc(0);
  for (let i = 0; i < n; i++) {
    const ct = await next!;
    next = i + 1 < n ? enc(i + 1) : null; // encrypt the next chunk while this one uploads
    await withRetry(() => request('PUT', `${o.base}/chunks/${o.stream}/${i}`, {
      bytes: ct, headers: { Authorization: `Upload ${o.uploadToken}` }, signal: o.signal,
    }), o.signal);
    o.onBytes(ct.length - TAG);
  }
}

/** Download and decrypt one stream. Throws Error('tampered') if any chunk fails authentication. */
export async function downloadStream(o: {
  path: (n: number) => string; headers: Record<string, string>; key: Uint8Array; id: string; stream: number;
  prefix: Uint8Array; chunks: number; onBytes?: (n: number) => void; signal?: AbortSignal;
}): Promise<Bytes[]> {
  const parts: Bytes[] = [];
  for (let i = 0; i < o.chunks; i++) {
    const ct = await withRetry(() => apiBytes(o.path(i), o.headers, o.signal), o.signal);
    const pt = await worker.decrypt(o.key, o.id, o.stream, o.prefix, i, i === o.chunks - 1, ct.buffer as ArrayBuffer);
    parts.push(pt);
    o.onBytes?.(pt.length);
  }
  return parts;
}

/** POST a seal, retrying network failures. A 409 after a retry means an earlier attempt already sealed it. */
export async function sealWithRetry(path: string, body: unknown, uploadToken: string, signal?: AbortSignal): Promise<void> {
  let attempt = 0;
  await withRetry(async () => {
    attempt++;
    try {
      await request('POST', path, { body, headers: { Authorization: `Upload ${uploadToken}` }, signal });
    } catch (e) {
      if (attempt > 1 && e instanceof ApiError && (e.code === 'already_sealed' || e.code === 'already_answered')) return;
      throw e;
    }
  }, signal);
}
