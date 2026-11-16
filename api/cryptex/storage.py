"""Encrypted chunk storage. Chunks are opaque, so any backend (disk, S3) works
without format changes. Names are random and never derived from IDs."""
from __future__ import annotations

import os
import secrets
import shutil
import time
from pathlib import Path
from typing import BinaryIO, Protocol


class Storage(Protocol):
    def put(self, data: bytes) -> str: ...
    def incoming(self) -> tuple[BinaryIO, Path]: ...
    def put_file(self, tmp: Path) -> str: ...
    def open(self, key: str) -> BinaryIO: ...
    def keys(self) -> list[str]: ...
    def age(self, key: str) -> float: ...
    def sweep_incoming(self, older_than: float) -> int: ...
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

    def incoming(self) -> tuple[BinaryIO, Path]:
        """A new temporary file to stream a chunk into as it arrives (B2: never held whole in memory); then put_file."""
        d = self.root / "incoming"
        d.mkdir(exist_ok=True)
        p = d / secrets.token_hex(16)
        return open(p, "xb"), p  # noqa: SIM115 (the caller closes it)

    def put_file(self, tmp: Path) -> str:
        """Move a finished temporary file into place under a new random name."""
        key = secrets.token_hex(16)
        p = self._path(key)
        p.parent.mkdir(exist_ok=True)
        with open(tmp, "rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp, p)
        return key

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def open(self, key: str) -> BinaryIO:
        """For serving a chunk from disk: an open file stays readable even if the blob is deleted meanwhile."""
        return open(self._path(key), "rb")  # noqa: SIM115

    def keys(self) -> list[str]:
        """Every stored blob's key."""
        return [p.name for d in self.root.iterdir() if d.is_dir() and len(d.name) == 2 for p in d.iterdir()
                if len(p.name) == 32 and p.name[:2] == d.name]

    def age(self, key: str) -> float:
        return time.time() - self._path(key).stat().st_mtime

    def sweep_incoming(self, older_than: float) -> int:
        """Temporary files a crash or a dropped upload left behind (and replace()'s .tmp files)."""
        n = 0
        for p in [*(self.root / "incoming").glob("*"), *self.root.glob("*/*.tmp*")]:
            try:
                if p.stat().st_mtime < time.time() - older_than:
                    p.unlink()
                    n += 1
            except FileNotFoundError:
                pass
        return n

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
