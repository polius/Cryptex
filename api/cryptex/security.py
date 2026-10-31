"""Server-side secrets: ENC_KEY encryption at rest, password hashing, TOTP."""
from __future__ import annotations

import hashlib
import hmac
import os
import time

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import state
from .util import b64u, unb64u

# argon2id over what the browser sends, which is already a 256-bit Argon2id output (64 MiB, 3 passes): this layer
# only has to make each guess cost the thief something, so OWASP's minimum (19 MiB, 2 passes, 1 lane) is enough and
# keeps parallel sign-ins from eating the server's memory.
_ph = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
_DUMMY = _ph.hash(b"timing-equalizer")


def seal(label: str, plaintext: bytes) -> bytes:
    """Encrypt a small value with ENC_KEY: nonce || ciphertext || tag."""
    nonce = os.urandom(12)
    return nonce + AESGCM(state.env().enc_key).encrypt(nonce, plaintext, b"cryptex/at-rest|" + label.encode())


def unseal(label: str, blob: bytes) -> bytes:
    return AESGCM(state.env().enc_key).decrypt(blob[:12], blob[12:], b"cryptex/at-rest|" + label.encode())


_CANARY = b"cryptex/enc-key-canary/v1"


def check_canary() -> None:
    """enc.key must be the key this database was set up with: the first start seals a constant with it, every later
    start opens that constant again. With another key, sign-in with 2FA, vaults and device keys would all fail."""
    stored = state.raw("enc_canary")
    if stored is None:
        state.save("enc_canary", b64u(seal("canary", _CANARY)))
        return
    try:
        ok = unseal("canary", unb64u(stored)) == _CANARY
    except (InvalidTag, ValueError):
        ok = False
    if not ok:
        raise RuntimeError("DATA_DIR/enc.key isn't the key this server was set up with (DATA_DIR/cryptex.db). "
                           "Put back the original enc.key (it's in every backup); Cryptex can't change keys.")


def keyed(label: str, value: str) -> bytes:
    """HMAC-SHA-256 with ENC_KEY. What's stored for an auth key goes through this first, so a copy of the database
    without ENC_KEY can't be used to test password guesses offline (threat-model.md)."""
    return hmac.new(state.env().enc_key, f"cryptex/v1/{label}|{value}".encode(), hashlib.sha256).digest()


def hash_password(auth_key: str) -> str:
    """users.password_hash: argon2id(HMAC(ENC_KEY, "cryptex/v1/password|" + auth key))."""
    return _ph.hash(keyed("password", auth_key))


def verify_password(hashed: str | None, auth_key: str) -> bool:
    """Constant work whether or not the user exists."""
    try:
        return _ph.verify(hashed or _DUMMY, keyed("password", auth_key)) and hashed is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def temp_key_hash(auth_key: str) -> str:
    """users.temp_key_hash for a temporary password's auth key (high-entropy, so no Argon2 needed): keyed like
    password_hash, so the database alone doesn't confirm a guess either."""
    return keyed("temp", auth_key).hex()


def verify_totp(secret: str, code: str, last_step: int | None) -> int | None:
    """Returns the matched time step, or None. Rejects a step already used (replay); callers store the step only if
    it is still newer than the stored one (auth.check_totp), so two requests racing with one code can't both pass."""
    if not (code.isdigit() and len(code) == 6):
        return None
    totp = pyotp.TOTP(secret)
    t = int(time.time())
    for drift in (0, -1, 1):
        step = t // 30 + drift
        if totp.at(step * 30) == code and (last_step is None or step > last_step):
            return step
    return None
