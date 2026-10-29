"""End-to-end API flows with real crypto (docs/crypto.md), as the browser does them."""
from conftest import SETUP, anon, chunk_files
from helpers import open_meta, reveal, send


def test_send_and_reveal_once(client):
    s = send(client, files=[("vpn.ovpn", b"client\ndev tun\n" * 100)], title="Staging database", sender="Sam")
    bob = anon(client)
    m = open_meta(bob, s)
    assert m["plain"] == {"title": "Staging database", "from": "Sam"}
    assert m["views_left"] == 1 and m["files"] == 1 and m["passphrase"] is False
    manifest, files = reveal(bob, s)
    assert manifest["items"][0]["v"] == "k7#Qp2-vR9mL"
    assert files == [b"client\ndev tun\n" * 100]
    # opened once: now 410 for the link holder, with the reason
    r = bob.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "opened"
    # data is gone from disk the moment every chunk was delivered (audit finding H1)
    assert chunk_files() == []


def test_multi_chunk_file(client):
    big = bytes(range(256)) * (11 * 1024 * 1024 // 256 + 7)  # 3 chunks
    s = send(client, files=[("big.bin", big)])
    _, files = reveal(anon(client), s)
    assert files[0] == big


def test_send_form_starts_with_one_time_off_demo_included(client, server):
    assert client.get("/api/v1/config").json()["defaults"]["views"] is None
    assert server(DEMO="true").get("/api/v1/config").json()["defaults"]["views"] is None


def test_links_without_one_time_open_until_they_expire(client):
    s = send(client, views=None)
    bob = anon(client)
    for _ in range(4):
        reveal(bob, s)
        assert open_meta(bob, s)["views_left"] is None
    r = client.post("/api/v1/receipts/lookup", json={"items": [{"id": s.id, "manage_token": s.manage_token}]}).json()["items"][0]
    assert r["status"] == "opened" and r["views"] == 4 and r["views_left"] is None
    from cryptex import db
    db.run("UPDATE secrets SET expires_at = 1 WHERE id = ?", s.id)
    assert bob.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers()).status_code == 410


def test_links_get_the_browsers_address_never_one_from_a_request(client):
    """Audit: the first unauthenticated GET /config once fixed the address used in invite links. The server now never
    puts an address in a link: it answers with a path, and the browser adds the address it's on."""
    assert "public_url" not in client.get("/api/v1/config", headers={"Host": "evil.example"}).json()["brand"]
    r = client.post("/api/v1/server/users", json={"username": "lisa"}, headers={"Host": "evil.example"})
    assert r.json()["invite_url"].startswith("/invite#")


def test_sign_in_cookies_are_secure_except_on_plain_http_localhost(server):
    """The web app runs only on https:// or localhost, so a proxy that doesn't send X-Forwarded-Proto can't make the
    session cookie lose Secure."""
    proxied = server(setup=False).post("/api/v1/setup", json=SETUP, headers={"Host": "vault.acme.com"})
    local = server(setup=False).post("/api/v1/setup", json=SETUP)  # http://localhost:8080
    assert proxied.status_code == local.status_code == 200
    assert all("; secure" in h.lower() for h in proxied.headers.get_list("set-cookie"))
    assert not any("; secure" in h.lower() for h in local.headers.get_list("set-cookie"))
