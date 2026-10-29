"""Send flow (create → chunks → seal) and recipient flow (meta → reveal → chunks)."""
from __future__ import annotations

import sqlite3
from typing import Annotated, Any, Literal, NoReturn

from fastapi import APIRouter, Path, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import ConfigDict, Field
from starlette.background import BackgroundTask

from .. import db, demo, items, ratelimit, state
from ..deps import Caller, caller, cap_hash, deny, matches, signed_in_here
from ..errors import ApiError, NotFound, gone, invalid
from ..events import emit
from ..util import b64u, is_id, iso, new_id, new_token, now, token_hash, unb64u
from .common import B64U, HEX64, Body, check_create_allowed, read_body

router = APIRouter()
MAX_TRIES = 5
StreamNo = Annotated[int, Path(ge=0, le=1000)]       # streams are 0..MAX_FILES (20 at most)
ChunkNo = Annotated[int, Path(ge=0, lt=2**32)]       # the most chunks a stream can declare (items.check_streams)


class Policy(Body):
    model_config = ConfigDict(extra="forbid")  # an old client asking for account-only gets an error, not a weaker link
    views: Literal[1] | None = 1  # 1: destroyed after it's opened; None: opens any number of times until it expires
    expires_in: int = Field(ge=300)
    passphrase: bool = False
    passphrase_salt: str | None = None


class CreateSecret(Body):
    policy: Policy
    streams: list[dict[str, Any]]


class SealSecret(Body):
    """Values that depend on the ID, so they arrive after create (docs/crypto.md §3.1)."""
    meta_ct: str = Field(max_length=2048)
    reveal_hash: str
    passcheck_hash: str | None = None
    answer_ct: str | None = Field(None, max_length=512)  # an answer to a request: its link key for the requester (§4)


def manifest_cap() -> int:
    # Up to 4 UTF-8 bytes a character, plus room for each file's entry (name, type, size).
    return int(state.setting("max_message_length")) * 4 + int(state.setting("max_files")) * 1024 + 64 * 1024


@router.post("/secrets", status_code=201)
def create_secret(body: CreateSecret, request: Request) -> dict[str, Any]:
    c = caller(request)
    check_create_allowed(c)
    p = body.policy
    e = state.env()
    if p.expires_in > state.setting("max_expiration"):
        raise ApiError("limit_exceeded", field="policy.expires_in", limit=state.setting("max_expiration"))
    salt = None
    if p.passphrase:
        try:
            salt = unb64u(p.passphrase_salt or "")
        except ValueError:
            salt = b""
        if len(salt) != 16:
            raise invalid("policy.passphrase_salt", "A passphrase needs a 16-byte salt.")
    streams = items.check_streams(body.streams, max_files=int(state.setting("max_files")),
                                  max_file_size=int(state.setting("max_file_size")), manifest_cap=manifest_cap())
    total = sum(s["size"] for s in streams)
    if e.demo:
        demo.before_create(c, request, total, len(streams) - 1)
    items.check_disk(total)

    upload, upload_h = new_token()
    manage, manage_h = new_token()
    t = now()
    with db.tx() as conn:
        sid = unique_id(conn)
        conn.execute(
            "INSERT INTO secrets(id, owner_id, created_at, expires_at, max_views, passphrase_salt, "
            "manage_hash, upload_hash, upload_active_at, size_bytes) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (sid, c.user_id, t, t + p.expires_in, p.views, salt,
             manage_h, upload_h, t, total),
        )
        items.insert_streams(conn, sid, streams)
        if c.user_id:
            conn.execute("INSERT OR IGNORE INTO user_receipts(user_id, secret_id, manage_hash, added_at) VALUES (?,?,?,?)",
                         (c.user_id, sid, manage_h, t))
        emit("secret.created", secret_id=sid, actor=c.actor, user_id=c.user_id, c=conn, detail={
            "views": p.views, "expires_in": p.expires_in, "passphrase": p.passphrase,
            "files": len(streams) - 1})
    # expires_at moves at seal: the chosen lifetime counts from then, so a slow upload doesn't eat into it.
    return {"id": sid, "upload_token": upload, "manage_token": manage, "expires_at": iso(t + p.expires_in)}


def unique_id(conn: sqlite3.Connection) -> str:
    """A new ID for a secret or a request: they share Your links (and the vault), so neither may reuse the other's."""
    while True:
        i = new_id()
        if not any(conn.execute(f"SELECT 1 FROM {t} WHERE id = ?", (i,)).fetchone() for t in ("secrets", "requests", "tombstones")):
            return i


