"""Ask for a secret: whoever can create links makes a request link, anyone holding it answers once, and only the
requester can read the answer (docs/crypto.md §4)."""
from __future__ import annotations

import json
import os
from typing import Any

import reference as ref
from conftest import anon, chunk_files
from cryptography.hazmat.primitives.asymmetric import ec
from helpers import CHUNK

from cryptex import db, jobs, manage
from cryptex.util import now


def ask(c, expires_in: int = 3600, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Like the browser: create, then seal the public key under the link's key."""
    r = c.post("/api/v1/requests", json={"expires_in": expires_in}, headers=headers or {})
    assert r.status_code == 201, r.text
    rid, R, d = r.json()["id"], os.urandom(16), ec.generate_private_key(ec.SECP256R1())
    m = {"Authorization": f"Manage {r.json()['manage_token']}"}
    a = ref.derive_ask(rid, R)
    ask_ct = ref.seal_blob(a["ask_key"], "ask", rid, json.dumps({"key": ref.b64u(ref.raw_public(d))}).encode(), os.urandom(12))
    assert c.post(f"/api/v1/requests/{rid}/seal", json={"ask_ct": ask_ct, "answer_hash": a["answer_hash"]}, headers=m).status_code == 204
    return {"id": rid, "R": R, "d": d, "m": m, "token": r.json()["manage_token"], "h": {"Authorization": f"Answer {ref.b64u(a['answer_token'])}"}}


def answer(b, q: dict[str, Any], text: str = "k7#Qp2-vR9mL", seal: bool = True, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Like the answer page: read the request, send a secret through it, its key encrypted to the requester."""
    r = b.get(f"/api/v1/requests/{q['id']}", headers=q["h"])
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"ask_ct", "expires_at"}  # never who asks
    asked = json.loads(ref.open_blob(ref.derive_ask(q["id"], q["R"])["ask_key"], "ask", q["id"], r.json()["ask_ct"]))
    pt = json.dumps({"v": 1, "items": [{"t": "note", "v": text}]}).encode()
    prefix = os.urandom(7)
    r = b.post(f"/api/v1/requests/{q['id']}/answer", headers={**q["h"], **(headers or {})},
               json={"streams": [{"stream": 0, "prefix": ref.b64u(prefix), "chunks": 1, "size": len(pt) + 16}]})
    assert r.status_code == 201, r.text
    sid, up = r.json()["id"], {"Authorization": f"Upload {r.json()['upload_token']}"}
    K = os.urandom(16)
    d = ref.derive_link(sid, K)
    for n, chunk in enumerate(ref.stream_encrypt(d["content_key"], sid, 0, prefix, pt, CHUNK)):
        assert b.put(f"/api/v1/secrets/{sid}/chunks/0/{n}", content=chunk, headers=up).status_code == 204
    out = {"id": sid, "K": K, "up": up, "asked": asked}
    if seal:
        body = {"meta_ct": ref.seal_blob(d["meta_key"], "meta", sid, b'{"title":null}', os.urandom(12)), "reveal_hash": d["reveal_hash"],
                "answer_ct": ref.wrap_answer(q["id"], sid, K, ref.unb64u(asked["key"]))}
        out["seal"] = b.post(f"/api/v1/secrets/{sid}/seal", json=body, headers=up)
    return out


def mine(c, *qs: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Your links' statuses: the requests these manage tokens prove."""
    r = anon(c).post("/api/v1/requests/lookup", json={"items": [{"id": q["id"], "manage_token": q["token"]} for q in qs]})
    assert r.status_code == 200, r.text
    return {x["id"]: x for x in r.json()["items"]}


def read_answer(c, q: dict[str, Any]) -> str:
    """Like Your links: the answer's key from the vault's private key, then an ordinary reveal."""
    a = mine(c, q)[q["id"]]["answer"]
    K = ref.unwrap_answer(q["id"], a["id"], q["d"], a["key"])
    d = ref.derive_link(a["id"], K)
    r = anon(c).post(f"/api/v1/secrets/{a['id']}/reveal", headers={"Authorization": f"Reveal {ref.b64u(d['reveal_token'])}"})
    assert r.status_code == 200, r.text
    st = r.json()["streams"][0]
    chunk = anon(c).get(f"/api/v1/secrets/{a['id']}/chunks/0/0", headers={"Authorization": f"Read {r.json()['read_session']}"}).content
    return json.loads(ref.stream_decrypt(d["content_key"], a["id"], 0, ref.unb64u(st["prefix"]), [chunk]))["items"][0]["v"]


def test_someone_without_an_account_answers_and_only_the_requester_reads_it(server):
    c = server(access="signed_in")  # nobody else can create links here, and anyone can still answer
    q = ask(c)
    stranger = anon(c)
    a = answer(stranger, q)
    assert a["seal"].status_code == 200, a["seal"].text
    got = mine(c, q)[q["id"]]
    assert got["status"] == "answered" and got["views"] == 0 and got["answer"]["files"] == 0
    assert read_answer(c, q) == "k7#Qp2-vR9mL"
    assert mine(c, q)[q["id"]]["views"] == 1  # it opens until it expires, like a link
    # One answer per request: the link is spent.
    r = stranger.get(f"/api/v1/requests/{q['id']}", headers=q["h"])
    assert r.status_code == 410 and r.json()["error"]["reason"] == "answered"
    # The server never had the key: what it stores for the requester is encrypted to their key alone.
    other = ec.generate_private_key(ec.SECP256R1())
    try:
        ref.unwrap_answer(q["id"], got["answer"]["id"], other, got["answer"]["key"])
        raise AssertionError("another key opened the answer")
    except Exception as e:  # noqa: BLE001
        assert type(e).__name__ == "InvalidTag"


def test_who_may_ask_is_who_may_create_links(server):
    closed = server(access="signed_in")
    r = anon(closed).post("/api/v1/requests", json={"expires_in": 3600})
    assert r.status_code == 401 and r.json()["error"]["code"] == "sign_in_required"
    q = ask(anon(server()))  # ACCESS=anyone: no account needed, and none recorded
    assert db.val("SELECT owner_id FROM requests WHERE id = ?", q["id"]) is None


def test_answering_needs_the_link_and_managing_needs_the_token(client):
    q = ask(client)
    b = anon(client)
    assert b.get(f"/api/v1/requests/{q['id']}").status_code == 404
    assert b.get(f"/api/v1/requests/{q['id']}", headers={"Authorization": "Answer " + ref.b64u(os.urandom(32))}).status_code == 404
    assert b.get(f"/api/v1/requests/{q['id']}", headers={"Authorization": "Reveal " + q["h"]["Authorization"].split()[1]}).status_code == 404
    # The answer token isn't the manage token: it can't read statuses or close the request.
    fake = {**q, "token": q["h"]["Authorization"].split()[1]}
    assert mine(client, fake) == {}
    assert b.delete(f"/api/v1/requests/{q['id']}", headers={"Authorization": "Manage " + fake["token"]}).status_code == 404
    assert b.post(f"/api/v1/requests/{q['id']}/seal", headers={"Authorization": "Manage " + fake["token"]},
                  json={"ask_ct": "AAAA", "answer_hash": "0" * 64}).status_code == 404


def test_two_answers_the_first_sealed_wins_and_the_other_is_dropped(client):
    q = ask(client)
    first = answer(anon(client), q, seal=False)
    # A second start replaces the first upload (one answer on its way at a time)...
    second = answer(anon(client), q, "second")
    assert second["seal"].status_code == 200
    assert db.val("SELECT count(*) FROM secrets WHERE id = ?", first["id"]) == 0
    # ...and nothing can be sealed into it any more.
    late = ask(client)
    one, two = answer(anon(client), late, "one", seal=False), answer(anon(client), late, "two", seal=False)
    assert db.val("SELECT count(*) FROM secrets WHERE request_id = ?", late["id"]) == 1 and one["id"] != two["id"]


def test_an_answer_sealed_after_another_is_refused_and_deleted(client):
    q = ask(client)
    a = answer(anon(client), q, seal=False)
    # Another answer completes meanwhile (as if from a parallel start that got there first).
    db.run("UPDATE requests SET answered_at = ? WHERE id = ?", now(), q["id"])
    d = ref.derive_link(a["id"], a["K"])
    r = anon(client).post(f"/api/v1/secrets/{a['id']}/seal", headers=a["up"], json={
        "meta_ct": ref.seal_blob(d["meta_key"], "meta", a["id"], b"{}", os.urandom(12)), "reveal_hash": d["reveal_hash"],
        "answer_ct": ref.wrap_answer(q["id"], a["id"], a["K"], ref.raw_public(q["d"]))})
    assert r.status_code == 410 and r.json()["error"]["reason"] == "answered"
    assert db.val("SELECT count(*) FROM secrets WHERE id = ?", a["id"]) == 0 and not chunk_files()


def test_seal_needs_answer_ct_exactly_for_an_answer(client):
    q = ask(client)
    a = answer(anon(client), q, seal=False)
    d = ref.derive_link(a["id"], a["K"])
    body = {"meta_ct": ref.seal_blob(d["meta_key"], "meta", a["id"], b"{}", os.urandom(12)), "reveal_hash": d["reveal_hash"]}
    assert anon(client).post(f"/api/v1/secrets/{a['id']}/seal", headers=a["up"], json=body).status_code == 400
    # A plain link can't pose as an answer.
    from helpers import send
    s = send(client, seal=False)
    d = ref.derive_link(s.id, s.K)
    r = client.post(f"/api/v1/secrets/{s.id}/seal", headers={"Authorization": f"Upload {s.upload_token}"}, json={
        "meta_ct": ref.seal_blob(d["meta_key"], "meta", s.id, b"{}", os.urandom(12)), "reveal_hash": d["reveal_hash"], "answer_ct": "AAAA"})
    assert r.status_code == 400


def test_an_unanswered_request_expires(client):
    q = ask(client, expires_in=300)
    db.run("UPDATE requests SET expires_at = ? WHERE id = ?", now() - 1, q["id"])
    r = anon(client).get(f"/api/v1/requests/{q['id']}", headers=q["h"])
    assert r.status_code == 410 and r.json()["error"]["reason"] == "expired"
    assert mine(client, q)[q["id"]]["status"] == "expired"


def test_the_request_and_its_answer_expire_together(client):
    q = ask(client, expires_in=7200)
    a = answer(anon(client), q)
    assert db.val("SELECT expires_at FROM secrets WHERE id = ?", a["id"]) == db.val("SELECT expires_at FROM requests WHERE id = ?", q["id"])
    assert mine(client, q)[q["id"]]["answer"]["expires_at"] == mine(client, q)[q["id"]]["expires_at"]
    db.run("UPDATE secrets SET expires_at = ? WHERE id = ?", now() - 1, a["id"])
    assert mine(client, q)[q["id"]]["status"] == "expired"
    jobs.cleanup()
    got = mine(client, q)[q["id"]]
    assert got["status"] == "expired" and "answer" not in got and not chunk_files()


def test_deleting_a_request_closes_its_link_and_destroys_the_answer(client):
    q = ask(client)
    answer(anon(client), q)
    assert anon(client).delete(f"/api/v1/requests/{q['id']}", headers=q["m"]).status_code == 204
    assert anon(client).delete(f"/api/v1/requests/{q['id']}", headers=q["m"]).status_code == 204  # again: nothing more to do
    assert q["id"] not in mine(client, q) and not chunk_files()
    waiting = ask(client)
    assert anon(client).delete(f"/api/v1/requests/{waiting['id']}", headers=waiting["m"]).status_code == 204
    r = anon(client).get(f"/api/v1/requests/{waiting['id']}", headers=waiting["h"])
    assert r.status_code == 410 and r.json()["error"]["reason"] == "closed"


def test_a_password_reset_closes_requests(client):
    q, waiting = ask(client), ask(client)
    answer(anon(client), q)
    assert manage.owner_reset(None) == 0  # only the old vault held the key their answers are encrypted to
    r = anon(client).get(f"/api/v1/requests/{waiting['id']}", headers=waiting["h"])
    assert r.status_code == 410 and r.json()["error"]["reason"] == "closed"
    jobs.cleanup()
    assert not chunk_files() and db.val("SELECT count(*) FROM secrets") == 0


def test_requests_are_audited(client):
    q = ask(client)
    answer(anon(client), q)
    types = [r["type"] for r in db.all("SELECT type FROM events WHERE secret_id = ? ORDER BY id", q["id"])]
    assert types == ["secret.requested", "secret.request_answered"]


def test_the_demo_asks_and_answers_within_its_limits_and_wipes_requests(server):
    from helpers import pow_header

    from cryptex import demo
    c = server(DEMO="true")
    assert c.post("/api/v1/requests", json={"expires_in": 3600}).status_code == 400  # proof of work, as for links
    q = ask(c, headers=pow_header(c))
    a = answer(anon(c), q, headers=pow_header(c))
    assert a["seal"].status_code == 200 and read_answer(c, q) == "k7#Qp2-vR9mL"
    assert c.get("/api/v1/config").json()["quota"]["used"] == 2  # asking and answering are each one of today's links
    demo.wipe()
    assert db.val("SELECT count(*) FROM requests") == 0


def test_whoever_answers_can_add_a_passphrase(client):
    q = ask(client)
    b = anon(client)
    pt = json.dumps({"v": 1, "items": [{"t": "note", "v": "locked twice"}]}).encode()
    prefix, salt = os.urandom(7), os.urandom(16)
    r = b.post(f"/api/v1/requests/{q['id']}/answer", headers=q["h"], json={
        "streams": [{"stream": 0, "prefix": ref.b64u(prefix), "chunks": 1, "size": len(pt) + 16}], "passphrase_salt": ref.b64u(salt)})
    assert r.status_code == 201, r.text
    sid, up = r.json()["id"], {"Authorization": f"Upload {r.json()['upload_token']}"}
    K = os.urandom(16)
    d, pp = ref.derive_link(sid, K), ref.derive_passphrase(sid, K, "copper-lantern", salt)
    assert b.put(f"/api/v1/secrets/{sid}/chunks/0/0", content=ref.stream_encrypt(pp["content_key"], sid, 0, prefix, pt)[0], headers=up).status_code == 204
    seal = {"meta_ct": ref.seal_blob(d["meta_key"], "meta", sid, b"{}", os.urandom(12)), "reveal_hash": d["reveal_hash"],
            "answer_ct": ref.wrap_answer(q["id"], sid, K, ref.raw_public(q["d"]))}
    assert b.post(f"/api/v1/secrets/{sid}/seal", json=seal, headers=up).status_code == 400  # the passcheck is required
    assert b.post(f"/api/v1/secrets/{sid}/seal", json={**seal, "passcheck_hash": pp["passcheck_hash"]}, headers=up).status_code == 200
    assert mine(client, q)[q["id"]]["answer"]["passphrase"] is True
    # The requester's key opens the link, and the passphrase is still needed to reveal it.
    rh = {"Authorization": f"Reveal {ref.b64u(d['reveal_token'])}"}
    assert anon(client).get(f"/api/v1/secrets/{sid}/meta", headers=rh).json()["passphrase"] is True
    assert anon(client).post(f"/api/v1/secrets/{sid}/reveal", headers=rh).status_code == 400
    assert anon(client).post(f"/api/v1/secrets/{sid}/reveal", headers={**rh, "X-Passcheck": ref.b64u(pp["passcheck_token"])}).status_code == 200
