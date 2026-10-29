"""Helpers shared by route modules."""
from __future__ import annotations

import re

from fastapi import Request
from pydantic import BaseModel, ConfigDict

from .. import ratelimit, state
from ..deps import Caller
from ..errors import ApiError

HEX64 = re.compile(r"^[0-9a-f]{64}$")
B64U = re.compile(r"^[A-Za-z0-9_-]*$")


class Body(BaseModel):
    model_config = ConfigDict(extra="ignore")


async def read_body(request: Request, limit: int) -> bytes:
    """Read a request body without ever holding more than `limit` + one network chunk."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise ApiError("too_large", limit=limit)
    buf = bytearray()
    async for part in request.stream():
        buf += part
        if len(buf) > limit:
            raise ApiError("too_large", limit=limit)
    return bytes(buf)


def check_create_allowed(c: Caller) -> None:
    """ACCESS rule and the create rate limit (per person when signed in, per IP otherwise)."""
    if state.setup_needed():
        raise ApiError("forbidden", "This server isn’t set up yet.", reason="setup_needed")
    if state.setting("access") == "signed_in" and c.user is None:
        raise ApiError("sign_in_required")
    key = f"user:{c.user_id}" if c.user_id else c.subject
    ratelimit.hit("create", state.env().rate_create, key)
