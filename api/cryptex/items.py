"""Shared logic for secrets and request answers: stream descriptors, chunks, purging.

A secret (or an answer) is a set of STREAM-encrypted streams (crypto-v1.md §3.4).
The server checks declared sizes so storage accounting can't be lied about, and
stores each chunk under a random name.
"""
from __future__ import annotations

import math
import sqlite3
from typing import Any

from . import db, storage
from .errors import ApiError, invalid
from .events import emit
from .util import b64u, now, unb64u

CHUNK = 5 * 1024 * 1024
TAG = 16
UPLOAD_IDLE = 30 * 60
READ_SESSION = 10 * 60
TOMBSTONE_DAYS = 7


def plaintext_size(size: int, chunks: int) -> int:
    return size - TAG * chunks


def check_streams(streams: Any, *, max_files: int, max_file_size: int, manifest_cap: int) -> list[dict[str, Any]]:
    if not isinstance(streams, list) or not streams:
        raise invalid("streams", "At least the manifest stream is needed.")
    out = []
    for i, s in enumerate(streams):
        if not isinstance(s, dict):
            raise invalid(f"streams[{i}]")
        try:
            idx, chunks, size = int(s["stream"]), int(s["chunks"]), int(s["size"])
            prefix = unb64u(str(s["prefix"]))
        except (KeyError, TypeError, ValueError):
            raise invalid(f"streams[{i}]", "Each stream needs stream, prefix, chunks and size.") from None
        if idx != i:
            raise invalid(f"streams[{i}].stream", "Streams must be numbered 0, 1, 2… in order.")
        if len(prefix) != 7:
            raise invalid(f"streams[{i}].prefix", "The nonce prefix must be 7 bytes.")
        if chunks < 1 or chunks > 2**32 - 1 or size < TAG * chunks:
            raise invalid(f"streams[{i}].size")
        pt = plaintext_size(size, chunks)
        if chunks != max(1, math.ceil(pt / CHUNK)):
            raise invalid(f"streams[{i}].chunks", "Chunk count doesn’t match the size.")
        limit = manifest_cap if idx == 0 else max_file_size
        if pt > limit:
            raise ApiError("limit_exceeded", field=f"streams[{i}].size", limit=limit, status=413 if idx else 400)
        out.append({"stream": idx, "prefix": prefix, "chunks": chunks, "size": size})
    if len(out) - 1 > max_files:
        raise ApiError("limit_exceeded", f"Up to {max_files} files.", field="streams", limit=max_files)
    return out


def expected_chunk_size(stream: sqlite3.Row, n: int) -> int:
    if n < stream["chunks"] - 1:
        return CHUNK + TAG
    return stream["size_bytes"] - (stream["chunks"] - 1) * (CHUNK + TAG)


def insert_streams(c: sqlite3.Connection, owner_col: str, owner_id: str, streams: list[dict[str, Any]]) -> None:
    for s in streams:
        c.execute(
            f"INSERT INTO streams({owner_col}, stream, prefix, chunks, size_bytes) VALUES (?,?,?,?,?)",
            (owner_id, s["stream"], s["prefix"], s["chunks"], s["size"]),
        )


def stream_list(owner_col: str, owner_id: str) -> list[dict[str, Any]]:
    rows = db.all(f"SELECT stream, prefix, chunks, size_bytes FROM streams WHERE {owner_col} = ? ORDER BY stream", owner_id)
    return [{"stream": r["stream"], "prefix": b64u(r["prefix"]), "chunks": r["chunks"], "size": r["size_bytes"]} for r in rows]


def store_chunk(owner_kind: str, owner_col: str, owner_id: str, stream: int, n: int, data: bytes) -> None:
    """Idempotent: re-sending a chunk replaces it."""
    st = db.one(f"SELECT * FROM streams WHERE {owner_col} = ? AND stream = ?", owner_id, stream)
    if st is None or not (0 <= n < st["chunks"]):
        raise invalid("n", "No such chunk in this upload.")
    if len(data) != expected_chunk_size(st, n):
        raise ApiError("too_large" if len(data) > CHUNK + TAG else "invalid",
                       "Chunk size doesn’t match the declared stream.", field="body", limit=expected_chunk_size(st, n))
    existing = db.one("SELECT blob_key FROM chunks WHERE owner_kind=? AND owner_id=? AND stream=? AND n=?",
                      owner_kind, owner_id, stream, n)
    st_ = storage.get()
    if existing is not None:
        st_.replace(existing["blob_key"], data)
        return
    key = st_.put(data)
    with db.tx() as c:
        c.execute("INSERT INTO chunks(owner_kind, owner_id, stream, n, size_bytes, blob_key) VALUES (?,?,?,?,?,?)",
                  (owner_kind, owner_id, stream, n, len(data), key))
        c.execute(f"UPDATE streams SET received = received + 1 WHERE {owner_col} = ? AND stream = ?", (owner_id, stream))


