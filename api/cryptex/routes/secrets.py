"""Send flow (create → chunks → seal) and recipient flow (meta → verify → reveal → chunks)."""
from __future__ import annotations

import secrets as pysecrets
import sqlite3
from typing import Any, Literal

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import EmailStr, Field

from .. import db, demo, items, mailer, ratelimit, security, state
from ..deps import Caller, caller, cap_hash, deny, matches
from ..errors import ApiError, NotFound, gone, invalid
from ..events import emit
from ..util import b64u, is_id, iso, mask_email, new_id, new_token, now, token_hash, unb64u
from .common import B64U, HEX64, Body, check_create_allowed, read_body

router = APIRouter()
MAX_TRIES = 5
CODE_TTL = 600
GRANT_TTL = 600
_code_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)


class Policy(Body):
    views: int = Field(ge=1)
    expires_in: int = Field(ge=300)
    access: Literal["link", "email", "org"] = "link"
    email: EmailStr | None = None
    passphrase: bool = False
    passphrase_salt: str | None = None
    notify: bool = False


class CreateSecret(Body):
    policy: Policy
    streams: list[dict[str, Any]]


class SealSecret(Body):
    """Values that depend on the ID, so they arrive after create (crypto-v1.md §3.1)."""
    meta_ct: str = Field(max_length=2048)
    reveal_hash: str
    passcheck_hash: str | None = None


def manifest_cap() -> int:
    return int(state.setting("max_message_length")) * 4 + 64 * 1024


@router.post("/secrets", status_code=201)
def create_secret(body: CreateSecret, request: Request) -> dict[str, Any]:
    c = caller(request)
    check_create_allowed(c, "send")
    p = body.policy
    e = state.env()
    if p.views > state.setting("max_views"):
        raise ApiError("limit_exceeded", f"Up to {state.setting('max_views')} opens.", field="policy.views", limit=state.setting("max_views"))
    if p.expires_in > state.setting("max_expiration"):
        raise ApiError("limit_exceeded", field="policy.expires_in", limit=state.setting("max_expiration"))
    email_ct = email_hint = None
    if p.access == "email":
        if not e.smtp_enabled:
            raise invalid("policy.access", "Email-only links need email to be set up on this server.")
        if not p.email:
            raise invalid("policy.email", "Enter the email address that can open it.")
        email_ct, email_hint = security.seal("email", p.email.lower().encode()), mask_email(p.email.lower())
    if p.access == "org" and (not e.oidc_enabled or not e.oidc_allowed_domains or c.user is None):
        raise invalid("policy.access", "Org-only links need single sign-on and a signed-in sender.")
    salt = None
    if p.passphrase:
        try:
            salt = unb64u(p.passphrase_salt or "")
        except ValueError:
            salt = b""
        if len(salt) != 16:
            raise invalid("policy.passphrase_salt", "A passphrase needs a 16-byte salt.")
    if p.notify and (not e.smtp_enabled or c.user is None):
        raise invalid("policy.notify", "Notifications need email to be set up and a signed-in sender.")
    streams = items.check_streams(body.streams, max_files=int(state.setting("max_files")),
                                  max_file_size=int(state.setting("max_file_size")), manifest_cap=manifest_cap())
    total = sum(s["size"] for s in streams)
    if e.demo:
        demo.before_create(c, request, total, len(streams) - 1)

    upload, upload_h = new_token()
    manage, manage_h = new_token()
    t = now()
    with db.tx() as conn:
        sid = _unique_id(conn, "secrets")
        conn.execute(
            "INSERT INTO secrets(id, owner_id, created_at, expires_at, max_views, access, email_ct, email_hint, passphrase_salt, "
            "manage_hash, upload_hash, upload_active_at, notify, size_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, c.user_id, t, t + p.expires_in, p.views, p.access, email_ct, email_hint, salt,
             manage_h, upload_h, t, int(p.notify), total),
        )
        items.insert_streams(conn, "secret_id", sid, streams)
        if c.user_id:
            conn.execute("INSERT OR IGNORE INTO user_receipts(user_id, kind, item_id, manage_hash, added_at) VALUES (?,?,?,?,?)",
                         (c.user_id, "secret", sid, manage_h, t))
        emit("secret.created", secret_id=sid, actor=c.actor, user_id=c.user_id, c=conn, detail={
            "views": p.views, "expires_in": p.expires_in, "access": p.access, "passphrase": p.passphrase,
            "files": len(streams) - 1})
    return {"id": sid, "upload_token": upload, "manage_token": manage, "expires_at": iso(t + p.expires_in)}


