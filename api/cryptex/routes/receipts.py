"""Sender-side status: receipts, batch lookup, account sync and live updates (SSE)."""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import Field

from .. import db, events, ratelimit, state
from ..deps import caller, cap_hash, deny, matches, require_session
from ..errors import NotFound
from ..util import is_id, iso, new_token, now, token_hash
from .common import Body

router = APIRouter()
TICKET_TTL = 3600
KEEPALIVE = 25


def receipt(kind: str, item_id: str, manage_hash: str | None, *, with_events: bool = True) -> dict[str, Any] | None:
    """Status of one item if `manage_hash` proves the caller holds its manage token."""
    if not is_id(item_id):
        return None
    out: dict[str, Any] | None = None
    if kind in ("secret", None):
        r = db.one("SELECT * FROM secrets WHERE id = ?", item_id)
        if r is not None and r["sealed"] and matches(r["manage_hash"], manage_hash):
            out = {"id": item_id, "kind": "secret", "status": "opened" if r["views"] else "waiting",
                   "views_left": r["max_views"] - r["views"], "max_views": r["max_views"],
                   "created_at": iso(r["created_at"]), "expires_at": iso(r["expires_at"]),
                   "access": r["access"], "passphrase": r["passcheck_hash"] is not None}
    if out is None and kind in ("request", None):
        r = db.one("SELECT * FROM requests WHERE id = ?", item_id)
        if r is not None and r["sealed"] and matches(r["manage_hash"], manage_hash):
            status = "revealed" if r["answer_read_at"] else "answered" if r["answered_at"] else "waiting"
            out = {"id": item_id, "kind": "request", "status": status, "created_at": iso(r["created_at"]),
                   "expires_at": iso(r["expires_at"]), "answered_at": iso(r["answered_at"]),
                   "kept_until": iso(r["answered_at"] + r["keep_answer_s"]) if r["answered_at"] else None}
    if out is None:
        q = "SELECT * FROM tombstones WHERE id = ?" + (" AND kind = ?" if kind else "")
        t = db.one(q, *([item_id, kind] if kind else [item_id]))
        if t is not None and matches(t["manage_hash"], manage_hash):
            status = {"opened": "opened", "expired": "expired", "destroyed": "destroyed", "too_many_tries": "destroyed",
                      "cancelled": "cancelled", "answered": "revealed"}[t["reason"]]
            out = {"id": item_id, "kind": t["kind"], "status": status, "reason": t["reason"], "ended_at": iso(t["at"])}
            if t["kind"] == "secret":
                out["views_left"] = 0 if t["reason"] == "opened" else None
    if out is not None and with_events:
        out["events"] = events.for_item(out["kind"], item_id)
    return out


def _user_receipt_hash(user_id: str, item_id: str) -> tuple[str, str] | None:
    r = db.one("SELECT kind, manage_hash FROM user_receipts WHERE user_id = ? AND item_id = ?", user_id, item_id)
    return (r["kind"], r["manage_hash"]) if r else None


class Pair(Body):
    id: str
    manage_token: str


class Lookup(Body):
    items: list[Pair] = Field(default_factory=list, max_length=200)


@router.post("/receipts/lookup")
def lookup(body: Lookup, request: Request) -> dict[str, Any]:
    c = caller(request)
    ratelimit.hit("reveal", state.env().rate_reveal, c.subject)
    out = []
    for p in body.items:
        r = receipt(None, p.id, token_hash(p.manage_token))  # type: ignore[arg-type]
        if r is not None:
            out.append(r)
    return {"items": out}


class Attach(Body):
    id: str
    manage_token: str
    kind: Literal["secret", "request"]


@router.get("/me/receipts")
def my_receipts(request: Request) -> dict[str, Any]:
    c = require_session(request)
    rows = db.all("SELECT kind, item_id, manage_hash FROM user_receipts WHERE user_id = ? ORDER BY added_at DESC LIMIT 500", c.user_id)
    out = []
    for r in rows:
        rec = receipt(r["kind"], r["item_id"], r["manage_hash"], with_events=False)
        if rec is not None:
            out.append(rec)
    return {"items": out}


@router.post("/me/receipts", status_code=204)
def attach(body: Attach, request: Request) -> Response:
    c = require_session(request)
    h = token_hash(body.manage_token)
    if receipt(body.kind, body.id, h, with_events=False) is None:
        raise deny(c)
    db.run("INSERT OR IGNORE INTO user_receipts(user_id, kind, item_id, manage_hash, added_at) VALUES (?,?,?,?,?)",
           c.user_id, body.kind, body.id, h, now())
    return Response(status_code=204)


@router.delete("/me/receipts/{item_id}", status_code=204)
def detach(item_id: str, request: Request) -> Response:
    c = require_session(request)
    db.run("DELETE FROM user_receipts WHERE user_id = ? AND item_id = ?", c.user_id, item_id)
    return Response(status_code=204)


