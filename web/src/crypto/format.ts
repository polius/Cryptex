/**
 * Cryptex crypto format v1 (docs/crypto.md), on WebCrypto.
 * A line-by-line port of reference.py; tested against vectors.json.
 * Runs in the crypto worker and in tests. Never logs or stores key material.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export const VERSION = 'cryptex/v1';
export const CHUNK = 5 * 1024 * 1024;
export const TAG = 16;
export const ARGON2 = { memorySize: 47104, iterations: 1, parallelism: 1, hashLength: 32 } as const;

export type Bytes = Uint8Array<ArrayBuffer>;

// ------------------------------------------------------------------ encoding
export function b64u(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function unhex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u32be(i: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, i >>> 0);
  return b;
}

export const utf8 = (s: string): Bytes => enc.encode(s) as Bytes;
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function random(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export async function sha256(b: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', b as Bytes));
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  return hex(await sha256(b));
}

// ------------------------------------------------------------------ HKDF (RFC 5869, SHA-256, L = 32)
async function hmac(key: Uint8Array, msg: Uint8Array): Promise<Bytes> {
  const k = await subtle.importKey('raw', key as Bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, msg as Bytes));
}

export const extract = (salt: Uint8Array, ikm: Uint8Array) => hmac(salt, ikm);
/** HKDF-Expand with L = 32 is exactly one block: T(1) = HMAC(prk, info || 0x01). */
export const expand = (prk: Uint8Array, info: string) => hmac(prk, concat(utf8(info), new Uint8Array([1])));
export const saltFor = (id: string) => utf8(`${VERSION}/${id}`);

// ------------------------------------------------------------------ §3.1 link key
export interface LinkKeys {
  contentKey: Bytes;
  metaKey: Bytes;
  revealToken: Bytes;
  revealHash: string;
}

export async function deriveLink(id: string, K: Uint8Array): Promise<LinkKeys> {
  if (K.length !== 16) throw new Error('link key must be 16 bytes');
  const prk = await extract(saltFor(id), K);
  const revealToken = await expand(prk, 'reveal');
  return {
    contentKey: await expand(prk, 'content'),
    metaKey: await expand(prk, 'meta'),
    revealToken,
    revealHash: await sha256Hex(revealToken),
  };
}

/** A /s/ fragment must be exactly 22 base64url characters (16 bytes). */
export function parseLinkFragment(fragment: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(fragment)) return null;
  const K = unb64u(fragment);
  return K.length === 16 ? K : null;
}

// ------------------------------------------------------------------ §3.2 passphrase
export type Argon2Fn = (password: string, salt: Uint8Array) => Promise<Uint8Array>;

/** Argon2id settings: the link passphrase uses ARGON2; account passwords pass their own (stronger) ones. */
export interface Kdf { m: number; t: number; p: number }

export async function argon2id(password: string, salt: Uint8Array, kdf?: Kdf): Promise<Bytes> {
  const { argon2id: run } = await import('hash-wasm');
  const params = kdf ? { memorySize: kdf.m, iterations: kdf.t, parallelism: kdf.p, hashLength: 32 } : ARGON2;
  const out = await run({ password, salt, ...params, outputType: 'binary' });
  return new Uint8Array(out);
}

export interface PassKeys {
  contentKey: Bytes;
  passcheck: Bytes;
  passcheckHash: string;
}

export async function derivePassphrase(id: string, K: Uint8Array, passphrase: string, salt: Uint8Array, kdf: Argon2Fn = argon2id): Promise<PassKeys> {
  if (salt.length !== 16) throw new Error('salt must be 16 bytes');
  const pw = await kdf(passphrase, salt);
  const prk = await extract(saltFor(id), concat(K, pw));
  const passcheck = await expand(prk, 'passcheck');
  return { contentKey: await expand(prk, 'content'), passcheck, passcheckHash: await sha256Hex(passcheck) };
}

// ------------------------------------------------------------------ AES-GCM helpers
async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return subtle.importKey('raw', raw as Bytes, { name: 'AES-GCM' }, false, usage);
}

export async function sealBlob(key: Uint8Array, label: string, id: string, plaintext: Uint8Array, nonce: Uint8Array = random(12)): Promise<string> {
  const k = await aesKey(key, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce as Bytes, additionalData: utf8(`${VERSION}|${label}|${id}`) }, k, plaintext as Bytes));
  return b64u(concat(nonce, ct));
}

export async function openBlob(key: Uint8Array, label: string, id: string, blob: string): Promise<Bytes> {
  const raw = unb64u(blob);
  const k = await aesKey(key, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: utf8(`${VERSION}|${label}|${id}`) }, k, raw.slice(12)));
}

// ------------------------------------------------------------------ §3.4 STREAM
export const streamAad = (id: string, stream: number) => concat(utf8(`${VERSION}|${id}|`), u32be(stream));

export function nonceFor(prefix: Uint8Array, i: number, last: boolean): Bytes {
  if (prefix.length !== 7) throw new Error('prefix must be 7 bytes');
  return concat(prefix, u32be(i), new Uint8Array([last ? 1 : 0]));
}

