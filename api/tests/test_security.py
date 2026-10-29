"""Threat model rows (docs/threat-model.md) and audit regressions, as named tests."""
import base64
import json
import os
import re

import pyotp
import pytest
from conftest import (
    OWNER,
    OWNER_SALT,
    SETUP,
    anon,
    auth_key,
    chunk_files,
    creds,
    from_address,
    login_body,
    sign_in,
    totp_code,
)
from helpers import CHUNK, open_meta, passcheck, reveal, send

from cryptex import db, items, jobs, manage, state
from cryptex.routes.auth import safe_return_to
from cryptex.util import now


# ------------------------------------------------------------------ stranger on the internet
def test_stranger_cannot_destroy_by_id(client):
    s = send(client)
    stranger = anon(client)
    assert stranger.delete(f"/api/v1/secrets/{s.id}").status_code == 404
    assert stranger.delete(f"/api/v1/secrets/{s.id}", headers={"Authorization": "Manage " + "x" * 43}).status_code == 404
    assert open_meta(stranger, s)["views_left"] == 1


def test_stranger_cannot_upload_into_someone_elses_secret(client):
    """File uploads need the upload token, not just the ID, even on passphrase-protected secrets."""
    s = send(client, seal=False)
    stranger = anon(client)
    r = stranger.put(f"/api/v1/secrets/{s.id}/chunks/0/0", content=b"x" * 32)
    assert r.status_code == 404
    r = stranger.put(f"/api/v1/secrets/{s.id}/chunks/0/0", content=b"x" * 32, headers={"Authorization": "Upload " + "A" * 43})
    assert r.status_code == 404


def test_stranger_cannot_burn_by_id(client):
    s = send(client)
    stranger = anon(client)
    assert stranger.post(f"/api/v1/secrets/{s.id}/reveal").status_code == 404
    assert open_meta(stranger, s)["views_left"] == 1


def test_upload_is_closed_after_seal(client):
    s = send(client)
    r = client.put(f"/api/v1/secrets/{s.id}/chunks/0/0", content=b"x" * 32, headers={"Authorization": f"Upload {s.upload_token}"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_sealed"


def test_failed_tokens_block_the_ip_for_an_hour(server):
    c = server(RATE_FAILED_TOKENS="5/h")
    s = send(c)
    stranger = anon(c)
    for _ in range(5):
        assert stranger.get(f"/api/v1/secrets/{s.id}/meta", headers={"Authorization": "Reveal " + "C" * 43}).status_code == 404
    r = stranger.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers())
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > 3500


def test_ipv6_addresses_are_grouped_by_64(server):
    from cryptex.ratelimit import subject
    assert subject("2001:db8:1:2::1") == subject("2001:db8:1:2:ffff:ffff:ffff:ffff")
    assert subject("2001:db8:1:2::1") != subject("2001:db8:1:3::1")
    assert subject("203.0.113.7") == "ip:203.0.113.7"


def test_the_app_never_reads_forwarded_for_itself(server):
    c = server(RATE_CREATE="2/h")
    bob = anon(c)
    # Only uvicorn reads X-Forwarded-For, and only from TRUSTED_PROXIES: rotating it doesn't help
    send(bob, headers={"X-Forwarded-For": "198.51.100.1"})
    send(bob, headers={"X-Forwarded-For": "198.51.100.2"})
    r = bob.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600}, "streams": []}, headers={"X-Forwarded-For": "198.51.100.3"})
    assert r.status_code == 429


# ------------------------------------------------------------------ link scanners and previews
def test_scanner_load_does_not_consume(client):
    s = send(client)
    scanner = anon(client)
    for _ in range(20):
        assert open_meta(scanner, s)["views_left"] == 1
    manifest, _ = reveal(anon(client), s)
    assert manifest["items"]


# ------------------------------------------------------------------ someone who sees the link in transit
def test_link_in_transit_cannot_open_after_it_was_opened(client):
    s = send(client)
    reveal(anon(client), s)
    r = anon(client).post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "opened"


def test_sender_sees_opened_immediately(client):
    s = send(client)
    reveal(anon(client), s)
    rec = client.get(f"/api/v1/receipts/{s.id}", headers=s.manage_headers()).json()
    assert rec["status"] == "opened"
    assert [e["type"] for e in rec["events"]] == ["secret.created", "secret.sealed", "secret.revealed"]


# ------------------------------------------------------------------ passphrases
def test_passphrase_wrong_five_times_destroys(client):
    s = send(client, passphrase="copper-lantern-river-42")
    bob = anon(client)
    m = open_meta(bob, s)
    assert m["passphrase"] and m["tries_left"] == 5 and m["passphrase_salt"]
    for left in (4, 3, 2, 1):
        r = bob.post(f"/api/v1/secrets/{s.id}/reveal", headers={**s.reveal_headers(), "X-Passcheck": passcheck(s, "nope")})
        assert r.status_code == 422 and r.json()["error"]["tries_left"] == left
    r = bob.post(f"/api/v1/secrets/{s.id}/reveal", headers={**s.reveal_headers(), "X-Passcheck": passcheck(s, "nope")})
    assert r.status_code == 410 and r.json()["error"]["reason"] == "too_many_tries"
    assert chunk_files() == []
    rec = client.get(f"/api/v1/receipts/{s.id}", headers=s.manage_headers()).json()
    assert rec["status"] == "destroyed" and rec["reason"] == "too_many_tries"


def test_passphrase_right_after_a_wrong_one(client):
    s = send(client, passphrase="copper-lantern-river-42")
    bob = anon(client)
    bob.post(f"/api/v1/secrets/{s.id}/reveal", headers={**s.reveal_headers(), "X-Passcheck": passcheck(s, "nope")})
    manifest, _ = reveal(bob, s, passphrase="copper-lantern-river-42")
    assert manifest["items"][0]["v"] == "k7#Qp2-vR9mL"


def test_passphrase_failures_cannot_be_triggered_without_the_link(client):
    s = send(client, passphrase="copper-lantern-river-42")
    stranger = anon(client)
    for _ in range(10):
        stranger.post(f"/api/v1/secrets/{s.id}/reveal", headers={"Authorization": "Reveal " + "D" * 43, "X-Passcheck": "x" * 43})
    assert open_meta(anon(client), s)["tries_left"] == 5


def test_seal_requires_passcheck_exactly_when_passphrase_is_set(client):
    s = send(client, passphrase="pw-pw-pw-12", seal=False)
    r = client.post(f"/api/v1/secrets/{s.id}/seal", json={"meta_ct": "AAAA", "reveal_hash": "0" * 64},
                    headers={"Authorization": f"Upload {s.upload_token}"})
    assert r.status_code == 400


# ------------------------------------------------------------------ database or backup thief
def test_database_thief_finds_no_plaintext(server):
    c = server()
    secret_value, title, filename = "hunter2-PLAINTEXT-canary", "Canary title", "canary-file.txt"
    send(c, items=[{"t": "note", "v": secret_value}], files=[(filename, b"file canary contents")], title=title)
    data = (state.env().data_dir / "cryptex.db").read_bytes()
    wal = state.env().data_dir / "cryptex.db-wal"
    if wal.exists():
        data += wal.read_bytes()
    for p in chunk_files():
        data += p.read_bytes()
    for canary in (secret_value, title, filename, "file canary contents"):
        assert canary.encode() not in data, canary


def test_tokens_are_stored_hashed(client):
    s = send(client)
    data = (state.env().data_dir / "cryptex.db").read_bytes()
    wal = state.env().data_dir / "cryptex.db-wal"
    data += wal.read_bytes() if wal.exists() else b""
    for tok in (s.manage_token, s.upload_token, s.reveal_token):
        assert tok.encode() not in data


# ------------------------------------------------------------------ uploads and sizes
def test_chunk_size_must_match_declaration(client):
    big = b"z" * (CHUNK + 10)
    s = send(client, files=[("f", big)], upload=False, seal=False)
    up = {"Authorization": f"Upload {s.upload_token}"}
    assert client.put(f"/api/v1/secrets/{s.id}/chunks/1/0", content=b"short", headers=up).status_code == 400
    assert client.put(f"/api/v1/secrets/{s.id}/chunks/1/9", content=b"x" * 26, headers=up).status_code == 400
    r = client.post(f"/api/v1/secrets/{s.id}/seal", json={"meta_ct": "AAAA", "reveal_hash": "0" * 64}, headers=up)
    assert r.status_code == 400  # chunks missing


