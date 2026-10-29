/**
 * The account vault (zero-knowledge; server side in api/cryptex/account.py).
 *
 * From the password and the account's salt, Argon2id gives a master secret, split by HMAC into:
 *   auth key → sent to sign in (the server stores only argon2id of it; the password never leaves this page)
 *   wrap key → never sent; with the server's unlock share (released only after a full sign-in) it makes the
 *              key-encryption key (HKDF) that wraps the vault key
 * The vault key (32 random bytes, made here) encrypts each item of Your links: title, the link while it waits,
 * the manage token. Items are stored on the server, so every device of the account sees the same thing and
 * clearing a browser loses nothing. Only the password opens the vault key: a password reset clears the vault (the
 * links and their statuses stay), and the next sign-in makes a new one.
 *
 * Staying unlocked: this browser keeps the vault key wrapped by a device key that only a signed-in session can
 * fetch (POST /me/device-key). Signing out, or a remote sign-out, leaves that copy unreadable. On a shared
 * computer nothing is kept: the vault key lives in this tab's memory only. Whether a session is on a shared
 * computer is the server's word (`shared` at sign-in and on GET /auth/session), so it holds after a reload too.
 * Until the server has said (GET /auth/session failed), nothing is written to this browser and nothing is deleted.
 */
import { signal } from '@preact/signals';
import { api, ApiError, setSignedInAs, signedInUid } from '../api/client';
import { argon2 } from '../crypto/client';
import { b64u, concat, random, unb64u, utf8, type Bytes, type Kdf } from '../crypto/format';
import { announceSignOut, countLinks } from '../lib/state';
import { keys, localReceipts, prefs, type StoredReceipt } from './db';

export interface Bundle {
  salt: string; kdf: Kdf; unlock_share: string; vault_pw: string | null;
}

/** GET /me/vault/keys: enough to derive the keys. The unlock share and vault_pw come only with a checked password
 *  (sign-in, or POST /me/vault/unlock). */
export type KeysInfo = Pick<Bundle, 'salt' | 'kdf'>;

/** off: not signed in. locked: needs the password. */
export type VaultState = 'off' | 'ready' | 'locked';
export const vault = signal<{ state: VaultState }>({ state: 'off' });
/** How many links sent from this browser before signing in could join the account (asked, never on a shared computer). */
export const adoptOffer = signal(0);

const subtle = crypto.subtle;
/** `from`: opened with this browser's device copy, or with the password (or a new vault). */
let open: { uid: string; raw: Bytes; key: CryptoKey; from: 'device' | 'password' } | null = null;
/** The server's word on this session: true on a shared computer, false if not, null while unknown. */
let sharedComputer: boolean | null = null;
let cache: Map<string, StoredReceipt> | null = null;

/** Whether this browser may keep anything for the account (a device copy, links it couldn't save to the account):
 *  only once the server said the session isn't on a shared computer. */
export const mayKeepOnDevice = (): boolean => sharedComputer === false;

// ------------------------------------------------------------------ keys
async function hmac(key: Uint8Array, label: string): Promise<Bytes> {
  const k = await subtle.importKey('raw', key as Bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, utf8(label)));
}

/** Argon2id settings for a new password; the server stores and hands back the same (api/cryptex/account.py KDF).
 *  They're also the floor: settings from the server that are weaker are refused (a server can't make a password
 *  cheap to guess from what it stores). */
export const ACCOUNT_KDF: Kdf = { m: 65536, t: 3, p: 1 };

export function checkKdf(kdf: Kdf): void {
  const ok = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;
  if (!kdf || !ok(kdf.m, ACCOUNT_KDF.m) || !ok(kdf.t, ACCOUNT_KDF.t) || !ok(kdf.p, ACCOUNT_KDF.p)) throw new Error('weak_kdf');
}

/** A new password (setup, invite, change): a fresh salt, and the keys it gives. */
export async function newPassword(password: string): Promise<{ salt: string; authKey: string; wrap: Bytes }> {
  const salt = b64u(random(16));
  return { salt, ...(await deriveAccount(password, salt, ACCOUNT_KDF)) };
}

