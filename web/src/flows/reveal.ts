/** Recipient flow: meta (changes nothing) → reveal (counts a view) → chunks (docs/crypto.md §3). The server's list of
 *  streams is checked too (docs/crypto.md §3.4): each chunk is authenticated, but only the list says which files exist.
 *  Once POST /reveal has answered, the view is counted (a one-time link is used up), so a download that stops is
 *  continued with the same read session, never by revealing again. */
import { ApiError, api, type Meta, type StreamDesc } from '../api/client';
import * as worker from '../crypto/client';
import { b64u, deriveLink, derivePassphrase, fromUtf8, openBlob, unb64u, type LinkKeys } from '../crypto/format';
import { downloadStream } from './transfer';

export interface Opened {
  meta: Meta;
  keys: LinkKeys;
  title: string | null;
  /** The sending account's name as the server attests it (meta.sender), never the name inside the encrypted meta. */
  from: string | null;
  fields: number | null;
  notes: number | null;
}

export interface RevealedFile {
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

export interface Revealed {
  items: Array<{ t: 'note'; v: string } | { t: 'field'; k: string; v: string; secret: boolean }>;
  files: RevealedFile[];
  views_left: number | null;
}

const revealHeader = (keys: LinkKeys) => ({ Authorization: `Reveal ${b64u(keys.revealToken)}` });

export async function loadMeta(id: string, K: Uint8Array): Promise<Opened> {
  const keys = await deriveLink(id, K);
  const meta = await api<Meta>('GET', `/secrets/${id}/meta`, { headers: revealHeader(keys) });
  let m: unknown;
  try {
    m = JSON.parse(fromUtf8(await openBlob(keys.metaKey, 'meta', id, meta.meta_ct)));
  } catch {
    throw new Error('tampered');
  }
  if (!isObject(m)) throw new Error('tampered');
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
  return { meta, keys, title: typeof m.title === 'string' && m.title ? m.title : null, from: meta.sender || null, fields: count(m.fields), notes: count(m.notes) };
}

/** Demo only: take the link down for everyone. Resolves with the reason the link now shows. */
export async function report(id: string, keys: LinkKeys): Promise<string> {
  const r = await api<{ reason?: string } | undefined>('POST', `/secrets/${id}/report`, { headers: revealHeader(keys) });
  return (r && typeof r === 'object' && r.reason) || 'reported';
}

/** A file name to show and save: no control, format or direction characters (invoice\u202Efdp.exe would show as
 *  invoiceexe.pdf), no path separators, no leading dots (hidden files). */
export function safeFileName(name: string, fallback = 'file'): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').replace(/[/\\]/g, '_').trim().replace(/^[.\s]+/, '');
  return clean || fallback;
}

const tampered = () => new Error('tampered');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stream's nonce prefix: 7 bytes, base64url without padding (docs/crypto.md §3). */
const PREFIX = /^[A-Za-z0-9_-]{10}$/;

/** Streams must be exactly 0…n−1, each once, each with at least one chunk, a size and a 7-byte prefix. Returns them
 *  in stream order. Anything else is a changed stream list ("tampered"), never a download that stops and retries. */
export function checkStreams(streams: StreamDesc[]): StreamDesc[] {
  if (!Array.isArray(streams) || !streams.every(isObject)) throw tampered();
  const sorted = [...streams].sort((a, b) => a.stream - b.stream);
  if (!sorted.length || sorted.some((s, i) => s.stream !== i || !Number.isInteger(s.chunks) || s.chunks < 1
    || !Number.isInteger(s.size) || s.size < 0 || typeof s.prefix !== 'string' || !PREFIX.test(s.prefix))) throw tampered();
  return sorted;
}

// ------------------------------------------------------------------ "you opened this here"
// This tab remembers which links it revealed (the ID and when; never a key or any content), so a reload after the
// key left the address bar, or the same link opened again, says what happened instead of "part of the link is
// missing" or "someone else may have seen it". It also remembers asking: a reveal whose answer never arrived (the
// connection dropped) may have been counted all the same, and a later "already opened" is then most likely this tab.
const OPENED = 'cx-opened';
const ASKED = 'cx-revealing';

function list(key: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    return isObject(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function mark(key: string, id: string, at: string | null): void {
  try {
    const rest = Object.entries(list(key)).filter(([k]) => k !== id).slice(-49);
    sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(at ? [...rest, [id, at]] : rest)));
  } catch {
    /* storage off: the pages just can't say it */
  }
}

export function markOpened(id: string): void {
  mark(OPENED, id, new Date().toISOString());
  mark(ASKED, id, null);
}

/** When this tab revealed the link, if it did. */
export function openedHere(id: string): string | null {
  const at = list(OPENED)[id];
  return typeof at === 'string' ? at : null;
}

/** When this tab asked to reveal the link and never heard back, if it did. */
export function askedHere(id: string): string | null {
  const at = list(ASKED)[id];
  return typeof at === 'string' ? at : null;
}

