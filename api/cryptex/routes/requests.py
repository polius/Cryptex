"""Requests: ask someone for a secret. The answer is encrypted to the requester's
P-256 public key (crypto-v1.md §4), so the server can't read it."""
from __future__ import annotations

import sqlite3
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_der_public_key
from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import Field

from .. import db, demo, items, mailer, ratelimit, state
from ..deps import Caller, caller, cap_hash, deny, matches
from ..errors import ApiError, NotFound, gone, invalid
from ..events import emit
from ..util import b64u, is_id, iso, new_token, now, unb64u
from .common import B64U, HEX64, Body, check_create_allowed, read_body
from .secrets import _unique_id, manage_allowed, manifest_cap

router = APIRouter()
PROMPT_MAX = 8 * 1024


def _p256(spki_b64u: str, field: str) -> bytes:
    try:
        der = unb64u(spki_b64u)
        key = load_der_public_key(der)
    except ValueError:
        raise invalid(field, "Not a P-256 public key.") from None
    if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
        raise invalid(field, "Not a P-256 public key.")
    return der


class CreateRequest(Body):
    public_key: str
    expires_in: int = Field(ge=300)
    keep_answer_s: int = Field(ge=300)
    files: bool = False
    notify: bool = False


@router.post("/requests", status_code=201)
def create_request(body: CreateRequest, request: Request) -> dict[str, Any]:
    c = caller(request)
    check_create_allowed(c, "request")
    if body.expires_in > state.setting("request_max_expiration"):
        raise ApiError("limit_exceeded", field="expires_in", limit=state.setting("request_max_expiration"))
    if body.keep_answer_s > state.setting("request_max_keep"):
        raise ApiError("limit_exceeded", field="keep_answer_s", limit=state.setting("request_max_keep"))
    if body.notify and (not state.env().smtp_enabled or c.user is None):
        raise invalid("notify", "Notifications need email to be set up and a signed-in requester.")
    der = _p256(body.public_key, "public_key")
    if state.env().demo:
        demo.before_create(c, request, PROMPT_MAX, 0)
    manage, manage_h = new_token()
    seal_tok, seal_h = new_token()
    t = now()
    with db.tx() as conn:
        rid = _unique_id(conn, "requests")
        conn.execute(
            "INSERT INTO requests(id, owner_id, created_at, expires_at, keep_answer_s, allow_files, notify, public_key, "
            "manage_hash, seal_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (rid, c.user_id, t, t + body.expires_in, body.keep_answer_s, int(body.files), int(body.notify), der,
             manage_h, seal_h),
        )
        if c.user_id:
            conn.execute("INSERT OR IGNORE INTO user_receipts(user_id, kind, item_id, manage_hash, added_at) VALUES (?,?,?,?,?)",
                         (c.user_id, "request", rid, manage_h, t))
        emit("request.created", request_id=rid, actor=c.actor, user_id=c.user_id, c=conn, detail={
            "expires_in": body.expires_in, "keep_answer_s": body.keep_answer_s, "files": body.files})
    return {"id": rid, "manage_token": manage, "upload_token": seal_tok, "expires_at": iso(t + body.expires_in)}


class SealRequest(Body):
    """Values that depend on the ID, so they arrive after create (crypto-v1.md §4)."""
    prompt_ct: str = Field(max_length=PROMPT_MAX)
    answer_token_hash: str


@router.post("/requests/{rid}/seal", status_code=204)
def seal_request(rid: str, body: SealRequest, request: Request) -> Response:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    h = cap_hash(request, "Upload")
    row = db.one("SELECT * FROM requests WHERE id = ?", rid) if is_id(rid) else None
    if row is None or not matches(row["seal_hash"], h):
        raise deny(c, presented=h is not None)
    if row["sealed"]:
        raise ApiError("already_sealed")
    if not B64U.match(body.prompt_ct) or not HEX64.match(body.answer_token_hash):
        raise invalid("prompt_ct")
    db.run("UPDATE requests SET prompt_ct = ?, answer_token_hash = ?, sealed = 1 WHERE id = ?",
           body.prompt_ct.encode(), body.answer_token_hash, rid)
    return Response(status_code=204)


