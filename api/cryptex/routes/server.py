"""The Server tab (owners only, screens E1–E7). No endpoint here can read, reveal or
destroy anyone's secrets: there is no admin bypass."""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import struct
import time
import xml.etree.ElementTree as ET
from typing import Any, Literal
from xml.parsers import expat

from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import Field

from .. import VERSION, db, items, state, storage
from ..account import Username, forget_sign_ins
from ..config import EDITABLE, validate_setting
from ..deps import Caller, require_owner, require_reauth
from ..errors import ApiError, NotFound, invalid
from ..events import emit
from ..util import from_iso, iso, new_id, now
from .auth import issue_invite, issue_reset_link
from .common import Body, read_body
from .config import brand_json

router = APIRouter()
LIMIT_KEYS = ["max_expiration", "max_file_size", "max_files", "max_message_length", "audit_retention_days"]


def _changed(user_id: str | None, key: str, old: Any, new: Any) -> None:
    if old != new:
        emit("setting.changed", actor="user", user_id=user_id, detail={"key": key, "from": old, "to": new})


# ------------------------------------------------------------------ overview
@router.get("/server/overview")
def overview(request: Request) -> dict[str, Any]:
    require_owner(request)
    t = now()
    total, free = storage.get().disk()
    cleanup = db.one("SELECT last_run_at, last_result FROM jobs WHERE name = 'cleanup'")
    attention: list[dict[str, Any]] = []
    if total and (total - free) / total > 0.9:
        attention.append({"code": "disk", "level": "error", "pct": round(100 * (total - free) / total)})
    if cleanup is not None and (cleanup["last_run_at"] or 0) < t - 900:
        attention.append({"code": "cleanup", "level": "error", "minutes": (t - (cleanup["last_run_at"] or t)) // 60 or 15})
    recent = audit_rows(limit=6)
    return {
        "version": VERSION, "update_available": None,
        "storage": {"used": items.stored_bytes(), "disk_total": total, "disk_free": free},
        "live": {"secrets": db.val("SELECT count(*) FROM secrets WHERE sealed = 1"),
                 "expiring_today": db.val("SELECT count(*) FROM secrets WHERE sealed = 1 AND expires_at < ?", t + 86400)},
        "week": {"created": db.val("SELECT count(*) FROM events WHERE type = 'secret.created' AND at > ?", t - 7 * 86400),
                 "senders": db.val("SELECT count(DISTINCT coalesce(actor_user_id, 'anon')) FROM events "
                                   "WHERE type = 'secret.created' AND at > ?", t - 7 * 86400)},
        "cleanup": {"last_run": iso(cleanup["last_run_at"]) if cleanup else None,
                    "removed": int(cleanup["last_result"]) if cleanup and (cleanup["last_result"] or "").isdigit() else 0},
        "attention": attention, "recent": recent["items"],
    }


# ------------------------------------------------------------------ access and people
def _status(u: Any, reset_until: int | None) -> str:
    if reset_until:
        return "reset"  # a reset link is waiting
    if u["invite_hash"] is None:
        return "active" if u["password_hash"] is not None else "locked"  # locked: by a reset link that then expired
    return "invited" if (u["invite_expires_at"] or 0) > now() else "expired"


def _people() -> list[dict[str, Any]]:
    resets = {r["user_id"]: r["expires_at"] for r in db.all("SELECT user_id, expires_at FROM reset_links WHERE expires_at > ?", now())}
    return [{"id": u["id"], "username": u["username"], "role": u["role"], "status": _status(u, resets.get(u["id"])),
             "invite_expires_at": iso(u["invite_expires_at"]), "reset_expires_at": iso(resets.get(u["id"])),
             "last_seen_at": iso(u["last_seen_at"])}
            for u in db.all("SELECT * FROM users ORDER BY role = 'owner' DESC, username")]


@router.get("/server/access")
def get_access(request: Request) -> dict[str, Any]:
    c = require_owner(request)
    r = state.resolve("access")
    return {"mode": r.value, "locked_by": r.locked_by,
            "people": _people(), "me": c.user_id,
            "reauth_until": iso(c.reauth_until) if c.reauth_until and c.reauth_until > now() else None}


class AccessBody(Body):
    mode: Literal["anyone", "signed_in"]


@router.put("/server/access", status_code=204)
def put_access(body: AccessBody, request: Request) -> Response:
    c = require_owner(request)
    require_reauth(c)
    r = state.resolve("access")
    if r.locked_by:
        raise invalid("mode", f"Set by {r.locked_by} in your environment.")
    state.save("access", body.mode, c.user_id)
    _changed(c.user_id, "access", r.value, body.mode)
    return Response(status_code=204)


@router.get("/server/users")
def users(request: Request) -> dict[str, Any]:
    require_owner(request)
    return {"items": _people()}


class NewPerson(Body):
    username: Username
    role: Literal["member", "owner"] = "member"


@router.post("/server/users", status_code=201)
def add_person(body: NewPerson, request: Request) -> dict[str, Any]:
    """Create an account and return a one-time invite link. Nothing is emailed: the owner passes the link on."""
    c = require_owner(request)
    require_reauth(c)
    username = body.username
    uid = new_id(16)
    with db.tx() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise invalid("username", "Someone already has that username.")
        conn.execute("INSERT INTO users(id, username, role, created_at) VALUES (?,?,?,?)",
                     (uid, username, body.role, now()))
        invite = issue_invite(conn, uid)
        emit("user.invited", actor="user", user_id=c.user_id, detail={"user_id": uid, "role": body.role}, c=conn)
    return {"id": uid, **invite}


@router.post("/server/users/{user_id}/invite")
def reinvite(user_id: str, request: Request) -> dict[str, Any]:
    """A new invite link, for someone who hasn't joined yet. People who joined get a reset link instead."""
    c = require_owner(request)
    require_reauth(c)
    with db.tx() as conn:
        u = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if u is None:
            raise NotFound()
        if u["invite_hash"] is None:
            raise invalid("user_id", "They already joined. Make a reset link instead.")
        invite = issue_invite(conn, user_id)
        emit("user.invited", actor="user", user_id=c.user_id, detail={"user_id": user_id, "role": u["role"]}, c=conn)
    return invite


class ResetLinkBody(Body):
    lock: bool = False  # the account may be compromised: stop the current password and sign out everywhere now


@router.post("/server/users/{user_id}/reset")
def make_reset_link(user_id: str, body: ResetLinkBody, request: Request) -> dict[str, Any]:
    """A reset link and a separate code for someone who joined (owner or member): with both, they choose a new
    password, and their 2FA is turned off (they can set up a new one on the same page). Not for yourself."""
    c = require_owner(request)
    require_reauth(c)
    assert c.user is not None
    if user_id == c.user_id:
        raise invalid("user_id", "Change your own password and 2FA under Your account.")
    with db.tx() as conn:
        u = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if u is None:
            raise NotFound()
        if u["invite_hash"] is not None:
            raise invalid("user_id", "They haven’t joined yet. Make a new invite link instead.")
        link = issue_reset_link(conn, user_id, c.user["username"], body.lock)
        emit("user.reset_link", actor="user", user_id=c.user_id, detail={"user_id": user_id, "role": u["role"], "lock": body.lock}, c=conn)
    return link


def still_owner(conn: sqlite3.Connection, c: Caller) -> None:
    """Inside the transaction: the caller is still an owner. Two owners removing or demoting each other at the same
    time would otherwise both pass require_owner and leave the server with none."""
    if conn.execute("SELECT 1 FROM users WHERE id = ? AND role = 'owner'", (c.user_id,)).fetchone() is None:
        raise NotFound()


@router.delete("/server/users/{user_id}", status_code=204)
def remove_person(user_id: str, request: Request) -> Response:
    """Their links keep working until they expire; they just can't sign in or see them any more."""
    c = require_owner(request)
    require_reauth(c)
    if user_id == c.user_id:
        raise invalid("user_id", "Ask another owner to remove you.")
    with db.tx() as conn:
        still_owner(conn, c)  # and as the caller isn't the one removed, an owner remains
        u = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if u is None:
            raise NotFound()
        forget_sign_ins(conn, user_id)  # their temporary password file too: a new account by that name starts clean
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        emit("user.removed", actor="user", user_id=c.user_id, detail={"user_id": user_id, "role": u["role"]}, c=conn)
    return Response(status_code=204)


class RoleBody(Body):
    role: Literal["member", "owner"]


@router.patch("/server/users/{user_id}", status_code=204)
def set_role(user_id: str, body: RoleBody, request: Request) -> Response:
    c = require_owner(request)
    require_reauth(c)
    with db.tx() as conn:
        still_owner(conn, c)
        u = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if u is None:
            raise NotFound()
        if body.role != u["role"]:
            if u["role"] == "owner" and conn.execute("SELECT count(*) FROM users WHERE role = 'owner'").fetchone()[0] <= 1:
                raise ApiError("forbidden", "The last owner can’t be demoted. Promote someone else first.", status=409, reason="last_owner")
            conn.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
            emit("user.role_changed", actor="user", user_id=c.user_id, detail={"user_id": user_id, "role": body.role}, c=conn)
    return Response(status_code=204)


# ------------------------------------------------------------------ limits
@router.get("/server/limits")
def get_limits(request: Request) -> dict[str, Any]:
    require_owner(request)
    _, free = storage.get().disk()
    out = {}
    for k in LIMIT_KEYS:
        r, s = state.resolve(k), EDITABLE[k]
        out[k] = {"value": r.value, "locked_by": r.locked_by, "min": s.lo, "max": s.hi, "default": s.default}
    return {"items": out, "disk_free": free}


@router.put("/server/limits", status_code=204)
def put_limits(body: dict[str, Any], request: Request) -> Response:
    c = require_owner(request)
    parsed = {}
    for k, v in body.items():
        if k not in LIMIT_KEYS:
            raise invalid(k, "Unknown setting.")
        r = state.resolve(k)
        if r.locked_by:
            raise invalid(k, f"Set by {r.locked_by} in your environment.")
        try:
            parsed[k] = validate_setting(k, v)
        except ValueError as err:  # the parsers' messages are written for people (config.py)
            raise invalid(k, f"That {k.replace('_', ' ')} {err}.") from None
    for k, v in parsed.items():
        old = state.setting(k)
        state.save(k, v, c.user_id)
        _changed(c.user_id, k, old, v)
    return Response(status_code=204)


# ------------------------------------------------------------------ language
@router.get("/server/language")
def get_language(request: Request) -> dict[str, Any]:
    require_owner(request)
    r = state.resolve("language")
    return {"language": r.value, "locked_by": r.locked_by}


class LanguageBody(Body):
    language: str


@router.put("/server/language", status_code=204)
def put_language(body: LanguageBody, request: Request) -> Response:
    c = require_owner(request)
    r = state.resolve("language")
    if r.locked_by:
        raise invalid("language", f"Set by {r.locked_by} in your environment.")
    try:
        value = validate_setting("language", body.language)
    except ValueError as err:
        raise invalid("language", str(err)) from None
    state.save("language", value, c.user_id)
    _changed(c.user_id, "language", r.value, value)
    return Response(status_code=204)


# ------------------------------------------------------------------ branding
@router.get("/server/branding")
def get_branding(request: Request) -> dict[str, Any]:
    require_owner(request)
    logo = state.raw("brand_logo")
    return {**brand_json(), "name_locked_by": state.resolve("brand_name").locked_by,
            "logo_name": logo.get("name") if logo else None}


class BrandingBody(Body):
    name: str | None = Field(default=None, max_length=40)


@router.put("/server/branding", status_code=204)
def put_branding(body: BrandingBody, request: Request) -> Response:
    c = require_owner(request)
    if body.name is not None:
        r = state.resolve("brand_name")
        if r.locked_by:
            raise invalid("name", f"Set by {r.locked_by} in your environment.")
        state.save("brand_name", body.name.strip(), c.user_id)
        _changed(c.user_id, "brand_name", r.value, body.name.strip())
    return Response(status_code=204)


SVG_ALLOWED = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "lineargradient",
               "radialgradient", "stop", "title", "desc", "clippath", "mask", "use", "symbol"}


def _no_dtd(*_: Any) -> None:
    raise ValueError("DTD")


def sanitize_svg(data: bytes) -> bytes:
    """UTF-8 only (whatever the XML declaration says), and no DTD at all, so no entities to expand."""
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        raise invalid("logo", "Save the SVG as UTF-8.") from None
    check = expat.ParserCreate(encoding="utf-8")
    check.StartDoctypeDeclHandler = _no_dtd
    check.EntityDeclHandler = _no_dtd
    try:
        check.Parse(data, True)
        root = ET.fromstring(data, parser=ET.XMLParser(encoding="utf-8"))  # noqa: S314 (UTF-8 without a DTD, checked above)
    except ValueError:
        raise invalid("logo", "SVG files can’t contain a DOCTYPE.") from None
    except (ET.ParseError, expat.ExpatError):
        raise invalid("logo", "That SVG couldn’t be read.") from None

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1].lower()
    if local(root.tag) != "svg":
        raise invalid("logo", "That isn’t an SVG image.")

    def clean(el: ET.Element) -> None:
        for child in list(el):
            if local(child.tag) not in SVG_ALLOWED:
                el.remove(child)
            else:
                clean(child)
        for attr in list(el.attrib):
            name, value = local(attr), el.attrib[attr]
            if name.startswith("on") or (name == "href" and not value.startswith("#")) or "javascript:" in value.lower() \
                    or name == "style" and ("url(" in value or "expression" in value):
                del el.attrib[attr]
    clean(root)
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    return ET.tostring(root)


