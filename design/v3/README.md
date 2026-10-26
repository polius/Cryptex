# Cryptex 3.0 developer kit

Everything needed to implement Cryptex 3.0, from the audit and redesign artifact. Copy this folder into the repository as `design/v3/` (or `spec/`), next to `proto/`.

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
| `../backlog.md` | 32 issues with dependencies and acceptance criteria | Planning |
| `../proto/` | 36 static screens + `app.css` (the starting stylesheet) | Everything front end |
