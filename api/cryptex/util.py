"""Small helpers shared by every module: encodings, IDs, tokens, time."""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets
import string
import time
from datetime import datetime, timezone

BASE62 = string.digits + string.ascii_uppercase + string.ascii_lowercase


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    """Strict base64url decode; raises ValueError on anything malformed."""
    if not isinstance(s, str) or any(ch not in BASE62 + "-_" for ch in s):
        raise ValueError("not base64url")
    try:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (binascii.Error, ValueError) as e:
        raise ValueError("not base64url") from e


def sha256_hex(b: bytes | str) -> str:
    if isinstance(b, str):
        b = b.encode()
    return hashlib.sha256(b).hexdigest()


def new_id(n: int = 10) -> str:
    return "".join(secrets.choice(BASE62) for _ in range(n))


def new_token() -> tuple[str, str]:
    """A 256-bit capability token: (b64u for the client, hex SHA-256 for the database)."""
    raw = secrets.token_bytes(32)
    return b64u(raw), sha256_hex(raw)


def token_hash(token: str) -> str | None:
    """Hash of a b64u capability token as presented by a client, or None if malformed."""
    try:
        raw = unb64u(token)
    except ValueError:
        return None
    return sha256_hex(raw) if len(raw) == 32 else None


def same(a: str | None, b: str | None) -> bool:
    """Constant-time string comparison that never raises (hmac.compare_digest refuses non-ASCII str)."""
    return a is not None and b is not None and hmac.compare_digest(a.encode(), b.encode())


def now() -> int:
    return int(time.time())


def iso(ts: int | float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def from_iso(s: str) -> int:
    """ISO 8601 date or date-time; UTC unless it says otherwise. Raises ValueError."""
    d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    return int((d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp())


def is_id(s: str) -> bool:
    return isinstance(s, str) and len(s) == 10 and all(ch in BASE62 for ch in s)


