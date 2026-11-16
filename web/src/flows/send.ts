/** Sending a secret: create → encrypt with the assigned ID → upload chunks → seal (docs/crypto.md §3). */
import { api, ApiError, signedInUid, type Config, type Policy, type StreamDesc } from '../api/client';
import * as worker from '../crypto/client';
import { b64u, chunkCount, deriveLink, derivePassphrase, random, sealBlob, streamSize, utf8, type Bytes } from '../crypto/format';
import { localReceipts, receipts, type StoredReceipt } from '../store/db';
import { mayKeepOnDevice } from '../store/vault';
import { bytesSource, fileSource, sealWithRetry, uploadStream, withRetry, type Source } from './transfer';

export type Item =
  | { t: 'note'; v: string }
  | { t: 'field'; k: string; v: string; secret: boolean };

export interface Draft {
  title: string;
  items: Item[];
  files: File[];
}

export interface PolicyChoice {
  views: 1 | null;
  expires_in: number;
  passphrase?: string | null;
}

export interface Progress {
  stream: number;      // 0 = the message, n = files[n - 1]
  done: number;        // plaintext bytes uploaded overall
  total: number;
}

export interface Sent {
  id: string;
  link: string;
  manage_token: string;
  expires_at: string;
  /** Where Your links keeps it: as asked ('ok'), in this browser only because the account couldn't take it
   *  ('local'), or nowhere ('none': on a shared computer, or the browser refused). The link is live either way, so
   *  the page shows it and says so. */
  saved: 'ok' | 'local' | 'none';
}

export async function proofOfWork(cfg: Config): Promise<Record<string, string>> {
  if (!cfg.demo) return {};
  const c = await api<{ challenge: string; bits: number }>('GET', '/demo/challenge');
  return { 'X-PoW': `${c.challenge}:${await worker.pow(c.challenge, c.bits)}` };
}

export function manifestOf(d: Draft) {
  return {
    v: 1,
    items: [
      ...d.items,
      ...d.files.map((f, i) => ({ t: 'file' as const, name: f.name, type: f.type || 'application/octet-stream', size: f.size, stream: i + 1 })),
    ],
  };
}

/** An upload in progress, kept by the page so Try again continues it instead of starting over (S9): what it was
 *  made with (the draft and the policy, compared by identity) and how far it got. Only in memory. */
export interface Upload {
  draft: Draft;
  policy?: PolicyChoice;
  id: string;
  upload_token: string;
  manage_token?: string;
  K: Bytes;
  salt: Bytes | null;
  prefixes: Bytes[];
  next: { stream: number; chunk: number };
  done: number;
}

/** Encrypt and upload a secret (docs/crypto.md §3). `start` makes it with its stream list (POST /secrets, or an answer
 *  to a request) and returns its ID and upload token; `sealExtra` adds seal fields that need its link key. `upload`
 *  holds the upload's state as it goes: given one already started (`upload.current`), it continues from there. */
export async function uploadSecret(d: Draft, start: (streams: StreamDesc[]) => Promise<{ id: string; upload_token: string }>, o: {
  onProgress: (p: Progress) => void; signal?: AbortSignal; onCreated?: (id: string, uploadToken: string) => void;
  passphrase?: { value: string; salt: Bytes } | null; sealExtra?: (id: string, K: Bytes) => Promise<Record<string, string>>;
  upload?: { current: Upload | null };
}): Promise<{ id: string; K: Bytes; expires_at: string | null }> {
  const manifest = utf8(JSON.stringify(manifestOf(d)));
  const sources: Source[] = [bytesSource(manifest), ...d.files.map(fileSource)];
  let u = o.upload?.current?.draft === d ? o.upload.current : null;
  if (!u) {
    const prefixes = sources.map(() => random(7));
    const streams: StreamDesc[] = sources.map((s, i) => ({ stream: i, prefix: b64u(prefixes[i]), chunks: chunkCount(s.size), size: streamSize(s.size) }));
    const created = await start(streams);
    u = { draft: d, id: created.id, upload_token: created.upload_token, K: random(16), salt: o.passphrase?.salt ?? null, prefixes, next: { stream: 0, chunk: 0 }, done: 0 };
    if (o.upload) o.upload.current = u;
  }
  const { id, K } = u;
  o.onCreated?.(id, u.upload_token);
  const keys = await deriveLink(id, K);
  const pass = o.passphrase ? await derivePassphrase(id, K, o.passphrase.value, o.passphrase.salt, worker.argon2) : null;
  const contentKey = pass ? pass.contentKey : keys.contentKey;

  const total = sources.reduce((n, s) => n + s.size, 0);
  o.onProgress({ stream: u.next.stream, done: u.done, total });
  for (let i = u.next.stream; i < sources.length; i++) {
    const at = u;
    await uploadStream({
      base: `/secrets/${id}`, uploadToken: u.upload_token, key: contentKey, id, stream: i, prefix: u.prefixes[i], src: sources[i], signal: o.signal,
      from: u.next.stream === i ? u.next.chunk : 0,
      onSending: (sent) => o.onProgress({ stream: i, done: at.done + sent, total }),
      onChunk: (chunk, n) => {
        at.done += n;
        at.next = chunk + 1 < chunkCount(sources[i].size) ? { stream: i, chunk: chunk + 1 } : { stream: i + 1, chunk: 0 };
        o.onProgress({ stream: i, done: at.done, total });
      },
    });
  }
  // No sender name inside: recipients see the one the server knows (docs/crypto.md §3.3).
  const meta_ct = await sealBlob(keys.metaKey, 'meta', id, utf8(JSON.stringify({ title: d.title.trim() || null, from: null, fields: d.items.filter((x) => x.t === 'field').length, notes: d.items.filter((x) => x.t === 'note').length })));
  const sealed = await sealWithRetry(`/secrets/${id}/seal`, {
    meta_ct, reveal_hash: keys.revealHash, ...(pass ? { passcheck_hash: pass.passcheckHash } : {}), ...(o.sealExtra ? await o.sealExtra(id, K) : {}),
  }, u.upload_token, o.signal);
  return { id, K, expires_at: sealed?.expires_at ?? null };
}

