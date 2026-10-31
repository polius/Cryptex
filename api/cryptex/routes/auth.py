"""Sign-in: password, then TOTP for those with 2FA; temporary passwords, invite links, re-auth, own password and 2FA.

The password itself never reaches the server: browsers send an auth key derived from it (see account.py)."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
from types import TracebackType
from typing import Annotated, Any

import pyotp
from fastapi import APIRouter, BackgroundTasks, Request, Response
from pydantic import AfterValidator, Field

from .. import account, db, ratelimit, security, state
from ..account import B64_32, Credentials, clear_vault, fake_salt, forget_sign_ins, kdf_of, set_credentials, vault_bundle
from ..config import Rate
from ..deps import SESSION_COOKIE, SESSION_MAX, SESSION_TTL, SHARED_TTL, Caller, caller, require_reauth, require_session
from ..errors import ApiError, invalid
from ..events import emit
from ..util import b64u, iso, new_token, now, token_hash
from .common import Body
from .config import user_json

router = APIRouter()
MFA_TTL = 300
RESET_TTL = 900  # to choose a new password after signing in with a temporary one
REAUTH_TTL = 300
INVITE_TTL = 7 * 86400
TICKET_TRIES = 5  # 2FA codes per sign-in ticket
SIGN_IN_FAILS = Rate(30, 3600)  # wrong passwords and 2FA codes per account (sign-in, re-auth, unlock, password change), whatever the IP


# ------------------------------------------------------------------ limits
class Attempt:
    """One sign-in request (or re-auth, unlock, password change, sign-in link). Takes one unit of each failure limit it
    can fail (RATE_AUTH per IP, and SIGN_IN_FAILS per account for passwords and 2FA codes) before any work, so parallel
    requests can't all slip under a limit. Units are given back when the request leaves without being a wrong guess
    (wrong()): a success, an expired ticket, a link already used, a bad request.

        with Attempt(c) as a:
            account_limit(a, username)
            if not ok:
                raise a.wrong(ApiError("wrong_password"))
    """

    def __init__(self, c: Caller) -> None:
        self.held = [ratelimit.reserve("auth", state.env().rate_auth, c.subject)]
        self.guessed_wrong = False

    def reserve(self, name: str, rate: Rate, key: str) -> ratelimit.Held:
        h = ratelimit.reserve(name, rate, key)
        self.held.append(h)
        return h

    def passed(self, h: ratelimit.Held) -> None:
        """One part of the attempt was right (the password, before its 2FA code): its unit goes back now, whatever
        comes next."""
        self.held.remove(h)
        ratelimit.refund(h)

    def wrong(self, err: ApiError) -> ApiError:
        """A wrong password, 2FA code, reset code or setup code: the units stay taken."""
        self.guessed_wrong = True
        return err

    def __enter__(self) -> Attempt:
        return self

    def __exit__(self, kind: type[BaseException] | None, err: BaseException | None, tb: TracebackType | None) -> None:
        if not self.guessed_wrong:
            for h in self.held:
                ratelimit.refund(h)


def account_limit(a: Attempt, username: str) -> ratelimit.Held:
    """One unit of the account's SIGN_IN_FAILS, by username (so unknown names answer the same)."""
    return a.reserve("sign_in", SIGN_IN_FAILS, f"user:{username}")


def check_totp(a: Attempt, u: sqlite3.Row, code: str) -> None:
    """The account's current 2FA code (sign-in and re-auth). Past the account's SIGN_IN_FAILS, from anywhere: 429
    without looking at the code. The step is stored only if still newer than the stored one, so two requests racing
    with one code can't both pass."""
    account_limit(a, u["username"])
    step = security.verify_totp(security.unseal("totp", u["totp_ct"]).decode(), code.strip(), u["totp_last_step"])
    if step is None or db.run("UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)",
                              step, u["id"], step).rowcount != 1:
        emit("user.sign_in_failed", actor="system", detail={"method": "totp"})
        raise a.wrong(ApiError("wrong_code", "That code didn’t work.", status=401))


