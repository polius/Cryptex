"""Threat model rows (design/v3/spec/threat-model.md) and audit regressions, as named tests."""
import json
import os

from conftest import OWNER, anon, chunk_files
from helpers import CHUNK, ask, open_meta, passcheck, reveal, send

from cryptex import db, items, jobs, state
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
    """Audit finding: 2.4 accepted file uploads with the ID only, even on password-protected secrets."""
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


def test_forwarded_for_is_trusted_only_from_trusted_proxies(server):
    c = server(TRUSTED_PROXIES="10.0.0.0/8", RATE_CREATE="2/h")
    bob = anon(c)
    # testclient's peer is "testclient", not a trusted proxy: X-Forwarded-For is ignored, so rotating it doesn't help
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
    c = server(SMTP_URL="smtp://127.0.0.1:2", SMTP_FROM="x@acme.example")
    secret_value, title, filename, email = "hunter2-PLAINTEXT-canary", "Canary title", "canary-file.txt", "lisa@globex.example"
    send(c, items=[{"t": "note", "v": secret_value}], files=[(filename, b"file canary contents")], title=title,
         access="email", email=email)
    ask(c, title="Canary request")
    data = (state.env().data_dir / "cryptex.db").read_bytes()
    wal = state.env().data_dir / "cryptex.db-wal"
    if wal.exists():
        data += wal.read_bytes()
    for p in chunk_files():
        data += p.read_bytes()
    for canary in (secret_value, title, filename, email, "file canary contents", "Canary request"):
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
    r = c.post("/api/v1/secrets", json={"policy": {"views": 50, "expires_in": 3600}, "streams": [m]})
    assert r.status_code == 400 and r.json()["error"]["limit"] == 10
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
    c = server(RATE_AUTH="4/15m")  # setup used one
    bob = anon(c)
    for _ in range(3):
        assert bob.post("/api/v1/auth/login", json={"email": OWNER["email"], "password": "x"}).status_code == 401
    assert bob.post("/api/v1/auth/login", json={"email": OWNER["email"], "password": OWNER["password"]}).status_code == 429


def test_login_message_is_the_same_for_unknown_email(client):
    bob = anon(client)
    a = bob.post("/api/v1/auth/login", json={"email": OWNER["email"], "password": "wrong"})
    b = bob.post("/api/v1/auth/login", json={"email": "nobody@acme.example", "password": "wrong"})
    assert a.status_code == b.status_code == 401 and a.json() == b.json()


# ------------------------------------------------------------------ open redirect (audit: /\ in login return path)
def test_return_to_is_same_origin_only():
    for bad in ("//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "", "/\x00x"):
        assert safe_return_to(bad) == "/"
    assert safe_return_to("/links?x=1") == "/links?x=1"


# ------------------------------------------------------------------ settings can't brick the server (audit: bad setting → 500)
def test_invalid_limits_are_rejected_with_a_message(client):
    for body in ({"max_views": 0}, {"max_file_size": "lots"}, {"max_expiration": "99y"}, {"max_files": 999}, {"nope": 1}):
        r = client.put("/api/v1/server/limits", json=body)
        assert r.status_code == 400 and r.json()["error"]["field"], body
    assert client.get("/api/v1/config").status_code == 200


def test_env_locked_limits_are_read_only(server):
    c = server(MAX_MESSAGE_LENGTH="5000")
    item = c.get("/api/v1/server/limits").json()["items"]["max_message_length"]
    assert item == {**item, "value": 5000, "locked_by": "MAX_MESSAGE_LENGTH"}
    r = c.put("/api/v1/server/limits", json={"max_message_length": 100})
    assert r.status_code == 400 and "MAX_MESSAGE_LENGTH" in r.json()["error"]["message"]


def test_invalid_env_fails_fast_with_the_variable_name(tmp_path):
    import pytest

    from cryptex.config import load_env
    with pytest.raises(ValueError, match="MAX_FILE_SIZE"):
        load_env({"DATA_DIR": str(tmp_path), "MAX_FILE_SIZE": "huge"})
    with pytest.raises(ValueError, match="PUBLIC_URL"):
        load_env({"DATA_DIR": str(tmp_path), "PUBLIC_URL": "http://vault.acme.com"})


# ------------------------------------------------------------------ setup
def test_nothing_can_be_created_until_an_owner_exists(server):
    c = server(setup=False)
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600}, "streams": []})
    assert r.status_code == 403
    assert c.get("/api/v1/config").json()["setup_needed"] is True
    assert c.post("/api/v1/setup/owner", json={"setup_code": "WRONG", **OWNER}).status_code == 400
    r = c.post("/api/v1/setup/owner", json={"setup_code": "TEST-CODE-0001", **OWNER, "password": "short"})
    assert r.status_code == 400 and r.json()["error"]["field"] == "password"


def test_setup_can_only_run_once(client):
    r = anon(client).post("/api/v1/setup/owner", json={"setup_code": "TEST-CODE-0001", **OWNER, "email": "eve@evil.example"})
    assert r.status_code == 409


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


def test_expired_request_and_kept_answer(client):
    a = ask(client)
    db.run("UPDATE requests SET expires_at = ?", now() - 1)
    jobs.cleanup()
    r = anon(client).get(f"/api/v1/requests/{a.id}/prompt", headers=a.answer_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "expired"


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


def test_logs_hold_no_tokens(client, capsys):
    s = send(client)
    open_meta(anon(client), s)
    out = capsys.readouterr().out
    for tok in (s.manage_token, s.upload_token, s.reveal_token):
        assert tok not in out


def test_enc_key_is_generated_once_with_0600(server):
    server()
    p = state.env().data_dir / "enc.key"
    assert p.exists() and oct(os.stat(p).st_mode & 0o777) == "0o600"


def test_last_view_survives_a_dropped_last_chunk_for_a_minute(client):
    """A retry after a lost response still works; then the grace ends and cleanup deletes it."""
    s = send(client, files=[("a", b"abc")])
    bob = anon(client)
    manifest, _ = reveal(bob, s, done=False)
    r = bob.post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers())
    assert r.status_code == 410  # no second view
    assert chunk_files()  # still there for the retry
    exp = db.val("SELECT expires_at FROM read_sessions")
    assert exp <= now() + 60
    db.run("UPDATE read_sessions SET expires_at = ?", now() - 1)
    jobs.cleanup()
    assert chunk_files() == []


def test_read_done_needs_the_read_session(client):
    s = send(client)
    assert anon(client).delete(f"/api/v1/secrets/{s.id}/read", headers=s.reveal_headers()).status_code == 404


def test_cancelling_an_unread_answer_is_not_reported_as_read(client):
    from helpers import answer
    a = ask(client)
    answer(anon(client), a, {"Access key ID": "x", "Secret access key": "y"})
    assert client.delete(f"/api/v1/requests/{a.id}", headers=a.manage_headers()).status_code == 204
    rec = client.get(f"/api/v1/receipts/{a.id}", headers=a.manage_headers()).json()
    assert rec["status"] == "destroyed" and rec["events"][-1]["type"] == "request.cancelled"
