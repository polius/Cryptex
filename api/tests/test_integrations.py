"""Sign-in, invites, 2FA, branding and audit, against real local services."""
import json
import logging

import pyotp
from conftest import OWNER, OWNER_SALT, SETUP, SETUP_CODE, anon, auth_key, creds, login_body, reauth, sign_in, totp_code
from helpers import reveal, send

from cryptex import account, db, manage, state
from cryptex.util import b64u, now


# ------------------------------------------------------------------ access rules
def test_email_only_links_are_gone(client):
    r = client.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600, "access": "email", "email": "a@b.example"},
                                             "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 20}]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid"


# ------------------------------------------------------------------ sign-in: password, plus the code when 2FA is on
def test_sign_in_with_2fa_needs_a_code_and_codes_cant_be_replayed(client):
    bob = anon(client)
    r = bob.post("/api/v1/auth/login", json=login_body(bob, OWNER["username"], OWNER["password"]))
    ticket = r.json()["mfa_ticket"]
    assert ticket and "cx_session" not in r.cookies
    code = totp_code()
    r = bob.post("/api/v1/auth/login/totp", json={"mfa_ticket": ticket, "code": code})
    assert r.status_code == 200 and bob.get("/api/v1/auth/session").json()["user"]["username"] == OWNER["username"]
    eve = anon(client)
    r = eve.post("/api/v1/auth/login", json=login_body(eve, OWNER["username"], OWNER["password"]))
    r = eve.post("/api/v1/auth/login/totp", json={"mfa_ticket": r.json()["mfa_ticket"], "code": code})
    assert r.status_code == 401


def test_2fa_moves_to_a_new_app_by_turning_it_off_and_on(client):
    new = client.post("/api/v1/me/totp").json()["secret"]
    assert client.put("/api/v1/me/totp", json={"secret": new, "code": pyotp.TOTP(new).now()}).status_code == 409  # still on
    assert client.delete("/api/v1/me/totp").status_code == 204
    assert client.put("/api/v1/me/totp", json={"secret": new, "code": "000000"}).status_code == 400
    assert client.put("/api/v1/me/totp", json={"secret": new, "code": pyotp.TOTP(new).now()}).status_code == 204
    sign_in(anon(client), secret=new)


def test_setup_is_done_at_once_and_the_owner_is_signed_in(server):
    """Finish: owner, name and access together. 2FA is off until the owner turns it on."""
    c = server(setup=False)
    assert c.post("/api/v1/setup/check", json={"setup_code": "WRONG"}).status_code == 400
    assert c.post("/api/v1/setup/check", json={"setup_code": SETUP_CODE}).status_code == 204
    assert c.get("/api/v1/config").json()["setup_needed"] is True  # checking the code changes nothing
    r = c.post("/api/v1/setup", json={**SETUP, "brand_name": " Globex ", "access": "signed_in"})
    assert r.status_code == 200 and r.json()["user"]["totp"] is False and r.json()["user"]["role"] == "owner"
    cfg = anon(c).get("/api/v1/config").json()
    assert cfg["setup_needed"] is False and cfg["brand"]["name"] == "Globex" and cfg["mode"] == "signed_in"
    c.headers["X-CSRF"] = r.json()["csrf"]
    assert c.get("/api/v1/server/overview").status_code == 200
    assert c.post("/api/v1/setup/check", json={"setup_code": SETUP_CODE}).status_code == 409


def test_2fa_is_optional_and_can_be_turned_on_and_off(server):
    c = server(setup=False)
    r = c.post("/api/v1/setup", json=SETUP)
    assert r.status_code == 200 and r.json()["user"]["totp"] is False
    c.headers["X-CSRF"] = r.json()["csrf"]

    def login() -> dict:
        b = anon(c)
        r = b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"]))
        assert r.status_code == 200, r.text
        return r.json()

    assert set(login()) == {"user", "csrf", "vault", "shared"}  # no 2FA: the password signs in
    assert c.post("/api/v1/auth/reauth", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT)}).status_code == 204
    secret = c.post("/api/v1/me/totp").json()["secret"]
    assert c.put("/api/v1/me/totp", json={"secret": secret, "code": pyotp.TOTP(secret).now()}).status_code == 204
    assert c.get("/api/v1/config").json()["user"]["totp"] is True
    assert set(login()) == {"mfa_ticket"}  # now the code is needed too
    assert c.post("/api/v1/auth/reauth", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT)}).status_code == 401
    db.run("UPDATE sessions SET reauth_until = 0")
    assert c.delete("/api/v1/me/totp").status_code == 403  # turning it off needs a fresh confirmation
    assert c.post("/api/v1/auth/reauth", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT),
                                              "code": totp_code(secret=secret)}).status_code == 204
    assert c.delete("/api/v1/me/totp").status_code == 204
    assert set(login()) == {"user", "csrf", "vault", "shared"}


