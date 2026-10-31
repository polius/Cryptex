#!/usr/bin/env python3
"""
Cryptex crypto format v1 — reference implementation.

This file is normative together with docs/crypto.md: when the two disagree,
fix the document. Run it to regenerate docs/vectors.json and to self-test:

    pip install cryptography argon2-cffi
    python tests/reference.py      # writes docs/vectors.json and verifies it

Implementations (the browser module) must reproduce
every value in vectors.json and must reject every "must_fail" case.
"""
import base64, hashlib, hmac, json, os, struct, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand
from cryptography.hazmat.primitives import hashes
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
    """Raises on tampering, reordering, truncation or extension, and on an empty chunk list."""
    if not chunks:
        raise ValueError("a stream has at least one chunk")  # an empty stream is one empty chunk with the last flag
    g = AESGCM(key); aad = stream_aad(secret_id, stream); out = []
    for i, c in enumerate(chunks):
        last = i == len(chunks) - 1
        out.append(g.decrypt(nonce_for(prefix, i, last), c, aad))  # final chunk must carry the last flag
    return b"".join(out)

def is_int(v) -> bool: return isinstance(v, int) and not isinstance(v, bool)
B64U = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

def check_streams(streams):
    """The stream list a server returns on reveal: exactly 0..n-1, each once, each with at least one chunk, a size
    and a 7-byte nonce prefix (base64url, 10 characters)."""
    def ok(s):
        return (isinstance(s, dict) and is_int(s.get("stream")) and is_int(s.get("chunks")) and is_int(s.get("size"))
                and s["size"] >= 0 and isinstance(s.get("prefix"), str) and len(s["prefix"]) == 10
                and all(ch in B64U for ch in s["prefix"]))
    if not streams or not all(ok(s) for s in streams):
        raise ValueError("stream list is not a list of streams")
    if sorted(s["stream"] for s in streams) != list(range(len(streams))) or any(s["chunks"] < 1 for s in streams):
        raise ValueError("stream list is not 0..n-1 with at least one chunk each")

def check_files(manifest, plain):
    """The manifest is an object whose items are objects; every stream n >= 1 is exactly one file of the manifest,
    and decrypts to the size the manifest gives. `plain` maps stream number to decrypted bytes."""
    if not isinstance(manifest, dict) or not isinstance(manifest.get("items"), list):
        raise ValueError("not a manifest")
    used = set()
    for it in manifest["items"]:
        if not isinstance(it, dict):
            raise ValueError("a manifest item isn't an object")
        if it.get("t") != "file":
            continue
        n = it.get("stream")
        if not is_int(n) or n < 1 or n not in plain or n in used or it.get("size") != len(plain[n]):
            raise ValueError("file streams don't match the manifest")
        used.add(n)
    if used != set(plain) - {0}:
        raise ValueError("a stream isn't in the manifest")

# ---------------------------------------------------------------- §4 requests
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

def derive_ask(request_id: str, R: bytes):
    assert len(R) == 16
    prk = extract(VERSION + b"/ask/" + request_id.encode(), R)
    token = expand(prk, "answer")
    return {"ask_key": expand(prk, "ask"), "answer_token": token, "answer_hash": sha256_hex(token)}

def raw_public(key) -> bytes:
    return key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)

def _answer_key(request_id: str, secret_id: str, z: bytes, E: bytes, Q: bytes) -> bytes:
    return expand(extract(VERSION + b"/answer/" + f"{request_id}/{secret_id}".encode(), z + E + Q), "answer")

def wrap_answer(request_id: str, secret_id: str, K: bytes, Q: bytes, e=None, nonce: bytes | None = None) -> str:
    """The answer's link key K, encrypted to the requester's public key Q (65 bytes, uncompressed)."""
    e = e or ec.generate_private_key(ec.SECP256R1()); E = raw_public(e)
    z = e.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), Q))
    nonce = nonce or os.urandom(12)
    aad = VERSION + b"|answer|" + f"{request_id}|{secret_id}".encode()
    return b64u(E + nonce + AESGCM(_answer_key(request_id, secret_id, z, E, Q)).encrypt(nonce, K, aad))

