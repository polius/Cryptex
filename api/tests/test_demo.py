"""DEMO=true: forced limits, proof of work, quotas, breakers, reports and the nightly wipe."""

import pytest
from conftest import anon, chunk_files
from helpers import open_meta, pow_header, reveal, send

from cryptex import db, jobs


def demo_send(c, **kw):
    return send(c, headers=pow_header(c), **kw)


def test_config_shows_forced_policy_and_quota(server):
    c = server(DEMO="true", MAX_EXPIRATION="30d")
    cfg = c.get("/api/v1/config").json()
    assert cfg["demo"] is True and cfg["setup_needed"] is False and cfg["mode"] == "anyone"
    assert cfg["limits"] == {**cfg["limits"], "max_expires_in": 3600, "max_message_chars": 500,
                             "max_files": 1, "max_file_bytes": 1024 * 1024}
    assert cfg["features"]["sign_in"] is False
    assert cfg["quota"]["limit"] == 10 and cfg["quota"]["used"] == 0
    assert c.get("/api/v1/config").headers["x-robots-tag"].startswith("noindex")


def test_create_needs_fresh_proof_of_work(server):
    c = server(DEMO="true")
    body = {"policy": {"views": 1, "expires_in": 3600}, "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]}
    r = c.post("/api/v1/secrets", json=body)
    assert r.status_code == 400 and r.json()["error"]["field"] == "X-PoW"
    h = pow_header(c)
    assert c.post("/api/v1/secrets", json=body, headers=h).status_code == 201
    assert c.post("/api/v1/secrets", json=body, headers=h).status_code == 400  # replay
    chal = c.get("/api/v1/demo/challenge").json()["challenge"]
    assert c.post("/api/v1/secrets", json=body, headers={"X-PoW": f"{chal}:0"}).status_code == 400  # not enough work


def test_demo_flow_and_quota(server):
    c = server(DEMO="true", DEMO_SEALS_PER_DAY="2")
    s = demo_send(c)
    assert c.get("/api/v1/config").json()["quota"]["used"] == 1
    reveal(anon(c), s)
    demo_send(c)
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600},
                                        "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]}, headers=pow_header(c))
    assert r.status_code == 429 and r.json()["error"]["reason"] == "demo_day"  # the "today's links are used" page
    reset = r.json()["error"]["reset_at"]
    assert reset.endswith("T00:00:00Z")  # resets at midnight UTC


def test_only_the_daily_quota_says_demo_day(server):
    """Audit: any demo 429 (per minute, bytes, breakers) was shown as "you used today's 10 links"."""
    c = server(DEMO="true")
    for _ in range(5):
        demo_send(c)
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600},
                                        "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]}, headers=pow_header(c))
    assert r.status_code == 429 and "reason" not in r.json()["error"] and int(r.headers["Retry-After"]) <= 60  # 5 a minute


def test_demo_tuning_can_only_be_stricter(server):
    c = server(DEMO="true", DEMO_SEALS_PER_DAY="1000")
    assert c.get("/api/v1/config").json()["quota"]["limit"] == 10


def test_demo_allows_reusable_links_but_only_for_an_hour(server):
    c = server(DEMO="true")
    body = {"policy": {"views": None, "expires_in": 3600}, "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]}
    assert c.post("/api/v1/secrets", json=body, headers=pow_header(c)).status_code == 201
    body["policy"] = {"views": 1, "expires_in": 7200}
    assert c.post("/api/v1/secrets", json=body, headers=pow_header(c)).status_code == 400


def test_demo_has_no_owner(server):
    c = server(DEMO="true")
    assert c.get("/api/v1/setup").json()["needed"] is False


def test_demo_has_no_accounts_whatever_the_page_sends(server):
    """The menu's sample owner and its greyed-out Sign out are only on the page: nothing here signs anyone in or out."""
    c = server(DEMO="true")
    key = "A" * 43
    for path, body in (("/auth/prelogin", {"username": "demo"}), ("/auth/login", {"username": "demo", "auth_key": key})):
        r = c.post(f"/api/v1{path}", json=body)
        assert r.status_code == 403 and r.json()["error"]["code"] == "demo_locked", path
    assert c.post("/api/v1/auth/logout").status_code == 204  # no session: nothing to end
    for path in ("/me/vault/keys", "/server/overview"):
        assert c.get(f"/api/v1{path}").status_code in (401, 404), path
    assert db.val("SELECT count(*) FROM users") == 0 and db.val("SELECT count(*) FROM sessions") == 0


def test_breaker_on_storage(server):
    c = server(DEMO="true", DEMO_STORAGE_CAP="1kb")
    s = demo_send(c)
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600},
                                        "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 2000}]}, headers=pow_header(c))
    assert r.status_code == 429 and "full" in r.json()["error"]["message"]
    assert db.val("SELECT count(*) FROM events WHERE type = 'demo.breaker_tripped'") == 1
    # reveals keep working while sealing is paused
    reveal(anon(c), s)


