"""One test per row of design/v3/spec/permissions.md, plus its four "rules worth testing"."""
import pytest
from conftest import OWNER, anon
from helpers import ask, open_meta, reveal, send

NOT_FOUND = {"error": {"code": "not_found", "message": "Not found."}}


def test_visitor_can_create_when_access_is_anyone(client):
    bob = anon(client)
    s = send(bob)
    assert open_meta(bob, s)["views_left"] == 1


def test_visitor_cannot_create_when_access_is_signed_in(server):
    c = server(access="signed_in")
    bob = anon(c)
    r = bob.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600}, "streams": []})
    assert r.status_code == 401 and r.json()["error"]["code"] == "sign_in_required"
    r = bob.post("/api/v1/requests", json={"public_key": "x", "expires_in": 3600, "keep_answer_s": 3600})
    assert r.status_code == 401
    # signed-in owner still can
    send(c)


def test_visitor_can_still_open_and_answer_when_signed_in_required(server):
    c = server(access="signed_in")
    s = send(c)
    a = ask(c)
    bob = anon(c)
    reveal(bob, s)
    assert bob.get(f"/api/v1/requests/{a.id}/prompt", headers=a.answer_headers()).status_code == 200


def test_meta_and_reveal_need_the_reveal_token(client):
    s = send(client)
    bob = anon(client)
    for headers in ({}, {"Authorization": "Reveal " + "A" * 43}, s.manage_headers(), {"Authorization": f"Upload {s.upload_token}"}):
        r = bob.get(f"/api/v1/secrets/{s.id}/meta", headers=headers)
        assert (r.status_code, r.json()) == (404, NOT_FOUND)
        r = bob.post(f"/api/v1/secrets/{s.id}/reveal", headers=headers)
        assert (r.status_code, r.json()) == (404, NOT_FOUND)


def test_404_is_identical_for_unknown_id_wrong_token_and_unknown_route(client):
    s = send(client)
    bob = anon(client)
    a = bob.get(f"/api/v1/secrets/{s.id}/meta", headers={"Authorization": "Reveal " + "B" * 43})
    b = bob.get("/api/v1/secrets/ZZZZZZZZZZ/meta", headers=s.reveal_headers())
    c = bob.get("/api/v1/nope")
    d = bob.delete(f"/api/v1/secrets/{s.id}")
    assert a.content == b.content == c.content == d.content
    assert {a.status_code, b.status_code, c.status_code, d.status_code} == {404}


def test_answer_needs_the_answer_token(client):
    a = ask(client)
    bob = anon(client)
    assert bob.get(f"/api/v1/requests/{a.id}/prompt").status_code == 404
    assert bob.get(f"/api/v1/requests/{a.id}/prompt", headers=a.manage_headers()).status_code == 404
    assert bob.post(f"/api/v1/requests/{a.id}/answer", json={"ephemeral_key": "x", "streams": []}).status_code == 404


def test_status_and_destroy_need_the_manage_token(client):
    s = send(client)
    bob = anon(client)
    assert bob.get(f"/api/v1/receipts/{s.id}").status_code == 404
    assert bob.get(f"/api/v1/receipts/{s.id}", headers=s.reveal_headers()).status_code == 404
    assert bob.delete(f"/api/v1/secrets/{s.id}", headers=s.reveal_headers()).status_code == 404
    assert bob.get(f"/api/v1/receipts/{s.id}", headers=s.manage_headers()).json()["status"] == "waiting"
    assert bob.delete(f"/api/v1/secrets/{s.id}", headers=s.manage_headers()).status_code == 204
    r = bob.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "destroyed"


def test_members_see_status_through_synced_receipts(client):
    # the owner on `client` created it while signed in: it's attached to their account
    s = send(client)
    assert client.get(f"/api/v1/receipts/{s.id}").status_code == 200
    ids = [i["id"] for i in client.get("/api/v1/me/receipts").json()["items"]]
    assert s.id in ids
    assert client.delete(f"/api/v1/secrets/{s.id}").status_code == 204


def test_owner_session_never_grants_reveal_answer_or_manage_for_others(client):
    """Rule 2: there is no admin bypass."""
    bob = anon(client)
    s = send(bob)  # anonymous sender
    a = ask(bob)
    for r in (client.get(f"/api/v1/secrets/{s.id}/meta"), client.post(f"/api/v1/secrets/{s.id}/reveal"),
              client.get(f"/api/v1/receipts/{s.id}"), client.delete(f"/api/v1/secrets/{s.id}"),
              client.get(f"/api/v1/requests/{a.id}/prompt"), client.get(f"/api/v1/requests/{a.id}/answer"),
              client.delete(f"/api/v1/requests/{a.id}")):
        assert r.status_code == 404, r.request.url
    assert open_meta(bob, s)["views_left"] == 1


