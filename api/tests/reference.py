#!/usr/bin/env python3
"""
Cryptex crypto format v1 — reference implementation.

This file is normative together with crypto-v1.md: when the two disagree,
fix the document. Run it to regenerate vectors.json and to self-test:

    pip install cryptography argon2-cffi
    python reference.py            # writes vectors.json and verifies it

Implementations (browser module, CLI, server legacy path) must reproduce
every value in vectors.json and must reject every "must_fail" case.
"""
import base64, hashlib, hmac, json, os, struct, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.exceptions import InvalidTag
from argon2.low_level import hash_secret_raw, Type

VERSION = b"cryptex/v1"
MAX_CHUNK = 5 * 1024 * 1024          # encoders use exactly this, except the last chunk
ARGON2 = dict(time_cost=1, memory_cost=47104, parallelism=1, hash_len=32, type=Type.ID)  # 46 MiB

# ---------------------------------------------------------------- encoding
def b64u(b: bytes) -> str: return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def unb64u(s: str) -> bytes: return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
def u32(i: int) -> bytes: return struct.pack(">I", i)
def sha256_hex(b: bytes) -> str: return hashlib.sha256(b).hexdigest()

# ---------------------------------------------------------------- HKDF
def extract(salt: bytes, ikm: bytes) -> bytes: return hmac.new(salt, ikm, hashlib.sha256).digest()
def expand(prk: bytes, info: str, n: int = 32) -> bytes:
    return HKDFExpand(algorithm=hashes.SHA256(), length=n, info=info.encode()).derive(prk)
def salt_for(secret_id: str) -> bytes: return VERSION + b"/" + secret_id.encode()

# ---------------------------------------------------------------- §1 link key
def derive_link(secret_id: str, K: bytes):
    assert len(K) == 16
    prk = extract(salt_for(secret_id), K)
    reveal = expand(prk, "reveal")
    return {"content_key": expand(prk, "content"), "meta_key": expand(prk, "meta"),
            "reveal_token": reveal, "reveal_hash": sha256_hex(reveal)}

# ---------------------------------------------------------------- §2 passphrase
def derive_passphrase(secret_id: str, K: bytes, passphrase: str, salt: bytes):
    assert len(salt) == 16
    pw = hash_secret_raw(passphrase.encode("utf-8"), salt, **ARGON2)
    prk2 = extract(salt_for(secret_id), K + pw)
    passcheck = expand(prk2, "passcheck")
    return {"pw": pw, "content_key": expand(prk2, "content"),
            "passcheck_token": passcheck, "passcheck_hash": sha256_hex(passcheck)}

# ---------------------------------------------------------------- small blobs (meta, prompt)
def seal_blob(key: bytes, label: str, secret_id: str, plaintext: bytes, nonce: bytes) -> str:
    aad = VERSION + b"|" + label.encode() + b"|" + secret_id.encode()
    return b64u(nonce + AESGCM(key).encrypt(nonce, plaintext, aad))
def open_blob(key: bytes, label: str, secret_id: str, blob: str) -> bytes:
    raw = unb64u(blob); aad = VERSION + b"|" + label.encode() + b"|" + secret_id.encode()
    return AESGCM(key).decrypt(raw[:12], raw[12:], aad)

# ---------------------------------------------------------------- §3 STREAM
def stream_aad(secret_id: str, stream: int) -> bytes:
    return VERSION + b"|" + secret_id.encode() + b"|" + u32(stream)
def nonce_for(prefix: bytes, i: int, last: bool) -> bytes:
    assert len(prefix) == 7
    return prefix + u32(i) + (b"\x01" if last else b"\x00")
def stream_encrypt(key, secret_id, stream, prefix, plaintext: bytes, chunk_size=MAX_CHUNK):
    parts = [plaintext[o:o + chunk_size] for o in range(0, max(len(plaintext), 1), chunk_size)] or [b""]
    g = AESGCM(key); aad = stream_aad(secret_id, stream)
    return [g.encrypt(nonce_for(prefix, i, i == len(parts) - 1), p, aad) for i, p in enumerate(parts)]