# ------------------------------------------------------------------ forgot password: a temporary one, read on the server
def test_temporary_password_auth_key_matches_the_browser():
    # From hash-wasm with the browser's settings (web/src/store/vault.ts deriveAccount).
    assert account.derive_auth_key("abcd-efgh-jkmn-pqrs", b"owner-test-salt!", account.KDF) == "ikOv8ImqirdUUjvk2xg1Cl1i5AanRRRj3BhSDSULm6E"


def cli(monkeypatch, *args: str) -> int:
    """`cryptex ...` as whoever runs the server would, on this test server's data."""
    e = state.env()
    monkeypatch.setenv("DATA_DIR", str(e.data_dir))
    try:
        return manage.main(list(args))
    finally:
        state.init(e)  # the command loads its own settings from the environment


def read_temp(monkeypatch, capsys, username=OWNER["username"]) -> str:
    assert cli(monkeypatch, "temp-password", username) == 0
    return capsys.readouterr().out.strip().splitlines()[-1]


def test_forgot_password_leaves_a_temporary_one_that_must_be_replaced(server, monkeypatch, capsys):
    client = server(RATE_AUTH="20/15m")
    monkeypatch.setattr(account, "derive_auth_key", lambda pw, salt, kdf: auth_key(pw, b64u(salt)))  # the tests' stand-in KDF
    bob = anon(client)
    nobody = bob.post("/api/v1/auth/forgot", json={"username": "nobody"})
    r = bob.post("/api/v1/auth/forgot", json={"username": OWNER["username"]})
    assert r.status_code == nobody.status_code == 200 and set(r.json()) == set(nobody.json()) == {"command", "hours"}
    folder = state.env().data_dir / "temp-passwords"
    assert [p.name for p in folder.iterdir()] == [OWNER["username"]]
    assert (folder / OWNER["username"]).stat().st_mode & 0o777 == 0o600

    # Asking changes nothing: the current password still signs in, and then the temporary one is dropped.
    sign_in(anon(client))
    assert list(folder.iterdir()) == []
    assert cli(monkeypatch, "temp-password", OWNER["username"]) == 1 and "No temporary password" in capsys.readouterr().err

    bob.post("/api/v1/auth/forgot", json={"username": OWNER["username"]})
    temp = read_temp(monkeypatch, capsys)
    r = bob.post("/api/v1/auth/login", json=login_body(bob, OWNER["username"], temp))
    assert set(r.json()) == {"reset_ticket"} and "cx_session" not in r.cookies  # no 2FA code; not signed in until a new password
    ticket = r.json()["reset_ticket"]
    assert bob.post("/api/v1/auth/login/totp", json={"mfa_ticket": ticket, "code": totp_code()}).status_code == 401
    r = bob.post("/api/v1/auth/password/reset", json={"reset_ticket": ticket, **creds("new password")})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["totp"] is False  # 2FA turned off with it
    assert r.json()["vault"]["vault_pw"] is None  # the old vault went with the old password: the browser makes a new one
    assert anon(client).post("/api/v1/auth/password/reset", json={"reset_ticket": ticket, **creds("again")}).status_code == 401
    assert client.get("/api/v1/auth/session").json()["user"] is None  # other sessions signed out
    assert list(folder.iterdir()) == []

    for old in (OWNER["password"], temp):
        eve = anon(client)
        assert eve.post("/api/v1/auth/login", json=login_body(eve, OWNER["username"], old)).status_code == 401
    eve = anon(client)
    r = eve.post("/api/v1/auth/login", json=login_body(eve, OWNER["username"], "new password"))
    assert set(r.json()) == {"user", "csrf", "vault", "shared"}  # the new password alone signs in now
    eve.headers["X-CSRF"] = r.json()["csrf"]
    types = [e["type"] for e in eve.get("/api/v1/server/audit").json()["items"]]
    assert "user.temp_password" in types and "user.password_reset" in types