def _token(client, scopes=("send", "request")):
    r = client.post("/api/v1/me/tokens", json={"name": "ci", "scopes": list(scopes)})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def test_api_tokens_cannot_call_server_or_auth_even_for_owners(client):
    """Rule 3."""
    t = _token(client)
    bob = anon(client)
    h = {"Authorization": f"Bearer {t}"}
    for path in ("/api/v1/server/overview", "/api/v1/server/access", "/api/v1/server/limits", "/api/v1/server/audit",
                 "/api/v1/server/tokens", "/api/v1/me/tokens", "/api/v1/me/receipts"):
        assert bob.get(path, headers=h).status_code == 404, path
    assert bob.post("/api/v1/auth/reauth", json={"password": OWNER["password"]}, headers=h).status_code == 404
    assert bob.post("/api/v1/me/tokens", json={"name": "x", "scopes": ["send"]}, headers=h).status_code == 404


def test_api_token_scopes(client):
    t = _token(client, scopes=("send",))
    bob = anon(client)
    h = {"Authorization": f"Bearer {t}"}
    send(bob, headers=h)
    r = bob.post("/api/v1/requests", json={"public_key": "x", "expires_in": 3600, "keep_answer_s": 3600}, headers=h)
    assert r.status_code == 403


def test_api_token_manages_its_own_receipts(client):
    t = _token(client)
    bob = anon(client)
    h = {"Authorization": f"Bearer {t}"}
    s = send(bob, headers=h)
    assert bob.get(f"/api/v1/receipts/{s.id}", headers=h).json()["status"] == "waiting"


def test_revoked_or_bad_token_is_rejected(client):
    t = _token(client)
    tid = client.get("/api/v1/me/tokens").json()["items"][0]["id"]
    assert client.delete(f"/api/v1/tokens/{tid}").status_code == 204
    bob = anon(client)
    r = bob.post("/api/v1/secrets", json={}, headers={"Authorization": f"Bearer {t}"})
    assert r.status_code == 401


def test_members_get_404_for_server_tab(client):
    bob = anon(client)
    for path in ("/api/v1/server/overview", "/api/v1/server/access", "/api/v1/server/limits"):
        assert bob.get(path).status_code == 404


def test_role_changes_need_reauth_and_last_owner_stays(client):
    me = client.get("/api/v1/auth/session").json()["user"]["id"]
    # fresh setup grants a 5-minute re-auth window; expire it
    from cryptex import db
    db.run("UPDATE sessions SET reauth_until = 0")
    r = client.patch(f"/api/v1/server/users/{me}", json={"role": "member"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    assert client.post("/api/v1/auth/reauth", json={"password": "wrong"}).status_code == 401
    assert client.post("/api/v1/auth/reauth", json={"password": OWNER["password"]}).status_code == 204
    r = client.patch(f"/api/v1/server/users/{me}", json={"role": "member"})
    assert r.status_code == 409


def test_access_change_needs_reauth(client):
    from cryptex import db
    db.run("UPDATE sessions SET reauth_until = 0")
    assert client.put("/api/v1/server/access", json={"mode": "signed_in"}).status_code == 403
    client.post("/api/v1/auth/reauth", json={"password": OWNER["password"]})
    assert client.put("/api/v1/server/access", json={"mode": "signed_in"}).status_code == 204
    assert client.get("/api/v1/config").json()["mode"] == "signed_in"


def test_csrf_required_for_session_writes(client):
    csrf = client.headers.pop("X-CSRF")
    r = client.post("/api/v1/me/tokens", json={"name": "x", "scopes": ["send"]})
    assert r.status_code == 403
    client.headers["X-CSRF"] = csrf


@pytest.mark.parametrize("path", ["/api/v1/server/overview", "/api/v1/server/limits"])
def test_demo_has_no_server_tab_and_no_sign_in(server, path):
    """Rule 4: in DEMO=true nobody can sign in."""
    c = server(DEMO="true")
    assert c.get(path).status_code == 404
    r = c.post("/api/v1/auth/login", json={"email": OWNER["email"], "password": OWNER["password"]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "demo_locked"
    assert c.post("/api/v1/setup/owner", json={"setup_code": "TEST-CODE-0001", **OWNER}).status_code == 409