def stream_decrypt(key, secret_id, stream, prefix, chunks):
    """Raises on tampering, reordering, truncation or extension."""
    g = AESGCM(key); aad = stream_aad(secret_id, stream); out = []
    for i, c in enumerate(chunks):
        last = i == len(chunks) - 1
        out.append(g.decrypt(nonce_for(prefix, i, last), c, aad))  # final chunk must carry the last flag
    return b"".join(out)

# ---------------------------------------------------------------- §4 requests
def p256_from_scalar(d: int): return ec.derive_private_key(d, ec.SECP256R1())
def spki(pub) -> bytes:
    return pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
def request_link(secret_id: str, P: bytes, requester_pub):
    fp = hashlib.sha256(spki(requester_pub)).digest()[:8]
    prk = extract(salt_for(secret_id), P)
    at = expand(prk, "answer-token")
    return {"fragment": b64u(P + fp), "fingerprint": fp.hex(), "prompt_key": expand(prk, "prompt"),
            "answer_token": at, "answer_token_hash": sha256_hex(at)}
def parse_request_fragment(fragment: str):
    raw = unb64u(fragment)
    if len(raw) != 24: raise ValueError("incomplete link")
    return raw[:16], raw[16:]
def answer_key(secret_id: str, own_priv, peer_pub) -> bytes:
    shared = own_priv.exchange(ec.ECDH(), peer_pub)
    return expand(extract(salt_for(secret_id), shared), "answer")

# ---------------------------------------------------------------- vectors
def det(label: str, n: int) -> bytes:
    """Deterministic bytes for vectors only. Real code uses crypto.getRandomValues."""
    return hashlib.sha256(b"cryptex-test-vector|" + label.encode()).digest()[:n]

