"""Sign-in: OIDC for everyone, password + TOTP for owners without SSO, re-auth, 2FA."""
from __future__ import annotations

import base64
import hashlib
import re
import secrets
import time
from typing import Any
from urllib.parse import urlencode

import httpx
import pyotp
from fastapi import APIRouter, Request, Response
from fastapi.responses import RedirectResponse
from joserfc import jwt
from joserfc.errors import JoseError
from joserfc.jwk import KeySet
from pydantic import Field

from .. import db, ratelimit, security, state
from ..deps import SESSION_COOKIE, SESSION_TTL, caller, require_reauth, require_session
from ..errors import ApiError, NotFound, invalid
from ..events import emit
from ..util import new_id, new_token, now, sha256_hex, token_hash
from .common import Body
from .config import user_json

router = APIRouter()
MFA_TTL = 300
REAUTH_TTL = 300


def safe_return_to(v: str | None) -> str:
    """Same-origin path only: blocks //evil, /\\evil and scheme tricks (audit finding S14)."""
    if not v or not v.startswith("/") or v.startswith("//") or "\\" in v or re.search(r"[\x00-\x1f]", v):
        return "/"
    return v


def is_https(request: Request) -> bool:
    return state.public_url().startswith("https://") or request.url.scheme == "https"


def start_session(user_id: str, request: Request, response: Response, *, reauth: bool = True) -> str:
    token, h = new_token()
    csrf = secrets.token_urlsafe(24)
    t = now()
    db.run("INSERT INTO sessions(id_hash, user_id, csrf, created_at, expires_at, reauth_until) VALUES (?,?,?,?,?,?)",
           h, user_id, csrf, t, t + SESSION_TTL, t + REAUTH_TTL if reauth else None)
    db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", t, user_id)
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_TTL, httponly=True, secure=is_https(request),
                        samesite="lax", path="/")
    return csrf


@router.get("/auth/session")
def session(request: Request) -> dict[str, Any]:
    c = caller(request)
    if c.via != "session":
        return {"user": None, "csrf": None}
    return {"user": user_json(c.user), "csrf": db.val("SELECT csrf FROM sessions WHERE id_hash = ?", c.session_hash)}


class Login(Body):
    email: str = Field(max_length=254)
    password: str = Field(max_length=1024)


@router.post("/auth/login")
def login(body: Login, request: Request, response: Response) -> dict[str, Any]:
    c = caller(request)
    if state.env().demo:
        raise ApiError("demo_locked")
    ratelimit.hit("auth", state.env().rate_auth, c.subject)
    u = db.one("SELECT * FROM users WHERE email = ?", body.email.strip())
    if u is None or not security.verify_password(u["password_hash"] if u else None, body.password):
        emit("user.sign_in_failed", actor="system", detail={"method": "password"})
        raise ApiError("sign_in_required", "That email and password don’t match.", status=401)
    if u["totp_ct"] is not None:
        ticket, h = new_token()
        db.run("INSERT INTO mfa_tickets(ticket_hash, user_id, expires_at) VALUES (?,?,?)", h, u["id"], now() + MFA_TTL)
        return {"mfa_ticket": ticket}
    csrf = start_session(u["id"], request, response)
    emit("user.signed_in", actor="user", user_id=u["id"], detail={"method": "password"})
    return {"user": user_json(u), "csrf": csrf}


class Totp(Body):
    mfa_ticket: str
    code: str


@router.post("/auth/login/totp")
def login_totp(body: Totp, request: Request, response: Response) -> dict[str, Any]:
    c = caller(request)
    ratelimit.hit("auth", state.env().rate_auth, c.subject)
    h = token_hash(body.mfa_ticket)
    t = db.one("SELECT * FROM mfa_tickets WHERE ticket_hash = ? AND expires_at > ?", h, now()) if h else None
    if t is None:
        raise ApiError("sign_in_required", "That sign-in expired. Start again.", status=401)
    u = db.one("SELECT * FROM users WHERE id = ?", t["user_id"])
    step = security.verify_totp(security.unseal("totp", u["totp_ct"]).decode(), body.code.strip(), u["totp_last_step"])
    if step is None:
        db.run("UPDATE mfa_tickets SET tries = tries + 1 WHERE ticket_hash = ?", h)
        if t["tries"] + 1 >= 5:
            db.run("DELETE FROM mfa_tickets WHERE ticket_hash = ?", h)
        emit("user.sign_in_failed", actor="system", detail={"method": "totp"})
        raise ApiError("wrong_code", "That code didn’t work.", status=401)
    db.run("UPDATE users SET totp_last_step = ? WHERE id = ?", step, u["id"])
    db.run("DELETE FROM mfa_tickets WHERE ticket_hash = ?", h)
    csrf = start_session(u["id"], request, response)
    emit("user.signed_in", actor="user", user_id=u["id"], detail={"method": "password"})
    return {"user": user_json(u), "csrf": csrf}


