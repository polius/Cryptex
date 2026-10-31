/** Tests only: an in-memory IndexedDB, just enough for store/db.ts (open, one store per transaction, get, getAll,
 *  put, delete). `stores` is what a browser would have kept. */
export const stores = new Map<string, Map<IDBValidKey, unknown>>();

export function installFakeIndexedDB(): void {
  const db = {
    objectStoreNames: { contains: (s: string) => stores.has(s) },
    createObjectStore: (s: string) => {
      stores.set(s, new Map());
    },
    transaction: (name: string) => {
      const t: { oncomplete?: () => void; objectStore: () => unknown } = {
        objectStore: () => {
          const m = stores.get(name)!;
          const req = (f: () => unknown) => {
            const r = { result: f() };
            setTimeout(() => t.oncomplete?.());
            return r;
          };
          return {
            getAll: () => req(() => [...m.values()].map((v) => structuredClone(v))),
            get: (k: IDBValidKey) => req(() => structuredClone(m.get(k))),
            put: (v: unknown, k: IDBValidKey) => req(() => {
              m.set(k, structuredClone(v));
              return k;
            }),
            delete: (k: IDBValidKey) => req(() => {
              m.delete(k);
            }),
          };
        },
      };
      return t;
    },
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const r: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = {};
      setTimeout(() => {
        r.result = db;
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
}