def expired_sign_in() -> ApiError:
    return ApiError("sign_in_required", "That sign-in expired. Start again.", status=401, reason="expired")


def safe_return_to(v: str | None) -> str:
    """Same-origin path only: blocks //evil, /\\evil and scheme tricks (audit finding S14)."""
    if not v or not v.startswith("/") or v.startswith("//") or "\\" in v or re.search(r"[\x00-\x1f]", v):
        return "/"
    return v


def is_https(request: Request) -> bool:
    """Secure cookies everywhere but plain http on this computer: the web app only runs on https:// or localhost, so
    this holds even when the proxy doesn't say the request came over HTTPS."""
    return request.url.scheme == "https" or request.url.hostname not in ("localhost", "127.0.0.1", "::1")


def start_session(user_id: str, request: Request, response: Response, *, shared: bool = False, reauth: bool = True) -> str:
    """A new session. Every sign-in starts a re-auth window. A shared-computer session lasts 12 hours, never slides,
    and its cookie goes when the browser closes; others last 14 days from their last use, 30 at most (deps.caller).

    The session this browser had until now ends here (another account's, or an older one of the same): one browser,
    one session. That account's sessions elsewhere stay."""
    old = request.cookies.get(SESSION_COOKIE)
    if old and (old_hash := token_hash(old)):
        db.run("DELETE FROM sessions WHERE id_hash = ?", old_hash)
    token, h = new_token()
    csrf = secrets.token_urlsafe(24)
    t = now()
    db.run("INSERT INTO sessions(id_hash, user_id, csrf, created_at, expires_at, reauth_until, shared) VALUES (?,?,?,?,?,?,?)",
           h, user_id, csrf, t, t + (SHARED_TTL if shared else SESSION_TTL), t + REAUTH_TTL if reauth else None, int(shared))
    db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", t, user_id)
    response.set_cookie(SESSION_COOKIE, token, max_age=None if shared else SESSION_MAX, httponly=True,
                        secure=is_https(request), samesite="lax", path="/")
    return csrf


def session_json(u: sqlite3.Row, csrf: str, shared: bool) -> dict[str, Any]:
    """Every sign-in response: the person, the CSRF token, the vault bundle (the password was just checked)."""
    return {"user": user_json(u), "csrf": csrf, "vault": vault_bundle(u), "shared": shared}


@router.get("/auth/session")
def session(request: Request) -> dict[str, Any]:
    c = caller(request)
    if c.via != "session":
        return {"user": None, "csrf": None, "shared": False}
    return {"user": user_json(c.user), "csrf": db.val("SELECT csrf FROM sessions WHERE id_hash = ?", c.session_hash),
            "shared": c.shared}


class PreLogin(Body):
    username: str = Field(max_length=64)


@router.post("/auth/prelogin")
def prelogin(body: PreLogin) -> dict[str, Any]:
    """The salt and Argon2id settings to derive the auth key with. Unknown usernames get a stable fake salt.
    Cheap (no Argon2id here), so not rate-limited."""
    if state.env().demo:
        raise ApiError("demo_locked")
    username = body.username.strip().lower()
    u = db.one("SELECT kdf_salt, kdf FROM users WHERE username = ?", username)
    if u is not None and u["kdf_salt"] is not None:
        return {"salt": b64u(u["kdf_salt"]), "kdf": kdf_of(u)}
    return {"salt": b64u(fake_salt(username)), "kdf": dict(account.KDF)}


class Login(Body):
    username: str = Field(max_length=64)
    auth_key: str = Field(pattern=B64_32)
    shared: bool = False  # "This is a shared computer"