# ------------------------------------------------------------------ responder
def _answerable(request: Request, rid: str) -> tuple[Caller, sqlite3.Row]:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    ratelimit.hit("reveal", state.env().rate_reveal, c.subject)
    h = cap_hash(request, "Answer")
    if not is_id(rid) or h is None:
        raise deny(c, presented=h is not None)
    row = db.one("SELECT * FROM requests WHERE id = ? AND sealed = 1", rid)
    if row is not None and matches(row["answer_token_hash"], h):
        if row["answered_at"]:
            raise gone("answered", row["answered_at"])
        if row["expires_at"] <= now():
            items.purge_request(rid, "expired", event=("request.expired", {"answered": False}))
            raise gone("expired", row["expires_at"])
        return c, row
    tomb = db.one("SELECT * FROM tombstones WHERE kind = 'request' AND id = ?", rid)
    if tomb is not None and matches(tomb["token_hash"], h):
        raise gone(tomb["reason"], tomb["at"])
    raise deny(c)


def _limits(row: sqlite3.Row) -> dict[str, Any]:
    return {"max_files": int(state.setting("max_files")) if row["allow_files"] else 0,
            "max_file_bytes": int(state.setting("max_file_size")),
            "max_message_chars": int(state.setting("max_message_length"))}


@router.get("/requests/{rid}/prompt")
def prompt(rid: str, request: Request) -> dict[str, Any]:
    _, row = _answerable(request, rid)
    return {"public_key": b64u(row["public_key"]), "prompt_ct": row["prompt_ct"].decode(), "files": bool(row["allow_files"]),
            "expires_at": iso(row["expires_at"]), "limits": _limits(row)}


class StartAnswer(Body):
    ephemeral_key: str
    streams: list[dict[str, Any]]


@router.post("/requests/{rid}/answer", status_code=201)
def start_answer(rid: str, body: StartAnswer, request: Request) -> dict[str, Any]:
    c, row = _answerable(request, rid)
    eph = _p256(body.ephemeral_key, "ephemeral_key")
    lim = _limits(row)
    streams = items.check_streams(body.streams, max_files=lim["max_files"], max_file_size=lim["max_file_bytes"],
                                  manifest_cap=manifest_cap())
    total = sum(s["size"] for s in streams)
    key = f"user:{c.user_id}" if c.user_id else c.subject
    ratelimit.hit("create", state.env().rate_create, key)
    if state.env().demo:
        demo.before_create(c, request, total, len(streams) - 1)
    upload, upload_h = new_token()
    with db.tx() as conn:
        cur = conn.execute("SELECT answered_at FROM requests WHERE id = ?", (rid,)).fetchone()
        if cur is None or cur["answered_at"]:
            raise ApiError("already_answered")
        old = items.purge_answer(conn, rid)  # a responder retrying replaces their unfinished upload
        conn.execute("UPDATE requests SET answer_upload_hash = ?, answer_started_at = ?, ephemeral_key = ?, answer_size = ? WHERE id = ?",
                     (upload_h, now(), eph, total, rid))
        items.insert_streams(conn, "request_id", rid, streams)
    items.delete_blobs(old)
    return {"upload_token": upload}


def _answer_upload(request: Request, rid: str) -> sqlite3.Row:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    h = cap_hash(request, "Upload")
    row = db.one("SELECT * FROM requests WHERE id = ?", rid) if is_id(rid) else None
    if row is None or not matches(row["answer_upload_hash"], h):
        raise deny(c, presented=h is not None)
    if row["answered_at"]:
        raise ApiError("already_answered")
    if (row["answer_started_at"] or 0) < now() - items.UPLOAD_IDLE:
        raise NotFound()
    return row


@router.put("/requests/{rid}/answer/chunks/{stream}/{n}", status_code=204)
async def put_answer_chunk(rid: str, stream: int, n: int, request: Request) -> Response:
    await run_in_threadpool(_answer_upload, request, rid)
    data = await read_body(request, items.CHUNK + items.TAG)
    await run_in_threadpool(items.store_chunk, "answer", "request_id", rid, stream, n, data)
    await run_in_threadpool(db.run, "UPDATE requests SET answer_started_at = ? WHERE id = ?", now(), rid)
    return Response(status_code=204)


