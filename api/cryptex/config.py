"""Configuration: environment variables, saved settings and demo overrides.

Precedence, strongest first: DEMO=true forced values, environment variables
(which lock the setting in the Server tab), values saved in the Server tab,
built-in defaults. See design/v3/spec/config.md.
"""
from __future__ import annotations

import base64
import ipaddress
import logging
import os
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("cryptex.config")

KB, MB, GB = 1024, 1024**2, 1024**3
HARD_MAX_FILE = 10 * GB

_SIZE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$", re.I)
_DUR = re.compile(r"^\s*(\d+)\s*(s|m|h|d)?\s*$", re.I)
_RATE = re.compile(r"^\s*(\d+)\s*/\s*(\d*)\s*(s|m|h|d)\s*$", re.I)
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_size(v: str | int) -> int:
    if isinstance(v, int):
        return v
    m = _SIZE.match(v)
    if not m:
        raise ValueError(f"not a size: {v!r} (use 500kb, 10mb, 1gb)")
    mult = {"b": 1, "kb": KB, "mb": MB, "gb": GB}[(m.group(2) or "b").lower()]
    return int(float(m.group(1)) * mult)


def parse_duration(v: str | int) -> int:
    if isinstance(v, int):
        return v
    m = _DUR.match(v)
    if not m:
        raise ValueError(f"not a duration: {v!r} (use 30m, 24h, 7d)")
    return int(m.group(1)) * _UNITS[(m.group(2) or "s").lower()]


def parse_rate(v: str) -> tuple[int, int]:
    """'60/h' -> (60, 3600); '10/15m' -> (10, 900)."""
    m = _RATE.match(v)
    if not m:
        raise ValueError(f"not a rate: {v!r} (use 60/h or 10/15m)")
    return int(m.group(1)), int(m.group(2) or 1) * _UNITS[m.group(3).lower()]


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
    Setting("max_expiration", "MAX_EXPIRATION", parse_duration, 7 * 86400, 300, 365 * 86400, demo=3600),
    Setting("max_views", "MAX_VIEWS", int, 10, 1, 100, demo=1),
    Setting("max_message_length", "MAX_MESSAGE_LENGTH", int, 10_000, 100, 1_000_000, demo=500),
    Setting("max_files", "MAX_FILES", int, 5, 0, 20, demo=1),
    Setting("max_file_size", "MAX_FILE_SIZE", parse_size, 100 * MB, 1 * KB, HARD_MAX_FILE, demo=1 * MB),
    Setting("request_max_expiration", "REQUEST_MAX_EXPIRATION", parse_duration, 30 * 86400, 300, 365 * 86400, demo=3600),
    Setting("request_max_keep", "REQUEST_MAX_KEEP", parse_duration, 30 * 86400, 300, 365 * 86400, demo=3600),
    Setting("audit_retention_days", "AUDIT_RETENTION_DAYS", int, 365, 1, 3650),
    Setting("brand_name", "BRAND_NAME", lambda v: _text(v, 40), "", demo="Cryptex demo"),
]}


def _choice(v: Any, options: tuple[str, ...]) -> str:
    if v not in options:
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
        raise ValueError(f"must be at least {s.lo}")
    if s.hi is not None and v > s.hi:
        raise ValueError(f"must be at most {s.hi}")
    return v


@dataclass(frozen=True)
class Rate:
    count: int
    window: int


@dataclass
class Env:
    """Everything read from the environment once at startup."""
    data_dir: Path
    public_url: str | None
    enc_key: bytes
    demo: bool
    trusted_proxies: list[ipaddress.IPv4Network | ipaddress.IPv6Network]
    rate_create: Rate
    rate_reveal: Rate
    rate_auth: Rate
    rate_failed_tokens: Rate
    oidc_issuer: str | None
    oidc_client_id: str | None
    oidc_client_secret: str | None
    oidc_allowed_domains: list[str]
    oidc_name: str
    oidc_owner_emails: list[str]
    smtp_url: str | None
    smtp_from: str | None
    log_level: str
    log_format: str
    log_ips: bool
    metrics_token: str | None
    setup_code: str
    static_dir: Path | None
    locked: dict[str, Any] = field(default_factory=dict)  # setting key -> value from env
    demo_seals_per_day: int = 30
    demo_upload_bytes_per_day: int = 10 * MB
    demo_max_live_items: int = 2000
    demo_storage_cap: int = 1 * GB
    demo_pow_bits: int = 18
    demo_wipe_cron: str = "0 0 * * *"
    demo_seals_per_hour_breaker: int = 500

    @property
    def smtp_enabled(self) -> bool:
        return bool(self.smtp_url) and not self.demo

    @property
    def oidc_enabled(self) -> bool:
        return bool(self.oidc_issuer and self.oidc_client_id) and not self.demo