def unwrap_answer(request_id: str, secret_id: str, d, answer_ct: str) -> bytes:
    raw = unb64u(answer_ct); E, nonce, ct = raw[:65], raw[65:77], raw[77:]
    z = d.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), E))
    aad = VERSION + b"|answer|" + f"{request_id}|{secret_id}".encode()
    return AESGCM(_answer_key(request_id, secret_id, z, E, raw_public(d))).decrypt(nonce, ct, aad)

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

    meta_pt = json.dumps({"title": "Staging database", "from": None, "fields": 2, "notes": 0}, separators=(",", ":")).encode()
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
          {"name": "extended: chunk appended after final", "stream": 1, "prefix": p1.hex(), "chunks": [c.hex() for c in s1] + [s1[0].hex()]},
          {"name": "empty: no chunks at all", "stream": 1, "prefix": p1.hex(), "chunks": []}]}

    salt = det("argon-salt", 16)
    pp = derive_passphrase(sid, K, "copper-lantern-river-42", salt)
    V["cases"]["passphrase"] = {"id": sid, "K": K.hex(), "passphrase": "copper-lantern-river-42", "salt": salt.hex(),
        "argon2id": {"m_kib": 47104, "t": 1, "p": 1, "len": 32}, "pw": pp["pw"].hex(),
        "content_key": pp["content_key"].hex(), "passcheck_token_b64u": b64u(pp["passcheck_token"]),
        "passcheck_hash": pp["passcheck_hash"],
        "note": "meta_key and reveal_token do not change when a passphrase is set, so the title shows before the passphrase is asked."}

    # §3.4 checks on reveal. Only stream numbers and chunk counts matter in a stream list; `sizes` gives each file
    # stream's decrypted size (the bytes themselves don't matter to these checks).
    f = lambda stream, size=70, name="vpn.ovpn": {"t": "file", "name": name, "type": "application/x-openvpn-profile", "size": size, "stream": stream}
    m = lambda *items: {"v": 1, "items": list(items)}
    S = lambda *chunks: [{"stream": i, "prefix": "AAAAAAAAAA", "chunks": c, "size": 16} for i, c in enumerate(chunks)]
    V["cases"]["reveal"] = {
        "note": "Checks on reveal (crypto-v1 §3.4): the server's stream list, and the manifest against the decrypted streams. sizes maps each stream n >= 1 to its decrypted size.",
        "stream_list_must_fail": [
            {"name": "empty list", "streams": []},
            {"name": "doesn't start at 0", "streams": [{**S(1)[0], "stream": 1}]},
            {"name": "a gap", "streams": [S(1)[0], {**S(1)[0], "stream": 2}]},
            {"name": "a stream twice", "streams": S(1, 1) + [S(1, 1)[1]]},
            {"name": "a stream with no chunks", "streams": S(1, 0)},
            {"name": "not a list of streams", "streams": [None]},
            {"name": "no nonce prefix", "streams": [{k: v for k, v in S(1)[0].items() if k != "prefix"}]},
            {"name": "a nonce prefix that isn't 7 bytes", "streams": [{**S(1)[0], "prefix": "AAAA"}]},
            {"name": "a nonce prefix that isn't base64url", "streams": [{**S(1)[0], "prefix": "AAAAAAAA+/"}]},
            {"name": "a size that isn't a whole number", "streams": [{**S(1)[0], "size": "16"}]}],
        "manifest_must_fail": [
            {"name": "a file points to stream 0", "manifest": m(f(0)), "sizes": {}},
            {"name": "a file points to a stream that isn't there", "manifest": m(f(2)), "sizes": {"1": 70}},
            {"name": "two files share a stream", "manifest": m(f(1), f(1, name="b.txt")), "sizes": {"1": 70}},
            {"name": "a stream no item uses", "manifest": m({"t": "note", "v": "hi"}), "sizes": {"1": 70}},
            {"name": "a file emptied", "manifest": m(f(1)), "sizes": {"1": 0}},
            {"name": "a file truncated", "manifest": m(f(1)), "sizes": {"1": 69}},
            {"name": "a stream number that isn't an integer", "manifest": m(f("1")), "sizes": {"1": 70}},
            {"name": "an item that isn't an object", "manifest": m(None), "sizes": {}},
            {"name": "items isn't a list", "manifest": {"v": 1, "items": {}}, "sizes": {}},
            {"name": "not an object", "manifest": None, "sizes": {}}]}

    rid = "Rq7Bn2xK4m"; R = det("R", 16); a = derive_ask(rid, R)
    d_req = ec.derive_private_key(int.from_bytes(det("requester", 32), "big"), ec.SECP256R1())
    e_eph = ec.derive_private_key(int.from_bytes(det("ephemeral", 32), "big"), ec.SECP256R1())
    Q = raw_public(d_req); an = det("ask-nonce", 12); wn = det("answer-nonce", 12)
    ask_pt = json.dumps({"key": b64u(Q)}, separators=(",", ":")).encode()
    nums = d_req.private_numbers()
    V["cases"]["request"] = {"id": rid, "R": R.hex(), "link": f"https://vault.example/a/{rid}#{b64u(R)}",
        "ask_key": a["ask_key"].hex(), "answer_token_b64u": b64u(a["answer_token"]), "answer_hash": a["answer_hash"],
        "ask_nonce": an.hex(), "ask_plaintext": ask_pt.decode(), "ask_ct_b64u": seal_blob(a["ask_key"], "ask", rid, ask_pt, an),
        "requester_jwk": {"kty": "EC", "crv": "P-256", "d": b64u(nums.private_value.to_bytes(32, "big")),
                          "x": b64u(nums.public_numbers.x.to_bytes(32, "big")), "y": b64u(nums.public_numbers.y.to_bytes(32, "big"))},
        "answer_id": sid, "answer_K": K.hex(), "answer_nonce": wn.hex(),
        "answer_ct_b64u": wrap_answer(rid, sid, K, Q, e_eph, wn)}

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
    plain = {st["stream"]: stream_decrypt(d["content_key"], sid, st["stream"], bytes.fromhex(st["prefix"]), [bytes.fromhex(x) for x in st["chunks"]])
             for st in c["stream"]["streams"]}
    check_streams([{"stream": st["stream"], "prefix": b64u(bytes.fromhex(st["prefix"])), "chunks": len(st["chunks"]), "size": 0}
                   for st in c["stream"]["streams"]])
    check_files(json.loads(plain[0]), plain)
    for f in c["stream"]["must_fail"]:
        try:
            stream_decrypt(d["content_key"], sid, f["stream"], bytes.fromhex(f["prefix"]), [bytes.fromhex(x) for x in f["chunks"]])
            raise AssertionError("must fail: " + f["name"])
        except (InvalidTag, ValueError):
            pass
    for f in c["reveal"]["stream_list_must_fail"]:
        try:
            check_streams(f["streams"])
            raise AssertionError("must fail: " + f["name"])
        except ValueError:
            pass
    for f in c["reveal"]["manifest_must_fail"]:
        try:
            check_files(f["manifest"], {0: b"", **{int(n): bytes(size) for n, size in f["sizes"].items()}})
            raise AssertionError("must fail: " + f["name"])
        except ValueError:
            pass
    q = c["request"]; a = derive_ask(q["id"], bytes.fromhex(q["R"]))
    assert a["ask_key"].hex() == q["ask_key"] and a["answer_hash"] == q["answer_hash"]
    assert open_blob(a["ask_key"], "ask", q["id"], q["ask_ct_b64u"]).decode() == q["ask_plaintext"]
    d_req = ec.derive_private_key(int.from_bytes(unb64u(q["requester_jwk"]["d"]), "big"), ec.SECP256R1())
    assert unwrap_answer(q["id"], q["answer_id"], d_req, q["answer_ct_b64u"]).hex() == q["answer_K"]
    pp = c["passphrase"]
    got = derive_passphrase(sid, K, pp["passphrase"], bytes.fromhex(pp["salt"]))
    assert got["passcheck_hash"] == pp["passcheck_hash"] and got["content_key"].hex() == pp["content_key"]
    return True

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs", "vectors.json")
    V = build()
    with open(out, "w") as f: json.dump(V, f, indent=2)
    with open(out) as f: assert verify(json.load(f))
    print("vectors.json written and verified:", ", ".join(V["cases"]))
