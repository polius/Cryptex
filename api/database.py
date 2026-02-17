"""
SQLite database module for persistent cryptex metadata storage.

Stores cryptex metadata (password, creation time, retention, file list, flags)
while actual file content remains on disk under /cryptex/data/files/<id>/.
"""

import json
import shutil
import time

import aiosqlite
from pathlib import Path
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException

DATABASE_DIR = Path("/cryptex/data")
DATABASE_PATH = DATABASE_DIR / "cryptex.db"
FILES_DIR = DATABASE_DIR / "files"

SCHEMA = """
CREATE TABLE IF NOT EXISTS cryptex (
    id          TEXT PRIMARY KEY,
    password    TEXT,
    created     TEXT    NOT NULL,
    retention   INTEGER NOT NULL,
    files       TEXT    NOT NULL DEFAULT '[]',
    autodestroy INTEGER NOT NULL DEFAULT 0,
    consumed    INTEGER NOT NULL DEFAULT 0,
    has_text    INTEGER NOT NULL DEFAULT 0,
    file_count  INTEGER NOT NULL DEFAULT 0,
    total_size  INTEGER NOT NULL DEFAULT 0,
    views       INTEGER NOT NULL DEFAULT 0,
    pending     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS links (
    token               TEXT PRIMARY KEY,
    label               TEXT NOT NULL DEFAULT '',
    created_at          INTEGER NOT NULL,
    expires_at          INTEGER NOT NULL DEFAULT 0,
    max_uses            INTEGER NOT NULL DEFAULT 1,
    uses                INTEGER NOT NULL DEFAULT 0,
    password            TEXT,
    cryptex_id          TEXT,
    cryptex_has_password INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    key         TEXT NOT NULL UNIQUE,
    created     INTEGER NOT NULL,
    last_used   INTEGER
);
"""


