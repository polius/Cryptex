import hashlib
import os
import secrets
import time
from pathlib import Path

import bcrypt
import pyotp
from datetime import datetime, timedelta, timezone
from typing import Annotated
from fastapi import Depends, APIRouter, HTTPException, Request, Response, Cookie
from fastapi.responses import JSONResponse

from ..models import LoginRequest

# Token lifetimes
ACCESS_EXPIRE_MINUTES = 15          # Short-lived access token
REFRESH_EXPIRE_DAYS = 365           # Long-lived refresh token (1 year)

# Password file is the single source of truth.
# On first run, seed it from the ADMIN_PASSWORD env var (default: 'admin').
_password_file = Path("/cryptex/data/password.conf")
if not _password_file.exists():
    _password_file.parent.mkdir(parents=True, exist_ok=True)
    _password_file.write_text(
        os.getenv("ADMIN_PASSWORD", "sha256:8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918")
    )

ADMIN_PASSWORD = _password_file.read_text().strip()

# In-memory session stores
access_sessions: dict[str, dict] = {}    # access_token  -> session data
refresh_sessions: dict[str, dict] = {}   # refresh_token -> session data

# 2FA storage (in production, use a database)
two_factor_settings = {
    "enabled": False,
    "secret": None
}

# Initialize FastAPI router
router = APIRouter(prefix="/auth", tags=["Auth"])


def _generate_token() -> str:
    """Create a secure random token"""
    return secrets.token_urlsafe(32)


def _is_secure_request(request: Request | None) -> bool:
    """Return True if the original client request was made over HTTPS.

    Checks the ``X-Forwarded-Proto`` header (set by reverse proxies) first,
    then falls back to the request's own URL scheme.
    """
    if request is None:
        return False
    proto = (request.headers.get("x-forwarded-proto") or "").lower()
    if proto:
        return proto == "https"
    return request.url.scheme == "https"


def _issue_tokens(response: JSONResponse | Response, request: Request | None = None) -> str:
    """Create an access + refresh token pair and set them as cookies on *response*.
    Returns the access token string (mostly for internal use).
    """
    now = datetime.now(timezone.utc)
    secure = _is_secure_request(request)

    access_token = _generate_token()
    access_sessions[access_token] = {
        "user": "admin",
        "created": now,
        "expires": now + timedelta(minutes=ACCESS_EXPIRE_MINUTES),
    }

    refresh_token = _generate_token()
    refresh_sessions[refresh_token] = {
        "user": "admin",
        "created": now,
        "expires": now + timedelta(days=REFRESH_EXPIRE_DAYS),
        "access_token": access_token,          # link so we can revoke on refresh
    }

    # Short-lived access cookie
    response.set_cookie(
        key="access_token",
        value=access_token,
        httponly=True,
        secure=secure,
        max_age=ACCESS_EXPIRE_MINUTES * 60,
        samesite="strict",
        path="/",
    )

    # Long-lived refresh cookie — only sent to /api/auth/refresh
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=secure,
        max_age=REFRESH_EXPIRE_DAYS * 86400,
        samesite="strict",
        path="/api/auth/refresh",
    )

    return access_token


def _revoke_tokens(
    access_token: str | None = None,
    refresh_token: str | None = None,
):
    """Remove tokens from the session stores."""
    if access_token and access_token in access_sessions:
        del access_sessions[access_token]
    if refresh_token and refresh_token in refresh_sessions:
        # Also revoke the linked access token
        linked = refresh_sessions[refresh_token].get("access_token")
        if linked and linked in access_sessions:
            del access_sessions[linked]
        del refresh_sessions[refresh_token]


_last_session_purge = 0
_SESSION_PURGE_INTERVAL = 3600  # Purge expired sessions every hour


