"""Reveals that take a while, uploads that take a while, and Your links with many items."""
import os

import reference as ref
from conftest import anon, chunk_files, sign_in
from helpers import reveal, send

from cryptex import db, items, jobs
from cryptex.routes import receipts as receipts_routes
from cryptex.util import now


def started(c, s):
    r = c.post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers())
    assert r.status_code == 200, r.text
    return {"Authorization": f"Read {r.json()['read_session']}"}


def seal_body(s):
    return {"meta_ct": "AAAA", "reveal_hash": ref.derive_link(s.id, s.K)["reveal_hash"]}


def session_end() -> int:
    return db.val("SELECT expires_at FROM read_sessions")


# ------------------------------------------------------------------ the read session slides (R1)
def test_a_slow_one_time_download_keeps_its_read_session_open(client):
    """Audit: the read session ended 10 minutes after the reveal, however busy the download, and cleanup then purged
    the one-time secret as opened: a large file on a slow line was lost halfway."""
    s = send(client, files=[("big.bin", os.urandom(6 * 1024 * 1024))])  # stream 1 has 2 chunks
    b = anon(client)
    rh = started(b, s)
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/0/0", headers=rh).status_code == 200
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/0", headers=rh).status_code == 200
    # 11 minutes later, still on chunk 1/0's heels: the session would have ended at 10
    db.run("UPDATE read_sessions SET revealed_at = revealed_at - 660, expires_at = ?", now() + 5)
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/0", headers=rh).status_code == 200  # a resumed chunk
    assert session_end() >= now() + items.READ_SLIDE - 1
    jobs.cleanup()
    assert db.val("SELECT count(*) FROM secrets WHERE id = ?", s.id) == 1  # still downloading: not purged
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/1", headers=rh).status_code == 200
    assert session_end() <= now() + items.READ_GRACE  # every chunk went out: the grace, no more sliding
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/1", headers=rh).status_code == 200  # a retry within it
    assert session_end() <= now() + items.READ_GRACE
    assert b.delete(f"/api/v1/secrets/{s.id}/read", headers=rh).status_code == 204
    assert chunk_files() == []


def test_a_read_session_never_outlives_six_hours_from_the_reveal(client):
    s = send(client, files=[("big.bin", os.urandom(6 * 1024 * 1024))])
    b = anon(client)
    rh = started(b, s)
    db.run("UPDATE read_sessions SET revealed_at = ?, expires_at = ?", now() - items.READ_MAX + 30, now() + 10)
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/0/0", headers=rh).status_code == 200
    assert session_end() == db.val("SELECT revealed_at FROM read_sessions") + items.READ_MAX  # capped, not now + 3 min
    db.run("UPDATE read_sessions SET expires_at = ?", now() - 1)
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/0", headers=rh).status_code == 404
    jobs.cleanup()
    r = b.post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "opened"


def test_a_download_started_before_expiry_finishes(client):
    s = send(client, views=None, files=[("big.bin", os.urandom(6 * 1024 * 1024))])
    b = anon(client)
    rh = started(b, s)
    db.run("UPDATE secrets SET expires_at = ?", now() - 1)
    jobs.cleanup()
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/0", headers=rh).status_code == 200
    r = anon(client).get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "expired"  # no new reveals
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/1", headers=rh).status_code == 200
    db.run("UPDATE read_sessions SET expires_at = ?", now() - 1)
    jobs.cleanup()
    assert chunk_files() == [] and db.val("SELECT reason FROM tombstones WHERE id = ?", s.id) == "expired"


