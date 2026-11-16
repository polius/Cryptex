"""SQLite access: one connection per thread, WAL mode, numbered migrations.

Handlers that touch the database are plain `def` functions, so FastAPI runs them in
its thread pool and the event loop never blocks on disk I/O.
"""
from __future__ import annotations

import hashlib
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
_generation = 0  # bumped by configure() and close_all() so threads drop connections to an old file
_open: list[sqlite3.Connection] = []  # every thread's connection, for close_all()
_open_lock = threading.Lock()
CHECKPOINT_WAIT = 0.5  # seconds close_all waits for a busy database before leaving the WAL for the next start


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
    # B5: FULL, so a burn (a one-time link's view) survives a power cut; writes here are small and rare. secure_delete,
    # so a destroyed secret's encrypted metadata doesn't linger in free pages of the database file.
    c.execute("PRAGMA synchronous = FULL")
    c.execute("PRAGMA secure_delete = ON")
    c.execute("PRAGMA foreign_keys = ON")
    c.execute("PRAGMA busy_timeout = 30000")
    with _open_lock:
        _open.append(c)
    return c


def close_all() -> None:
    """At shutdown: fold the write-ahead log into the database file and close every connection, so a copy of
    DATA_DIR taken after the server stopped is the whole database (no cryptex.db-wal it depends on) and an old -wal
    file can never be replayed onto a restored one."""
    global _generation
    with _open_lock:
        conns, _open[:] = list(_open), []
        _generation += 1
    for c in conns:
        c.close()  # a transaction some request left open (it can't commit any more) is rolled back
    if _path is not None and _path.exists():
        # Briefly: `docker stop` kills the container 10 s after asking it to stop, and uvicorn may have used 5 of them
        # ending open requests (--timeout-graceful-shutdown). A checkpoint has nothing to wait for unless some other
        # process (a `cryptex backup` in progress) is reading the database.
        c = sqlite3.connect(_path, isolation_level=None, timeout=CHECKPOINT_WAIT)
        try:
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass  # busy: the WAL stays, and SQLite folds it in at the next start
        finally:
            c.close()  # the last connection to close also deletes cryptex.db-wal and -shm


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


V2_TABLES = {"cryptex", "links", "api_keys"}  # Cryptex 2.x's database (api/database.py at v.2.4.0)


def migrate() -> int:
    """Apply the numbered migrations the database doesn't have yet (D3). A migration, once released, never changes:
    each one's SHA-256 is stored as it's applied, and a different file stops the server, as does a database newer
    than this code or one from Cryptex 2.x. Schema changes go in a new numbered file, never into an old one."""
    c = conn()
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "schema_version" not in tables and tables & V2_TABLES:
        raise RuntimeError(f"{_path} is a Cryptex 2.x database, which version 3 can't read. Start version 3 with an empty "
                           "data folder, and keep the old one for the 2.x image until its links have expired.")
    c.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)")
    if "sha256" not in {r[1] for r in c.execute("PRAGMA table_info(schema_version)")}:
        c.execute("ALTER TABLE schema_version ADD COLUMN sha256 TEXT")  # databases made before 3.2
    files = dict(sorted(
        (int(f.name.split("_", 1)[0]), f)
        for f in resources.files("cryptex.migrations").iterdir()
        if f.name.endswith(".sql")
    ))
    digest = {v: hashlib.sha256(f.read_bytes()).hexdigest() for v, f in files.items()}
    applied = {r[0]: r[1] for r in c.execute("SELECT version, sha256 FROM schema_version")}
    current = max(applied, default=0)
    if current > max(files, default=0):
        raise RuntimeError(f"the database is at schema version {current}, but this Cryptex knows only up to {max(files)}: "
                           "it was used by a newer version. Run that version (or a later one) again.")
    for version, h in applied.items():
        if version not in files:
            continue
        if h is None:  # applied before hashes were kept: this is the file it was applied from (they never change)
            c.execute("UPDATE schema_version SET sha256 = ? WHERE version = ?", (digest[version], version))
        elif h != digest[version]:
            raise RuntimeError(f"migration {files[version].name} isn't the one this database was made with. Released "
                               "migrations must never change: put schema changes in a new numbered file.")
    for version, f in files.items():
        if version <= current:
            continue
        c.execute("BEGIN IMMEDIATE")
        try:
            for statement in _split(f.read_text()):
                c.execute(statement)
            c.execute("INSERT INTO schema_version(version, applied_at, sha256) VALUES (?, ?, ?)", (version, int(time.time()), digest[version]))
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
