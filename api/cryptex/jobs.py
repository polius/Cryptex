"""Background jobs, run in-process and tracked in the `jobs` table."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from fastapi.concurrency import run_in_threadpool

from . import db, demo, items, ratelimit, state
from .util import now

log = logging.getLogger("cryptex.jobs")


def cleanup() -> int:
    t = now()
    removed = 0
    no_download = "NOT EXISTS (SELECT 1 FROM read_sessions s WHERE s.secret_id = secrets.id AND s.expires_at > ?)"
    # Last view used and its read session ended (whether or not it has expired meanwhile).
    for r in db.all(f"SELECT id FROM secrets WHERE consumed_at IS NOT NULL AND {no_download}", t):
        items.purge_secret(r["id"], "opened")
        removed += 1
    # Sealed secrets past their expiry, once no download is in progress: tombstone "expired". (Unsealed uploads go
    # only by the idle rule below: their lifetime starts at seal.)
    for r in db.all(f"SELECT id, views FROM secrets WHERE sealed = 1 AND consumed_at IS NULL AND expires_at <= ? AND {no_download}", t, t):
        items.purge_secret(r["id"], "expired", event=("secret.expired", {"views_used": r["views"]}))
        removed += 1
    # Unsealed uploads idle for 30 minutes never existed for anyone.
    for r in db.all("SELECT id FROM secrets WHERE sealed = 0 AND upload_active_at < ?", t - items.UPLOAD_IDLE):
        items.drop_upload(r["id"])
        removed += 1
    # Requests never sealed (their link was never shown); and any request as long after it ended as Your links keeps
    # ended items: its answer, and the answer's tombstone, are gone by then.
    db.run("DELETE FROM requests WHERE ask_ct IS NULL AND closed_at IS NULL AND created_at < ?", t - items.UPLOAD_IDLE)
    db.run("DELETE FROM requests WHERE coalesce(closed_at, expires_at) < ?", t - items.TOMBSTONE_DAYS * 86400)
    for table, col in (("read_sessions", "expires_at"), ("sessions", "expires_at"), ("mfa_tickets", "expires_at"),
                       ("pow_used", "expires_at"), ("reset_links", "expires_at")):
        db.run(f"DELETE FROM {table} WHERE {col} < ?", t)
    db.run("UPDATE users SET temp_key_hash = NULL, temp_expires_at = NULL WHERE temp_expires_at <= ?", t)
    state.forget_old_temp_passwords()
    ratelimit.purge()
    return removed


def tombstones() -> int:
    """Tombstones past purge_after, and the account receipts of secrets now gone without a trace (Your links keeps
    an ended item as long as its tombstone: TOMBSTONE_DAYS)."""
    n = db.run("DELETE FROM tombstones WHERE purge_after < ?", now()).rowcount
    db.run("DELETE FROM user_receipts WHERE secret_id NOT IN (SELECT id FROM secrets) AND secret_id NOT IN (SELECT id FROM tombstones)")
    return n


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
    """Runs every job on its schedule until cancelled. Nothing a job or the schedule raises stops the loop."""
    last: dict[str, float] = {}
    schedule = [("cleanup", 60, cleanup), ("tombstones", 3600, tombstones), ("audit", 86400, audit)]
    while True:
        try:
            await _tick(last, schedule)
        except Exception:
            log.exception("background jobs: unexpected error")
        await asyncio.sleep(5)


async def _tick(last: dict[str, float], schedule: list[tuple[str, int, Callable[[], int]]]) -> None:
    t = now()
    for name, every, fn in schedule:
        if t - last.get(name, 0) >= every:
            last[name] = t
            await run_in_threadpool(record, name, fn)
    e = state.env()
    day = int(t // demo.DAY)  # the demo is wiped when the UTC day changes (its limit page says 00:00 UTC)
    if e.demo and last.setdefault("demo_day", day) != day:
        last["demo_day"] = day
        await run_in_threadpool(record, "demo_wipe", demo_wipe)