# ------------------------------------------------------------------ upload
def _uploading(request: Request, sid: str) -> sqlite3.Row:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    h = cap_hash(request, "Upload")
    row = db.one("SELECT * FROM secrets WHERE id = ?", sid) if is_id(sid) else None
    if row is None or not matches(row["upload_hash"], h):
        raise deny(c, presented=h is not None)
    if row["sealed"]:
        raise ApiError("already_sealed")
    if row["upload_active_at"] < now() - items.UPLOAD_IDLE:
        raise NotFound()
    return row


@router.put("/secrets/{sid}/chunks/{stream}/{n}", status_code=204)
async def put_chunk(sid: str, stream: StreamNo, n: ChunkNo, request: Request) -> Response:
    await run_in_threadpool(_uploading, request, sid)
    data = await read_body(request, items.CHUNK + items.TAG)
    await run_in_threadpool(items.store_chunk, sid, stream, n, data)
    await run_in_threadpool(db.run, "UPDATE secrets SET upload_active_at = ? WHERE id = ?", now(), sid)
    return Response(status_code=204)


@router.post("/secrets/{sid}/seal")
def seal(sid: str, body: SealSecret, request: Request) -> dict[str, Any]:
    """The chosen lifetime starts now: expires_at becomes seal time + lifetime (create showed create time + it). An
    answer to a request keeps the request's expiry."""
    row = _uploading(request, sid)
    if not B64U.match(body.meta_ct):
        raise invalid("meta_ct")
    if not HEX64.match(body.reveal_hash):
        raise invalid("reveal_hash")
    has_pass = row["passphrase_salt"] is not None
    if has_pass != bool(body.passcheck_hash) or (body.passcheck_hash and not HEX64.match(body.passcheck_hash)):
        raise invalid("passcheck_hash", "passcheck_hash is required exactly when a passphrase is set.")
    rid = row["request_id"]
    if bool(rid) != bool(body.answer_ct) or (body.answer_ct and not B64U.match(body.answer_ct)):
        raise invalid("answer_ct", "answer_ct is required exactly for an answer to a request.")
    items.check_complete(sid)
    t = now()
    try:
        with db.tx() as conn:
            expires = conn.execute("UPDATE secrets SET sealed = 1, upload_active_at = NULL, meta_ct = ?, reveal_hash = ?, passcheck_hash = ?, "
                                   "expires_at = CASE WHEN request_id IS NULL THEN ? + expires_at - created_at ELSE expires_at END "
                                   "WHERE id = ? AND sealed = 0 RETURNING expires_at",
                                   (body.meta_ct.encode(), body.reveal_hash, body.passcheck_hash, t, sid)).fetchone()
            if expires is None:
                raise ApiError("already_sealed")  # or cancelled: a parallel request got there first
            if rid and not conn.execute(
                    "UPDATE requests SET answered_at = ?, answer_id = ?, answer_ct = ? WHERE id = ? AND answered_at IS NULL "
                    "AND closed_at IS NULL AND expires_at > ?", (t, sid, (body.answer_ct or "").encode(), rid, t)).rowcount:
                raise items.request_ended(rid)  # answered meanwhile (one answer per request), closed, or expired
            emit("secret.sealed", secret_id=sid, actor="user" if row["owner_id"] else "link", user_id=row["owner_id"],
                 detail={"size": row["size_bytes"]}, c=conn)
            if rid:
                emit("secret.request_answered", secret_id=rid, detail={"files": items.file_count(sid)}, c=conn)
    except ApiError as e:
        if rid and e.code == "gone":
            items.drop_upload(sid)  # it can never be delivered
        raise
    return {"expires_at": iso(expires[0])}


@router.delete("/secrets/{sid}/upload", status_code=204)
def cancel_upload(sid: str, request: Request) -> Response:
    _uploading(request, sid)
    items.drop_upload(sid)
    return Response(status_code=204)


# ------------------------------------------------------------------ recipient
def _revealable(request: Request, sid: str) -> tuple[Caller, sqlite3.Row]:
    """Reveal token check shared by meta, reveal and report. Changes nothing."""
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    ratelimit.hit("reveal", state.env().rate_reveal, c.subject)
    h = cap_hash(request, "Reveal")
    if not is_id(sid) or h is None:
        raise deny(c, presented=h is not None)
    row = db.one("SELECT * FROM secrets WHERE id = ?", sid)
    if row is not None and matches(row["reveal_hash"], h):
        if not row["sealed"]:
            raise NotFound()
        if row["consumed_at"]:  # its data goes when the last read session ends (cleanup)
            raise gone("opened", row["consumed_at"], True)
        if row["expires_at"] <= now():
            if not items.reading(sid):  # a download that started before expiry finishes; cleanup purges it after
                items.purge_secret(sid, "expired", event=("secret.expired", {"views_used": row["views"]}))
            raise gone("expired", row["expires_at"], row["views"] > 0)
        return c, row
    raise _gone_or_deny(c, sid, h)


