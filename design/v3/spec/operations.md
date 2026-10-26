# Operations

## Run it

```yaml
services:
  cryptex:
    image: poliuscorp/cryptex:3
    restart: unless-stopped
    ports: ["8080:80"]
    volumes: ["./data:/data"]
    environment:
      PUBLIC_URL: https://vault.acme.com
      ENC_KEY: ${CRYPTEX_ENC_KEY}        # openssl rand -base64 32, stored in your secret manager
      TRUSTED_PROXIES: 172.18.0.0/16
```

- Always behind HTTPS. Link keys live in URL fragments, which are safe only over TLS.
- One container runs nginx and the API under s6-overlay; if either keeps crashing, the container exits so the orchestrator restarts it.
- A reverse proxy in front must not buffer `/api/v1/receipts/events` (SSE) and must allow request bodies of at least 6 MB.

## Background jobs (in-process, tracked in the `jobs` table)

| Job | Every | Does |
|---|---|---|
| cleanup | 1 min | Purges expired secrets and requests, ended read sessions, unsealed uploads idle 30 min, expired sessions, codes and grants; writes tombstones |
| tombstones | 1 h | Deletes tombstones past `purge_after` |
| webhooks | 30 s | Delivers pending webhook events with retries |
| audit | daily | Deletes events older than `AUDIT_RETENTION_DAYS` |
| demo_wipe | `DEMO_WIPE_CRON` | Demo only: deletes everything except fixtures |

The Server overview turns red if cleanup hasn't run for 15 minutes.

## Retention

| Data | Kept |
|---|---|
| Secret ciphertext | Until the last view's read session ends, destroy, or expiry |
| Allowed recipient email (encrypted) | Same as the secret |
| Tombstones | 7 days after the secret or request is gone |
| Request answers | `keep_answer_s` after arrival |
| Events and audit | 365 days (configurable) |
| Sessions | 14 days sliding |
| Logs | Whatever your log driver keeps; logs hold no tokens, bodies or contents |

## Backups and restore

- Back up `DATA_DIR` with `sqlite3 cryptex.db ".backup backup.db"` plus the `chunks/` folder, while running.
- Back up `ENC_KEY` separately. Without it, restored TOTP secrets, recipient emails and webhook secrets are unreadable, but secrets themselves still work for link holders.
- Restoring an old backup can bring back secrets already opened since. Prefer short retention over restores for this data.

## Observability

- Logs: JSON lines with `ts, level, msg, route, status, ms, request_id`. No IP addresses unless `LOG_IPS=true`.
- `/api/v1/healthz` for liveness (checks the database).
- `/api/v1/metrics` (with `METRICS_TOKEN`): requests by route and status, active secrets, storage bytes, job last-run times, rate-limit hits, webhook failures.