def all_received(owner_col: str, owner_id: str) -> bool:
    missing = db.val(f"SELECT count(*) FROM streams WHERE {owner_col} = ? AND received < chunks", owner_id)
    return missing == 0


def read_chunk(owner_kind: str, owner_id: str, stream: int, n: int) -> bytes | None:
    row = db.one("SELECT blob_key FROM chunks WHERE owner_kind=? AND owner_id=? AND stream=? AND n=?",
                 owner_kind, owner_id, stream, n)
    if row is None:
        return None
    try:
        return storage.get().get(row["blob_key"])
    except FileNotFoundError:
        return None


def drop_chunks(c: sqlite3.Connection, owner_kind: str, owner_id: str) -> list[str]:
    keys = [r[0] for r in c.execute("SELECT blob_key FROM chunks WHERE owner_kind=? AND owner_id=?", (owner_kind, owner_id))]
    c.execute("DELETE FROM chunks WHERE owner_kind=? AND owner_id=?", (owner_kind, owner_id))
    return keys


def delete_blobs(keys: list[str]) -> None:
    st = storage.get()
    for k in keys:
        st.delete(k)


def purge_secret(secret_id: str, reason: str | None, *, event: tuple[str, dict[str, Any]] | None = None,
                 actor: str = "system", user_id: str | None = None) -> bool:
    """Delete a secret's data now. With a reason, leave a tombstone so link holders get 410."""
    with db.tx() as c:
        row = c.execute("SELECT reveal_hash, manage_hash, sealed FROM secrets WHERE id = ?", (secret_id,)).fetchone()
        if row is None:
            return False
        if not row["sealed"]:
            reason = None  # never visible to anyone: no tombstone
        keys = drop_chunks(c, "secret", secret_id)
        c.execute("DELETE FROM secrets WHERE id = ?", (secret_id,))
        if reason:
            t = now()
            c.execute("INSERT OR REPLACE INTO tombstones(kind, id, token_hash, manage_hash, reason, at, purge_after) "
                      "VALUES ('secret',?,?,?,?,?,?)", (secret_id, row["reveal_hash"], row["manage_hash"], reason, t,
                                                        t + TOMBSTONE_DAYS * 86400))
        if event:
            emit(event[0], secret_id=secret_id, actor=actor, user_id=user_id, detail=event[1], c=c)
    delete_blobs(keys)
    return True


def purge_answer(c: sqlite3.Connection, request_id: str) -> list[str]:
    keys = drop_chunks(c, "answer", request_id)
    c.execute("DELETE FROM streams WHERE request_id = ?", (request_id,))
    return keys


def purge_request(request_id: str, reason: str | None, *, event: tuple[str, dict[str, Any]] | None = None,
                  actor: str = "system", user_id: str | None = None) -> bool:
    with db.tx() as c:
        row = c.execute("SELECT answer_token_hash, manage_hash, sealed FROM requests WHERE id = ?", (request_id,)).fetchone()
        if row is None:
            return False
        if not row["sealed"]:
            reason = None
        keys = purge_answer(c, request_id)
        c.execute("DELETE FROM requests WHERE id = ?", (request_id,))
        if reason:
            t = now()
            c.execute("INSERT OR REPLACE INTO tombstones(kind, id, token_hash, manage_hash, reason, at, purge_after) "
                      "VALUES ('request',?,?,?,?,?,?)", (request_id, row["answer_token_hash"], row["manage_hash"], reason, t,
                                                         t + TOMBSTONE_DAYS * 86400))
        if event:
            emit(event[0], request_id=request_id, actor=actor, user_id=user_id, detail=event[1], c=c)
    delete_blobs(keys)
    return True


def stored_bytes() -> int:
    return int(db.val("SELECT coalesce(sum(size_bytes), 0) FROM chunks") or 0)