def test_temporary_password_expires_and_yields_to_an_owner_reset(server, monkeypatch, capsys):
    monkeypatch.setattr(account, "derive_auth_key", lambda pw, salt, kdf: auth_key(pw, b64u(salt)))
    c = server(setup=False)
    c.headers["X-CSRF"] = c.post("/api/v1/setup", json=SETUP).json()["csrf"]
    bob = anon(c)
    bob.post("/api/v1/auth/forgot", json={"username": OWNER["username"]})
    temp = read_temp(monkeypatch, capsys)
    r = bob.post("/api/v1/auth/login", json=login_body(bob, OWNER["username"], temp))
    assert set(r.json()) == {"reset_ticket"}

    path = state.env().data_dir / "temp-passwords" / OWNER["username"]
    db.run("UPDATE users SET temp_expires_at = ?", now() - 1)  # a day old
    assert bob.post("/api/v1/auth/login", json=login_body(bob, OWNER["username"], temp)).status_code == 401
    assert cli(monkeypatch, "temp-password", OWNER["username"]) == 1 and not path.exists()  # never handed out

    bob.post("/api/v1/auth/forgot", json={"username": OWNER["username"]})
    temp = read_temp(monkeypatch, capsys)
    db.run("UPDATE users SET password_hash = NULL")  # an owner reset: only the invite link gets in now
    assert bob.post("/api/v1/auth/login", json=login_body(bob, OWNER["username"], temp)).status_code == 401


# ------------------------------------------------------------------ invites
def accept(c, url, password="lisa's long passphrase", totp=True):
    token = url.split("#", 1)[1]
    info = c.post("/api/v1/auth/invite", json={"token": token}).json()
    mfa = {"totp_secret": info["secret"], "totp_code": pyotp.TOTP(info["secret"]).now()} if totp else {}
    r = c.post("/api/v1/auth/invite/accept", json={"token": token, **creds(password), **mfa})
    if r.status_code == 200:
        c.headers["X-CSRF"] = r.json()["csrf"]
    return r, info


def test_invite_sets_a_password_and_2fa_once(client):
    r = client.post("/api/v1/server/users", json={"username": "Lisa", "role": "member"})
    assert r.status_code == 201
    url = r.json()["invite_url"]
    assert url.startswith("/invite#")
    lisa = anon(client)
    token = url.split("#", 1)[1]
    info = lisa.post("/api/v1/auth/invite", json={"token": token}).json()
    assert info["username"] == "lisa" and "name" not in info and info["reset"] is False
    bad = lisa.post("/api/v1/auth/invite/accept", json={"token": token, "salt": "x", "auth_key": "not a key", "totp_secret": info["secret"],
                                                        "totp_code": pyotp.TOTP(info["secret"]).now()})
    assert bad.status_code == 400  # the browser sends a derived key, never the password itself
    bad = lisa.post("/api/v1/auth/invite/accept", json={"token": token, **creds("lisa's long passphrase"),
                                                        "totp_secret": info["secret"], "totp_code": "000000"})
    assert bad.status_code == 400 and bad.json()["error"]["field"] == "totp_code"
    r, info = accept(lisa, url)
    assert r.status_code == 200 and r.json()["user"]["role"] == "member"
    assert lisa.get("/api/v1/server/overview").status_code == 404  # members don't get the Server tab
    again = anon(client).post("/api/v1/auth/invite", json={"token": token})
    assert again.status_code == 410
    sign_in(anon(client), "lisa", "lisa's long passphrase", info["secret"])
    people = {p["username"]: p for p in client.get("/api/v1/server/access").json()["people"]}
    assert people["lisa"]["status"] == "active"
    types = [e["type"] for e in client.get("/api/v1/server/audit").json()["items"]]
    assert "user.invited" in types and "user.joined" in types


def test_invite_can_skip_2fa(client):
    url = client.post("/api/v1/server/users", json={"username": "lisa", "role": "member"}).json()["invite_url"]
    r, _ = accept(anon(client), url, totp=False)
    assert r.status_code == 200 and r.json()["user"]["totp"] is False
    b = anon(client)
    assert set(b.post("/api/v1/auth/login", json=login_body(b, "lisa", "lisa's long passphrase")).json()) == {"user", "csrf", "vault", "shared"}


