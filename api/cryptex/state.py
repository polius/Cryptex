"""Process-wide state: the loaded environment and the resolved settings."""
from __future__ import annotations

import json
import os
import re
import secrets
import socket
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import db
from .config import EDITABLE, Env
from .util import now

_env: Env | None = None
_lock = threading.Lock()
_cache: tuple[int, dict[str, Any]] | None = None  # (settings_version.v it was read at, the settings)


def init(env: Env) -> None:
    global _env, _cache
    _env = env
    _cache = None


def env() -> Env:
    assert _env is not None, "state.init() not called"
    return _env


def _saved() -> dict[str, Any]:
    """Saved settings, cached until settings_version moves: triggers bump it on every change from any process, so a
    `cryptex` command run beside the server (owner reset reopening setup, say) takes effect without a restart."""
    global _cache
    version = db.val("SELECT v FROM settings_version")  # before the read: a change in between only reloads again
    with _lock:
        if _cache is None or _cache[0] != version:
            _cache = (version, {r["key"]: json.loads(r["value"]) for r in db.all("SELECT key, value FROM settings")})
        return dict(_cache[1])


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


def brand_name() -> str:
    return setting("brand_name") or "Cryptex"


def owner_exists() -> bool:
    return db.val("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1") is not None


def setup_needed() -> bool:
    return not env().demo and not raw("setup_completed", False)


SETUP_CODE_FILE = "setup-code"
DOCKERENV = Path("/.dockerenv")  # Docker creates it in every container


def cli_command(*args: str) -> str | None:
    """A `cryptex` command to run on the host, for screens that point at one; None outside a Docker container.
    Docker makes a container's hostname its short ID, which `docker exec` takes whatever the container is named.
    With a custom hostname (or host networking) fall back to the name the README and compose file use."""
    if not DOCKERENV.exists():
        return None
    host = socket.gethostname()
    return f"docker exec {host if re.fullmatch(r'[0-9a-f]{12}', host) else 'cryptex'} cryptex {' '.join(args)}"


def setup_code() -> str:
    """The code that claims a fresh install: made on first use and kept in DATA_DIR/setup-code, so it survives restarts
    and `cryptex setup-code` (another process) shows the same one."""
    path = env().data_dir / SETUP_CODE_FILE
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if code := path.read_text().strip():
            return code
        path.unlink(missing_ok=True)  # left empty by a crash mid-write: never let "" be the code
        return setup_code()
    code = "-".join(secrets.token_hex(2).upper() for _ in range(3))
    with os.fdopen(fd, "w") as f:
        f.write(code + "\n")
    return code


def forget_setup_code() -> None:
    """The owner exists: the code has done its job."""
    (env().data_dir / SETUP_CODE_FILE).unlink(missing_ok=True)


# ------------------------------------------------------------------ temporary passwords
# "Forgot your password?" leaves one in DATA_DIR/temp-passwords/<username>, for whoever runs the server to read
# (`cryptex temp-password USERNAME`) and pass on. Files, not the database, so the folder is the hand-off.
TEMP_DIR = "temp-passwords"
TEMP_TTL = 86400
_TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # lower case only: the browser derives keys from it as typed


def _temp_path(username: str) -> Path:
    return env().data_dir / TEMP_DIR / username


def make_temp_password(username: str) -> str:
    """A new temporary password for this account (16 characters, about 79 bits), replacing any earlier one."""
    pw = "-".join("".join(secrets.choice(_TEMP_ALPHABET) for _ in range(4)) for _ in range(4))
    folder = env().data_dir / TEMP_DIR
    folder.mkdir(mode=0o700, exist_ok=True)
    tmp = folder / f".{username}.{secrets.token_hex(4)}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(pw + "\n")
    os.replace(tmp, _temp_path(username))
    return pw


def temp_password(username: str) -> str | None:
    """The account's temporary password, if one was asked for in the last 24 hours."""
    path = _temp_path(username)
    try:
        if path.stat().st_mtime > now() - TEMP_TTL and (pw := path.read_text().strip()):
            return pw
    except FileNotFoundError:
        return None
    path.unlink(missing_ok=True)
    return None


def forget_temp_password(username: str) -> None:
    _temp_path(username).unlink(missing_ok=True)


def forget_old_temp_passwords() -> None:
    """The cleanup job: nothing stays in the folder past its 24 hours, read or not (nor a crash's half-written file)."""
    folder = env().data_dir / TEMP_DIR
    for p in folder.glob("*") if folder.is_dir() else []:
        try:
            if p.stat().st_mtime <= now() - TEMP_TTL:
                p.unlink(missing_ok=True)
        except FileNotFoundError:
            pass
