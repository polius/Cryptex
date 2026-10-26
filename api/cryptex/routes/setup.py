"""First-run setup (screen F1). Nothing can be created until an owner exists, and only
someone holding SETUP_CODE (printed in the server log) can claim a fresh install."""
from __future__ import annotations

import hmac
from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from pydantic import EmailStr, Field

from .. import db, ratelimit, security, state
from ..deps import require_session
from ..errors import ApiError, invalid
from ..events import emit
from ..util import new_id, now
from .auth import start_session
from .common import Body

router = APIRouter()


def detected_url(request: Request) -> str:
    """Origin as the browser sees it, honoring X-Forwarded-* only from trusted proxies."""
    proto, host = request.url.scheme, request.headers.get("host", request.url.netloc)
    peer = ratelimit._parse(request.client.host if request.client else "")
    if peer is not None and any(peer in n for n in state.env().trusted_proxies):
        proto = request.headers.get("x-forwarded-proto", proto).split(",")[0].strip()
        host = request.headers.get("x-forwarded-host", host).split(",")[0].strip()
    return f"{proto}://{host}"


def step() -> int:
    if not state.owner_exists():
        return 1
    if not state.raw("setup_brand_done", False):
        return 2
    return 3


@router.get("/setup")
def get_setup(request: Request) -> dict[str, Any]:
    e = state.env()
    url = e.public_url or detected_url(request)
    return {"needed": state.setup_needed(), "step": step(), "detected_url": url, "https": url.startswith("https://"),
            "public_url_locked": e.public_url is not None, "brand_locked": "brand_name" in e.locked,
            "sso": {"enabled": e.oidc_enabled, "name": e.oidc_name}}


class Owner(Body):
    setup_code: str
    email: EmailStr
    name: str = Field(min_length=1, max_length=80)
    password: str | None = Field(default=None, max_length=1024)
    totp_secret: str | None = None
    totp_code: str | None = None
    oidc: bool = False


@router.post("/setup/owner")
def setup_owner(body: Owner, request: Request, response: Response) -> dict[str, Any]:
    e = state.env()
    ratelimit.hit("auth", e.rate_auth, ratelimit.subject(ratelimit.client_ip(request)))
    if not state.setup_needed() or state.owner_exists():
        raise ApiError("setup_done")
    if not hmac.compare_digest(body.setup_code.strip().upper(), e.setup_code.upper()):
        raise invalid("setup_code", "That setup code doesn’t match the one in the server log.")
    if body.oidc and not e.oidc_enabled:
        raise invalid("oidc", "Single sign-on isn’t configured.")
    if not body.oidc and (not body.password or len(body.password) < 12):
        raise invalid("password", "Use at least 12 characters.")
    totp_ct = None
    if body.totp_secret:
        if security.verify_totp(body.totp_secret, (body.totp_code or "").strip(), None) is None:
            raise invalid("totp_code", "That code didn’t work. Check the time on your phone.")
        totp_ct = security.seal("totp", body.totp_secret.encode())
    uid = new_id(16)
    with db.tx() as c:
        if c.execute("SELECT 1 FROM users WHERE role = 'owner'").fetchone():
            raise ApiError("setup_done")
        c.execute("INSERT INTO users(id, email, name, role, password_hash, totp_ct, created_at) VALUES (?,?,?,?,?,?,?)",
                  (uid, str(body.email).lower(), body.name.strip(), "owner",
                   None if body.oidc else security.hash_password(body.password or ""), totp_ct, now()))
    state.save("detected_url", e.public_url or detected_url(request))
    if body.oidc:
        return {"next": "/api/v1/auth/oidc/start?return_to=/setup"}
    csrf = start_session(uid, request, response)
    return {"next": None, "csrf": csrf}


def _owner(request: Request) -> None:
    c = require_session(request)
    if not c.is_owner:
        raise ApiError("forbidden")
    if not state.setup_needed():
        raise ApiError("setup_done")


class BrandBody(Body):
    name: str = Field(default="", max_length=40)
    public_url: str | None = None


@router.post("/setup/brand", status_code=204)
def setup_brand(body: BrandBody, request: Request) -> Response:
    _owner(request)
    if "brand_name" not in state.env().locked:
        state.save("brand_name", body.name.strip())
    if body.public_url and not state.env().public_url:
        url = body.public_url.strip().rstrip("/")
        if not url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise invalid("public_url", "Use an https:// address.")
        state.save("detected_url", url)
    state.save("setup_brand_done", True)
    return Response(status_code=204)


class AccessBody(Body):
    mode: Literal["anyone", "signed_in"]


@router.post("/setup/access", status_code=204)
def setup_access(body: AccessBody, request: Request) -> Response:
    _owner(request)
    c = require_session(request)
    if "access" not in state.env().locked:
        state.save("access", body.mode, c.user_id)
    state.save("setup_completed", True, c.user_id)
    emit("setup.completed", actor="user", user_id=c.user_id)
    return Response(status_code=204)