def test_people_management_rules(client):
    from cryptex import db
    r = client.post("/api/v1/server/users", json={"username": OWNER["username"]})
    assert r.status_code == 400 and r.json()["error"]["field"] == "username"
    assert client.post("/api/v1/server/users", json={"username": " SAM "}).status_code == 400  # same, once folded
    for bad in ["a", "with space", "lee@acme.example", "-lee", "x" * 33]:
        r = client.post("/api/v1/server/users", json={"username": bad})
        assert r.status_code == 400 and r.json()["error"]["field"] == "username", bad
    uid = client.post("/api/v1/server/users", json={"username": "lee"}).json()["id"]
    me = client.get("/api/v1/auth/session").json()["user"]["id"]
    assert client.post(f"/api/v1/server/users/{me}/invite").status_code == 400
    assert client.delete(f"/api/v1/server/users/{me}").status_code == 400
    db.run("UPDATE sessions SET reauth_until = 0")
    assert client.delete(f"/api/v1/server/users/{uid}").status_code == 403  # re-auth first
    reauth(client)
    assert client.delete(f"/api/v1/server/users/{uid}").status_code == 204
    assert client.delete(f"/api/v1/server/users/{uid}").status_code == 404


def test_authenticator_label_names_the_server_once(client):
    db.run("UPDATE settings SET value = '\"\"' WHERE key = 'brand_name'")
    state.invalidate()
    reauth(client)
    uri = client.post("/api/v1/me/totp").json()["uri"]
    assert uri.startswith("otpauth://totp/Cryptex:sam?") and "issuer=Cryptex&" in uri + "&"


def lisa_joined(client, totp=True):
    """Lisa, a member who joined (with 2FA unless totp=False), signed in on her own client."""
    url = client.post("/api/v1/server/users", json={"username": "lisa"}).json()["invite_url"]
    lisa = anon(client)
    _, info = accept(lisa, url, totp=totp)
    return lisa, lisa.get("/api/v1/auth/session").json()["user"]["id"], info


def reset_accept(c, link, code=None, password="a different passphrase", **mfa):
    return c.post("/api/v1/auth/reset/accept", json={"token": link["reset_url"].split("#", 1)[1], "code": code or link["code"],
                                                     **creds(password), **mfa})


def test_reset_link_needs_the_code_keeps_the_old_password_until_used_and_turns_2fa_off(client):
    lisa, uid, _ = lisa_joined(client)
    assert client.post(f"/api/v1/server/users/{uid}/invite").status_code == 400  # joined: a reset link, not an invite
    link = client.post(f"/api/v1/server/users/{uid}/reset", json={}).json()
    token = link["reset_url"].split("#", 1)[1]
    assert link["reset_url"].startswith("/reset#") and len(token) == 43  # 256 bits
    assert len(link["code"]) == 9 and link["code"][4] == "-"
    people = {p["username"]: p for p in client.get("/api/v1/server/access").json()["people"]}
    assert people["lisa"]["status"] == "reset" and people["lisa"]["reset_expires_at"]

    # Nothing changes for Lisa until the link is used, but she hears about it.
    me = lisa.get("/api/v1/config").json()["user"]
    assert me["notice"]["by"] == OWNER["username"] and me["notice"]["pending"] is True
    b = anon(client)
    assert set(b.post("/api/v1/auth/login", json=login_body(b, "lisa", "lisa's long passphrase")).json()) == {"mfa_ticket"}

    info = anon(client).post("/api/v1/auth/reset", json={"token": token}).json()
    assert info["username"] == "lisa" and info["by"] == OWNER["username"] and info["tries_left"] == 5 and info["secret"]
    r = reset_accept(anon(client), link, code="AAAA-AAAA")
    assert r.status_code == 400 and r.json()["error"]["code"] == "wrong_code" and r.json()["error"]["tries_left"] == 4
    r = reset_accept(anon(client), link, code=" " + link["code"].replace("-", "").lower())  # typed loosely
    assert r.status_code == 200, r.text
    assert r.json()["user"]["totp"] is False and r.json()["user"]["notice"] is None  # 2FA off; it can be set up again
    assert r.json()["vault"]["vault_pw"] is None  # a new vault, made by the browser
    assert lisa.get("/api/v1/auth/session").json()["user"] is None  # signed out everywhere else
    assert reset_accept(anon(client), link).status_code == 410  # once
    b = anon(client)
    assert b.post("/api/v1/auth/login", json=login_body(b, "lisa", "lisa's long passphrase")).status_code == 401
    assert set(b.post("/api/v1/auth/login", json=login_body(b, "lisa", "a different passphrase")).json()) == {"user", "csrf", "vault", "shared"}
    types = [e["type"] for e in client.get("/api/v1/server/audit").json()["items"]]
    assert "user.reset_link" in types and "user.password_reset" in types