# ------------------------------------------------------------------ a secret's lifetime starts at seal (R16)
def test_the_lifetime_counts_from_seal_and_a_slow_upload_is_never_cleaned_up_as_expired(client):
    """Audit: an upload still in progress was purged once its lifetime (counted from create) passed, leaving its
    secret.created event and the account's receipt behind."""
    s = send(client, files=[("a", b"abc")], expires_in=300, seal=False)
    db.run("UPDATE secrets SET created_at = created_at - 600, expires_at = expires_at - 600")  # 10 minutes of uploading
    jobs.cleanup()
    assert db.val("SELECT count(*) FROM secrets WHERE id = ?", s.id) == 1  # still active: the idle rule decides
    up = {"Authorization": f"Upload {s.upload_token}"}
    r = client.post(f"/api/v1/secrets/{s.id}/seal", json=seal_body(s), headers=up)
    assert r.status_code == 200
    expires = db.val("SELECT expires_at FROM secrets WHERE id = ?", s.id)
    assert now() + 300 - 2 <= expires <= now() + 300
    from cryptex.util import iso
    assert r.json() == {"expires_at": iso(expires)}
    assert client.post(f"/api/v1/secrets/{s.id}/seal", json=seal_body(s), headers=up).status_code == 409  # a retry: already sealed


def test_an_idle_upload_leaves_nothing_behind(client):
    s = send(client, files=[("a", b"abc")], seal=False)
    assert db.val("SELECT count(*) FROM user_receipts WHERE secret_id = ?", s.id) == 1
    db.run("UPDATE secrets SET upload_active_at = ?", now() - items.UPLOAD_IDLE - 1)
    jobs.cleanup()
    for table in ("secrets", "user_receipts", "events", "chunks", "streams"):
        assert db.val(f"SELECT count(*) FROM {table} WHERE {'id' if table == 'secrets' else 'secret_id'} = ?", s.id) == 0, table
    assert chunk_files() == []


# ------------------------------------------------------------------ wrong manage tokens count only for items that exist (R11)
def test_asking_about_a_long_gone_item_never_blocks_the_address(server):
    """Audit: Your links keeps ended items for 30 days, tombstones lasted 7: every status check of an old item counted
    as a guessed token, and 30 of them blocked reveals from that address for an hour."""
    c = server(RATE_FAILED_TOKENS="3/h")
    s = send(c)
    assert c.delete(f"/api/v1/secrets/{s.id}", headers=s.manage_headers()).status_code == 204
    db.run("UPDATE tombstones SET purge_after = ?", now() - 1)
    jobs.tombstones()
    b = anon(c)
    for _ in range(10):
        assert b.get(f"/api/v1/receipts/{s.id}", headers=s.manage_headers()).status_code == 404
        assert b.delete(f"/api/v1/secrets/{s.id}", headers=s.manage_headers()).status_code == 404
    live = send(c)
    assert b.get(f"/api/v1/receipts/{live.id}", headers=live.manage_headers()).status_code == 200  # not blocked
    for _ in range(3):  # a wrong token for an item that exists still counts
        assert b.get(f"/api/v1/receipts/{live.id}", headers={"Authorization": "Manage " + "A" * 43}).status_code == 404
    assert b.get(f"/api/v1/receipts/{live.id}", headers=live.manage_headers()).status_code == 429


def test_tombstones_last_as_long_as_your_links_keeps_ended_items():
    assert items.TOMBSTONE_DAYS == 30


# ------------------------------------------------------------------ many links (R12)
def pair(i):
    return {"id": f"{i:010d}"[-10:].replace("0", "Z"), "manage_token": "A" * 43}


def test_lookup_takes_up_to_2000_items(client):
    s = send(client)
    items_ = [pair(i) for i in range(1999)] + [{"id": s.id, "manage_token": s.manage_token}]
    b = anon(client)
    r = b.post("/api/v1/receipts/lookup", json={"items": items_})
    assert r.status_code == 200 and [i["id"] for i in r.json()["items"]] == [s.id]
    assert [e["type"] for e in r.json()["items"][0]["events"]] == ["secret.created", "secret.sealed"]
    r = b.post("/api/v1/receipts/lookup", json={"items": items_ + [pair(5000)]})
    assert r.status_code == 400 and r.json()["error"]["field"] == "items"


