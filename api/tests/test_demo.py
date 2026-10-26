"""DEMO=true: forced limits, proof of work, quotas, breakers, reports and the nightly wipe."""
import calendar
import time

import pytest
from conftest import anon, chunk_files
from helpers import ask, open_meta, pow_header, reveal, send

from cryptex import db, demo, jobs


def demo_send(c, **kw):
    return send(c, headers=pow_header(c), **kw)


def test_config_shows_forced_policy_and_quota(server):
    c = server(DEMO="true", MAX_VIEWS="50", MAX_EXPIRATION="30d")
    cfg = c.get("/api/v1/config").json()
    assert cfg["demo"] is True and cfg["setup_needed"] is False and cfg["mode"] == "anyone"
    assert cfg["limits"] == {**cfg["limits"], "max_views": 1, "max_expires_in": 3600, "max_message_chars": 500,
                             "max_files": 1, "max_file_bytes": 1024 * 1024, "request_max_expires_in": 3600}
    assert cfg["features"]["email_access"] is False and cfg["features"]["sso"] is False
    assert cfg["quota"]["limit"] == 30 and cfg["quota"]["used"] == 0
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
    assert r.status_code == 429
    reset = r.json()["error"]["reset_at"]
    assert reset.endswith("T00:00:00Z")  # resets at midnight UTC


def test_demo_tuning_can_only_be_stricter(server):
    c = server(DEMO="true", DEMO_SEALS_PER_DAY="1000")
    assert c.get("/api/v1/config").json()["quota"]["limit"] == 30


def test_demo_forces_one_view_and_one_hour(server):
    c = server(DEMO="true")
    body = {"policy": {"views": 2, "expires_in": 3600}, "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]}
    assert c.post("/api/v1/secrets", json=body, headers=pow_header(c)).status_code == 400
    body["policy"] = {"views": 1, "expires_in": 7200}
    assert c.post("/api/v1/secrets", json=body, headers=pow_header(c)).status_code == 400


def test_demo_has_no_tokens_and_no_owner(server):
    c = server(DEMO="true")
    assert c.get("/api/v1/setup").json()["needed"] is False
    assert c.post("/api/v1/me/tokens", json={"name": "x", "scopes": ["send"]}).status_code == 401


def test_breaker_on_live_items(server):
    c = server(DEMO="true", DEMO_MAX_LIVE_ITEMS="1")
    s = demo_send(c)
    r = c.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600},
                                        "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]}, headers=pow_header(c))
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
    ask(c, headers=pow_header(c), expires_in=3600, keep=3600)
    open_meta(c, s)
    jobs.demo_wipe()
    assert chunk_files() == [] and db.val("SELECT count(*) FROM secrets") == 0 and db.val("SELECT count(*) FROM requests") == 0
    assert c.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers()).status_code == 404


@pytest.mark.parametrize("expr,stamp,ok", [
    ("0 0 * * *", "2026-10-27 00:00", True), ("0 0 * * *", "2026-10-27 00:01", False),
    ("*/15 * * * *", "2026-10-27 10:45", True), ("30 2 * * 1-5", "2026-10-26 02:30", True),
    ("30 2 * * 1-5", "2026-10-25 02:30", False), ("0 12 1,15 * *", "2026-10-15 12:00", True),
])
def test_cron(expr, stamp, ok):
    ts = calendar.timegm(time.strptime(stamp, "%Y-%m-%d %H:%M"))
    assert demo.cron_matches(expr, ts) is ok
