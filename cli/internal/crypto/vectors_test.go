package crypto

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

type vecStream struct {
	Stream       uint32   `json:"stream"`
	Prefix       string   `json:"prefix"`
	ChunkSize    int      `json:"chunk_size"`
	Plaintext    *string  `json:"plaintext"`
	PlaintextHex *string  `json:"plaintext_hex"`
	Chunks       []string `json:"chunks"`
	Name         string   `json:"name"`
}

type vectors struct {
	Version string `json:"version"`
	Cases   struct {
		Link struct {
			ID, K, KB64u, Link, ContentKey, MetaKey, RevealTokenB64u, RevealHash string
		} `json:"-"`
		LinkRaw map[string]string `json:"link"`
		Meta    map[string]string `json:"meta"`
		Stream  struct {
			ID         string      `json:"id"`
			ContentKey string      `json:"content_key"`
			Streams    []vecStream `json:"streams"`
			MustFail   []vecStream `json:"must_fail"`
		} `json:"stream"`
		Passphrase struct {
			ID                 string `json:"id"`
			K                  string `json:"K"`
			Passphrase         string `json:"passphrase"`
			Salt               string `json:"salt"`
			PW                 string `json:"pw"`
			ContentKey         string `json:"content_key"`
			PasscheckTokenB64u string `json:"passcheck_token_b64u"`
			PasscheckHash      string `json:"passcheck_hash"`
			Argon2id           struct {
				M   uint32 `json:"m_kib"`
				T   uint32 `json:"t"`
				P   uint8  `json:"p"`
				Len uint32 `json:"len"`
			} `json:"argon2id"`
		} `json:"passphrase"`
		Request struct {
			ID                     string `json:"id"`
			P                      string `json:"P"`
			RequesterPrivateScalar string `json:"requester_private_scalar"`
			RequesterSPKIB64u      string `json:"requester_spki_b64u"`
			FragmentB64u           string `json:"fragment_b64u"`
			Link                   string `json:"link"`
			Fingerprint            string `json:"fingerprint"`
			PromptKey              string `json:"prompt_key"`
			AnswerTokenB64u        string `json:"answer_token_b64u"`
			AnswerTokenHash        string `json:"answer_token_hash"`
			Prompt                 struct {
				Nonce, Plaintext string
				PromptCtB64u     string `json:"prompt_ct_b64u"`
			} `json:"prompt"`
			Answer struct {
				EphPriv   string   `json:"responder_ephemeral_private_scalar"`
				EphSPKI   string   `json:"responder_ephemeral_spki_b64u"`
				AnswerKey string   `json:"answer_key"`
				Stream    uint32   `json:"stream"`
				Prefix    string   `json:"prefix"`
				ChunkSize int      `json:"chunk_size"`
				Plaintext string   `json:"plaintext"`
				Chunks    []string `json:"chunks"`
			} `json:"answer"`
			MustFail []struct {
				Name                string `json:"name"`
				FragmentB64u        string `json:"fragment_b64u"`
				SPKIB64u            string `json:"spki_b64u"`
				ExpectedFingerprint string `json:"expected_fingerprint"`
			} `json:"must_fail"`
		} `json:"request"`
		LinkMustFail []struct {
			Name, Fragment, Reason string
		} `json:"link_must_fail"`
	} `json:"cases"`
}

