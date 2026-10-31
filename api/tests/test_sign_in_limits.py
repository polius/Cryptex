"""Sign-in limits reserved before the work (parallel requests can't slip under them), sessions that ended elsewhere,
requests carrying a link's token, the setup code check, and the audit trail of account changes."""
import concurrent.futures
from collections import Counter

import pyotp
import pytest
from conftest import OWNER, OWNER_SALT, OWNER_TOTP, anon, auth_key, creds, from_address, login_body, reauth, sign_in, totp_code
from helpers import open_meta, reveal, send
from test_integrations import lisa_joined, reset_accept

from cryptex import db
from cryptex.deps import Caller
from cryptex.errors import ApiError


def wrong_code() -> str:
    return "000000" if pyotp.TOTP(OWNER_TOTP).now() != "000000" else "111111"


def parallel(n, fn):
    with concurrent.futures.ThreadPoolExecutor(16) as pool:
        return list(pool.map(fn, range(n)))


# ------------------------------------------------------------------ failure limits, reserved atomically
def test_parallel_wrong_passwords_from_one_address_stop_at_rate_auth(server):
    """Audit: RATE_AUTH 10 let 22-30 parallel guesses through (checked before any of them was counted)."""
    c = server(RATE_AUTH="5/15m")
    b = anon(c)
    salt = b.post("/api/v1/auth/prelogin", json={"username": OWNER["username"]}).json()["salt"]
    codes = Counter(parallel(30, lambda i: b.post("/api/v1/auth/login", json={"username": OWNER["username"],
                                                                                  "auth_key": auth_key(f"guess {i}", salt)}).status_code))
    assert codes == {401: 5, 429: 25}


def test_parallel_wrong_2fa_codes_stop_at_the_accounts_limit(server):
    """Audit: a per-account limit of 10 let up to 19 codes be checked."""
    c = server(RATE_AUTH="1000/15m")
    tickets = []
    for _ in range(40):
        b = anon(c)
        tickets.append(b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).json()["mfa_ticket"])
    bad = wrong_code()
    codes = Counter(parallel(40, lambda i: anon(c).post("/api/v1/auth/login/totp", json={"mfa_ticket": tickets[i], "code": bad}).status_code))
    assert codes == {401: 30, 429: 10}


def test_a_wrong_2fa_code_at_reauth_costs_one_unit_not_two(client):
    """Audit N4: re-auth with the right password and a wrong code kept the password's unit too."""
    from cryptex import ratelimit
    from cryptex.routes.auth import SIGN_IN_FAILS

    def used() -> int:
        return ratelimit.used("sign_in", SIGN_IN_FAILS, f"user:{OWNER['username']}")[0]
    r = client.post("/api/v1/auth/reauth", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT), "code": wrong_code()})
    assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_code"
    assert used() == 1
    r = client.post("/api/v1/auth/reauth", json={"auth_key": auth_key("wrong", OWNER_SALT), "code": totp_code()})
    assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_password"
    assert used() == 2


def test_wrong_passwords_are_limited_per_account_whatever_the_address(server):
    """30 wrong passwords an hour per account, from anywhere (a spoofed or rotating address doesn't help); right ones
    don't count, and the limit is per name, known or not. Each guess comes from an address of its own, so the
    per-address RATE_AUTH (10) never comes into it (audit P-P8: these used to come from one address)."""
    c = server()
    lisa, _, _ = lisa_joined(c, totp=False)
    b = anon(c)
    for _ in range(35):  # successful password steps give their unit back
        assert b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).status_code == 200
    for i in range(30):
        g = from_address(c, f"198.18.0.{i + 1}")
        assert g.post("/api/v1/auth/login", json=login_body(g, OWNER["username"], "guess")).status_code == 401
    g = from_address(c, "198.18.1.1")  # an address that never guessed
    r = g.post("/api/v1/auth/login", json=login_body(g, OWNER["username"], OWNER["password"]))
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited" and int(r.headers["Retry-After"]) > 0
    r = c.post("/api/v1/auth/reauth", json={"auth_key": auth_key(OWNER["password"], OWNER_SALT), "code": totp_code()})
    assert r.status_code == 429  # re-auth, unlock and password change share it
    assert anon(c).post("/api/v1/auth/login", json=login_body(b, "lisa", "lisa's long passphrase")).status_code == 200  # others aren't
    for i in range(30):
        g = from_address(c, f"2001:db8:{i + 1}::1")
        assert g.post("/api/v1/auth/login", json=login_body(g, "nobody", "guess")).status_code == 401
    g = from_address(c, "2001:db8:ffff::1")
    assert g.post("/api/v1/auth/login", json=login_body(g, "nobody", "guess")).status_code == 429  # same answer: no tell


