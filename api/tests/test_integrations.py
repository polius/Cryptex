"""Email, webhooks, OIDC, 2FA, live updates, branding and audit, against real local services."""
import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import httpx
import pyotp
import pytest
from aiosmtpd.controller import Controller
from conftest import OWNER, anon
from helpers import answer, ask, open_meta, reveal, send
from joserfc import jwt
from joserfc.jwk import RSAKey

from cryptex import db, mailer, webhooks
from cryptex.routes import auth as auth_routes
from cryptex.routes import receipts as receipts_routes
from cryptex.util import now


# ------------------------------------------------------------------ SMTP
class Inbox:
    def __init__(self):
        self.messages = []

    async def handle_DATA(self, server, session, envelope):  # noqa: N802
        self.messages.append(envelope)
        return "250 OK"


@pytest.fixture
def smtp():
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    inbox = Inbox()
    ctl = Controller(inbox, hostname="127.0.0.1", port=port)
    ctl.start()
    inbox.port = port
    yield inbox
    ctl.stop()


def wait_mail(inbox, n=1):
    mailer.flush()
    end = time.time() + 5
    while len(inbox.messages) < n and time.time() < end:
        time.sleep(0.05)
    return inbox.messages


def test_email_only_link_with_code(server, smtp):
    c = server(SMTP_URL=f"smtp://127.0.0.1:{smtp.port}", SMTP_FROM="Acme <no-reply@acme.example>")
    s = send(c, access="email", email="lisa@globex.example")
    bob = anon(c)
    m = open_meta(bob, s)
    assert m["access"] == "email" and m["email_hint"] == "l•••@globex.example"
    r = bob.post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers())
    assert r.status_code == 403 and r.json()["error"]["code"] == "code_required"
    assert bob.post(f"/api/v1/secrets/{s.id}/verify/start", headers=s.reveal_headers()).status_code == 204
    msgs = wait_mail(smtp)
    assert msgs[-1].rcpt_tos == ["lisa@globex.example"]
    body = msgs[-1].content.decode()
    code = body.split("Subject: ")[1][:6]
    assert code.isdigit() and "Staging database" not in body and s.fragment not in body
    r = bob.post(f"/api/v1/secrets/{s.id}/verify", json={"code": "000000" if code != "000000" else "111111"}, headers=s.reveal_headers())
    assert r.status_code == 403 and r.json()["error"]["tries_left"] == 4
    grant = bob.post(f"/api/v1/secrets/{s.id}/verify", json={"code": code}, headers=s.reveal_headers()).json()["grant"]
    manifest, _ = reveal(bob, s, grant=grant)
    assert manifest["items"]
    # the encrypted address is deleted with the secret
    assert db.val("SELECT count(*) FROM secrets") == 0


def test_five_wrong_codes_destroy(server, smtp):
    c = server(SMTP_URL=f"smtp://127.0.0.1:{smtp.port}")
    s = send(c, access="email", email="lisa@globex.example")
    bob = anon(c)
    bob.post(f"/api/v1/secrets/{s.id}/verify/start", headers=s.reveal_headers())
    code = wait_mail(smtp)[-1].content.decode().split("Subject: ")[1][:6]
    wrong = "123456" if code != "123456" else "654321"
    for _ in range(4):
        bob.post(f"/api/v1/secrets/{s.id}/verify", json={"code": wrong}, headers=s.reveal_headers())
    r = bob.post(f"/api/v1/secrets/{s.id}/verify", json={"code": wrong}, headers=s.reveal_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "too_many_tries"


def test_email_only_needs_smtp(client):
    r = client.post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600, "access": "email", "email": "a@b.example"},
                                             "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 20}]})
    assert r.status_code == 400 and r.json()["error"]["field"] == "policy.access"


def test_open_and_answer_notifications(server, smtp):
    c = server(SMTP_URL=f"smtp://127.0.0.1:{smtp.port}")
    s = send(c, notify=True)
    reveal(anon(c), s)
    msg = wait_mail(smtp)[-1]
    assert msg.rcpt_tos == [OWNER["email"]]
    text = msg.content.decode()
    assert "was opened" in text and f"/r/{s.id}" in text and "Staging database" not in text
    a = ask(c, notify=True)
    answer(anon(c), a, {"Access key ID": "x", "Secret access key": "y"})
    assert "answered" in wait_mail(smtp, 2)[-1].content.decode()


def test_test_email(server, smtp):
    c = server(SMTP_URL=f"smtp://127.0.0.1:{smtp.port}")
    assert c.post("/api/v1/server/notifications/test-email", json={}).status_code == 204
    assert "Email is working" in wait_mail(smtp)[-1].content.decode()


