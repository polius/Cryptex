// Package crypto implements the Cryptex crypto format v1 (design/v3/spec/crypto-v1.md).
//
// It is byte-compatible with spec/reference.py and verified against spec/vectors.json.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
)

const (
	// Version is the format string bound into every salt and AAD.
	Version = "cryptex/v1"
	// ChunkSize is the plaintext size of every chunk except the last.
	ChunkSize = 5 * 1024 * 1024
	// TagSize is the AES-GCM tag length.
	TagSize = 16
	// MaxChunkCiphertext is the largest chunk a decoder accepts.
	MaxChunkCiphertext = ChunkSize + TagSize
	// PrefixSize is the per-stream random nonce prefix.
	PrefixSize = 7
	// SecretFragmentLen is the length of a /s/ link fragment (b64u of 16 bytes).
	SecretFragmentLen = 22
	// RequestFragmentLen is the length of a /q/ link fragment (b64u of 16 + 8 bytes).
	RequestFragmentLen = 32

	argonTime    = 1
	argonMemory  = 47104 // KiB
	argonThreads = 1
)

// ErrIncompleteLink is returned when a link fragment isn't the exact expected length.
var ErrIncompleteLink = errors.New("link incomplete: the key after # is missing or cut off")

// ErrTampered is returned when authenticated decryption fails.
var ErrTampered = errors.New("decryption failed: the data was changed, truncated, reordered or the key is wrong")

// B64u encodes without padding (RFC 4648 §5).
func B64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// UnB64u decodes base64url without padding and rejects anything else.
func UnB64u(s string) ([]byte, error) {
	if !IsB64u(s) {
		return nil, errors.New("not base64url")
	}
	return base64.RawURLEncoding.DecodeString(s)
}