def test_reset_link_can_lock_the_account_and_dies_after_five_wrong_codes(server):
    client = server(RATE_AUTH="30/15m")
    lisa, uid, _ = lisa_joined(client, totp=False)
    link = client.post(f"/api/v1/server/users/{uid}/reset", json={"lock": True}).json()
    assert lisa.get("/api/v1/auth/session").json()["user"] is None  # locked: signed out now
    b = anon(client)
    assert b.post("/api/v1/auth/login", json=login_body(b, "lisa", "lisa's long passphrase")).status_code == 401
    for left in (4, 3, 2, 1):
        assert reset_accept(anon(client), link, code="AAAA-AAAA").json()["error"]["tries_left"] == left
    r = reset_accept(anon(client), link, code="AAAA-AAAA")
    assert r.status_code == 410 and r.json()["error"]["reason"] == "reset_tries"
    assert reset_accept(anon(client), link).status_code == 410  # the right code is too late now
    people = {p["username"]: p for p in client.get("/api/v1/server/access").json()["people"]}
    assert people["lisa"]["status"] == "locked"
    # A new link, and this time Lisa sets up 2FA on the reset page.
    link = client.post(f"/api/v1/server/users/{uid}/reset", json={}).json()
    secret = anon(client).post("/api/v1/auth/reset", json={"token": link["reset_url"].split("#", 1)[1]}).json()["secret"]
    assert reset_accept(anon(client), link, totp_secret=secret, totp_code="000000").status_code == 400
    r = reset_accept(anon(client), link, totp_secret=secret, totp_code=pyotp.TOTP(secret).now())
    assert r.status_code == 200 and r.json()["user"]["totp"] is True


def test_reset_link_rules_and_cancelling_it(client):
    me = client.get("/api/v1/auth/session").json()["user"]["id"]
    assert client.post(f"/api/v1/server/users/{me}/reset", json={}).status_code == 400  # not yourself
    pending = client.post("/api/v1/server/users", json={"username": "lee"}).json()["id"]
    assert client.post(f"/api/v1/server/users/{pending}/reset", json={}).status_code == 400  # not joined: a new invite
    lisa, uid, _ = lisa_joined(client, totp=False)
    assert lisa.post(f"/api/v1/server/users/{me}/reset", json={}).status_code == 404  # members don't get the Server tab

    client.post(f"/api/v1/server/users/{uid}/reset", json={})
    assert lisa.delete("/api/v1/me/notice").status_code == 204  # "I asked for it": the link stays
    assert lisa.get("/api/v1/config").json()["user"]["notice"] is None
    assert client.get("/api/v1/server/access").json()["people"][-1]["status"] == "reset"

    link = client.post(f"/api/v1/server/users/{uid}/reset", json={}).json()  # replaces the first one
    assert lisa.get("/api/v1/config").json()["user"]["notice"]["pending"] is True
    assert lisa.delete("/api/v1/me/reset-link").status_code == 204  # "I didn't ask for it"
    assert anon(client).post("/api/v1/auth/reset", json={"token": link["reset_url"].split("#", 1)[1]}).status_code == 410
    assert lisa.get("/api/v1/config").json()["user"]["notice"] is None
    assert "user.reset_cancelled" in [e["type"] for e in client.get("/api/v1/server/audit").json()["items"]]
    # removing someone ends their sessions too
    assert client.delete(f"/api/v1/server/users/{uid}").status_code == 204
    assert lisa.get("/api/v1/auth/session").json()["user"] is None


# ------------------------------------------------------------------ account-only links
def test_account_only_links_are_gone(client):
    """An old client asking for one gets an error, never a link anyone could open."""
    r = client.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600, "access": "account"},
                                             "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 20}]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid"


def test_logout(client):
    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get("/api/v1/auth/session").json()["user"] is None


