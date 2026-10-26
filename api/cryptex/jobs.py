"""Background jobs, run in-process and tracked in the `jobs` table (operations.md)."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from fastapi.concurrency import run_in_threadpool

from . import db, demo, items, ratelimit, state, webhooks
from .util import now

log = logging.getLogger("cryptex.jobs")


def cleanup() -> int:
    t = now()
    removed = 0
    # Secrets past their expiry: tombstone "expired" unless every view was used.
    for r in db.all("SELECT id, sealed, views, consumed_at FROM secrets WHERE expires_at <= ?", t):
        if not r["sealed"]:
            items.purge_secret(r["id"], None)
        elif r["consumed_at"]:
            items.purge_secret(r["id"], "opened")
        else:
            items.purge_secret(r["id"], "expired", event=("secret.expired", {"views_used": r["views"]}))
        removed += 1
    # Last view used and its read session ended.
    for r in db.all("SELECT id FROM secrets WHERE consumed_at IS NOT NULL AND NOT EXISTS "
                    "(SELECT 1 FROM read_sessions s WHERE s.secret_id = secrets.id AND s.expires_at > ?)", t):
        items.purge_secret(r["id"], "opened")
        removed += 1
    # Unsealed uploads idle for 30 minutes never existed for anyone.
    for r in db.all("SELECT id FROM secrets WHERE sealed = 0 AND upload_active_at < ?", t - items.UPLOAD_IDLE):
        items.purge_secret(r["id"], None)
        db.run("DELETE FROM events WHERE secret_id = ?", r["id"])
        db.run("DELETE FROM user_receipts WHERE kind = 'secret' AND item_id = ?", r["id"])
        removed += 1
    for r in db.all("SELECT id FROM requests WHERE sealed = 0 AND created_at < ?", t - items.UPLOAD_IDLE):
        items.purge_request(r["id"], None)
        db.run("DELETE FROM events WHERE request_id = ?", r["id"])
        db.run("DELETE FROM user_receipts WHERE kind = 'request' AND item_id = ?", r["id"])
        removed += 1
    # Requests: link expired unanswered, or the kept answer expired.
    for r in db.all("SELECT id FROM requests WHERE answered_at IS NULL AND expires_at <= ?", t):
        items.purge_request(r["id"], "expired", event=("request.expired", {"answered": False}))
        removed += 1
    for r in db.all("SELECT id FROM requests WHERE answered_at IS NOT NULL AND answered_at + keep_answer_s <= ?", t):
        items.purge_request(r["id"], "expired", event=("request.expired", {"answered": True}))
        removed += 1
    # Abandoned answer uploads: free the space, the responder can start again.
    for r in db.all("SELECT id FROM requests WHERE answered_at IS NULL AND answer_started_at < ?", t - items.UPLOAD_IDLE):
        with db.tx() as c:
            keys = items.purge_answer(c, r["id"])
            c.execute("UPDATE requests SET answer_upload_hash = NULL, answer_started_at = NULL WHERE id = ?", (r["id"],))
        items.delete_blobs(keys)
    for table, col in (("read_sessions", "expires_at"), ("sessions", "expires_at"), ("email_codes", "expires_at"),
                       ("access_grants", "expires_at"), ("mfa_tickets", "expires_at"), ("oidc_states", "expires_at"),
                       ("sse_tickets", "expires_at"), ("pow_used", "expires_at")):
        db.run(f"DELETE FROM {table} WHERE {col} < ?", t)
    ratelimit.purge()
    db.run("DELETE FROM webhook_deliveries WHERE done = 1")
    return removed


def tombstones() -> int:
    return db.run("DELETE FROM tombstones WHERE purge_after < ?", now()).rowcount


def audit() -> int:
    days = int(state.setting("audit_retention_days"))
    return db.run("DELETE FROM events WHERE at < ?", now() - days * 86400).rowcount


def demo_wipe() -> int:
    return demo.wipe()


def record(name: str, fn: Callable[[], int]) -> int:
    try:
        n = fn()
        db.run("INSERT INTO jobs(name, last_run_at, last_result) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE "
               "SET last_run_at = excluded.last_run_at, last_result = excluded.last_result", name, now(), str(n))
        return n
    except Exception:
        log.exception("job %s failed", name)
        db.run("INSERT INTO jobs(name, last_run_at, last_result) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE "
               "SET last_result = excluded.last_result", name, None, "error")
        return 0


async def loop() -> None:
    """Runs every job on its schedule until cancelled."""
    last: dict[str, float] = {}
    schedule = [("cleanup", 60, cleanup), ("tombstones", 3600, tombstones), ("webhooks", 30, webhooks.run),
                ("audit", 86400, audit)]
    while True:
        t = now()
        for name, every, fn in schedule:
            if t - last.get(name, 0) >= every:
                last[name] = t
                await run_in_threadpool(record, name, fn)
        if state.env().demo and demo.cron_matches(state.env().demo_wipe_cron, t) and t - last.get("demo_wipe", 0) > 60:
            last["demo_wipe"] = t
            await run_in_threadpool(record, "demo_wipe", demo_wipe)
        await asyncio.sleep(5)
