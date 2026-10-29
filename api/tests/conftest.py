"""Every test gets a fresh server: its own data directory, settings and database."""
from __future__ import annotations

import hashlib
import os
from collections.abc import Callable
from pathlib import Path

import pyotp
import pytest
from fastapi.testclient import TestClient

from cryptex import db
from cryptex.app import create_app
from cryptex.config import load_env
from cryptex.util import b64u, unb64u

SETUP_CODE = "TEST-CODE-0001"
OWNER_TOTP = "JBSWY3DPEHPK3PXPJBSWY3DP"
OWNER = {"username": "sam", "password": "correct horse battery"}


def auth_key(password: str, salt: str) -> str:
    """Stand-in for the browser's Argon2id: to the server an auth key is an opaque 32-byte value."""
    return b64u(hashlib.sha256(b"cryptex-test|" + unb64u(salt) + password.encode()).digest())


def creds(password: str, salt: str | None = None) -> dict[str, str]:
    """Salt + auth key, as a browser sends them when it sets a password (setup, invite, password change)."""
    salt = salt or b64u(os.urandom(16))
    return {"salt": salt, "auth_key": auth_key(password, salt)}


OWNER_SALT = b64u(b"owner-test-salt!")
OWNER_SETUP = {"username": OWNER["username"], **creds(OWNER["password"], OWNER_SALT)}
SETUP = {"setup_code": SETUP_CODE, **OWNER_SETUP, "brand_name": "Acme", "access": "anyone"}  # POST /setup


def login_body(c: TestClient, username: str, password: str) -> dict[str, str]:
    """What the sign-in form sends: pre-login for the salt, then the auth key derived from the password."""
    salt = c.post("/api/v1/auth/prelogin", json={"username": username}).json()["salt"]
    return {"username": username, "auth_key": auth_key(password, salt)}


def totp_code(username: str = OWNER["username"], secret: str = OWNER_TOTP) -> str:
    """A current code; forgets the last used step so tests can sign in twice within 30 seconds."""
    db.run("UPDATE users SET totp_last_step = NULL WHERE username = ?", username)
    return pyotp.TOTP(secret).now()


def sign_in(c: TestClient, username: str = OWNER["username"], password: str = OWNER["password"], secret: str = OWNER_TOTP) -> TestClient:
    r = c.post("/api/v1/auth/login", json=login_body(c, username, password))
    assert r.status_code == 200, r.text
    r = c.post("/api/v1/auth/login/totp", json={"mfa_ticket": r.json()["mfa_ticket"], "code": totp_code(username, secret)})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF"] = r.json()["csrf"]
    return c


def reauth(c: TestClient) -> None:
    assert c.post("/api/v1/auth/reauth", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT), "code": totp_code()}).status_code == 204


def make_client(tmp: Path, seed_code: bool = True, **env: str) -> TestClient:
    """seed_code: a known setup code, written where the server keeps the one it makes (state.setup_code)."""
    if seed_code and not (tmp / "setup-code").exists() and not (tmp / "cryptex.db").exists():
        tmp.mkdir(parents=True, exist_ok=True)
        (tmp / "setup-code").write_text(SETUP_CODE + "\n")
    base = {"DATA_DIR": str(tmp), "LOG_LEVEL": "warning"}
    base.update(env)
    app = create_app(load_env(base), run_jobs=False)
    return TestClient(app, base_url="http://localhost:8080")


def complete_setup(c: TestClient, access: str = "anyone") -> dict[str, str]:
    """Setup, then 2FA on (Your account), as most owners would."""
    r = c.post("/api/v1/setup", json={**SETUP, "access": access})
    assert r.status_code == 200, r.text
    h = {"X-CSRF": r.json()["csrf"]}
    assert c.put("/api/v1/me/totp", json={"secret": OWNER_TOTP, "code": pyotp.TOTP(OWNER_TOTP).now()}, headers=h).status_code == 204
    return h


@pytest.fixture
def server(tmp_path: Path) -> Callable[..., TestClient]:
    """Factory: server(**env) -> a TestClient on a fresh, set-up instance (owner signed in on that client)."""
    made: list[TestClient] = []

    def factory(setup: bool = True, access: str = "anyone", seed_code: bool = True, **env: str) -> TestClient:
        d = tmp_path / f"srv{len(made)}"
        d.mkdir()
        c = make_client(d, seed_code, **env)
        c.__enter__()
        made.append(c)
        if setup and env.get("DEMO") != "true":
            c.headers.update(complete_setup(c, access))
        return c

    yield factory
    for c in made:
        c.__exit__(None, None, None)


@pytest.fixture
def client(server: Callable[..., TestClient]) -> TestClient:
    """A set-up server, plus a second anonymous client for the same app via .anon()."""
    return server()


def anon(c: TestClient) -> TestClient:
    """Another browser on the same server: no cookies."""
    return TestClient(c.app, base_url="http://localhost:8080")


def from_address(c: TestClient, ip: str) -> TestClient:
    """Another browser on the same server, connecting from `ip` (anon() connects from "testclient")."""
    return TestClient(c.app, base_url="http://localhost:8080", client=(ip, 50000))


def chunk_files() -> list[Path]:
    from cryptex import state
    return [p for p in (state.env().data_dir / "chunks").rglob("*") if p.is_file()]


def pytest_configure() -> None:
    os.environ.setdefault("TZ", "UTC")

