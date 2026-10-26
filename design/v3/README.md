# Cryptex 3.0 developer kit

The specification Cryptex 3 is built from: the crypto format, API contract, schema, behavior specs, copy deck, brand files and the static prototype the screens were designed in. The implementation lives in `api/`, `web/`, `cli/` and `e2e/` at the repository root; CI checks that it still matches this folder (crypto vectors, OpenAPI routes, copy keys).

| Path | What it is | Used by |
|---|---|---|
| `spec/crypto-v1.md` | Byte-level crypto format: keys, STREAM chunks, passphrase, requests | CX-10, CX-11, CX-50, CX-90 |
| `spec/reference.py` | Reference implementation; regenerates and verifies the vectors | CX-10 |
| `spec/vectors.json` | Test vectors every implementation must pass, including must-fail cases | CX-11, CX-50, CX-90 |
| `spec/openapi.yaml` | Full API: 50 paths, 60 operations, error model (validated with openapi-spec-validator) | CX-12, CX-50, CX-70–72; generate the TS client from it |
| `spec/schema.sql` | SQLite schema, migration 0001 (loads cleanly) | CX-13 |
| `spec/events.md` | Event catalog, SSE format, webhook signing, email triggers | CX-41, CX-60, CX-61, CX-72 |
| `spec/permissions.md` | Who can do what, and the rules to test | CX-12, CX-62, CX-70 |
| `spec/config.md` | Every environment variable, defaults, demo overrides | CX-13, CX-80, CX-92 |
| `spec/frontend.md` | Routes, source layout, IndexedDB, worker protocol, paste parser rules, keyboard, states, motion, budgets | CX-15–CX-41 |
| `spec/cli.md` | Commands, flags, output, exit codes | CX-90 |
| `spec/threat-model.md` | Assets, adversaries, mitigations, out of scope | Security review, tests |
| `spec/operations.md` | Deploy, jobs, retention, backups, observability | CX-92 |
| `copy/en.json` | Every UI string (290), keyed; covers every API error code | CX-15 onward |
| `copy/emails.md` | The five email templates | CX-60 |
| `brand/` | Mark, small mark, outlined wordmark and lockups (SVG), favicon, app icons, social image | CX-15 |
| `research/usability-test.md` | 5-person prototype test, tasks and decision rules | Before CX-20/30/51 |
| `legal/privacy-notice.md` | Draft privacy notice matching the product | Legal review before launch |
| `backlog.md` | 32 issues with dependencies and acceptance criteria | Planning |
| `proto/` | 36 static screens + `app.css` (the starting stylesheet, used as-is by `web/`) | Everything front end |

## Decisions changed during implementation

| Spec said | Built | Why |
|---|---|---|
| Create sends `meta_ct`, `reveal_hash`, `passcheck_hash` (and `prompt_ct`, `answer_token_hash` for requests) | They're sent with **seal** (`/requests/{id}/seal` added) | Every derived value is bound to the ID, and the server assigns the ID on create. |
| The last view deletes data when the last chunk is served | Deleted when the client confirms (`DELETE /secrets/{id}/read`), or 60 s after the last chunk | A dropped connection on the last chunk would otherwise lose the secret. |
| Meta plaintext `{title, from}` | `{title, from, fields, notes}` | So the sealed page can say “3 fields and 1 file” before reveal. |
| Lucide icons | The prototype's own icon set (`web/src/ui/icons.tsx`) | Pixel-identical to the approved screens; no dependency. |
| Authlib, aiosmtplib | joserfc (same author, the maintained JOSE library) and the standard library's smtplib on a worker thread | Authlib's JOSE module is deprecated; SMTP never blocks a request either way. |
| `size-limit` | `web/scripts/budget.mjs` over the Vite manifest | Measures each route's real chunk graph. |
| 2.4 migration, `LEGACY_API` | Removed | 3.0 is a new application with no upgrade path. |

Added beyond the spec: `cryptex answer` in the CLI, `cryptex owner reset` in the container, `PUT /me/password`, `/me/totp`, demo abuse reports, `GET /server/webhooks`.
