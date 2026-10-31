/** Every value in vectors.json, and every must_fail case (docs/crypto.md). */
import { describe, expect, it } from 'vitest';
import { assemble, checkStreams } from '../flows/reveal';
import V from '../../../docs/vectors.json';
import { b64u, deriveAsk, deriveLink, derivePassphrase, fromUtf8, hex, newRequestKey, openBlob, parseLinkFragment, sealBlob, streamDecrypt, streamEncrypt, unb64u, unhex, unwrapAnswer, utf8, wrapAnswer } from './format';

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

describe('reveal checks (§3.4)', () => {
  const r = c.reveal;

  it('the stream vector passes them, and gives back its fields and file', async () => {
    const s = c.stream;
    const list = checkStreams(s.streams.map((st) => ({ stream: st.stream, prefix: b64u(unhex(st.prefix)), chunks: st.chunks.length, size: 0 })));
    const parts = await Promise.all(list.map(async (d) => {
      const st = s.streams[d.stream];
      return [new Blob([await streamDecrypt(unhex(s.content_key), s.id, d.stream, unhex(st.prefix), st.chunks.map(unhex))])];
    }));
    const out = await assemble(parts, null);
    expect(out.items.map((i) => (i.t === 'field' ? i.k : i.t))).toEqual(['Host', 'Password']);
    expect(out.files.map((f) => [f.name, f.size])).toEqual([['vpn.ovpn', 70]]);
  });

  for (const f of r.stream_list_must_fail) {
    it(`rejects the stream list: ${f.name}`, () => {
      expect(() => checkStreams(f.streams as never)).toThrow('tampered');
    });
  }
  for (const f of r.manifest_must_fail) {
    it(`rejects the manifest: ${f.name}`, async () => {
      const sizes = f.sizes as Record<string, number>;
      const parts: Blob[][] = [[new Blob([utf8(JSON.stringify(f.manifest))])]];
      for (const [n, size] of Object.entries(sizes)) parts[Number(n)] = [new Blob([new Uint8Array(size)])];
      await expect(assemble(parts, null)).rejects.toThrow('tampered');
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

describe('asking for a secret (§4)', () => {
  const q = c.request;
  it('derives the note key and answer token, and opens the note', async () => {
    const a = await deriveAsk(q.id, unhex(q.R));
    expect(hex(a.askKey)).toBe(q.ask_key);
    expect(b64u(a.answerToken)).toBe(q.answer_token_b64u);
    expect(a.answerHash).toBe(q.answer_hash);
    expect(await sealBlob(a.askKey, 'ask', q.id, utf8(q.ask_plaintext), unhex(q.ask_nonce))).toBe(q.ask_ct_b64u);
    expect(q.link.endsWith('#' + b64u(unhex(q.R)))).toBe(true);
  });

  it("opens the reference's answer with the requester's key", async () => {
    expect(hex(await unwrapAnswer(q.id, q.answer_id, q.requester_jwk, q.answer_ct_b64u))).toBe(q.answer_K);
  });

  it('wraps for the requester alone, bound to the request and the answer', async () => {
    const mine = await newRequestKey();
    const other = await newRequestKey();
    const K = unhex(q.answer_K);
    const ct = await wrapAnswer(q.id, q.answer_id, K, mine.Q);
    expect(await unwrapAnswer(q.id, q.answer_id, mine.jwk, ct)).toEqual(K);
    await expect(unwrapAnswer(q.id, q.answer_id, other.jwk, ct)).rejects.toThrow();
    await expect(unwrapAnswer(q.id, 'XXXXXXXXXX', mine.jwk, ct)).rejects.toThrow();
    expect(mine.Q.length).toBe(65);
    expect(unb64u(mine.jwk.d!).length).toBe(32);
  });
});
