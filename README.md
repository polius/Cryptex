# Cryptex

Send and ask for secrets (passwords, API keys, `.env` files, files) through one-time links that are encrypted on your device. The server only ever stores ciphertext: it can't read what you send, its title, its file names or who it's from.

- **Send**: paste anything. Logins, `.env` files, connection strings and keys are read into fields. You get a link that opens once (or a few times) and expires.
- **Request**: ask someone for a secret. They fill in a simple form. Their answer is encrypted for a key that only your browser holds.
- **You'll know**: *Your links* shows when each link was opened, live. You can destroy one early.
- **Who can open it**: anyone with the link, only one email address (they confirm a 6-digit code), or only people at your organization (single sign-on). Add a passphrase for a second factor.
- **For teams**: single sign-on (OpenID Connect), owners and members, a Server tab with limits, branding, email and webhooks, API tokens and an audit log without contents.
- **CLI**: `cryptex send`, `request`, `open` and `status`, encrypting on your own computer.

## Run it

```yaml
services:
  cryptex:
    image: poliuscorp/cryptex:3
    restart: unless-stopped
    ports: ["8080:80"]
    volumes: ["./data:/data"]
    environment:
      PUBLIC_URL: https://vault.example.com
      ENC_KEY: ${CRYPTEX_ENC_KEY}        # openssl rand -base64 32; keep it in your secret manager
```

1. Put it behind HTTPS. Link keys live in the part of the URL after `#`, which is only private over TLS.
2. Open the address. The first screen asks for the **setup code** printed in the log (`docker logs cryptex`), then creates the owner account.
3. Optional: set `SMTP_URL` for email codes and "tell me when it's opened", and `OIDC_*` for single sign-on.

Every setting is listed in [design/v3/spec/config.md](design/v3/spec/config.md). An environment variable locks the matching setting in the Server tab. Operations (backups, jobs, retention, metrics) are in [design/v3/spec/operations.md](design/v3/spec/operations.md).

Locked out? `docker exec -it cryptex cryptex owner reset`.

### Public demo

`DEMO=true` turns an instance into a public demo: 1 hour, 1 view, 500 characters and 1 × 1 MB per link, a daily quota per IP (IPv6 by /64), proof of work instead of a CAPTCHA, circuit breakers, abuse reports, a banner on every page, `noindex`, no sign-in, and a nightly wipe. Run it on its own domain, never one used for real secrets.

## How it's secured

- The browser encrypts with AES-256-GCM in 5 MiB chunks (STREAM construction, so truncation, reordering and extension are detected). Keys come from a 128-bit link key through HKDF-SHA-256; passphrases go through Argon2id. Requests use ECDH P-256. The format is in [crypto-v1.md](design/v3/spec/crypto-v1.md), with a reference implementation and test vectors that the browser, the CLI and the test suite all verify.
- An ID alone authorizes nothing. Revealing, uploading, managing and answering each need their own capability token, and every wrong or missing token gets the same `404`. Wrong tokens count toward an hourly block per IP.
- Loading a link changes nothing. Revealing is a click, so link previews and scanners can't burn a secret. After the last view the data is deleted from disk.
- There is no admin bypass: owners can't read, reveal or destroy other people's items.
- A strict Content Security Policy, no third-party requests, and no tokens or contents in logs. The threat model is in [threat-model.md](design/v3/spec/threat-model.md).

A web page can only be as trustworthy as the server that serves its code. If you need protection even from the people running the server, use the CLI.

## CLI

```
$ cryptex login vault.example.com
$ cryptex send --title "Staging database" --ttl 1d < .env.staging
https://vault.example.com/s/k7Qp2vR9mL#08hLdXPyTgClYg1aikN6PA
$ cryptex request "AWS read-only keys" --field "Access key ID" --field "Secret access key"
$ cryptex open https://vault.example.com/s/k7Qp2vR9mL#08hLdXPyTgClYg1aikN6PA --as env
$ cryptex status --watch
```

Binaries for Linux, macOS and Windows are attached to each release. See [cli/README.md](cli/README.md).

## Development

| Part | Where | Run |
|---|---|---|
| API (FastAPI, SQLite) | `api/` | `cd api && python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest` |
| Web app (Preact, Vite) | `web/` | `cd web && npm ci && npm test && npm run dev` (proxies `/api` to `127.0.0.1:8000`) |
| CLI (Go) | `cli/` | `cd cli && go test ./...`; live: `CRYPTEX_IT=1 go test ./cmd/cryptex -run Integration` |
| End to end (Playwright) | `e2e/` | `docker compose -f e2e/compose.yml up -d --build --wait cryptex cryptex-demo mailpit && docker compose -f e2e/compose.yml run --rm playwright` |
| Design, specs, prototype | `design/v3/` | Screens, API contract, schema, crypto spec, copy deck |

Run the API locally with `DATA_DIR=./data SETUP_CODE=dev PUBLIC_URL=http://localhost:8000 STATIC_DIR=../web/dist .venv/bin/uvicorn cryptex.app:create_app --factory`.

CI runs everything above on every push: linting, the API suite (one test per permission rule and threat-model row), the crypto vectors in three languages, size budgets, the CLI against a live server, Playwright in two browser contexts with Mailpit and a demo instance, visual regression at desktop and mobile sizes in light and dark, and a multi-arch image build with a smoke test.

## License

MIT
