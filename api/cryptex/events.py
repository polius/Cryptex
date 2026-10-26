"""One event table feeds receipts, live updates, webhooks, emails and the audit log.

Events never contain content, titles, sender names, file names or IP addresses.
See design/v3/spec/events.md.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from . import db
from .util import iso, now

WEBHOOK = {
    "secret.created", "secret.revealed", "secret.passphrase_failed", "secret.destroyed", "secret.expired",
    "request.created", "request.answered", "request.cancelled", "request.expired",
    "user.role_changed", "token.created", "token.revoked", "setting.changed",
}
RECEIPT = {
    "secret.created", "secret.sealed", "secret.revealed", "secret.passphrase_failed", "secret.code_failed",
    "secret.destroyed", "secret.expired", "request.created", "request.answered", "request.answer_read",
    "request.cancelled", "request.expired",
}
NOT_AUDIT = {"secret.sealed"}

# Highest event ID written by this process; live-update streams poll only when it moves.
latest_id = 0


def emit(type_: str, *, secret_id: str | None = None, request_id: str | None = None,
         actor: str = "link", user_id: str | None = None, detail: dict[str, Any] | None = None,
         c: sqlite3.Connection | None = None) -> int:
    global latest_id
    conn = c or db.conn()
    cur = conn.execute(
        "INSERT INTO events(at, type, secret_id, request_id, actor_user_id, actor, detail) VALUES (?,?,?,?,?,?,?)",
        (now(), type_, secret_id, request_id, user_id, actor, json.dumps(detail or {}, separators=(",", ":"))),
    )
    event_id = int(cur.lastrowid or 0)
    if type_ in WEBHOOK:
        for (hook_id, events) in conn.execute("SELECT id, events FROM webhooks").fetchall():
            if events == "*" or type_ in events.split(","):
                conn.execute(
                    "INSERT INTO webhook_deliveries(webhook_id, event_id, next_attempt_at) VALUES (?,?,?)",
                    (hook_id, event_id, now()),
                )
    latest_id = max(latest_id, event_id)
    return event_id


def as_json(row: sqlite3.Row) -> dict[str, Any]:
    return {"type": row["type"], "at": iso(row["at"]), "detail": json.loads(row["detail"])}


def for_item(kind: str, item_id: str) -> list[dict[str, Any]]:
    col = "secret_id" if kind == "secret" else "request_id"
    rows = db.all(f"SELECT type, at, detail FROM events WHERE {col} = ? ORDER BY id", item_id)
    return [as_json(r) for r in rows if r["type"] in RECEIPT]