# ------------------------------------------------------------------ webhooks
class Receiver(BaseHTTPRequestHandler):
    got: list = []
    status = 200

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        Receiver.got.append((dict(self.headers), body))
        self.send_response(Receiver.status)
        self.end_headers()

    def log_message(self, *a):
        pass


@pytest.fixture
def receiver():
    Receiver.got, Receiver.status = [], 200
    srv = HTTPServer(("127.0.0.1", 0), Receiver)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/hook"
    srv.shutdown()


def test_webhook_signed_delivery(client, receiver):
    r = client.post("/api/v1/server/webhooks", json={"url": receiver, "events": ["secret.revealed"]})
    assert r.status_code == 201
    secret = r.json()["signing_secret"]
    s = send(client)
    reveal(anon(client), s)
    assert webhooks.run() == 1
    headers, body = Receiver.got[-1]
    assert headers["Cryptex-Event"] == "secret.revealed"
    ts, sig = headers["Cryptex-Signature"].split(",")
    t = ts.split("=")[1]
    assert sig == "v1=" + hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    p = json.loads(body)
    assert p["item"] == {"kind": "secret", "id": s.id} and p["actor"] == "link" and p["detail"]["views_left"] == 0
    hooks = client.get("/api/v1/server/notifications").json()["webhooks"]
    assert hooks[0]["last_status"] == 200


def test_webhook_retries_then_gives_up(client, receiver):
    Receiver.status = 500
    client.post("/api/v1/server/webhooks", json={"url": receiver})
    send(client)
    for _ in range(6):
        db.run("UPDATE webhook_deliveries SET next_attempt_at = 0")
        webhooks.run()
    assert db.val("SELECT count(*) FROM events WHERE type = 'webhook.failed'") >= 1


def test_webhook_needs_https(client):
    assert client.post("/api/v1/server/webhooks", json={"url": "http://hooks.example.com/x"}).status_code == 400


def test_slack_gets_text_only():
    seen = {}

    def handler(req):
        seen["body"] = json.loads(req.content)
        return httpx.Response(200)
    hook = {"url": "https://hooks.slack.com/services/T/B/x", "secret_ct": None}
    ev = {"id": 1, "type": "secret.revealed", "at": now(), "secret_id": "k7Qp2vR9mL", "request_id": None, "actor": "link", "detail": "{}"}
    orig = webhooks.security.unseal
    webhooks.security.unseal = lambda *_: b"whsec_x"
    try:
        ok, _, _ = webhooks.deliver_one(hook, ev, httpx.Client(transport=httpx.MockTransport(handler)))
    finally:
        webhooks.security.unseal = orig
    assert ok and seen["body"] == {"text": "A link was opened (k7Qp…)"}


# ------------------------------------------------------------------ OIDC
@pytest.fixture
def idp():
    key = RSAKey.generate_key(2048, parameters={"kid": "k1"})
    issuer = "https://idp.example"
    state = {"claims": {}}

    def handler(req):
        if req.url.path == "/.well-known/openid-configuration":
            return httpx.Response(200, json={"issuer": issuer, "authorization_endpoint": f"{issuer}/authorize",
                                             "token_endpoint": f"{issuer}/token", "jwks_uri": f"{issuer}/jwks"})
        if req.url.path == "/jwks":
            return httpx.Response(200, json={"keys": [key.as_dict(private=False)]})
        if req.url.path == "/token":
            form = parse_qs(req.content.decode())
            assert form["code_verifier"][0]
            claims = {"iss": issuer, "aud": "client-1", "exp": now() + 300, "iat": now(), **state["claims"]}
            return httpx.Response(200, json={"id_token": jwt.encode({"alg": "RS256", "kid": "k1"}, claims, key)})
        return httpx.Response(404)
    auth_routes.http_client = httpx.Client(transport=httpx.MockTransport(handler))
    auth_routes._discovery.clear()
    auth_routes._jwks.clear()
    yield state
    auth_routes.http_client = None


def oidc_env(**extra):
    return {"OIDC_ISSUER": "https://idp.example", "OIDC_CLIENT_ID": "client-1", "OIDC_CLIENT_SECRET": "s",
            "OIDC_ALLOWED_DOMAINS": "acme.example", "OIDC_NAME": "Acme SSO", **extra}