async def init_db() -> None:
    """Create the database directory and tables if they don't exist."""
    DATABASE_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.executescript(SCHEMA)
        # Migrate: add 'pending' column for existing databases
        try:
            # v.2.2.0
            await db.execute("ALTER TABLE cryptex ADD COLUMN pending INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass  # Column already exists
        await db.commit()


# ---------------------------------------------------------------------------
# CRUD operations
# ---------------------------------------------------------------------------

async def store_cryptex(
    cryptex_id: str,
    password: str | None,
    created: str,
    retention: int,
    files: list,
    autodestroy: bool = False,
    has_text: bool = False,
    total_size: int = 0,
    pending: bool = False,
) -> None:
    """Insert a new cryptex record."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            """
            INSERT INTO cryptex
                (id, password, created, retention, files, autodestroy, consumed,
                 has_text, file_count, total_size, pending)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
            """,
            (
                cryptex_id,
                password,
                created,
                retention,
                json.dumps(files),
                int(autodestroy),
                int(has_text),
                len(files),
                total_size,
                int(pending),
            ),
        )
        await db.commit()


async def add_file_to_cryptex(cryptex_id: str, filename: str, file_size: int) -> None:
    """Append a file entry to an existing cryptex's file list and update totals."""
    async with aiosqlite.connect(DATABASE_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cursor = await conn.execute("SELECT files, total_size FROM cryptex WHERE id = ?", (cryptex_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(404, "Cryptex not found")

        files = json.loads(row["files"])
        files.append({"filename": filename, "size": file_size})
        new_total = row["total_size"] + file_size

        await conn.execute(
            "UPDATE cryptex SET files = ?, file_count = ?, total_size = ? WHERE id = ?",
            (json.dumps(files), len(files), new_total, cryptex_id),
        )
        await conn.commit()


async def get_cryptex(cryptex_id: str) -> dict | None:
    """
    Fetch a cryptex by ID. Returns ``None`` if it doesn't exist
    or has expired.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM cryptex WHERE id = ?", (cryptex_id,))
        row = await cursor.fetchone()

    if row is None:
        return None

    data = dict(row)

    # Check expiration
    created = datetime.fromisoformat(data["created"]).replace(tzinfo=timezone.utc)
    expires_at = created + timedelta(seconds=data["retention"])
    if datetime.now(timezone.utc) > expires_at:
        # Expired — clean up DB record and on-disk files
        await delete_cryptex(cryptex_id)
        cryptex_dir = FILES_DIR / cryptex_id
        if cryptex_dir.exists():
            shutil.rmtree(cryptex_dir, ignore_errors=True)
        return None

    # Deserialise JSON fields
    data["files"] = json.loads(data["files"])
    data["autodestroy"] = bool(data["autodestroy"])
    data["consumed"] = bool(data["consumed"])
    data["has_text"] = bool(data["has_text"])
    return data


async def mark_consumed(cryptex_id: str) -> None:
    """Mark a cryptex as consumed (for autodestroy)."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("UPDATE cryptex SET consumed = 1 WHERE id = ?", (cryptex_id,))
        await db.commit()


async def increment_views(cryptex_id: str) -> int:
    """Increment the view count for a cryptex. Returns the new count."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("UPDATE cryptex SET views = views + 1 WHERE id = ?", (cryptex_id,))
        await db.commit()
        cursor = await db.execute("SELECT views FROM cryptex WHERE id = ?", (cryptex_id,))
        row = await cursor.fetchone()
        return row[0] if row else 0


async def delete_cryptex(cryptex_id: str) -> None:
    """Delete a single cryptex record."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM cryptex WHERE id = ?", (cryptex_id,))
        await db.commit()


async def delete_all_cryptex() -> int:
    """Delete all cryptex records and clear link associations. Returns the number of deleted rows."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("DELETE FROM cryptex")
        deleted = cursor.rowcount
        # Clear cryptex associations from links so they don't reference deleted IDs
        await db.execute("UPDATE links SET cryptex_id = NULL, cryptex_has_password = 0 WHERE cryptex_id IS NOT NULL")
        await db.commit()
        return deleted


async def list_all_cryptex() -> list[dict]:
    """Return all non-expired cryptex records (used by the monitor).

    Filtering and expiration calculation are done entirely in SQL so
    no filesystem access is needed.
    """
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT *,
                   CAST(
                       (julianday(created, '+' || retention || ' seconds')
                        - julianday(?)) * 86400 AS INTEGER
                   ) AS expires_in
            FROM cryptex
            WHERE datetime(created, '+' || retention || ' seconds') > datetime(?)
            ORDER BY created DESC
            """,
            (now, now),
        )
        rows = await cursor.fetchall()

    results = []
    for row in rows:
        data = dict(row)
        data["files"] = json.loads(data["files"])
        data["autodestroy"] = bool(data["autodestroy"])
        data["consumed"] = bool(data["consumed"])
        data["has_text"] = bool(data["has_text"])
        data["expires_in"] = max(0, data["expires_in"] or 0)
        results.append(data)
    return results


async def purge_expired() -> list[str]:
    """
    Delete all expired cryptex records from the database.
    Returns the list of deleted cryptex IDs (so callers can remove
    their on-disk folders too).
    """
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DATABASE_PATH) as db:
        # Compute expiration in SQL using datetime arithmetic
        cursor = await db.execute(
            """
            SELECT id FROM cryptex
            WHERE datetime(created, '+' || retention || ' seconds') < datetime(?)
            """,
            (now,),
        )
        rows = await cursor.fetchall()
        expired_ids = [r[0] for r in rows]

        if expired_ids:
            placeholders = ",".join("?" for _ in expired_ids)
            await db.execute(f"DELETE FROM cryptex WHERE id IN ({placeholders})", expired_ids)
            await db.commit()

    return expired_ids


async def cryptex_exists(cryptex_id: str) -> bool:
    """Check whether a cryptex ID is already in use."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT 1 FROM cryptex WHERE id = ?", (cryptex_id,))
        return await cursor.fetchone() is not None


async def verify_cryptex(cryptex_id: str, password: str | None = None) -> dict:
    """
    Verify that a cryptex exists, is not expired, and that the password
    matches (if the cryptex is password-protected).

    Raises ``HTTPException`` on any failure.
    """
    data = await get_cryptex(cryptex_id)
    if data is None:
        raise HTTPException(404, "This cryptex does not exist or has expired.")

    has_password = bool(data.get("password"))

    if has_password:
        if not password:
            raise HTTPException(401, "Password required")
        if password != data["password"]:
            raise HTTPException(403, "Incorrect password or the cryptex does not exist.")

    return data


# ---------------------------------------------------------------------------
# Link CRUD operations
# ---------------------------------------------------------------------------

async def create_link(token: str, label: str, created_at: int, expires_at: int,
                      max_uses: int, password: str | None) -> dict:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO links (token, label, created_at, expires_at, max_uses, uses, password) "
            "VALUES (?, ?, ?, ?, ?, 0, ?)",
            (token, label, created_at, expires_at, max_uses, password),
        )
        await db.commit()
    return {
        "token": token, "label": label, "created_at": created_at,
        "expires_at": expires_at, "max_uses": max_uses, "uses": 0,
        "password": password, "cryptex_id": None, "cryptex_has_password": False,
    }


async def get_all_links() -> list[dict]:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM links ORDER BY created_at DESC")
        rows = await cursor.fetchall()
    return [_link_row(r) for r in rows]


async def get_link(token: str) -> dict | None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM links WHERE token = ?", (token,))
        row = await cursor.fetchone()
    return _link_row(row) if row else None


async def update_link_label(token: str, label: str) -> bool:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("UPDATE links SET label = ? WHERE token = ?", (label, token))
        await db.commit()
        return cursor.rowcount > 0


async def update_link_cryptex(token: str, cryptex_id: str, has_password: bool) -> None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE links SET cryptex_id = ?, cryptex_has_password = ?, uses = uses + 1 WHERE token = ?",
            (cryptex_id, int(has_password), token),
        )
        await db.commit()


async def mark_cryptex_ready(cryptex_id: str) -> None:
    """Clear the pending flag on a cryptex, marking it as fully created."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("UPDATE cryptex SET pending = 0 WHERE id = ?", (cryptex_id,))
        await db.commit()


async def is_cryptex_pending(cryptex_id: str) -> bool | None:
    """Check if a cryptex is still pending.

    Returns True if pending, False if ready, or None if the cryptex
    doesn't exist (e.g. expired and cleaned up).
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT pending FROM cryptex WHERE id = ?", (cryptex_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        return bool(row["pending"])


async def reset_link_cryptex(token: str) -> None:
    """Reset a link's cryptex association so it can be reused."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE links SET cryptex_id = NULL, cryptex_has_password = 0, uses = MAX(uses - 1, 0) "
            "WHERE token = ?",
            (token,),
        )
        await db.commit()


