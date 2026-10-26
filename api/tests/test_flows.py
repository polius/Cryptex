"""End-to-end API flows with real crypto (crypto-v1.md), as the browser and CLI do them."""
from conftest import anon, chunk_files
from helpers import answer, ask, open_meta, read_answer, reveal, send


def test_send_and_reveal_once(client):
    s = send(client, files=[("vpn.ovpn", b"client\ndev tun\n" * 100)], title="Staging database", sender="Sam")
    bob = anon(client)
    m = open_meta(bob, s)
    assert m["plain"] == {"title": "Staging database", "from": "Sam"}
    assert m["views_left"] == 1 and m["files"] == 1 and m["access"] == "link" and m["passphrase"] is False
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


def test_views_count_down(client):
    s = send(client, views=3)
    bob = anon(client)
    for left in (2, 1, 0):
        reveal(bob, s)
        if left:
            assert open_meta(bob, s)["views_left"] == left
    assert bob.get(f"/api/v1/secrets/{s.id}/meta", headers=s.reveal_headers()).status_code == 410


def test_request_answer_roundtrip(client):
    a = ask(client, files=True)
    vendor = anon(client)
    answer(vendor, a, {"Access key ID": "AKIA…", "Secret access key": "wJal…"}, files=[("key.pem", b"PEM")])
    manifest, files = read_answer(client, a)
    assert [i["v"] for i in manifest["items"] if i["t"] == "field"] == ["AKIA…", "wJal…"]
    assert files == [b"PEM"]
    r = client.get(f"/api/v1/receipts/{a.id}", headers=a.manage_headers())
    assert r.json()["status"] == "revealed"
    # one answer per request
    r = vendor.get(f"/api/v1/requests/{a.id}/prompt", headers=a.answer_headers())
    assert r.status_code == 410 and r.json()["error"]["reason"] == "answered"
