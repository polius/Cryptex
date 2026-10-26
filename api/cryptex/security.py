"""Server-side secrets: ENC_KEY encryption at rest, password hashing, TOTP."""
from __future__ import annotations

import os
import time

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import state

_ph = PasswordHasher()  # argon2id, library defaults (RFC 9106 low-memory profile)
_DUMMY = _ph.hash("timing-equalizer")


def seal(label: str, plaintext: bytes) -> bytes:
    """Encrypt a small value with ENC_KEY: nonce || ciphertext || tag."""
    nonce = os.urandom(12)
    return nonce + AESGCM(state.env().enc_key).encrypt(nonce, plaintext, b"cryptex/at-rest|" + label.encode())


def unseal(label: str, blob: bytes) -> bytes:
    return AESGCM(state.env().enc_key).decrypt(blob[:12], blob[12:], b"cryptex/at-rest|" + label.encode())


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(hashed: str | None, password: str) -> bool:
    """Constant work whether or not the user exists."""
    try:
        return _ph.verify(hashed or _DUMMY, password) and hashed is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def verify_totp(secret: str, code: str, last_step: int | None) -> int | None:
    """Returns the matched time step, or None. Rejects a step already used (replay)."""
    if not (code.isdigit() and len(code) == 6):
        return None
    totp = pyotp.TOTP(secret)
    t = int(time.time())
    for drift in (0, -1, 1):
        step = t // 30 + drift
        if totp.at(step * 30) == code and (last_step is None or step > last_step):
            return step
    return None