@router.post("/requests/{rid}/answer/seal", status_code=204)
def seal_answer(rid: str, request: Request) -> Response:
    row = _answer_upload(request, rid)
    if not items.all_received("request_id", rid):
        raise invalid("chunks", "Some chunks haven’t arrived yet.")
    t = now()
    with db.tx() as conn:
        conn.execute("UPDATE requests SET answered_at = ? WHERE id = ?", (t, rid))
        emit("request.answered", request_id=rid, detail={"size": row["answer_size"]}, c=conn)
    if row["notify"] and row["owner_id"]:
        to = db.val("SELECT email FROM users WHERE id = ?", row["owner_id"])
        if to:
            mailer.answered(to, rid, t, t + row["keep_answer_s"])
    return Response(status_code=204)


# ------------------------------------------------------------------ requester
def _managed(request: Request, rid: str) -> tuple[Caller, sqlite3.Row]:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    row = db.one("SELECT * FROM requests WHERE id = ?", rid) if is_id(rid) else None
    if row is not None and manage_allowed(request, "request", rid, row["manage_hash"]):
        return c, row
    tomb = db.one("SELECT * FROM tombstones WHERE kind = 'request' AND id = ?", rid) if is_id(rid) else None
    if tomb is not None and manage_allowed(request, "request", rid, tomb["manage_hash"]):
        raise gone(tomb["reason"], tomb["at"])
    raise deny(c, presented=cap_hash(request, "Manage") is not None)


@router.get("/requests/{rid}/answer")
def get_answer(rid: str, request: Request) -> dict[str, Any]:
    _, row = _managed(request, rid)
    if not row["answered_at"]:
        return {"answered_at": None, "expires_at": iso(row["expires_at"])}
    return {"ephemeral_key": b64u(row["ephemeral_key"]), "streams": items.stream_list("request_id", rid),
            "answered_at": iso(row["answered_at"]), "kept_until": iso(row["answered_at"] + row["keep_answer_s"])}


def _answer_chunk(rid: str, stream: int, n: int, request: Request) -> bytes:
    c, row = _managed(request, rid)
    if not row["answered_at"]:
        raise NotFound()
    data = items.read_chunk("answer", rid, stream, n)
    if data is None:
        raise NotFound()
    db.run("UPDATE chunks SET served = 1 WHERE owner_kind = 'answer' AND owner_id = ? AND stream = ? AND n = ?", rid, stream, n)
    if not row["answer_read_at"] and not db.val("SELECT 1 FROM chunks WHERE owner_kind='answer' AND owner_id=? AND served=0 LIMIT 1", rid):
        with db.tx() as conn:
            conn.execute("UPDATE requests SET answer_read_at = ? WHERE id = ?", (now(), rid))
            emit("request.answer_read", request_id=rid, actor=c.actor if c.user else "link", user_id=c.user_id, c=conn)
    return data


@router.get("/requests/{rid}/answer/chunks/{stream}/{n}")
async def get_answer_chunk(rid: str, stream: int, n: int, request: Request) -> Response:
    data = await run_in_threadpool(_answer_chunk, rid, stream, n, request)
    return Response(data, media_type="application/octet-stream", headers={"Content-Disposition": "attachment", "Cache-Control": "no-store"})


@router.delete("/requests/{rid}", status_code=204)
def cancel(rid: str, request: Request) -> Response:
    try:
        c, row = _managed(request, rid)
    except ApiError as e:
        if e.code == "gone":
            return Response(status_code=204)  # already gone: idempotent
        raise
    if row["answer_read_at"]:
        items.purge_request(rid, "answered")  # read, then deleted: the receipt stays "revealed"
    elif row["answered_at"]:
        items.purge_request(rid, "destroyed", event=("request.cancelled", {"answered": True}), actor=c.actor if c.user else "link",
                            user_id=c.user_id)
    else:
        items.purge_request(rid, "cancelled", event=("request.cancelled", {}), actor=c.actor if c.user else "link", user_id=c.user_id)
    return Response(status_code=204)