def sso_sign_in(c, idp, email, sub="u1", return_to="/links"):
    r = c.get(f"/api/v1/auth/oidc/start?return_to={return_to}", follow_redirects=False)
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["code_challenge_method"] == ["S256"] and q["redirect_uri"] == ["http://localhost:8080/api/v1/auth/oidc/callback"]
    idp["claims"] = {"sub": sub, "email": email, "email_verified": True, "nonce": q["nonce"][0], "name": "Lisa"}
    return c.get(f"/api/v1/auth/oidc/callback?code=abc&state={q['state'][0]}", follow_redirects=False)


def test_oidc_sign_in_creates_a_member(server, idp):
    c = server(**oidc_env())
    bob = anon(c)
    r = sso_sign_in(bob, idp, "lisa@acme.example")
    assert r.status_code == 302 and r.headers["location"] == "/links"
    me = bob.get("/api/v1/auth/session").json()
    assert me["user"]["email"] == "lisa@acme.example" and me["user"]["role"] == "member"
    assert bob.get("/api/v1/server/overview").status_code == 404


def test_oidc_rejects_other_domains_and_bad_nonce(server, idp):
    c = server(**oidc_env())
    r = sso_sign_in(anon(c), idp, "eve@evil.example")
    assert r.headers["location"] == "/signin?error=domain"
    bob = anon(c)
    r = bob.get("/api/v1/auth/oidc/start", follow_redirects=False)
    q = parse_qs(urlparse(r.headers["location"]).query)
    idp["claims"] = {"sub": "x", "email": "a@acme.example", "nonce": "wrong"}
    r = bob.get(f"/api/v1/auth/oidc/callback?code=abc&state={q['state'][0]}", follow_redirects=False)
    assert r.headers["location"] == "/signin?error=provider"
    # replaying the state fails
    r = bob.get(f"/api/v1/auth/oidc/callback?code=abc&state={q['state'][0]}", follow_redirects=False)
    assert r.headers["location"] == "/signin?error=expired"


def test_oidc_owner_emails_and_org_only_links(server, idp):
    c = server(**oidc_env(OIDC_OWNER_EMAILS="dana@acme.example"))
    dana = anon(c)
    sso_sign_in(dana, idp, "dana@acme.example", sub="d1")
    assert dana.get("/api/v1/auth/session").json()["user"]["role"] == "owner"
    csrf = dana.get("/api/v1/auth/session").json()["csrf"]
    dana.headers["X-CSRF"] = csrf
    s = send(dana, access="org")
    # a visitor needs to sign in; someone from the org can open it
    visitor = anon(c)
    assert open_meta(visitor, s)["org_name"] == "Acme"
    r = visitor.post(f"/api/v1/secrets/{s.id}/reveal", headers=s.reveal_headers())
    assert r.status_code == 401 and r.json()["error"]["code"] == "sign_in_required"
    lisa = anon(c)
    sso_sign_in(lisa, idp, "lisa@acme.example", sub="l1")
    lisa.headers["X-CSRF"] = lisa.get("/api/v1/auth/session").json()["csrf"]
    manifest, _ = reveal(lisa, s)
    assert manifest["items"]


def test_org_only_needs_a_signed_in_sender_with_sso(server, idp):
    c = server(**oidc_env())
    r = anon(c).post("/api/v1/secrets", json={"policy": {"views": 1, "expires_in": 3600, "access": "org"},
                                              "streams": [{"stream": 0, "prefix": "AAAAAAAAAA", "chunks": 1, "size": 20}]})
    assert r.status_code == 400


# ------------------------------------------------------------------ owner 2FA
def test_password_owner_with_totp(client):
    secret = client.post("/api/v1/me/totp").json()["secret"]
    assert client.put("/api/v1/me/totp", json={"secret": secret, "code": pyotp.TOTP(secret).now()}).status_code == 204
    bob = anon(client)
    r = bob.post("/api/v1/auth/login", json={"email": OWNER["email"], "password": OWNER["password"]})
    ticket = r.json()["mfa_ticket"]
    assert ticket and "cx_session" not in r.cookies
    # the code used to enable is a replay now; wait for the next step only if needed
    code = pyotp.TOTP(secret).at(time.time() + 30)
    r = bob.post("/api/v1/auth/login/totp", json={"mfa_ticket": ticket, "code": code})
    assert r.status_code == 200 and bob.get("/api/v1/auth/session").json()["user"]["mfa"] is True
    # replaying the same code fails (another browser, so no session cookie)
    eve = anon(client)
    r = eve.post("/api/v1/auth/login", json={"email": OWNER["email"], "password": OWNER["password"]})
    r = eve.post("/api/v1/auth/login/totp", json={"mfa_ticket": r.json()["mfa_ticket"], "code": code})
    assert r.status_code == 401


