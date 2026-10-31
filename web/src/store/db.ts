/**
 * IndexedDB `cryptex` (schema version 3): links sent while not signed in, preferences, and per account this
 * browser's locked copy of the vault key. Link keys are kept only until an item reaches a final status.
 */

export interface StoredReceipt {
  id: string;
  manage_token: string;
  title: string;
  created_at: string;
  expires_at?: string;
  link?: string;              // full link with key; deleted at a final status
  last_status: string;
  fields: number;
  files: number;
  views?: number | null;      // 1: one-time; null: opens until it expires
  ended_at?: string;
  opened_at?: string;
  other_device?: boolean;     // from account sync: sent on another device
  label?: string;             // the sender's own name for it (Rename); never sent anywhere
  hint?: string;              // a default name when there's no title: the field names, or the first file name
  kind?: 'request';           // "Ask for a secret": `link` is the request link, `key` the private key its answer is
  key?: JsonWebKey;           // encrypted to
}

import { signedInUid } from '../api/client';
import { mayKeepOnDevice, vaultItems } from './vault';

const NAME = 'cryptex';
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        // receipts: links sent while not signed in (signed in, they live in the account vault, store/vault.ts)
        // prefs: theme, last options, this browser's device id
        // keys: per account, this browser's copy of the vault key, locked with a device key only a session can fetch
        for (const s of ['receipts', 'prefs', 'keys']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
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

const byNewest = (list: StoredReceipt[]) => list.sort((a, b) => b.created_at.localeCompare(a.created_at));

/** Links sent from this browser while not signed in. */
export const localReceipts = {
  async all(): Promise<StoredReceipt[]> {
    return byNewest(await tx<StoredReceipt[]>('receipts', 'readonly', (s) => s.getAll() as IDBRequest<StoredReceipt[]>));
  },
  get: (id: string) => tx<StoredReceipt | undefined>('receipts', 'readonly', (s) => s.get(id)),
  put: (r: StoredReceipt) => tx<IDBValidKey>('receipts', 'readwrite', (s) => s.put(r, r.id)),
  remove: (id: string) => tx<undefined>('receipts', 'readwrite', (s) => s.delete(id)),
};

/** This browser's own links show in Your links when signed out, and while signed in too unless the session is (or
 *  may be) on a shared computer: then they're someone else's, and nothing of the account's is written here. Decided
 *  right before each read or write: a session that ended meanwhile has locked the vault (the shared flag is unknown
 *  again), so the account's link and manage token never land in this browser. */
const localShown = () => !signedInUid() || mayKeepOnDevice();
const local = async () => (localShown() ? localReceipts.all() : []);

/** Your links. Signed in: the account vault (throws Error('locked') while it's locked), plus this browser's links
 *  (sent before signing in and left here, or kept here when the account couldn't take them). Signed out: this
 *  browser. */
export const receipts = {
  async all(): Promise<StoredReceipt[]> {
    if (!signedInUid()) return localReceipts.all();
    const mine = vaultItems.isOpen() ? await vaultItems.all() : [];
    const ids = new Set(mine.map((r) => r.id));
    return byNewest([...mine, ...(await local()).filter((r) => !ids.has(r.id))]);
  },
  async get(id: string): Promise<StoredReceipt | undefined> {
    if (!signedInUid()) return localReceipts.get(id);
    return (vaultItems.isOpen() ? await vaultItems.get(id) : undefined) ?? (localShown() ? await localReceipts.get(id) : undefined);
  },
  /** `ifThere`: a newer copy of a stored link, written only if the account still has it (another device may have
   *  deleted it meanwhile). Leave it out for a new link. */
  async put(r: StoredReceipt, ifThere = false): Promise<void> {
    if (signedInUid()) {
      if (!vaultItems.isOpen()) throw new Error('locked');
      // One that lives in this browser only stays there; anything else goes to the account.
      if (await vaultItems.get(r.id) || !localShown() || !(await localReceipts.get(r.id))) return vaultItems.put(r, ifThere);
    }
    if (!localShown()) throw new Error('locked');
    await localReceipts.put(r);
  },
  async remove(id: string): Promise<void> {
    if (vaultItems.isOpen() && (await vaultItems.get(id))) await vaultItems.remove(id);
    if (localShown()) await localReceipts.remove(id);
  },
  async patch(id: string, p: Partial<StoredReceipt>): Promise<void> {
    const r = await receipts.get(id);
    if (r) await receipts.put({ ...r, ...p }, true);
  },
};

export const keys = {
  get: (uid: string) => tx<string | undefined>('keys', 'readonly', (s) => s.get(uid)),
  put: (uid: string, wrapped: string) => tx<IDBValidKey>('keys', 'readwrite', (s) => s.put(wrapped, uid)),
  remove: (uid: string) => tx<undefined>('keys', 'readwrite', (s) => s.delete(uid)),
};

export const prefs = {
  get: <T>(k: string) => tx<T | undefined>('prefs', 'readonly', (s) => s.get(k)),
  set: (k: string, v: unknown) => tx<IDBValidKey>('prefs', 'readwrite', (s) => s.put(v, k)),
};

export const FINAL = new Set(['opened', 'expired', 'destroyed', 'gone']);
