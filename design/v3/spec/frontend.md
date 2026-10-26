# Front-end specification

Stack (decision D1): Vite + TypeScript + Preact + `@preact/signals`. Styles: `proto/app.css` becomes `web/src/styles/app.css` unchanged, then split per component. Icons: Lucide, imported per icon (tree-shaken). Fonts: Red Hat Display 600/700, Text 400/500/600, Mono 400/500, self-hosted WOFF2, latin + latin-ext subsets; preload Display 700 and Text 400 only.

## 1. Routes

| Route | Screen(s) | Data needed | Notes |
|---|---|---|---|
| `/` | A1–A8, C1–C2 | `/config` | `?mode=request` selects Request. After create, the URL stays `/`. |
| `/links` | B1, B3, B4 | IndexedDB receipts + `/receipts/lookup` + `/me/receipts` | Live via SSE while open |
| `/r/:id` | B2 | receipt from IndexedDB (or `#manage=…` import) | |
| `/s/:id#key` | D1–D6 | `/secrets/:id/meta` | Key validated locally first (22 chars) |
| `/q/:id#key` | C3, C4 | `/requests/:id/prompt` | Fragment must be 32 chars |
| `/q/:id/key#pkcs8` | — | none | Imports a request backup key into IndexedDB, then redirects to `/links` |
| `/signin` | F2 | `/config` | |
| `/setup` | F1 | `/setup` | All other routes redirect here while setup is needed |
| `/server/*` | E1–E8 | `/server/*` | Owners only; members get the 404 page |
| anything else | D7 | — | |

Fragments are read on load and kept in memory. After a successful reveal (or answer), the fragment is removed from the address bar with `history.replaceState`, so the key doesn't linger in the visible URL, screenshots or a later refresh. Before reveal it stays, so a refresh still works. Fragments never reach `fetch` URLs or logs.

## 2. Source layout

```
web/src/
  main.tsx              router, theme, config bootstrap
  api/client.ts         typed from openapi.yaml (openapi-typescript), error mapping to copy keys
  crypto/worker.ts      all crypto in a Web Worker (see §4)
  crypto/format.ts      port of reference.py; tested against vectors.json
  store/receipts.ts     IndexedDB access (idb)
  store/prefs.ts        theme, last-used policy
  parse/paste.ts        paste parser (§5)
  ui/…                  one folder per component from the component sheet (H1)
  screens/…             one folder per flow (send, links, request, reveal, server, setup, demo)
  copy/en.json          strings (copy/en.json in this kit)
```

## 3. Local storage (IndexedDB `cryptex`, version 1)

| Store | Key | Value | Kept until |
|---|---|---|---|
| `receipts` | `kind:id` | `{kind, id, manage_token, title, created_at, link?, last_status}` | Removed by the user, or 30 days after a final status |
| `request_keys` | `id` | non-extractable `CryptoKey` (ECDH P-256 private) | Answer read and destroyed, or request expired |
| `prefs` | `theme`, `policy` | `"auto"\|"light"\|"dark"`, last options used | Forever |

- `link` (with its key) is stored only for secrets created on this device and is deleted as soon as the status is final (opened, expired, destroyed), so a stolen laptop can't reopen old links.
- `title` is kept locally in plain text so Your links can show it; “Clear this device” in the account menu wipes the store.
- `localStorage` is not used for anything sensitive.

## 4. Crypto worker protocol

```
→ {type:"seal", id, K?, policy, manifest, files:[File]}       // K generated in the worker if absent
← {type:"progress", stream, bytes, total}
← {type:"chunk", stream, n, bytes:ArrayBuffer}                 // uploaded by the main thread, with retries
← {type:"sealed", K_b64u, reveal_hash, passcheck_hash?, meta_ct, streams:[{stream,prefix,chunks,size}]}
→ {type:"open", id, K, passphrase?, chunks: AsyncIterable}
← {type:"item", item} … {type:"file", stream, blob}             // files assembled as Blob, never as text
← {type:"error", code:"tampered"|"wrong_passphrase"|"incomplete_link"}
```

Large files stream through the worker chunk by chunk; memory stays under about 3 chunks (15 MB).

## 5. Paste parser

Applied when the composer receives a paste. The first rule that matches the **whole** paste wins; otherwise the paste stays a note. “Undo” restores the raw text.

