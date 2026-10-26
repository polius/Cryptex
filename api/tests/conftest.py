"""Every test gets a fresh server: its own data directory, settings and database."""
from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cryptex import mailer
from cryptex.app import create_app
from cryptex.config import load_env

SETUP_CODE = "TEST-CODE-0001"
OWNER = {"email": "sam@acme.example", "name": "Sam Rivera", "password": "correct horse battery"}


def make_client(tmp: Path, **env: str) -> TestClient:
    base = {"DATA_DIR": str(tmp), "SETUP_CODE": SETUP_CODE, "PUBLIC_URL": "http://localhost:8080", "LOG_LEVEL": "warning"}
    base.update(env)
    app = create_app(load_env(base), run_jobs=False)
    return TestClient(app, base_url="http://localhost:8080")


def complete_setup(c: TestClient, access: str = "anyone") -> dict[str, str]:
    r = c.post("/api/v1/setup/owner", json={"setup_code": SETUP_CODE, **OWNER})
    assert r.status_code == 200, r.text
    h = {"X-CSRF": r.json()["csrf"]}
    assert c.post("/api/v1/setup/brand", json={"name": "Acme"}, headers=h).status_code == 204
    assert c.post("/api/v1/setup/access", json={"mode": access}, headers=h).status_code == 204
    return h


@pytest.fixture
def server(tmp_path: Path) -> Callable[..., TestClient]:
    """Factory: server(**env) -> a TestClient on a fresh, set-up instance (owner signed in on that client)."""
    made: list[TestClient] = []

    def factory(setup: bool = True, access: str = "anyone", **env: str) -> TestClient:
        d = tmp_path / f"srv{len(made)}"
        d.mkdir()
        c = make_client(d, **env)
        c.__enter__()
        made.append(c)
        if setup and env.get("DEMO") != "true":
            c.headers.update(complete_setup(c, access))
        return c

    yield factory
    for c in made:
        c.__exit__(None, None, None)
    mailer.sent.clear()


@pytest.fixture
def client(server: Callable[..., TestClient]) -> TestClient:
    """A set-up server, plus a second anonymous client for the same app via .anon()."""
    return server()


def anon(c: TestClient) -> TestClient:
    """Another browser on the same server: no cookies."""
    return TestClient(c.app, base_url="http://localhost:8080")


def chunk_files() -> list[Path]:
    from cryptex import state
    return [p for p in (state.env().data_dir / "chunks").rglob("*") if p.is_file()]


def pytest_configure() -> None:
    os.environ.setdefault("TZ", "UTC")

