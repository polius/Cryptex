"""Webhook delivery: signed JSON POSTs with retries (events.md → Webhooks)."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
from typing import Any
from urllib.parse import urlparse

import httpx

from . import db, security
from .events import emit
from .util import iso, now

log = logging.getLogger("cryptex.webhooks")
RETRIES = [60, 300, 1800, 7200, 43200]
TIMEOUT = 10

LABELS = {
    "secret.created": "A link was created", "secret.revealed": "A link was opened",
    "secret.passphrase_failed": "A wrong passphrase was entered", "secret.destroyed": "A link was destroyed",
    "secret.expired": "A link expired", "request.created": "A request was created",
    "request.answered": "A request was answered", "request.cancelled": "A request was cancelled",
    "request.expired": "A request expired", "user.role_changed": "A role changed",
    "token.created": "An API token was created", "token.revoked": "An API token was revoked",
    "setting.changed": "A setting changed",
}


def new_secret() -> tuple[str, bytes]:
    s = "whsec_" + secrets.token_urlsafe(32)
    return s, security.seal("webhook", s.encode())


def payload(ev: Any) -> dict[str, Any]:
    item = None
    if ev["secret_id"]:
        item = {"kind": "secret", "id": ev["secret_id"]}
    elif ev["request_id"]:
        item = {"kind": "request", "id": ev["request_id"]}
    return {"id": ev["id"], "type": ev["type"], "at": iso(ev["at"]), "item": item, "actor": ev["actor"],
            "detail": json.loads(ev["detail"])}


def sign(secret: str, ts: int, body: bytes) -> str:
    return f"t={ts},v1=" + hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


def is_slack(url: str) -> bool:
    return (urlparse(url).hostname or "") == "hooks.slack.com"


def deliver_one(hook: Any, ev: Any, client: httpx.Client) -> tuple[bool, int | None, str | None]:
    p = payload(ev)
    if is_slack(hook["url"]):
        short = f" ({p['item']['id'][:4]}…)" if p["item"] else ""
        body = json.dumps({"text": f"{LABELS.get(p['type'], p['type'])}{short}"}).encode()
    else:
        body = json.dumps(p, separators=(",", ":")).encode()
    secret = security.unseal("webhook", hook["secret_ct"]).decode()
    ts = now()
    headers = {"Content-Type": "application/json", "User-Agent": "Cryptex-Webhooks/3",
               "Cryptex-Event": p["type"], "Cryptex-Delivery": secrets.token_hex(12),
               "Cryptex-Signature": sign(secret, ts, body)}
    try:
        r = client.post(hook["url"], content=body, headers=headers, timeout=TIMEOUT)
        return 200 <= r.status_code < 300, r.status_code, None if r.status_code < 300 else f"HTTP {r.status_code}"
    except httpx.HTTPError as e:
        return False, None, type(e).__name__


def run(client: httpx.Client | None = None) -> int:
    due = db.all(
        "SELECT d.id AS delivery_id, d.attempts, w.*, e.id AS ev_id FROM webhook_deliveries d "
        "JOIN webhooks w ON w.id = d.webhook_id JOIN events e ON e.id = d.event_id "
        "WHERE d.done = 0 AND d.next_attempt_at <= ? ORDER BY d.id LIMIT 100", now())
    if not due:
        return 0
    own = client is None
    client = client or httpx.Client(follow_redirects=False)
    sent = 0
    try:
        for d in due:
            ev = db.one("SELECT * FROM events WHERE id = ?", d["ev_id"])
            ok, status, err = deliver_one(d, ev, client)
            attempts = d["attempts"] + 1
            db.run("UPDATE webhooks SET last_status = ?, last_error = ?, last_attempt_at = ? WHERE id = ?",
                   status, err, now(), d["id"])
            if ok:
                db.run("UPDATE webhook_deliveries SET done = 1, attempts = ? WHERE id = ?", attempts, d["delivery_id"])
                sent += 1
            elif attempts > len(RETRIES):
                db.run("UPDATE webhook_deliveries SET done = 1, attempts = ? WHERE id = ?", attempts, d["delivery_id"])
                emit("webhook.failed", actor="system", detail={"webhook_id": d["id"], "status": status})
            else:
                db.run("UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ? WHERE id = ?",
                       attempts, now() + RETRIES[attempts - 1], d["delivery_id"])
    finally:
        if own:
            client.close()
    return sent
