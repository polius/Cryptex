"""The Server tab (owners only, screens E1–E7). No endpoint here can read, reveal or
destroy anyone's secrets: there is no admin bypass."""
from __future__ import annotations

import csv
import io
import json
import re
import struct
import xml.etree.ElementTree as ET
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import Field

from .. import VERSION, db, items, mailer, state, storage, webhooks
from ..config import EDITABLE, validate_setting
from ..deps import require_owner, require_reauth
from ..errors import ApiError, NotFound, invalid
from ..events import emit
from ..util import from_iso, iso, new_id, now
from .common import Body, read_body
from .config import brand_json

router = APIRouter()
LIMIT_KEYS = ["max_expiration", "max_views", "max_file_size", "max_files", "max_message_length",
              "request_max_expiration", "request_max_keep", "audit_retention_days"]


def _changed(user_id: str | None, key: str, old: Any, new: Any) -> None:
    if old != new:
        emit("setting.changed", actor="user", user_id=user_id, detail={"key": key, "from": old, "to": new})


# ------------------------------------------------------------------ overview
@router.get("/server/overview")
def overview(request: Request) -> dict[str, Any]:
    require_owner(request)
    e = state.env()
    t = now()
    total, free = storage.get().disk()
    cleanup = db.one("SELECT last_run_at, last_result FROM jobs WHERE name = 'cleanup'")
    attention: list[dict[str, Any]] = []
    if not e.smtp_enabled:
        attention.append({"code": "smtp", "level": "warn", "action": "/server/notifications"})
    no2fa = db.all("SELECT email FROM users WHERE role = 'owner' AND password_hash IS NOT NULL AND totp_ct IS NULL")
    if no2fa:
        attention.append({"code": "2fa", "level": "warn", "n": len(no2fa), "emails": [r["email"] for r in no2fa],
                          "action": "/server/access"})
    if total and (total - free) / total > 0.9:
        attention.append({"code": "disk", "level": "error", "pct": round(100 * (total - free) / total)})
    if cleanup is not None and (cleanup["last_run_at"] or 0) < t - 900:
        attention.append({"code": "cleanup", "level": "error", "minutes": (t - (cleanup["last_run_at"] or t)) // 60 or 15})
    if not state.public_url().startswith("https://") and urlparse(state.public_url()).hostname not in ("localhost", "127.0.0.1"):
        attention.append({"code": "https", "level": "error"})
    recent = audit_rows(limit=6)
    return {
        "version": VERSION, "update_available": None, "public_url": state.public_url(),
        "storage": {"used": items.stored_bytes(), "disk_total": total, "disk_free": free},
        "live": {"secrets": db.val("SELECT count(*) FROM secrets WHERE sealed = 1"),
                 "requests": db.val("SELECT count(*) FROM requests"),
                 "expiring_today": db.val("SELECT (SELECT count(*) FROM secrets WHERE sealed = 1 AND expires_at < ?) + "
                                          "(SELECT count(*) FROM requests WHERE expires_at < ?)", t + 86400, t + 86400)},
        "week": {"created": db.val("SELECT count(*) FROM events WHERE type IN ('secret.created','request.created') AND at > ?", t - 7 * 86400),
                 "senders": db.val("SELECT count(DISTINCT coalesce(actor_user_id, 'anon')) FROM events "
                                   "WHERE type IN ('secret.created','request.created') AND at > ?", t - 7 * 86400)},
        "cleanup": {"last_run": iso(cleanup["last_run_at"]) if cleanup else None,
                    "removed": int(cleanup["last_result"]) if cleanup and (cleanup["last_result"] or "").isdigit() else 0},
        "attention": attention, "recent": recent["items"],
    }


# ------------------------------------------------------------------ access and people
def _people() -> list[dict[str, Any]]:
    return [{"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "mfa": u["totp_ct"] is not None,
             "sign_in": "sso" if u["oidc_sub"] else "password", "last_seen_at": iso(u["last_seen_at"])}
            for u in db.all("SELECT * FROM users ORDER BY role = 'owner' DESC, email")]


@router.get("/server/access")
def get_access(request: Request) -> dict[str, Any]:
    c = require_owner(request)
    e = state.env()
    r = state.resolve("access")
    return {"mode": r.value, "locked_by": r.locked_by,
            "sso": {"enabled": e.oidc_enabled, "name": e.oidc_name, "issuer": urlparse(e.oidc_issuer or "").hostname,
                    "domains": e.oidc_allowed_domains},
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


class RoleBody(Body):
    role: Literal["member", "owner"]


@router.patch("/server/users/{user_id}", status_code=204)
def set_role(user_id: str, body: RoleBody, request: Request) -> Response:
    c = require_owner(request)
    require_reauth(c)
    with db.tx() as conn:
        u = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if u is None:
            raise NotFound()
        if u["role"] == "owner" and body.role == "member" and \
                conn.execute("SELECT count(*) FROM users WHERE role = 'owner'").fetchone()[0] <= 1:
            raise ApiError("forbidden", "The last owner can’t be demoted. Promote someone else first.", status=409)
        conn.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
        if u["role"] != body.role:
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
        except (ValueError, TypeError) as err:
            raise invalid(k, str(err)) from None
    for k, v in parsed.items():
        old = state.setting(k)
        state.save(k, v, c.user_id)
        _changed(c.user_id, k, old, v)
    return Response(status_code=204)


# ------------------------------------------------------------------ branding
@router.get("/server/branding")
def get_branding(request: Request) -> dict[str, Any]:
    require_owner(request)
    logo = state.raw("brand_logo")
    return {**brand_json(), "name_locked_by": state.resolve("brand_name").locked_by,
            "public_url_locked_by": "PUBLIC_URL" if state.env().public_url else None,
            "logo_name": logo.get("name") if logo else None}


class BrandingBody(Body):
    name: str | None = Field(default=None, max_length=40)
    public_url: str | None = None


@router.put("/server/branding", status_code=204)
def put_branding(body: BrandingBody, request: Request) -> Response:
    c = require_owner(request)
    if body.name is not None:
        r = state.resolve("brand_name")
        if r.locked_by:
            raise invalid("name", f"Set by {r.locked_by} in your environment.")
        state.save("brand_name", body.name.strip(), c.user_id)
        _changed(c.user_id, "brand_name", r.value, body.name.strip())
    if body.public_url is not None:
        if state.env().public_url:
            raise invalid("public_url", "Set by PUBLIC_URL in your environment.")
        url = body.public_url.strip().rstrip("/")
        if not re.match(r"^https://[^/\s]+$|^http://(localhost|127\.0\.0\.1)(:\d+)?$", url):
            raise invalid("public_url", "Use an https:// address with no path.")
        old = state.public_url()
        state.save("detected_url", url, c.user_id)
        _changed(c.user_id, "public_url", old, url)
    return Response(status_code=204)


SVG_ALLOWED = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "lineargradient",
               "radialgradient", "stop", "title", "desc", "clippath", "mask", "use", "symbol"}


def sanitize_svg(data: bytes) -> bytes:
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise invalid("logo", "SVG files can’t contain a DOCTYPE.")
    try:
        root = ET.fromstring(data)  # noqa: S314 (DOCTYPE and entities rejected above; expat never fetches external entities)
    except ET.ParseError:
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
    data = await read_body(request, 256 * 1024)
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
    return Response(status_code=204)


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


# ------------------------------------------------------------------ notifications
def _webhook_list() -> list[dict[str, Any]]:
    return [{"id": w["id"], "url": w["url"], "events": w["events"].split(","), "created_at": iso(w["created_at"]),
             "last_status": w["last_status"], "last_error": w["last_error"], "last_attempt_at": iso(w["last_attempt_at"]),
             "pending": db.val("SELECT count(*) FROM webhook_deliveries WHERE webhook_id = ? AND done = 0", w["id"])}
            for w in db.all("SELECT * FROM webhooks ORDER BY created_at")]


@router.get("/server/notifications")
def notifications(request: Request) -> dict[str, Any]:
    require_owner(request)
    e = state.env()
    u = urlparse(e.smtp_url or "")
    return {
        "smtp": {"enabled": e.smtp_enabled, "host": u.hostname, "port": u.port, "from": e.smtp_from,
                 "tls": {"smtps": "implicit", "smtp+starttls": "starttls"}.get(u.scheme, "none") if e.smtp_url else None},
        "webhooks": _webhook_list(),
        "event_types": sorted(webhooks.LABELS),
    }


@router.get("/server/webhooks")
def list_webhooks(request: Request) -> dict[str, Any]:
    require_owner(request)
    return {"items": _webhook_list()}


class TestEmail(Body):
    to: str | None = None


@router.post("/server/notifications/test-email", status_code=204)
def test_email(body: TestEmail, request: Request) -> Response:
    c = require_owner(request)
    if not state.env().smtp_enabled:
        raise invalid("smtp", "Set SMTP_URL first.")
    assert c.user is not None
    mailer.test(body.to or c.user["email"])
    return Response(status_code=204)


class WebhookBody(Body):
    url: str = Field(max_length=2000)
    events: list[str] = Field(default_factory=lambda: ["*"])


@router.post("/server/webhooks", status_code=201)
def add_webhook(body: WebhookBody, request: Request) -> dict[str, Any]:
    c = require_owner(request)
    u = urlparse(body.url)
    if not u.hostname or not (u.scheme == "https" or (u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1"))):
        raise invalid("url", "Use an https:// address.")
    evs = ["*"] if "*" in body.events or not body.events else [x for x in body.events if x in webhooks.LABELS]
    if not evs:
        raise invalid("events", "Pick at least one event.")
    secret, secret_ct = webhooks.new_secret()
    wid = new_id(12)
    db.run("INSERT INTO webhooks(id, url, events, secret_ct, created_at) VALUES (?,?,?,?,?)", wid, body.url, ",".join(evs), secret_ct, now())
    emit("setting.changed", actor="user", user_id=c.user_id, detail={"key": "webhook", "from": None, "to": urlparse(body.url).hostname})
    return {"id": wid, "signing_secret": secret}


@router.delete("/server/webhooks/{webhook_id}", status_code=204)
def delete_webhook(webhook_id: str, request: Request) -> Response:
    c = require_owner(request)
    w = db.one("SELECT url FROM webhooks WHERE id = ?", webhook_id)
    if w is None:
        raise NotFound()
    db.run("DELETE FROM webhooks WHERE id = ?", webhook_id)
    emit("setting.changed", actor="user", user_id=c.user_id, detail={"key": "webhook", "from": urlparse(w["url"]).hostname, "to": None})
    return Response(status_code=204)


# ------------------------------------------------------------------ tokens (all)
def token_json(t: Any) -> dict[str, Any]:
    return {"id": t["id"], "name": t["name"], "scopes": t["scopes"].split(","), "created_at": iso(t["created_at"]),
            "expires_at": iso(t["expires_at"]), "last_used_at": iso(t["last_used_at"]), "hint": f"cx_live_…{t['hint']}",
            "owner": {"id": t["user_id"], "email": t["email"], "name": t["uname"]}}


@router.get("/server/tokens")
def all_tokens(request: Request) -> dict[str, Any]:
    require_owner(request)
    rows = db.all("SELECT t.*, u.email, u.name AS uname FROM api_tokens t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC")
    return {"items": [token_json(t) for t in rows]}


# ------------------------------------------------------------------ audit
def audit_rows(type_: str | None = None, q: str | None = None, from_: str | None = None, to: str | None = None,
               cursor: str | None = None, limit: int = 50) -> dict[str, Any]:
    where, args = ["e.type NOT IN ('secret.sealed')"], []
    if type_:
        where.append("(e.type = ? OR e.type LIKE ?)")
        args += [type_, type_.rstrip(".*") + ".%"]
    if q:
        where.append("(u.email LIKE ? OR e.secret_id = ? OR e.request_id = ?)")
        args += [f"%{q.strip()}%", q.strip(), q.strip()]
    if from_:
        where.append("e.at >= ?")
        args.append(from_iso(from_))
    if to:
        where.append("e.at <= ?")
        args.append(from_iso(to))
    if cursor and cursor.isdigit():
        where.append("e.id < ?")
        args.append(int(cursor))
    rows = db.all(f"SELECT e.*, u.email FROM events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE {' AND '.join(where)} "
                  f"ORDER BY e.id DESC LIMIT ?", *args, limit + 1)
    out = [{"id": r["id"], "type": r["type"], "at": iso(r["at"]), "detail": json.loads(r["detail"]), "actor": r["actor"],
            "actor_email": r["email"], "item": r["secret_id"] or r["request_id"],
            "item_kind": "secret" if r["secret_id"] else "request" if r["request_id"] else None} for r in rows[:limit]]
    return {"items": out, "next": str(rows[limit - 1]["id"]) if len(rows) > limit else None}


@router.get("/server/audit")
def audit(request: Request, type: str | None = None, q: str | None = None, cursor: str | None = None,  # noqa: A002
          to: str | None = None) -> dict[str, Any]:
    require_owner(request)
    try:
        return audit_rows(type, q, request.query_params.get("from"), to, cursor)
    except ValueError:
        raise invalid("from", "Use an ISO 8601 date.") from None


@router.get("/server/audit.csv")
def audit_csv(request: Request, type: str | None = None, q: str | None = None) -> StreamingResponse:  # noqa: A002
    require_owner(request)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "time", "type", "actor", "actor_email", "item", "detail"])
    cursor = None
    while True:
        page = audit_rows(type, q, request.query_params.get("from"), request.query_params.get("to"), cursor, limit=500)
        for r in page["items"]:
            w.writerow([r["id"], r["at"], r["type"], r["actor"], r["actor_email"] or "", r["item"] or "",
                        json.dumps(r["detail"], separators=(",", ":"))])
        cursor = page["next"]
        if not cursor:
            break
    data = buf.getvalue()
    return StreamingResponse(iter([data]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="cryptex-audit-{iso(now())[:10]}.csv"'})
