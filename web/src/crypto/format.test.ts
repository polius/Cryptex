/** Every value in vectors.json, and every must_fail case (crypto-v1.md). */
import { describe, expect, it } from 'vitest';
import V from './vectors.json';
import {
  answerKey, b64u, deriveLink, derivePassphrase, fingerprint, fromUtf8, hex, importPublic, openBlob, parseLinkFragment,
  parseRequestFragment, privateJwk, requestLink, sealBlob, streamDecrypt, streamEncrypt, unb64u, unhex, utf8,
} from './format';

const c = V.cases;

describe('link', () => {
  it('derives keys and the reveal hash', async () => {
    const d = await deriveLink(c.link.id, unhex(c.link.K));
    expect(hex(d.contentKey)).toBe(c.link.content_key);
    expect(hex(d.metaKey)).toBe(c.link.meta_key);
    expect(b64u(d.revealToken)).toBe(c.link.reveal_token_b64u);
    expect(d.revealHash).toBe(c.link.reveal_hash);
    expect(c.link.link.endsWith('#' + c.link.K_b64u)).toBe(true);
  });

  it('parses only a full 22-character fragment', () => {
    expect(parseLinkFragment(c.link.K_b64u)).toEqual(unhex(c.link.K));
    for (const f of c.link_must_fail) expect(parseLinkFragment(f.fragment)).toBeNull();
    expect(parseLinkFragment(c.link.K_b64u + 'A')).toBeNull();
  });
});

describe('meta blob', () => {
  it('reproduces the ciphertext and opens it', async () => {
    const m = c.meta;
    expect(await sealBlob(unhex(m.meta_key), 'meta', m.id, utf8(m.plaintext), unhex(m.nonce))).toBe(m.meta_ct_b64u);
    expect(fromUtf8(await openBlob(unhex(m.meta_key), 'meta', m.id, m.meta_ct_b64u))).toBe(m.plaintext);
  });

  it('is bound to the ID', async () => {
    await expect(openBlob(unhex(c.meta.meta_key), 'meta', 'XXXXXXXXXX', c.meta.meta_ct_b64u)).rejects.toThrow();
  });
});

describe('STREAM', () => {
  const s = c.stream;
  for (const st of s.streams) {
    it(`stream ${st.stream} encrypts to the vector and decrypts back`, async () => {
      const pt = 'plaintext' in st ? utf8(st.plaintext as string) : unhex(st.plaintext_hex as string);
      const chunks = await streamEncrypt(unhex(s.content_key), s.id, st.stream, unhex(st.prefix), pt, st.chunk_size);
      expect(chunks.map(hex)).toEqual(st.chunks);
      const back = await streamDecrypt(unhex(s.content_key), s.id, st.stream, unhex(st.prefix), st.chunks.map(unhex));
      expect(back).toEqual(pt);
    });
  }
  for (const f of s.must_fail) {
    it(`rejects: ${f.name}`, async () => {
      await expect(streamDecrypt(unhex(s.content_key), s.id, f.stream, unhex(f.prefix), f.chunks.map(unhex))).rejects.toThrow();
    });
  }
});

describe('passphrase', () => {
  it('derives the Argon2id key, content key and passcheck', async () => {
    const p = c.passphrase;
    const d = await derivePassphrase(p.id, unhex(p.K), p.passphrase, unhex(p.salt));
    expect(hex(d.contentKey)).toBe(p.content_key);
    expect(b64u(d.passcheck)).toBe(p.passcheck_token_b64u);
    expect(d.passcheckHash).toBe(p.passcheck_hash);
    const link = await deriveLink(p.id, unhex(p.K));
    expect(hex(link.metaKey)).toBe(c.link.meta_key); // meta key unchanged, so the title shows first
  }, 20000);
});

describe('requests', () => {
  const r = c.request;
  it('builds the link fragment and tokens', async () => {
    const k = await requestLink(r.id, unhex(r.P), unb64u(r.requester_spki_b64u));
    expect(k.fragment).toBe(r.fragment_b64u);
    expect(hex(k.promptKey)).toBe(r.prompt_key);
    expect(b64u(k.answerToken)).toBe(r.answer_token_b64u);
    expect(k.answerTokenHash).toBe(r.answer_token_hash);
    expect(hex(await fingerprint(unb64u(r.requester_spki_b64u)))).toBe(r.fingerprint);
  });

  it('opens the prompt', async () => {
    const pt = await openBlob(unhex(r.prompt_key), 'prompt', r.id, r.prompt.prompt_ct_b64u);
    expect(fromUtf8(pt)).toBe(r.prompt.plaintext);
  });

  it('derives the same answer key on both sides and decrypts the answer', async () => {
    const subtle = globalThis.crypto.subtle;
    const reqSpki = unb64u(r.requester_spki_b64u);
    const ephSpki = unb64u(r.answer.responder_ephemeral_spki_b64u);
    const reqPriv = await subtle.importKey('jwk', privateJwk(unhex(r.requester_private_scalar), reqSpki), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const ephPriv = await subtle.importKey('jwk', privateJwk(unhex(r.answer.responder_ephemeral_private_scalar), ephSpki), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const a1 = await answerKey(r.id, ephPriv, await importPublic(reqSpki));
    const a2 = await answerKey(r.id, reqPriv, await importPublic(ephSpki));
    expect(hex(a1)).toBe(r.answer.answer_key);
    expect(hex(a2)).toBe(r.answer.answer_key);
    const pt = await streamDecrypt(a2, r.id, 0, unhex(r.answer.prefix), r.answer.chunks.map(unhex));
    expect(fromUtf8(pt)).toBe(r.answer.plaintext);
  });

  it('rejects a cut fragment and a swapped key', async () => {
    expect(parseRequestFragment(r.must_fail[0].fragment_b64u as string)).toBeNull();
    const parsed = parseRequestFragment(r.fragment_b64u)!;
    expect(hex(parsed.fp)).toBe(r.fingerprint);
    const swapped = await fingerprint(unb64u(r.must_fail[1].spki_b64u as string));
    expect(hex(swapped)).not.toBe(r.must_fail[1].expected_fingerprint);
  });
});
