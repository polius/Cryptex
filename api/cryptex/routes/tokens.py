"""Personal API tokens (screens E6, E8). Each token acts as its person, limited by scopes."""
from __future__ import annotations

import secrets
from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from pydantic import Field

from .. import db, state
from ..deps import require_reauth, require_session
from ..errors import ApiError, NotFound
from ..events import emit
from ..util import new_id, now, sha256_hex
from .common import Body
from .server import token_json

router = APIRouter()


@router.get("/me/tokens")
def my_tokens(request: Request) -> dict[str, Any]:
    c = require_session(request)
    rows = db.all("SELECT t.*, u.email, u.name AS uname FROM api_tokens t JOIN users u ON u.id = t.user_id "
                  "WHERE t.user_id = ? ORDER BY t.created_at DESC", c.user_id)
    return {"items": [token_json(t) for t in rows]}


class NewToken(Body):
    name: str = Field(min_length=1, max_length=64)
    scopes: list[Literal["send", "request"]] = Field(min_length=1)
    expires_in_days: int = Field(default=90, ge=1, le=365)


@router.post("/me/tokens", status_code=201)
def create_token(body: NewToken, request: Request) -> dict[str, Any]:
    c = require_session(request)
    if state.env().demo:
        raise ApiError("demo_locked")
    raw = "cx_live_" + secrets.token_urlsafe(32)
    tid = new_id(12)
    scopes = ",".join(sorted(set(body.scopes)))
    t = now()
    db.run("INSERT INTO api_tokens(id, user_id, name, scopes, token_hash, hint, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)",
           tid, c.user_id, body.name.strip(), scopes, sha256_hex(raw), raw[-4:], t, t + body.expires_in_days * 86400)
    emit("token.created", actor="user", user_id=c.user_id, detail={"token_id": tid, "scopes": scopes.split(",")})
    row = db.one("SELECT t.*, u.email, u.name AS uname FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?", tid)
    return {**token_json(row), "token": raw}


@router.delete("/tokens/{token_id}", status_code=204)
def revoke(token_id: str, request: Request) -> Response:
    c = require_session(request)
    t = db.one("SELECT * FROM api_tokens WHERE id = ?", token_id)
    if t is None or (t["user_id"] != c.user_id and not c.is_owner):
        raise NotFound()
    if t["user_id"] != c.user_id:
        require_reauth(c)  # changing someone else's access
    db.run("DELETE FROM api_tokens WHERE id = ?", token_id)
    emit("token.revoked", actor="user", user_id=c.user_id, detail={"token_id": token_id, "scopes": t["scopes"].split(",")})
    return Response(status_code=204)