export function chunkCount(plaintextBytes: number, chunkSize = CHUNK): number {
  return Math.max(1, Math.ceil(plaintextBytes / chunkSize));
}

export function streamSize(plaintextBytes: number, chunkSize = CHUNK): number {
  return plaintextBytes + TAG * chunkCount(plaintextBytes, chunkSize);
}

export async function encryptChunk(key: CryptoKey, id: string, stream: number, prefix: Uint8Array, i: number, last: boolean, plaintext: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonceFor(prefix, i, last), additionalData: streamAad(id, stream) }, key, plaintext as Bytes));
}

export async function decryptChunk(key: CryptoKey, id: string, stream: number, prefix: Uint8Array, i: number, last: boolean, ciphertext: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonceFor(prefix, i, last), additionalData: streamAad(id, stream) }, key, ciphertext as Bytes));
}

export const streamKey = (raw: Uint8Array, usage: 'encrypt' | 'decrypt') => aesKey(raw, [usage]);

/** Whole-stream helpers (small streams and tests). Large files go chunk by chunk through the worker. */
export async function streamEncrypt(rawKey: Uint8Array, id: string, stream: number, prefix: Uint8Array, plaintext: Uint8Array, chunkSize = CHUNK): Promise<Bytes[]> {
  const key = await streamKey(rawKey, 'encrypt');
  const n = chunkCount(plaintext.length, chunkSize);
  const out: Bytes[] = [];
  for (let i = 0; i < n; i++) out.push(await encryptChunk(key, id, stream, prefix, i, i === n - 1, plaintext.subarray(i * chunkSize, (i + 1) * chunkSize)));
  return out;
}

/** Throws on tampering, reordering, truncation or extension, and on an empty chunk list (a stream always has at
 *  least one chunk: an empty one is one empty chunk with the last flag). */
export async function streamDecrypt(rawKey: Uint8Array, id: string, stream: number, prefix: Uint8Array, chunks: Uint8Array[]): Promise<Bytes> {
  if (!chunks.length) throw new Error('a stream has at least one chunk');
  const key = await streamKey(rawKey, 'decrypt');
  const parts: Bytes[] = [];
  for (let i = 0; i < chunks.length; i++) parts.push(await decryptChunk(key, id, stream, prefix, i, i === chunks.length - 1, chunks[i]));
  return concat(...parts);
}

// ------------------------------------------------------------------ §4 asking for a secret
export interface AskKeys {
  askKey: Bytes;
  answerToken: Bytes;
  answerHash: string;
}

/** The request link's key R gives the note's key and the token that lets its holder answer (never read). */
export async function deriveAsk(id: string, R: Uint8Array): Promise<AskKeys> {
  if (R.length !== 16) throw new Error('request key must be 16 bytes');
  const prk = await extract(utf8(`${VERSION}/ask/${id}`), R);
  const answerToken = await expand(prk, 'answer');
  return { askKey: await expand(prk, 'ask'), answerToken, answerHash: await sha256Hex(answerToken) };
}

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** The requester's key pair: the private half as a JWK (kept in the account vault), the public half as the 65-byte
 *  uncompressed point (inside the note). */
export async function newRequestKey(): Promise<{ jwk: JsonWebKey; Q: Bytes }> {
  const pair = await subtle.generateKey(P256, true, ['deriveBits']) as CryptoKeyPair;
  return { jwk: await subtle.exportKey('jwk', pair.privateKey), Q: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

async function answerKey(id: string, sid: string, z: Uint8Array, E: Uint8Array, Q: Uint8Array): Promise<Bytes> {
  return expand(await extract(utf8(`${VERSION}/answer/${id}/${sid}`), concat(z, E, Q)), 'answer');
}

const ecdh = async (priv: CryptoKey, pubRaw: Uint8Array) => new Uint8Array(await subtle.deriveBits(
  { name: 'ECDH', public: await subtle.importKey('raw', pubRaw as Bytes, P256, false, []) }, priv, 256));

/** The answer's link key K, encrypted to the requester's public key Q: only their private key opens it. */
export async function wrapAnswer(id: string, sid: string, K: Uint8Array, Q: Uint8Array): Promise<string> {
  if (Q.length !== 65) throw new Error('not a P-256 public key');
  const e = await subtle.generateKey(P256, true, ['deriveBits']) as CryptoKeyPair;
  const E = new Uint8Array(await subtle.exportKey('raw', e.publicKey));
  const key = await answerKey(id, sid, await ecdh(e.privateKey, Q), E, Q);
  return b64u(concat(E, unb64u(await sealBlob(key, 'answer', `${id}|${sid}`, K))));
}

export async function unwrapAnswer(id: string, sid: string, jwk: JsonWebKey, answerCt: string): Promise<Bytes> {
  const raw = unb64u(answerCt);
  const E = raw.slice(0, 65);
  const Q = concat(new Uint8Array([4]), unb64u(jwk.x ?? ''), unb64u(jwk.y ?? ''));
  const d = await subtle.importKey('jwk', jwk, P256, false, ['deriveBits']);
  const key = await answerKey(id, sid, await ecdh(d, E), E, Q);
  return openBlob(key, 'answer', `${id}|${sid}`, b64u(raw.slice(65)));
}
