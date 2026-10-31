"""Rate limits counted in the app, per IPv4 address and per IPv6 /64.

Fixed windows stored in the `rate_limits` table, so limits hold across restarts. The client address is the one
uvicorn reports: it takes X-Forwarded-For only from TRUSTED_PROXIES (--forwarded-allow-ips).
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass

from fastapi import Request

from . import db, state
from .config import Rate
from .errors import ApiError
from .util import iso, now


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "0.0.0.0"  # noqa: S104 (an address, not a bind)


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
    return f"ip:{a or ip}"


def human(seconds: int) -> str:
    seconds = max(1, seconds)
    h, rem = divmod(seconds, 3600)
    m = -(-rem // 60) if h == 0 else rem // 60
    if h and m:
        return f"{h} h {m} min"
    if h:
        return f"{h} h"
    return f"{max(1, m)} min"


def limited(retry_after: int, reason: str | None = None) -> ApiError:
    return ApiError(
        "rate_limited", f"Too many tries. Try again in {human(retry_after)}.",
        headers={"Retry-After": str(retry_after)}, reset_at=iso(now() + retry_after), reason=reason,
    )


def hit(name: str, rate: Rate, key: str, cost: int = 1, reason: str | None = None) -> int:
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
        raise limited(start + rate.window - t, reason)
    return count


@dataclass(frozen=True)
class Held:
    """One unit reserved against a failure limit (reserve), until it is given back (refund) or kept."""
    bucket: str
    window_start: int


def reserve(name: str, rate: Rate, key: str) -> Held:
    """Failure limits (wrong passwords and codes): take one unit before the work, in one statement, so parallel
    requests can't all pass a check made before any of them counted. Over the limit: 429, and nothing taken."""
    t = now()
    start = t - t % rate.window
    with db.tx() as c:
        count = c.execute(
            "INSERT INTO rate_limits(bucket, window_start, count) VALUES (?,?,1) "
            "ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count",
            (f"{name}:{key}", start),
        ).fetchone()[0]
        if count > rate.count:
            raise limited(start + rate.window - t)  # rolls the increment back
    return Held(f"{name}:{key}", start)


def refund(h: Held) -> None:
    """The attempt wasn't a wrong guess: give its unit back."""
    db.run("UPDATE rate_limits SET count = max(count - 1, 0) WHERE bucket = ? AND window_start = ?", h.bucket, h.window_start)


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


def failed_token(ip: str, n: int = 1) -> None:
    """`n` 404s caused by wrong tokens. After RATE_FAILED_TOKENS, block for an hour."""
    rate = state.env().rate_failed_tokens
    key = subject(ip)
    t = now()
    start = t - t % rate.window
    with db.tx() as c:
        count = c.execute(
            "INSERT INTO rate_limits(bucket, window_start, count) VALUES (?,?,?) "
            "ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + excluded.count RETURNING count",
            (f"failed:{key}", start, n),
        ).fetchone()[0]
        if count >= rate.count:
            c.execute("INSERT OR REPLACE INTO rate_limits(bucket, window_start, count) VALUES (?,?,1)",
                      (f"block:{key}", t + BLOCK_SECONDS))


def purge() -> int:
    """Drop windows older than a day: no window is longer (config.MAX_WINDOW), and blocks are stored with their end
    time."""
    return db.run("DELETE FROM rate_limits WHERE window_start < ?", now() - 86400).rowcount
