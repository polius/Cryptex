/** Recipient flow: meta (changes nothing) → optional code → reveal (counts a view) → chunks (crypto-v1 §3). */
import { api, type Meta, type StreamDesc } from '../api/client';
import * as worker from '../crypto/client';
import { b64u, concat, deriveLink, derivePassphrase, fromUtf8, openBlob, unb64u, type LinkKeys } from '../crypto/format';
import { downloadStream } from './transfer';

export interface Opened {
  meta: Meta;
  keys: LinkKeys;
  title: string | null;
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
  views_left: number;
}

const revealHeader = (keys: LinkKeys) => ({ Authorization: `Reveal ${b64u(keys.revealToken)}` });

export async function loadMeta(id: string, K: Uint8Array): Promise<Opened> {
  const keys = await deriveLink(id, K);
  const meta = await api<Meta>('GET', `/secrets/${id}/meta`, { headers: revealHeader(keys) });
  let m: { title?: string; from?: string; fields?: number; notes?: number };
  try {
    m = JSON.parse(fromUtf8(await openBlob(keys.metaKey, 'meta', id, meta.meta_ct)));
  } catch {
    throw new Error('tampered');
  }
  return { meta, keys, title: m.title || null, from: m.from || null, fields: typeof m.fields === 'number' ? m.fields : null, notes: typeof m.notes === 'number' ? m.notes : null };
}

export const startCode = (id: string, keys: LinkKeys) => api('POST', `/secrets/${id}/verify/start`, { headers: revealHeader(keys) });

export async function checkCode(id: string, keys: LinkKeys, code: string): Promise<string> {
  return (await api<{ grant: string }>('POST', `/secrets/${id}/verify`, { body: { code }, headers: revealHeader(keys) })).grant;
}

export const report = (id: string, keys: LinkKeys) => api('POST', `/secrets/${id}/report`, { headers: revealHeader(keys) });

export async function reveal(id: string, K: Uint8Array, o: Opened, extra: { passphrase?: string; grant?: string },
  onProgress?: (done: number, total: number) => void): Promise<Revealed> {
  const headers: Record<string, string> = revealHeader(o.keys);
  let contentKey = o.keys.contentKey;
  if (o.meta.passphrase) {
    const pass = await derivePassphrase(id, K, extra.passphrase ?? '', unb64u(o.meta.passphrase_salt ?? ''), worker.argon2);
    headers['X-Passcheck'] = b64u(pass.passcheck);
    contentKey = pass.contentKey;
  }
  if (extra.grant) headers['X-Access-Grant'] = extra.grant;
  const r = await api<{ read_session: string; streams: StreamDesc[]; views_left: number }>('POST', `/secrets/${id}/reveal`, { headers });
  const read = { Authorization: `Read ${r.read_session}` };
  const total = r.streams.reduce((n, s) => n + s.size, 0);
  let done = 0;
  const plain: Uint8Array[][] = [];
  for (const s of r.streams) {
    plain.push(await downloadStream({
      path: (n) => `/secrets/${id}/chunks/${s.stream}/${n}`, headers: read, key: contentKey, id, stream: s.stream,
      prefix: unb64u(s.prefix), chunks: s.chunks, onBytes: (n) => onProgress?.((done += n), total),
    }));
  }
  // Confirm: on the last view this deletes the data now instead of after the retry grace.
  await api('DELETE', `/secrets/${id}/read`, { headers: read }).catch(() => undefined);
  return assemble(plain, r.views_left);
}

export function assemble(plain: Uint8Array[][], views_left: number): Revealed {
  const manifest = JSON.parse(fromUtf8(concat(...plain[0]))) as { v: number; items: Array<Record<string, unknown>> };
  const items: Revealed['items'] = [];
  const files: RevealedFile[] = [];
  for (const it of manifest.items) {
    if (it.t === 'note') items.push({ t: 'note', v: String(it.v ?? '') });
    else if (it.t === 'field') items.push({ t: 'field', k: String(it.k ?? ''), v: String(it.v ?? ''), secret: !!it.secret });
    else if (it.t === 'file') {
      const parts = plain[Number(it.stream)] ?? [];
      // Files become Blobs, never text; the declared type only matters for the download name.
      files.push({ name: String(it.name || 'file'), type: String(it.type || 'application/octet-stream'), size: Number(it.size || 0),
        blob: new Blob(parts as BlobPart[], { type: 'application/octet-stream' }) });
    }
  }
  return { items, files, views_left };
}