@router.put("/server/branding/logo", status_code=204)
async def put_logo(request: Request) -> Response:
    c = await run_in_threadpool(require_owner, request)
    data = await read_body(request, 1024 * 1024)  # async: reading the body is the only part that waits on the network
    await run_in_threadpool(_save_logo, c, request, data)  # parsing, files and the database: off the event loop
    return Response(status_code=204)


def _save_logo(c: Caller, request: Request, data: bytes) -> None:
    ctype = request.headers.get("content-type", "").split(";")[0].strip()
    if ctype == "image/svg+xml":
        data, ext = sanitize_svg(data), "svg"
    elif ctype == "image/png":
        if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24:
            raise invalid("logo", "That isn’t a PNG image.")
        w, h = struct.unpack(">II", data[16:24])
        if min(w, h) < 64:
            raise invalid("logo", "Use a logo at least 64 px wide and tall.")
        ext = "png"
    else:
        raise invalid("logo", "Use an SVG or PNG file.")
    v = new_id(8)
    path = state.env().data_dir / "brand" / f"logo-{v}.{ext}"
    path.write_bytes(data)
    old = state.raw("brand_logo")
    state.save("brand_logo", {"file": path.name, "v": v, "name": request.headers.get("x-file-name", f"logo.{ext}")[:80]}, c.user_id)
    if old:
        (state.env().data_dir / "brand" / old["file"]).unlink(missing_ok=True)
    emit("setting.changed", actor="user", user_id=c.user_id, detail={"key": "brand_logo", "from": None, "to": "uploaded"})


