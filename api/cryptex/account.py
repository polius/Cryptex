"""Zero-knowledge sign-in and the account vault (users, device_keys and vault_items in migrations/0001_init.sql).

The browser never sends the password. From password + kdf_salt it derives (Argon2id) an auth key, which it sends,
and a wrap key, which it keeps. The server stores argon2id(HMAC(ENC_KEY, auth key)) (security.hash_password) and an
unlock share; the browser combines its wrap key with the share to unwrap the vault key. The server never sees the
vault key or anything it encrypts.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import sqlite3
from typing import Annotated, Any

from argon2.low_level import Type, hash_secret_raw
from pydantic import BeforeValidator, Field

from . import db, security, state
from .events import emit
from .routes.common import Body
from .util import b64u, now, same, unb64u

# Argon2id for the account password: stronger than the per-link passphrase (it guards something long-lived).
# Browsers use these when they set a password (web/src/store/vault.ts ACCOUNT_KDF) and refuse anything weaker:
# keep the two the same. Every account is written with exactly these (set_credentials).
KDF = {"m": 65536, "t": 3, "p": 1}
B64_16 = r"^[A-Za-z0-9_-]{22}$"   # 16 bytes
B64_32 = r"^[A-Za-z0-9_-]{43}$"   # 32 bytes
WRAPPED = r"^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,200}$"
USERNAME = r"^[a-z0-9][a-z0-9._-]{1,31}$"  # 2 to 32 characters, stored in lower case
log = logging.getLogger("cryptex")


def norm_username(v: object) -> object:
    return v.strip().lower() if isinstance(v, str) else v


# What people sign in with. Nothing is ever sent to it: it's a name, not an address.
Username = Annotated[str, BeforeValidator(norm_username), Field(pattern=USERNAME)]


class Credentials(Body):
    """What a browser sends instead of a password."""
    salt: str = Field(pattern=B64_16)
    auth_key: str = Field(pattern=B64_32)


def fake_salt(username: str) -> bytes:
    """A stable salt for a username with no account, so pre-login doesn't tell who has one."""
    return hmac.new(state.env().enc_key, b"cryptex/kdf-salt|" + username.strip().lower().encode(), hashlib.sha256).digest()[:16]


def kdf_of(u: sqlite3.Row | None) -> dict[str, int]:
    return json.loads(u["kdf"]) if u is not None and u["kdf"] else dict(KDF)


def set_credentials(conn: sqlite3.Connection, user_id: str, cred: Credentials) -> None:
    """Store a new salt and auth key (setup, invite, reset, password change). Creates the unlock share once.
    Every other way in that was open for the old credentials closes (forget_sign_ins)."""
    conn.execute("UPDATE users SET kdf_salt = ?, kdf = ?, password_hash = ?, "
                 "unlock_ct = coalesce(unlock_ct, ?) WHERE id = ?",
                 (unb64u(cred.salt), json.dumps(KDF), security.hash_password(cred.auth_key),
                  security.seal(f"unlock|{user_id}", secrets.token_bytes(32)), user_id))
    forget_sign_ins(conn, user_id)


def forget_sign_ins(conn: sqlite3.Connection, user_id: str) -> None:
    """The account's credentials changed (or it is going away): its temporary password, half-done sign-ins (2FA and
    new-password tickets) and any reset link stop working. Sessions are the caller's call."""
    conn.execute("UPDATE users SET temp_key_hash = NULL, temp_expires_at = NULL WHERE id = ?", (user_id,))
    conn.execute("DELETE FROM mfa_tickets WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM reset_links WHERE user_id = ?", (user_id,))
    u = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
    if u is not None:
        state.forget_temp_password(u["username"])


def clear_vault(conn: sqlite3.Connection, user_id: str) -> None:
    """A password reset. Only the old password opened the vault key, so what it encrypted (Your links' titles, and
    links while they wait) can never be read again: it goes, with every browser's copy of the key, and the next
    sign-in makes a new vault. The links keep working, and Your links keeps them and their statuses (user_receipts).
    Requests are closed: only the vault held the key their answers are encrypted to, so an answer could never be read.
    Their answers expire now (cleanup deletes them)."""
    t = now()
    conn.execute("UPDATE secrets SET expires_at = min(expires_at, ?) WHERE request_id IN (SELECT id FROM requests WHERE owner_id = ?)",
                 (t, user_id))
    conn.execute("UPDATE secrets SET upload_active_at = 0 WHERE sealed = 0 AND request_id IN (SELECT id FROM requests WHERE owner_id = ?)",
                 (user_id,))
    conn.execute("UPDATE requests SET closed_at = ?, ask_ct = NULL, answer_ct = NULL WHERE owner_id = ? AND closed_at IS NULL",
                 (t, user_id))
    conn.execute("UPDATE users SET vault_pw = NULL WHERE id = ?", (user_id,))
    conn.execute("DELETE FROM vault_items WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM device_keys WHERE user_id = ?", (user_id,))