def test_report_removes_the_secret(server):
    c = server(DEMO="true")
    s = demo_send(c, files=[("a.txt", b"abc")])
    bob = anon(c)
    assert bob.post(f"/api/v1/secrets/{s.id}/report").status_code == 404  # needs the link
    assert bob.post(f"/api/v1/secrets/{s.id}/report", headers=s.reveal_headers()).status_code == 204
    assert chunk_files() == []
    assert bob.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers()).status_code == 410


def test_report_is_demo_only(client):
    s = send(client)
    assert client.post(f"/api/v1/secrets/{s.id}/report", headers=s.reveal_headers()).status_code == 404


def test_nightly_wipe(server):
    c = server(DEMO="true")
    s = demo_send(c, files=[("a.txt", b"abc")])
    open_meta(c, s)
    jobs.demo_wipe()
    assert chunk_files() == [] and db.val("SELECT count(*) FROM secrets") == 0
    assert c.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers()).status_code == 404


def test_the_demo_is_wiped_once_when_the_utc_day_changes(server, monkeypatch):
    import asyncio
    server(DEMO="true")
    wiped: list[int] = []
    monkeypatch.setattr(jobs, "demo_wipe", lambda: wiped.append(1) or 0)
    midnight, last = 100 * 86400, {}
    for t in (midnight - 10, midnight - 5, midnight + 5, midnight + 10):  # a restart mid-day doesn't wipe
        monkeypatch.setattr(jobs, "now", lambda t=t: t)
        asyncio.run(jobs._tick(last, []))
    assert wiped == [1]


def test_demo_tuning_is_validated(tmp_path):
    from cryptex.config import load_env
    env = {"DATA_DIR": str(tmp_path), "DEMO": "true"}
    for k, v in (("DEMO_SEALS_PER_DAY", "ten"), ("DEMO_SEALS_PER_DAY", "0"), ("DEMO_STORAGE_CAP", "big")):
        with pytest.raises(ValueError, match=k):
            load_env({**env, k: v})


def test_the_jobs_loop_survives_and_logs_any_error(server, monkeypatch, caplog):
    import asyncio
    import logging
    server(DEMO="true")
    calls = []

    async def broken(*_):
        calls.append(1)
        raise RuntimeError("boom")

    async def stop_after_two(_):
        if len(calls) >= 2:
            raise asyncio.CancelledError
    monkeypatch.setattr(jobs, "_tick", broken)
    monkeypatch.setattr(jobs.asyncio, "sleep", stop_after_two)
    caplog.set_level(logging.ERROR, logger="cryptex.jobs")
    logging.getLogger("cryptex").propagate = True
    try:
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(jobs.loop())
    finally:
        logging.getLogger("cryptex").propagate = False
    assert len(calls) == 2 and any("unexpected error" in r.getMessage() for r in caplog.records)


def test_report_tombstones_the_link_as_reported(server):
    c = server(DEMO="true")
    s = demo_send(c)
    bob = anon(c)
    reveal(bob, demo_send(c))
    assert bob.post(f"/api/v1/secrets/{s.id}/report", headers=s.reveal_headers()).status_code == 204
    r = bob.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers()).json()["error"]
    assert (r["reason"], r["opened"]) == ("reported", False)
    assert bob.post(f"/api/v1/secrets/{s.id}/report", headers=s.reveal_headers()).status_code == 410  # already down
    assert c.get(f"/api/v1/receipts/{s.id}", headers=s.manage_headers()).json()["reason"] == "reported"
