/** Main-thread side of the crypto worker: a small promise-based RPC. */
import { unb64u, type Bytes } from './format';
import type { Job } from './worker';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function get(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ n: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.n);
      if (!p) return;
      pending.delete(e.data.n);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }
  return worker;
}

function call<T>(job: Job, transfer: Transferable[] = []): Promise<T> {
  const n = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(n, { resolve: resolve as (v: unknown) => void, reject });
    get().postMessage({ n, job }, transfer);
  });
}

export async function encrypt(key: Uint8Array, id: string, stream: number, prefix: Uint8Array, i: number, last: boolean, data: ArrayBuffer): Promise<Bytes> {
  return new Uint8Array(await call<ArrayBuffer>({ op: 'encrypt', key, id, stream, prefix, i, last, data }, [data]));
}

export async function decrypt(key: Uint8Array, id: string, stream: number, prefix: Uint8Array, i: number, last: boolean, data: ArrayBuffer): Promise<Bytes> {
  return new Uint8Array(await call<ArrayBuffer>({ op: 'decrypt', key, id, stream, prefix, i, last, data }, [data]));
}

export async function argon2(password: string, salt: Uint8Array): Promise<Bytes> {
  return unb64u(await call<string>({ op: 'argon2', password, salt }));
}

export function pow(challenge: string, bits: number): Promise<string> {
  return call<string>({ op: 'pow', challenge, bits });
}