def _unique_id(conn: sqlite3.Connection, table: str) -> str:
    while True:
        i = new_id()
        if not conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (i,)).fetchone() and \
                not conn.execute("SELECT 1 FROM tombstones WHERE id = ?", (i,)).fetchone():
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
async def put_chunk(sid: str, stream: int, n: int, request: Request) -> Response:
    await run_in_threadpool(_uploading, request, sid)
    data = await read_body(request, items.CHUNK + items.TAG)
    await run_in_threadpool(items.store_chunk, "secret", "secret_id", sid, stream, n, data)
    await run_in_threadpool(db.run, "UPDATE secrets SET upload_active_at = ? WHERE id = ?", now(), sid)
    return Response(status_code=204)


@router.post("/secrets/{sid}/seal", status_code=204)
def seal(sid: str, body: SealSecret, request: Request) -> Response:
    row = _uploading(request, sid)
    if not B64U.match(body.meta_ct) or not HEX64.match(body.reveal_hash):
        raise invalid("meta_ct")
    has_pass = row["passphrase_salt"] is not None
    if has_pass != bool(body.passcheck_hash) or (body.passcheck_hash and not HEX64.match(body.passcheck_hash)):
        raise invalid("passcheck_hash", "passcheck_hash is required exactly when a passphrase is set.")
    if not items.all_received("secret_id", sid):
        raise invalid("chunks", "Some chunks haven’t arrived yet.")
    with db.tx() as conn:
        conn.execute("UPDATE secrets SET sealed = 1, upload_active_at = NULL, meta_ct = ?, reveal_hash = ?, passcheck_hash = ? "
                     "WHERE id = ?", (body.meta_ct.encode(), body.reveal_hash, body.passcheck_hash, sid))
        emit("secret.sealed", secret_id=sid, actor="user" if row["owner_id"] else "link", user_id=row["owner_id"],
             detail={"size": row["size_bytes"]}, c=conn)
    return Response(status_code=204)


@router.delete("/secrets/{sid}/upload", status_code=204)
def cancel_upload(sid: str, request: Request) -> Response:
    _uploading(request, sid)
    items.purge_secret(sid, None)
    db.run("DELETE FROM events WHERE secret_id = ?", sid)  # it never existed for anyone
    db.run("DELETE FROM user_receipts WHERE kind = 'secret' AND item_id = ?", sid)
    return Response(status_code=204)


# ------------------------------------------------------------------ recipient
def _revealable(request: Request, sid: str) -> tuple[Caller, sqlite3.Row]:
    """Reveal token check shared by meta, verify and reveal. Changes nothing."""
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
        if row["expires_at"] <= now():
            items.purge_secret(sid, "expired", event=("secret.expired", {"views_used": row["views"]}))
            raise gone("expired", row["expires_at"])
        if row["consumed_at"]:
            raise gone("opened", row["consumed_at"])
        return c, row
    tomb = db.one("SELECT * FROM tombstones WHERE kind = 'secret' AND id = ?", sid)
    if tomb is not None and matches(tomb["token_hash"], h):
        raise gone(tomb["reason"], tomb["at"])
    raise deny(c)


@router.get("/secrets/{sid}/meta")
def meta(sid: str, request: Request) -> dict[str, Any]:
    _, row = _revealable(request, sid)
    files = db.val("SELECT count(*) FROM streams WHERE secret_id = ? AND stream > 0", sid)
    out: dict[str, Any] = {
        "meta_ct": row["meta_ct"].decode(), "views_left": row["max_views"] - row["views"],
        "max_views": row["max_views"], "expires_at": iso(row["expires_at"]), "access": row["access"],
        "passphrase": row["passcheck_hash"] is not None, "size": row["size_bytes"], "files": files,
    }
    if row["access"] == "email":
        out["email_hint"] = row["email_hint"]
    if row["access"] == "org":
        out["org_name"] = state.brand_name()
        out["org_domains"] = state.env().oidc_allowed_domains
    if row["passcheck_hash"]:
        out["passphrase_salt"] = b64u(row["passphrase_salt"])
        out["tries_left"] = MAX_TRIES - row["failed_tries"]
    return out


def _sender_email(row: sqlite3.Row) -> str | None:
    if not row["owner_id"]:
        return None
    return db.val("SELECT email FROM users WHERE id = ?", row["owner_id"])


def _sender_name(row: sqlite3.Row) -> str:
    if row["owner_id"]:
        u = db.one("SELECT name, email FROM users WHERE id = ?", row["owner_id"])
        if u:
            return u["name"] or u["email"]
    return "Someone"