def _purge_expired_sessions():
    """Remove expired tokens from in-memory session stores."""
    global _last_session_purge
    now_ts = time.time()
    if now_ts - _last_session_purge < _SESSION_PURGE_INTERVAL:
        return
    _last_session_purge = now_ts
    now = datetime.now(timezone.utc)
    expired_access = [k for k, v in access_sessions.items() if now > v["expires"]]
    for k in expired_access:
        del access_sessions[k]
    expired_refresh = [k for k, v in refresh_sessions.items() if now > v["expires"]]
    for k in expired_refresh:
        del refresh_sessions[k]


def check_auth(
    request: Request,
    access_token: Annotated[str | None, Cookie()] = None,
):
    """Dependency to check if user is authenticated via access token."""
    _purge_expired_sessions()

    if not access_token:
        raise HTTPException(401, "Not authenticated")

    session = access_sessions.get(access_token)
    if not session:
        raise HTTPException(401, "Not authenticated")

    if datetime.now(timezone.utc) > session["expires"]:
        del access_sessions[access_token]
        raise HTTPException(401, "Access token expired")

    return session


def _verify_password(password: str) -> bool:
    """Check *password* against the stored admin hash. Returns True on match."""
    if ADMIN_PASSWORD.startswith("sha256:"):
        input_hash = hashlib.sha256(password.encode("utf-8")).hexdigest()
        return input_hash == ADMIN_PASSWORD.split(":", 1)[1]
    elif ADMIN_PASSWORD.startswith("$2b$"):
        return bcrypt.checkpw(
            password.encode("utf-8"),
            ADMIN_PASSWORD.encode("utf-8"),
        )
    raise HTTPException(500, "Invalid password hash configuration")


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/login")
def login(login_data: LoginRequest, request: Request) -> JSONResponse:
    """Login endpoint — verifies password and issues access + refresh tokens."""
    if not ADMIN_PASSWORD:
        raise HTTPException(500, "Admin password not configured")

    try:
        password_ok = _verify_password(login_data.password)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(500, "Invalid password hash configuration")

    if not password_ok:
        raise HTTPException(401, "Invalid password")

    # Check 2FA if enabled
    if two_factor_settings["enabled"] and two_factor_settings["secret"]:
        if not login_data.totp_code:
            raise HTTPException(401, "2FA code required")
        totp = pyotp.TOTP(two_factor_settings["secret"])
        if not totp.verify(login_data.totp_code, valid_window=1):
            raise HTTPException(401, "Invalid 2FA code")

    json_response = JSONResponse({"message": "Login successful"})
    _issue_tokens(json_response, request)
    return json_response


@router.post("/refresh")
def refresh(
    request: Request,
    response: Response,
    refresh_token: Annotated[str | None, Cookie()] = None,
):
    """Use a valid refresh token to get a new access + refresh token pair.

    Implements **refresh-token rotation**: each refresh token is single-use.
    The old tokens are revoked and a fresh pair is issued.
    """
    if not refresh_token:
        raise HTTPException(401, "No refresh token")

    session = refresh_sessions.get(refresh_token)
    if not session:
        raise HTTPException(401, "Invalid refresh token")

    if datetime.now(timezone.utc) > session["expires"]:
        _revoke_tokens(refresh_token=refresh_token)
        raise HTTPException(401, "Refresh token expired")

    # Revoke old pair (rotation)
    _revoke_tokens(refresh_token=refresh_token)

    # Issue fresh pair
    json_response = JSONResponse({"message": "Tokens refreshed"})
    _issue_tokens(json_response, request)
    return json_response


@router.post("/logout")
def logout(
    response: Response,
    access_token: Annotated[str | None, Cookie()] = None,
    refresh_token: Annotated[str | None, Cookie()] = None,
):
    """Logout — revoke both tokens and clear cookies."""
    _revoke_tokens(access_token=access_token, refresh_token=refresh_token)

    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/api/auth/refresh")
    return {"message": "Logged out successfully"}


@router.get("/check")
def check_login(user=Depends(check_auth)):
    """Check if user is logged in."""
    return {"authenticated": True, "user": user}
