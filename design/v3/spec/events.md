# Events, live updates, webhooks and emails

One event table (`events` in schema.sql) feeds four consumers: the receipt page, live updates (SSE), webhooks and the audit log. **Events never contain content, titles, sender names, file names or IP addresses.**

## Catalog

| Type | When | Actor | `detail` | Receipt / SSE | Webhook | Audit | Email |
|---|---|---|---|---|---|---|---|
| `secret.created` | Create call accepted | user, token or link | `{views, expires_in, access, passphrase, files}` | yes | yes | yes | — |
| `secret.sealed` | All chunks stored | same as created | `{size}` | yes | — | — | — |
| `secret.revealed` | A view was counted | link | `{views_left, access_check: "none"\|"email"\|"org"}` | yes | yes | yes | Sender, if `notify` |
| `secret.passphrase_failed` | Wrong passcheck after a valid reveal token | link | `{tries_left}` | yes | yes | yes | — |
| `secret.code_sent` | Email code sent | link | `{}` | — | — | yes | Recipient (the code) |
| `secret.code_failed` | Wrong email code | link | `{tries_left}` | yes | — | yes | — |
| `secret.destroyed` | Destroy now, or too many tries | user/link/system | `{reason: "sender"\|"too_many_tries"}` | yes | yes | yes | Sender, if `too_many_tries` |
| `secret.expired` | Cleanup removed it unopened or partly opened | system | `{views_used}` | yes | yes | yes | — |
| `request.created` | Request created | user, token or link | `{expires_in, keep_answer_s, fields, files}` | yes | yes | yes | — |
| `request.answered` | Answer sealed | link | `{size}` | yes | yes | yes | Requester, if `notify` |
| `request.answer_read` | Requester downloaded the answer | user or link | `{}` | yes | — | yes | — |
| `request.cancelled` | Requester cancelled | user/link | `{}` | yes | yes | yes | — |
| `request.expired` | Link or kept answer expired | system | `{answered: bool}` | yes | yes | yes | — |
| `user.signed_in` | Session created | user | `{method: "oidc"\|"password"}` | — | — | yes | — |
| `user.sign_in_failed` | Wrong password or TOTP | system | `{method}` | — | — | yes | — |
| `user.role_changed` | Promote or demote | user | `{user_id, role}` | — | yes | yes | — |
| `token.created` / `token.revoked` | API token changes | user | `{token_id, scopes}` | — | yes | yes | — |
| `setting.changed` | Any Server setting saved | user | `{key, from, to}` | — | yes | yes | — |
| `setup.completed` | First-run setup finished | user | `{}` | — | — | yes | — |
| `webhook.failed` | A delivery gave up after all retries | system | `{webhook_id, status}` | — | — | yes | — |
| `demo.breaker_tripped` | Demo circuit breaker opened | system | `{rule}` | — | — | yes | — |

"Actor = link" is shown in the audit log as **Link holder**.

## Live updates (Server-Sent Events)

1. The client posts its receipts to `POST /receipts/subscribe` and gets a one-hour ticket (EventSource can't send headers).
2. `GET /receipts/events?ticket=…` streams:

```
retry: 5000

event: receipt
id: 18734
data: {"kind":"secret","id":"k7Qp2vR9mL","status":"opened","views_left":0,"event":{"type":"secret.revealed","at":"2026-10-27T14:03:11Z"}}

: keep-alive
```

- A comment line every 25 seconds keeps proxies from closing the stream.
- `Last-Event-ID` resumes from the next event ID.
- nginx needs `proxy_buffering off` and `X-Accel-Buffering: no` for this route.

## Webhooks

```
POST {your url}
Content-Type: application/json
Cryptex-Event: secret.revealed
Cryptex-Delivery: 9f2c…
Cryptex-Signature: t=1793034191,v1=hex(HMAC-SHA256(signing_secret, "1793034191." + raw_body))

{"id":18734,"type":"secret.revealed","at":"2026-10-27T14:03:11Z",
 "item":{"kind":"secret","id":"k7Qp2vR9mL"},"actor":"link","detail":{"views_left":0}}
```

- Success is any 2xx within 10 seconds.
- Retries after 1 min, 5 min, 30 min, 2 h and 12 h, then `webhook.failed`.
- Receivers should reject signatures older than 5 minutes.
- The signing secret is shown once on creation and stored encrypted with `ENC_KEY`.
- Slack incoming-webhook URLs get a Slack-formatted body automatically (`text` only, no IDs beyond the short link ID).

## Emails

Templates and wording are in `copy/emails.md`. Every email:

- names the operator (brand name) and the public address;
- never contains the secret, its title or a link that reveals anything;
- links only to the sender's receipt page, which needs the manage token held by their browser or account.