class Reauth(Body):
    password: str | None = None
    code: str | None = None


@router.post("/auth/reauth", status_code=204)
def reauth(body: Reauth, request: Request) -> Response:
    c = require_session(request)
    ratelimit.hit("auth", state.env().rate_auth, c.subject)
    u = c.user
    assert u is not None
    if u["password_hash"] is None:
        raise invalid("password", "Confirm with single sign-on instead.")
    if not security.verify_password(u["password_hash"], body.password or ""):
        raise ApiError("sign_in_required", "That password didn’t work.", status=401)
    if u["totp_ct"] is not None:
        step = security.verify_totp(security.unseal("totp", u["totp_ct"]).decode(), (body.code or "").strip(), u["totp_last_step"])
        if step is None:
            raise ApiError("wrong_code", "That code didn’t work.", status=401)
        db.run("UPDATE users SET totp_last_step = ? WHERE id = ?", step, u["id"])
    db.run("UPDATE sessions SET reauth_until = ? WHERE id_hash = ?", now() + REAUTH_TTL, c.session_hash)
    return Response(status_code=204)


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response) -> Response:
    c = caller(request)
    if c.session_hash:
        db.run("DELETE FROM sessions WHERE id_hash = ?", c.session_hash)
    r = Response(status_code=204)
    r.delete_cookie(SESSION_COOKIE, path="/")
    return r


# ------------------------------------------------------------------ own 2FA
@router.post("/me/totp")
def totp_begin(request: Request) -> dict[str, Any]:
    c = require_session(request)
    assert c.user is not None
    secret = pyotp.random_base32()
    uri = pyotp.TOTP(secret).provisioning_uri(c.user["email"], issuer_name=f"{state.brand_name()} Cryptex")
    return {"secret": secret, "uri": uri}


class TotpEnable(Body):
    secret: str = Field(min_length=16, max_length=64)
    code: str


@router.put("/me/totp", status_code=204)
def totp_enable(body: TotpEnable, request: Request) -> Response:
    c = require_session(request)
    require_reauth(c)
    step = security.verify_totp(body.secret, body.code.strip(), None)
    if step is None:
        raise ApiError("wrong_code", "That code didn’t work. Check the time on your phone.")
    db.run("UPDATE users SET totp_ct = ?, totp_last_step = ? WHERE id = ?", security.seal("totp", body.secret.encode()), step, c.user_id)
    return Response(status_code=204)


@router.delete("/me/totp", status_code=204)
def totp_disable(request: Request) -> Response:
    c = require_session(request)
    require_reauth(c)
    db.run("UPDATE users SET totp_ct = NULL, totp_last_step = NULL WHERE id = ?", c.user_id)
    return Response(status_code=204)


# ------------------------------------------------------------------ OIDC
_discovery: dict[str, Any] = {}
_jwks: dict[str, Any] = {}
http_client: httpx.Client | None = None  # tests inject a client wired to a fake provider


def _http() -> httpx.Client:
    global http_client
    if http_client is None:
        http_client = httpx.Client(timeout=10)
    return http_client


def discovery() -> dict[str, Any]:
    e = state.env()
    if _discovery.get("_at", 0) > time.time() - 3600:
        return _discovery
    r = _http().get(f"{e.oidc_issuer}/.well-known/openid-configuration")
    r.raise_for_status()
    _discovery.clear()
    _discovery.update(r.json())
    _discovery["_at"] = time.time()
    _jwks.clear()
    return _discovery


def jwks(force: bool = False) -> Any:
    if force or not _jwks:
        r = _http().get(discovery()["jwks_uri"])
        r.raise_for_status()
        _jwks.clear()
        _jwks.update(r.json())
    return KeySet.import_key_set(dict(_jwks))  # type: ignore[arg-type]


def redirect_uri() -> str:
    return f"{state.public_url()}/api/v1/auth/oidc/callback"


