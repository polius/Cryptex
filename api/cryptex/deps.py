"""Who is calling: client IP, session or API token, and capability tokens.

Sessions use the `cx_session` cookie plus an `X-CSRF` header on unsafe methods.
API tokens use `Authorization: Bearer cx_live_…`. Capability tokens use their own
scheme name (`Reveal`, `Upload`, `Manage`, `Answer`, `Read`).
"""
from __future__ import annotations

import hmac
import sqlite3
from dataclasses import dataclass, field

from fastapi import Request

from . import db, ratelimit, state
from .errors import ApiError, NotFound
from .util import now, sha256_hex, token_hash

SESSION_COOKIE = "cx_session"
SESSION_TTL = 14 * 86400
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


@dataclass
class Caller:
    ip: str
    user: sqlite3.Row | None = None
    via: str | None = None              # "session" | "token" | None
    session_hash: str | None = None
    reauth_until: int | None = None
    scopes: set[str] = field(default_factory=set)
    token_id: str | None = None

    @property
    def subject(self) -> str:
        return ratelimit.subject(self.ip)

    @property
    def user_id(self) -> str | None:
        return self.user["id"] if self.user else None

    @property
    def is_owner(self) -> bool:
        return bool(self.user and self.via == "session" and self.user["role"] == "owner")

    @property
    def actor(self) -> str:
        return {"session": "user", "token": "token"}.get(self.via or "", "link")

    def can(self, scope: str) -> bool:
        return self.via == "session" or (self.via == "token" and scope in self.scopes)


def caller(request: Request) -> Caller:
    c: Caller | None = getattr(request.state, "caller", None)
    if c is not None:
        return c
    c = Caller(ip=ratelimit.client_ip(request))
    auth = request.headers.get("authorization", "")
    if auth[:7].lower() == "bearer ":
        raw = auth[7:].strip()
        row = db.one(
            "SELECT t.id AS token_id, t.scopes, t.expires_at, u.* FROM api_tokens t JOIN users u ON u.id = t.user_id "
            "WHERE t.token_hash = ?", sha256_hex(raw),
        )
        if row is None or (row["expires_at"] and row["expires_at"] < now()):
            raise ApiError("sign_in_required", "That API token isn’t valid.")
        db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now(), row["token_id"])
        c.user, c.via, c.token_id = row, "token", row["token_id"]
        c.scopes = set(row["scopes"].split(","))
    else:
        cookie = request.cookies.get(SESSION_COOKIE)
        h = token_hash(cookie) if cookie else None
        if h:
            s = db.one("SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?", h, now())
            if s is not None:
                if request.method in UNSAFE and not hmac.compare_digest(request.headers.get("x-csrf", ""), s["csrf"]):
                    raise ApiError("forbidden", "Missing or wrong CSRF token. Reload the page and try again.")
                user = db.one("SELECT * FROM users WHERE id = ?", s["user_id"])
                if user is not None:
                    c.user, c.via, c.session_hash, c.reauth_until = user, "session", h, s["reauth_until"]
                    if s["expires_at"] - now() < SESSION_TTL - 3600:  # slide at most once an hour
                        db.run("UPDATE sessions SET expires_at = ? WHERE id_hash = ?", now() + SESSION_TTL, h)
                        db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", now(), user["id"])
    request.state.caller = c
    return c


def capability(request: Request, scheme: str) -> str | None:
    """The token after `Authorization: <scheme> `, or None."""
    auth = request.headers.get("authorization", "")
    if auth[: len(scheme) + 1].lower() == scheme.lower() + " ":
        return auth[len(scheme) + 1:].strip()
    return None


def cap_hash(request: Request, scheme: str) -> str | None:
    t = capability(request, scheme)
    return token_hash(t) if t else None


def matches(stored: str | None, presented: str | None) -> bool:
    return bool(stored and presented and hmac.compare_digest(stored, presented))


def deny(c: Caller, presented: bool = True) -> NotFound:
    """The uniform 404. A wrong token counts toward the failed-token block."""
    if presented:
        ratelimit.failed_token(c.ip)
    return NotFound()


def require_user(request: Request) -> Caller:
    c = caller(request)
    if c.user is None:
        raise ApiError("sign_in_required")
    return c


def require_session(request: Request) -> Caller:
    """Signed-in browser session; API tokens can't call /auth/*, /me/* or /server/*."""
    c = caller(request)
    if c.via != "session":
        if c.via == "token":
            raise NotFound()
        raise ApiError("sign_in_required")
    return c


def require_owner(request: Request) -> Caller:
    if state.env().demo:
        raise NotFound()
    c = caller(request)
    if not c.is_owner:
        raise NotFound()  # members and tokens get the 404 page; the Server tab doesn't exist for them
    return c


def require_reauth(c: Caller) -> None:
    if not c.reauth_until or c.reauth_until < now():
        raise ApiError("reauth_required")