@router.post("/auth/login")
def login(body: Login, request: Request, response: Response) -> dict[str, Any]:
    c = caller(request)
    if state.env().demo:
        raise ApiError("demo_locked")
    username = body.username.strip().lower()
    with Attempt(c) as a:
        account_limit(a, username)
        u = db.one("SELECT * FROM users WHERE username = ?", username)
        ok = security.verify_password(u["password_hash"] if u else None, body.auth_key)
        temp = u is not None and not ok and account.temp_password_matches(u, body.auth_key)
        if u is None or not (ok or temp):
            emit("user.sign_in_failed", actor="system", detail={"method": "password"})
            raise a.wrong(ApiError("wrong_password", "That username and password don’t match."))
    if ok and u["temp_expires_at"] is not None:  # they remembered: a temporary one waiting is only a risk
        with db.tx() as conn:
            conn.execute("UPDATE users SET temp_key_hash = NULL, temp_expires_at = NULL WHERE id = ?", (u["id"],))
            conn.execute("DELETE FROM mfa_tickets WHERE user_id = ? AND kind = 'reset'", (u["id"],))
        state.forget_temp_password(u["username"])
    if temp:  # whoever runs the server vouched for this person: no 2FA code (it may be what they lost)
        return {"reset_ticket": new_ticket(u["id"], "reset", body.shared)}
    if u["totp_ct"] is not None:  # 2FA is optional: without it, the password is enough
        return {"mfa_ticket": new_ticket(u["id"], "mfa", body.shared)}
    return signed_in(u, request, response, body.shared)


def new_ticket(user_id: str, kind: str, shared: bool) -> str:
    """mfa: the 2FA code is next. reset: a new password is next (after a temporary one). The session they lead to
    inherits `shared` from the sign-in form."""
    ticket, h = new_token()
    db.run("INSERT INTO mfa_tickets(ticket_hash, user_id, kind, shared, expires_at) VALUES (?,?,?,?,?)",
           h, user_id, kind, int(shared), now() + (RESET_TTL if kind == "reset" else MFA_TTL))
    return ticket


class Totp(Body):
    mfa_ticket: str = Field(max_length=128)
    code: str = Field(max_length=16)


@router.post("/auth/login/totp")
def login_totp(body: Totp, request: Request, response: Response) -> dict[str, Any]:
    c = caller(request)
    with Attempt(c) as a:  # a ticket checks 5 codes at most; wrong ones count toward RATE_AUTH and SIGN_IN_FAILS
        h = token_hash(body.mfa_ticket)
        # One try used up in the same statement that checks there is one left, so parallel guesses can't share a try.
        t = db.one("UPDATE mfa_tickets SET tries = tries + 1 WHERE ticket_hash = ? AND kind = 'mfa' AND expires_at > ? "
                   "AND tries < ? RETURNING *", h, now(), TICKET_TRIES) if h else None
        u = db.one("SELECT * FROM users WHERE id = ?", t["user_id"]) if t else None
        if t is None or u is None or u["totp_ct"] is None:  # expired, used up, or 2FA was turned off since: not a guess
            if t is not None:
                db.run("DELETE FROM mfa_tickets WHERE ticket_hash = ?", h)
            raise expired_sign_in()
        try:
            check_totp(a, u, body.code)
        except ApiError as err:
            if t["tries"] >= TICKET_TRIES:
                db.run("DELETE FROM mfa_tickets WHERE ticket_hash = ?", h)
            if err.code == "wrong_code":
                err.extra["tries_left"] = TICKET_TRIES - t["tries"]  # 0: this ticket is done, start again
            raise
        db.run("DELETE FROM mfa_tickets WHERE ticket_hash = ?", h)
        return signed_in(u, request, response, bool(t["shared"]))


def signed_in(u: sqlite3.Row, request: Request, response: Response, shared: bool) -> dict[str, Any]:
    csrf = start_session(u["id"], request, response, shared=shared)
    emit("user.signed_in", actor="user", user_id=u["id"])
    return session_json(u, csrf, shared)


class Forgot(Body):
    username: str = Field(max_length=64)