def test_declared_sizes_are_checked_against_limits(server):
    c = server(MAX_FILE_SIZE="1kb", MAX_FILES="1")
    pre = "AAAAAAAAAA"
    m = {"stream": 0, "prefix": pre, "chunks": 1, "size": 100}
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600}, "streams": [m, {"stream": 1, "prefix": pre, "chunks": 1, "size": 1024 + 17}]})
    assert r.status_code == 413 and r.json()["error"]["limit"] == 1024
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600},
                                        "streams": [m, {**m, "stream": 1}, {**m, "stream": 2}]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "limit_exceeded"
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600}, "streams": [{**m, "chunks": 2}]})
    assert r.status_code == 400  # chunk count doesn't match the size
    r = c.post("/api/v1/secrets", json={"policy": {"views": 3, "expires_in": 3600}, "streams": [m]})
    assert r.status_code == 400  # once, or until it expires
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 30 * 86400}, "streams": [m]})
    assert r.status_code == 400


def test_cancel_upload_removes_chunks(client):
    s = send(client, files=[("a", b"abc")], seal=False)
    assert chunk_files()
    r = client.delete(f"/api/v1/secrets/{s.id}/upload", headers={"Authorization": f"Upload {s.upload_token}"})
    assert r.status_code == 204 and chunk_files() == []


# ------------------------------------------------------------------ rate limits (audit: none on credential checks)
def test_create_is_rate_limited_with_retry_after(server):
    c = server(RATE_CREATE="2/h")
    bob = anon(c)
    send(bob)
    send(bob)
    r = bob.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600}, "streams": []})
    assert r.status_code == 429 and 0 < int(r.headers["Retry-After"]) <= 3600
    assert r.json()["error"]["reset_at"]


def test_reveal_and_create_use_separate_limits(server):
    c = server(RATE_CREATE="1/h", RATE_REVEAL="100/h")
    bob = anon(c)
    s = send(bob)
    for _ in range(5):
        open_meta(bob, s)


def test_login_is_rate_limited(server):
    c = server(RATE_AUTH="4/15m")
    bob = anon(c)
    for _ in range(4):
        r = bob.post("/api/v1/auth/login", json=login_body(bob, OWNER["username"], "x"))
        assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_password"
    r = bob.post("/api/v1/auth/login", json=login_body(bob, OWNER["username"], OWNER["password"]))
    assert r.status_code == 429  # even the right password, until the window ends


def test_login_message_is_the_same_for_an_unknown_username(client):
    bob = anon(client)
    a = bob.post("/api/v1/auth/login", json=login_body(bob, OWNER["username"], "wrong"))
    b = bob.post("/api/v1/auth/login", json=login_body(bob, "nobody", "wrong"))
    assert a.status_code == b.status_code == 401 and a.json() == b.json()


# ------------------------------------------------------------------ open redirect (audit: /\ in login return path)
def test_return_to_is_same_origin_only():
    for bad in ("//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "", "/\x00x"):
        assert safe_return_to(bad) == "/"
    assert safe_return_to("/links?x=1") == "/links?x=1"


# ------------------------------------------------------------------ settings can't brick the server (audit: bad setting → 500)
def test_invalid_limits_are_rejected_with_a_message(client):
    for body in ({"max_views": 0}, {"max_file_size": "lots"}, {"max_expiration": "99y"}, {"max_files": -1}, {"nope": 1},
                 {"max_file_size": "1" * 400 + "gb"}, {"max_expiration": "9" * 400 + "d"}, {"max_files": "9" * 5000},
                 {"max_files": 1.7}, {"max_files": "1e3"}, {"max_files": True}, {"max_file_size": "500b"}, {"max_expiration": "36501d"}, {"max_message_length": [1]}):
        r = client.put("/api/v1/server/limits", json=body)
        assert r.status_code == 400 and r.json()["error"]["field"] == next(iter(body)), body
        message = r.json()["error"]["message"]
        assert not re.search(r"literal|Exceeds|int\(|float|Overflow|Traceback", message), message  # written for people
    r = client.put("/api/v1/server/limits", json={"max_file_size": "500b"})
    assert r.json()["error"]["message"] == "That max file size must be at least 1kb."
    # Sizes and counts have no ceiling: the owner decides (MIN_FREE_DISK still guards the disk).
    assert client.put("/api/v1/server/limits", json={"max_files": "500", "max_file_size": "50gb", "max_message_length": 10**7,
                                                      "max_expiration": "36500d"}).status_code == 204
    assert client.get("/api/v1/config").json()["limits"] == {**client.get("/api/v1/config").json()["limits"], "max_files": 500,
                                                              "max_file_bytes": 50 * 1024**3, "max_message_chars": 10**7,
                                                              "max_expires_in": 36500 * 86400}


def test_env_locked_limits_are_read_only(server):
    c = server(MAX_MESSAGE_LENGTH="5000")
    item = c.get("/api/v1/server/limits").json()["items"]["max_message_length"]
    assert item == {**item, "value": 5000, "locked_by": "MAX_MESSAGE_LENGTH"}
    r = c.put("/api/v1/server/limits", json={"max_message_length": 100})
    assert r.status_code == 400 and "MAX_MESSAGE_LENGTH" in r.json()["error"]["message"]


def test_invalid_env_fails_fast_with_the_variable_name(tmp_path):
    from cryptex.config import load_env
    for k, v in (("MAX_FILE_SIZE", "huge"), ("MAX_FILE_SIZE", "1" * 400 + "gb"), ("MAX_FILE_SIZE", "1" * 30), ("MIN_FREE_DISK", "1" * 400 + "gb"),
                 ("MAX_FILES", "1.5"), ("MAX_EXPIRATION", "9" * 30 + "d"),
                 ("RATE_CREATE", "500/7d"), ("RATE_AUTH", "10/25h"), ("RATE_STATUS", "9" * 40 + "/h")):
        with pytest.raises(ValueError, match=k):  # a ValueError naming the variable, never an OverflowError
            load_env({"DATA_DIR": str(tmp_path), k: v})
    assert load_env({"DATA_DIR": str(tmp_path), "RATE_CREATE": "500/1d"}).rate_create.window == 86400  # a day is fine


# ------------------------------------------------------------------ setup
def test_nothing_can_be_created_until_an_owner_exists(server):
    c = server(setup=False)
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600}, "streams": []})
    assert r.status_code == 403
    assert c.get("/api/v1/config").json()["setup_needed"] is True
    assert c.post("/api/v1/setup", json={**SETUP, "setup_code": "WRONG"}).status_code == 400
    r = c.post("/api/v1/setup", json={**SETUP, "auth_key": "my password"})
    assert r.status_code == 400  # a password sent as-is is refused: only a derived key is accepted
    assert c.get("/api/v1/config").json()["setup_needed"] is True  # nothing was half done


def test_setup_can_only_run_once(client):
    r = anon(client).post("/api/v1/setup", json={**SETUP, "username": "eve"})
    assert r.status_code == 409


def test_generated_setup_code_is_kept_until_the_owner_exists(server, monkeypatch, capsys):
    c = server(setup=False, seed_code=False)
    path = state.env().data_dir / "setup-code"
    code = path.read_text().strip()  # made at startup, for the log line
    assert re.fullmatch(r"[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}", code)
    assert path.stat().st_mode & 0o777 == 0o600
    # `cryptex setup-code` runs in another process: it reads the same code instead of making a new one.
    monkeypatch.setenv("DATA_DIR", str(state.env().data_dir))
    assert manage.main(["setup-code"]) == 0
    assert capsys.readouterr().out.strip().splitlines()[-1] == code  # (the log handler shares stdout)
    assert c.post("/api/v1/setup", json={**SETUP, "setup_code": ""}).status_code == 400
    r = c.post("/api/v1/setup", json={**SETUP, "setup_code": f" {code.lower()} "})
    assert r.status_code == 200, r.text
    assert not path.exists()  # used up
    assert manage.main(["setup-code"]) == 1
    assert "already finished" in capsys.readouterr().err


def test_a_crash_mid_write_never_makes_an_empty_setup_code(server):
    server(setup=False, seed_code=False)
    path = state.env().data_dir / "setup-code"
    path.write_text("\n")
    assert re.fullmatch(r"[0-9A-F-]{14}", state.setup_code())


def test_setup_screen_names_the_command_only_in_the_container(server, monkeypatch, tmp_path):
    monkeypatch.setattr(state, "DOCKERENV", tmp_path / "no-dockerenv")
    c = server(setup=False)
    assert c.get("/api/v1/setup").json()["code_command"] is None
    (tmp_path / ".dockerenv").touch()
    monkeypatch.setattr(state, "DOCKERENV", tmp_path / ".dockerenv")
    monkeypatch.setattr("socket.gethostname", lambda: "be1df0b50ddb")  # Docker's default: the short container ID
    assert c.get("/api/v1/setup").json()["code_command"] == "docker exec be1df0b50ddb cryptex setup-code"
    monkeypatch.setattr("socket.gethostname", lambda: "vault-01")  # a custom hostname: use the documented name
    assert c.get("/api/v1/setup").json()["code_command"] == "docker exec cryptex cryptex setup-code"


