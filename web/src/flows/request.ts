/** Asking for a secret (docs/crypto.md §4): the request link, answering it, and opening the answer. */
import { signal } from '@preact/signals';
import { api, cap, signedInUid, type Config, type Receipt } from '../api/client';
import { b64u, deriveAsk, fromUtf8, newRequestKey, openBlob, random, sealBlob, unb64u, unwrapAnswer, utf8, wrapAnswer, type Bytes } from '../crypto/format';
import { receipts, type StoredReceipt } from '../store/db';
import { vaultItems } from '../store/vault';
import { proofOfWork, uploadSecret, type Draft, type Progress } from './send';

/** The longest note a request can carry: who asks and what for. */
export const NOTE_MAX = 1000;

/** Make a request link. Its private key and manage token are kept before the link exists, so its answer can always
 *  be opened: in the account vault when signed in (any device of the account), else in this browser, like the links
 *  sent from it. `note` travels sealed with the link's key, beside the public key: only people with the link read it.
 *  Throws Error('locked') while the vault is locked. */
export async function createRequest(cfg: Config, expiresIn: number, note = ''): Promise<StoredReceipt> {
  if (signedInUid() && !vaultItems.isOpen()) throw new Error('locked');
  const { id, manage_token, expires_at } = await api<{ id: string; manage_token: string; expires_at: string }>('POST', '/requests', {
    body: { expires_in: expiresIn }, headers: await proofOfWork(cfg),
  });
  const R = random(16);
  const keys = await deriveAsk(id, R);
  const { jwk, Q } = await newRequestKey();
  const ask_ct = await sealBlob(keys.askKey, 'ask', id, utf8(JSON.stringify({ key: b64u(Q), ...(note.trim() ? { note: note.trim() } : {}) })));
  const item: StoredReceipt = {
    kind: 'request', id, key: jwk, manage_token, title: '',
    created_at: new Date().toISOString(), expires_at, link: `${location.origin}/a/${id}#${b64u(R)}`, last_status: 'waiting',
    fields: 0, files: 0,
  };
  await receipts.put(item);
  try {
    await api('POST', `/requests/${id}/seal`, { body: { ask_ct, answer_hash: keys.answerHash }, headers: cap('Manage', manage_token) });
  } catch (e) {
    await receipts.remove(id).catch(() => undefined); // never sealed: the server forgets it too
    throw e;
  }
  return item;
}

/** A request's code, like KFX-49M: shown to whoever asks and on the answer page, so they can check it's the same
 *  request without naming anyone. Made from the request's ID (a label, not a secret): 30 bits of FNV-1a, in Crockford's
 *  base32, which has no I, L, O or U to misread. */
export function requestCode(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  let s = '';
  for (let i = 0; i < 6; i++) s += '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[(h >>> (i * 5)) & 31];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/** The request just made, until its "ready" page is left: /r/:id shows that page instead of the request's status
 *  (screens/links/Receipt.tsx), as a sent link's does. `copied`: the link went to the clipboard as it was made. */
export const justAsked = signal<{ item: StoredReceipt; copied: boolean } | null>(null);

export interface Asked {
  id: string;
  /** The requester's public key, sealed with the link's key: never taken from the server in the clear. */
  key: Bytes;
  /** What the person asking wrote, or null. Their own words: nobody vouches for them. */
  note: string | null;
  expires_at: string;
  token: string;
}

/** The answer page: who asks, and the key to encrypt for. Throws ApiError (gone, not_found), or Error('broken') when
 *  what the server holds doesn't open with this link's key. */
export async function loadRequest(id: string, R: Uint8Array): Promise<Asked> {
  const keys = await deriveAsk(id, R);
  const token = b64u(keys.answerToken);
  const r = await api<{ ask_ct: string; expires_at: string }>('GET', `/requests/${id}`, { headers: cap('Answer', token) });
  let key: Bytes;
  let note: unknown;
  try {
    const pt = JSON.parse(fromUtf8(await openBlob(keys.askKey, 'ask', id, r.ask_ct))) as { key?: unknown; note?: unknown };
    key = unb64u(String(pt.key));
    note = pt.note;
  } catch {
    throw new Error('broken');
  }
  if (key.length !== 65 || (note !== undefined && (typeof note !== 'string' || note.length > NOTE_MAX))) throw new Error('broken');
  return { id, key, note: note || null, expires_at: r.expires_at, token };
}

/** Send the answer: a secret like any other, its link key encrypted to the requester, with a passphrase if whoever
 *  answers chose one (the requester then needs it to open it, docs/crypto.md §3.2). */
export async function sendAnswer(cfg: Config, a: Asked, d: Draft, passphrase: string | null, onProgress: (p: Progress) => void,
  signal?: AbortSignal, onCreated?: (id: string, uploadToken: string) => void): Promise<void> {
  const salt = passphrase ? random(16) : null;
  await uploadSecret(d, async (streams) => api<{ id: string; upload_token: string }>('POST', `/requests/${a.id}/answer`, {
    body: { streams, ...(salt ? { passphrase_salt: b64u(salt) } : {}) }, headers: { ...cap('Answer', a.token), ...(await proofOfWork(cfg)) }, signal,
  }), {
    onProgress, signal, onCreated, passphrase: salt ? { value: passphrase!, salt } : null,
    sealExtra: async (sid, K) => ({ answer_ct: await wrapAnswer(a.id, sid, K, a.key) }),
  });
}

/** The statuses of these requests (Your links), proven with their manage tokens. Closed ones aren't returned. */
export async function lookupRequests(list: StoredReceipt[]): Promise<Receipt[]> {
  if (!list.length) return [];
  const r = await api<{ items: Receipt[] }>('POST', '/requests/lookup', { body: { items: list.map((x) => ({ id: x.id, manage_token: x.manage_token })) } });
  return r.items.map((x) => ({ ...x, kind: 'request' as const }));
}

/** The answer's own link, opened with the request's private key. Throws when it can't be (no key: locked). */
export async function answerLink(item: StoredReceipt | null, r: Receipt): Promise<string> {
  if (!item?.key || !r.answer) throw new Error('locked');
  const K = await unwrapAnswer(r.id, r.answer.id, item.key, r.answer.key);
  return `/s/${r.answer.id}#${b64u(K)}`;
}

/** Delete a request: its link stops taking answers and an answer it has is destroyed, then it leaves Your links. */
export async function closeRequest(id: string, manageToken: string): Promise<void> {
  await api('DELETE', `/requests/${encodeURIComponent(id)}`, { headers: cap('Manage', manageToken) });
}
