"""The crypto test vectors (docs/crypto.md) verify with the reference implementation, as the browser's must."""
import json
from pathlib import Path

import pytest
import reference as ref

VECTORS = Path(__file__).resolve().parents[2] / "docs" / "vectors.json"


def test_reference_verifies_every_vector():
    v = json.loads(VECTORS.read_text())
    assert v["version"] == "cryptex/v1"
    assert ref.verify(v) is True


def test_reference_rejects_a_tampered_vector():
    """verify() isn't vacuous: a flipped ciphertext byte fails it."""
    v = json.loads(VECTORS.read_text())
    st = v["cases"]["stream"]["streams"][0]
    first = bytes.fromhex(st["chunks"][0])
    st["chunks"][0] = (bytes([first[0] ^ 1]) + first[1:]).hex()
    with pytest.raises(Exception):  # noqa: B017 (InvalidTag or ValueError, whichever check catches it first)
        ref.verify(v)