def build():
    V = {"version": "cryptex/v1", "note": "All byte values are hex unless the key ends in _b64u. Generated by reference.py.", "cases": {}}
    sid = "k7Qp2vR9mL"; K = det("K", 16)
    d = derive_link(sid, K)
    V["cases"]["link"] = {"id": sid, "K": K.hex(), "K_b64u": b64u(K),
        "link": f"https://vault.example/s/{sid}#{b64u(K)}",
        "content_key": d["content_key"].hex(), "meta_key": d["meta_key"].hex(),
        "reveal_token_b64u": b64u(d["reveal_token"]), "reveal_hash": d["reveal_hash"]}

    meta_pt = json.dumps({"title": "Staging database", "from": "Sam Rivera"}, separators=(",", ":")).encode()
    mn = det("meta-nonce", 12)
    V["cases"]["meta"] = {"id": sid, "meta_key": d["meta_key"].hex(), "nonce": mn.hex(),
        "plaintext": meta_pt.decode(), "meta_ct_b64u": seal_blob(d["meta_key"], "meta", sid, meta_pt, mn)}

    manifest = json.dumps({"v": 1, "items": [
        {"t": "field", "k": "Host", "v": "db-staging.internal:5432", "secret": False},
        {"t": "field", "k": "Password", "v": "k7#Qp2-vR9mL", "secret": True},
        {"t": "file", "name": "vpn.ovpn", "type": "application/x-openvpn-profile", "size": 70, "stream": 1}]},
        separators=(",", ":")).encode()
    file_pt = b"client\ndev tun\nproto udp\nremote vpn.example 1194\nresolv-retry infinite\n"[:70]
    p0, p1 = det("prefix-0", 7), det("prefix-1", 7)
    s0 = stream_encrypt(d["content_key"], sid, 0, p0, manifest, chunk_size=64)
    s1 = stream_encrypt(d["content_key"], sid, 1, p1, file_pt, chunk_size=32)
    V["cases"]["stream"] = {"id": sid, "content_key": d["content_key"].hex(),
        "note": "chunk_size is reduced for testing; production encoders use 5242880.",
        "streams": [
          {"stream": 0, "prefix": p0.hex(), "chunk_size": 64, "plaintext": manifest.decode(), "chunks": [c.hex() for c in s0]},
          {"stream": 1, "prefix": p1.hex(), "chunk_size": 32, "plaintext_hex": file_pt.hex(), "chunks": [c.hex() for c in s1]}],
        "must_fail": [
          {"name": "truncated: last chunk dropped", "stream": 1, "prefix": p1.hex(), "chunks": [c.hex() for c in s1[:-1]]},
          {"name": "reordered: chunks 0 and 1 swapped", "stream": 1, "prefix": p1.hex(), "chunks": [s1[1].hex(), s1[0].hex()] + [c.hex() for c in s1[2:]]},
          {"name": "stream index swapped (file decrypted as stream 0)", "stream": 0, "prefix": p1.hex(), "chunks": [c.hex() for c in s1]},
          {"name": "extended: chunk appended after final", "stream": 1, "prefix": p1.hex(), "chunks": [c.hex() for c in s1] + [s1[0].hex()]}]}

    salt = det("argon-salt", 16)
    pp = derive_passphrase(sid, K, "copper-lantern-river-42", salt)
    V["cases"]["passphrase"] = {"id": sid, "K": K.hex(), "passphrase": "copper-lantern-river-42", "salt": salt.hex(),
        "argon2id": {"m_kib": 47104, "t": 1, "p": 1, "len": 32}, "pw": pp["pw"].hex(),
        "content_key": pp["content_key"].hex(), "passcheck_token_b64u": b64u(pp["passcheck_token"]),
        "passcheck_hash": pp["passcheck_hash"],
        "note": "meta_key and reveal_token do not change when a passphrase is set, so the title shows before the passphrase is asked."}

    rid = "7hk2Vn4pXa"; P = det("P", 16)
    req_priv = p256_from_scalar(int.from_bytes(det("requester-d", 32), "big") % (2**256 - 2**224) + 1)
    rl = request_link(rid, P, req_priv.public_key())
    prompt_pt = json.dumps({"title": "AWS read-only keys", "from": "Sam Rivera",
        "message": "Read-only on the billing account is enough. Thanks!", "fields": ["Access key ID", "Secret access key"], "files": False},
        separators=(",", ":")).encode()
    pn = det("prompt-nonce", 12)
    eph = p256_from_scalar(int.from_bytes(det("responder-e", 32), "big") % (2**256 - 2**224) + 1)
    ak = answer_key(rid, eph, req_priv.public_key()); ak2 = answer_key(rid, req_priv, eph.public_key())
    assert ak == ak2
    answer_pt = json.dumps({"v": 1, "items": [{"t": "field", "k": "Access key ID", "v": "AKIAIOSFODNN7EXAMPLE", "secret": False},
        {"t": "field", "k": "Secret access key", "v": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "secret": True}]},
        separators=(",", ":")).encode()
    ap = det("answer-prefix", 7)
    ans = stream_encrypt(ak, rid, 0, ap, answer_pt, chunk_size=64)
    V["cases"]["request"] = {"id": rid, "P": P.hex(),
        "requester_private_scalar": format(req_priv.private_numbers().private_value, "064x"),
        "requester_spki_b64u": b64u(spki(req_priv.public_key())),
        "fragment_b64u": rl["fragment"], "link": f"https://vault.example/q/{rid}#{rl['fragment']}",
        "fingerprint": rl["fingerprint"], "prompt_key": rl["prompt_key"].hex(),
        "answer_token_b64u": b64u(rl["answer_token"]), "answer_token_hash": rl["answer_token_hash"],
        "prompt": {"nonce": pn.hex(), "plaintext": prompt_pt.decode(), "prompt_ct_b64u": seal_blob(rl["prompt_key"], "prompt", rid, prompt_pt, pn)},
        "answer": {"responder_ephemeral_private_scalar": format(eph.private_numbers().private_value, "064x"),
                   "responder_ephemeral_spki_b64u": b64u(spki(eph.public_key())), "answer_key": ak.hex(),
                   "stream": 0, "prefix": ap.hex(), "chunk_size": 64, "plaintext": answer_pt.decode(), "chunks": [c.hex() for c in ans]},
        "must_fail": [{"name": "fragment cut to 20 characters", "fragment_b64u": rl["fragment"][:20]},
                      {"name": "server swapped the public key (fingerprint mismatch)",
                       "spki_b64u": b64u(spki(p256_from_scalar(12345).public_key())), "expected_fingerprint": rl["fingerprint"]}]}
    V["cases"]["link_must_fail"] = [{"name": "key cut by a chat app", "fragment": b64u(K)[:14], "reason": "not 22 base64url characters"},
                                    {"name": "missing fragment", "fragment": "", "reason": "no key"}]
    return V

