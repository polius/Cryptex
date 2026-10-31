"""Secret storage: stream descriptors, chunks, purging.

A secret is a set of STREAM-encrypted streams (docs/crypto.md §3.4).
The server checks declared sizes so storage accounting can't be lied about, and
stores each chunk under a random name.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from . import db, state, storage
from .errors import ApiError, NotFound, gone, invalid
from .events import emit
from .util import b64u, now, unb64u

CHUNK = 5 * 1024 * 1024
TAG = 16
UPLOAD_IDLE = 30 * 60
READ_SESSION = 10 * 60     # a read session at first: time to fetch the first chunk
READ_SLIDE = 15 * 60       # then each chunk request, and each chunk sent in full, keeps it open at least this much
                           # longer (a slow phone takes minutes per 5 MiB chunk; a retry after a dropped connection)...
READ_MAX = 6 * 3600        # ...but never past this long after the reveal
READ_GRACE = 5 * 60        # on the last view, once every chunk was sent in full: time left to start a retry
TOMBSTONE_DAYS = 30        # link holders get 410 with why; as long as Your links keeps ended items (README.md)


def plaintext_size(size: int, chunks: int) -> int:
    return size - TAG * chunks


_BIG = 2**53  # no stream number, chunk count or size comes near this (sizes are capped far lower)


def _whole(v: Any) -> int:
    """A JSON whole number below 2**53: 1.5, 1e400, "3", true or a 400-digit number are refused, never rounded."""
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < _BIG:
        raise ValueError("not a whole number in range")
    return v


def check_streams(streams: Any, *, max_files: int, max_file_size: int, manifest_cap: int) -> list[dict[str, Any]]:
    if not isinstance(streams, list) or not streams:
        raise invalid("streams", "At least the manifest stream is needed.")
    out = []
    for i, s in enumerate(streams):
        if not isinstance(s, dict):
            raise invalid(f"streams[{i}]")
        try:
            idx, chunks, size = (_whole(s[k]) for k in ("stream", "chunks", "size"))
            prefix = unb64u(str(s["prefix"]))
        except (KeyError, TypeError, ValueError):
            raise invalid(f"streams[{i}]", "Each stream needs stream, prefix, chunks and size, as whole numbers.") from None
        if idx != i:
            raise invalid(f"streams[{i}].stream", "Streams must be numbered 0, 1, 2… in order.")
        if len(prefix) != 7:
            raise invalid(f"streams[{i}].prefix", "The nonce prefix must be 7 bytes.")
        if chunks < 1 or chunks > 2**32 - 1 or size < TAG * chunks:
            raise invalid(f"streams[{i}].size")
        pt = plaintext_size(size, chunks)
        if chunks != max(1, -(-pt // CHUNK)):  # integer ceiling: exact for any size
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


def insert_streams(c: sqlite3.Connection, secret_id: str, streams: list[dict[str, Any]]) -> None:
    for s in streams:
        c.execute("INSERT INTO streams(secret_id, stream, prefix, chunks, size_bytes) VALUES (?,?,?,?,?)",
                  (secret_id, s["stream"], s["prefix"], s["chunks"], s["size"]))


def stream_list(secret_id: str) -> list[dict[str, Any]]:
    rows = db.all("SELECT stream, prefix, chunks, size_bytes FROM streams WHERE secret_id = ? ORDER BY stream", secret_id)
    return [{"stream": r["stream"], "prefix": b64u(r["prefix"]), "chunks": r["chunks"], "size": r["size_bytes"]} for r in rows]


def store_chunk(secret_id: str, stream: int, n: int, data: bytes) -> None:
    """Idempotent: re-sending a chunk replaces it. The blob is written first and its row claimed in one transaction
    with the checks, so a lost race, a cancelled upload or a seal in between never leaves a blob without a row."""
    st = db.one("SELECT * FROM streams WHERE secret_id = ? AND stream = ?", secret_id, stream)
    if st is None or not (0 <= n < st["chunks"]):
        raise invalid("n", "No such chunk in this upload.")
    if len(data) != expected_chunk_size(st, n):
        raise ApiError("too_large" if len(data) > CHUNK + TAG else "invalid",
                       "Chunk size doesn’t match the declared stream.", field="body", limit=expected_chunk_size(st, n))
    blobs = storage.get()
    key = blobs.put(data)
    old = None
    try:
        with db.tx() as c:
            sealed = c.execute("SELECT sealed FROM secrets WHERE id = ?", (secret_id,)).fetchone()
            if sealed is None:
                raise NotFound()  # cancelled or cleaned up meanwhile
            if sealed[0]:
                raise ApiError("already_sealed")
            row = c.execute("SELECT blob_key FROM chunks WHERE secret_id = ? AND stream = ? AND n = ?", (secret_id, stream, n)).fetchone()
            if row is not None:
                old = row[0]
                c.execute("UPDATE chunks SET blob_key = ?, size_bytes = ? WHERE secret_id = ? AND stream = ? AND n = ?",
                          (key, len(data), secret_id, stream, n))
            else:
                c.execute("INSERT INTO chunks(secret_id, stream, n, size_bytes, blob_key) VALUES (?,?,?,?,?)",
                          (secret_id, stream, n, len(data), key))
                c.execute("UPDATE streams SET received = received + 1 WHERE secret_id = ? AND stream = ?", (secret_id, stream))
    except BaseException:
        blobs.delete(key)
        raise
    if old is not None:
        blobs.delete(old)


def check_complete(secret_id: str) -> None:
    """Before seal: streams numbered 0..n-1, each with at least one chunk, and every chunk of every stream stored
    (docs/crypto.md §3.4: a recipient must never get a truncated or partial list)."""
    rows = db.all("SELECT s.stream, s.chunks, (SELECT count(*) FROM chunks c WHERE c.secret_id = s.secret_id AND c.stream = s.stream "
                  "AND c.n < s.chunks) AS stored FROM streams s WHERE s.secret_id = ? ORDER BY s.stream", secret_id)
    if not rows or [r["stream"] for r in rows] != list(range(len(rows))) or any(r["chunks"] < 1 for r in rows):
        raise invalid("streams", "Streams must be numbered 0, 1, 2… and each needs at least one chunk.")
    if any(r["stored"] != r["chunks"] for r in rows):
        raise invalid("chunks", "Some chunks haven’t arrived yet.")


def check_disk(upload_bytes: int) -> None:
    """Refuse a new secret that would leave less than MIN_FREE_DISK free on DATA_DIR, counting what uploads in
    progress still have to send. A full disk takes the database down with it."""
    _, free = storage.get().disk()
    declared = db.val("SELECT coalesce(sum(size_bytes), 0) FROM secrets WHERE sealed = 0")
    stored = db.val("SELECT coalesce(sum(c.size_bytes), 0) FROM chunks c JOIN secrets s ON s.id = c.secret_id WHERE s.sealed = 0")
    room = free - max(0, int(declared) - int(stored)) - state.env().min_free_disk
    if upload_bytes > room:
        raise ApiError("storage_full", limit=max(0, room))


def read_chunk(secret_id: str, stream: int, n: int) -> bytes | None:
    row = db.one("SELECT blob_key FROM chunks WHERE secret_id = ? AND stream = ? AND n = ?", secret_id, stream, n)
    if row is None:
        return None
    try:
        return storage.get().get(row["blob_key"])
    except FileNotFoundError:
        return None


def drop_chunks(c: sqlite3.Connection, secret_id: str) -> list[str]:
    keys = [r[0] for r in c.execute("SELECT blob_key FROM chunks WHERE secret_id = ?", (secret_id,))]
    c.execute("DELETE FROM chunks WHERE secret_id = ?", (secret_id,))
    return keys


def delete_blobs(keys: list[str]) -> None:
    st = storage.get()
    for k in keys:
        st.delete(k)


def reading(secret_id: str) -> bool:
    """Is a read session still open for it (a download in progress)?"""
    return db.val("SELECT 1 FROM read_sessions WHERE secret_id = ? AND expires_at > ? LIMIT 1", secret_id, now()) is not None


def drop_upload(secret_id: str) -> None:
    """An upload that was never sealed (cancelled, or idle too long) never existed for anyone: its chunks, its
    secret.created event and the account's receipt go with it."""
    purge_secret(secret_id, None)
    with db.tx() as c:
        if c.execute("SELECT 1 FROM secrets WHERE id = ?", (secret_id,)).fetchone() is None:
            c.execute("DELETE FROM events WHERE secret_id = ?", (secret_id,))
            c.execute("DELETE FROM user_receipts WHERE secret_id = ?", (secret_id,))


