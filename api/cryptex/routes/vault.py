"""The account vault: the wrapped vault key and encrypted items, for the signed-in session only (account.py).

Everything stored here was encrypted in the browser. The server keeps it so every device of the account
sees the same Your links, and so clearing a browser loses nothing.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import Field

from .. import db
from ..account import B64_32, WRAPPED, vault_bundle, vault_public
from ..deps import require_reauth, require_session
from ..errors import ApiError
from ..util import now
from .auth import check_password
from .common import Body

router = APIRouter()
MAX_ITEMS = 5000
ITEM_ID = r"^[A-Za-z0-9]{10}$"
ITEM_CT = r"^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20,22000}$"


@router.get("/me/vault/keys")
def keys(request: Request) -> dict[str, Any]:
    """Salt and settings. The rest of the bundle needs the password: /me/vault/unlock."""
    c = require_session(request)
    u = c.user
    assert u is not None
    return vault_public(u)


class Unlock(Body):
    auth_key: str = Field(pattern=B64_32)


@router.post("/me/vault/unlock")
def unlock(body: Unlock, request: Request) -> dict[str, Any]:
    """The unlock prompt: the full vault bundle, only for the account's password (checked here, so a typo is
    refused before the browser uses any key derived from it). Counts toward RATE_AUTH like a sign-in."""
    c = require_session(request)
    check_password(c, body.auth_key)
    assert c.user is not None
    return vault_bundle(c.user)


class Keys(Body):
    vault_pw: str = Field(pattern=WRAPPED)
    auth_key: str | None = Field(default=None, pattern=B64_32)  # the password, instead of a re-auth window


@router.put("/me/vault/keys", status_code=204)
def put_keys(body: Keys, request: Request) -> Response:
    """Save a new vault key, wrapped for the password (the first sign-in, or the first after a reset). It's what the
    password opens, so writing it needs the password: a re-auth window (signing in starts one) or auth_key."""
    c = require_session(request)
    if body.auth_key:
        check_password(c, body.auth_key)
    else:
        require_reauth(c)
    db.run("UPDATE users SET vault_pw = ? WHERE id = ?", body.vault_pw, c.user_id)
    return Response(status_code=204)


@router.get("/me/vault/items")
def items(request: Request) -> dict[str, Any]:
    c = require_session(request)
    rows = db.all("SELECT item_id, ct, updated_at FROM vault_items WHERE user_id = ? ORDER BY updated_at DESC", c.user_id)
    return {"items": [{"id": r["item_id"], "ct": r["ct"], "updated_at": r["updated_at"]} for r in rows]}


class Item(Body):
    ct: str = Field(pattern=ITEM_CT)


@router.put("/me/vault/items/{item_id}", status_code=204)
def put_item(item_id: str, body: Item, request: Request) -> Response:
    """Add an item, or replace it. `If-Match: *` replaces only: a device saving a newer status of a link that another
    device deleted meanwhile is refused (412), instead of bringing the link back."""
    c = require_session(request)
    if not re.match(ITEM_ID, item_id):
        raise ApiError("invalid", "Not a link id.", field="item_id")
    with db.tx() as conn:
        exists = conn.execute("SELECT 1 FROM vault_items WHERE user_id = ? AND item_id = ?", (c.user_id, item_id)).fetchone()
        if not exists and request.headers.get("if-match", "").strip() == "*":
            raise ApiError("deleted")
        if not exists and conn.execute("SELECT count(*) FROM vault_items WHERE user_id = ?", (c.user_id,)).fetchone()[0] >= MAX_ITEMS:
            raise ApiError("limit_exceeded", "Your links are full. Remove some first.", limit=MAX_ITEMS)
        conn.execute("INSERT INTO vault_items(user_id, item_id, ct, updated_at) VALUES (?,?,?,?) "
                     "ON CONFLICT(user_id, item_id) DO UPDATE SET ct = excluded.ct, updated_at = excluded.updated_at",
                     (c.user_id, item_id, body.ct, now()))
    return Response(status_code=204)


@router.delete("/me/vault/items/{item_id}", status_code=204)
def delete_item(item_id: str, request: Request) -> Response:
    c = require_session(request)
    db.run("DELETE FROM vault_items WHERE user_id = ? AND item_id = ?", c.user_id, item_id)
    return Response(status_code=204)