# ------------------------------------------------------------------ cleanup and retention
def test_expired_secret_leaves_a_tombstone_and_an_event(client):
    s = send(client, files=[("a", b"abc")])
    db.run("UPDATE secrets SET expires_at = ? WHERE id = ?", now() - 1, s.id)
    jobs.cleanup()
    assert chunk_files() == []
    r = anon(client).get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "expired"
    assert client.get(f"/api/v1/receipts/{s.id}", headers=s.manage_headers()).json()["status"] == "expired"
    db.run("UPDATE tombstones SET purge_after = ?", now() - 1)
    jobs.tombstones()
    assert anon(client).get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers()).status_code == 404


def test_last_view_purges_when_the_read_session_ends(client):
    s = send(client, files=[("a", b"abc")])
    r = anon(client).post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers())
    assert r.status_code == 200
    assert chunk_files()  # not downloaded yet
    db.run("UPDATE read_sessions SET expires_at = ?", now() - 1)
    jobs.cleanup()
    assert chunk_files() == []


def test_abandoned_upload_is_removed(client):
    send(client, files=[("a", b"abc")], seal=False)
    db.run("UPDATE secrets SET upload_active_at = ?", now() - items.UPLOAD_IDLE - 1)
    jobs.cleanup()
    assert chunk_files() == [] and db.val("SELECT count(*) FROM secrets") == 0


def test_audit_retention(client):
    send(client)
    db.run("UPDATE events SET at = ?", now() - 400 * 86400)
    jobs.audit()
    assert db.val("SELECT count(*) FROM events") == 0


# ------------------------------------------------------------------ events never hold content
def test_events_hold_no_content(client):
    send(client, items=[{"t": "note", "v": "event-canary"}], title="event-title-canary")
    for r in db.all("SELECT * FROM events"):
        blob = json.dumps(dict(r))
        assert "canary" not in blob


def test_logs_hold_no_tokens(server, capsys):
    """At the production log level (info): every request is logged, and no token is in any line."""
    c = server(LOG_LEVEL="info")
    capsys.readouterr()
    s = send(c, files=[("a.txt", b"abc")])
    b = anon(c)
    reveal(b, s)
    b.get(f"/api/v1/receipts/{s.id}", headers=s.manage_headers())
    out = capsys.readouterr().out
    lines = [json.loads(line) for line in out.splitlines()]
    assert sum(1 for x in lines if x["msg"] == "request") >= 8  # the logging under test really ran
    assert any(x["msg"] == "event secret.revealed" for x in lines)
    for tok in (s.manage_token, s.upload_token, s.reveal_token, s.fragment, c.headers["X-CSRF"]):
        assert tok not in out


def test_enc_key_is_generated_once_with_0600(server):
    server()
    p = state.env().data_dir / "enc.key"
    assert p.exists() and oct(os.stat(p).st_mode & 0o777) == "0o600"


def test_last_view_survives_a_dropped_last_chunk_for_a_few_minutes(client):
    """A retry after a lost response still works; then the grace ends and cleanup deletes it."""
    s = send(client, files=[("a", b"abc")])
    bob = anon(client)
    manifest, _ = reveal(bob, s, done=False)
    r = bob.post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers())
    assert r.status_code == 410  # no second view
    assert chunk_files()  # still there for the retry
    exp = db.val("SELECT expires_at FROM read_sessions")
    assert now() + items.READ_GRACE - 2 <= exp <= now() + items.READ_GRACE
    db.run("UPDATE read_sessions SET expires_at = ?", now() - 1)
    jobs.cleanup()
    assert chunk_files() == []


def test_read_done_needs_the_read_session(client):
    s = send(client)
    assert anon(client).delete(f"/api/v1/secrets/{s.id}/read", headers=s.reveal_headers()).status_code == 404


def test_owner_reset_command(client, capsys):
    from cryptex import manage
    assert manage.owner_reset(None) == 0
    out = capsys.readouterr().out
    url = [line.strip() for line in out.splitlines() if line.startswith("  ")][0]
    assert url.startswith("http://localhost:8080/invite#")
    assert client.get("/api/v1/auth/session").json()["user"] is None  # signed out everywhere
    # the old password no longer works; the invite sets a new one
    r = anon(client).post("/api/v1/auth/login", json=login_body(anon(client), OWNER["username"], OWNER["password"]))
    assert r.status_code == 401
    info = anon(client).post("/api/v1/auth/invite", json={"token": url.split("#")[1]}).json()
    assert info["username"] == OWNER["username"] and info["reset"] is True
    assert manage.owner_reset("nobody") == 1


def test_change_password_signs_out_other_sessions(client):
    other = sign_in(anon(client))
    current = auth_key(OWNER["password"], OWNER_SALT)
    r = client.put("/api/v1/me/password", json={"current_auth_key": auth_key("wrong", OWNER_SALT), "new": creds("x" * 12)})
    assert r.status_code == 401 and r.json()["error"] == {**r.json()["error"], "code": "wrong_password", "field": "current"}
    assert client.put("/api/v1/me/password", json={"current_auth_key": current, "new": creds("a brand new passphrase")}).status_code == 204
    assert other.get("/api/v1/auth/session").json()["user"] is None
    assert client.get("/api/v1/auth/session").json()["user"] is not None


# ------------------------------------------------------------------ device keys: what a signed-in browser keeps is locked to the account
DEVICE = "dev_0123456789abcdef"


def test_device_key_is_stable_per_device_and_only_for_a_session(client):
    k1 = client.post("/api/v1/me/device-key", json={"device_id": DEVICE}).json()["key"]
    assert len(base64.urlsafe_b64decode(k1 + "==")) == 32
    assert client.post("/api/v1/me/device-key", json={"device_id": DEVICE}).json()["key"] == k1  # same browser, same key
    assert client.post("/api/v1/me/device-key", json={"device_id": "dev_another_browser_1"}).json()["key"] != k1
    r = anon(client).post("/api/v1/me/device-key", json={"device_id": DEVICE})
    assert r.status_code == 401 and r.json()["error"]["code"] == "sign_in_required"
    assert client.post("/api/v1/me/device-key", json={"device_id": "short"}).status_code == 400


def test_device_key_is_gone_with_the_session(client):
    assert client.post("/api/v1/me/device-key", json={"device_id": DEVICE}).status_code == 200
    assert client.post("/api/v1/auth/logout").status_code == 204
    r = client.post("/api/v1/me/device-key", json={"device_id": DEVICE})
    assert r.status_code == 401 and r.json()["error"]["code"] == "sign_in_required"


def test_signing_out_forgets_this_devices_key(client):
    client.post("/api/v1/me/device-key", json={"device_id": DEVICE})
    client.post("/api/v1/me/device-key", json={"device_id": "dev_another_browser_1"})
    assert client.post("/api/v1/auth/logout", json={"device_id": DEVICE}).status_code == 204
    assert db.val("SELECT count(*) FROM device_keys WHERE device_id = ?", DEVICE) == 0
    assert db.val("SELECT count(*) FROM device_keys WHERE device_id = ?", "dev_another_browser_1") == 1  # other browsers keep theirs


def test_device_key_is_kept_encrypted_at_rest(client):
    key = base64.urlsafe_b64decode(client.post("/api/v1/me/device-key", json={"device_id": DEVICE}).json()["key"] + "==")
    stored = db.val("SELECT key_ct FROM device_keys WHERE device_id = ?", DEVICE)
    assert key not in stored


# ------------------------------------------------------------------ zero-knowledge sign-in and the account vault
WRAP = "v1." + "n" * 16 + "." + "c" * 60
ITEM = "v1." + "n" * 16 + "." + "x" * 80


def unlock(c, password=OWNER["password"], salt=OWNER_SALT):
    """The unlock prompt: the full vault bundle, for the account's password."""
    r = c.post("/api/v1/me/vault/unlock", json={"auth_key": auth_key(password, salt)})
    assert r.status_code == 200, r.text
    return r.json()


def test_prelogin_does_not_tell_who_has_an_account(client):
    bob = anon(client)
    a = bob.post("/api/v1/auth/prelogin", json={"username": "nobody"}).json()
    assert a == bob.post("/api/v1/auth/prelogin", json={"username": "nobody"}).json()  # stable
    assert a["salt"] != bob.post("/api/v1/auth/prelogin", json={"username": "other"}).json()["salt"]
    real = bob.post("/api/v1/auth/prelogin", json={"username": OWNER["username"]}).json()
    assert real["salt"] == OWNER_SALT and set(real) == set(a) == {"salt", "kdf"}


