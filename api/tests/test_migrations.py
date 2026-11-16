"""D3: released migrations never change, a database from 3.0.0 upgrades, and a newer or a 2.x database stops the
server with one clear line."""
from __future__ import annotations

import hashlib
import sqlite3
from importlib import resources

import pytest
from conftest import make_client

from cryptex import db

# 0001_init.sql as released in 3.0.0 (and unchanged in 3.1.0 and 3.1.1): frozen.
RELEASED = {1: "1fe2cc382137884236ead9a35b2bf1da2dd13906413f9ca8ae8423ae17043a2c"}


def migration(version: int) -> bytes:
    return next(f for f in resources.files("cryptex.migrations").iterdir() if f.name.startswith(f"{version:04d}_")).read_bytes()


def test_released_migrations_never_change():
    for version, digest in RELEASED.items():
        assert hashlib.sha256(migration(version)).hexdigest() == digest, f"{version:04d} changed: add a new numbered migration instead"


def make_3_0_0(path):
    """A database as the 3.0.0 runner left it: 0001 applied, schema_version without hashes."""
    c = sqlite3.connect(path)
    c.executescript(migration(1).decode())
    c.execute("CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)")
    c.execute("INSERT INTO schema_version VALUES (1, 1767225600)")
    c.commit()
    c.close()


def test_a_3_0_0_database_upgrades(tmp_path):
    make_3_0_0(tmp_path / "cryptex.db")
    c = make_client(tmp_path)
    assert c.get("/api/v1/healthz").status_code == 200
    rows = db.all("SELECT version, sha256 FROM schema_version ORDER BY version")
    assert [r["version"] for r in rows][-1] >= 2 and all(r["sha256"] for r in rows)
    assert "creator" in {r[1] for r in db.all("PRAGMA table_info(secrets)")}


def test_a_newer_database_stops_the_server(tmp_path):
    make_client(tmp_path)
    db.run("INSERT INTO schema_version(version, applied_at) VALUES (7, 0)")
    with pytest.raises(RuntimeError, match="schema version 7"):
        make_client(tmp_path)


def test_a_changed_migration_stops_the_server(tmp_path):
    make_client(tmp_path)
    db.run("UPDATE schema_version SET sha256 = 'not the same' WHERE version = 1")
    with pytest.raises(RuntimeError, match="0001_init.sql isn't the one"):
        make_client(tmp_path)


def test_a_2_x_database_stops_the_server(tmp_path):
    c = sqlite3.connect(tmp_path / "cryptex.db")
    c.execute("CREATE TABLE cryptex (id TEXT PRIMARY KEY)")
    c.execute("CREATE TABLE links (id TEXT)")
    c.commit()
    c.close()
    with pytest.raises(RuntimeError, match="Cryptex 2.x database"):
        make_client(tmp_path)