def test_receipts_lookup_omits_wrong_pairs(client):
    s = send(client)
    other = send(client)
    r = anon(client).post("/api/v1/receipts/lookup", json={"items": [
        {"id": s.id, "manage_token": s.manage_token}, {"id": other.id, "manage_token": other.manage_token},
        {"id": s.id, "manage_token": other.manage_token}]}).json()
    assert sorted(i["id"] for i in r["items"]) == sorted([s.id, other.id])


def test_links_made_before_signing_in_join_the_account_only_with_their_manage_token(client):
    """Audit Q1: links a browser adopted after signing in had no receipt in the account, so "Start fresh" (a new
    vault) lost them. POST /me/receipts saves them to the account, each proven with its manage token."""
    mine, theirs = send(anon(client)), send(anon(client))
    failed = lambda: db.val("SELECT coalesce(sum(count), 0) FROM rate_limits WHERE bucket LIKE 'failed:%'")  # noqa: E731
    r = client.post("/api/v1/me/receipts", json={"items": [{"id": mine.id, "manage_token": mine.manage_token},
                                                           {"id": theirs.id, "manage_token": mine.manage_token},
                                                           {"id": "Zz00000000", "manage_token": "x"}]})
    assert r.status_code == 200 and r.json() == {"attached": [mine.id]}
    assert failed() == 1  # the wrong token for an ID that exists; an unknown ID isn't a guess
    listed = [i["id"] for i in client.get("/api/v1/me/receipts").json()["items"]]
    assert mine.id in listed and theirs.id not in listed
    again = client.post("/api/v1/me/receipts", json={"items": [{"id": mine.id, "manage_token": mine.manage_token}]})
    assert again.json() == {"attached": [mine.id]} and db.val("SELECT count(*) FROM user_receipts WHERE secret_id = ?", mine.id) == 1
    item = {"id": mine.id, "manage_token": mine.manage_token}
    assert anon(client).post("/api/v1/me/receipts", json={"items": [item]}).status_code == 401
    assert client.post("/api/v1/me/receipts", json={"items": [item]}, headers={"X-CSRF": "nope"}).status_code == 403
    assert client.post("/api/v1/me/receipts", json={"items": [item] * 201}).status_code == 400
    assert client.post("/api/v1/me/receipts", json={"items": []}).status_code == 400
    from cryptex import manage
    assert manage.owner_reset(None) == 0  # a password reset: the vault goes, the receipts stay
    assert db.val("SELECT count(*) FROM user_receipts WHERE secret_id = ?", mine.id) == 1


# ------------------------------------------------------------------ server tab
def test_overview(client):
    send(client)
    o = client.get("/api/v1/server/overview").json()
    assert o["live"]["secrets"] == 1 and o["week"]["created"] == 1 and o["week"]["senders"] == 1
    assert o["attention"] == []
    assert o["recent"][0]["type"] == "secret.created"


def test_branding_and_logo_sanitizing(client):
    assert client.put("/api/v1/server/branding", json={"name": "Globex", "public_url": "https://evil.example"}).status_code == 204
    brand = client.get("/api/v1/config").json()["brand"]
    assert brand["name"] == "Globex" and "public_url" not in brand  # links take the browser's address, never a stored one
    evil = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10" onclick="x()"/><foreignObject/></svg>'
    r = client.put("/api/v1/server/branding/logo", content=evil, headers={"Content-Type": "image/svg+xml"})
    assert r.status_code == 204
    url = client.get("/api/v1/config").json()["brand"]["logo_url"]
    logo = anon(client).get(url)
    assert logo.status_code == 200 and b"script" not in logo.content and b"onload" not in logo.content and b"onclick" not in logo.content
    assert b"<rect" in logo.content and "sandbox" in logo.headers["content-security-policy"]
    r = client.put("/api/v1/server/branding/logo", content=b"<!DOCTYPE x><svg/>", headers={"Content-Type": "image/svg+xml"})
    assert r.status_code == 400
    png = b"\x89PNG\r\n\x1a\n" + b"\0\0\0\rIHDR" + (128).to_bytes(4, "big") * 2
    big = png + b"\0" * (1024 * 1024 - len(png))  # logos may be up to 1 MiB
    assert client.put("/api/v1/server/branding/logo", content=big, headers={"Content-Type": "image/png"}).status_code == 204
    r = client.put("/api/v1/server/branding/logo", content=big + b"\0", headers={"Content-Type": "image/png"})
    assert r.status_code == 413 or r.json()["error"]["code"] == "too_large"
    assert client.delete("/api/v1/server/branding/logo").status_code == 204
    assert client.get("/api/v1/config").json()["brand"]["logo_url"] is None