def test_dead_links_tickets_and_successes_are_not_guesses(server):
    """Audit: an expired 2FA ticket or an invite link opened again counted as a failed sign-in."""
    c = server(RATE_AUTH="2/15m")
    b = anon(c)
    for _ in range(4):
        assert b.post("/api/v1/auth/invite", json={"token": "A" * 43}).status_code == 410
        assert b.post("/api/v1/auth/reset", json={"token": "A" * 43}).status_code == 410
        r = b.post("/api/v1/auth/login/totp", json={"mfa_ticket": "A" * 43, "code": "123456"})
        assert r.status_code == 401 and r.json()["error"]["reason"] == "expired"
        sign_in(anon(c))
    for _ in range(2):
        assert b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], "typo")).status_code == 401
    assert b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).status_code == 429


def test_one_2fa_code_signs_in_once_even_when_two_requests_race(client):
    """The step is stored only if still newer than the stored one: a request that read the row before another
    stored the same step loses (coordinator note on totp_last_step)."""
    from cryptex.routes.auth import Attempt, check_totp
    code = totp_code()
    before = db.one("SELECT * FROM users WHERE username = ?", OWNER["username"])  # read by the slower request
    b = anon(client)
    t = b.post("/api/v1/auth/login", json=login_body(b, OWNER["username"], OWNER["password"])).json()["mfa_ticket"]
    assert b.post("/api/v1/auth/login/totp", json={"mfa_ticket": t, "code": code}).status_code == 200
    with pytest.raises(ApiError) as err, Attempt(Caller(ip="203.0.113.9")) as a:
        check_totp(a, before, code)
    assert err.value.code == "wrong_code"


