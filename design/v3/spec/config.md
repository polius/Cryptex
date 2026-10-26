# Configuration reference

All configuration is environment variables. A variable that is set **locks** the matching setting: the Server tab shows it read-only with the variable name. Sizes accept `500kb`, `10mb`, `1gb`; durations accept `30m`, `24h`, `7d`.

## Required in production

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | detected on first request | Public origin, e.g. `https://vault.acme.com`. Used in links, emails and OIDC redirects. Must be HTTPS except on `localhost`. |
| `ENC_KEY` | generated into `DATA_DIR/enc.key` on first boot, with a warning | 32 random bytes, base64. Encrypts TOTP secrets, allowed recipient emails and webhook secrets at rest. **Back it up separately from the data volume.** |
| `DATA_DIR` | `/data` | SQLite database and encrypted chunks. |

## Access and limits

| Variable | Default | Meaning |
|---|---|---|
| `ACCESS` | `anyone` | `anyone` or `signed_in`. Who can create secrets and requests. Opening and answering never need an account. |
| `MAX_EXPIRATION` | `7d` | Longest lifetime offered for a secret. |
| `MAX_VIEWS` | `10` | Most opens per secret. |
| `MAX_MESSAGE_LENGTH` | `10000` | Characters across notes and fields. |
| `BRAND_NAME` | unset | Organization name shown to recipients (otherwise set in setup). |
| `MAX_FILES` | `5` | Files per secret or answer. |
| `MAX_FILE_SIZE` | `100mb` | Per file. Hard ceiling 10 GB. |
| `REQUEST_MAX_EXPIRATION` | `30d` | Longest a request link stays open. |
| `REQUEST_MAX_KEEP` | `30d` | Longest a received answer is kept. |
| `AUDIT_RETENTION_DAYS` | `365` | Events older than this are deleted. |

## Rate limits

Counted per IPv4 address and per IPv6 /64, in the app (nginx keeps a coarse safety limit).

| Variable | Default | Applies to |
|---|---|---|
| `RATE_CREATE` | `60/h` | Create secret, create request, start answer |
| `RATE_REVEAL` | `120/h` | meta, reveal, verify, prompt |
| `RATE_AUTH` | `10/15m` | Password, TOTP, re-auth, email codes |
| `RATE_FAILED_TOKENS` | `30/h` | Any 404 caused by a wrong capability token; then a 1-hour block |
| `TRUSTED_PROXIES` | unset | CIDRs whose `X-Forwarded-For` is trusted. Unset: use the socket address. |

## Sign-in (OIDC)

| Variable | Example | Meaning |
|---|---|---|
| `OIDC_ISSUER` | `https://accounts.google.com` | Enables SSO. Discovery via `/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | | From the provider. Redirect URI: `{PUBLIC_URL}/api/v1/auth/oidc/callback`. |
| `OIDC_ALLOWED_DOMAINS` | `acme.example` | Comma list; checked against the `email` claim (and `hd` for Google). Also defines “people at {brand}” for org-only links. |
| `OIDC_NAME` | `Google Workspace` | Button label. |
| `OIDC_OWNER_EMAILS` | `sam@acme.example` | Optional: these people become owners on first sign-in. |

## Email and notifications

| Variable | Example | Meaning |
|---|---|---|
| `SMTP_URL` | `smtp+starttls://user:pass@smtp.example.com:587` | Enables email codes, open notices and answer notices. `smtps://` for implicit TLS. |
| `SMTP_FROM` | `Acme Secure share <no-reply@acme.example>` | Sender. |

## Operations

| Variable | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` never logs tokens or bodies either. |
| `LOG_FORMAT` | `json` | `json` or `text`. |
| `METRICS_TOKEN` | unset | Enables `/api/v1/metrics` for `Bearer {token}`. |
| `SETUP_CODE` | random, printed in the log on first boot | Needed to claim a fresh install (screen F1). |
| `LOG_IPS` | `false` | Add client IPs to request logs. |
| `STATIC_DIR` | unset | Serve the built front end from the API process (development and tests; the container uses nginx). |

## Demo (`DEMO=true`)

Forces: `ACCESS=anyone`, max lifetime `1h`, views `1`, message `500`, files `1 × 1mb`, request links `1h`, no sign-in, no SMTP, no webhooks, no API tokens, `noindex`, nightly wipe. Other limit variables are ignored. Tuning (values can only be stricter):

| Variable | Default |
|---|---|
| `DEMO_SEALS_PER_DAY` | `30` per IP or /64 |
| `DEMO_UPLOAD_BYTES_PER_DAY` | `10mb` |
| `DEMO_MAX_LIVE_ITEMS` | `2000` |
| `DEMO_STORAGE_CAP` | `1gb` |
| `DEMO_POW_BITS` | `18` |
| `DEMO_WIPE_CRON` | `0 0 * * *` |
