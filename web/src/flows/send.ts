/** Sending a secret: create → encrypt with the assigned ID → upload chunks → seal (crypto-v1 §3, openapi /secrets). */
import { api, type Config, type Policy, type StreamDesc } from '../api/client';
import * as worker from '../crypto/client';
import { b64u, chunkCount, deriveLink, derivePassphrase, random, sealBlob, streamSize, utf8 } from '../crypto/format';
import { receipts } from '../store/db';
import { bytesSource, fileSource, sealWithRetry, uploadStream, type Source } from './transfer';

export type Item =
  | { t: 'note'; v: string }
  | { t: 'field'; k: string; v: string; secret: boolean };

export interface Draft {
  title: string;
  items: Item[];
  files: File[];
}

export interface PolicyChoice {
  views: number;
  expires_in: number;
  access: 'link' | 'email' | 'org';
  email?: string;
  notify: boolean;
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
}

export async function proofOfWork(cfg: Config): Promise<Record<string, string>> {
  if (!cfg.demo) return {};
  const c = await api<{ challenge: string; bits: number }>('GET', '/demo/challenge');
  return { 'X-PoW': `${c.challenge}:${await worker.pow(c.challenge, c.bits)}` };
}

export function publicOrigin(cfg: Config): string {
  return (cfg.brand.public_url || location.origin).replace(/\/$/, '');
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

export async function sendSecret(cfg: Config, d: Draft, p: PolicyChoice, onProgress: (p: Progress) => void, signal?: AbortSignal,
  onCreated?: (id: string, uploadToken: string) => void): Promise<Sent> {
  const manifest = utf8(JSON.stringify(manifestOf(d)));
  const sources: Source[] = [bytesSource(manifest), ...d.files.map(fileSource)];
  const prefixes = sources.map(() => random(7));
  const streams: StreamDesc[] = sources.map((s, i) => ({ stream: i, prefix: b64u(prefixes[i]), chunks: chunkCount(s.size), size: streamSize(s.size) }));
  const salt = p.passphrase ? random(16) : null;
  const policy: Policy = { views: p.views, expires_in: p.expires_in, access: p.access, notify: p.notify, passphrase: !!salt };
  if (p.access === 'email') policy.email = p.email;
  if (salt) policy.passphrase_salt = b64u(salt);

  const created = await api<{ id: string; upload_token: string; manage_token: string; expires_at: string }>('POST', '/secrets', {
    body: { policy, streams }, headers: await proofOfWork(cfg), signal,
  });
  const { id } = created;
  onCreated?.(id, created.upload_token);
  const K = random(16);
  const keys = await deriveLink(id, K);
  const pass = salt ? await derivePassphrase(id, K, p.passphrase!, salt, worker.argon2) : null;
  const contentKey = pass ? pass.contentKey : keys.contentKey;

  const total = sources.reduce((n, s) => n + s.size, 0);
  let done = 0;
  for (let i = 0; i < sources.length; i++) {
    await uploadStream({
      base: `/secrets/${id}`, uploadToken: created.upload_token, key: contentKey, id, stream: i, prefix: prefixes[i], src: sources[i], signal,
      onBytes: (n) => {
        done += n;
        onProgress({ stream: i, done, total });
      },
    });
  }
  const meta_ct = await sealBlob(keys.metaKey, 'meta', id, utf8(JSON.stringify({ title: d.title.trim() || null, from: cfg.user?.name || null, fields: d.items.filter((x) => x.t === 'field').length, notes: d.items.filter((x) => x.t === 'note').length })));
  await sealWithRetry(`/secrets/${id}/seal`, { meta_ct, reveal_hash: keys.revealHash, ...(pass ? { passcheck_hash: pass.passcheckHash } : {}) },
    created.upload_token, signal);
  const link = `${publicOrigin(cfg)}/s/${id}#${b64u(K)}`;
  await receipts.put({
    kind: 'secret', id, manage_token: created.manage_token, title: d.title.trim(), created_at: new Date().toISOString(),
    expires_at: created.expires_at, link, last_status: 'waiting', fields: d.items.filter((x) => x.t === 'field').length,
    files: d.files.length, access: p.access, email: p.email, views: p.views,
  });
  return { id, link, manage_token: created.manage_token, expires_at: created.expires_at };
}

export async function cancelUpload(id: string, uploadToken: string): Promise<void> {
  await api('DELETE', `/secrets/${id}/upload`, { headers: { Authorization: `Upload ${uploadToken}` } }).catch(() => undefined);
}

export async function destroySecret(id: string, manageToken: string): Promise<void> {
  await api('DELETE', `/secrets/${id}`, { headers: { Authorization: `Manage ${manageToken}` } });
}

/** Passphrases: 4 words from the EFF large wordlist plus a 2-digit number (about 54 bits). */
export async function generatePassphrase(): Promise<string> {
  const { default: words } = await import('./words');
  const pick = () => words[new Uint32Array(globalThis.crypto.getRandomValues(new Uint32Array(1)))[0] % words.length];
  const n = globalThis.crypto.getRandomValues(new Uint8Array(1))[0] % 90 + 10;
  return `${pick()}-${pick()}-${pick()}-${pick()}-${n}`;
}

/** Generated passwords: 20 characters, unambiguous alphabet with symbols, unbiased. */
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