@router.delete("/server/branding/logo", status_code=204)
def delete_logo(request: Request) -> Response:
    c = require_owner(request)
    old = state.raw("brand_logo")
    if old:
        (state.env().data_dir / "brand" / old["file"]).unlink(missing_ok=True)
        db.run("DELETE FROM settings WHERE key = 'brand_logo'")
        state.invalidate()
        emit("setting.changed", actor="user", user_id=c.user_id, detail={"key": "brand_logo", "from": "uploaded", "to": None})
    return Response(status_code=204)


# ------------------------------------------------------------------ audit
def _date(field: str, v: str | None) -> int | None:
    if not v:
        return None
    try:
        return from_iso(v)
    except (ValueError, OverflowError):
        raise invalid(field, "Use an ISO 8601 date.") from None


def audit_rows(type_: str | None = None, q: str | None = None, from_: str | None = None, to: str | None = None,
               cursor: str | None = None, limit: int = 50) -> dict[str, Any]:
    """Raises invalid for a `from` or `to` that isn't a date."""
    where: list[str] = ["e.type NOT IN ('secret.sealed')"]
    args: list[Any] = []
    start, end = _date("from", from_), _date("to", to)
    if type_:
        where.append("(e.type = ? OR e.type LIKE ?)")
        args += [type_, type_.rstrip(".*") + ".%"]
    if q:
        where.append("(u.username LIKE ? OR e.secret_id = ?)")
        args += [f"%{q.strip()}%", q.strip()]
    if start is not None:
        where.append("e.at >= ?")
        args.append(start)
    if end is not None:
        where.append("e.at <= ?")
        args.append(end)
    if cursor and cursor.isdigit() and len(cursor) < 19:
        where.append("e.id < ?")
        args.append(int(cursor))
    rows = db.all(f"SELECT e.*, u.username FROM events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE {' AND '.join(where)} "
                  f"ORDER BY e.id DESC LIMIT ?", *args, limit + 1)
    out = [{"id": r["id"], "type": r["type"], "at": iso(r["at"]), "detail": json.loads(r["detail"]), "actor": r["actor"],
            "actor_username": r["username"], "item": r["secret_id"]} for r in rows[:limit]]
    return {"items": out, "next": str(rows[limit - 1]["id"]) if len(rows) > limit else None}


@router.get("/server/audit")
def audit(request: Request, type: str | None = None, q: str | None = None, cursor: str | None = None,  # noqa: A002
          to: str | None = None) -> dict[str, Any]:
    require_owner(request)
    return audit_rows(type, q, request.query_params.get("from"), to, cursor)


@router.get("/server/audit.csv")
def audit_csv(request: Request, type: str | None = None, q: str | None = None) -> StreamingResponse:  # noqa: A002
    require_owner(request)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "time", "type", "actor", "actor_username", "item", "detail"])
    cursor = None
    while True:
        page = audit_rows(type, q, request.query_params.get("from"), request.query_params.get("to"), cursor, limit=500)
        for r in page["items"]:
            w.writerow([r["id"], r["at"], r["type"], r["actor"], r["actor_username"] or "", r["item"] or "",
                        json.dumps(r["detail"], separators=(",", ":"))])
        cursor = page["next"]
        if not cursor:
            break
    data = buf.getvalue()
    day = time.strftime("%Y-%m-%d", time.gmtime())
    return StreamingResponse(iter([data]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="cryptex-audit-{day}.csv"'})
