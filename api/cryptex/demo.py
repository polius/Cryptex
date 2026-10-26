"""DEMO=true: a public instance that shows every feature but is useless to abusers.

Four layers (design/v3, "Public demo"): no action works with an ID alone (everywhere),
per-person limits (IPv4 or IPv6 /64), global circuit breakers, and proof of work
instead of a third-party CAPTCHA.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Any

from fastapi import Request

from . import db, items, ratelimit, state
from .config import Rate
from .deps import Caller
from .errors import ApiError
from .events import emit
from .util import b64u, iso, now, sha256_hex

DAY = 86400
CHALLENGE_TTL = 300


def _pow_key() -> bytes:
    return hashlib.sha256(b"cryptex/pow|" + state.env().enc_key).digest()


def challenge() -> dict[str, Any]:
    rnd = b64u(secrets.token_bytes(16))
    exp = now() + CHALLENGE_TTL
    body = f"{rnd}.{exp}"
    sig = hmac.new(_pow_key(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return {"challenge": f"{body}.{sig}", "bits": state.env().demo_pow_bits, "expires_in": CHALLENGE_TTL}


def leading_zero_bits(digest: bytes) -> int:
    n = 0
    for byte in digest:
        if byte == 0:
            n += 8
            continue
        n += 8 - byte.bit_length()
        break
    return n


def check_pow(header: str | None) -> None:
    bad = ApiError("invalid", "Proof of work missing or expired. Reload the page and try again.", field="X-PoW")
    if not header or header.count(":") != 1:
        raise bad
    chal, nonce = header.split(":")
    try:
        rnd, exp_s, sig = chal.split(".")
        exp = int(exp_s)
    except ValueError:
        raise bad from None
    want = hmac.new(_pow_key(), f"{rnd}.{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(want, sig) or exp < now() or len(nonce) > 32:
        raise bad
    if leading_zero_bits(hashlib.sha256(header.encode()).digest()) < state.env().demo_pow_bits:
        raise bad
    with db.tx() as c:
        if c.execute("SELECT 1 FROM pow_used WHERE challenge_hash = ?", (sha256_hex(chal),)).fetchone():
            raise bad
        c.execute("INSERT INTO pow_used(challenge_hash, expires_at) VALUES (?,?)", (sha256_hex(chal), exp))


def _readonly_until() -> int:
    return int(state.raw("demo_readonly_until", 0) or 0)


def before_create(c: Caller, request: Request, upload_bytes: int, files: int) -> None:
    """Every create in the demo: breakers, then proof of work, then per-person quotas."""
    e = state.env()
    t = now()
    if _readonly_until() > t:
        raise ratelimit.limited(_readonly_until() - t)
    live = int(db.val("SELECT (SELECT count(*) FROM secrets) + (SELECT count(*) FROM requests)") or 0)
    used = items.stored_bytes()
    if live >= e.demo_max_live_items or used + upload_bytes > e.demo_storage_cap:
        _trip("capacity")
        raise ApiError("rate_limited", "The demo is full right now. Links already sent keep working. Try again later.",
                       headers={"Retry-After": "3600"}, reset_at=iso(t + 3600))
    if files and used >= 0.8 * e.demo_storage_cap:
        raise ApiError("limit_exceeded", "Files are paused in the demo right now. Text still works.", field="streams", limit=0)
    check_pow(request.headers.get("x-pow"))
    ratelimit.hit("demo_min", Rate(5, 60), c.subject)
    ratelimit.hit("demo_day", Rate(e.demo_seals_per_day, DAY), c.subject)
    ratelimit.hit("demo_bytes", Rate(e.demo_upload_bytes_per_day, DAY), c.subject, cost=max(0, upload_bytes))
    hour = ratelimit.hit("demo_all", Rate(10**9, 3600), "global")
    if hour > e.demo_seals_per_hour_breaker:
        state.save("demo_readonly_until", t + 3600)
        _trip("seals_per_hour")


def _trip(rule: str) -> None:
    last = state.raw(f"demo_trip_{rule}", 0) or 0
    if now() - last > 3600:
        state.save(f"demo_trip_{rule}", now())
        emit("demo.breaker_tripped", actor="system", detail={"rule": rule})


def quota(c: Caller) -> dict[str, Any]:
    e = state.env()
    used, reset = ratelimit.used("demo_day", Rate(e.demo_seals_per_day, DAY), c.subject)
    return {"used": min(used, e.demo_seals_per_day), "limit": e.demo_seals_per_day, "reset_at": iso(reset)}


def wipe() -> int:
    """Nightly: delete every secret, request, event and receipt. Quotas stay (they reset by day)."""
    with db.tx() as c:
        n = int(c.execute("SELECT (SELECT count(*) FROM secrets) + (SELECT count(*) FROM requests)").fetchone()[0])
        for table in ("chunks", "streams", "read_sessions", "email_codes", "access_grants", "secrets", "requests",
                      "tombstones", "user_receipts", "webhook_deliveries", "events", "sse_tickets", "pow_used"):
            c.execute(f"DELETE FROM {table}")
    from . import storage
    storage.get().wipe()
    return n


def cron_matches(expr: str, ts: int) -> bool:
    """Five-field cron (minute hour day month weekday) in UTC: *, numbers, lists, ranges, steps."""
    import time as _t
    tm = _t.gmtime(ts)
    fields = expr.split()
    if len(fields) != 5:
        return False
    values = [tm.tm_min, tm.tm_hour, tm.tm_mday, tm.tm_mon, (tm.tm_wday + 1) % 7]
    ranges = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]
    for f, v, (lo, hi) in zip(fields, values, ranges, strict=True):
        if not _field_match(f, v, lo, hi):
            return False
    return True


def _field_match(f: str, v: int, lo: int, hi: int) -> bool:
    for part in f.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/")
            step = int(s)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a, b = (int(x) for x in part.split("-"))
        else:
            a = b = int(part)
        if a <= v <= b and (v - a) % step == 0:
            return True
    return False