def test_language_setting(client):
    assert client.get("/api/v1/config").json()["language"] == "auto"
    assert client.get("/api/v1/server/language").json() == {"language": "auto", "locked_by": None}
    assert client.put("/api/v1/server/language", json={"language": "ca"}).status_code == 204
    assert anon(client).get("/api/v1/config").json()["language"] == "ca"
    r = client.put("/api/v1/server/language", json={"language": "xx"})
    assert r.status_code == 400 and r.json()["error"]["field"] == "language"
    audit = client.get("/api/v1/server/audit?type=setting.changed").json()["items"]
    assert audit[0]["detail"] == {"key": "language", "from": "auto", "to": "ca"}


def test_language_locked_by_env(server):
    locked = server(DEFAULT_LANGUAGE="es")
    assert locked.get("/api/v1/server/language").json() == {"language": "es", "locked_by": "DEFAULT_LANGUAGE"}
    assert locked.put("/api/v1/server/language", json={"language": "en"}).status_code == 400


def test_every_language_has_a_copy_deck():
    from pathlib import Path

    from cryptex.config import LANGUAGES
    copy = Path(__file__).resolve().parents[2] / "web" / "src" / "copy"
    assert sorted(LANGUAGES) == sorted(p.stem for p in copy.glob("*.json"))


def test_audit_filters_and_csv(client):
    s = send(client)
    reveal(anon(client), s)
    items = client.get("/api/v1/server/audit").json()["items"]
    assert [i["type"] for i in items][:2] == ["secret.revealed", "secret.created"]
    assert items[1]["actor_username"] == OWNER["username"]
    only = client.get(f"/api/v1/server/audit?q={s.id}&type=secret.revealed").json()["items"]
    assert len(only) == 1 and only[0]["actor"] == "link"
    r = client.get("/api/v1/server/audit.csv")
    assert r.headers["content-type"].startswith("text/csv") and "secret.revealed" in r.text



def test_audit_events_are_logged_as_json(client, caplog):
    from cryptex.app import JsonFormatter
    caplog.set_level(logging.INFO, logger="cryptex.events")
    s = send(client)
    reveal(anon(client), s)
    lines = [json.loads(JsonFormatter().format(r)) for r in caplog.records if r.name == "cryptex.events"]
    assert [x["event"] for x in lines] == ["secret.created", "secret.revealed"]  # secret.sealed isn't audited
    assert lines[1]["secret_id"] == s.id and lines[1]["actor"] == "link" and lines[1]["detail"]["views_left"] == 0


# ------------------------------------------------------------------ backups without the sqlite3 CLI
def test_backup_command_copies_the_database_and_chunks_while_running(client, monkeypatch, tmp_path, capsys):
    import sqlite3
    s = send(client, files=[("a.txt", b"abc")])
    dest = tmp_path / "backup-1"
    assert cli(monkeypatch, "backup", str(dest)) == 0
    assert sorted(p.name for p in dest.iterdir()) == ["brand", "chunks", "cryptex.db", "enc.key"]  # audit N2: no -wal or -shm beside it
    assert (dest / "enc.key").read_bytes() == (state.env().data_dir / "enc.key").read_bytes()
    assert (dest / "enc.key").stat().st_mode & 0o777 == 0o600
    copy = sqlite3.connect(dest / "cryptex.db")
    assert copy.execute("SELECT count(*) FROM secrets WHERE id = ?", (s.id,)).fetchone()[0] == 1
    keys = [r[0] for r in copy.execute("SELECT blob_key FROM chunks")]
    assert keys and all((dest / "chunks" / k[:2] / k).is_file() for k in keys)
    assert (dest / "cryptex.db").stat().st_mode & 0o777 == 0o600
    assert cli(monkeypatch, "backup", str(dest)) == 1  # never overwrites
    assert cli(monkeypatch, "backup", str(state.env().data_dir / "inside")) == 1


