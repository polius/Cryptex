"""/config, /healthz, /metrics and the demo proof-of-work challenge."""
from __future__ import annotations

import hmac
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, Response

from .. import VERSION, db, demo, items, ratelimit, state
from ..deps import caller
from ..errors import NotFound
from ..util import iso, now

router = APIRouter()


def user_json(u: Any) -> dict[str, Any] | None:
    if u is None:
        return None
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "mfa": u["totp_ct"] is not None,
            "sso": u["oidc_sub"] is not None}


def brand_json() -> dict[str, Any]:
    logo = state.raw("brand_logo")
    return {"name": state.setting("brand_name") or "", "logo_url": f"/api/v1/brand/logo?v={logo['v']}" if logo else None,
            "public_url": state.public_url()}


@router.get("/config")
def config(request: Request) -> dict[str, Any]:
    c = caller(request)
    e = state.env()
    max_exp = int(state.setting("max_expiration"))
    out: dict[str, Any] = {
        "version": VERSION,
        "mode": state.setting("access"),
        "demo": e.demo,
        "setup_needed": state.setup_needed(),
        "signed_in": c.via == "session",
        "user": user_json(c.user),  # session, or the person an API token belongs to
        "via": c.via,
        "brand": brand_json(),
        "limits": {
            "max_expires_in": max_exp, "max_views": int(state.setting("max_views")),
            "max_message_chars": int(state.setting("max_message_length")), "max_files": int(state.setting("max_files")),
            "max_file_bytes": int(state.setting("max_file_size")),
            "request_max_expires_in": int(state.setting("request_max_expiration")),
            "request_max_keep": int(state.setting("request_max_keep")),
        },
        "defaults": {"views": 1, "expires_in": min(86400, max_exp), "access": "link"},
        "features": {"email_access": e.smtp_enabled, "org_access": e.oidc_enabled and bool(e.oidc_allowed_domains),
                     "notify": e.smtp_enabled, "sso": e.oidc_enabled, "sso_name": e.oidc_name,
                     "password_sign_in": not e.demo},
    }
    if c.via == "session":
        out["csrf"] = db.val("SELECT csrf FROM sessions WHERE id_hash = ?", c.session_hash)
    if e.demo:
        out["quota"] = demo.quota(c)
        out["pow_bits"] = e.demo_pow_bits
    elif c.user is None:
        used, reset = ratelimit.used("create", e.rate_create, c.subject)
        out["quota"] = {"used": used, "limit": e.rate_create.count, "reset_at": iso(reset)}
    return out


@router.get("/demo/challenge")
def challenge() -> dict[str, Any]:
    if not state.env().demo:
        raise NotFound()
    return demo.challenge()


@router.get("/brand/logo")
def logo() -> Response:
    logo = state.raw("brand_logo")
    if not logo:
        raise NotFound()
    path = state.env().data_dir / "brand" / logo["file"]
    if not path.exists():
        raise NotFound()
    media = "image/svg+xml" if logo["file"].endswith(".svg") else "image/png"
    return Response(path.read_bytes(), media_type=media, headers={
        "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})


@router.get("/healthz")
def healthz() -> dict[str, Any]:
    db.val("SELECT 1")
    return {"ok": True, "version": VERSION}


@router.get("/metrics")
def metrics(request: Request) -> PlainTextResponse:
    token = state.env().metrics_token
    auth = request.headers.get("authorization", "")
    if not token or not hmac.compare_digest(auth, f"Bearer {token}"):
        raise NotFound()
    lines = [
        f"cryptex_live_secrets {db.val('SELECT count(*) FROM secrets WHERE sealed = 1')}",
        f"cryptex_live_requests {db.val('SELECT count(*) FROM requests')}",
        f"cryptex_storage_bytes {items.stored_bytes()}",
        f"cryptex_rate_limit_blocks {db.val('SELECT count(*) FROM rate_limits WHERE bucket LIKE ? AND window_start > ?', 'block:%', now())}",
        f"cryptex_webhook_failures {db.val('SELECT count(*) FROM events WHERE type = ?', 'webhook.failed')}",
    ]
    for r in db.all("SELECT name, last_run_at FROM jobs"):
        lines.append(f'cryptex_job_last_run_seconds{{job="{r["name"]}"}} {r["last_run_at"] or 0}')
    from ..app import REQUEST_COUNTS
    for (route, status), n in sorted(REQUEST_COUNTS.items()):
        lines.append(f'cryptex_requests_total{{route="{route}",status="{status}"}} {n}')
    return PlainTextResponse("\n".join(lines) + "\n")