async def delete_link(token: str) -> None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM links WHERE token = ?", (token,))
        await db.commit()


def _link_row(row) -> dict:
    d = dict(row)
    d["cryptex_has_password"] = bool(d["cryptex_has_password"])
    return d


# ---------------------------------------------------------------------------
# API Key CRUD operations
# ---------------------------------------------------------------------------

async def create_api_key(key_id: str, name: str, description: str, key_hash: str, created: int) -> dict:
    """Store a new API key."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO api_keys (id, name, description, key, created) VALUES (?, ?, ?, ?, ?)",
            (key_id, name, description, key_hash, created),
        )
        await db.commit()
    return {"id": key_id, "name": name, "description": description, "created": created, "last_used": None}


async def get_all_api_keys() -> list[dict]:
    """Return all API keys (without the key hash)."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT id, name, description, created, last_used FROM api_keys ORDER BY created DESC")
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def verify_api_key(key_hash: str) -> dict | None:
    """Look up an API key by its hash. Returns the row or None."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM api_keys WHERE key = ?", (key_hash,))
        row = await cursor.fetchone()
        if row:
            d = dict(row)
            now = int(time.time())
            await db.execute("UPDATE api_keys SET last_used = ? WHERE id = ?", (now, d["id"]))
            await db.commit()
            return d
    return None


async def delete_api_key(key_id: str) -> bool:
    """Delete an API key by ID. Returns True if a row was deleted."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        await db.commit()
        return cursor.rowcount > 0


async def delete_all_api_keys() -> int:
    """Delete all API keys. Returns the number of deleted rows."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("DELETE FROM api_keys")
        await db.commit()
        return cursor.rowcount


async def purge_expired_links() -> int:
    """Delete all expired links from the database.
    Returns the count of deleted links.
    """
    now = int(datetime.now(timezone.utc).timestamp())
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "DELETE FROM links WHERE expires_at > 0 AND expires_at < ?",
            (now,),
        )
        await db.commit()
        return cursor.rowcount