def test_the_server_only_ever_gets_a_derived_key(client):
    u = db.one("SELECT password_hash, kdf_salt, unlock_ct FROM users WHERE username = ?", OWNER["username"])
    assert OWNER["password"] not in str(dict(u))
    r = anon(client).post("/api/v1/auth/login", json={"username": OWNER["username"], "password": OWNER["password"]})
    assert r.status_code == 400  # a plain password isn't even a valid request


def test_sign_in_returns_the_vault_bundle_and_keys_need_reauth_to_replace(client):
    me = sign_in(anon(client))
    b = unlock(me)
    assert b["salt"] == OWNER_SALT and len(b["unlock_share"]) == 43 and b["vault_pw"] is None
    assert me.put("/api/v1/me/vault/keys", json={"vault_pw": WRAP}).status_code == 204
    assert unlock(me)["vault_pw"] == WRAP
    db.run("UPDATE sessions SET reauth_until = 0")
    r = me.put("/api/v1/me/vault/keys", json={"vault_pw": WRAP.replace("c", "d")})
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    assert anon(client).get("/api/v1/me/vault/keys").status_code == 401


def test_vault_items_are_per_account_and_session_only(client):
    assert client.put("/api/v1/me/vault/items/k7Qp2vR9mL", json={"ct": ITEM}).status_code == 204
    assert client.put("/api/v1/me/vault/items/k7Qp2vR9mL", json={"ct": ITEM + "y"}).status_code == 204  # update
    assert client.put("/api/v1/me/vault/items/k7Qp2vR9mL", json={"ct": "plain title"}).status_code == 400
    assert client.put("/api/v1/me/vault/items/not-an-id!", json={"ct": ITEM}).status_code == 400
    items = client.get("/api/v1/me/vault/items").json()["items"]
    assert [(i["id"], i["ct"]) for i in items] == [("k7Qp2vR9mL", ITEM + "y")]
    assert anon(client).get("/api/v1/me/vault/items").status_code == 401
    lisa = anon(client)
    url = client.post("/api/v1/server/users", json={"username": "lisa", "role": "member"}).json()["invite_url"]
    token = url.split("#", 1)[1]
    info = lisa.post("/api/v1/auth/invite", json={"token": token}).json()
    r = lisa.post("/api/v1/auth/invite/accept", json={"token": token, **creds("lisa's long passphrase"), "totp_secret": info["secret"],
                                                     "totp_code": pyotp.TOTP(info["secret"]).now()})
    lisa.headers["X-CSRF"] = r.json()["csrf"]
    assert r.json()["vault"]["vault_pw"] is None and len(r.json()["vault"]["unlock_share"]) == 43
    assert lisa.get("/api/v1/me/vault/items").json()["items"] == []  # nobody sees another person's vault
    assert client.delete("/api/v1/me/vault/items/k7Qp2vR9mL").status_code == 204
    assert client.get("/api/v1/me/vault/items").json()["items"] == []


def test_a_password_reset_clears_the_vault_and_keeps_the_links(client):
    assert client.put("/api/v1/me/vault/keys", json={"vault_pw": WRAP}).status_code == 204
    assert client.put("/api/v1/me/vault/items/k7Qp2vR9mL", json={"ct": ITEM}).status_code == 204
    sent = send(client)
    assert manage.owner_reset(None) == 0
    assert db.val("SELECT vault_pw FROM users WHERE username = ?", OWNER["username"]) is None
    assert db.val("SELECT count(*) FROM vault_items") == 0  # only the old password could read them
    assert db.val("SELECT count(*) FROM user_receipts WHERE secret_id = ?", sent.id) == 1


def test_changing_the_password_rewraps_the_vault(client):
    current = auth_key(OWNER["password"], OWNER_SALT)
    assert client.put("/api/v1/me/vault/keys", json={"vault_pw": WRAP}).status_code == 204
    new = creds("a brand new passphrase")
    rewrapped = WRAP.replace("c", "e")
    assert client.put("/api/v1/me/password", json={"current_auth_key": current, "new": new, "vault_pw": rewrapped}).status_code == 204
    b = unlock(client, "a brand new passphrase", new["salt"])
    assert b["salt"] == new["salt"] and b["vault_pw"] == rewrapped
    assert sign_in(anon(client), password="a brand new passphrase")


# ------------------------------------------------------------------ temporary passwords (audit: they outlived every other recovery path)
def forgot_and_read(c, monkeypatch, capsys, username=OWNER["username"]):
    assert anon(c).post("/api/v1/auth/forgot", json={"username": username}).status_code == 200
    e = state.env()
    monkeypatch.setenv("DATA_DIR", str(e.data_dir))
    try:
        assert manage.main(["temp-password", username]) == 0
    finally:
        state.init(e)
    return capsys.readouterr().out.strip().splitlines()[-1]


def temp_login(c, password, username=OWNER["username"]):
    b = anon(c)
    return b.post("/api/v1/auth/login", json=login_body(b, username, password))


def stand_in_kdf(monkeypatch):
    from cryptex import account
    from cryptex.util import b64u
    monkeypatch.setattr(account, "derive_auth_key", lambda pw, salt, kdf: auth_key(pw, b64u(salt)))


def test_temporary_password_dies_with_an_owner_reset_and_the_invite_after_it(client, monkeypatch, capsys):
    stand_in_kdf(monkeypatch)
    temp = forgot_and_read(client, monkeypatch, capsys)
    r = temp_login(client, temp)
    assert set(r.json()) == {"reset_ticket"}
    ticket = r.json()["reset_ticket"]
    assert manage.owner_reset(None) == 0
    url = [line.strip() for line in capsys.readouterr().out.splitlines() if line.startswith("  ")][0]
    assert anon(client).post("/api/v1/auth/password/reset", json={"reset_ticket": ticket, **creds("x" * 12)}).status_code == 401
    token = url.split("#", 1)[1]
    assert anon(client).post("/api/v1/auth/invite/accept", json={"token": token, **creds("brand new owner pw")}).status_code == 200
    r = temp_login(client, temp)
    assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_password"  # no session with 2FA turned off


def test_temporary_password_dies_with_a_password_change(client, monkeypatch, capsys):
    stand_in_kdf(monkeypatch)
    temp = forgot_and_read(client, monkeypatch, capsys)
    current = auth_key(OWNER["password"], OWNER_SALT)
    assert client.put("/api/v1/me/password", json={"current_auth_key": current, "new": creds("a brand new passphrase")}).status_code == 204
    assert temp_login(client, temp).status_code == 401
    assert not (state.env().data_dir / "temp-passwords" / OWNER["username"]).exists()


def test_removed_persons_temporary_password_cannot_take_over_a_new_account_with_their_name(client, monkeypatch, capsys):
    stand_in_kdf(monkeypatch)
    url = client.post("/api/v1/server/users", json={"username": "alice"}).json()["invite_url"]
    alice = anon(client)
    assert alice.post("/api/v1/auth/invite/accept", json={"token": url.split("#")[1], **creds("alice's passphrase")}).status_code == 200
    uid = alice.get("/api/v1/auth/session").json()["user"]["id"]
    temp = forgot_and_read(client, monkeypatch, capsys, "alice")
    assert client.delete(f"/api/v1/server/users/{uid}").status_code == 204
    assert not (state.env().data_dir / "temp-passwords" / "alice").exists()
    url = client.post("/api/v1/server/users", json={"username": "alice"}).json()["invite_url"]
    assert anon(client).post("/api/v1/auth/invite/accept", json={"token": url.split("#")[1], **creds("the new alice")}).status_code == 200
    assert temp_login(client, temp, "alice").status_code == 401


def test_someone_else_cannot_replace_a_waiting_temporary_password(client, monkeypatch, capsys):
    stand_in_kdf(monkeypatch)
    temp = forgot_and_read(client, monkeypatch, capsys)
    for _ in range(3):
        assert forgot_and_read(client, monkeypatch, capsys) == temp  # the one passed on keeps working
    assert db.val("SELECT count(*) FROM events WHERE type = 'user.temp_password'") == 1
    assert set(temp_login(client, temp).json()) == {"reset_ticket"}


def test_login_does_no_server_side_argon2_for_an_account_with_a_temporary_password(client, monkeypatch, capsys):
    """Audit: a waiting temporary password made every failed login for that account run Argon2id (timing oracle)."""
    stand_in_kdf(monkeypatch)
    temp = forgot_and_read(client, monkeypatch, capsys)
    from cryptex import account

    def boom(*_):
        raise AssertionError("Argon2id at login")
    monkeypatch.setattr(account, "derive_auth_key", boom)
    assert temp_login(client, "wrong").status_code == 401
    assert set(temp_login(client, temp).json()) == {"reset_ticket"}