def test_backup_finishes_when_chunks_are_deleted_while_it_copies(client, monkeypatch, tmp_path, capsys):
    """Audit P-B2: a chunk deleted mid-copy (cleanup purging a secret) made copytree raise: no "Backed up", a
    traceback, the 0600/0700 modes never applied, and a retry into the same folder refused."""
    import os
    import shutil
    import sqlite3
    gone, kept = send(client, files=[("a.txt", b"abc")]), send(client, files=[("b.txt", b"def")])
    data = state.env().data_dir
    for p in (data / "chunks").rglob("*"):
        p.chmod(0o755 if p.is_dir() else 0o644)  # as a restore may have left them
    doomed = {r["blob_key"] for r in db.all("SELECT blob_key FROM chunks WHERE secret_id = ?", gone.id)}
    real = shutil.copyfile

    def racing_copy(src, dst, **kw):  # cleanup purges `gone` between the folder listing and the copy
        if os.path.basename(src) in doomed:
            os.unlink(src)
        return real(src, dst, **kw)
    monkeypatch.setattr(shutil, "copyfile", racing_copy)
    old = os.umask(0o022)
    try:
        assert cli(monkeypatch, "backup", str(tmp_path / "b1")) == 0
    finally:
        os.umask(old)
    out = capsys.readouterr().out
    assert "Backed up to" in out and f"{len(doomed)} chunk(s) went while the copy ran" in out
    copy = sqlite3.connect(tmp_path / "b1" / "cryptex.db")
    for sid, present in ((kept.id, True), (gone.id, False)):
        keys = [r[0] for r in copy.execute("SELECT blob_key FROM chunks WHERE secret_id = ?", (sid,))]
        assert keys and all((tmp_path / "b1" / "chunks" / k[:2] / k).is_file() == present for k in keys)
    for p in [tmp_path / "b1", *(tmp_path / "b1").rglob("*")]:
        assert p.stat().st_mode & 0o777 == (0o700 if p.is_dir() else 0o600), (p, oct(p.stat().st_mode))


def test_a_backup_that_fails_part_way_leaves_nothing_behind(client, monkeypatch, tmp_path, capsys):
    import shutil
    import sqlite3
    send(client, files=[("a.txt", b"abc")])

    def disk_full(src, dst, **kw):
        raise OSError(28, "No space left on device")
    real = shutil.copyfile
    monkeypatch.setattr(shutil, "copyfile", disk_full)
    (tmp_path / "mounted").mkdir()  # a folder that was there before (a mounted /backups) stays
    for dest in (tmp_path / "new", tmp_path / "mounted"):
        assert cli(monkeypatch, "backup", str(dest)) == 1
        assert "No space left on device" in capsys.readouterr().err
    assert not (tmp_path / "new").exists() and list((tmp_path / "mounted").iterdir()) == []
    monkeypatch.setattr(shutil, "copyfile", real)

    def fails_reading_the_copy(out):  # SQLite left its side files, then the check failed
        for side in ("-wal", "-shm"):
            (out / f"cryptex.db{side}").write_bytes(b"x")
        raise sqlite3.OperationalError("disk I/O error")
    real_check = manage._missing_chunks
    monkeypatch.setattr(manage, "_missing_chunks", fails_reading_the_copy)
    assert cli(monkeypatch, "backup", str(tmp_path / "mounted")) == 1
    assert list((tmp_path / "mounted").iterdir()) == []
    monkeypatch.setattr(manage, "_missing_chunks", real_check)
    assert cli(monkeypatch, "backup", str(tmp_path / "mounted")) == 0  # the same folder again, once fixed


def test_cleanup_deletes_temporary_passwords_nobody_read_after_a_day(client, monkeypatch, capsys):
    import os as _os

    from cryptex import jobs
    monkeypatch.setattr(account, "derive_auth_key", lambda pw, salt, kdf: auth_key(pw, b64u(salt)))
    anon(client).post("/api/v1/auth/forgot", json={"username": OWNER["username"]})
    path = state.env().data_dir / "temp-passwords" / OWNER["username"]
    jobs.cleanup()
    assert path.exists()
    _os.utime(path, (0, now() - state.TEMP_TTL - 1))
    db.run("UPDATE users SET temp_expires_at = ?", now() - 1)
    jobs.cleanup()
    assert not path.exists() and db.val("SELECT temp_key_hash FROM users WHERE username = ?", OWNER["username"]) is None
