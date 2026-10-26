"""Process-wide state: the loaded environment and the resolved settings."""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from typing import Any

from . import db
from .config import EDITABLE, Env
from .util import now

_env: Env | None = None
_lock = threading.Lock()
_cache: dict[str, Any] | None = None


def init(env: Env) -> None:
    global _env, _cache
    _env = env
    _cache = None


def env() -> Env:
    assert _env is not None, "state.init() not called"
    return _env


def _saved() -> dict[str, Any]:
    global _cache
    with _lock:
        if _cache is None:
            _cache = {r["key"]: json.loads(r["value"]) for r in db.all("SELECT key, value FROM settings")}
        return dict(_cache)


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


@dataclass(frozen=True)
class Resolved:
    value: Any
    locked_by: str | None  # env var name, "DEMO", or None


def setting(key: str) -> Any:
    return resolve(key).value


def resolve(key: str) -> Resolved:
    e = env()
    s = EDITABLE.get(key)
    if s is not None and key in e.locked:
        return Resolved(e.locked[key], "DEMO" if e.demo and s.demo is not None else s.env)
    saved = _saved()
    if key in saved:
        return Resolved(saved[key], None)
    return Resolved(s.default if s else None, None)


def raw(key: str, default: Any = None) -> Any:
    """Internal settings that aren't in the Server tab (setup step, logo, detected URL)."""
    return _saved().get(key, default)


def save(key: str, value: Any, by: str | None = None) -> None:
    db.run(
        "INSERT INTO settings(key, value, updated_at, updated_by) VALUES (?,?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
        key, json.dumps(value), now(), by,
    )
    invalidate()


def public_url() -> str:
    return env().public_url or raw("detected_url") or "http://localhost:8080"


def brand_name() -> str:
    return setting("brand_name") or "Cryptex"


def owner_exists() -> bool:
    return db.val("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1") is not None


def setup_needed() -> bool:
    return not env().demo and not raw("setup_completed", False)
