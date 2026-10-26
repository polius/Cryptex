"""SQLite access: one connection per thread, WAL mode, numbered migrations.

Handlers that touch the database are plain `def` functions, so FastAPI runs them in
its thread pool and the event loop never blocks on disk I/O.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from importlib import resources
from pathlib import Path
from typing import Any

_local = threading.local()
_path: Path | None = None
_generation = 0  # bumped by reset() so threads drop connections to an old file


def configure(path: Path) -> None:
    global _path, _generation
    _path = path
    _generation += 1
    migrate()


def _connect() -> sqlite3.Connection:
    assert _path is not None, "db.configure() not called"
    c = sqlite3.connect(_path, isolation_level=None, check_same_thread=False, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode = WAL")
    c.execute("PRAGMA synchronous = NORMAL")
    c.execute("PRAGMA foreign_keys = ON")
    c.execute("PRAGMA busy_timeout = 30000")
    return c


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None or getattr(_local, "gen", -1) != _generation:
        c = _local.conn = _connect()
        _local.gen = _generation
    return c


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """A write transaction. BEGIN IMMEDIATE takes the write lock up front, so
    read-then-write sequences (counting views, tries) can't race."""
    c = conn()
    if c.in_transaction:  # nested: join the outer transaction
        yield c
        return
    c.execute("BEGIN IMMEDIATE")
    try:
        yield c
    except BaseException:
        c.execute("ROLLBACK")
        raise
    else:
        c.execute("COMMIT")


def one(sql: str, *args: Any) -> sqlite3.Row | None:
    return conn().execute(sql, args).fetchone()


def all(sql: str, *args: Any) -> list[sqlite3.Row]:  # noqa: A001
    return conn().execute(sql, args).fetchall()


def val(sql: str, *args: Any) -> Any:
    r = conn().execute(sql, args).fetchone()
    return None if r is None else r[0]


def run(sql: str, *args: Any) -> sqlite3.Cursor:
    return conn().execute(sql, args)


def migrate() -> int:
    c = conn()
    c.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)")
    current = c.execute("SELECT coalesce(max(version), 0) FROM schema_version").fetchone()[0]
    files = sorted(
        (int(f.name.split("_", 1)[0]), f)
        for f in resources.files("cryptex.migrations").iterdir()
        if f.name.endswith(".sql")
    )
    for version, f in files:
        if version <= current:
            continue
        c.execute("BEGIN IMMEDIATE")
        try:
            for statement in _split(f.read_text()):
                c.execute(statement)
            c.execute("INSERT INTO schema_version VALUES (?, ?)", (version, int(time.time())))
            c.execute("COMMIT")
        except BaseException:
            c.execute("ROLLBACK")
            raise
        current = version
    return current


def _split(script: str) -> list[str]:
    out, buf = [], []
    for line in script.splitlines():
        stripped = line.split("--", 1)[0] if "--" in line and "'" not in line else line
        buf.append(stripped)
        if stripped.rstrip().endswith(";") and sqlite3.complete_statement("\n".join(buf)):
            stmt = "\n".join(buf).strip()
            if stmt.strip(";").strip():
                out.append(stmt)
            buf = []
    tail = "\n".join(buf).strip()
    if tail:
        out.append(tail)
    return out