/** The two keys a password gives. Slow on purpose (Argon2id, in the crypto worker). */
export async function deriveAccount(password: string, salt: string, kdf: Kdf): Promise<{ authKey: string; wrap: Bytes }> {
  checkKdf(kdf);
  const master = await argon2(password, unb64u(salt), kdf);
  return { authKey: b64u(await hmac(master, 'cryptex/v1/account|auth')), wrap: await hmac(master, 'cryptex/v1/account|vault') };
}

async function aesFrom(ikm: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', ikm as Bytes, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const kekFor = (wrap: Uint8Array, share: string, uid: string) => aesFrom(concat(wrap, unb64u(share)), `cryptex/v1/kek|${uid}`);

async function seal(key: CryptoKey, data: Uint8Array, aad: string): Promise<string> {
  const iv = random(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, data as Bytes));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}

async function unseal(key: CryptoKey, blob: string, aad: string): Promise<Bytes> {
  const [v, iv, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('not a vault blob');
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv), additionalData: utf8(aad) }, key, unb64u(ct)));
}

const PW = (uid: string) => `cryptex/v1/vault-key|pw|${uid}`;
const DEV = (uid: string) => `cryptex/v1/vault-key|device|${uid}`;
const ITEM = (uid: string, id: string) => `cryptex/v1/item|${uid}|${id}`;

// ------------------------------------------------------------------ this device
async function deviceId(): Promise<string> {
  let id = await prefs.get<string>('device_id');
  if (!id) {
    id = b64u(random(18));
    await prefs.set('device_id', id);
  }
  return id;
}

async function deviceKey(uid: string): Promise<CryptoKey> {
  const { key } = await api<{ key: string }>('POST', '/me/device-key', { body: { device_id: await deviceId() } });
  return aesFrom(unb64u(key), `cryptex/v1/device|${uid}`);
}

/** Best effort: without a copy, this browser asks for the password next time. */
async function keepOnDevice(uid: string, raw: Bytes): Promise<void> {
  if (!mayKeepOnDevice()) return;
  try {
    await keys.put(uid, await seal(await deviceKey(uid), raw, DEV(uid)));
  } catch {
    /* offline, or the server refused: nothing kept */
  }
}

/** Throws on network errors, 429 and 5xx: the copy stays for next time. */
async function fromDevice(uid: string): Promise<Bytes | null> {
  const wrapped = await keys.get(uid);
  if (!wrapped) return null;
  const key = await deviceKey(uid);
  try {
    return await unseal(key, wrapped, DEV(uid));
  } catch {
    // A device key that changed (the server forgot this browser): ask for the password, and drop the copy once the
    // server has said this session may keep one at all (until then, nothing here is written or deleted).
    if (sharedComputer !== null) await keys.remove(uid);
    return null;
  }
}