def test_logout(client):
    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get("/api/v1/auth/session").json()["user"] is None


# ------------------------------------------------------------------ live updates
def test_subscribe_ticket_and_events(client):
    s = send(client)
    other = send(client)
    bob = anon(client)
    t = bob.post("/api/v1/receipts/subscribe", json={"items": [{"id": s.id, "manage_token": s.manage_token},
                                                               {"id": other.id, "manage_token": "wrong"}]}).json()["ticket"]
    secrets, requests = receipts_routes._ticket(t)
    assert secrets == [s.id] and requests == []
    start = db.val("SELECT max(id) FROM events")
    reveal(anon(client), s)
    reveal(anon(client), other)
    evs = receipts_routes._new_events(secrets, requests, start)
    assert [(e["data"]["id"], e["data"]["status"]) for e in evs] == [(s.id, "opened")]
    assert bob.get("/api/v1/receipts/events?ticket=nope").status_code == 404


def test_receipts_lookup_omits_wrong_pairs(client):
    s = send(client)
    a = ask(client)
    r = anon(client).post("/api/v1/receipts/lookup", json={"items": [
        {"id": s.id, "manage_token": s.manage_token}, {"id": a.id, "manage_token": a.manage_token},
        {"id": s.id, "manage_token": a.manage_token}]}).json()
    assert sorted((i["id"], i["kind"]) for i in r["items"]) == sorted([(s.id, "secret"), (a.id, "request")])


def test_attach_receipt_to_account(client):
    s = send(anon(client))
    assert client.post("/api/v1/me/receipts", json={"id": s.id, "manage_token": "bad", "kind": "secret"}).status_code == 404
    assert client.post("/api/v1/me/receipts", json={"id": s.id, "manage_token": s.manage_token, "kind": "secret"}).status_code == 204
    assert s.id in [i["id"] for i in client.get("/api/v1/me/receipts").json()["items"]]


# ------------------------------------------------------------------ server tab
def test_overview(client):
    send(client)
    o = client.get("/api/v1/server/overview").json()
    assert o["live"]["secrets"] == 1 and o["week"]["created"] == 1 and o["week"]["senders"] == 1
    assert {a["code"] for a in o["attention"]} >= {"smtp", "2fa"}
    assert o["recent"][0]["type"] == "secret.created"


def test_branding_and_logo_sanitizing(client):
    assert client.put("/api/v1/server/branding", json={"name": "Globex"}).status_code == 204
    assert client.get("/api/v1/config").json()["brand"]["name"] == "Globex"
    evil = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10" onclick="x()"/><foreignObject/></svg>'
    r = client.put("/api/v1/server/branding/logo", content=evil, headers={"Content-Type": "image/svg+xml"})
    assert r.status_code == 204
    url = client.get("/api/v1/config").json()["brand"]["logo_url"]
    logo = anon(client).get(url)
    assert logo.status_code == 200 and b"script" not in logo.content and b"onload" not in logo.content and b"onclick" not in logo.content
    assert b"<rect" in logo.content and "sandbox" in logo.headers["content-security-policy"]
    r = client.put("/api/v1/server/branding/logo", content=b"<!DOCTYPE x><svg/>", headers={"Content-Type": "image/svg+xml"})
    assert r.status_code == 400
    assert client.delete("/api/v1/server/branding/logo").status_code == 204
    assert client.get("/api/v1/config").json()["brand"]["logo_url"] is None


def test_audit_filters_and_csv(client):
    s = send(client)
    reveal(anon(client), s)
    items = client.get("/api/v1/server/audit").json()["items"]
    assert [i["type"] for i in items][:2] == ["secret.revealed", "secret.created"]
    assert items[1]["actor_email"] == OWNER["email"]
    only = client.get(f"/api/v1/server/audit?q={s.id}&type=secret.revealed").json()["items"]
    assert len(only) == 1 and only[0]["actor"] == "link"
    r = client.get("/api/v1/server/audit.csv")
    assert r.headers["content-type"].startswith("text/csv") and "secret.revealed" in r.text


def test_tokens_shown_once_and_listed_for_owners(client):
    r = client.post("/api/v1/me/tokens", json={"name": "CI deploys", "scopes": ["send"]}).json()
    assert r["token"].startswith("cx_live_") and r["hint"].endswith(r["token"][-4:])
    listed = client.get("/api/v1/server/tokens").json()["items"]
    assert listed[0]["name"] == "CI deploys" and "token" not in listed[0]