// IsB64u reports whether s uses only the base64url alphabet.
func IsB64u(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// SHA256Hex is hex(SHA-256(b)).
func SHA256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// Random returns n bytes from crypto/rand.
func Random(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return b
}

// Salt is "cryptex/v1/" || id.
func Salt(id string) []byte { return []byte(Version + "/" + id) }

// Extract is HKDF-Extract with SHA-256.
func Extract(salt, ikm []byte) []byte {
	m := hmac.New(sha256.New, salt)
	m.Write(ikm)
	return m.Sum(nil)
}

// Expand is HKDF-Expand(prk, info = label, L = 32).
func Expand(prk []byte, label string) []byte {
	out, err := hkdf.Expand(sha256.New, prk, label, 32)
	if err != nil {
		panic(err)
	}
	return out
}

// LinkKeys are the values derived from a secret's link key K (§3.1).
type LinkKeys struct {
	ContentKey  []byte
	MetaKey     []byte
	RevealToken []byte
}

// RevealHash is hex(SHA-256(reveal_token)).
func (k LinkKeys) RevealHash() string { return SHA256Hex(k.RevealToken) }

// DeriveLink derives §3.1 values from K (16 bytes).
func DeriveLink(id string, K []byte) LinkKeys {
	if len(K) != 16 {
		panic("link key must be 16 bytes")
	}
	prk := Extract(Salt(id), K)
	return LinkKeys{ContentKey: Expand(prk, "content"), MetaKey: Expand(prk, "meta"), RevealToken: Expand(prk, "reveal")}
}

// PassKeys are the values derived when a passphrase is set (§3.2).
type PassKeys struct {
	PW         []byte
	ContentKey []byte
	Passcheck  []byte
}

// PasscheckHash is hex(SHA-256(passcheck)).
func (k PassKeys) PasscheckHash() string { return SHA256Hex(k.Passcheck) }

// Argon2id runs the §3.2 password hash (m = 47104 KiB, t = 1, p = 1, len = 32).
func Argon2id(passphrase string, salt []byte) []byte {
	return argon2.IDKey([]byte(passphrase), salt, argonTime, argonMemory, argonThreads, 32)
}

// DerivePassphrase derives §3.2 values. salt must be 16 bytes.
func DerivePassphrase(id string, K []byte, passphrase string, salt []byte) PassKeys {
	if len(salt) != 16 {
		panic("passphrase salt must be 16 bytes")
	}
	pw := Argon2id(passphrase, salt)
	ikm := append(append([]byte{}, K...), pw...)
	prk := Extract(Salt(id), ikm)
	return PassKeys{PW: pw, ContentKey: Expand(prk, "content"), Passcheck: Expand(prk, "passcheck")}
}

func gcm(key []byte) cipher.AEAD {
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return g
}

func blobAAD(label, id string) []byte { return []byte(Version + "|" + label + "|" + id) }

// SealBlob encrypts a small blob (meta, prompt): b64u(nonce || AES-GCM(key, nonce, pt, aad)).
// A nil nonce means a random one.
func SealBlob(key []byte, label, id string, plaintext, nonce []byte) string {
	if nonce == nil {
		nonce = Random(12)
	}
	out := gcm(key).Seal(append([]byte{}, nonce...), nonce, plaintext, blobAAD(label, id))
	return B64u(out)
}

// OpenBlob decrypts a blob made by SealBlob.
func OpenBlob(key []byte, label, id, blob string) ([]byte, error) {
	raw, err := UnB64u(blob)
	if err != nil || len(raw) < 12+TagSize {
		return nil, ErrTampered
	}
	pt, err := gcm(key).Open(nil, raw[:12], raw[12:], blobAAD(label, id))
	if err != nil {
		return nil, ErrTampered
	}
	return pt, nil
}

// StreamAAD is "cryptex/v1|" || id || "|" || u32be(stream).
func StreamAAD(id string, stream uint32) []byte {
	aad := []byte(Version + "|" + id + "|")
	return binary.BigEndian.AppendUint32(aad, stream)
}

// Nonce is prefix || u32be(i) || last_flag.
func Nonce(prefix []byte, i uint32, last bool) []byte {
	if len(prefix) != PrefixSize {
		panic("nonce prefix must be 7 bytes")
	}
	n := make([]byte, 0, 12)
	n = append(n, prefix...)
	n = binary.BigEndian.AppendUint32(n, i)
	if last {
		return append(n, 1)
	}
	return append(n, 0)
}

// Stream encrypts or decrypts one STREAM (§3.4) chunk by chunk.
type Stream struct {
	aead   cipher.AEAD
	prefix []byte
	aad    []byte
}

// NewStream prepares a stream cipher for (key, id, stream index, prefix).
func NewStream(key []byte, id string, stream uint32, prefix []byte) *Stream {
	if len(prefix) != PrefixSize {
		panic("nonce prefix must be 7 bytes")
	}
	return &Stream{aead: gcm(key), prefix: append([]byte{}, prefix...), aad: StreamAAD(id, stream)}
}

// Seal encrypts chunk i, appending to dst.
func (s *Stream) Seal(dst []byte, i uint32, last bool, plaintext []byte) []byte {
	return s.aead.Seal(dst, Nonce(s.prefix, i, last), plaintext, s.aad)
}

// Open decrypts chunk i, appending to dst. last must be true exactly for the final chunk.
func (s *Stream) Open(dst []byte, i uint32, last bool, ciphertext []byte) ([]byte, error) {
	if len(ciphertext) < TagSize || len(ciphertext) > MaxChunkCiphertext {
		return nil, ErrTampered
	}
	out, err := s.aead.Open(dst, Nonce(s.prefix, i, last), ciphertext, s.aad)
	if err != nil {
		return nil, ErrTampered
	}
	return out, nil
}

// ChunkCount is max(1, ceil(n / ChunkSize)).
func ChunkCount(n int64) int64 {
	if n <= 0 {
		return 1
	}
	return (n + ChunkSize - 1) / ChunkSize
}

// CiphertextSize is the stream size declared on create: plaintext + 16 × chunks.
func CiphertextSize(n int64) int64 { return n + TagSize*ChunkCount(n) }

// EncryptAll encrypts a whole in-memory plaintext with the given chunk size (for small streams and tests).
func EncryptAll(key []byte, id string, stream uint32, prefix, plaintext []byte, chunkSize int) [][]byte {
	s := NewStream(key, id, stream, prefix)
	var parts [][]byte
	for o := 0; o < len(plaintext); o += chunkSize {
		parts = append(parts, plaintext[o:min(o+chunkSize, len(plaintext))])
	}
	if len(parts) == 0 {
		parts = [][]byte{{}}
	}
	out := make([][]byte, len(parts))
	for i, p := range parts {
		out[i] = s.Seal(nil, uint32(i), i == len(parts)-1, p)
	}
	return out
}

// DecryptAll decrypts a complete list of chunks; it fails on tampering, reordering, truncation or extension.
func DecryptAll(key []byte, id string, stream uint32, prefix []byte, chunks [][]byte) ([]byte, error) {
	if len(chunks) == 0 {
		return nil, ErrTampered
	}
	s := NewStream(key, id, stream, prefix)
	var out []byte
	for i, c := range chunks {
		var err error
		out, err = s.Open(out, uint32(i), i == len(chunks)-1, c)
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ParseSecretFragment returns K from a /s/ link fragment. The fragment must be exactly 22 base64url characters.
func ParseSecretFragment(fragment string) ([]byte, error) {
	if len(fragment) != SecretFragmentLen || !IsB64u(fragment) {
		return nil, ErrIncompleteLink
	}
	K, err := base64.RawURLEncoding.DecodeString(fragment)
	if err != nil || len(K) != 16 {
		return nil, ErrIncompleteLink
	}
	return K, nil
}

// ParseRequestFragment returns (P, fingerprint) from a /q/ link fragment (exactly 32 base64url characters).
func ParseRequestFragment(fragment string) (P, fp []byte, err error) {
	if len(fragment) != RequestFragmentLen || !IsB64u(fragment) {
		return nil, nil, ErrIncompleteLink
	}
	raw, err := base64.RawURLEncoding.DecodeString(fragment)
	if err != nil || len(raw) != 24 {
		return nil, nil, ErrIncompleteLink
	}
	return raw[:16], raw[16:], nil
}

// RequestKeys are the values derived from a request's P (§4).
type RequestKeys struct {
	Fragment    string
	Fingerprint []byte
	PromptKey   []byte
	AnswerToken []byte
}

// AnswerTokenHash is hex(SHA-256(answer_token)).
func (k RequestKeys) AnswerTokenHash() string { return SHA256Hex(k.AnswerToken) }

// Fingerprint is SHA-256(SPKI-DER)[0..8].
func Fingerprint(spki []byte) []byte {
	h := sha256.Sum256(spki)
	return h[:8]
}

// DeriveRequest derives §4 values from P (16 bytes) and the requester's SPKI DER public key.
func DeriveRequest(id string, P, spki []byte) RequestKeys {
	if len(P) != 16 {
		panic("request key must be 16 bytes")
	}
	fp := Fingerprint(spki)
	prk := Extract(Salt(id), P)
	return RequestKeys{
		Fragment:    B64u(append(append([]byte{}, P...), fp...)),
		Fingerprint: fp,
		PromptKey:   Expand(prk, "prompt"),
		AnswerToken: Expand(prk, "answer-token"),
	}
}

// PromptKeys derives prompt_key and answer_token from P alone (the responder side).
func PromptKeys(id string, P []byte) (promptKey, answerToken []byte) {
	prk := Extract(Salt(id), P)
	return Expand(prk, "prompt"), Expand(prk, "answer-token")
}

// GenerateP256 makes a new P-256 key pair.
func GenerateP256() (*ecdh.PrivateKey, error) { return ecdh.P256().GenerateKey(rand.Reader) }

// SPKI encodes a P-256 public key as SubjectPublicKeyInfo DER.
func SPKI(pub *ecdh.PublicKey) []byte {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		panic(err)
	}
	return der
}

// ParseSPKI decodes a SubjectPublicKeyInfo DER P-256 public key.
func ParseSPKI(der []byte) (*ecdh.PublicKey, error) {
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("not a public key: %w", err)
	}
	var pub *ecdh.PublicKey
	switch v := k.(type) {
	case *ecdsa.PublicKey:
		pub, err = v.ECDH()
	case *ecdh.PublicKey:
		pub = v
	default:
		return nil, errors.New("not an EC public key")
	}
	if err != nil {
		return nil, err
	}
	if pub.Curve() != ecdh.P256() {
		return nil, errors.New("not a P-256 public key")
	}
	return pub, nil
}

// AnswerKey is Expand(HKDF-Extract(salt(id), ECDH(own, peer)), "answer").
func AnswerKey(id string, own *ecdh.PrivateKey, peer *ecdh.PublicKey) ([]byte, error) {
	shared, err := own.ECDH(peer)
	if err != nil {
		return nil, err
	}
	return Expand(Extract(Salt(id), shared), "answer"), nil
}

// MarshalPrivateKey encodes a private key as PKCS#8 DER.
func MarshalPrivateKey(k *ecdh.PrivateKey) []byte {
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		panic(err)
	}
	return der
}

// ParsePrivateKey decodes a PKCS#8 DER P-256 private key.
func ParsePrivateKey(der []byte) (*ecdh.PrivateKey, error) {
	k, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	switch v := k.(type) {
	case *ecdsa.PrivateKey:
		return v.ECDH()
	case *ecdh.PrivateKey:
		return v, nil
	}
	return nil, errors.New("not an EC private key")
}