func load(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Version != Version {
		t.Fatalf("vectors version %q, want %q", v.Version, Version)
	}
	return v
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func unb(t *testing.T, s string) []byte {
	t.Helper()
	b, err := UnB64u(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func eq(t *testing.T, name string, got, want any) {
	t.Helper()
	if gb, ok := got.([]byte); ok {
		got = hex.EncodeToString(gb)
	}
	if got != want {
		t.Errorf("%s:\n got %v\nwant %v", name, got, want)
	}
}

func TestVectorLink(t *testing.T) {
	c := load(t).Cases.LinkRaw
	K := unhex(t, c["K"])
	eq(t, "K_b64u", B64u(K), c["K_b64u"])
	d := DeriveLink(c["id"], K)
	eq(t, "content_key", d.ContentKey, c["content_key"])
	eq(t, "meta_key", d.MetaKey, c["meta_key"])
	eq(t, "reveal_token_b64u", B64u(d.RevealToken), c["reveal_token_b64u"])
	eq(t, "reveal_hash", d.RevealHash(), c["reveal_hash"])
	eq(t, "link", "https://vault.example/s/"+c["id"]+"#"+B64u(K), c["link"])
	got, err := ParseSecretFragment(c["K_b64u"])
	if err != nil || !bytes.Equal(got, K) {
		t.Fatalf("ParseSecretFragment: %x %v", got, err)
	}
}

func TestVectorMeta(t *testing.T) {
	c := load(t).Cases.Meta
	key := unhex(t, c["meta_key"])
	ct := SealBlob(key, "meta", c["id"], []byte(c["plaintext"]), unhex(t, c["nonce"]))
	eq(t, "meta_ct_b64u", ct, c["meta_ct_b64u"])
	pt, err := OpenBlob(key, "meta", c["id"], c["meta_ct_b64u"])
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "plaintext", string(pt), c["plaintext"])
	if _, err := OpenBlob(key, "meta", "k7Qp2vR9mX", c["meta_ct_b64u"]); err == nil {
		t.Fatal("meta opened under another ID")
	}
	if _, err := OpenBlob(key, "prompt", c["id"], c["meta_ct_b64u"]); err == nil {
		t.Fatal("meta opened under the prompt label")
	}
}

func streamPT(t *testing.T, s vecStream) []byte {
	if s.Plaintext != nil {
		return []byte(*s.Plaintext)
	}
	return unhex(t, *s.PlaintextHex)
}

func chunks(t *testing.T, hexes []string) [][]byte {
	out := make([][]byte, len(hexes))
	for i, h := range hexes {
		out[i] = unhex(t, h)
	}
	return out
}

func TestVectorStream(t *testing.T) {
	c := load(t).Cases.Stream
	key := unhex(t, c.ContentKey)
	// The stream content key must match the one derived in the link case.
	if got := DeriveLink(c.ID, unhex(t, load(t).Cases.LinkRaw["K"])).ContentKey; !bytes.Equal(got, key) {
		t.Fatal("stream content_key differs from link content_key")
	}
	for _, s := range c.Streams {
		pt := streamPT(t, s)
		enc := EncryptAll(key, c.ID, s.Stream, unhex(t, s.Prefix), pt, s.ChunkSize)
		if len(enc) != len(s.Chunks) {
			t.Fatalf("stream %d: %d chunks, want %d", s.Stream, len(enc), len(s.Chunks))
		}
		for i := range enc {
			eq(t, "chunk", enc[i], s.Chunks[i])
		}
		got, err := DecryptAll(key, c.ID, s.Stream, unhex(t, s.Prefix), chunks(t, s.Chunks))
		if err != nil || !bytes.Equal(got, pt) {
			t.Fatalf("stream %d decrypt: %v", s.Stream, err)
		}
	}
	if len(c.MustFail) == 0 {
		t.Fatal("no must_fail cases")
	}
	for _, f := range c.MustFail {
		_, err := DecryptAll(key, c.ID, f.Stream, unhex(t, f.Prefix), chunks(t, f.Chunks))
		if !errors.Is(err, ErrTampered) {
			t.Errorf("must fail: %s (got %v)", f.Name, err)
		}
	}
}

func TestStreamEmpty(t *testing.T) {
	key, prefix := Random(32), Random(7)
	enc := EncryptAll(key, "k7Qp2vR9mL", 3, prefix, nil, ChunkSize)
	if len(enc) != 1 || len(enc[0]) != TagSize {
		t.Fatalf("empty stream: %d chunks", len(enc))
	}
	pt, err := DecryptAll(key, "k7Qp2vR9mL", 3, prefix, enc)
	if err != nil || len(pt) != 0 {
		t.Fatal(err)
	}
	if ChunkCount(0) != 1 || CiphertextSize(0) != 16 || ChunkCount(ChunkSize) != 1 || ChunkCount(ChunkSize+1) != 2 ||
		CiphertextSize(ChunkSize+1) != ChunkSize+1+32 {
		t.Fatal("chunk arithmetic")
	}
}

func TestVectorPassphrase(t *testing.T) {
	c := load(t).Cases.Passphrase
	if c.Argon2id.M != argonMemory || c.Argon2id.T != argonTime || c.Argon2id.P != argonThreads || c.Argon2id.Len != 32 {
		t.Fatalf("argon2 parameters differ: %+v", c.Argon2id)
	}
	K := unhex(t, c.K)
	d := DerivePassphrase(c.ID, K, c.Passphrase, unhex(t, c.Salt))
	eq(t, "pw", d.PW, c.PW)
	eq(t, "content_key", d.ContentKey, c.ContentKey)
	eq(t, "passcheck_token_b64u", B64u(d.Passcheck), c.PasscheckTokenB64u)
	eq(t, "passcheck_hash", d.PasscheckHash(), c.PasscheckHash)
	// meta_key and reveal_token don't depend on the passphrase.
	l := load(t).Cases.LinkRaw
	eq(t, "meta_key unchanged", DeriveLink(c.ID, K).MetaKey, l["meta_key"])
}

func TestVectorRequest(t *testing.T) {
	r := load(t).Cases.Request
	priv, err := ecdh.P256().NewPrivateKey(unhex(t, r.RequesterPrivateScalar))
	if err != nil {
		t.Fatal(err)
	}
	spki := SPKI(priv.PublicKey())
	eq(t, "requester_spki_b64u", B64u(spki), r.RequesterSPKIB64u)
	P := unhex(t, r.P)
	d := DeriveRequest(r.ID, P, spki)
	eq(t, "fragment_b64u", d.Fragment, r.FragmentB64u)
	eq(t, "fingerprint", d.Fingerprint, r.Fingerprint)
	eq(t, "prompt_key", d.PromptKey, r.PromptKey)
	eq(t, "answer_token_b64u", B64u(d.AnswerToken), r.AnswerTokenB64u)
	eq(t, "answer_token_hash", d.AnswerTokenHash(), r.AnswerTokenHash)
	eq(t, "link", "https://vault.example/q/"+r.ID+"#"+d.Fragment, r.Link)

	gotP, fp, err := ParseRequestFragment(r.FragmentB64u)
	if err != nil || !bytes.Equal(gotP, P) || !bytes.Equal(fp, Fingerprint(spki)) {
		t.Fatalf("ParseRequestFragment: %v", err)
	}
	pk, at := PromptKeys(r.ID, gotP)
	if !bytes.Equal(pk, d.PromptKey) || !bytes.Equal(at, d.AnswerToken) {
		t.Fatal("PromptKeys differs from DeriveRequest")
	}

	ct := SealBlob(d.PromptKey, "prompt", r.ID, []byte(r.Prompt.Plaintext), unhex(t, r.Prompt.Nonce))
	eq(t, "prompt_ct_b64u", ct, r.Prompt.PromptCtB64u)
	pt, err := OpenBlob(d.PromptKey, "prompt", r.ID, r.Prompt.PromptCtB64u)
	if err != nil || string(pt) != r.Prompt.Plaintext {
		t.Fatalf("prompt open: %v", err)
	}

	a := r.Answer
	eph, err := ecdh.P256().NewPrivateKey(unhex(t, a.EphPriv))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "responder_ephemeral_spki_b64u", B64u(SPKI(eph.PublicKey())), a.EphSPKI)
	// Responder side: ECDH(e, pub) from the server-provided SPKI.
	reqPub, err := ParseSPKI(unb(t, r.RequesterSPKIB64u))
	if err != nil {
		t.Fatal(err)
	}
	ak, err := AnswerKey(r.ID, eph, reqPub)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "answer_key (responder)", ak, a.AnswerKey)
	// Requester side: ECDH(priv, E).
	ephPub, err := ParseSPKI(unb(t, a.EphSPKI))
	if err != nil {
		t.Fatal(err)
	}
	ak2, err := AnswerKey(r.ID, priv, ephPub)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "answer_key (requester)", ak2, a.AnswerKey)
	enc := EncryptAll(ak, r.ID, a.Stream, unhex(t, a.Prefix), []byte(a.Plaintext), a.ChunkSize)
	for i := range enc {
		eq(t, "answer chunk", enc[i], a.Chunks[i])
	}
	got, err := DecryptAll(ak2, r.ID, a.Stream, unhex(t, a.Prefix), chunks(t, a.Chunks))
	if err != nil || string(got) != a.Plaintext {
		t.Fatalf("answer decrypt: %v", err)
	}

	// PKCS#8 round trip for the local key store.
	back, err := ParsePrivateKey(MarshalPrivateKey(priv))
	if err != nil || !back.Equal(priv) {
		t.Fatal("PKCS#8 round trip")
	}

	if len(r.MustFail) != 2 {
		t.Fatalf("want 2 request must_fail cases, got %d", len(r.MustFail))
	}
	for _, f := range r.MustFail {
		switch {
		case f.FragmentB64u != "":
			if _, _, err := ParseRequestFragment(f.FragmentB64u); !errors.Is(err, ErrIncompleteLink) {
				t.Errorf("must fail: %s", f.Name)
			}
		case f.SPKIB64u != "":
			bad, err := ParseSPKI(unb(t, f.SPKIB64u))
			if err != nil {
				t.Fatal(err)
			}
			if hex.EncodeToString(Fingerprint(SPKI(bad))) == f.ExpectedFingerprint {
				t.Errorf("must fail: %s", f.Name)
			}
		default:
			t.Errorf("unknown must_fail case %q", f.Name)
		}
	}
}

func TestVectorLinkMustFail(t *testing.T) {
	cases := load(t).Cases.LinkMustFail
	if len(cases) == 0 {
		t.Fatal("no link_must_fail cases")
	}
	for _, c := range cases {
		if _, err := ParseSecretFragment(c.Fragment); !errors.Is(err, ErrIncompleteLink) {
			t.Errorf("must fail: %s (%s)", c.Name, c.Reason)
		}
	}
	// More cut and padded variants.
	K := load(t).Cases.LinkRaw["K_b64u"]
	for _, f := range []string{K[:21], K + "A", K[:20] + "==", strings.Replace(K, "h", "+", 1), strings.Replace(K, "h", "/", 1)} {
		if _, err := ParseSecretFragment(f); err == nil {
			t.Errorf("accepted fragment %q", f)
		}
	}
}

func TestGeneratePassphrase(t *testing.T) {
	if len(Words) != 7776 {
		t.Fatalf("wordlist has %d words", len(Words))
	}
	p := GeneratePassphrase()
	parts := strings.Split(p, "-")
	if len(parts) != 5 || len(parts[4]) != 2 {
		t.Fatalf("passphrase %q", p)
	}
	if GeneratePassphrase() == p {
		t.Fatal("passphrases repeat")
	}
}