@router.get("/auth/oidc/start")
def oidc_start(request: Request, return_to: str = "/", reauth: int = 0) -> RedirectResponse:
    e = state.env()
    if not e.oidc_enabled:
        raise NotFound()
    c = caller(request)
    ratelimit.hit("auth", e.rate_auth, c.subject)
    st, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    db.run("INSERT INTO oidc_states(state_hash, nonce, verifier, return_to, reauth_session, expires_at) VALUES (?,?,?,?,?,?)",
           sha256_hex(st), nonce, verifier, safe_return_to(return_to), c.session_hash if reauth and c.via == "session" else None,
           now() + 600)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = {"client_id": e.oidc_client_id, "response_type": "code", "scope": "openid email profile",
              "redirect_uri": redirect_uri(), "state": st, "nonce": nonce, "code_challenge": challenge,
              "code_challenge_method": "S256"}
    if reauth:
        params.update(prompt="login", max_age="0")
    if len(e.oidc_allowed_domains) == 1 and "accounts.google.com" in (e.oidc_issuer or ""):
        params["hd"] = e.oidc_allowed_domains[0]
    return RedirectResponse(f"{discovery()['authorization_endpoint']}?{urlencode(params)}", status_code=302)


def _fail(reason: str) -> RedirectResponse:
    return RedirectResponse(f"/signin?error={reason}", status_code=302)


@router.get("/auth/oidc/callback")
def oidc_callback(request: Request, state_: str = "", code: str = "", error: str = "") -> RedirectResponse:
    e = state.env()
    if not e.oidc_enabled:
        raise NotFound()
    st = request.query_params.get("state", state_)
    row = db.one("SELECT * FROM oidc_states WHERE state_hash = ? AND expires_at > ?", sha256_hex(st), now()) if st else None
    if row is None:
        return _fail("expired")
    db.run("DELETE FROM oidc_states WHERE state_hash = ?", sha256_hex(st))
    if error or not code:
        return _fail("cancelled")
    try:
        d = discovery()
        tok = _http().post(d["token_endpoint"], data={
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
            "client_id": e.oidc_client_id, "client_secret": e.oidc_client_secret or "", "code_verifier": row["verifier"]})
        tok.raise_for_status()
        id_token = tok.json()["id_token"]
        try:
            token = jwt.decode(id_token, jwks(), algorithms=["RS256", "ES256", "PS256", "EdDSA"])
        except (JoseError, ValueError):
            token = jwt.decode(id_token, jwks(force=True), algorithms=["RS256", "ES256", "PS256", "EdDSA"])  # key rotation
        claims = token.claims
        jwt.JWTClaimsRegistry(leeway=60, exp={"essential": True}, iat={"essential": False}).validate(claims)
    except (httpx.HTTPError, KeyError, ValueError, JoseError):
        return _fail("provider")
    aud = claims.get("aud")
    if claims.get("iss", "").rstrip("/") != e.oidc_issuer or (e.oidc_client_id not in (aud if isinstance(aud, list) else [aud])) \
            or claims.get("nonce") != row["nonce"]:
        return _fail("provider")
    email = str(claims.get("email") or "").lower()
    if not email or claims.get("email_verified") is False:
        return _fail("email")
    domain = email.rsplit("@", 1)[-1]
    if e.oidc_allowed_domains and (domain not in e.oidc_allowed_domains or
                                   ("hd" in claims and claims["hd"] not in e.oidc_allowed_domains)):
        return _fail("domain")
    sub = f"{e.oidc_issuer}|{claims['sub']}"
    u = db.one("SELECT * FROM users WHERE oidc_sub = ?", sub) or db.one("SELECT * FROM users WHERE email = ?", email)
    name = str(claims.get("name") or "")[:80]
    if row["reauth_session"]:
        s = db.one("SELECT user_id FROM sessions WHERE id_hash = ?", row["reauth_session"])
        if s is None or u is None or s["user_id"] != u["id"]:
            return _fail("reauth")
        db.run("UPDATE sessions SET reauth_until = ? WHERE id_hash = ?", now() + REAUTH_TTL, row["reauth_session"])
        return RedirectResponse(row["return_to"], status_code=302)
    if u is None:
        if state.setup_needed():
            return _fail("setup")
        role = "owner" if email in e.oidc_owner_emails else "member"
        uid = new_id(16)
        db.run("INSERT INTO users(id, email, name, role, oidc_sub, created_at) VALUES (?,?,?,?,?,?)", uid, email, name, role, sub, now())
        u = db.one("SELECT * FROM users WHERE id = ?", uid)
    else:
        promote = "owner" if email in e.oidc_owner_emails else u["role"]
        db.run("UPDATE users SET oidc_sub = ?, name = CASE WHEN name = '' THEN ? ELSE name END, role = ? WHERE id = ?",
               sub, name, promote, u["id"])
    assert u is not None
    resp = RedirectResponse(row["return_to"], status_code=302)
    start_session(u["id"], request, resp)
    emit("user.signed_in", actor="user", user_id=u["id"], detail={"method": "oidc"})
    return resp
