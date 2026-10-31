"""Configuration: environment variables, saved settings and demo overrides.

Precedence, strongest first: DEMO=true forced values, environment variables
(which lock the setting in the Server tab), values saved in the Server tab,
built-in defaults. README.md lists every variable.
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
import re
import secrets
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("cryptex.config")

KB, MB, GB = 1024, 1024**2, 1024**3
MAX_LIFETIME = 100 * 365 * 86400  # longest link lifetime: its expiry must stay a valid date
MAX_WINDOW = 86400          # rate-limit windows: counters (they hold addresses) are purged after a day
_BIG = 2**53                # no size, duration or count is near this; larger input is a typo, not a setting

_SIZE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$", re.I)
_DUR = re.compile(r"^\s*(\d+)\s*(s|m|h|d)?\s*$", re.I)
_RATE = re.compile(r"^\s*(\d+)\s*/\s*(\d*)\s*(s|m|h|d)\s*$", re.I)
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def _bounded(n: float) -> int:
    if not n < _BIG:  # also catches inf and nan
        raise ValueError("is far too large")
    return int(n)


def parse_int(v: Any) -> int:
    """A whole number, as a JSON number or a string of digits (1.7, true or "1e3" are refused, not rounded)."""
    if isinstance(v, bool) or not isinstance(v, int | str):
        raise ValueError("must be a whole number")
    if isinstance(v, str):
        if not v.strip().isdigit() or len(v.strip()) > 15:
            raise ValueError("must be a whole number" if not v.strip().isdigit() else "is far too large")
        v = int(v.strip())
    return _bounded(v)


def parse_size(v: Any) -> int:
    if isinstance(v, int) and not isinstance(v, bool):
        return _bounded(v)
    m = _SIZE.match(v) if isinstance(v, str) and len(v) <= 32 else None
    if not m:
        raise ValueError(f"isn't a size: use a number with kb, mb or gb, like 500kb or 10mb ({str(v)[:32]!r})")
    mult = {"b": 1, "kb": KB, "mb": MB, "gb": GB}[(m.group(2) or "b").lower()]
    return _bounded(float(m.group(1)) * mult)


def parse_duration(v: Any) -> int:
    if isinstance(v, int) and not isinstance(v, bool):
        return _bounded(v)
    m = _DUR.match(v) if isinstance(v, str) and len(v) <= 32 else None
    if not m:
        raise ValueError(f"isn't a duration: use a number with m, h or d, like 30m, 24h or 7d ({str(v)[:32]!r})")
    return _bounded(int(m.group(1)) * _UNITS[(m.group(2) or "s").lower()])


def parse_rate(v: str) -> tuple[int, int]:
    """'60/h' -> (60, 3600); '10/15m' -> (10, 900)."""
    m = _RATE.match(v) if len(v) <= 32 else None
    if not m:
        raise ValueError(f"isn't a rate: use a count per period, like 60/h or 10/15m ({v[:32]!r})")
    return _bounded(int(m.group(1))), _bounded(int(m.group(2) or 1) * _UNITS[m.group(3).lower()])


def parse_bool(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Setting:
    key: str
    env: str
    parse: Callable[[Any], Any]
    default: Any
    lo: int | None = None
    hi: int | None = None
    demo: Any = None


# Settings an owner can change in the Server tab (unless an env var locks them).
EDITABLE: dict[str, Setting] = {s.key: s for s in [
    Setting("access", "ACCESS", lambda v: _choice(v, ("anyone", "signed_in")), "anyone", demo="anyone"),
    Setting("max_expiration", "MAX_EXPIRATION", parse_duration, 7 * 86400, 300, MAX_LIFETIME, demo=3600),
    Setting("max_message_length", "MAX_MESSAGE_LENGTH", parse_int, 10_000, 100, None, demo=500),
    Setting("max_files", "MAX_FILES", parse_int, 5, 0, None, demo=1),
    Setting("max_file_size", "MAX_FILE_SIZE", parse_size, 100 * MB, 1 * KB, None, demo=1 * MB),
    Setting("audit_retention_days", "AUDIT_RETENTION_DAYS", parse_int, 365, 1, 3650),
    Setting("brand_name", "BRAND_NAME", lambda v: _text(v, 40), "", demo=""),
]}


def _choice(v: Any, options: tuple[str, ...]) -> str:
    if not isinstance(v, str) or v not in options:
        raise ValueError(f"must be one of {', '.join(options)}")
    return v


def _text(v: Any, max_len: int) -> str:
    v = str(v).strip()
    if len(v) > max_len:
        raise ValueError(f"must be at most {max_len} characters")
    return v


def validate_setting(key: str, value: Any) -> Any:
    """Parse and range-check a value from the Server tab. Raises ValueError with a message."""
    s = EDITABLE[key]
    v = s.parse(value)
    if s.lo is not None and v < s.lo:
        raise ValueError(f"must be at least {_show(s, s.lo)}")
    if s.hi is not None and v > s.hi:
        raise ValueError(f"must be at most {_show(s, s.hi)}")
    return v


def _show(s: Setting, n: int) -> str:
    """A bound as people set it: 2gb, 365d, 20."""
    if s.parse is parse_size:
        for unit, size in (("gb", GB), ("mb", MB), ("kb", KB)):
            if n % size == 0:
                return f"{n // size}{unit}"
    if s.parse is parse_duration:
        for unit, secs in (("d", 86400), ("h", 3600), ("m", 60)):
            if n % secs == 0:
                return f"{n // secs}{unit}"
    return str(n)


@dataclass(frozen=True)
class Rate:
    count: int
    window: int


@dataclass
class Env:
    """Everything read from the environment once at startup."""
    data_dir: Path
    enc_key: bytes
    demo: bool
    rate_create: Rate
    rate_reveal: Rate
    rate_auth: Rate        # failed sign-in attempts per IP
    rate_failed_tokens: Rate
    rate_status: Rate      # receipt lookups: Your links, the receipt page
    log_level: str
    log_format: str
    log_ips: bool
    metrics_token: str | None
    static_dir: Path | None
    min_free_disk: int = 1 * GB  # refuse new secrets that would leave less free space than this on DATA_DIR
    locked: dict[str, Any] = field(default_factory=dict)  # setting key -> value from env
    demo_seals_per_day: int = 10
    demo_upload_bytes_per_day: int = 10 * MB
    demo_storage_cap: int = 1 * GB
    demo_seals_per_hour_breaker: int = 500


def _decode_key(raw: str, source: str) -> bytes:
    try:
        key = base64.b64decode(raw.strip(), validate=True)
    except (binascii.Error, ValueError):
        key = b""
    if len(key) != 32:
        raise ValueError(f"{source} must hold 32 random bytes, base64-encoded")
    return key


def _has_accounts(data_dir: Path) -> bool:
    """Does the database already hold accounts (whose secrets an old ENC_KEY protects)?"""
    path = data_dir / "cryptex.db"
    if not path.exists():
        return False
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return c.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None
        finally:
            c.close()
    except sqlite3.Error:
        return False


def _load_enc_key(data_dir: Path) -> bytes:
    """The server key (ENC_KEY in the code): DATA_DIR/enc.key, made on first start (only for a server with no accounts
    yet). create_app checks it against the canary in the database (security.check_canary)."""
    path = data_dir / "enc.key"
    if path.exists():
        return _decode_key(path.read_text(), str(path))
    if _has_accounts(data_dir):
        raise ValueError(f"{path} is missing, but this server already has accounts. Put back the enc.key it was set up "
                         "with (it's in every backup); a new key can't open their data.")
    key = secrets.token_bytes(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(base64.b64encode(key).decode() + "\n")
    log.info("Generated %s, the key that protects this server's sign-in data. Keep it with the data folder: "
             "without it, nobody can sign in.", path)
    return key


def load_env(environ: dict[str, str] | None = None) -> Env:
    e = dict(os.environ if environ is None else environ)
    get = lambda k, d=None: (e.get(k) or "").strip() or d  # noqa: E731
    data_dir = Path(get("DATA_DIR", "/data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    demo = parse_bool(get("DEMO", "false"))

    def rate(k: str, d: str) -> Rate:
        try:
            c, w = parse_rate(get(k, d))
        except ValueError as err:
            raise ValueError(f"{k}: {err}") from None
        if c < 1 or w < 1:
            raise ValueError(f"{k}: use at least 1 per period")
        if w > MAX_WINDOW:
            raise ValueError(f"{k}: use a period of 1 day or less (counters are kept for a day)")
        return Rate(c, w)

    try:
        min_free = parse_size(get("MIN_FREE_DISK", "1gb"))
    except ValueError as err:
        raise ValueError(f"MIN_FREE_DISK: {err}") from None

    static_dir = get("STATIC_DIR")

    env = Env(
        data_dir=data_dir,
        enc_key=_load_enc_key(data_dir),
        demo=demo,
        rate_create=rate("RATE_CREATE", "60/h"),
        rate_reveal=rate("RATE_REVEAL", "120/h"),
        rate_auth=rate("RATE_AUTH", "10/15m"),
        rate_failed_tokens=rate("RATE_FAILED_TOKENS", "30/h"),
        rate_status=rate("RATE_STATUS", "600/h"),
        log_level=get("LOG_LEVEL", "info"),
        log_format=get("LOG_FORMAT", "json"),
        log_ips=parse_bool(get("LOG_IPS", "false")),
        metrics_token=get("METRICS_TOKEN"),
        min_free_disk=min_free,
        static_dir=Path(static_dir) if static_dir else None,
    )

    for s in EDITABLE.values():
        if get(s.env) is not None:
            try:
                env.locked[s.key] = validate_setting(s.key, get(s.env))
            except ValueError as err:
                raise ValueError(f"{s.env}: {err}") from None

    if demo:
        def stricter(k: str, d: int, p: Callable[[str], int] = parse_int) -> int:
            """Demo tuning can only tighten the defaults: a looser value is ignored, a malformed one is an error."""
            v = get(k)
            if not v:
                return d
            try:
                n = p(v)
            except ValueError as err:
                raise ValueError(f"{k}: {err}") from None
            if n < 1:
                raise ValueError(f"{k}: must be at least 1")
            return min(d, n)
        env.demo_seals_per_day = stricter("DEMO_SEALS_PER_DAY", 10)
        env.demo_upload_bytes_per_day = stricter("DEMO_UPLOAD_BYTES_PER_DAY", 10 * MB, parse_size)
        env.demo_storage_cap = stricter("DEMO_STORAGE_CAP", 1 * GB, parse_size)
        for s in EDITABLE.values():
            if s.demo is not None:
                env.locked[s.key] = s.demo
    return env