# ------------------------------------------------------------------ 2FA guessing (audit: per-IP limit only, tries not atomic)
def test_wrong_passwords_and_2fa_codes_share_one_limit_per_account_whatever_the_ip(server):
    """Each wrong guess from an address of its own: the per-address limits never come into it (audit P-P8)."""
    c = server()
    for i in range(15):
        g = from_address(c, f"198.18.2.{i + 1}")
        assert g.post("/api/v1/auth/login", json=login_body(g, OWNER["username"], "guess")).status_code == 401
    b = from_address(c, "198.18.1.1")
    last = b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).json()["mfa_ticket"]
    for i in range(15):
        g = from_address(c, f"198.18.0.{i + 1}")
        t = g.post("/api/v1/auth/login", json=login_body(g, OWNER["username"], OWNER["password"])).json()["mfa_ticket"]
        r = g.post("/api/v1/auth/login/totp", json={"mfa_ticket": t, "code": "000000" if totp_code() != "000000" else "111111"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_code", i
    r = b.post("/api/v1/auth/login/totp", json={"mfa_ticket": last, "code": totp_code()})
    assert r.status_code == 429  # even the right code: the account is closed to guesses for the hour
    assert b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).status_code == 429
    r = c.post("/api/v1/auth/reauth", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT), "code": totp_code()})
    assert r.status_code == 429  # re-auth shares the limit


def test_a_sign_in_ticket_checks_five_codes_at_most(server):
    c = server(RATE_AUTH="1000/15m")
    b = anon(c)
    t = b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).json()["mfa_ticket"]
    wrong = "000000" if totp_code() != "000000" else "111111"
    lefts = [b.post("/api/v1/auth/login/totp", json={"mfa_ticket": t, "code": wrong}).json()["error"].get("tries_left") for _ in range(5)]
    assert lefts == [4, 3, 2, 1, 0]
    r = b.post("/api/v1/auth/login/totp", json={"mfa_ticket": t, "code": totp_code()})
    assert r.status_code == 401 and r.json()["error"]["reason"] == "expired"


def test_parallel_2fa_guesses_cannot_share_a_try(server):
    """Audit: 40 parallel requests got 6 codes checked on one ticket."""
    import concurrent.futures
    c = server(RATE_AUTH="1000/15m")
    b = anon(c)
    t = b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).json()["mfa_ticket"]
    from cryptex.routes import auth as auth_routes
    checked = []
    real = auth_routes.check_totp
    monkey = lambda cl, u, code: (checked.append(code), real(cl, u, code))  # noqa: E731
    auth_routes.check_totp = monkey
    try:
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            list(pool.map(lambda _: b.post("/api/v1/auth/login/totp", json={"mfa_ticket": t, "code": "999999"}), range(16)))
    finally:
        auth_routes.check_totp = real
    assert len(checked) <= 5


# ------------------------------------------------------------------ sign-in limits that an office behind NAT can live with
def test_failed_sign_ins_count_toward_rate_auth_and_successful_ones_dont(server):
    c = server(RATE_AUTH="3/15m")
    for _ in range(6):
        sign_in(anon(c))  # an office signing in: password and code, all fine
    for _ in range(3):
        b = anon(c)
        assert b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], "typo")).status_code == 401
    b = anon(c)
    assert b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).status_code == 429


def test_an_office_behind_one_address_signs_in_with_2fa_many_times(server):
    """Audit P-P3: an office behind one NAT address got about 19 sign-ins with 2FA per 15 minutes. Only failures count
    now: a sign-in that succeeds gives its units back."""
    c = server()
    for _ in range(100):
        sign_in(anon(c))  # pre-login, password, 2FA code
    assert not db.val("SELECT sum(count) FROM rate_limits WHERE bucket LIKE 'auth:%' OR bucket LIKE 'sign_in:%'")
    b = anon(c)
    r = b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"]))
    assert r.status_code == 200, r.text


# ------------------------------------------------------------------ shared computers and session lifetime
def test_shared_computer_session_is_a_browser_session_cookie_and_never_slides(client):
    from cryptex.deps import SHARED_TTL
    b = anon(client)
    r = b.post("/api/v1/auth/login", json={**login_body(b, OWNER["username"], OWNER["password"]), "shared": True})
    r = b.post("/api/v1/auth/login/totp", json={"mfa_ticket": r.json()["mfa_ticket"], "code": totp_code()})
    assert r.json()["shared"] is True  # inherited from the password step
    cookie = r.headers["set-cookie"].lower()
    assert "max-age" not in cookie and "expires" not in cookie
    assert b.get("/api/v1/auth/session").json()["shared"] is True
    s = db.one("SELECT * FROM sessions WHERE shared = 1")
    assert s["expires_at"] - s["created_at"] == SHARED_TTL
    db.run("UPDATE sessions SET expires_at = ? WHERE shared = 1", now() + 60)
    b.get("/api/v1/auth/session")
    assert db.val("SELECT expires_at FROM sessions WHERE shared = 1") <= now() + 60  # no sliding


def test_sessions_slide_but_never_past_thirty_days(client):
    from cryptex.deps import SESSION_MAX
    assert client.get("/api/v1/auth/session").json()["shared"] is False
    db.run("UPDATE sessions SET created_at = ?, expires_at = ?", now() - SESSION_MAX + 7200, now() + 60)
    client.get("/api/v1/auth/session")
    s = db.one("SELECT * FROM sessions")
    assert s["expires_at"] == s["created_at"] + SESSION_MAX  # capped, not now + 14 days
    db.run("UPDATE sessions SET expires_at = ?", now() - 1)
    assert client.get("/api/v1/auth/session").json()["user"] is None


def shared_session(r) -> bool:
    """The response says shared, the session row is shared, and its cookie is a browser-session cookie."""
    assert r.status_code == 200, r.text
    cookie = r.headers["set-cookie"].lower()
    row = db.one("SELECT shared, created_at, expires_at FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1")
    from cryptex.deps import SHARED_TTL
    return (r.json()["shared"] is True and row["shared"] == 1 and row["expires_at"] - row["created_at"] == SHARED_TTL
            and "max-age" not in cookie and "expires" not in cookie)


def test_shared_flag_reaches_every_way_to_sign_in(server, monkeypatch, capsys):
    """Audit: only the invite was covered. Sign-in with and without 2FA, a reset link and a temporary password. Setup
    doesn't offer it: whoever sets up a server does it on their own computer."""
    c = server(setup=False, RATE_AUTH="100/15m")
    r = c.post("/api/v1/setup", json={**SETUP, "shared": True})
    assert r.status_code == 200 and r.json()["shared"] is False
    c.headers["X-CSRF"] = r.json()["csrf"]

    b = anon(c)  # the owner has no 2FA: the password signs in
    assert shared_session(b.post("/api/v1/auth/login", json={**login_body(b, OWNER["username"], OWNER["password"]), "shared": True}))

    url = c.post("/api/v1/server/users", json={"username": "lisa"}).json()["invite_url"]
    info = anon(c).post("/api/v1/auth/invite", json={"token": url.split("#")[1]}).json()
    r = anon(c).post("/api/v1/auth/invite/accept", json={"token": url.split("#")[1], **creds("lisa's passphrase"), "shared": True,
                                                         "totp_secret": info["secret"], "totp_code": pyotp.TOTP(info["secret"]).now()})
    assert shared_session(r)
    lisa_id = r.json()["user"]["id"]

    b = anon(c)  # with 2FA: the ticket remembers it
    t = b.post("/api/v1/auth/login", json={**login_body(b, "lisa", "lisa's passphrase"), "shared": True}).json()["mfa_ticket"]
    assert shared_session(b.post("/api/v1/auth/login/totp", json={"mfa_ticket": t, "code": totp_code("lisa", info["secret"])}))

    link = c.post(f"/api/v1/server/users/{lisa_id}/reset", json={}).json()
    r = anon(c).post("/api/v1/auth/reset/accept", json={"token": link["reset_url"].split("#", 1)[1], "code": link["code"],
                                                        **creds("lisa's new passphrase"), "shared": True})
    assert shared_session(r)

    stand_in_kdf(monkeypatch)
    temp = forgot_and_read(c, monkeypatch, capsys, "lisa")
    b = anon(c)
    ticket = b.post("/api/v1/auth/login", json={**login_body(b, "lisa", temp), "shared": True}).json()["reset_ticket"]
    assert shared_session(b.post("/api/v1/auth/password/reset", json={"reset_ticket": ticket, **creds("lisa's third passphrase")}))

    b = anon(c)  # and not shared unless asked
    r = b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"]))
    assert r.json()["shared"] is False and not shared_session(r)