| # | Rule | Example input | Result |
|---|---|---|---|
| 1 | One PEM block | `-----BEGIN OPENSSH PRIVATE KEY-----…` | Field “Private key” (secret), value is the block |
| 2 | Every non-empty, non-`#` line is `KEY=value` | `DB_HOST=db\nDB_PASSWORD="x y"` | Fields `DB_HOST`, `DB_PASSWORD`; quotes removed; detected as `.env` |
| 3 | Every line is `key: value` (2+ lines) | `host: db\npassword: hunter2` | Fields `host`, `password` |
| 4 | One URL with credentials | `postgres://app:pw@db:5432/x` | Fields Host `db:5432/x`, Username `app`, Password `pw`, Type `postgres` |
| 5 | Two lines: identity, then secret | `sam@acme.example\nk7#Qp2-vR9mL` | Fields Username, Password |
| 6 | Anything else | free text | One note |

A field is marked secret (masked after reveal) when its key matches `/pass|secret|token|key|pwd|private|credential/i` or it came from rules 1, 4 (password) or 5 (second line). Parser tests live next to the parser and must include every row above plus Windows line endings, trailing spaces, empty values and duplicate keys (kept in order).

## 6. Keyboard and focus

| Keys | Where | Does |
|---|---|---|
| `⌘/Ctrl + Enter` | Send, Request, Respond | Create / send |
| `⌘/Ctrl + V` | anywhere on `/` | Focuses the composer and pastes |
| `Esc` | dialogs, options panel, menus | Closes and returns focus to the opener |
| `Enter` | sealed page | Reveal (only when the button has focus) |

Focus order follows the visual order; the first focus on each route is the page heading (`tabindex=-1`), except `/` where it's the composer.

## 7. States every component must implement

Button: default, hover, active, focus-visible, disabled, loading (spinner replaces the icon, label stays). Input: default, focus, error (with message below), disabled, read-only (env-locked). Choice and radio: default, selected, disabled with reason. Row: default, hover, attention. Dialog: open, closing. Toast: info, success, error (errors stay until dismissed).

## 8. Motion

| Moment | Duration | Easing | Reduced motion |
|---|---|---|---|
| Reveal: tint lifts, slot mark opens | 360 ms | `cubic-bezier(.2,.8,.2,1)` | 120 ms fade |
| Options panel expand | 180 ms | ease-out | instant |
| Dialog / bottom sheet | 160 ms in, 120 ms out | ease-out | fade only |
| Toast | 200 ms | ease-out | fade only |

No other animation. No skeleton shimmer; loading states use a static placeholder.

## 9. Behaviors

- **Copy**: `navigator.clipboard.writeText` inside the click handler; on failure, select the text and show “Press ⌘C to copy”.
- **Auto-clear** (D4): after 5 minutes without input, or 5 minutes hidden, or “Clear now”: wipe decrypted values from memory and the DOM, revoke Blob URLs, show “Cleared. The secret was deleted from the server.”
- **Upload retries**: each chunk retries 5 times with backoff (1, 2, 4, 8, 16 s); offline pauses and resumes on `online`.
- **Dates**: `Intl.DateTimeFormat` in the viewer's locale and time zone; relative times with `Intl.RelativeTimeFormat`.
- **Strings**: all from `copy/en.json` through `t(key, vars)`; plurals with `Intl.PluralRules`.
- **No-JS / old browser**: a static message “Cryptex needs a current browser to decrypt secrets on your device.”

## 10. Icon mapping (prototype sprite → Lucide)

lock→`lock` · eye→`eye` · eyeoff→`eye-off` · clock→`clock` · users→`users` · key→`key-round` · mail→`mail` · file→`file` · clip→`paperclip` · copy→`copy` · check→`check` · x→`x` · plus→`plus` · qr→`qr-code` · down→`download` · trash→`trash-2` · more→`ellipsis` · shield→`shield-check` · link→`link` · inbox→`inbox` · send→`send` · arrow→`arrow-right` · back→`arrow-left` · alert→`triangle-alert` · info→`info` · gauge→`gauge` · list→`list` · brush→`brush` · sliders→`sliders-horizontal` · user→`user` · search→`search` · scan→`scan-line` · upload→`upload` · globe→`globe` · terminal→`terminal` · refresh→`refresh-cw` · bell→`bell` · hourglass→`hourglass` · logout→`log-out`

## 11. Budgets

Recipient route (`/s/*`): ≤ 60 KB JS gzip excluding Argon2 (lazy, about 30 KB), ≤ 25 KB CSS, LCP ≤ 1.5 s on a mid-range phone over 4G. Sender route: ≤ 90 KB JS gzip. Checked in CI with `size-limit`.