def _gone_or_deny(c: Caller, sid: str, h: str) -> ApiError:
    """The secret is gone: 410 with why for whoever holds its link, the uniform 404 for anyone else."""
    tomb = db.one("SELECT * FROM tombstones WHERE id = ?", sid)
    if tomb is not None and matches(tomb["token_hash"], h):
        return gone(tomb["reason"], tomb["at"], bool(tomb["opened"]))
    return deny(c)


@router.get("/secrets/{sid}/meta")
def meta(sid: str, request: Request) -> dict[str, Any]:
    _, row = _revealable(request, sid)
    files = items.file_count(sid)
    # Who sent it, as this server knows them (the account's current username), and only to someone signed in here:
    # a username is half of a sign-in, and a link can travel further than meant. Null otherwise, and for anonymous
    # senders (or accounts removed since). The page then names only the organization.
    sender = db.val("SELECT username FROM users WHERE id = ?", row["owner_id"]) if row["owner_id"] and signed_in_here(request) else None
    out: dict[str, Any] = {
        "meta_ct": row["meta_ct"].decode(), "views_left": views_left(row["max_views"], row["views"]),
        "max_views": row["max_views"], "expires_at": iso(row["expires_at"]),
        "passphrase": row["passcheck_hash"] is not None, "size": row["size_bytes"], "files": files, "sender": sender,
    }
    if row["passcheck_hash"]:
        out["passphrase_salt"] = b64u(row["passphrase_salt"])
        out["tries_left"] = MAX_TRIES - row["failed_tries"]
    return out


@router.post("/secrets/{sid}/reveal")
def reveal(sid: str, request: Request) -> dict[str, Any]:
    _, row = _revealable(request, sid)
    if row["passcheck_hash"]:
        pc = request.headers.get("x-passcheck")
        pc_h = token_hash(pc) if pc else None
        if pc_h is None:
            raise invalid("X-Passcheck", "This secret needs its passphrase.")
        if not matches(row["passcheck_hash"], pc_h):
            _wrong_passphrase(request, sid)

    read, read_h = new_token()
    t = now()
    with db.tx() as conn:
        cur = conn.execute("SELECT views, max_views, consumed_at FROM secrets WHERE id = ?", (sid,)).fetchone()
        if cur is None or cur["consumed_at"]:  # lost a race for the last view (or a destroy)
            raise gone("opened", t, True) if cur is not None else _gone_or_deny(caller(request), sid, row["reveal_hash"])
        views = cur["views"] + 1
        last = cur["max_views"] is not None and views >= cur["max_views"]
        conn.execute("UPDATE secrets SET views = ?, consumed_at = ? WHERE id = ?", (views, t if last else None, sid))
        conn.execute("INSERT INTO read_sessions(token_hash, secret_id, revealed_at, expires_at, last_view) VALUES (?,?,?,?,?)",
                     (read_h, sid, t, t + items.READ_SESSION, int(last)))
        left = views_left(cur["max_views"], views)
        emit("secret.revealed", secret_id=sid, c=conn, detail={"views_left": left})
    return {"read_session": read, "streams": items.stream_list(sid), "views_left": left}


def views_left(max_views: int | None, views: int) -> int | None:
    """None for a link that opens any number of times until it expires."""
    return None if max_views is None else max_views - views


def _wrong_passphrase(request: Request, sid: str) -> NoReturn:
    with db.tx() as conn:
        r = conn.execute("UPDATE secrets SET failed_tries = failed_tries + 1 WHERE id = ? RETURNING failed_tries, views",
                         (sid,)).fetchone()
        if r is None:  # purged by a parallel request (the fifth wrong try, a destroy, expiry)
            raise _gone_or_deny(caller(request), sid, cap_hash(request, "Reveal") or "")
        left = MAX_TRIES - r["failed_tries"]
        emit("secret.passphrase_failed", secret_id=sid, detail={"tries_left": max(0, left)}, c=conn)
    if left <= 0:
        items.purge_secret(sid, "too_many_tries", event=("secret.destroyed", {"reason": "too_many_tries"}), actor="link")
        raise gone("too_many_tries", now(), r["views"] > 0)
    raise ApiError("wrong_passphrase", tries_left=left)


def _read_session(request: Request, sid: str) -> sqlite3.Row:
    c = caller(request)
    h = cap_hash(request, "Read")
    s = db.one("SELECT * FROM read_sessions WHERE token_hash = ?", h) if h else None
    if s is None or s["secret_id"] != sid or s["expires_at"] < now():
        raise deny(c, presented=h is not None)
    return s


