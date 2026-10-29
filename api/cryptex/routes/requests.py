"""Ask for a secret: whoever can create links makes a request link, and whoever opens it sends them a secret, with or
without an account. The answer is an ordinary secret (secrets.py: chunks, seal, reveal) whose link key is encrypted to
the requester's public key (docs/crypto.md §4), so neither the server nor anyone else holding the request link can read
it. One answer per request. The requester holds a manage token, like a link's sender: in the account vault when signed
in, else in this browser."""
from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import Field

from .. import db, demo, items, ratelimit, state
from ..deps import Caller, caller, cap_hash, deny, matches
from ..errors import ApiError, NotFound, invalid
from ..events import emit
from ..util import is_id, iso, new_token, now, token_hash, unb64u
from .common import B64U, HEX64, Body, check_create_allowed
from .receipts import Lookup, status_request
from .secrets import manifest_cap, unique_id

router = APIRouter()
ASK_MAX = 8 * 1024  # the encrypted note (1000 characters at most) and public key


class CreateRequest(Body):
    expires_in: int = Field(ge=300)


@router.post("/requests", status_code=201)
def create_request(body: CreateRequest, request: Request) -> dict[str, Any]:
    """Step one: the ID, which the link's key is bound to. Seal completes it. Who may ask is who may create links;
    in the demo it counts as one of today's links."""
    c = caller(request)
    check_create_allowed(c)
    if body.expires_in > state.setting("max_expiration"):
        raise ApiError("limit_exceeded", field="expires_in", limit=state.setting("max_expiration"))
    if state.env().demo:
        demo.before_create(c, request, 0, 0)
    manage, manage_h = new_token()
    t = now()
    with db.tx() as conn:
        rid = unique_id(conn)
        conn.execute("INSERT INTO requests(id, owner_id, manage_hash, created_at, expires_at) VALUES (?,?,?,?,?)",
                     (rid, c.user_id, manage_h, t, t + body.expires_in))
    return {"id": rid, "manage_token": manage, "expires_at": iso(t + body.expires_in)}


class SealRequest(Body):
    ask_ct: str = Field(min_length=1, max_length=ASK_MAX)
    answer_hash: str


def _managed(request: Request, rid: str) -> tuple[Caller, sqlite3.Row]:
    """The requester's Manage token checked. A wrong one counts toward the failed-token block only for a request that
    exists: Your links can hold requests long gone."""
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    h = cap_hash(request, "Manage")
    row = db.one("SELECT * FROM requests WHERE id = ?", rid) if is_id(rid) and h else None
    if row is None or not matches(row["manage_hash"], h):
        raise deny(c, presented=h is not None and row is not None)
    return c, row


@router.post("/requests/{rid}/seal", status_code=204)
def seal_request(rid: str, body: SealRequest, request: Request) -> Response:
    c, row = _managed(request, rid)
    if not B64U.match(body.ask_ct):
        raise invalid("ask_ct")
    if not HEX64.match(body.answer_hash):
        raise invalid("answer_hash")
    with db.tx() as conn:
        if not conn.execute("UPDATE requests SET ask_ct = ?, answer_hash = ? WHERE id = ? AND ask_ct IS NULL AND closed_at IS NULL",
                            (body.ask_ct.encode(), body.answer_hash, rid)).rowcount:
            raise NotFound()
        emit("secret.requested", secret_id=rid, actor="user" if row["owner_id"] else "link", user_id=row["owner_id"],
             detail={"expires_in": row["expires_at"] - row["created_at"]}, c=conn)
    return Response(status_code=204)


# ------------------------------------------------------------------ the requester (Your links)
def _view(r: sqlite3.Row, answer: sqlite3.Row | None, tomb: sqlite3.Row | None) -> dict[str, Any]:
    """waiting: no answer yet. answered: the answer can be opened (until the request expires). expired: no answer in
    time, or not opened in time. destroyed: the answer was destroyed."""
    t = now()
    out: dict[str, Any] = {"id": r["id"], "created_at": iso(r["created_at"]), "expires_at": iso(r["expires_at"])}
    if not r["answered_at"]:
        out["status"] = "waiting" if r["expires_at"] > t else "expired"
        if out["status"] == "expired":
            out["ended_at"] = iso(r["expires_at"])
        return out
    out["answered_at"] = iso(r["answered_at"])
    if answer is not None and answer["expires_at"] > t:
        out.update(status="answered", views=answer["views"], answer={
            "id": r["answer_id"], "key": r["answer_ct"].decode(), "expires_at": iso(answer["expires_at"]),
            "files": items.file_count(r["answer_id"]), "passphrase": answer["passcheck_hash"] is not None})
    else:
        out["status"] = "destroyed" if tomb is not None and tomb["reason"] != "expired" else "expired"
        out["views"] = answer["views"] if answer is not None else int(bool(tomb and tomb["opened"]))
        out["ended_at"] = iso(tomb["at"] if tomb is not None else answer["expires_at"] if answer is not None else r["answered_at"])
    return out