def verify(V):
    c = V["cases"]; sid = c["link"]["id"]; K = bytes.fromhex(c["link"]["K"])
    d = derive_link(sid, K)
    assert d["content_key"].hex() == c["link"]["content_key"] and d["reveal_hash"] == c["link"]["reveal_hash"]
    assert open_blob(d["meta_key"], "meta", sid, c["meta"]["meta_ct_b64u"]).decode() == c["meta"]["plaintext"]
    for st in c["stream"]["streams"]:
        pt = stream_decrypt(d["content_key"], sid, st["stream"], bytes.fromhex(st["prefix"]), [bytes.fromhex(x) for x in st["chunks"]])
        assert pt == (st["plaintext"].encode() if "plaintext" in st else bytes.fromhex(st["plaintext_hex"]))
    for f in c["stream"]["must_fail"]:
        try:
            stream_decrypt(d["content_key"], sid, f["stream"], bytes.fromhex(f["prefix"]), [bytes.fromhex(x) for x in f["chunks"]])
            raise AssertionError("must fail: " + f["name"])
        except InvalidTag:
            pass
    r = c["request"]; priv = p256_from_scalar(int(r["requester_private_scalar"], 16))
    P, fp = parse_request_fragment(r["fragment_b64u"])
    assert hashlib.sha256(spki(priv.public_key())).digest()[:8] == fp
    rl = request_link(r["id"], P, priv.public_key())
    assert open_blob(rl["prompt_key"], "prompt", r["id"], r["prompt"]["prompt_ct_b64u"]).decode() == r["prompt"]["plaintext"]
    eph_pub = serialization.load_der_public_key(unb64u(r["answer"]["responder_ephemeral_spki_b64u"]))
    ak = answer_key(r["id"], priv, eph_pub)
    pt = stream_decrypt(ak, r["id"], 0, bytes.fromhex(r["answer"]["prefix"]), [bytes.fromhex(x) for x in r["answer"]["chunks"]])
    assert pt.decode() == r["answer"]["plaintext"]
    try: parse_request_fragment(r["must_fail"][0]["fragment_b64u"]); raise AssertionError("short fragment accepted")
    except ValueError: pass
    bad = serialization.load_der_public_key(unb64u(r["must_fail"][1]["spki_b64u"]))
    assert hashlib.sha256(spki(bad)).digest()[:8].hex() != r["must_fail"][1]["expected_fingerprint"]
    pp = c["passphrase"]
    got = derive_passphrase(sid, K, pp["passphrase"], bytes.fromhex(pp["salt"]))
    assert got["passcheck_hash"] == pp["passcheck_hash"] and got["content_key"].hex() == pp["content_key"]
    return True

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors.json")
    V = build()
    with open(out, "w") as f: json.dump(V, f, indent=2)
    with open(out) as f: assert verify(json.load(f))
    print("vectors.json written and verified:", ", ".join(V["cases"]))