def unlock_share(u: sqlite3.Row) -> str:
    return b64u(security.unseal(f"unlock|{u['id']}", u["unlock_ct"]))


def vault_public(u: sqlite3.Row) -> dict[str, Any]:
    """What GET /me/vault/keys shows any session of the account: enough to derive keys, nothing that helps guess the
    password (the unlock share and vault_pw need it: vault_bundle)."""
    return {"salt": b64u(u["kdf_salt"]), "kdf": kdf_of(u)}


def vault_bundle(u: sqlite3.Row) -> dict[str, Any]:
    """What a browser needs to open its vault. Only returned right after the password was checked (sign-in, or
    POST /me/vault/unlock), to that account's session."""
    return {**vault_public(u), "unlock_share": unlock_share(u), "vault_pw": u["vault_pw"]}


def derive_auth_key(password: str, salt: bytes, kdf: dict[str, int]) -> str:
    """The auth key a browser sends for this password (web/src/store/vault.ts deriveAccount). The server only ever
    runs this for a temporary password it made itself."""
    master = hash_secret_raw(password.encode(), salt, time_cost=kdf["t"], memory_cost=kdf["m"], parallelism=kdf["p"],
                             hash_len=32, type=Type.ID)
    return b64u(hmac.new(master, b"cryptex/v1/account|auth", hashlib.sha256).digest())


def issue_temp_password(user_id: str) -> None:
    """"Forgot your password?": unless one is already waiting, a temporary password in DATA_DIR/temp-passwords
    (state.make_temp_password) for whoever runs the server to pass on. The account keeps a hash of the auth key it
    derives with the current salt, so signing in with it is a cheap compare, and any credential change voids it.
    Runs after the response is sent (Argon2id here takes a while): the answer and its timing are the same either way."""
    t = now()
    exp = t + state.TEMP_TTL
    claimed = db.run("UPDATE users SET temp_expires_at = ?, temp_key_hash = NULL WHERE id = ? AND password_hash IS NOT NULL "
                     "AND (temp_expires_at IS NULL OR temp_expires_at <= ?)", exp, user_id, t).rowcount
    u = db.one("SELECT * FROM users WHERE id = ?", user_id)
    if not claimed or u is None:
        return  # one is waiting already: the one passed on keeps working
    try:
        pw = state.make_temp_password(u["username"])
        key = derive_auth_key(pw, u["kdf_salt"], kdf_of(u))
    except Exception:
        log.exception("couldn't make a temporary password")
        db.run("UPDATE users SET temp_expires_at = NULL WHERE id = ? AND temp_expires_at = ?", user_id, exp)
        return
    db.run("UPDATE users SET temp_key_hash = ? WHERE id = ? AND temp_expires_at = ? AND kdf_salt = ?",
           security.temp_key_hash(key), user_id, exp, u["kdf_salt"])
    emit("user.temp_password", actor="user", user_id=user_id)  # the account it is for: anyone can ask


def temp_password_matches(u: sqlite3.Row, auth_key: str) -> bool:
    """Was this auth key derived from the account's temporary password? No password (a locked account or an owner
    reset): the invite or reset link is the way in, not this."""
    if u["password_hash"] is None or u["temp_key_hash"] is None or (u["temp_expires_at"] or 0) <= now():
        return False
    return same(security.temp_key_hash(auth_key), u["temp_key_hash"])


def temp_password_waiting(username: str) -> str | None:
    """The temporary password to show whoever runs the server, if its account still accepts it."""
    pw = state.temp_password(username)
    if pw is not None and db.val("SELECT 1 FROM users WHERE username = ? AND temp_key_hash IS NOT NULL AND temp_expires_at > ?",
                                 username, now()) is None:
        state.forget_temp_password(username)  # left behind (the account changed): never hand it out
        return None
    return pw
