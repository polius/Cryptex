"""Sender-side status: receipts, batch lookup and account sync."""
from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterable
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import Field

from .. import db, events, ratelimit, state
from ..deps import Caller, caller, cap_hash, deny, matches, require_session
from ..errors import invalid
from ..util import is_id, iso, now, token_hash
from .common import Body

router = APIRouter()
MAX_ITEMS = 2000  # per lookup; Your links sends more in several
PAGE = 500        # GET /me/receipts
ATTACH = 200      # POST /me/receipts
_IN = 500         # ids per IN (...) query

def _by_id(table: str, ids: Iterable[str]) -> dict[str, sqlite3.Row]:
    ids = sorted({i for i in ids if is_id(i)})
    out: dict[str, sqlite3.Row] = {}
    for k in range(0, len(ids), _IN):
        part = ids[k:k + _IN]
        out.update((r["id"], r) for r in db.all(f"SELECT * FROM {table} WHERE id IN ({','.join('?' * len(part))})", *part))
    return out


def _events(ids: Iterable[str]) -> dict[str, list[dict[str, Any]]]:
    ids = sorted(set(ids))
    out: dict[str, list[dict[str, Any]]] = {i: [] for i in ids}
    for k in range(0, len(ids), _IN):
        part = ids[k:k + _IN]
        for e in db.all(f"SELECT secret_id, type, at, detail FROM events WHERE secret_id IN ({','.join('?' * len(part))}) ORDER BY id", *part):
            if e["type"] in events.RECEIPT:
                out[e["secret_id"]].append(events.as_json(e))
    return out


def receipts(pairs: list[tuple[str, str | None]], *, with_events: bool = True) -> list[dict[str, Any] | None]:
    """Status of each (id, manage hash) pair whose hash proves the caller holds its manage token, else None.
    A few queries for the whole batch, however long."""
    secrets_, tombs = _by_id("secrets", (i for i, _ in pairs)), _by_id("tombstones", (i for i, _ in pairs))
    out = [_receipt(i, h, secrets_.get(i), tombs.get(i)) if h else None for i, h in pairs]
    if with_events:
        evs = _events(r["id"] for r in out if r is not None)
        for r in out:
            if r is not None:
                r["events"] = evs[r["id"]]
    return out


def receipt(secret_id: str, manage_hash: str | None, *, with_events: bool = True) -> dict[str, Any] | None:
    """Status of one secret if `manage_hash` proves the caller holds its manage token."""
    return receipts([(secret_id, manage_hash)], with_events=with_events)[0]


def _receipt(secret_id: str, manage_hash: str, r: sqlite3.Row | None, t: sqlite3.Row | None) -> dict[str, Any] | None:
    out: dict[str, Any] | None = None
    if r is not None and r["sealed"] and matches(r["manage_hash"], manage_hash):
        out = {"id": secret_id, "status": "opened" if r["views"] else "waiting",
               "views_left": None if r["max_views"] is None else r["max_views"] - r["views"], "max_views": r["max_views"],
               "views": r["views"], "created_at": iso(r["created_at"]), "expires_at": iso(r["expires_at"]),
               "passphrase": r["passcheck_hash"] is not None}
    elif t is not None and matches(t["manage_hash"], manage_hash):
        status = {"opened": "opened", "expired": "expired", "destroyed": "destroyed", "too_many_tries": "destroyed",
                  "reported": "destroyed"}[t["reason"]]
        out = {"id": secret_id, "status": status, "reason": t["reason"], "ended_at": iso(t["at"]),
               "views_left": 0 if t["reason"] == "opened" else None, "opened": bool(t["opened"])}
    return out


def known(secret_id: str) -> bool:
    """Does the ID exist, or did it recently (a tombstone)? Only then is a wrong manage token a guess worth counting."""
    return is_id(secret_id) and (db.val("SELECT 1 FROM secrets WHERE id = ?", secret_id) is not None
                                 or db.val("SELECT 1 FROM tombstones WHERE id = ?", secret_id) is not None)


class Pair(Body):
    id: str = Field(max_length=16)
    manage_token: str = Field(max_length=64)


class Lookup(Body):
    items: list[Pair] = Field(default_factory=list, max_length=MAX_ITEMS)