def purge_secret(secret_id: str, reason: str | None, *, event: tuple[str, dict[str, Any]] | None = None,
                 actor: str = "system", user_id: str | None = None) -> bool:
    """Delete a secret's data now. With a reason, leave a tombstone so link holders get 410 (with whether it was
    ever opened)."""
    with db.tx() as c:
        row = c.execute("SELECT reveal_hash, manage_hash, sealed, views FROM secrets WHERE id = ?", (secret_id,)).fetchone()
        if row is None:
            return False
        if not row["sealed"]:
            reason = None  # never visible to anyone: no tombstone
        keys = drop_chunks(c, secret_id)
        c.execute("DELETE FROM secrets WHERE id = ?", (secret_id,))
        if reason:
            t = now()
            c.execute("INSERT OR REPLACE INTO tombstones(id, token_hash, manage_hash, reason, opened, at, purge_after) "
                      "VALUES (?,?,?,?,?,?,?)", (secret_id, row["reveal_hash"], row["manage_hash"], reason, int(row["views"] > 0),
                                                 t, t + TOMBSTONE_DAYS * 86400))
        if event:
            emit(event[0], secret_id=secret_id, actor=actor, user_id=user_id, detail=event[1], c=c)
    delete_blobs(keys)
    return True


def file_count(secret_id: str) -> int:
    return int(db.val("SELECT count(*) FROM streams WHERE secret_id = ? AND stream > 0", secret_id) or 0)


def request_ended(request_id: str) -> ApiError:
    """Why a request can't take an answer: 410 closed, answered or expired (or the uniform 404 once it's gone)."""
    r = db.one("SELECT closed_at, answered_at, expires_at FROM requests WHERE id = ?", request_id)
    if r is None:
        return NotFound()
    if r["closed_at"]:
        return gone("closed", r["closed_at"], False)
    if r["answered_at"]:
        return gone("answered", r["answered_at"], False)
    return gone("expired", r["expires_at"], False)


def stored_bytes() -> int:
    return int(db.val("SELECT coalesce(sum(size_bytes), 0) FROM chunks") or 0)
