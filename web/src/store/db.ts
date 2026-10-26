/**
 * IndexedDB `cryptex` v1 (frontend.md §3): receipts, request private keys, preferences.
 * Link keys are kept only until an item reaches a final status. "Clear this device" wipes it all.
 */

export interface StoredReceipt {
  kind: 'secret' | 'request';
  id: string;
  manage_token: string;
  title: string;
  created_at: string;
  expires_at?: string;
  link?: string;              // full link with key; deleted at a final status
  last_status: string;
  fields: number;
  files: number;
  access?: 'link' | 'email' | 'org';
  email?: string;
  views?: number;
  keep_answer_s?: number;
  ended_at?: string;
  opened_at?: string;
  other_device?: boolean;     // imported from a receipt link or account sync
}

const NAME = 'cryptex';
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('receipts');
        db.createObjectStore('request_keys');
        db.createObjectStore('prefs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opening;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const receipts = {
  key: (kind: string, id: string) => `${kind}:${id}`,
  async all(): Promise<StoredReceipt[]> {
    const list = await tx<StoredReceipt[]>('receipts', 'readonly', (s) => s.getAll() as IDBRequest<StoredReceipt[]>);
    return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  get: (kind: string, id: string) => tx<StoredReceipt | undefined>('receipts', 'readonly', (s) => s.get(`${kind}:${id}`)),
  put: (r: StoredReceipt) => tx<IDBValidKey>('receipts', 'readwrite', (s) => s.put(r, `${r.kind}:${r.id}`)),
  remove: (kind: string, id: string) => tx<undefined>('receipts', 'readwrite', (s) => s.delete(`${kind}:${id}`)),
  async patch(kind: string, id: string, p: Partial<StoredReceipt>): Promise<void> {
    const r = await receipts.get(kind, id);
    if (r) await receipts.put({ ...r, ...p });
  },
};

export const requestKeys = {
  get: (id: string) => tx<CryptoKey | undefined>('request_keys', 'readonly', (s) => s.get(id)),
  put: (id: string, key: CryptoKey) => tx<IDBValidKey>('request_keys', 'readwrite', (s) => s.put(key, id)),
  remove: (id: string) => tx<undefined>('request_keys', 'readwrite', (s) => s.delete(id)),
};

export const prefs = {
  get: <T>(k: string) => tx<T | undefined>('prefs', 'readonly', (s) => s.get(k)),
  set: (k: string, v: unknown) => tx<IDBValidKey>('prefs', 'readwrite', (s) => s.put(v, k)),
};

export async function clearDevice(): Promise<void> {
  for (const store of ['receipts', 'request_keys', 'prefs']) await tx(store, 'readwrite', (s) => s.clear());
}

export const FINAL = new Set(['opened', 'expired', 'destroyed', 'cancelled', 'revealed']);