def _get_chunk(sid: str, stream: int, n: int, request: Request) -> tuple[bytes, str]:
    s = _read_session(request, sid)
    data = items.read_chunk(sid, stream, n)
    if data is None:
        raise NotFound()
    db.run("UPDATE chunks SET served = 1 WHERE secret_id = ? AND stream = ? AND n = ?", sid, stream, n)
    _keep_open(s["token_hash"], sent=False)
    return data, s["token_hash"]


def _keep_open(token_hash: str, *, sent: bool) -> None:
    """The read session stays open while chunks keep coming (a slow phone, a resumed download), so a large one-time
    file isn't lost halfway: each chunk request, and the end of each chunk's response (`sent`), moves its end to at
    least READ_SLIDE from now; READ_MAX after the reveal it ends anyway. On the last view, once the response that
    completed the set of chunks served is done, READ_GRACE is left to start a retry after a dropped connection; the
    client confirms with DELETE /secrets/{id}/read once it decrypted everything, which deletes the data at once."""
    t = now()
    s = db.one("SELECT * FROM read_sessions WHERE token_hash = ?", token_hash)
    if s is None:
        return  # confirmed (DELETE /read) or ended meanwhile
    if sent and s["last_view"] and not db.val("SELECT 1 FROM chunks WHERE secret_id = ? AND served = 0 LIMIT 1", s["secret_id"]):
        db.run("UPDATE read_sessions SET expires_at = min(?, revealed_at + ?) WHERE token_hash = ?",
               t + items.READ_GRACE, items.READ_MAX, token_hash)
    else:
        db.run("UPDATE read_sessions SET expires_at = min(max(expires_at, ?), revealed_at + ?) WHERE token_hash = ?",
               t + items.READ_SLIDE, items.READ_MAX, token_hash)


@router.delete("/secrets/{sid}/read", status_code=204)
def read_done(sid: str, request: Request) -> Response:
    """The recipient decrypted everything: end the read session; on the last view, delete the data now."""
    s = _read_session(request, sid)
    db.run("DELETE FROM read_sessions WHERE token_hash = ?", s["token_hash"])
    if s["last_view"]:
        items.purge_secret(sid, "opened")
    return Response(status_code=204)


@router.get("/secrets/{sid}/chunks/{stream}/{n}")
async def get_chunk(sid: str, stream: StreamNo, n: ChunkNo, request: Request) -> Response:
    data, session = await run_in_threadpool(_get_chunk, sid, stream, n, request)
    # When the response is done (sent, or the connection dropped part-way), the session's clock starts again.
    return Response(data, media_type="application/octet-stream",
                    headers={"Content-Disposition": "attachment", "Cache-Control": "no-store"},
                    background=BackgroundTask(run_in_threadpool, _keep_open, session, sent=True))


# ------------------------------------------------------------------ sender
def manage_allowed(request: Request, sid: str, manage_hash: str | None) -> bool:
    """Manage token, or a signed-in user who attached this receipt to their account."""
    h = cap_hash(request, "Manage")
    if h is not None:
        return matches(manage_hash, h)
    c = caller(request)
    if c.user_id:
        r = db.one("SELECT manage_hash FROM user_receipts WHERE user_id = ? AND secret_id = ?", c.user_id, sid)
        return r is not None and matches(manage_hash, r["manage_hash"])
    return False


@router.delete("/secrets/{sid}", status_code=204)
def destroy(sid: str, request: Request) -> Response:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    row = db.one("SELECT * FROM secrets WHERE id = ?", sid) if is_id(sid) else None
    if row is not None and manage_allowed(request, sid, row["manage_hash"]):
        items.purge_secret(sid, "destroyed", event=("secret.destroyed", {"reason": "sender"}), actor=c.actor if c.user else "link",
                           user_id=c.user_id)
        return Response(status_code=204)
    tomb = db.one("SELECT manage_hash FROM tombstones WHERE id = ?", sid) if is_id(sid) else None
    if tomb is not None and manage_allowed(request, sid, tomb["manage_hash"]):
        return Response(status_code=204)  # already gone: destroying is idempotent
    # A wrong token counts toward the failed-token block only for an item that exists: Your links can hold items
    # whose tombstones are long gone.
    raise deny(c, presented=cap_hash(request, "Manage") is not None and (row is not None or tomb is not None))


# ------------------------------------------------------------------ demo reports
@router.post("/secrets/{sid}/report", status_code=204)
def report(sid: str, request: Request) -> Response:
    """Demo only: anyone holding the link can take it down. 204 once it's down; a link already gone gets its 410."""
    if not state.env().demo:
        raise NotFound()
    c, row = _revealable(request, sid)
    if not items.purge_secret(sid, "reported", event=("secret.destroyed", {"reason": "reported"}), actor="link"):
        raise _gone_or_deny(c, sid, row["reveal_hash"])  # a parallel request removed it first
    return Response(status_code=204)

