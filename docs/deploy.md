# Deploying Cryptex behind a proxy

Cryptex is one container that speaks plain HTTP on port 8080. Browsers only allow its encryption on `https://`
pages (and on `localhost`), so anywhere else it needs a proxy in front that terminates TLS. The README's Quick start
covers Caddy; this page is for any other proxy.

## What the proxy must do

| Requirement | Why |
|---|---|
| Serve Cryptex at the root of a host name (`https://secrets.example.com/`), not under a path | The app has no sub-path support. |
| Forward the visitor's address in `X-Forwarded-For` and the scheme in `X-Forwarded-Proto` | Rate limits count per address. |
| Be listed in `TRUSTED_PROXIES` | Cryptex believes `X-Forwarded-For` only from these addresses (default: loopback). Without the proxy listed, every visitor shares the proxy's address and its limits. |
| Accept request bodies of at least **6 MB** | Files upload in 5 MiB chunks. nginx allows 1 MB by default. |
| Pass the response headers through unchanged | The Content Security Policy lives in them. |

## nginx

```nginx
server {
    listen 443 ssl;
    server_name secrets.example.com;
    ssl_certificate     /etc/letsencrypt/live/secrets.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/secrets.example.com/privkey.pem;

    client_max_body_size 8m;          # chunks are 5 MiB

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

nginx on the host reaches the published `127.0.0.1:8080`, which Cryptex sees as the Docker bridge gateway: run
Cryptex with `-e TRUSTED_PROXIES=172.17.0.1` (check yours with `docker network inspect bridge`).