def _load_enc_key(data_dir: Path, raw: str | None) -> bytes:
    if raw:
        key = base64.b64decode(raw)
        if len(key) != 32:
            raise ValueError("ENC_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)")
        return key
    path = data_dir / "enc.key"
    if path.exists():
        return base64.b64decode(path.read_text().strip())
    key = secrets.token_bytes(32)
    path.write_text(base64.b64encode(key).decode() + "\n")
    os.chmod(path, 0o600)
    log.warning("ENC_KEY not set; generated %s. Back it up separately from the data volume.", path)
    return key


def load_env(environ: dict[str, str] | None = None) -> Env:
    e = dict(os.environ if environ is None else environ)
    get = lambda k, d=None: (e.get(k) or "").strip() or d  # noqa: E731
    data_dir = Path(get("DATA_DIR", "/data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    demo = parse_bool(get("DEMO", "false"))

    public_url = get("PUBLIC_URL")
    if public_url:
        public_url = public_url.rstrip("/")
        if not (public_url.startswith("https://") or re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", public_url)):
            raise ValueError("PUBLIC_URL must use https:// (http:// is allowed only for localhost)")

    def rate(k: str, d: str) -> Rate:
        c, w = parse_rate(get(k, d))
        return Rate(c, w)

    proxies = [ipaddress.ip_network(p.strip(), strict=False) for p in (get("TRUSTED_PROXIES", "") or "").split(",") if p.strip()]
    if parse_bool(get("CRYPTEX_BEHIND_NGINX", "false")):  # the container's own nginx, on loopback
        proxies += [ipaddress.ip_network("127.0.0.1/32"), ipaddress.ip_network("::1/128")]
    setup_code = get("SETUP_CODE") or "-".join(secrets.token_hex(2).upper() for _ in range(3))
    static_dir = get("STATIC_DIR")

    env = Env(
        data_dir=data_dir,
        public_url=public_url,
        enc_key=_load_enc_key(data_dir, get("ENC_KEY")),
        demo=demo,
        trusted_proxies=proxies,
        rate_create=rate("RATE_CREATE", "60/h"),
        rate_reveal=rate("RATE_REVEAL", "120/h"),
        rate_auth=rate("RATE_AUTH", "10/15m"),
        rate_failed_tokens=rate("RATE_FAILED_TOKENS", "30/h"),
        oidc_issuer=(get("OIDC_ISSUER") or "").rstrip("/") or None,
        oidc_client_id=get("OIDC_CLIENT_ID"),
        oidc_client_secret=get("OIDC_CLIENT_SECRET"),
        oidc_allowed_domains=[d.strip().lower() for d in (get("OIDC_ALLOWED_DOMAINS", "") or "").split(",") if d.strip()],
        oidc_name=get("OIDC_NAME", "single sign-on"),
        oidc_owner_emails=[x.strip().lower() for x in (get("OIDC_OWNER_EMAILS", "") or "").split(",") if x.strip()],
        smtp_url=get("SMTP_URL"),
        smtp_from=get("SMTP_FROM"),
        log_level=get("LOG_LEVEL", "info"),
        log_format=get("LOG_FORMAT", "json"),
        log_ips=parse_bool(get("LOG_IPS", "false")),
        metrics_token=get("METRICS_TOKEN"),
        setup_code=setup_code,
        static_dir=Path(static_dir) if static_dir else None,
    )

    for s in EDITABLE.values():
        if get(s.env) is not None:
            try:
                env.locked[s.key] = validate_setting(s.key, get(s.env))
            except ValueError as err:
                raise ValueError(f"{s.env}: {err}") from None

    if demo:
        def stricter(k: str, d: int, p: Callable[[str], int] = int) -> int:
            v = get(k)
            return min(d, p(v)) if v else d
        env.demo_seals_per_day = stricter("DEMO_SEALS_PER_DAY", 30)
        env.demo_upload_bytes_per_day = stricter("DEMO_UPLOAD_BYTES_PER_DAY", 10 * MB, parse_size)
        env.demo_max_live_items = stricter("DEMO_MAX_LIVE_ITEMS", 2000)
        env.demo_storage_cap = stricter("DEMO_STORAGE_CAP", 1 * GB, parse_size)
        bits = get("DEMO_POW_BITS")
        env.demo_pow_bits = max(18, int(bits)) if bits else 18  # more bits is stricter
        env.demo_wipe_cron = get("DEMO_WIPE_CRON", "0 0 * * *")
        for s in EDITABLE.values():
            if s.demo is not None:
                env.locked[s.key] = s.demo
    return env