# ------------------------------------------------------------------ a session that ended elsewhere (R3)
def test_a_browser_whose_session_ended_gets_401_ended_never_a_visitors_answer(client):
    """Audit: after a sign-out elsewhere, Create link quietly made an anonymous secret and Your links looked empty."""
    other = sign_in(anon(client))
    uid = other.get("/api/v1/auth/session").json()["user"]["id"]
    other.headers["X-Cryptex-User"] = uid
    assert other.get("/api/v1/me/receipts").status_code == 200
    client.put("/api/v1/me/password", json={"current_auth_key": auth_key(OWNER["password"], OWNER_SALT),
                                            "new": creds(OWNER["password"], OWNER_SALT)})  # signs out other devices
    n = db.val("SELECT count(*) FROM secrets")
    body = {"policy": {"views": 1, "expires_in": 3600}, "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]}
    for method, path in (("POST", "/api/v1/secrets"), ("GET", "/api/v1/me/receipts"), ("GET", "/api/v1/me/vault/items"),
                         ("POST", "/api/v1/auth/logout"), ("GET", "/api/v1/auth/session")):
        r = other.request(method, path, json=body if method == "POST" else None)
        assert r.status_code == 401 and r.json()["error"]["code"] == "sign_in_required" and r.json()["error"]["reason"] == "ended", path
    assert db.val("SELECT count(*) FROM secrets") == n  # nothing was created anonymously
    del other.headers["X-Cryptex-User"]
    assert other.get("/api/v1/auth/session").json()["user"] is None  # without the header: the usual visitor answers
    r = client.get("/api/v1/me/receipts", headers={"X-Cryptex-User": "someone-else"})  # a different account now
    assert r.status_code == 401 and r.json()["error"]["reason"] == "ended"
    assert client.get("/api/v1/me/receipts", headers={"X-Cryptex-User": uid}).status_code == 200


def test_a_tab_of_the_previous_account_hears_it_was_signed_out_even_on_unsafe_requests(client):
    """Audit P-P4: Sam signed out and Lisa signed in, in the same browser. Sam's open tab sends his CSRF token and
    X-Cryptex-User with Lisa's cookie: the CSRF check came first, so POSTs got 403 csrf, not 401 ended."""
    sam_id = client.get("/api/v1/auth/session").json()["user"]["id"]
    sam_csrf = client.headers["X-CSRF"]
    lisa, lisa_id, _ = lisa_joined(client, totp=False)
    tab = anon(client)
    tab.cookies.update(lisa.cookies)  # the browser's cookie is Lisa's now
    tab.headers.update({"X-CSRF": sam_csrf, "X-Cryptex-User": sam_id})  # what Sam's tab still holds
    body = {"policy": {"views": 1, "expires_in": 3600}, "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 40}]}
    n = db.val("SELECT count(*) FROM secrets")
    for method, path in (("POST", "/api/v1/secrets"), ("DELETE", "/api/v1/me/receipts/k7Qp2vR9mL"),
                         ("PUT", "/api/v1/me/vault/items/k7Qp2vR9mL"), ("POST", "/api/v1/auth/logout")):
        r = tab.request(method, path, json=body if path == "/api/v1/secrets" else None)
        assert r.status_code == 401 and r.json()["error"]["reason"] == "ended", (path, r.text)
    assert db.val("SELECT count(*) FROM secrets") == n
    tab.headers["X-Cryptex-User"] = lisa_id  # Lisa's own tab, with a stale CSRF token: the CSRF check still applies
    r = tab.post("/api/v1/auth/logout")
    assert r.status_code == 403 and r.json()["error"]["reason"] == "csrf"


def test_requests_with_a_links_token_ignore_the_session(client):
    """Audit: a tab opened before a sign-in elsewhere in the browser has the cookie but no CSRF token, and its
    reveal or destroy failed with 403 csrf. A link's token is judged alone: no session, CSRF or X-Cryptex-User."""
    s, d = send(anon(client)), send(anon(client))
    b = sign_in(anon(client))
    uid = b.get("/api/v1/auth/session").json()["user"]["id"]
    b.headers.pop("X-CSRF")
    b.headers["X-Cryptex-User"] = "a-session-that-ended"
    assert open_meta(b, s)["views_left"] == 1
    manifest, _ = reveal(b, s)
    assert manifest["items"]
    assert b.delete(f"/api/v1/secrets/{d.id}", headers=d.manage_headers()).status_code == 204
    actor = db.val("SELECT actor FROM events WHERE secret_id = ? AND type = 'secret.destroyed'", d.id)
    assert actor == "link"  # the session wasn't used for it either
    r = b.delete("/api/v1/me/receipts/k7Qp2vR9mL")
    assert r.status_code == 401 and r.json()["error"]["reason"] == "ended"  # without a link's token, the session's checks apply
    b.headers["X-Cryptex-User"] = uid
    r = b.delete("/api/v1/me/receipts/k7Qp2vR9mL")
    assert r.status_code == 403 and r.json()["error"]["reason"] == "csrf"


# ------------------------------------------------------------------ reset links: a typo in the new authenticator code (R9)
def test_a_typo_in_the_new_authenticator_code_costs_no_reset_try(client):
    _, uid, _ = lisa_joined(client, totp=False)
    link = client.post(f"/api/v1/server/users/{uid}/reset", json={}).json()
    token = link["reset_url"].split("#", 1)[1]
    secret = anon(client).post("/api/v1/auth/reset", json={"token": token}).json()["secret"]
    bad = "000000" if pyotp.TOTP(secret).now() != "000000" else "111111"
    for _ in range(6):  # more than the 5 tries a link has
        r = reset_accept(anon(client), link, totp_secret=secret, totp_code=bad)
        assert r.status_code == 400 and r.json()["error"] == {**r.json()["error"], "code": "invalid", "field": "totp_code"}
    assert anon(client).post("/api/v1/auth/reset", json={"token": token}).json()["tries_left"] == 5
    r = reset_accept(anon(client), link, code="AAAA-AAAA")
    assert r.json()["error"]["tries_left"] == 4  # a wrong reset code still costs one
    r = reset_accept(anon(client), link, totp_secret=secret, totp_code=pyotp.TOTP(secret).now())
    assert r.status_code == 200 and r.json()["user"]["totp"] is True


# ------------------------------------------------------------------ setup: the code first (R13)
def test_setup_checks_the_code_before_the_authenticator_step(server):
    c = server(setup=False, RATE_AUTH="2/15m")
    r = c.post("/api/v1/setup/check", json={"setup_code": "WRONG-CODE"})
    assert r.status_code == 400 and r.json()["error"]["field"] == "setup_code"
    for _ in range(3):
        assert c.post("/api/v1/setup/check", json={"setup_code": " test-code-0001 "}).status_code == 204  # not counted
    assert c.post("/api/v1/setup/check", json={"setup_code": "WRONG-CODE"}).status_code == 400
    assert c.post("/api/v1/setup/check", json={"setup_code": "TEST-CODE-0001"}).status_code == 429  # same limit as POST /setup
    assert db.val("SELECT count(*) FROM users") == 0  # it creates nothing


def test_setup_check_after_setup_is_a_409(client):
    r = anon(client).post("/api/v1/setup/check", json={"setup_code": "TEST-CODE-0001"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "setup_done"


# ------------------------------------------------------------------ 2FA enrolment needs re-auth (R15)
def test_starting_2fa_enrolment_needs_reauth(client):
    db.run("UPDATE sessions SET reauth_until = 0")
    r = client.post("/api/v1/me/totp")
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    reauth(client)
    assert set(client.post("/api/v1/me/totp").json()) == {"secret", "uri"}


# ------------------------------------------------------------------ audit events for account changes (R18)
def test_password_and_2fa_changes_are_audited(client):
    def last() -> str:
        return client.get("/api/v1/server/audit?type=user.*").json()["items"][0]["type"]
    db.run("DELETE FROM events")  # the fixture's own 2FA
    new = client.post("/api/v1/me/totp").json()["secret"]
    r = client.put("/api/v1/me/totp", json={"secret": new, "code": pyotp.TOTP(new).now()})
    assert r.status_code == 409 and r.json()["error"]["reason"] == "totp_on"  # a new app: off first, then on
    assert client.delete("/api/v1/me/totp").status_code == 204
    assert last() == "user.totp_off"
    again = client.post("/api/v1/me/totp").json()["secret"]
    assert client.put("/api/v1/me/totp", json={"secret": again, "code": pyotp.TOTP(again).now()}).status_code == 204
    assert last() == "user.totp_on"
    assert client.put("/api/v1/me/password", json={"current_auth_key": auth_key(OWNER["password"], OWNER_SALT),
                                                   "new": creds("a brand new passphrase")}).status_code == 204
    assert last() == "user.password_changed"
    rows = db.all("SELECT actor, actor_user_id, detail FROM events WHERE type IN "
                  "('user.totp_off','user.totp_on','user.password_changed')")
    assert len(rows) == 3 and {(r["actor"], r["detail"]) for r in rows} == {("user", "{}")} and all(r["actor_user_id"] for r in rows)


# ------------------------------------------------------------------ device keys go with the vault (W6)
DEVICE = "dev_0123456789abcdef"


def test_device_keys_go_when_the_password_is_reset(client, capsys):
    from cryptex import manage
    lisa, uid, _ = lisa_joined(client, totp=False)
    assert lisa.post("/api/v1/me/device-key", json={"device_id": DEVICE}).status_code == 200
    link = client.post(f"/api/v1/server/users/{uid}/reset", json={}).json()
    assert reset_accept(anon(client), link).status_code == 200
    assert db.val("SELECT count(*) FROM device_keys WHERE user_id = ?", uid) == 0

    assert client.post("/api/v1/me/device-key", json={"device_id": DEVICE}).status_code == 200
    assert manage.owner_reset(OWNER["username"]) == 0
    capsys.readouterr()
    assert db.val("SELECT count(*) FROM device_keys") == 0
