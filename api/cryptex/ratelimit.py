"""Rate limits counted in the app, per IPv4 address and per IPv6 /64.

Fixed windows stored in the `rate_limits` table, so limits hold behind any proxy and
across restarts. The client address comes from X-Forwarded-For only when the socket
peer is in TRUSTED_PROXIES.
"""
from __future__ import annotations

import ipaddress

from fastapi import Request

from . import db, state
from .config import Rate
from .errors import ApiError
from .util import iso, now


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else "0.0.0.0"  # noqa: S104 (an address, not a bind)
    proxies = state.env().trusted_proxies
    addr = _parse(peer)
    if proxies and addr is not None and any(addr in n for n in proxies):
        chain = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        for hop in reversed(chain):  # rightmost address not added by a trusted proxy
            a = _parse(hop)
            if a is None:
                break
            addr = a
            if not any(a in n for n in proxies):
                break
    return str(addr) if addr is not None else peer


def _parse(s: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        a = ipaddress.ip_address(s)
    except ValueError:
        return None
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        return a.ipv4_mapped
    return a


def subject(ip: str) -> str:
    """The unit limits are counted per: the IPv4 address, or the IPv6 /64."""
    a = _parse(ip)
    if isinstance(a, ipaddress.IPv6Address):
        return "ip6:" + str(ipaddress.ip_network(f"{a}/64", strict=False))
    return f"ip:{ip}"


def human(seconds: int) -> str:
    seconds = max(1, seconds)
    h, rem = divmod(seconds, 3600)
    m = -(-rem // 60) if h == 0 else rem // 60
    if h and m:
        return f"{h} h {m} min"
    if h:
        return f"{h} h"
    return f"{max(1, m)} min"


def limited(retry_after: int) -> ApiError:
    return ApiError(
        "rate_limited", f"Too many tries. Try again in {human(retry_after)}.",
        headers={"Retry-After": str(retry_after)}, reset_at=iso(now() + retry_after),
    )


def hit(name: str, rate: Rate, key: str, cost: int = 1) -> int:
    """Count `cost` against `name` for `key`; raise 429 when over the limit. Returns the new count."""
    t = now()
    start = t - t % rate.window
    with db.tx() as c:
        count = c.execute(
            "INSERT INTO rate_limits(bucket, window_start, count) VALUES (?,?,?) "
            "ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + excluded.count RETURNING count",
            (f"{name}:{key}", start, cost),
        ).fetchone()[0]
    if count > rate.count:
        raise limited(start + rate.window - t)
    return count


def used(name: str, rate: Rate, key: str) -> tuple[int, int]:
    """(count in the current window, window end)."""
    t = now()
    start = t - t % rate.window
    c = db.val("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?", f"{name}:{key}", start)
    return int(c or 0), start + rate.window


# ------------------------------------------------------------- failed capability tokens
BLOCK_SECONDS = 3600


def check_blocked(ip: str) -> None:
    until = db.val("SELECT max(window_start) FROM rate_limits WHERE bucket = ?", f"block:{subject(ip)}")
    if until and until > now():
        raise limited(until - now())


def failed_token(ip: str) -> None:
    """A 404 caused by a wrong token. After RATE_FAILED_TOKENS, block for an hour."""
    rate = state.env().rate_failed_tokens
    key = subject(ip)
    t = now()
    start = t - t % rate.window
    with db.tx() as c:
        count = c.execute(
            "INSERT INTO rate_limits(bucket, window_start, count) VALUES (?,?,1) "
            "ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count",
            (f"failed:{key}", start),
        ).fetchone()[0]
        if count >= rate.count:
            c.execute("INSERT OR REPLACE INTO rate_limits(bucket, window_start, count) VALUES (?,?,1)",
                      (f"block:{key}", t + BLOCK_SECONDS))


def purge() -> int:
    """Drop windows older than a day (blocks are stored with their end time)."""
    return db.run("DELETE FROM rate_limits WHERE window_start < ?", now() - 86400).rowcount
