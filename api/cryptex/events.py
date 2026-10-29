"""One event table feeds receipts and the audit log. Audit events also go to the log as JSON.

Events never contain content, titles, sender names, file names or IP addresses.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any

from . import db
from .util import iso, now

RECEIPT = {
    "secret.created", "secret.sealed", "secret.revealed", "secret.passphrase_failed",
    "secret.destroyed", "secret.expired",
}
NOT_AUDIT = {"secret.sealed"}
log = logging.getLogger("cryptex.events")


def emit(type_: str, *, secret_id: str | None = None,
         actor: str = "link", user_id: str | None = None, detail: dict[str, Any] | None = None,
         c: sqlite3.Connection | None = None) -> int:
    conn = c or db.conn()
    cur = conn.execute(
        "INSERT INTO events(at, type, secret_id, actor_user_id, actor, detail) VALUES (?,?,?,?,?,?)",
        (now(), type_, secret_id, user_id, actor, json.dumps(detail or {}, separators=(",", ":"))),
    )
    event_id = int(cur.lastrowid or 0)
    if type_ not in NOT_AUDIT:  # one JSON line per audit event, for log pipelines and SIEMs
        log.info("event %s", type_, extra={"event": type_, "event_id": event_id, "secret_id": secret_id,
                                           "actor": actor, "user_id": user_id, "detail": detail or {}})
    return event_id


def as_json(row: sqlite3.Row) -> dict[str, Any]:
    return {"type": row["type"], "at": iso(row["at"]), "detail": json.loads(row["detail"])}