@router.post("/auth/forgot")
def forgot_password(body: Forgot, background: BackgroundTasks) -> dict[str, Any]:
    """"Forgot your password?": a temporary password in DATA_DIR/temp-passwords, for whoever runs the server to
    read and pass on (account.issue_temp_password). Changes nothing else: the current password keeps working until
    the temporary one is used, and one already waiting isn't replaced. The answer, and how long it takes, is the
    same whether or not the account exists."""
    if state.env().demo:
        raise ApiError("demo_locked")
    username = body.username.strip().lower()
    u = db.one("SELECT id FROM users WHERE username = ? AND password_hash IS NOT NULL", username)
    if u is not None and re.fullmatch(account.USERNAME, username):
        background.add_task(account.issue_temp_password, u["id"])
    return {"command": state.cli_command("temp-password", username) if re.fullmatch(account.USERNAME, username) else None,
            "hours": state.TEMP_TTL // 3600}


class NewPassword(Credentials):
    reset_ticket: str = Field(max_length=128)
    shared: bool = False


@router.post("/auth/password/reset")
def reset_password(body: NewPassword, request: Request, response: Response) -> dict[str, Any]:
    """After a temporary password: the new password replaces both, and 2FA is turned off (a lost authenticator is a
    common reason to be here; it can be turned on again). The vault goes, as after an owner reset."""
    c = caller(request)
    with Attempt(c):  # nothing here can be guessed (the ticket is 256 bits): only the limits' check before work
        h = token_hash(body.reset_ticket)
        t = db.one("DELETE FROM mfa_tickets WHERE ticket_hash = ? AND kind = 'reset' AND expires_at > ? RETURNING *", h, now()) if h else None
        u = db.one("SELECT * FROM users WHERE id = ?", t["user_id"]) if t else None
    if t is None or u is None or u["password_hash"] is None:  # expired, used, or locked by an owner since
        raise expired_sign_in()
    with db.tx() as conn:
        set_credentials(conn, u["id"], body)
        clear_vault(conn, u["id"])
        conn.execute("UPDATE users SET totp_ct = NULL, totp_last_step = NULL WHERE id = ?", (u["id"],))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (u["id"],))
        emit("user.password_reset", actor="user", user_id=u["id"], detail={"via": "temp", "totp_off": u["totp_ct"] is not None}, c=conn)
    return signed_in(fresh_user(u["id"]), request, response, body.shared or bool(t["shared"]))


def fresh_user(user_id: str) -> sqlite3.Row:
    u = db.one("SELECT * FROM users WHERE id = ?", user_id)
    if u is None:  # removed in the meantime
        raise expired_sign_in()
    return u


def check_password(c: Caller, auth_key: str, field: str | None = None, message: str = "That password didn’t work.",
                   a: Attempt | None = None) -> None:
    """The signed-in person's own password, again (re-auth, vault unlock, password change). A wrong one counts toward
    RATE_AUTH and the account's SIGN_IN_FAILS. `a`: part of a larger attempt (re-auth also checks the 2FA code)."""
    assert c.user is not None
    if a is None:
        with Attempt(c) as own:
            return check_password(c, auth_key, field, message, own)
    held = account_limit(a, c.user["username"])
    if not security.verify_password(c.user["password_hash"], auth_key):
        emit("user.sign_in_failed", actor="system", detail={"method": "password"})
        raise a.wrong(ApiError("wrong_password", message, field=field))
    a.passed(held)  # a wrong 2FA code after it isn't a wrong password (audit N4)


class Reauth(Body):
    auth_key: str = Field(pattern=B64_32)
    code: str = Field(default="", max_length=16)  # only for people with 2FA


@router.post("/auth/reauth", status_code=204)
def reauth(body: Reauth, request: Request) -> Response:
    c = require_session(request)
    assert c.user is not None
    with Attempt(c) as a:
        check_password(c, body.auth_key, a=a)
        if c.user["totp_ct"] is not None:
            check_totp(a, c.user, body.code)
    db.run("UPDATE sessions SET reauth_until = ? WHERE id_hash = ?", now() + REAUTH_TTL, c.session_hash)
    return Response(status_code=204)


DEVICE_ID = r"^[A-Za-z0-9_-]{16,64}$"