def test_your_links_pages_through_every_receipt(client, monkeypatch):
    monkeypatch.setattr(receipts_routes, "PAGE", 3)
    sent = [send(client) for _ in range(7)]
    db.run("UPDATE user_receipts SET added_at = 1000")  # one second for all: the cursor still orders them
    seen, cursor, pages = [], None, 0
    while True:
        r = client.get("/api/v1/me/receipts", params={"cursor": cursor} if cursor else None).json()
        seen += [i["id"] for i in r["items"]]
        pages += 1
        cursor = r["next"]
        if not cursor:
            break
    assert sorted(seen) == sorted(s.id for s in sent) and len(seen) == 7 and pages == 3
    r = client.get("/api/v1/me/receipts", params={"cursor": "nonsense"})
    assert r.status_code == 400 and r.json()["error"]["field"] == "cursor"


def test_account_receipts_go_with_the_tombstone(client):
    s = send(client)
    reveal(anon(client), s)
    jobs.tombstones()
    assert db.val("SELECT count(*) FROM user_receipts WHERE secret_id = ?", s.id) == 1  # still within 30 days
    db.run("UPDATE tombstones SET purge_after = ?", now() - 1)
    jobs.tombstones()
    assert db.val("SELECT count(*) FROM user_receipts WHERE secret_id = ?", s.id) == 0


def test_a_chunk_that_takes_longer_than_the_slide_to_arrive_still_lets_the_next_one_come(client, monkeypatch):
    """Audit C6: the session's end moved only when a chunk request STARTED, and the client asks for the next one after
    the previous one arrived: below about 29 KB/s (5 MiB in 3 minutes) every later chunk was a 404. Now the end of
    each response moves it too, and the slide is 15 minutes."""
    from cryptex.routes import secrets as secrets_routes
    s = send(client, files=[("big.bin", os.urandom(6 * 1024 * 1024))])  # stream 1 has 2 chunks
    b = anon(client)
    rh = started(b, s)
    real = secrets_routes._get_chunk

    def slow(*a, **kw):  # the response then takes longer than any slide to reach a slow phone
        out = real(*a, **kw)
        db.run("UPDATE read_sessions SET expires_at = ?", now() + 1)
        return out
    monkeypatch.setattr(secrets_routes, "_get_chunk", slow)
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/0/0", headers=rh).status_code == 200
    assert session_end() >= now() + items.READ_SLIDE - 1  # restarted when the response was done
    assert items.READ_SLIDE >= 15 * 60
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/0", headers=rh).status_code == 200
    assert b.get(f"/api/v1/secrets/{s.id}/chunks/1/1", headers=rh).status_code == 200
    # Every chunk went out on the last view: time left to start a retry, but no more than that.
    assert now() + items.READ_GRACE - 2 <= session_end() <= now() + items.READ_GRACE
    assert items.READ_GRACE >= 5 * 60


def test_signing_in_again_ends_the_session_this_browser_had(client):
    """Audit F1: signing in as B in a browser where A was signed in left A's session running behind B's. Now a new
    session ends the one the browser presented; A's sessions elsewhere stay."""
    from conftest import login_body
    from test_integrations import lisa_joined
    lisa, _, _ = lisa_joined(client, totp=False)
    elsewhere = sign_in(anon(client))  # A on another device
    from cryptex.util import token_hash
    a_hash = token_hash(client.cookies["cx_session"])
    assert db.val("SELECT count(*) FROM sessions WHERE id_hash = ?", a_hash) == 1
    r = client.post("/api/v1/auth/login", json=login_body(client, "lisa", "lisa's long passphrase"))  # A's cookie
    assert r.status_code == 200 and r.json()["user"]["username"] == "lisa"
    assert db.val("SELECT count(*) FROM sessions WHERE id_hash = ?", a_hash) == 0
    assert elsewhere.get("/api/v1/auth/session").json()["user"]["username"] == "sam"  # A elsewhere: still signed in
    assert client.get("/api/v1/auth/session").json()["user"]["username"] == "lisa"
