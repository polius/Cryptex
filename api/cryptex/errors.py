"""The API error model.

Every failure is `{"error": {"code", "message", ...}}`. `not_found` is byte-for-byte
identical whatever the cause, so it can't be used to probe IDs or tokens.
"""
from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

from .util import iso

MESSAGES = {
    "invalid": "Something in the request isn’t right.",
    "limit_exceeded": "That’s over this server’s limit.",
    "sign_in_required": "Sign in to do this.",
    "forbidden": "You don’t have access to this.",
    "reauth_required": "Confirm it’s you to make this change.",
    "wrong_code": "That code didn’t work.",
    "wrong_password": "That password didn’t work.",
    "not_found": "Not found.",
    "already_sealed": "This link is already complete.",
    "setup_done": "Setup is already finished.",
    "gone": "This is no longer available.",
    "too_large": "That’s too large for this server.",
    "wrong_passphrase": "That passphrase didn’t work.",
    "rate_limited": "Too many tries. Try again later.",
    "demo_locked": "This is fixed in the demo.",
    "storage_full": "This server is almost out of disk space. Try a smaller secret, or ask whoever runs it.",
    "internal": "Something went wrong on our side. Nothing was opened or deleted.",
}

STATUS = {
    "invalid": 400, "limit_exceeded": 400, "sign_in_required": 401, "forbidden": 403,
    "reauth_required": 403, "wrong_code": 403, "wrong_password": 401, "not_found": 404,
    "already_sealed": 409, "setup_done": 409, "gone": 410,
    "too_large": 413, "wrong_passphrase": 422, "rate_limited": 429, "demo_locked": 403,
    "storage_full": 507, "internal": 500,
}


class ApiError(Exception):
    def __init__(self, code: str, message: str | None = None, status: int | None = None,
                 headers: dict[str, str] | None = None, **extra: Any):
        self.code = code
        self.status = status or STATUS[code]
        self.message = message or MESSAGES[code]
        self.extra = {k: v for k, v in extra.items() if v is not None}
        self.headers = headers or {}
        super().__init__(code)

    def body(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, **self.extra}}

    def response(self) -> JSONResponse:
        return JSONResponse(self.body(), status_code=self.status, headers={"Cache-Control": "no-store", **self.headers})


class NotFound(ApiError):
    def __init__(self) -> None:
        super().__init__("not_found")


def gone(reason: str, at: int, opened: bool) -> ApiError:
    """A secret that no longer exists, for someone holding its link. `opened`: was it ever revealed?"""
    return ApiError("gone", reason=reason, at=iso(at), opened=opened)


def invalid(field: str, message: str | None = None, code: str = "invalid", limit: int | None = None) -> ApiError:
    return ApiError(code, message, field=field, limit=limit)