class LogoutBody(Body):
    device_id: str | None = Field(default=None, pattern=DEVICE_ID)  # this browser: its device key goes too


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response, body: LogoutBody | None = None) -> Response:
    c = caller(request)
    if c.session_hash:
        with db.tx() as conn:
            conn.execute("DELETE FROM sessions WHERE id_hash = ?", (c.session_hash,))
            if body and body.device_id and c.user_id:
                conn.execute("DELETE FROM device_keys WHERE user_id = ? AND device_id = ?", (c.user_id, body.device_id))
    r = Response(status_code=204)
    r.delete_cookie(SESSION_COOKIE, path="/")
    return r


# ------------------------------------------------------------------ device keys (what a signed-in browser keeps, locked to the account)
MAX_DEVICES = 50  # per person; the least recently used key goes first


class DeviceKeyBody(Body):
    device_id: str = Field(pattern=DEVICE_ID)


@router.post("/me/device-key")
def device_key(body: DeviceKeyBody, request: Request) -> dict[str, Any]:
    """The key for this browser's saved links. Only a signed-in session gets it; signing out ends that. A shared
    computer keeps no copy of the vault, so its session gets no key to lock one with."""
    c = require_session(request)
    if c.shared:
        raise ApiError("forbidden", "This is a shared computer: nothing is kept on it.", reason="shared")
    label = f"device-key|{c.user_id}|{body.device_id}"
    with db.tx() as conn:
        row = conn.execute("SELECT key_ct FROM device_keys WHERE user_id = ? AND device_id = ?", (c.user_id, body.device_id)).fetchone()
        if row:
            key = security.unseal(label, row["key_ct"])
            conn.execute("UPDATE device_keys SET last_used_at = ? WHERE user_id = ? AND device_id = ?", (now(), c.user_id, body.device_id))
        else:
            key = secrets.token_bytes(32)
            conn.execute("INSERT INTO device_keys(user_id, device_id, key_ct, created_at, last_used_at) VALUES (?,?,?,?,?)",
                         (c.user_id, body.device_id, security.seal(label, key), now(), now()))
            conn.execute("DELETE FROM device_keys WHERE user_id = ? AND device_id NOT IN "
                         "(SELECT device_id FROM device_keys WHERE user_id = ? ORDER BY last_used_at DESC LIMIT ?)",
                         (c.user_id, c.user_id, MAX_DEVICES))
    return {"key": b64u(key)}


# ------------------------------------------------------------------ own 2FA (optional: turn it on, move it to a new app, or turn it off)
def totp_setup(username: str) -> dict[str, str]:
    secret = pyotp.random_base32()
    brand = state.setting("brand_name")  # "Acme Cryptex" in the app's list, or just "Cryptex" before a name is set
    return {"secret": secret, "uri": pyotp.TOTP(secret).provisioning_uri(username, issuer_name=f"{brand} Cryptex" if brand else "Cryptex")}


def _base32_secret(v: str) -> str:
    """An authenticator secret as totp_setup makes them (32 characters): 16 to 64 base32 characters, 80 to 320 bits,
    of a length base32 can encode. Empty is left to the field: it means no 2FA where 2FA is optional."""
    if v and not (re.fullmatch(r"[A-Z2-7]{16,64}", v) and len(v) % 8 in (0, 2, 4, 5, 7)):
        raise ValueError("an authenticator secret is 16 to 64 base32 characters")
    return v


TotpSecret = Annotated[str, Field(min_length=16, max_length=64), AfterValidator(_base32_secret)]
OptionalTotpSecret = Annotated[str, Field(max_length=64), AfterValidator(_base32_secret)]  # empty: no 2FA


def new_totp(secret: str, code: str) -> tuple[bytes | None, int | None]:
    """An optional new authenticator: (sealed secret, its time step), or (None, None) when the person skipped 2FA."""
    if not secret:
        return None, None
    return security.seal("totp", secret.encode()), check_new_totp(secret, code)


def check_new_totp(secret: str, code: str) -> int:
    """Verify the first code from a new authenticator; returns its time step."""
    try:
        step = security.verify_totp(secret, code.strip(), None)
    except Exception:  # not base32
        step = None
    if step is None:
        raise invalid("totp_code", "That code didn’t work. Check the time on your phone.")
    return step