// ------------------------------------------------------------------ opening
async function setOpen(uid: string, raw: Bytes, from: 'device' | 'password'): Promise<void> {
  open = { uid, raw, key: await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']), from };
  cache = null;
  adoptOffer.value = (await offered(uid)).length;
  countLinks();
}

// ------------------------------------------------------------------ links sent before signing in
const SKIP = (uid: string) => `adopt_skip|${uid}`;

/** Links sent from this browser before signing in that the person hasn't chosen to leave here. None on a shared
 *  computer: someone else's links must not move into this account. */
async function offered(uid: string): Promise<StoredReceipt[]> {
  if (!mayKeepOnDevice()) return [];
  const local = await localReceipts.all().catch(() => [] as StoredReceipt[]);
  const skip = new Set((await prefs.get<string[]>(SKIP(uid)).catch(() => undefined)) ?? []);
  return local.filter((r) => !skip.has(r.id));
}

/** The most links one POST /me/receipts takes. */
const ATTACH = 200;

/** "Add to my account": they join the vault, so they show on every device. The account follows them first
 *  (POST /me/receipts, which checks each manage token): their statuses show on every device, and they stay in Your
 *  links (and can still be destroyed) after a password reset, like the links sent while signed in. Ones the server
 *  doesn't take (gone long ago, or a token that isn't right) stay in this browser, and aren't offered again. */
export async function adoptLocal(): Promise<void> {
  if (!open) return;
  const uid = open.uid;
  const list = await offered(uid);
  const left: string[] = [];
  for (let i = 0; i < list.length; i += ATTACH) {
    const part = list.slice(i, i + ATTACH);
    // Throws once the session ended (or the server can't be reached): the rest stay in this browser.
    const r = await api<{ attached: string[] }>('POST', '/me/receipts', { body: { items: part.map((x) => ({ id: x.id, manage_token: x.manage_token })) } });
    const taken = new Set(r?.attached ?? []);
    for (const x of part) {
      if (!taken.has(x.id)) {
        left.push(x.id);
        continue;
      }
      await vaultItems.put(x);
      await localReceipts.remove(x.id);
    }
  }
  if (left.length) await prefs.set(SKIP(uid), [...((await prefs.get<string[]>(SKIP(uid)).catch(() => undefined)) ?? []), ...left]).catch(() => undefined);
  adoptOffer.value = 0;
}

/** "Leave them here": they stay in this browser (Your links shows them when signed out), and aren't offered again. */
export async function keepLocal(): Promise<void> {
  if (!open) return;
  const local = await localReceipts.all().catch(() => [] as StoredReceipt[]);
  await prefs.set(SKIP(open.uid), local.map((r) => r.id)).catch(() => undefined);
  adoptOffer.value = 0;
}

const withAuth = (authKey?: string) => (authKey ? { auth_key: authKey } : {});

/** Make a vault (the first sign-in, or the first after a password reset): a random key, wrapped for the password. */
async function create(uid: string, kek: CryptoKey, authKey?: string): Promise<void> {
  const raw = random(32);
  await api('PUT', '/me/vault/keys', { body: { vault_pw: await seal(kek, raw, PW(uid)), ...withAuth(authKey) } });
  await setOpen(uid, raw, 'password');
  vault.value = { state: 'ready' };
  await keepOnDevice(uid, raw);
}

/** Right after a sign-in, setup or invite, with the wrap key from the password the person just typed.
 *  `shared` is the server's flag for this session; `authKey` (from the same password) lets later vault writes
 *  prove the password without another confirmation. */
export async function openAfterSignIn(uid: string, wrap: Uint8Array, b: Bundle, opts: { shared?: boolean | null; authKey?: string } = {}): Promise<void> {
  // From now on requests go as uid (before any vault request). Signed in here as someone else until now: their
  // vault goes, and their other tabs reload.
  const was = signedInUid();
  setSignedInAs(uid);
  if (was && was !== uid) {
    lockVault();
    announceSignOut(was);
    countLinks();
  }
  sharedComputer = typeof opts.shared === 'boolean' ? opts.shared : null;
  if (sharedComputer) await keys.remove(uid).catch(() => undefined); // a copy left by an earlier sign-in here
  const kek = await kekFor(wrap, b.unlock_share, uid);
  if (b.vault_pw) {
    const raw = await unseal(kek, b.vault_pw, PW(uid));
    await setOpen(uid, raw, 'password');
    vault.value = { state: 'ready' };
    await keepOnDevice(uid, raw);
  } else {
    await create(uid, kek, opts.authKey);
  }
}

/** The server's word on this session: whether it's on a shared computer. */
async function askShared(): Promise<boolean | null> {
  const s = await api<{ shared?: boolean }>('GET', '/auth/session', { anonymous: true }).catch(() => null);
  return s ? !!s.shared : null;
}

/** On every config load while signed in: open from this device if it can, else ask for the password. If someone
 *  else signs in here meanwhile (an invite page), it stops without opening anything or changing the prompt. */
export async function syncVault(uid: string): Promise<void> {
  if (open?.uid === uid) return;
  const stale = () => signedInUid() !== uid;
  const shared = await askShared(); // unknown (offline): write nothing to this browser, delete nothing
  if (stale()) return;
  sharedComputer = shared;
  if (sharedComputer) {
    await keys.remove(uid).catch(() => undefined);
    if (!stale()) vault.value = { state: 'locked' };
    return;
  }
  const raw = await fromDevice(uid).catch(() => null);
  if (stale()) return;
  if (raw) {
    await setOpen(uid, raw, 'device');
    vault.value = { state: 'ready' };
  } else {
    vault.value = { state: 'locked' };
  }
}

/** What GET /auth/session said about this tab's account (lib/state.ts checkSession): a shared flag that was unknown
 *  becomes known, and a shared session keeps nothing here. */
export async function noteSession(uid: string, shared: boolean): Promise<void> {
  if (open?.uid !== uid) return;
  const was = sharedComputer;
  sharedComputer = shared;
  if (shared) await keys.remove(uid).catch(() => undefined);
  else if (was === null && open?.uid === uid) await keepOnDevice(uid, open.raw);
}

/** The unlock prompt (a reload on a shared computer, or a browser that forgot its copy). The server checks the
 *  password first (401 wrong_password, counted like a failed sign-in), so a typo is never used as a key. */
export async function unlockWithPassword(uid: string, password: string): Promise<void> {
  const info = await api<KeysInfo>('GET', '/me/vault/keys');
  const { authKey, wrap } = await deriveAccount(password, info.salt, info.kdf);
  const b = await api<Bundle>('POST', '/me/vault/unlock', { body: { auth_key: authKey } });
  if (sharedComputer === null) sharedComputer = await askShared(); // still unknown: ask again before keeping a copy
  await openAfterSignIn(uid, wrap, b, { shared: sharedComputer, authKey });
}

/** Changing the password: the same vault key, wrapped for the new password. The unlock share needs the current
 *  password's auth key, so a wrong current password is refused here (401 wrong_password). */
export async function wrapForNewPassword(currentAuthKey: string, newWrap: Uint8Array): Promise<string | null> {
  if (!open) return null;
  const b = await api<Bundle>('POST', '/me/vault/unlock', { body: { auth_key: currentAuthKey } });
  const o = open;
  if (!o) return null; // signed out meanwhile
  return seal(await kekFor(newWrap, b.unlock_share, o.uid), o.raw, PW(o.uid));
}

/** Signing out: this browser's locked copy of the vault key goes, and the server forgets its device key. Throws if
 *  the server couldn't be told (offline, 5xx): the session would still work, so the person must know and retry.
 *  Then the page loads afresh at "/", and this browser's other tabs reload too. */
export async function signOut(uid: string | undefined): Promise<void> {
  if (uid) await keys.remove(uid).catch(() => undefined);
  const device_id = await prefs.get<string>('device_id').catch(() => undefined);
  try {
    await api('POST', '/auth/logout', { anonymous: true, ...(device_id ? { body: { device_id } } : {}) });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) throw e; // 401: it had already ended
  }
  lockVault();
  if (uid) announceSignOut(uid);
  location.assign('/');
}