@router.post("/secrets/{sid}/verify/start", status_code=204)
def verify_start(sid: str, request: Request) -> Response:
    c, row = _revealable(request, sid)
    if row["access"] != "email" or not row["email_ct"]:
        raise invalid("access", "This link doesn’t need a code.")
    ratelimit.hit("auth", state.env().rate_auth, c.subject)
    prev = db.one("SELECT sent_at FROM email_codes WHERE secret_id = ?", sid)
    if prev and prev["sent_at"] > now() - 30:
        raise ratelimit.limited(prev["sent_at"] + 30 - now())
    code = f"{pysecrets.randbelow(10**6):06d}"
    t = now()
    with db.tx() as conn:
        conn.execute("INSERT OR REPLACE INTO email_codes(secret_id, code_hash, sent_at, expires_at, tries) VALUES (?,?,?,?, "
                     "coalesce((SELECT tries FROM email_codes WHERE secret_id = ?), 0))",
                     (sid, _code_hasher.hash(code), t, t + CODE_TTL, sid))
        emit("secret.code_sent", secret_id=sid, c=conn)
    mailer.code(security.unseal("email", row["email_ct"]).decode(), _sender_name(row), code)
    return Response(status_code=204)


class VerifyBody(Body):
    code: str = Field(pattern=r"^[0-9]{6}$")


@router.post("/secrets/{sid}/verify")
def verify(sid: str, body: VerifyBody, request: Request) -> dict[str, Any]:
    c, row = _revealable(request, sid)
    ratelimit.hit("auth", state.env().rate_auth, c.subject)
    rec = db.one("SELECT * FROM email_codes WHERE secret_id = ?", sid)
    if rec is None or rec["expires_at"] < now():
        raise ApiError("code_required", "That code expired. Send a new one.")
    try:
        ok = _code_hasher.verify(rec["code_hash"], body.code)
    except VerificationError:
        ok = False
    if not ok:
        tries = rec["tries"] + 1
        left = MAX_TRIES - tries
        if left <= 0:
            items.purge_secret(sid, "too_many_tries", event=("secret.destroyed", {"reason": "too_many_tries"}), actor="link")
            _notify_destroyed(row)
            raise gone("too_many_tries", now())
        with db.tx() as conn:
            conn.execute("UPDATE email_codes SET tries = ? WHERE secret_id = ?", (tries, sid))
            emit("secret.code_failed", secret_id=sid, detail={"tries_left": left}, c=conn)
        raise ApiError("wrong_code", tries_left=left)
    grant, grant_h = new_token()
    with db.tx() as conn:
        conn.execute("DELETE FROM email_codes WHERE secret_id = ?", (sid,))
        conn.execute("INSERT INTO access_grants(grant_hash, secret_id, expires_at) VALUES (?,?,?)", (grant_h, sid, now() + GRANT_TTL))
    return {"grant": grant}


def _notify_destroyed(row: sqlite3.Row) -> None:
    to = _sender_email(row)
    if to:
        mailer.destroyed(to, now())


@router.post("/secrets/{sid}/reveal")
def reveal(sid: str, request: Request) -> dict[str, Any]:
    c, row = _revealable(request, sid)
    access_check = "none"
    grant_h = None
    if row["access"] == "email":
        g = request.headers.get("x-access-grant")
        grant_h = token_hash(g) if g else None
        ok = grant_h and db.val("SELECT 1 FROM access_grants WHERE grant_hash = ? AND secret_id = ? AND expires_at > ?",
                                grant_h, sid, now())
        if not ok:
            raise ApiError("code_required")
        access_check = "email"
    elif row["access"] == "org":
        domains = state.env().oidc_allowed_domains
        if c.user is None or c.via != "session":
            raise ApiError("sign_in_required")
        if c.user["email"].rsplit("@", 1)[-1].lower() not in domains:
            raise ApiError("forbidden", f"Only people at {state.brand_name()} can open this.")
        access_check = "org"
    if row["passcheck_hash"]:
        pc = request.headers.get("x-passcheck")
        pc_h = token_hash(pc) if pc else None
        if pc_h is None:
            raise invalid("X-Passcheck", "This secret needs its passphrase.")
        if not matches(row["passcheck_hash"], pc_h):
            return _wrong_passphrase(sid)

    read, read_h = new_token()
    t = now()
    with db.tx() as conn:
        cur = conn.execute("SELECT views, max_views, consumed_at FROM secrets WHERE id = ?", (sid,)).fetchone()
        if cur is None or cur["consumed_at"]:  # lost a race for the last view
            raise gone("opened", t)
        views = cur["views"] + 1
        last = views >= cur["max_views"]
        conn.execute("UPDATE secrets SET views = ?, consumed_at = ? WHERE id = ?", (views, t if last else None, sid))
        conn.execute("INSERT INTO read_sessions(token_hash, secret_id, expires_at, last_view) VALUES (?,?,?,?)",
                     (read_h, sid, t + items.READ_SESSION, int(last)))
        if grant_h:
            conn.execute("DELETE FROM access_grants WHERE grant_hash = ?", (grant_h,))
        emit("secret.revealed", secret_id=sid, c=conn, detail={"views_left": cur["max_views"] - views, "access_check": access_check})
    if row["notify"]:
        to = _sender_email(row)
        if to:
            mailer.opened(to, sid, t)
    return {"read_session": read, "streams": items.stream_list("secret_id", sid), "views_left": row["max_views"] - views}


