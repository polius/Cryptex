/** Requests (crypto-v1 §4): the answer is encrypted to the requester's P-256 key, which stays on their device. */
import { api, type Config, type StreamDesc } from '../api/client';
import {
  answerKey, b64u, chunkCount, equalBytes, fingerprint, fromUtf8, importPublic, openBlob, P256, parseRequestFragment,
  random, requestLink, sealBlob, spki, streamSize, unb64u, utf8,
} from '../crypto/format';
import { receipts, requestKeys } from '../store/db';
import { assemble, type Revealed } from './reveal';
import { proofOfWork, publicOrigin, type Item } from './send';
import { bytesSource, downloadStream, fileSource, sealWithRetry, uploadStream, type Source } from './transfer';

export interface Prompt {
  title: string;
  from: string | null;
  message: string;
  fields: string[];
  files: boolean;
}

export interface Asked {
  id: string;
  link: string;
  backup: string;      // /q/{id}/key#pkcs8.manage: shown on request, never stored
  manage_token: string;
  expires_at: string;
}

export async function createRequest(cfg: Config, p: Omit<Prompt, 'from'>, o: { expires_in: number; keep_answer_s: number; notify: boolean }): Promise<Asked> {
  const subtle = globalThis.crypto.subtle;
  const pair = (await subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = await spki(pair.publicKey);
  const created = await api<{ id: string; manage_token: string; upload_token: string; expires_at: string }>('POST', '/requests', {
    body: { public_key: b64u(pub), expires_in: o.expires_in, keep_answer_s: o.keep_answer_s, files: p.files, notify: o.notify },
    headers: await proofOfWork(cfg),
  });
  const P = random(16);
  const rl = await requestLink(created.id, P, pub);
  const prompt: Prompt = { ...p, from: cfg.user?.name || null };
  const prompt_ct = await sealBlob(rl.promptKey, 'prompt', created.id, utf8(JSON.stringify(prompt)));
  await api('POST', `/requests/${created.id}/seal`, {
    body: { prompt_ct, answer_token_hash: rl.answerTokenHash }, headers: { Authorization: `Upload ${created.upload_token}` },
  });
  // Export once for the optional backup link, then keep only a non-extractable copy on this device.
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const stored = await subtle.importKey('pkcs8', pkcs8, P256, false, ['deriveBits']);
  await requestKeys.put(created.id, stored);
  const origin = publicOrigin(cfg);
  const link = `${origin}/q/${created.id}#${rl.fragment}`;
  await receipts.put({
    kind: 'request', id: created.id, manage_token: created.manage_token, title: p.title, created_at: new Date().toISOString(),
    expires_at: created.expires_at, link, last_status: 'waiting', fields: p.fields.length, files: p.files ? 1 : 0, keep_answer_s: o.keep_answer_s,
  });
  return { id: created.id, link, backup: `${origin}/q/${created.id}/key#${b64u(pkcs8)}.${created.manage_token}`, manage_token: created.manage_token, expires_at: created.expires_at };
}

/** /q/{id}/key#pkcs8.manage: import a backup key (and the receipt that goes with it) on another device. */
export async function importBackupKey(id: string, fragment: string): Promise<void> {
  const [pk, manage] = fragment.split('.');
  const key = await globalThis.crypto.subtle.importKey('pkcs8', unb64u(pk), P256, false, ['deriveBits']);
  await requestKeys.put(id, key);
  if (manage && !(await receipts.get('request', id))) {
    await receipts.put({ kind: 'request', id, manage_token: manage, title: '', created_at: new Date().toISOString(), last_status: 'waiting',
      fields: 0, files: 0, other_device: true });
  }
}

// ------------------------------------------------------------------ responder
export interface LoadedPrompt {
  prompt: Prompt;
  publicKey: CryptoKey;
  answerToken: string;
  expires_at: string;
  limits: { max_files: number; max_file_bytes: number; max_message_chars: number };
}

export class KeyMismatch extends Error {}

export async function loadPrompt(id: string, fragment: string): Promise<LoadedPrompt> {
  const parsed = parseRequestFragment(fragment);
  if (!parsed) throw new Error('incomplete_link');
  // The answer token and prompt key come from P; the fingerprint is checked against the key the server returns.
  const prk = await requestLinkFromP(id, parsed.P);
  const r = await api<{ public_key: string; prompt_ct: string; expires_at: string; limits: LoadedPrompt['limits'] }>('GET', `/requests/${id}/prompt`, {
    headers: { Authorization: `Answer ${prk.answerToken}` },
  });
  const pubDer = unb64u(r.public_key);
  if (!equalBytes(await fingerprint(pubDer), parsed.fp)) throw new KeyMismatch('key_mismatch');
  const prompt = JSON.parse(fromUtf8(await openBlob(prk.promptKey, 'prompt', id, r.prompt_ct))) as Prompt;
  return { prompt, publicKey: await importPublic(pubDer), answerToken: prk.answerToken, expires_at: r.expires_at, limits: r.limits };
}

async function requestLinkFromP(id: string, P: Uint8Array): Promise<{ answerToken: string; promptKey: Uint8Array }> {
  // requestLink needs an SPKI only for the fingerprint; the tokens depend on P alone.
  const rl = await requestLink(id, P, new Uint8Array(0));
  return { answerToken: b64u(rl.answerToken), promptKey: rl.promptKey };
}

export async function sendAnswer(cfg: Config, id: string, lp: LoadedPrompt, items: Item[], files: File[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const subtle = globalThis.crypto.subtle;
  const eph = (await subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
  const key = await answerKey(id, eph.privateKey, lp.publicKey);
  const manifest = utf8(JSON.stringify({
    v: 1, items: [...items, ...files.map((f, i) => ({ t: 'file', name: f.name, type: f.type || 'application/octet-stream', size: f.size, stream: i + 1 }))],
  }));
  const sources: Source[] = [bytesSource(manifest), ...files.map(fileSource)];
  const prefixes = sources.map(() => random(7));
  const streams: StreamDesc[] = sources.map((s, i) => ({ stream: i, prefix: b64u(prefixes[i]), chunks: chunkCount(s.size), size: streamSize(s.size) }));
  const started = await api<{ upload_token: string }>('POST', `/requests/${id}/answer`, {
    body: { ephemeral_key: b64u(await spki(eph.publicKey)), streams },
    headers: { Authorization: `Answer ${lp.answerToken}`, ...(await proofOfWork(cfg)) },
  });
  const total = sources.reduce((n, s) => n + s.size, 0);
  let done = 0;
  for (let i = 0; i < sources.length; i++) {
    await uploadStream({
      base: `/requests/${id}/answer`, uploadToken: started.upload_token, key, id, stream: i, prefix: prefixes[i], src: sources[i],
      onBytes: (n) => onProgress?.((done += n), total),
    });
  }
  await sealWithRetry(`/requests/${id}/answer/seal`, undefined, started.upload_token);
}

// ------------------------------------------------------------------ requester reads the answer
export class NoKey extends Error {}

export async function readAnswer(id: string, manageToken: string, onProgress?: (done: number, total: number) => void): Promise<Revealed & { kept_until: string }> {
  const priv = await requestKeys.get(id);
  if (!priv) throw new NoKey('no_key');
  const h = { Authorization: `Manage ${manageToken}` };
  const d = await api<{ ephemeral_key: string; streams: StreamDesc[]; answered_at: string | null; kept_until: string }>('GET', `/requests/${id}/answer`, { headers: h });
  if (!d.answered_at) throw new Error('not_answered');
  const key = await answerKey(id, priv, await importPublic(unb64u(d.ephemeral_key)));
  const total = d.streams.reduce((n, s) => n + s.size, 0);
  let done = 0;
  const plain: Uint8Array[][] = [];
  for (const s of d.streams) {
    plain.push(await downloadStream({
      path: (n) => `/requests/${id}/answer/chunks/${s.stream}/${n}`, headers: h, key, id, stream: s.stream, prefix: unb64u(s.prefix),
      chunks: s.chunks, onBytes: (n) => onProgress?.((done += n), total),
    }));
  }
  return { ...assemble(plain, 0), kept_until: d.kept_until };
}

export async function cancelRequest(id: string, manageToken: string): Promise<void> {
  await api('DELETE', `/requests/${id}`, { headers: { Authorization: `Manage ${manageToken}` } });
}