/** Forget the vault key and everything decrypted with it in this tab (signed out, here or elsewhere). */
export function lockVault(): void {
  open = null;
  cache = null;
  sharedComputer = null;
  adoptOffer.value = 0;
  vault.value = { state: 'off' };
}

// ------------------------------------------------------------------ items (Your links, encrypted per link)
function opened() {
  if (!open) throw new Error('locked');
  return open;
}

export const vaultItems = {
  isOpen: () => open !== null,
  async all(): Promise<StoredReceipt[]> {
    if (!open) return [];
    const o = open;
    const { items } = await api<{ items: Array<{ id: string; ct: string }> }>('GET', '/me/vault/items');
    const next = new Map<string, StoredReceipt>();
    let unreadable = 0;
    for (const it of items) {
      try {
        next.set(it.id, JSON.parse(new TextDecoder().decode(await unseal(o.key, it.ct, ITEM(o.uid, it.id)))) as StoredReceipt);
      } catch {
        unreadable++;
      }
    }
    if (open !== o) throw new Error('locked'); // locked meanwhile (signed out)
    if (unreadable && o.from === 'device') {
      // This browser's copy is of an older vault (the password was reset since): drop it, ask for the password.
      await keys.remove(o.uid).catch(() => undefined);
      open = null;
      cache = null;
      vault.value = { state: 'locked' };
      throw new Error('locked');
    }
    cache = next; // anything else unreadable was made with a key this vault no longer has: skipped
    return [...next.values()];
  },
  async get(id: string): Promise<StoredReceipt | undefined> {
    if (!open) return undefined;
    if (!cache) await vaultItems.all();
    return cache?.get(id);
  },
  async put(r: StoredReceipt): Promise<void> {
    const o = opened();
    const ct = await seal(o.key, utf8(JSON.stringify(r)), ITEM(o.uid, r.id));
    await api('PUT', `/me/vault/items/${encodeURIComponent(r.id)}`, { body: { ct } });
    if (open === o) cache?.set(r.id, r);
  },
  async remove(id: string): Promise<void> {
    const o = opened();
    await api('DELETE', `/me/vault/items/${encodeURIComponent(id)}`);
    if (open === o) cache?.delete(id);
  },
};
