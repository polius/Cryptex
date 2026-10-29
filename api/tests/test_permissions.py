"""One test per permission rule: who may do what to secrets, receipts, accounts and the server."""
import pytest
from conftest import OWNER, OWNER_SALT, SETUP, anon, auth_key, creds, reauth, totp_code
from helpers import open_meta, reveal, send

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
    # signed-in owner still can
    send(c)


def test_visitor_can_still_open_when_signed_in_required(server):
    c = server(access="signed_in")
    s = send(c)
    reveal(anon(c), s)


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


def test_owner_session_never_grants_reveal_or_manage_for_others(client):
    """Rule 2: there is no admin bypass."""
    bob = anon(client)
    s = send(bob)  # anonymous sender
    for r in (client.get(f"/api/v1/secrets/{s.id}/meta"), client.post(f"/api/v1/secrets/{s.id}/reveal"),
              client.get(f"/api/v1/receipts/{s.id}"), client.delete(f"/api/v1/secrets/{s.id}")):
        assert r.status_code == 404, r.request.url
    assert open_meta(bob, s)["views_left"] == 1


def test_members_get_404_for_server_tab(client):
    """A signed-in member, not a visitor: the role is what's checked, and the answer is the uniform 404."""
    url = client.post("/api/v1/server/users", json={"username": "lisa", "role": "member"}).json()["invite_url"]
    lisa = anon(client)
    r = lisa.post("/api/v1/auth/invite/accept", json={"token": url.split("#", 1)[1], **creds("lisa's long passphrase")})
    assert r.status_code == 200 and r.json()["user"]["role"] == "member"
    lisa.headers["X-CSRF"] = r.json()["csrf"]
    for path in ("/api/v1/server/overview", "/api/v1/server/access", "/api/v1/server/limits", "/api/v1/server/language",
                 "/api/v1/server/users", "/api/v1/server/branding", "/api/v1/server/audit"):
        r = lisa.get(path)
        assert (r.status_code, r.json()) == (404, NOT_FOUND), path
    me = client.get("/api/v1/auth/session").json()["user"]["id"]
    for method, path in (("PUT", "/api/v1/server/access"), ("PUT", "/api/v1/server/limits"), ("PATCH", f"/api/v1/server/users/{me}"),
                         ("DELETE", f"/api/v1/server/users/{me}"), ("POST", "/api/v1/server/users")):
        assert lisa.request(method, path, json={"mode": "anyone", "role": "member", "username": "eve"}).status_code == 404, path


def test_role_changes_need_reauth_and_last_owner_stays(client):
    me = client.get("/api/v1/auth/session").json()["user"]["id"]
    # fresh setup grants a 5-minute re-auth window; expire it
    from cryptex import db
    db.run("UPDATE sessions SET reauth_until = 0")
    r = client.patch(f"/api/v1/server/users/{me}", json={"role": "member"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    assert client.post("/api/v1/auth/reauth", json={"auth_key": auth_key("wrong", OWNER_SALT), "code": totp_code()}).status_code == 401
    assert client.post("/api/v1/auth/reauth", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT), "code": "000000"}).status_code == 401
    reauth(client)
    r = client.patch(f"/api/v1/server/users/{me}", json={"role": "member"})
    assert r.status_code == 409


def test_access_change_needs_reauth(client):
    from cryptex import db
    db.run("UPDATE sessions SET reauth_until = 0")
    assert client.put("/api/v1/server/access", json={"mode": "signed_in"}).status_code == 403
    reauth(client)
    assert client.put("/api/v1/server/access", json={"mode": "signed_in"}).status_code == 204
    assert client.get("/api/v1/config").json()["mode"] == "signed_in"


def test_csrf_required_for_session_writes(client):
    csrf = client.headers.pop("X-CSRF")
    r = client.delete("/api/v1/me/receipts/k7Qp2vR9mL")
    assert r.status_code == 403
    client.headers["X-CSRF"] = csrf


@pytest.mark.parametrize("path", ["/api/v1/server/overview", "/api/v1/server/limits"])
def test_demo_has_no_server_tab_and_no_sign_in(server, path):
    """Rule 4: in DEMO=true nobody can sign in."""
    c = server(DEMO="true")
    assert c.get(path).status_code == 404
    r = c.post("/api/v1/auth/login", json={"username": OWNER["username"], "auth_key": "A" * 43})
    assert r.status_code == 403 and r.json()["error"]["code"] == "demo_locked"
    assert c.post("/api/v1/setup", json=SETUP).status_code == 409