@router.post("/me/totp")
def totp_begin(request: Request) -> dict[str, Any]:
    """A new secret to scan. Needs re-auth like the change it starts, so a session left open can't begin one."""
    c = require_session(request)
    require_reauth(c)
    assert c.user is not None
    return totp_setup(c.user["username"])


class TotpEnable(Body):
    secret: TotpSecret
    code: str


@router.put("/me/totp", status_code=204)
def totp_enable(body: TotpEnable, request: Request) -> Response:
    """Turn 2FA on. To use a new app, turn it off and on again: there's one way to change it."""
    c = require_session(request)
    require_reauth(c)
    step = check_new_totp(body.secret, body.code)
    with db.tx() as conn:
        if conn.execute("UPDATE users SET totp_ct = ?, totp_last_step = ? WHERE id = ? AND totp_ct IS NULL",
                        (security.seal("totp", body.secret.encode()), step, c.user_id)).rowcount != 1:
            raise ApiError("forbidden", "2FA is already on. Turn it off first.", status=409, reason="totp_on")
        emit("user.totp_on", actor="user", user_id=c.user_id, c=conn)
    return Response(status_code=204)


@router.delete("/me/notice", status_code=204)
def dismiss_notice(request: Request) -> Response:
    """"I asked for it": the reset-link notice goes away."""
    c = require_session(request)
    db.run("UPDATE users SET reset_notice = NULL WHERE id = ?", c.user_id)
    return Response(status_code=204)


@router.delete("/me/reset-link", status_code=204)
def cancel_reset_link(request: Request) -> Response:
    """"I didn't ask for it": the reset link an owner made for this account stops working."""
    c = require_session(request)
    with db.tx() as conn:
        gone_ = conn.execute("DELETE FROM reset_links WHERE user_id = ?", (c.user_id,)).rowcount
        conn.execute("UPDATE users SET reset_notice = NULL WHERE id = ?", (c.user_id,))
        if gone_:
            emit("user.reset_cancelled", actor="user", user_id=c.user_id, c=conn)
    return Response(status_code=204)


@router.delete("/me/totp", status_code=204)
def totp_disable(request: Request) -> Response:
    c = require_session(request)
    require_reauth(c)
    with db.tx() as conn:
        if conn.execute("UPDATE users SET totp_ct = NULL, totp_last_step = NULL WHERE id = ? AND totp_ct IS NOT NULL",
                        (c.user_id,)).rowcount:
            emit("user.totp_off", actor="user", user_id=c.user_id, c=conn)
    return Response(status_code=204)


class PasswordChange(Body):
    current_auth_key: str = Field(pattern=B64_32)
    new: Credentials
    vault_pw: str | None = Field(default=None, pattern=account.WRAPPED)  # the vault key, wrapped for the new password


@router.put("/me/password", status_code=204)
def change_password(body: PasswordChange, request: Request) -> Response:
    c = require_session(request)
    check_password(c, body.current_auth_key, field="current", message="That isn’t your current password.")
    assert c.user is not None
    with db.tx() as conn:
        set_credentials(conn, c.user["id"], body.new)
        conn.execute("UPDATE users SET vault_pw = ? WHERE id = ?", (body.vault_pw, c.user_id))
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", (c.user_id, c.session_hash))  # sign out other devices
        emit("user.password_changed", actor="user", user_id=c.user_id, c=conn)
    return Response(status_code=204)