# ------------------------------------------------------------------ the vault (audit: any session could fetch what guessing needs)
def test_a_stolen_session_cannot_fetch_what_guessing_the_password_needs(client):
    b = client.get("/api/v1/me/vault/keys").json()
    assert set(b) == {"salt", "kdf"}  # no unlock share, no vault_pw
    r = client.post("/api/v1/me/vault/unlock", json={"auth_key": auth_key("a guess", OWNER_SALT)})
    assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_password"
    assert len(unlock(client)["unlock_share"]) == 43


def test_vault_unlock_guesses_count_toward_rate_auth(server):
    c = server(RATE_AUTH="2/15m")
    for _ in range(2):
        assert c.post("/api/v1/me/vault/unlock", json={"auth_key": auth_key("guess", OWNER_SALT)}).status_code == 401
    assert c.post("/api/v1/me/vault/unlock", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT)}).status_code == 429


def test_a_new_vault_key_needs_the_password(client):
    """A typo at the unlock prompt must never become what the password opens."""
    db.run("UPDATE users SET vault_pw = NULL")
    db.run("UPDATE sessions SET reauth_until = 0")
    r = client.put("/api/v1/me/vault/keys", json={"vault_pw": WRAP})
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    r = client.put("/api/v1/me/vault/keys", json={"vault_pw": WRAP, "auth_key": auth_key("typo", OWNER_SALT)})
    assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_password"
    assert client.put("/api/v1/me/vault/keys", json={"vault_pw": WRAP, "auth_key": auth_key(OWNER["password"], OWNER_SALT)}).status_code == 204
    assert unlock(client)["vault_pw"] == WRAP


# ------------------------------------------------------------------ uploads (audit: racing chunk PUTs left orphan blobs)
def test_resending_a_chunk_leaves_one_blob(client):
    s = send(client, seal=False)
    before = set(chunk_files())
    up = {"Authorization": f"Upload {s.upload_token}"}
    size = db.val("SELECT size_bytes FROM chunks WHERE stream = 0 AND n = 0")
    for _ in range(3):
        assert client.put(f"/api/v1/secrets/{s.id}/chunks/0/0", content=b"z" * size, headers=up).status_code == 204
    assert len(chunk_files()) == len(before)


def test_a_chunk_that_loses_a_race_leaves_no_blob(client, monkeypatch):
    from cryptex import storage
    from cryptex.errors import NotFound
    s = send(client, seal=False, upload=False)
    st = db.one("SELECT * FROM streams WHERE secret_id = ? AND stream = 0", s.id)
    data = b"z" * items.expected_chunk_size(st, 0)
    blobs = storage.get()
    real_put = blobs.put

    def cancelled_meanwhile(d):
        key = real_put(d)
        items.purge_secret(s.id, None)  # DELETE /upload, between the checks and the row
        return key
    monkeypatch.setattr(blobs, "put", cancelled_meanwhile)
    with pytest.raises(NotFound):
        items.store_chunk(s.id, 0, 0, data)
    monkeypatch.setattr(blobs, "put", real_put)
    assert chunk_files() == [] and db.val("SELECT count(*) FROM chunks") == 0
    s = send(client, upload=True)
    with pytest.raises(Exception, match="already_sealed"):
        items.store_chunk(s.id, 0, 0, data)
    assert db.val("SELECT count(*) FROM chunks") == len(chunk_files())


def test_parallel_uploads_of_one_chunk_leave_no_orphans(client):
    import concurrent.futures
    s = send(client, seal=False, upload=False)
    st = db.one("SELECT * FROM streams WHERE secret_id = ? AND stream = 0", s.id)
    data = b"z" * items.expected_chunk_size(st, 0)
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda _: items.store_chunk(s.id, 0, 0, data), range(16)))
    assert len(chunk_files()) == db.val("SELECT count(*) FROM chunks") == 1


def test_a_huge_chunk_index_is_a_400_not_a_500(client):
    s = send(client, seal=False)
    up = {"Authorization": f"Upload {s.upload_token}"}
    for path in ("0/99999999999999999999", "99999999999999999999/0", "0/-1"):
        r = client.put(f"/api/v1/secrets/{s.id}/chunks/{path}", content=b"z", headers=up)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", path


def test_seal_refuses_streams_with_a_gap_or_no_chunks(client):
    s = send(client, files=[("a", b"abc"), ("b", b"def")], seal=False)
    up = {"Authorization": f"Upload {s.upload_token}"}
    body = {"meta_ct": "AAAA", "reveal_hash": "0" * 64}
    db.run("UPDATE streams SET stream = 5 WHERE secret_id = ? AND stream = 2", s.id)
    r = client.post(f"/api/v1/secrets/{s.id}/seal", json=body, headers=up)
    assert r.status_code == 400 and r.json()["error"]["field"] == "streams"
    db.run("UPDATE streams SET stream = 2 WHERE secret_id = ? AND stream = 5", s.id)
    db.run("UPDATE streams SET chunks = 0 WHERE secret_id = ? AND stream = 1", s.id)
    r = client.post(f"/api/v1/secrets/{s.id}/seal", json=body, headers=up)
    assert r.status_code == 400 and r.json()["error"]["field"] == "streams"


def test_a_nearly_full_disk_refuses_new_secrets(server):
    c = server(MIN_FREE_DISK="100000gb")
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600},
                                        "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]})
    assert r.status_code == 507 and r.json()["error"]["code"] == "storage_full" and r.json()["error"]["limit"] == 0


# ------------------------------------------------------------------ enc.key (audit: wrong or missing key failed silently)
def test_a_different_enc_key_refuses_to_start(tmp_path):
    from conftest import make_client
    make_client(tmp_path)
    right = (tmp_path / "enc.key").read_text()
    (tmp_path / "enc.key").write_text(base64.b64encode(b"b" * 32).decode())
    with pytest.raises(RuntimeError, match="isn't the key this server was set up with"):
        make_client(tmp_path)
    (tmp_path / "enc.key").write_text(right)
    make_client(tmp_path)  # the right one still works


def test_enc_key_is_never_generated_for_a_server_with_accounts(server):
    from cryptex.config import load_env
    server()
    d = state.env().data_dir
    (d / "enc.key").unlink()
    with pytest.raises(ValueError, match="already has accounts"):
        load_env({"DATA_DIR": str(d)})
    assert not (d / "enc.key").exists()


def test_enc_key_lengths_are_checked(tmp_path):
    from cryptex.config import load_env
    (tmp_path / "d5").mkdir()
    (tmp_path / "d5" / "enc.key").write_text("c2hvcnQ=\n")
    with pytest.raises(ValueError, match="enc.key"):
        load_env({"DATA_DIR": str(tmp_path / "d5")})


# ------------------------------------------------------------------ owners (audit: two owners removing each other left none)
def test_an_owner_who_lost_the_role_mid_request_cannot_remove_the_last_owner(client, monkeypatch):
    from cryptex.routes import server as server_routes
    url = client.post("/api/v1/server/users", json={"username": "olga", "role": "owner"}).json()["invite_url"]
    olga = anon(client)
    assert olga.post("/api/v1/auth/invite/accept", json={"token": url.split("#")[1], **creds("olga's passphrase")}).status_code == 200
    olga_id = olga.get("/api/v1/auth/session").json()["user"]["id"]
    me = client.get("/api/v1/auth/session").json()["user"]["id"]
    real = server_routes.require_reauth

    def olga_removes_me_meanwhile(c):
        real(c)
        db.run("DELETE FROM users WHERE id = ?", me)
    monkeypatch.setattr(server_routes, "require_reauth", olga_removes_me_meanwhile)
    assert client.delete(f"/api/v1/server/users/{olga_id}").status_code == 404
    assert db.val("SELECT count(*) FROM users WHERE role = 'owner'") == 1


def test_owner_reset_recovers_a_server_with_no_owner(client, capsys):
    url = client.post("/api/v1/server/users", json={"username": "lisa"}).json()["invite_url"]
    anon(client).post("/api/v1/auth/invite/accept", json={"token": url.split("#")[1], **creds("lisa's passphrase")})
    db.run("UPDATE users SET role = 'member'")
    assert manage.owner_reset(None) == 1 and "lisa" in capsys.readouterr().err
    assert manage.owner_reset("lisa") == 0
    assert "/invite#" in capsys.readouterr().out
    assert db.val("SELECT role FROM users WHERE username = 'lisa'") == "owner"
    db.run("DELETE FROM users")
    assert manage.owner_reset(None) == 0
    assert state.setup_needed() and state.setup_code() in capsys.readouterr().out  # a new code


