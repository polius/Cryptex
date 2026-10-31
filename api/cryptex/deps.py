"""Who is calling: client IP, session, and capability tokens.

Sessions use the `cx_session` cookie plus an `X-CSRF` header on unsafe methods.
Capability tokens use their own scheme name (`Reveal`, `Upload`, `Manage`, `Read`, `Answer`); a request that carries one is
judged by it alone, whatever cookie the browser also sends.
A browser that believes it is signed in says as whom (`X-Cryptex-User`), so a session that ended meanwhile is a 401,
never a request quietly served as a visitor.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from fastapi import Request

from . import db, ratelimit, state
from .errors import ApiError, NotFound
from .util import now, same, token_hash

SESSION_COOKIE = "cx_session"
SESSION_TTL = 14 * 86400     # idle: each use slides it (at most once an hour)
SESSION_MAX = 30 * 86400     # absolute: sliding never goes past created_at + this
SHARED_TTL = 12 * 3600       # "This is a shared computer": fixed, never slides, and a browser-session cookie
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
CAPABILITIES = {"reveal", "upload", "manage", "read", "answer"}


@dataclass
class Caller:
    ip: str
    user: sqlite3.Row | None = None
    via: str | None = None              # "session" | None
    session_hash: str | None = None
    reauth_until: int | None = None
    shared: bool = False                # a shared-computer session

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
        return "user" if self.via == "session" else "link"


def signed_in_here(request: Request) -> bool:
    """Whether this browser is signed in on this server, for requests a link's token speaks for (caller() leaves the
    session out of those). Reads only: it gives no permission and changes nothing."""
    cookie = request.cookies.get(SESSION_COOKIE)
    h = token_hash(cookie) if cookie else None
    return h is not None and db.val("SELECT 1 FROM sessions WHERE id_hash = ? AND expires_at > ?", h, now()) is not None


def caller(request: Request) -> Caller:
    c: Caller | None = getattr(request.state, "caller", None)
    if c is not None:
        return c
    c = Caller(ip=ratelimit.client_ip(request))
    if request.headers.get("authorization", "").split(" ", 1)[0].lower() in CAPABILITIES:
        # A link's token speaks for itself: no session, so no CSRF check that a tab opened before a sign-in elsewhere
        # in the browser can't pass, and no X-Cryptex-User.
        request.state.caller = c
        return c
    cookie = request.cookies.get(SESSION_COOKIE)
    h = token_hash(cookie) if cookie else None
    s = db.one("SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?", h, now()) if h else None
    user = db.one("SELECT * FROM users WHERE id = ?", s["user_id"]) if s is not None else None
    claimed = request.headers.get("x-cryptex-user")
    if claimed and claimed != (user["id"] if user is not None else None):
        # The browser thinks it is signed in as `claimed`, but that session ended (signed out elsewhere, a password
        # change, a removal, a shared session's 12 hours) or is someone else's now. Checked before CSRF: a tab of
        # the old account holds the old CSRF token, and "you were signed out" is what it needs to hear.
        raise ApiError("sign_in_required", "You were signed out. Sign in again.", reason="ended")
    if s is not None:
        if request.method in UNSAFE and not same(request.headers.get("x-csrf"), s["csrf"]):
            raise ApiError("forbidden", "Missing or wrong CSRF token. Reload the page and try again.", reason="csrf")
        if user is not None:
            c.user, c.via, c.session_hash, c.reauth_until = user, "session", h, s["reauth_until"]
            c.shared = bool(s["shared"])
            slid = min(now() + SESSION_TTL, s["created_at"] + SESSION_MAX)
            if not c.shared and slid - s["expires_at"] >= 3600:  # slide at most once an hour
                db.run("UPDATE sessions SET expires_at = ? WHERE id_hash = ?", slid, h)
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
    return bool(stored and presented and same(stored, presented))


def deny(c: Caller, presented: bool = True) -> NotFound:
    """The uniform 404. A wrong token counts toward the failed-token block."""
    if presented:
        ratelimit.failed_token(c.ip)
    return NotFound()


def require_session(request: Request) -> Caller:
    """Signed-in browser session."""
    c = caller(request)
    if c.via != "session":
        raise ApiError("sign_in_required")
    return c


def require_owner(request: Request) -> Caller:
    if state.env().demo:
        raise NotFound()
    c = caller(request)
    if not c.is_owner:
        raise NotFound()  # members get the 404 page; the Server tab doesn't exist for them
    return c


def require_reauth(c: Caller) -> None:
    if not c.reauth_until or c.reauth_until < now():
        raise ApiError("reauth_required")