def status_request(c: Caller) -> None:
    """Receipt lookups (Your links, the receipt page): the failed-token block, then RATE_STATUS."""
    ratelimit.check_blocked(c.ip)
    ratelimit.hit("status", state.env().rate_status, c.subject)


def proven(c: Caller, pairs: list[Pair], *, with_events: bool = True) -> list[dict[str, Any]]:
    """The receipts these (id, manage token) pairs prove. A wrong token for an ID that exists (or did, recently)
    counts toward RATE_FAILED_TOKENS; unknown IDs don't, since Your links can hold items long purged."""
    found = receipts([(p.id, token_hash(p.manage_token)) for p in pairs], with_events=with_events)
    wrong = [p.id for p, r in zip(pairs, found, strict=True) if r is None]
    gone_ids = set(_by_id("secrets", wrong)) | set(_by_id("tombstones", wrong))
    if n := sum(1 for i in wrong if i in gone_ids):
        ratelimit.failed_token(c.ip, n)
    return [r for r in found if r is not None]


@router.post("/receipts/lookup")
def lookup(body: Lookup, request: Request) -> dict[str, Any]:
    c = caller(request)
    status_request(c)
    return {"items": proven(c, body.items)}


_CURSOR = re.compile(r"^(\d{1,12})\.([0-9A-Za-z]{10})$")


@router.get("/me/receipts")
def my_receipts(request: Request, cursor: str | None = None) -> dict[str, Any]:
    """The account's receipts, newest first, PAGE at a time: follow `next` until it is null."""
    c = require_session(request)
    status_request(c)
    after: tuple[int, str] | None = None
    if cursor:
        m = _CURSOR.match(cursor)
        if not m:
            raise invalid("cursor", "Use the next value from the previous page.")
        after = (int(m.group(1)), m.group(2))
    rows = db.all("SELECT secret_id, manage_hash, added_at FROM user_receipts WHERE user_id = ? "
                  + ("AND (added_at, secret_id) < (?, ?) " if after else "")
                  + "ORDER BY added_at DESC, secret_id DESC LIMIT ?", c.user_id, *(after or ()), PAGE + 1)
    page = rows[:PAGE]
    found = receipts([(r["secret_id"], r["manage_hash"]) for r in page], with_events=False)
    last = page[-1] if len(rows) > PAGE else None
    return {"items": [r for r in found if r is not None], "next": f"{last['added_at']}.{last['secret_id']}" if last else None}


class Attach(Body):
    items: list[Pair] = Field(min_length=1, max_length=ATTACH)


@router.post("/me/receipts")
def attach(body: Attach, request: Request) -> dict[str, Any]:
    """Save links this browser holds to the signed-in account (links made before signing in, or kept here when the
    account couldn't save them), so their statuses follow the account. Each must prove its manage token; as for a
    lookup, a wrong token counts toward RATE_FAILED_TOKENS only for an ID that exists or has a tombstone."""
    c = require_session(request)
    status_request(c)
    hashes = {p.id: token_hash(p.manage_token) for p in body.items}
    ids = [r["id"] for r in proven(c, body.items, with_events=False)]
    with db.tx() as conn:
        conn.executemany("INSERT OR IGNORE INTO user_receipts(user_id, secret_id, manage_hash, added_at) VALUES (?,?,?,?)",
                         [(c.user_id, i, hashes[i], now()) for i in ids])
    return {"attached": ids}


@router.delete("/me/receipts/{secret_id}", status_code=204)
def detach(secret_id: str, request: Request) -> Response:
    c = require_session(request)
    db.run("DELETE FROM user_receipts WHERE user_id = ? AND secret_id = ?", c.user_id, secret_id)
    return Response(status_code=204)


@router.get("/receipts/{secret_id}")
def get_receipt(secret_id: str, request: Request) -> dict[str, Any]:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    presented = cap_hash(request, "Manage")
    h = presented
    if h is None and c.user_id:
        h = db.val("SELECT manage_hash FROM user_receipts WHERE user_id = ? AND secret_id = ?", c.user_id, secret_id)
    out = receipt(secret_id, h)
    if out is None:
        # Counted only for an ID that exists (or has a tombstone): Your links asks about items long gone.
        raise deny(c, presented=presented is not None and known(secret_id))
    return out
