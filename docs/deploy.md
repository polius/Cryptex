# Deploying Cryptex behind a proxy

Cryptex is one container that speaks plain HTTP on port 8080. Browsers only allow its encryption on `https://`
pages (and on `localhost`), so anywhere else it needs a proxy in front that terminates TLS. The README's Quick start
covers Caddy on a server with a public address; this page covers the rest.

## What the proxy must do

| Requirement | Why |
|---|---|
| Serve Cryptex at the root of a host name (`https://secrets.example.com/`), not under a path | The app has no sub-path support: its pages, assets and API are at `/`. |
| Forward the visitor's address in `X-Forwarded-For` and the scheme in `X-Forwarded-Proto` | Rate limits count per address; the scheme tells Cryptex to send `Strict-Transport-Security`. |
| Be listed, exactly, in `TRUSTED_PROXIES` | Cryptex believes `X-Forwarded-For` only from these addresses (default: loopback). Listing more lets anyone there claim any address. Without the proxy listed, every visitor shares the proxy's address and its limits. |
| Accept request bodies of at least **6 MB**, and give them a few minutes | Files upload in 5 MiB chunks. nginx allows 1 MB by default: uploads then fail with "That's larger than this server, or the proxy in front of it, accepts." |
| Pass `Content-Security-Policy` and the other headers through unchanged | The app's protection against injected scripts lives in them. |
| Compress (optional) | The image already holds Brotli and gzip copies of its files, and sends them when the browser asks. |

`TRUSTED_PROXIES` takes addresses or CIDRs, comma-separated. Find the proxy's address as Cryptex sees it: with the
proxy in the same compose file, give it a fixed address (as `deploy/docker-compose-ssl.yml` does); on the same
machine with a published port, it's the Docker bridge gateway (often `172.17.0.1`); on another machine, its address.

After any change, check: `docker logs cryptex` shows requests, sending a 10 MB file works, and two browsers on
different networks don't share a rate limit.

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name secrets.example.com;
    ssl_certificate     /etc/letsencrypt/live/secrets.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/secrets.example.com/privkey.pem;

    client_max_body_size 8m;          # chunks are 5 MiB
    client_body_timeout 300s;
    proxy_request_buffering off;      # stream uploads straight through
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

nginx on the host reaches the published `127.0.0.1:8080`, which Cryptex sees as the bridge gateway: run Cryptex with
`-e TRUSTED_PROXIES=172.17.0.1` (check yours with `docker network inspect bridge`), or run nginx in the same compose
file with a fixed address.

## Traefik

```yaml
services:
  traefik:
    image: traefik:v3
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.le.acme.tlschallenge=true
      - --certificatesresolvers.le.acme.email=you@example.com
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
    ports: ["443:443"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks: { default: { ipv4_address: 10.213.48.2 } }

  cryptex:
    image: poliuscorp/cryptex:3
    restart: unless-stopped
    environment: { TRUSTED_PROXIES: 10.213.48.2 }
    volumes: ["./data:/data"]
    labels:
      - traefik.enable=true
      - traefik.http.routers.cryptex.rule=Host(`secrets.example.com`)
      - traefik.http.routers.cryptex.entrypoints=websecure
      - traefik.http.routers.cryptex.tls.certresolver=le
      - traefik.http.services.cryptex.loadbalancer.server.port=8080

networks:
  default:
    ipam: { config: [{ subnet: 10.213.48.0/24 }] }
```

Traefik doesn't limit request bodies by default, and sends `X-Forwarded-For` and `X-Forwarded-Proto` itself.

## Caddy on a private network (internal certificate)

For a server only your network reaches (no public DNS, so no Let's Encrypt), Caddy can be its own certificate
authority. Use `deploy/docker-compose-ssl.yml` with this `Caddyfile`:

```
secrets.lan {
	tls internal
	encode zstd gzip
	reverse_proxy cryptex:8080
}
```

Each device must trust Caddy's root certificate once: copy it out with
`docker cp cryptex-caddy:/data/caddy/pki/authorities/local/root.crt .` and install it as a trusted root (or use your
organization's own CA with `tls cert.pem key.pem`).

## Cloudflare Tunnel

No open ports: `cloudflared` connects out to Cloudflare, which serves HTTPS on your domain.

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment: { TUNNEL_TOKEN: "<token from the Cloudflare dashboard>" }
    networks: { default: { ipv4_address: 10.213.49.2 } }

  cryptex:
    image: poliuscorp/cryptex:3
    restart: unless-stopped
    environment: { TRUSTED_PROXIES: 10.213.49.2 }
    volumes: ["./data:/data"]

networks:
  default:
    ipam: { config: [{ subnet: 10.213.49.0/24 }] }
```

In the tunnel's public hostname, set the service to `http://cryptex:8080`. Cloudflare's free plan accepts request
bodies up to 100 MB, enough for 5 MiB chunks. Cloudflare sends the visitor's address in `X-Forwarded-For`.

## Tailscale Serve

For people on your tailnet only:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

The server is then at `https://<machine>.<tailnet>.ts.net`, with a certificate Tailscale manages. `tailscale serve`
runs on the host and reaches Cryptex through the published port, so set `TRUSTED_PROXIES` to the Docker bridge
gateway as for nginx above.

## Kubernetes

One replica (the database is SQLite on the volume), a `PersistentVolumeClaim` mounted at `/data`, and an Ingress
that meets the requirements above (with ingress-nginx, the annotation `nginx.ingress.kubernetes.io/proxy-body-size: 8m`).
Set `TRUSTED_PROXIES` to the ingress controller's pod network, and use a `Recreate` deployment strategy so two
servers never open the database at once.
