import asyncio
import json
import shutil
import time
from pathlib import Path

from . import database as db

# Prefix used by multipart upload metadata directories.
_UPLOAD_DIR_PREFIX = "_upload_"
# An upload is considered stale after 10 minutes of inactivity.
_UPLOAD_MAX_AGE = 600


async def cleanup_expired(files_dir: Path, interval: int = 300):
    """
    Background task that periodically purges expired cryptex entries from
    the SQLite database and removes their on-disk folders.

    Also cleans up stale multipart uploads: the metadata directory **and**
    the partially-written target file are both deleted when the upload has
    been inactive for more than ``_UPLOAD_MAX_AGE`` seconds.

    Runs every ``interval`` seconds (default: 5 minutes).
    """
    while True:
        try:
            await asyncio.sleep(interval)

            # Purge expired rows from the database and get their IDs
            expired_ids = await db.purge_expired()

            # Delete on-disk folders for expired entries
            for cryptex_id in expired_ids:
                cryptex_dir = files_dir / cryptex_id
                if cryptex_dir.exists():
                    shutil.rmtree(cryptex_dir)

            if expired_ids:
                print(f"[Cleanup] Purged {len(expired_ids)} expired cryptex entries")

            # Purge expired links
            expired_links = await db.purge_expired_links()
            if expired_links:
                print(f"[Cleanup] Purged {expired_links} expired links")

            # Clean up stale multipart uploads
            stale_count = 0
            stale_bytes = 0
            now = time.time()
            if files_dir.exists():
                for cryptex_dir in files_dir.iterdir():
                    if not cryptex_dir.is_dir():
                        continue
                    for child in cryptex_dir.iterdir():
                        if not (child.is_dir() and child.name.startswith(_UPLOAD_DIR_PREFIX)):
                            continue
                        meta_path = child / "meta.json"
                        is_stale = False
                        filename = None
                        if meta_path.exists():
                            try:
                                meta = json.loads(meta_path.read_text())
                                # Use last_active if available, else fall back to created_at
                                last_active = meta.get("last_active", meta.get("created_at", 0))
                                if now - last_active > _UPLOAD_MAX_AGE:
                                    is_stale = True
                                    filename = meta.get("filename")
                            except Exception:
                                is_stale = True
                        else:
                            # No metadata — treat as stale
                            is_stale = True
                        if is_stale:
                            # Delete the partially-written target file
                            if filename:
                                target_path = cryptex_dir / filename
                                if target_path.exists():
                                    try:
                                        stale_bytes += target_path.stat().st_size
                                    except OSError:
                                        pass
                                    target_path.unlink(missing_ok=True)
                            shutil.rmtree(child, ignore_errors=True)
                            stale_count += 1
            if stale_count:
                size_str = _format_bytes(stale_bytes) if stale_bytes else "0 B"
                print(f"[Cleanup] Removed {stale_count} stale multipart upload(s), reclaimed {size_str}")

        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[Cleanup] Error in cleanup task: {e}")
            continue


def _format_bytes(n: int) -> str:
    """Human-readable byte size."""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}" if n != int(n) else f"{int(n)} {unit}"
        n /= 1024
    return f"{n:.1f} TB"