# ------------------------------------------------------------------ invite links
def issue_invite(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """A one-time link to set a password (and, if they want, 2FA). Replaces any earlier invite for this person."""
    token, h = new_token()
    exp = now() + INVITE_TTL
    conn.execute("UPDATE users SET invite_hash = ?, invite_expires_at = ? WHERE id = ?", (h, exp, user_id))
    return {"invite_url": f"/invite#{token}", "expires_at": iso(exp)}  # the browser adds its own address


def _invited(token: str) -> sqlite3.Row:
    """The account an invite link is for. A link that doesn't work isn't a guess (the token is 256 bits): an
    expired or used link, reloaded, mustn't count toward RATE_AUTH."""
    h = token_hash(token)
    u = db.one("SELECT * FROM users WHERE invite_hash = ? AND invite_expires_at > ?", h, now()) if h else None
    if u is None:
        raise ApiError("gone", "This invite link expired or was already used. Ask an owner for a new one.", reason="invite")
    return u


class InviteBody(Body):
    token: str = Field(max_length=128)


@router.post("/auth/invite")
def invite_info(body: InviteBody, request: Request) -> dict[str, Any]:
    """Who the invite is for. Changes nothing; the token goes in the body so it never lands in a URL."""
    with Attempt(caller(request)):
        u = _invited(body.token)
    return {"username": u["username"], "role": u["role"], "reset": u["last_seen_at"] is not None,
            **totp_setup(u["username"])}


class InviteAccept(Credentials):
    token: str = Field(max_length=128)
    totp_secret: OptionalTotpSecret = ""  # empty: no 2FA
    totp_code: str = Field(default="", max_length=16)
    shared: bool = False


@router.post("/auth/invite/accept")
def invite_accept(body: InviteAccept, request: Request, response: Response) -> dict[str, Any]:
    with Attempt(caller(request)):
        u = _invited(body.token)
        totp_ct, step = new_totp(body.totp_secret, body.totp_code)
    with db.tx() as conn:
        # Once: a parallel accept of the same link finds it used.
        if conn.execute("UPDATE users SET invite_hash = NULL, invite_expires_at = NULL WHERE id = ? AND invite_hash = ?",
                        (u["id"], u["invite_hash"])).rowcount != 1:
            raise ApiError("gone", "This invite link expired or was already used. Ask an owner for a new one.", reason="invite")
        set_credentials(conn, u["id"], body)
        clear_vault(conn, u["id"])  # an invite for an existing account is a reset
        conn.execute("UPDATE users SET totp_ct = ?, totp_last_step = ? WHERE id = ?", (totp_ct, step, u["id"]))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (u["id"],))
        emit("user.joined", actor="user", user_id=u["id"], c=conn)
    csrf = start_session(u["id"], request, response, shared=body.shared)
    return session_json(fresh_user(u["id"]), csrf, body.shared)


# ------------------------------------------------------------------ reset links (made by an owner)
RESET_LINK_TTL = 86400
RESET_TRIES = 5
_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32: no I, L, O or U


def _code_hash(code: str) -> str:
    """Case, spaces and dashes don't matter; O, I and L read as 0, 1 and 1. Keyed with ENC_KEY, so a copy of the
    database alone can't be used to try the 2^40 codes offline."""
    s = re.sub(r"[^0-9A-Z]", "", code.upper()).replace("O", "0").replace("I", "1").replace("L", "1")
    return hmac.new(state.env().enc_key, b"cryptex/reset-code|" + s.encode(), hashlib.sha256).hexdigest()


def issue_reset_link(conn: sqlite3.Connection, user_id: str, by: str, lock: bool) -> dict[str, Any]:
    """A one-time link (256-bit token) plus an 8-character code, for 24 hours. Replaces any earlier one. Unless
    `lock`, the current password keeps working until the link is used, and the person sees a notice when they
    next sign in. `lock` (a compromised account): the password stops working and every session ends now."""
    token, h = new_token()
    code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))
    code = f"{code[:4]}-{code[4:]}"
    t = now()
    if lock:
        conn.execute("UPDATE users SET password_hash = NULL, reset_notice = NULL WHERE id = ?", (user_id,))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        forget_sign_ins(conn, user_id)  # a temporary password or a half-done sign-in mustn't outlive the lock
    conn.execute("INSERT OR REPLACE INTO reset_links(user_id, token_hash, code_hash, by_username, created_at, expires_at) "
                 "VALUES (?,?,?,?,?,?)", (user_id, h, _code_hash(code), by, t, t + RESET_LINK_TTL))
    if not lock:
        conn.execute("UPDATE users SET reset_notice = ? WHERE id = ?", (json.dumps({"by": by, "at": t}), user_id))
    return {"reset_url": f"/reset#{token}", "code": code, "expires_at": iso(t + RESET_LINK_TTL)}