# ------------------------------------------------------------------ receipts (audit: no limits, no failed-token counting)
def test_guessing_manage_tokens_in_a_lookup_counts_toward_the_block(server):
    c = server(RATE_FAILED_TOKENS="3/h")
    s = send(c)
    bob = anon(c)
    unknown = [{"id": "ZZZZZZZZZZ", "manage_token": "A" * 43}] * 10
    assert bob.post("/api/v1/receipts/lookup", json={"items": unknown}).status_code == 200  # purged items don't count
    guesses = [{"id": s.id, "manage_token": "B" * 43}] * 3
    assert bob.post("/api/v1/receipts/lookup", json={"items": guesses}).json()["items"] == []
    assert bob.post("/api/v1/receipts/lookup", json={"items": []}).status_code == 429


def test_receipt_lookups_are_rate_limited(server):
    c = server(RATE_STATUS="2/h")
    bob = anon(c)
    for _ in range(2):
        assert bob.post("/api/v1/receipts/lookup", json={"items": []}).status_code == 200
    assert bob.post("/api/v1/receipts/lookup", json={"items": []}).status_code == 429
    assert c.get("/api/v1/me/receipts").status_code == 429  # Your links counts too (same address)


# ------------------------------------------------------------------ phishing with a sender name (audit: the page showed what the sender's browser claimed)
def test_recipient_sees_the_sender_this_server_knows(client):
    """Only someone signed in here is told who sent it, and then as this server knows them, never what the sender's
    browser wrote. Anyone else sees no username: a username is half of a sign-in, and a link can travel."""
    s = send(client, sender="ceo@acme")
    m = open_meta(client, s)
    assert m["sender"] == OWNER["username"] and m["plain"]["from"] == "ceo@acme"
    assert open_meta(anon(client), s)["sender"] is None
    assert open_meta(client, send(anon(client), sender=OWNER["username"]))["sender"] is None  # anonymous: unverified


# ------------------------------------------------------------------ gone pages (audit: "never opened" about a link opened many times)
def test_gone_says_why_and_whether_it_was_opened(client):
    bob = anon(client)
    opened = send(client, views=None)
    reveal(bob, opened)
    unopened = send(client, views=None)
    db.run("UPDATE secrets SET expires_at = ?", now() - 1)
    jobs.cleanup()
    for s, was in ((opened, True), (unopened, False)):
        r = bob.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers()).json()["error"]
        assert (r["reason"], r["opened"]) == ("expired", was)
    s = send(client, views=None)
    reveal(bob, s)
    assert client.delete(f"/api/v1/secrets/{s.id}", headers=s.manage_headers()).status_code == 204
    r = bob.post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers()).json()["error"]
    assert (r["reason"], r["opened"]) == ("destroyed", True)
    once = send(client)
    reveal(bob, once)
    r = bob.get(f"/api/v1/secrets/{once.id}/meta", headers=once.reveal_headers()).json()["error"]
    assert (r["reason"], r["opened"]) == ("opened", True)
    rec = client.get(f"/api/v1/receipts/{opened.id}", headers=opened.manage_headers()).json()
    assert rec["status"] == "expired" and rec["opened"] is True


# ------------------------------------------------------------------ 500s that were really bad requests
def test_non_ascii_secrets_in_headers_and_bodies_are_rejected_not_crashed(server):
    c = server(METRICS_TOKEN="m-token")
    r = c.delete("/api/v1/me/receipts/k7Qp2vR9mL", headers={"X-CSRF": "é".encode()})
    assert r.status_code == 403 and r.json()["error"]["reason"] == "csrf"
    assert c.get("/api/v1/metrics", headers={"Authorization": "Bearer ñ".encode()}).status_code == 404
    fresh = server(setup=False)
    r = fresh.post("/api/v1/setup", json={**SETUP, "setup_code": "CÓDIGO"})
    assert r.status_code == 400 and r.json()["error"]["field"] == "setup_code"


def test_bad_audit_dates_are_a_400(client):
    for url, field in (("/api/v1/server/audit.csv?from=bad", "from"), ("/api/v1/server/audit?to=2026-13-45", "to"),
                       ("/api/v1/server/audit?from=2026-10-01", None), ("/api/v1/server/audit?cursor=" + "9" * 40, None)):
        r = client.get(url)
        if field:
            assert r.status_code == 400 and r.json()["error"]["field"] == field, url
        else:
            assert r.status_code == 200, url


def test_wrong_passphrase_after_a_parallel_purge_is_a_410(client, monkeypatch):
    from cryptex.routes import secrets as secrets_routes
    s = send(client, passphrase="copper-lantern-river-42")
    stored = db.val("SELECT passcheck_hash FROM secrets")
    real = secrets_routes.matches

    def purged_meanwhile(a, b):
        if a == stored:
            items.purge_secret(s.id, "destroyed")
            return False
        return real(a, b)
    monkeypatch.setattr(secrets_routes, "matches", purged_meanwhile)
    r = anon(client).post(f"/api/v1/secrets/{s.id}/reveal", headers={**s.reveal_headers(), "X-Passcheck": passcheck(s, "nope")})
    assert r.status_code == 410 and r.json()["error"]["reason"] == "destroyed"


def test_2fa_code_after_2fa_was_turned_off_is_a_401(client):
    b = anon(client)
    t = b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).json()["mfa_ticket"]
    db.run("UPDATE users SET totp_ct = NULL")
    r = b.post("/api/v1/auth/login/totp", json={"mfa_ticket": t, "code": totp_code()})
    assert r.status_code == 401 and r.json()["error"] == {**r.json()["error"], "code": "sign_in_required", "reason": "expired"}