export async function sendSecret(cfg: Config, d: Draft, p: PolicyChoice, onProgress: (p: Progress) => void, signal?: AbortSignal,
  onCreated?: (id: string, uploadToken: string) => void, upload?: { current: Upload | null }): Promise<Sent> {
  // Continue an upload only if it was made from this very draft and policy; otherwise it starts over.
  const resume = upload?.current && upload.current.draft === d && upload.current.policy === p ? upload.current : null;
  if (upload?.current && !resume) {
    void cancelUpload(upload.current.id, upload.current.upload_token); // made from something else: drop it
    upload.current = null;
  }
  // Whether this browser may keep it, as things are now: the upload can take minutes, and a session that ends
  // meanwhile (on a shared computer) must not turn this into a link kept here.
  const signedIn = !!signedInUid();
  const mayKeepHere = !signedIn || mayKeepOnDevice();
  const salt = resume ? resume.salt : p.passphrase ? random(16) : null;
  const policy: Policy = { views: p.views, expires_in: p.expires_in, passphrase: !!salt };
  if (salt) policy.passphrase_salt = b64u(salt);
  let manage_token = resume?.manage_token ?? '';
  const up = await uploadSecret(d, async (streams) => {
    const created = await api<{ id: string; upload_token: string; manage_token: string }>('POST', '/secrets', {
      body: { policy, streams }, headers: await proofOfWork(cfg), signal,
    });
    manage_token = created.manage_token;
    return created;
  }, {
    onProgress, signal, passphrase: salt ? { value: p.passphrase!, salt } : null, upload,
    onCreated: (id, token) => {
      if (upload?.current) Object.assign(upload.current, { manage_token, policy: p });
      onCreated?.(id, token);
    },
  });
  if (upload) upload.current = null; // sealed: nothing left to continue
  const { id } = up;
  // The expiry counts from the seal: the server's word, else (an earlier attempt sealed it) about now plus the choice.
  const expires_at = up.expires_at ?? new Date(Date.now() + p.expires_in * 1000).toISOString();
  const link = `${location.origin}/s/${id}#${b64u(up.K)}`;
  // A default name for Your links when there's no title: field names (never values), or the first file's name.
  const names = d.items.flatMap((x) => (x.t === 'field' && x.k ? [x.k] : []));
  const hint = (names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '') : d.files[0]?.name)?.slice(0, 120); // a name's limit, like titles
  const saved = await saveReceipt({
    id, manage_token, title: d.title.trim(), hint, created_at: new Date().toISOString(),
    expires_at, link, last_status: 'waiting', fields: d.items.filter((x) => x.t === 'field').length,
    files: d.files.length, views: p.views,
  }, signedIn, mayKeepHere);
  return { id, link, manage_token, expires_at, saved };
}

/** The secret is already live, so a failure here must not lose the link: retry the account, then keep it in this
 *  browser (it shows in Your links there, and the account offers to take it at the next unlock), and only then give
 *  up. `signedIn` and `mayKeepHere` are as the send started. Signed in on a shared computer, before the server said
 *  whether it is one, or once the session ended during the upload (the vault is locked), nothing is written to this
 *  browser: the next person would find the link and its manage token. The link page then says to copy it now. Sent
 *  without an account, it's this browser's link. */
async function saveReceipt(r: StoredReceipt, signedIn: boolean, mayKeepHere: boolean): Promise<Sent['saved']> {
  if (!signedIn) return withRetry(() => localReceipts.put(r)).then(() => 'ok' as const, () => 'none' as const);
  try {
    await withRetry(() => receipts.put(r));
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError && e.code === 'sign_in_required') throw e; // the session ended: the page reloads
    if (!mayKeepHere || !mayKeepOnDevice()) return 'none';
    return localReceipts.put(r).then(() => 'local' as const, () => 'none' as const);
  }
}

export async function cancelUpload(id: string, uploadToken: string): Promise<void> {
  await api('DELETE', `/secrets/${id}/upload`, { headers: { Authorization: `Upload ${uploadToken}` } }).catch(() => undefined);
}

export async function destroySecret(id: string, manageToken: string): Promise<void> {
  await api('DELETE', `/secrets/${id}`, { headers: { Authorization: `Manage ${manageToken}` } });
}

/** Generated passwords and passphrases: 20 characters from an unambiguous 64-character alphabet with symbols
 *  (120 bits), unbiased. */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#%+-=@_';
  const out: string[] = [];
  while (out.length < length) {
    for (const b of globalThis.crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 256 - (256 % alphabet.length) && out.length < length) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join('');
}

export const chunkPlan = (bytes: number) => ({ chunks: chunkCount(bytes), size: streamSize(bytes) });