// ------------------------------------------------------------------ reveal
/** After POST /reveal: what finishing (or continuing) the download needs. Kept by the page until it's done. */
export interface Reading {
  id: string;
  read: Record<string, string>;
  contentKey: Uint8Array;
  streams: StreamDesc[];
  views_left: number | null;
  /** Decrypted chunks so far, per stream, as Blobs. */
  parts: Blob[][];
  done: number;
  total: number;
}

/** Counts a view (the last one of a one-time link). Throws wrong_passphrase, gone, … before anything is counted. */
export async function startReveal(id: string, K: Uint8Array, o: Opened, extra: { passphrase?: string }): Promise<Reading> {
  const headers: Record<string, string> = revealHeader(o.keys);
  let contentKey = o.keys.contentKey;
  if (o.meta.passphrase) {
    const pass = await derivePassphrase(id, K, extra.passphrase ?? '', unb64u(o.meta.passphrase_salt ?? ''), worker.argon2);
    headers['X-Passcheck'] = b64u(pass.passcheck);
    contentKey = pass.contentKey;
  }
  const asked = askedHere(id);
  mark(ASKED, id, asked ?? new Date().toISOString()); // before asking: the answer may never arrive
  let r: { read_session: string; streams: StreamDesc[]; views_left: number | null };
  try {
    r = await api('POST', `/secrets/${id}/reveal`, { headers });
  } catch (e) {
    // The server said no (a wrong passphrase, gone): this time nothing was counted, so it's as before this attempt
    // (an earlier one whose answer was lost still counts). No answer, or a proxy's error page instead of one: it
    // may have been.
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) mark(ASKED, id, asked);
    throw e;
  }
  markOpened(id);
  const streams = checkStreams(r.streams);
  return {
    id, read: { Authorization: `Read ${r.read_session}` }, contentKey, streams, views_left: r.views_left,
    parts: streams.map(() => []), done: 0, total: streams.reduce((n, s) => n + s.size, 0),
  };
}

/** A link that opens more than once was revealed again (its read session had ended): the same content, so the
 *  chunks already here are kept. */
export function carryOver(from: Reading, to: Reading): Reading {
  const same = JSON.stringify(from.streams) === JSON.stringify(to.streams);
  return same ? { ...to, parts: from.parts, done: from.done } : to;
}

/** Download what's missing, check it all (docs/crypto.md §3.4), then confirm the read. Throws Error('tampered'), or an
 *  ApiError: a 404 means the read session is gone (readingGone), anything else can be continued with this Reading. */
export async function finishReveal(r: Reading, onProgress?: (done: number, total: number) => void): Promise<Revealed> {
  for (const s of r.streams) {
    await downloadStream({
      path: (n) => `/secrets/${r.id}/chunks/${s.stream}/${n}`, headers: r.read, key: r.contentKey, id: r.id, stream: s.stream,
      prefix: unb64u(s.prefix), chunks: s.chunks, parts: r.parts[s.stream], onBytes: (n) => onProgress?.((r.done += n), r.total),
    });
  }
  const out = await assemble(r.parts, r.views_left); // throws before the read is confirmed if the files don't add up
  // Confirm: on the last view this deletes the data now instead of after the retry grace.
  await api('DELETE', `/secrets/${r.id}/read`, { headers: r.read }).catch(() => undefined);
  return out;
}

/** The read session ended (it lapsed, or the data was deleted): this Reading can't continue. */
export const readingGone = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 410);

/** The manifest (stream 0) and the files it lists. Every other stream must be one file, used once, of exactly the
 *  size the manifest says; anything else is a server that dropped, swapped or truncated files. */
export async function assemble(parts: Blob[][], views_left: number | null): Promise<Revealed> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fromUtf8(new Uint8Array(await new Blob(parts[0] ?? []).arrayBuffer())));
  } catch {
    throw tampered();
  }
  if (!isObject(manifest) || !Array.isArray(manifest.items)) throw tampered();
  const items: Revealed['items'] = [];
  const files: RevealedFile[] = [];
  const used = new Set<number>();
  for (const it of manifest.items as unknown[]) {
    if (!isObject(it)) throw tampered();
    if (it.t === 'note') items.push({ t: 'note', v: String(it.v ?? '') });
    else if (it.t === 'field') items.push({ t: 'field', k: String(it.k ?? ''), v: String(it.v ?? ''), secret: !!it.secret });
    else if (it.t === 'file') {
      const n = it.stream;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n >= parts.length || used.has(n)) throw tampered();
      used.add(n);
      // Files become Blobs, never text; the declared type only matters for the download name.
      const blob = new Blob(parts[n], { type: 'application/octet-stream' });
      if (blob.size !== it.size) throw tampered();
      files.push({ name: safeFileName(String(it.name ?? '')), type: String(it.type || 'application/octet-stream'), size: blob.size, blob });
    }
  }
  if (used.size !== parts.length - 1) throw tampered();
  return { items, files, views_left };
}