# ------------------------------------------------------------------ the logo (audit: the DOCTYPE filter missed UTF-16)
def test_svg_logo_must_be_utf8_without_a_dtd(client):
    def put(data):
        return client.put("/api/v1/server/branding/logo", content=data, headers={"Content-Type": "image/svg+xml"})
    laughs = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"><title>&a;</title></svg>'
    assert put(laughs.encode("utf-16")).status_code == 400
    assert put(laughs.encode()).status_code == 400
    assert put(b'<?xml version="1.0"?>\n<!doctype svg><svg/>').status_code == 400
    sneaky = '<?xml version="1.0" encoding="UTF-16"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/></svg>'
    assert put(sneaky.encode()).status_code in (204, 400)  # read as UTF-8 whatever it claims; never a 500
    assert put(b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/></svg>').status_code == 204


def test_a_shared_computer_session_gets_no_device_key(client):
    b = anon(client)
    r = b.post("/api/v1/auth/login", json={**login_body(b, OWNER["username"], OWNER["password"]), "shared": True})
    r = b.post("/api/v1/auth/login/totp", json={"mfa_ticket": r.json()["mfa_ticket"], "code": totp_code()})
    b.headers["X-CSRF"] = r.json()["csrf"]
    r = b.post("/api/v1/me/device-key", json={"device_id": DEVICE})
    assert r.status_code == 403 and r.json()["error"]["reason"] == "shared"


# ------------------------------------------------------------------ the password verifier needs ENC_KEY too (R5)
def test_a_database_copy_alone_cannot_test_password_guesses(client):
    """Audit: password_hash was argon2id(auth key): with the database alone, a guess could be checked offline."""
    from argon2 import PasswordHasher
    from argon2.exceptions import VerifyMismatchError

    from cryptex import security
    row = db.one("SELECT password_hash FROM users WHERE username = ?", OWNER["username"])
    right = auth_key(OWNER["password"], OWNER_SALT)  # what a thief would derive from a correct guess
    with pytest.raises(VerifyMismatchError):
        PasswordHasher().verify(row["password_hash"], right)
    assert PasswordHasher().verify(row["password_hash"], security.keyed("password", right))  # with ENC_KEY, it would
    assert "$argon2id$v=19$m=19456,t=2,p=1$" in row["password_hash"]  # input is already a 256-bit Argon2id output


def test_the_temporary_password_hash_needs_enc_key_too(client, monkeypatch, capsys):
    import hashlib
    stand_in_kdf(monkeypatch)
    temp = forgot_and_read(client, monkeypatch, capsys)
    stored = db.val("SELECT temp_key_hash FROM users WHERE username = ?", OWNER["username"])
    key = auth_key(temp, OWNER_SALT)
    assert stored and stored != hashlib.sha256(key.encode()).hexdigest()
    assert set(temp_login(client, temp).json()) == {"reset_ticket"}


def test_the_server_never_hands_out_kdf_settings_weaker_than_the_floor(client):
    """The browser refuses account KDF settings below m=65536, t=3, p=1; the API never sends any."""
    floor = {"m": 65536, "t": 3, "p": 1}
    b = anon(client)
    for kdf in (b.post("/api/v1/auth/prelogin", json={"username": OWNER["username"]}).json()["kdf"],
                b.post("/api/v1/auth/prelogin", json={"username": "nobody"}).json()["kdf"],
                client.get("/api/v1/me/vault/keys").json()["kdf"]):
        assert all(kdf[k] >= v for k, v in floor.items()), kdf


# ------------------------------------------------------------------ settings changed by another process (R14)
def test_cli_writes_reach_a_running_server_without_a_restart(server):
    """Audit: `cryptex owner reset` on a server with no accounts reopened setup in the database, but the running
    server's settings cache kept saying setup was done."""
    import subprocess
    import sys
    c = server()
    assert c.get("/api/v1/setup").json()["needed"] is False
    db.run("DELETE FROM users")
    d = state.env().data_dir
    out = subprocess.run([sys.executable, "-m", "cryptex.manage", "owner", "reset"], capture_output=True, text=True, timeout=60,
                         env={**os.environ, "DATA_DIR": str(d)})
    assert out.returncode == 0, out.stderr
    assert c.get("/api/v1/setup").json()["needed"] is True and c.get("/api/v1/config").json()["setup_needed"] is True
    import sqlite3
    other = sqlite3.connect(d / "cryptex.db")  # any writer: a hand edit too
    other.execute("""UPDATE settings SET value = '"Globex"' WHERE key = 'brand_name'""")
    other.commit()
    other.close()
    assert c.get("/api/v1/config").json()["brand"]["name"] == "Globex"


# ------------------------------------------------------------------ what the CLI writes is private (A9)
def test_backups_are_readable_only_by_whoever_runs_the_server(client, tmp_path, monkeypatch, capsys):
    send(client, files=[("a.txt", b"abc")])
    old = os.umask(0o022)
    try:
        monkeypatch.setenv("DATA_DIR", str(state.env().data_dir))
        e = state.env()
        try:
            assert manage.main(["backup", str(tmp_path / "b" / "today")]) == 0
        finally:
            state.init(e)
        assert os.umask(0o022) == 0o022  # the command put the caller's umask back
    finally:
        os.umask(old)
    for p in (tmp_path / "b").rglob("*"):
        assert p.stat().st_mode & 0o077 == 0, (p, oct(p.stat().st_mode))


# ------------------------------------------------------------------ a stopped server leaves one database file (D-M3)
def test_shutdown_checkpoints_the_wal_and_closes(tmp_path):
    from conftest import make_client
    c = make_client(tmp_path)
    with c:
        c.headers.update(__import__("conftest").complete_setup(c))
        send(c)
        assert (tmp_path / "cryptex.db-wal").exists()
    assert not (tmp_path / "cryptex.db-wal").exists() and not (tmp_path / "cryptex.db-shm").exists()
    import sqlite3
    copy = sqlite3.connect(tmp_path / "cryptex.db")  # everything is in the main file
    assert copy.execute("SELECT count(*) FROM secrets").fetchone()[0] == 1


# ------------------------------------------------------------------ round 3: numbers, authenticator secrets, proxies, shutdown
def test_huge_numbers_in_stream_descriptors_are_a_400_not_a_500(client):
    """Audit P-P5: a size of 1e400 or a 400-digit number raised OverflowError (500)."""
    stream = '{"stream":0,"prefix":"AAAAAAAAAA","chunks":%s,"size":%s}'
    for chunks, size in (("1", "1" + "0" * 400), ("1", "1e400"), ("1", "-1e400"), ("1e400", "40"), ("1" + "0" * 400, "40"),
                         ("1", "40.5"), ("1.0", "40"), ('"1"', "40"), ("true", "40"), ("1", str(2**53 + 40))):
        body = '{"policy":{"views":1,"expires_in":3600},"streams":[%s]}' % (stream % (chunks, size))
        r = client.post("/api/v1/secrets", content=body, headers={"Content-Type": "application/json"})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", (chunks, size, r.text)
    body = '{"policy":{"views":1,"expires_in":3600},"streams":[%s]}' % (stream % ("1", "40"))
    assert client.post("/api/v1/secrets", content=body, headers={"Content-Type": "application/json"}).status_code == 201


@pytest.mark.parametrize("bad", ["AAAAAAAA", "jbswy3dpehpk3pxp", "A" * 17, "JBSWY3DP-HPK3PXP", "A" * 72])
def test_authenticator_secrets_are_16_to_64_base32_characters_everywhere(server, bad):
    """Audit P-P6: invites and reset links took any secret (a 40-bit AAAAAAAA), unlike PUT /me/totp."""
    from conftest import reauth
    from test_integrations import lisa_joined, reset_accept

    def code():
        try:
            return pyotp.TOTP(bad).now()
        except Exception:
            return "123456"
    c = server()
    url = c.post("/api/v1/server/users", json={"username": "mia"}).json()["invite_url"]
    r = anon(c).post("/api/v1/auth/invite/accept", json={"token": url.split("#", 1)[1], **creds("lisa's long passphrase"),
                                                          "totp_secret": bad, "totp_code": code()})
    assert r.status_code == 400 and r.json()["error"]["field"] == "totp_secret", r.text
    _, uid, _ = lisa_joined(c, totp=False)
    link = c.post(f"/api/v1/server/users/{uid}/reset", json={}).json()
    r = reset_accept(anon(c), link, totp_secret=bad, totp_code=code())
    assert r.status_code == 400 and r.json()["error"]["field"] == "totp_secret", r.text
    reauth(c)
    r = c.put("/api/v1/me/totp", json={"secret": bad, "code": code()})
    assert r.status_code == 400 and r.json()["error"]["field"] == "secret", r.text


def test_shutdown_never_waits_long_for_a_busy_database(tmp_path):
    """Infra: `docker stop` waits 10 s, and uvicorn may use 5 of them; the checkpoint at shutdown waits briefly."""
    import sqlite3
    import time

    from conftest import make_client
    c = make_client(tmp_path)
    with c:
        c.headers.update(__import__("conftest").complete_setup(c))
        send(c)
        reader = sqlite3.connect(tmp_path / "cryptex.db", isolation_level=None)
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM secrets").fetchone()  # a `cryptex backup` reading meanwhile
        t0 = time.monotonic()
    try:
        assert time.monotonic() - t0 < db.CHECKPOINT_WAIT + 1
    finally:
        reader.close()


# ------------------------------------------------------------------ one process: what nginx used to do (headers, bodies, files)
def test_every_response_carries_the_security_headers(server, tmp_path):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / ".vite").mkdir()
    (web / "index.html").write_text("<!doctype html>")
    (web / "assets" / "app-1234.js").write_text("")
    (web / "favicon.svg").write_text("<svg/>")
    (web / ".vite" / "manifest.json").write_text("{}")
    c = server(setup=False, STATIC_DIR=str(web))
    c.base_url = "https://vault.acme.com"  # as uvicorn sees a request the proxy says came over HTTPS
    cache = {"/": "no-cache", "/s/abc": "no-cache", "/assets/app-1234.js": "public, max-age=31536000, immutable",
             "/favicon.svg": "public, max-age=86400", "/api/v1/healthz": "no-store", "/api/v1/nope": "no-store",
             "/assets/gone.js": "no-store", "/.vite/manifest.json": "no-store"}
    for path, want in cache.items():
        r = c.get(path)
        assert r.status_code == (404 if path in ("/api/v1/nope", "/assets/gone.js", "/.vite/manifest.json") else 200), path
        assert r.headers["cache-control"] == want, path
        assert "worker-src 'self'" in r.headers["content-security-policy"] and "blob:" not in r.headers["content-security-policy"].split("worker-src")[1].split(";")[0]
        assert r.headers["x-frame-options"] == "DENY" and r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "no-referrer" and r.headers["cross-origin-opener-policy"] == "same-origin"
        assert r.headers["strict-transport-security"] == "max-age=31536000" and "permissions-policy" in r.headers
    assert "strict-transport-security" not in server().get("/api/v1/healthz").headers  # plain http
    # Encoded dot segments get the app (its own not-found page), never a file outside the folder or a dotfile.
    (tmp_path / "secret.txt").write_text("outside")
    for path in ("/s/..%2Fconfig", "/s/..%2F..%2Fsecret.txt", "/..%2F..%2F..%2Fetc%2Fpasswd"):
        r = c.get(path)
        assert r.status_code == 200 and r.text == "<!doctype html>", path
    assert c.get("/s/..%2F.vite%2Fmanifest.json").status_code == 404


def test_request_bodies_over_1_mib_are_refused_with_or_without_a_length(client):
    big = b'{"username": "' + b"a" * (1024 * 1024) + b'"}'
    r = client.post("/api/v1/auth/prelogin", content=big, headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large", r.text
    r = client.post("/api/v1/auth/prelogin", content=iter([big[:600_000], big[600_000:]]), headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large", r.text
