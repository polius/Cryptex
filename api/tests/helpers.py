"""A test client that behaves like the browser: it encrypts with reference.py
(docs/crypto.md) and talks to the API exactly as web/src does."""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any

import reference as ref
from fastapi.testclient import TestClient

CHUNK = ref.MAX_CHUNK


def pow_header(client: TestClient) -> dict[str, str]:
    r = client.get("/api/v1/demo/challenge")
    if r.status_code != 200:
        return {}
    c = r.json()
    n = 0
    while True:
        h = f"{c['challenge']}:{n}"
        d = hashlib.sha256(h.encode()).digest()
        bits = 0
        for byte in d:
            if byte == 0:
                bits += 8
                continue
            bits += 8 - byte.bit_length()
            break
        if bits >= c["bits"]:
            return {"X-PoW": h}
        n += 1


@dataclass
class Sent:
    id: str
    K: bytes
    upload_token: str
    manage_token: str
    reveal_token: str
    passphrase: str | None = None
    salt: bytes | None = None
    files: list[bytes] = field(default_factory=list)
    manifest: dict[str, Any] = field(default_factory=dict)

    @property
    def fragment(self) -> str:
        return ref.b64u(self.K)

    def reveal_headers(self) -> dict[str, str]:
        return {"Authorization": f"Reveal {self.reveal_token}"}

    def manage_headers(self) -> dict[str, str]:
        return {"Authorization": f"Manage {self.manage_token}"}


def send(client: TestClient, items: list[dict[str, Any]] | None = None, files: list[tuple[str, bytes]] | None = None, *,
         title: str | None = "Staging database", sender: str | None = None, views: int | None = 1, expires_in: int = 3600,
         passphrase: str | None = None,
         headers: dict[str, str] | None = None, seal: bool = True, upload: bool = True) -> Sent:
    """Create → encrypt with the assigned ID → upload chunks → seal, like the browser."""
    items = items if items is not None else [{"t": "field", "k": "Password", "v": "k7#Qp2-vR9mL", "secret": True}]
    files = files or []
    manifest = {"v": 1, "items": items + [{"t": "file", "name": n, "type": "application/octet-stream", "size": len(b), "stream": i + 1}
                                          for i, (n, b) in enumerate(files)]}
    blobs = [json.dumps(manifest).encode()] + [b for _, b in files]
    salt = os.urandom(16) if passphrase else None
    policy: dict[str, Any] = {"views": views, "expires_in": expires_in, "passphrase": bool(passphrase)}
    if salt:
        policy["passphrase_salt"] = ref.b64u(salt)
    prefixes = [os.urandom(7) for _ in blobs]
    descs = []
    for idx, pt in enumerate(blobs):
        n = max(1, -(-len(pt) // CHUNK))
        descs.append({"stream": idx, "prefix": ref.b64u(prefixes[idx]), "chunks": n, "size": len(pt) + 16 * n})
    h = {**(headers or {})}
    r = client.post("/api/v1/secrets", json={"policy": policy, "streams": descs}, headers=h)
    assert r.status_code == 201, r.text
    created = r.json()
    sid, K = created["id"], os.urandom(16)
    d = ref.derive_link(sid, K)
    content_key, passcheck_hash = d["content_key"], None
    if passphrase:
        pp = ref.derive_passphrase(sid, K, passphrase, salt)
        content_key, passcheck_hash = pp["content_key"], pp["passcheck_hash"]
    up = {"Authorization": f"Upload {created['upload_token']}"}
    if upload:
        for idx, pt in enumerate(blobs):
            for n, chunk in enumerate(ref.stream_encrypt(content_key, sid, idx, prefixes[idx], pt)):
                rr = client.put(f"/api/v1/secrets/{sid}/chunks/{idx}/{n}", content=chunk, headers=up)
                assert rr.status_code == 204, rr.text
    meta_ct = ref.seal_blob(d["meta_key"], "meta", sid, json.dumps({"title": title, "from": sender}).encode(), os.urandom(12))
    if seal:
        body = {"meta_ct": meta_ct, "reveal_hash": d["reveal_hash"]}
        if passcheck_hash:
            body["passcheck_hash"] = passcheck_hash
        rr = client.post(f"/api/v1/secrets/{sid}/seal", json=body, headers=up)
        assert rr.status_code == 200 and set(rr.json()) == {"expires_at"}, rr.text
    return Sent(sid, K, created["upload_token"], created["manage_token"], ref.b64u(d["reveal_token"]), passphrase, salt,
                [b for _, b in files], manifest)


def passcheck(s: Sent, passphrase: str) -> str:
    assert s.salt is not None
    return ref.b64u(ref.derive_passphrase(s.id, s.K, passphrase, s.salt)["passcheck_token"])


def reveal(client: TestClient, s: Sent, *, passphrase: str | None = None,
           headers: dict[str, str] | None = None, done: bool = True) -> tuple[dict[str, Any], list[bytes]]:
    h = {**s.reveal_headers(), **(headers or {})}
    if passphrase is not None:
        h["X-Passcheck"] = passcheck(s, passphrase)
    r = client.post(f"/api/v1/secrets/{s.id}/reveal", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    key = ref.derive_passphrase(s.id, s.K, passphrase, s.salt)["content_key"] if passphrase else ref.derive_link(s.id, s.K)["content_key"]
    rh = {"Authorization": f"Read {body['read_session']}"}
    plain = []
    for st in body["streams"]:
        chunks = []
        for n in range(st["chunks"]):
            cr = client.get(f"/api/v1/secrets/{s.id}/chunks/{st['stream']}/{n}", headers=rh)
            assert cr.status_code == 200, cr.text
            chunks.append(cr.content)
        plain.append(ref.stream_decrypt(key, s.id, st["stream"], ref.unb64u(st["prefix"]), chunks))
    if done:
        assert client.delete(f"/api/v1/secrets/{s.id}/read", headers=rh).status_code == 204
    return json.loads(plain[0]), plain[1:]


def open_meta(client: TestClient, s: Sent) -> dict[str, Any]:
    r = client.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers())
    assert r.status_code == 200, r.text
    m = r.json()
    m["plain"] = json.loads(ref.open_blob(ref.derive_link(s.id, s.K)["meta_key"], "meta", s.id, m["meta_ct"]))
    return m