# ------------------------------------------------------------------ live updates
@router.post("/receipts/subscribe")
def subscribe(body: Lookup, request: Request) -> dict[str, Any]:
    c = caller(request)
    proven: list[list[str]] = []
    for p in body.items:
        r = receipt(None, p.id, token_hash(p.manage_token), with_events=False)  # type: ignore[arg-type]
        if r is not None:
            proven.append([r["kind"], p.id])
    ticket, h = new_token()
    db.run("DELETE FROM sse_tickets WHERE expires_at < ?", now())
    db.run("INSERT INTO sse_tickets(ticket_hash, items, user_id, expires_at) VALUES (?,?,?,?)",
           h, json.dumps(proven), c.user_id if c.via == "session" else None, now() + TICKET_TTL)
    return {"ticket": ticket, "expires_in": TICKET_TTL}


def _ticket(ticket: str) -> tuple[list[str], list[str]] | None:
    h = token_hash(ticket)
    row = db.one("SELECT * FROM sse_tickets WHERE ticket_hash = ? AND expires_at > ?", h, now()) if h else None
    if row is None:
        return None
    pairs = json.loads(row["items"])
    if row["user_id"]:
        pairs += [[r["kind"], r["item_id"]] for r in db.all("SELECT kind, item_id FROM user_receipts WHERE user_id = ?", row["user_id"])]
    secrets = sorted({i for k, i in pairs if k == "secret"})
    requests = sorted({i for k, i in pairs if k == "request"})
    return secrets, requests


def _new_events(secrets: list[str], requests: list[str], after: int) -> list[dict[str, Any]]:
    if not secrets and not requests:
        return []
    q = (f"SELECT * FROM events WHERE id > ? AND (secret_id IN ({','.join('?' * len(secrets)) or 'NULL'}) "
         f"OR request_id IN ({','.join('?' * len(requests)) or 'NULL'})) ORDER BY id LIMIT 200")
    out = []
    for e in db.all(q, after, *secrets, *requests):
        if e["type"] not in events.RECEIPT:
            continue
        kind = "secret" if e["secret_id"] else "request"
        item_id = e["secret_id"] or e["request_id"]
        status = _status_after(kind, e["type"], json.loads(e["detail"]))
        out.append({"id": e["id"], "data": {"kind": kind, "id": item_id, "status": status,
                                             **({"views_left": json.loads(e["detail"]).get("views_left")} if e["type"] == "secret.revealed" else {}),
                                             "event": events.as_json(e)}})
    return out


def _status_after(kind: str, type_: str, detail: dict[str, Any]) -> str | None:
    return {
        "secret.revealed": "opened", "secret.destroyed": "destroyed", "secret.expired": "expired",
        "request.answered": "answered", "request.answer_read": "revealed", "request.cancelled": "cancelled",
        "request.expired": "expired", "secret.sealed": "waiting", "request.created": "waiting",
    }.get(type_)


@router.get("/receipts/events")
async def stream(request: Request, ticket: str = "") -> StreamingResponse:
    found = await run_in_threadpool(_ticket, ticket)
    if found is None:
        raise NotFound()
    secrets, requests = found
    last = request.headers.get("last-event-id", "")
    after = int(last) if last.isdigit() else int(await run_in_threadpool(db.val, "SELECT coalesce(max(id), 0) FROM events") or 0)

    async def gen() -> AsyncIterator[bytes]:
        nonlocal after
        yield b"retry: 5000\n\n"
        seen = -1
        quiet = 0.0
        while not await request.is_disconnected():
            if events.latest_id != seen:
                seen = events.latest_id
                for ev in await run_in_threadpool(_new_events, secrets, requests, after):
                    after = ev["id"]
                    yield f"event: receipt\nid: {ev['id']}\ndata: {json.dumps(ev['data'], separators=(',', ':'))}\n\n".encode()
                quiet = 0
            await asyncio.sleep(0.5)
            quiet += 0.5
            if quiet >= KEEPALIVE:
                quiet = 0
                seen = -1  # also re-check the table now and then (events from other processes)
                yield b": keep-alive\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/receipts/{item_id}")
def get_receipt(item_id: str, request: Request) -> dict[str, Any]:
    c = caller(request)
    ratelimit.check_blocked(c.ip)
    h = cap_hash(request, "Manage")
    kind = None
    if h is None and c.user_id:
        found = _user_receipt_hash(c.user_id, item_id)
        if found:
            kind, h = found
    out = receipt(kind, item_id, h) if h else None  # type: ignore[arg-type]
    if out is None:
        raise deny(c, presented=cap_hash(request, "Manage") is not None)
    return out
