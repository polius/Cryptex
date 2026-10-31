"""Encrypted chunk storage. Chunks are opaque, so any backend (disk, S3) works
without format changes. Names are random and never derived from IDs."""
from __future__ import annotations

import os
import secrets
import shutil
from pathlib import Path
from typing import Protocol


class Storage(Protocol):
    def put(self, data: bytes) -> str: ...
    def replace(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def disk(self) -> tuple[int, int]: ...
    def wipe(self) -> None: ...


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        if len(key) != 32 or not all(c in "0123456789abcdef" for c in key):
            raise ValueError("bad blob key")
        return self.root / key[:2] / key

    def put(self, data: bytes) -> str:
        key = secrets.token_hex(16)
        self.replace(key, data)
        return key

    def replace(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(exist_ok=True)
        tmp = p.with_suffix(".tmp" + secrets.token_hex(4))
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink()
        except FileNotFoundError:
            pass

    def disk(self) -> tuple[int, int]:
        """(total, free) bytes of the volume."""
        u = shutil.disk_usage(self.root)
        return u.total, u.free

    def wipe(self) -> None:
        for child in self.root.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)


_storage: Storage | None = None


def init(s: Storage) -> None:
    global _storage
    _storage = s


def get() -> Storage:
    assert _storage is not None
    return _storage