def _reset_gone() -> ApiError:
    return ApiError("gone", "This reset link no longer works. Ask an owner for a new one.", reason="reset")


def _reset_link(token: str) -> sqlite3.Row:
    """Like _invited: a link that doesn't work (expired, used, cancelled) isn't a guess. Its code is."""
    h = token_hash(token)
    r = db.one("SELECT r.*, u.username, u.totp_ct FROM reset_links r JOIN users u ON u.id = r.user_id "
               "WHERE r.token_hash = ? AND r.expires_at > ?", h, now()) if h else None
    if r is None:
        raise _reset_gone()
    return r


class ResetBody(Body):
    token: str = Field(max_length=128)


@router.post("/auth/reset")
def reset_info(body: ResetBody, request: Request) -> dict[str, Any]:
    """Who a reset link is for and who made it, plus a fresh authenticator secret. Changes nothing."""
    with Attempt(caller(request)):
        r = _reset_link(body.token)
    return {"username": r["username"], "by": r["by_username"], "expires_at": iso(r["expires_at"]),
            "tries_left": RESET_TRIES - r["tries"], **totp_setup(r["username"])}


class ResetAccept(Credentials):
    token: str = Field(max_length=128)
    code: str = Field(max_length=32)
    totp_secret: OptionalTotpSecret = ""  # empty: no 2FA for now
    totp_code: str = Field(default="", max_length=16)
    shared: bool = False


@router.post("/auth/reset/accept")
def reset_accept(body: ResetAccept, request: Request, response: Response) -> dict[str, Any]:
    """The link and the code: a new password, the old 2FA off (a new one if they set it up), everyone signed out."""
    with Attempt(caller(request)) as a:
        r = _reset_link(body.token)
        uid = r["user_id"]
        # One try used up in the same statement that checks there is one left, so parallel guesses can't share a try.
        tries = db.val("UPDATE reset_links SET tries = tries + 1 WHERE user_id = ? AND token_hash = ? AND tries < ? RETURNING tries",
                       uid, r["token_hash"], RESET_TRIES)
        if tries is None:
            raise _reset_gone()
        if not hmac.compare_digest(_code_hash(body.code), r["code_hash"]):
            emit("user.sign_in_failed", actor="system", detail={"method": "reset_code"})
            if tries >= RESET_TRIES:
                db.run("DELETE FROM reset_links WHERE user_id = ? AND token_hash = ?", uid, r["token_hash"])
                raise a.wrong(ApiError("gone", "Too many wrong codes, so this reset link stopped working. Ask an owner for a new one.",
                                       reason="reset_tries"))
            raise a.wrong(ApiError("wrong_code", "That code didn’t work.", status=400, field="code", tries_left=RESET_TRIES - tries))
        # The right code: the try goes back, so a typo in the NEW authenticator's code (checked next) costs none.
        db.run("UPDATE reset_links SET tries = tries - 1 WHERE user_id = ? AND token_hash = ?", uid, r["token_hash"])
        totp_ct, step = new_totp(body.totp_secret, body.totp_code)
    with db.tx() as conn:
        if conn.execute("DELETE FROM reset_links WHERE user_id = ? AND token_hash = ?", (uid, r["token_hash"])).rowcount != 1:
            raise _reset_gone()  # used by a parallel request
        set_credentials(conn, uid, body)
        clear_vault(conn, uid)
        conn.execute("UPDATE users SET totp_ct = ?, totp_last_step = ?, reset_notice = NULL WHERE id = ?",
                     (totp_ct, step, uid))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
        emit("user.password_reset", actor="user", user_id=uid,
             detail={"via": "link", "totp_off": r["totp_ct"] is not None and totp_ct is None}, c=conn)
    return signed_in(fresh_user(uid), request, response, body.shared)