@router.post("/requests/lookup")
def lookup(body: Lookup, request: Request) -> dict[str, Any]:
    """Statuses for Your links: each (id, manage token) pair that proves its token. Closed requests are left out (the
    requester deleted them, or a password reset closed them)."""
    c = caller(request)
    status_request(c)
    out, wrong = [], 0
    for p in body.items:
        r = db.one("SELECT * FROM requests WHERE id = ?", p.id) if is_id(p.id) else None
        if r is None or not matches(r["manage_hash"], token_hash(p.manage_token)):
            wrong += r is not None
            continue
        if r["closed_at"] or r["ask_ct"] is None:
            continue
        a = r["answer_id"]
        answer = db.one("SELECT views, expires_at, passcheck_hash FROM secrets WHERE id = ?", a) if a else None
        tomb = db.one("SELECT reason, opened, at FROM tombstones WHERE id = ?", a) if a and answer is None else None
        out.append(_view(r, answer, tomb))
    if wrong:
        ratelimit.failed_token(c.ip, wrong)
    return {"items": out}


@router.delete("/requests/{rid}", status_code=204)
def close_request(rid: str, request: Request) -> Response:
    """Delete a request from Your links: its link stops taking answers, and an answer it has is destroyed."""
    c, r = _managed(request, rid)
    if r["closed_at"]:
        return Response(status_code=204)
    for s in db.all("SELECT id FROM secrets WHERE request_id = ? AND sealed = 0", rid):
        items.drop_upload(s["id"])  # an answer on its way
    if r["answer_id"]:
        items.purge_secret(r["answer_id"], "destroyed", event=("secret.destroyed", {"reason": "sender"}),
                           actor="user" if c.user else "link", user_id=c.user_id)
    db.run("UPDATE requests SET closed_at = ?, ask_ct = NULL, answer_ct = NULL WHERE id = ?", now(), rid)
    return Response(status_code=204)


# ------------------------------------------------------------------ whoever holds the request link
def _answerable(request: Request, rid: str) -> tuple[Caller, sqlite3.Row]:
    """The Answer token checked, and the request still open. Changes nothing."""
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    ratelimit.hit("reveal", state.env().rate_reveal, c.subject)
    h = cap_hash(request, "Answer")
    row = db.one("SELECT * FROM requests WHERE id = ?", rid) if is_id(rid) and h else None
    if row is None or not matches(row["answer_hash"], h):
        raise deny(c, presented=h is not None)
    if row["closed_at"] or row["answered_at"] or row["expires_at"] <= now():
        raise items.request_ended(rid)
    return c, row


@router.get("/requests/{rid}")
def get_request(rid: str, request: Request) -> dict[str, Any]:
    _, row = _answerable(request, rid)
    # Never who asks: a username is half of a sign-in, and the link may travel further than meant. The page shows the
    # request's code instead, which the requester sees too.
    return {"ask_ct": row["ask_ct"].decode(), "expires_at": iso(row["expires_at"])}


class StartAnswer(Body):
    streams: list[dict[str, Any]]
    passphrase_salt: str | None = None  # the answer asks for a passphrase (docs/crypto.md §3.2), chosen by who answers


@router.post("/requests/{rid}/answer", status_code=201)
def start_answer(rid: str, body: StartAnswer, request: Request) -> dict[str, Any]:
    """Make the answer's secret, then upload and seal it as any other (PUT chunks, POST seal with answer_ct). It opens
    any number of times until the request expires. A new start replaces an answer still on its way."""
    c, row = _answerable(request, rid)
    salt = None
    if body.passphrase_salt is not None:
        try:
            salt = unb64u(body.passphrase_salt)
        except ValueError:
            salt = b""
        if len(salt) != 16:
            raise invalid("passphrase_salt", "A passphrase needs a 16-byte salt.")
    streams = items.check_streams(body.streams, max_files=int(state.setting("max_files")),
                                  max_file_size=int(state.setting("max_file_size")), manifest_cap=manifest_cap())
    total = sum(s["size"] for s in streams)
    ratelimit.hit("create", state.env().rate_create, c.subject)
    if state.env().demo:
        demo.before_create(c, request, total, len(streams) - 1)
    for s in db.all("SELECT id FROM secrets WHERE request_id = ? AND sealed = 0", rid):
        items.drop_upload(s["id"])
    items.check_disk(total)
    upload, upload_h = new_token()
    _, manage_h = new_token()  # nobody manages an answer by token: the requester deletes it with the request
    t = now()
    with db.tx() as conn:
        sid = unique_id(conn)
        conn.execute(
            "INSERT INTO secrets(id, created_at, expires_at, max_views, passphrase_salt, manage_hash, upload_hash, upload_active_at, "
            "size_bytes, request_id) VALUES (?,?,?,NULL,?,?,?,?,?,?)",
            (sid, t, row["expires_at"], salt, manage_h, upload_h, t, total, rid))
        items.insert_streams(conn, sid, streams)
    return {"id": sid, "upload_token": upload}