def _wrong_passphrase(sid: str) -> dict[str, Any]:
    with db.tx() as conn:
        conn.execute("UPDATE secrets SET failed_tries = failed_tries + 1 WHERE id = ?", (sid,))
        r = conn.execute("SELECT failed_tries FROM secrets WHERE id = ?", (sid,)).fetchone()
        left = MAX_TRIES - r["failed_tries"]
        emit("secret.passphrase_failed", secret_id=sid, detail={"tries_left": max(0, left)}, c=conn)
    if left <= 0:
        row = db.one("SELECT * FROM secrets WHERE id = ?", sid)
        items.purge_secret(sid, "too_many_tries", event=("secret.destroyed", {"reason": "too_many_tries"}), actor="link")
        if row is not None:
            _notify_destroyed(row)
        raise gone("too_many_tries", now())
    raise ApiError("wrong_passphrase", tries_left=left)


def _read_session(request: Request, sid: str) -> sqlite3.Row:
    c = caller(request)
    h = cap_hash(request, "Read")
    s = db.one("SELECT * FROM read_sessions WHERE token_hash = ?", h) if h else None
    if s is None or s["secret_id"] != sid or s["expires_at"] < now():
        raise deny(c, presented=h is not None)
    return s


def _get_chunk(sid: str, stream: int, n: int, request: Request) -> bytes:
    s = _read_session(request, sid)
    data = items.read_chunk("secret", sid, stream, n)
    if data is None:
        raise NotFound()
    db.run("UPDATE chunks SET served = 1 WHERE owner_kind = 'secret' AND owner_id = ? AND stream = ? AND n = ?", sid, stream, n)
    if s["last_view"] and not db.val("SELECT 1 FROM chunks WHERE owner_kind='secret' AND owner_id=? AND served=0 LIMIT 1", sid):
        items.purge_secret(sid, "opened")  # everything delivered: delete now, don't wait for the session to end
    return data


@router.get("/secrets/{sid}/chunks/{stream}/{n}")
async def get_chunk(sid: str, stream: int, n: int, request: Request) -> Response:
    data = await run_in_threadpool(_get_chunk, sid, stream, n, request)
    return Response(data, media_type="application/octet-stream",
                    headers={"Content-Disposition": "attachment", "Cache-Control": "no-store"})


# ------------------------------------------------------------------ sender
def manage_allowed(request: Request, kind: str, item_id: str, manage_hash: str | None) -> bool:
    """Manage token, or a signed-in user who attached this receipt to their account."""
    h = cap_hash(request, "Manage")
    if h is not None:
        return matches(manage_hash, h)
    c = caller(request)
    if c.user_id and c.via == "session":
        r = db.one("SELECT manage_hash FROM user_receipts WHERE user_id = ? AND kind = ? AND item_id = ?", c.user_id, kind, item_id)
        return r is not None and matches(manage_hash, r["manage_hash"])
    if c.via == "token":
        r = db.one("SELECT manage_hash FROM user_receipts WHERE user_id = ? AND kind = ? AND item_id = ?", c.user_id, kind, item_id)
        return r is not None and matches(manage_hash, r["manage_hash"])
    return False


@router.delete("/secrets/{sid}", status_code=204)
def destroy(sid: str, request: Request) -> Response:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    row = db.one("SELECT * FROM secrets WHERE id = ?", sid) if is_id(sid) else None
    if row is not None and manage_allowed(request, "secret", sid, row["manage_hash"]):
        items.purge_secret(sid, "destroyed", event=("secret.destroyed", {"reason": "sender"}), actor=c.actor if c.user else "link",
                           user_id=c.user_id)
        return Response(status_code=204)
    tomb = db.one("SELECT manage_hash FROM tombstones WHERE kind = 'secret' AND id = ?", sid) if is_id(sid) else None
    if tomb is not None and manage_allowed(request, "secret", sid, tomb["manage_hash"]):
        return Response(status_code=204)  # already gone: destroying is idempotent
    raise deny(c, presented=cap_hash(request, "Manage") is not None)


# ------------------------------------------------------------------ demo reports
@router.post("/secrets/{sid}/report", status_code=204)
def report(sid: str, request: Request) -> Response:
    """Demo only: anyone holding the link can take it down."""
    if not state.env().demo:
        raise NotFound()
    _c, _row = _revealable(request, sid)
    items.purge_secret(sid, "destroyed", event=("secret.destroyed", {"reason": "reported"}), actor="link")
    return Response(status_code=204)

