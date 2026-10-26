# Cryptex 3.0 backlog

Generated from the audit and redesign artifact. Sizes: S < 1 day, M a few days, L about a week.


## Hotfix

### CX-01 · Remove false encryption claims

- **Done when:** Footer and tooltip no longer claim browser encryption.
- **Depends on:** —
- **Screens:** —
- **Size:** S

### CX-02 · Upload token, seal lock, random file names

- **Done when:** Uploads without the creation token return 404; files are stored by random name.
- **Depends on:** —
- **Screens:** —
- **Size:** M

### CX-03 · Delete on reveal for self-destruct

- **Done when:** After the first open, the text and files are gone from disk.
- **Depends on:** —
- **Screens:** —
- **Size:** S

### CX-04 · Rate-limit every credential check

- **Done when:** Login, destroy and download return 429 after the limit; open and create use separate zones.
- **Depends on:** —
- **Screens:** —
- **Size:** S

### CX-05 · Validate settings; force first-run password change

- **Done when:** Invalid limits are rejected with a message; default password can’t be used.
- **Depends on:** —
- **Screens:** —
- **Size:** S

### CX-06 · Release 2.4.1 and security advisory

- **Done when:** Tagged release, advisory published, README updated.
- **Depends on:** CX-01…05
- **Screens:** —
- **Size:** S


## Core

### CX-10 · Crypto review and ports of reference.py

- **Done when:** crypto-v1.md reviewed by a second engineer; reference.py ported to TypeScript and Go; both pass `vectors.json`.
- **Depends on:** —
- **Screens:** —
- **Size:** M

### CX-11 · Browser crypto module in a Web Worker

- **Done when:** Passes all vectors; 100 MB encrypts without freezing the page.
- **Depends on:** CX-10
- **Screens:** —
- **Size:** L

### CX-12 · API v1: secrets, chunks, seal, meta, reveal, destroy, tombstones

- **Done when:** Implements `openapi.yaml` (Secrets, Receipts); every row of permissions.md has a test.
- **Depends on:** CX-10, CX-13
- **Screens:** —
- **Size:** L

### CX-13 · SQLite schema, migrations, legacy reader

- **Done when:** Applies `schema.sql`; a 2.4 database upgrades to the same schema; config.md variables load.
- **Depends on:** —
- **Screens:** —
- **Size:** M

### CX-14 · Rate limiting service (IP, IPv6 /64, per target)

- **Done when:** Limits from config; Retry-After on 429.
- **Depends on:** CX-13
- **Screens:** —
- **Size:** M


## Front end

### CX-15 · Front-end foundation: Vite, Preact, app.css, fonts, icons, theme, copy, brand

- **Done when:** Follows frontend.md §1–2; strings from `en.json`; favicon and icons from `brand/`; component sheet matches the prototype.
- **Depends on:** —
- **Screens:** H1, B4
- **Size:** M

### CX-16 · Component library from the sheet

- **Done when:** Each component has a story or test page in both themes.
- **Depends on:** CX-15
- **Screens:** H1
- **Size:** M


## Send

### CX-20 · Composer and paste parser

- **Done when:** Parser passes every row of frontend.md §5; Undo restores the paste.
- **Depends on:** CX-11, CX-16
- **Screens:** A1–A3
- **Size:** L

### CX-21 · Encrypt and upload: progress, resume, cancel, failure

- **Done when:** A dropped connection resumes; cancel removes uploaded chunks.
- **Depends on:** CX-12, CX-20
- **Screens:** A4, A8
- **Size:** M

### CX-22 · Link ready, destroy and QR dialogs

- **Done when:** Link copied on create; address bar stays on /; destroy confirmed.
- **Depends on:** CX-21
- **Screens:** A5–A7
- **Size:** M


## Recipient

### CX-30 · Reveal: sealed, passphrase, revealed, auto-clear

- **Done when:** Loading changes nothing; 5 wrong passphrases destroy; page clears after 5 idle minutes.
- **Depends on:** CX-11, CX-12
- **Screens:** D1, D3, D4
- **Size:** L

### CX-31 · Gone, cut-off link, 404 and 500

- **Done when:** Truncated key detected without a server call.
- **Depends on:** CX-30
- **Screens:** D5–D7
- **Size:** S


## Your links

### CX-40 · Receipts store and Your links

- **Done when:** Receipts survive reload; empty state; account menu with theme.
- **Depends on:** CX-12, CX-16
- **Screens:** B1, B3, B4
- **Size:** M

### CX-41 · Receipt page and live updates (SSE)

- **Done when:** Event stream as in events.md; opening a link in another browser updates the receipt within 2 s.
- **Depends on:** CX-40
- **Screens:** B2
- **Size:** M


## Requests

### CX-50 · Requests API and key pairs

- **Done when:** Answer readable only with the requester’s private key; fingerprint checked.
- **Depends on:** CX-10, CX-12
- **Screens:** —
- **Size:** L

### CX-51 · Request screens

- **Done when:** Full request → answer → reveal flow passes end to end.
- **Depends on:** CX-50, CX-20
- **Screens:** C1–C4
- **Size:** L


## Access

### CX-60 · SMTP, email-only links, open notifications

- **Done when:** Emails match copy/emails.md; codes expire in 10 minutes, 5 tries; address stored encrypted and deleted with the secret.
- **Depends on:** CX-12
- **Screens:** D2, E5
- **Size:** M

### CX-61 · Webhooks

- **Done when:** Signature, retries and payloads as in events.md; delivery status visible.
- **Depends on:** CX-60
- **Screens:** E5
- **Size:** S

### CX-62 · OIDC sign-in and org-only links

- **Done when:** Google and Entra ID tested; org-only links require a matching domain.
- **Depends on:** CX-13
- **Screens:** F2, E2
- **Size:** L


## Server

### CX-70 · First-run setup and owners

- **Done when:** Nothing can be created until an owner exists.
- **Depends on:** CX-62
- **Screens:** F1, E2
- **Size:** M

### CX-71 · Server overview, limits, branding, notifications

- **Done when:** Env-locked fields are read-only; invalid values can’t be saved.
- **Depends on:** CX-70
- **Screens:** E1, E3–E5
- **Size:** M

### CX-72 · API tokens and audit log

- **Done when:** Token shown once; audit export as CSV.
- **Depends on:** CX-70
- **Screens:** E6–E8
- **Size:** M


## Demo

### CX-80 · DEMO mode

- **Done when:** Fixed policy, quota visible, nightly wipe, breakers tested.
- **Depends on:** CX-14, CX-30
- **Screens:** G1–G2
- **Size:** M


## Release

### CX-90 · CLI: send, request, status, open

- **Done when:** Implements cli.md including exit codes; passes vectors.json; single binary for 3 OSes.
- **Depends on:** CX-10, CX-12, CX-50
- **Screens:** —
- **Size:** M

### CX-91 · Playwright suite and visual regression

- **Done when:** Screens diff against the prototype in CI.
- **Depends on:** CX-22, CX-30
- **Screens:** All
- **Size:** M

### CX-92 · Container: s6, nginx for SSE, CSP, migration and LEGACY_API

- **Done when:** Follows operations.md; upgrade from 2.4 tested with real data; release notes written.
- **Depends on:** CX-13
- **Screens:** —
- **Size:** M
