-- Cryptex schema (SQLite, WAL mode). Migration 0001, applied by cryptex/db.py.
-- Rule: no column ever holds plaintext content, file names, titles, sender names or link keys.
-- Every *_hash column is hex(SHA-256(token)) of a 256-bit token. Times are unix seconds (UTC).

-- ---------------------------------------------------------------- people
CREATE TABLE users (
  id            TEXT PRIMARY KEY,                       -- random 16 chars
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner')),
  -- Zero-knowledge sign-in (account.py): the browser derives, from password + kdf_salt (Argon2id), an auth key it
  -- sends and a wrap key it keeps. The server never sees the password, the wrap key or the vault key.
  password_hash TEXT,                                   -- argon2id(HMAC-SHA-256(ENC_KEY, auth key)) (security.py), so a
                                                        -- database copy without ENC_KEY can't test password guesses;
                                                        -- NULL until an invite is accepted
  kdf_salt      BLOB,                                   -- 16 random bytes, made by the browser
  kdf           TEXT,                                   -- Argon2id settings as JSON, e.g. {"m":65536,"t":3,"p":1}
  unlock_ct     BLOB,                                   -- unlock share: 32 random bytes encrypted with ENC_KEY, released
                                                        -- only after a full sign-in, so a database copy alone can't be
                                                        -- used to guess passwords offline
  vault_pw      TEXT,                                   -- vault key wrapped by wrap key + unlock share; NULL until the
                                                        -- first sign-in, and after a reset (account.clear_vault)
  totp_ct       BLOB,                                   -- TOTP secret encrypted with ENC_KEY
  totp_last_step INTEGER,                               -- blocks code replay
  invite_hash   TEXT UNIQUE,                            -- one-time link to set a password and 2FA
  invite_expires_at INTEGER,
  reset_notice  TEXT,                                   -- {"by", "at"}: an owner made a reset link; shown at the next
                                                        -- sign-in until dismissed
  -- "Forgot your password?" (account.py issue_temp_password): HMAC-SHA-256(ENC_KEY) of the auth key the temporary
  -- password derives with this row's kdf_salt and kdf. Cleared by any credential change; the password itself is only
  -- in DATA_DIR.
  temp_key_hash TEXT,
  temp_expires_at INTEGER,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,                       -- 14 days, sliding, never past created_at + 30 days;
                                                        -- 12 hours and no sliding when shared
  reauth_until  INTEGER,                                -- sensitive changes allowed until
  shared        INTEGER NOT NULL DEFAULT 0              -- "This is a shared computer": browser-session cookie
);
CREATE INDEX sessions_user ON sessions(user_id);

-- What a signed-in browser keeps (its copy of the vault key) is locked with a device key that only a
-- signed-in session of its user can fetch: signing out leaves that browser's copy unreadable.
CREATE TABLE device_keys (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,                          -- random id the browser made for itself
  key_ct        BLOB NOT NULL,                          -- 32 random bytes, encrypted with ENC_KEY
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- The account vault: Your links' titles, links while they wait and manage tokens, encrypted in the browser with
-- the vault key. Synced so every device of the account shows the same thing.
CREATE TABLE vault_items (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL,                          -- the secret's id
  ct            TEXT NOT NULL,                          -- unreadable to the server
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

-- ---------------------------------------------------------------- secrets
CREATE TABLE secrets (
  id              TEXT PRIMARY KEY CHECK (length(id) = 10),
  owner_id        TEXT REFERENCES users(id) ON DELETE SET NULL,   -- NULL for anonymous senders
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                     -- the chosen lifetime counts from seal: until then it is
                                                        -- created_at + lifetime, and seal moves it to seal time + lifetime
                                                        -- (an answer keeps its request's)
  max_views       INTEGER CHECK (max_views IS NULL OR max_views >= 1),  -- 1: one-time; NULL: until it expires
  views           INTEGER NOT NULL DEFAULT 0,
  passphrase_salt BLOB,                                 -- 16 bytes, NULL when no passphrase
  passcheck_hash  TEXT,
  failed_tries    INTEGER NOT NULL DEFAULT 0,
  reveal_hash     TEXT,                                 -- set by seal (it depends on the ID)
  manage_hash     TEXT NOT NULL,
  upload_hash     TEXT,                                 -- kept after seal, when the token can change nothing, so a
                                                        -- retried seal gets 409 already_sealed rather than a 404
  upload_active_at INTEGER,                             -- unsealed: last chunk; idle 30 minutes and the upload goes
  sealed          INTEGER NOT NULL DEFAULT 0,
  consumed_at     INTEGER,                              -- last view used; data purged when read session ends
  meta_ct         BLOB,                                 -- set by seal
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  request_id      TEXT                                  -- an answer to a request (below): the request it answers;
                                                        -- its expiry is the request's, and seal doesn't move it
);
CREATE INDEX secrets_expiry ON secrets(expires_at);
CREATE INDEX secrets_owner ON secrets(owner_id);

CREATE TABLE streams (
  secret_id     TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  stream        INTEGER NOT NULL,
  prefix        BLOB NOT NULL CHECK (length(prefix) = 7),
  chunks        INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL,
  received      INTEGER NOT NULL DEFAULT 0,             -- chunks stored so far
  PRIMARY KEY (secret_id, stream)
);

CREATE TABLE chunks (
  secret_id     TEXT NOT NULL,                          -- no FK: blobs are deleted explicitly before the row
  stream        INTEGER NOT NULL,
  n             INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL,
  blob_key      TEXT NOT NULL,                          -- random name in the Storage backend
  served        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (secret_id, stream, n)
);

CREATE TABLE read_sessions (
  token_hash    TEXT PRIMARY KEY,
  secret_id     TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  revealed_at   INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,                       -- 10 minutes, then each chunk request and each chunk's
                                                        -- response done moves it to at least 15 minutes ahead,
                                                        -- never past revealed_at + 6 hours (5 minutes once the last
                                                        -- view's chunks all went out)
  last_view     INTEGER NOT NULL DEFAULT 0              -- purge data when this session ends
);
CREATE INDEX read_sessions_secret ON read_sessions(secret_id);

-- Answers 410 for 30 days after a secret is gone (as long as Your links keeps ended items). Holds no content.
CREATE TABLE tombstones (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,                          -- the secret's reveal_hash
  manage_hash   TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('opened','expired','destroyed','too_many_tries','reported')),
  opened        INTEGER NOT NULL DEFAULT 0,             -- it was revealed at least once
  at            INTEGER NOT NULL,
  purge_after   INTEGER NOT NULL
);

-- ---------------------------------------------------------------- requests
-- "Ask for a secret" (routes/requests.py): whoever can create links makes a request link, and whoever opens it sends
-- them a secret, with or without an account. The answer is an ordinary secret (secrets.request_id) whose link key is
-- encrypted to the requester's public key (docs/crypto.md §4): the server can't read it, nor can the link's holder.
CREATE TABLE requests (
  id            TEXT PRIMARY KEY CHECK (length(id) = 10),
  owner_id      TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL when asked without an account
  manage_hash   TEXT NOT NULL,                        -- the requester's token: statuses, seal, delete
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,                     -- it takes an answer until then, and its answer opens until then
  answer_hash   TEXT,                                 -- set by seal: SHA-256 of the answer token the link's key gives
  ask_ct        BLOB,                                 -- set by seal: the note and the public key, under the link's key
  answer_id     TEXT,                                 -- the answer's secret, once sent
  answer_ct     BLOB,                                 -- the answer's link key, encrypted to the public key
  answered_at   INTEGER,
  closed_at     INTEGER                               -- deleted by the requester, or closed by a password reset
);
CREATE INDEX requests_owner ON requests(owner_id);

-- ---------------------------------------------------------------- receipts sync and events
CREATE TABLE user_receipts (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_id     TEXT NOT NULL,
  manage_hash   TEXT NOT NULL,                          -- proves the user held the token
  added_at      INTEGER NOT NULL,                       -- deleted with the secret's tombstone (jobs.tombstones)
  PRIMARY KEY (user_id, secret_id)
);
CREATE INDEX user_receipts_secret ON user_receipts(secret_id);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  type          TEXT NOT NULL,                          -- see events.py
  secret_id     TEXT,
  actor_user_id TEXT,                                   -- NULL means "link holder" or system
  actor         TEXT NOT NULL DEFAULT 'link' CHECK (actor IN ('user','link','system')),
  detail        TEXT NOT NULL DEFAULT '{}'              -- JSON; never content, titles or IPs
);
CREATE INDEX events_at ON events(at);
CREATE INDEX events_secret ON events(secret_id);

-- ---------------------------------------------------------------- server
CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,                          -- JSON. enc_canary: a constant sealed with ENC_KEY (security.py)
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Bumped by every change to settings, whichever process makes it (the server, `cryptex owner reset`, a hand edit),
-- so the server's cached settings (state.py) notice it without a restart.
CREATE TABLE settings_version (v INTEGER NOT NULL);
INSERT INTO settings_version VALUES (0);
CREATE TRIGGER settings_inserted AFTER INSERT ON settings BEGIN UPDATE settings_version SET v = v + 1; END;
CREATE TRIGGER settings_updated AFTER UPDATE ON settings BEGIN UPDATE settings_version SET v = v + 1; END;
CREATE TRIGGER settings_deleted AFTER DELETE ON settings BEGIN UPDATE settings_version SET v = v + 1; END;

CREATE TABLE rate_limits (
  bucket        TEXT NOT NULL,                          -- e.g. "create:ip:203.0.113.7", "create:ip6:2001:db8:1:2::/64",
                                                        -- "totp:user:<id>" or "password:user:<username>"
  window_start  INTEGER NOT NULL,                       -- windows are a day at most; rows go after a day
  count         INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE jobs (
  name          TEXT PRIMARY KEY,                       -- cleanup, tombstones, audit, demo_wipe
  last_run_at   INTEGER,
  last_result   TEXT
);

-- ---------------------------------------------------------------- short-lived tickets
CREATE TABLE mfa_tickets (                             -- sign-in tickets (routes/auth.py new_ticket)
  ticket_hash   TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'mfa' CHECK (kind IN ('mfa','reset')),  -- mfa: the 2FA code is next;
                                                        -- reset: after a temporary password, a new password is next
  tries         INTEGER NOT NULL DEFAULT 0,
  shared        INTEGER NOT NULL DEFAULT 0,             -- the session it leads to is a shared-computer one
  expires_at    INTEGER NOT NULL
);

-- Reset links (routes/server.py make_reset_link, routes/auth.py reset_*): an owner lets someone choose a new
-- password. The link carries a 256-bit token and a separate 8-character code goes by another channel; only
-- hashes are kept. The current password keeps working until the link is used, unless the owner locked the account.
CREATE TABLE reset_links (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,  -- one at a time per person
  token_hash    TEXT NOT NULL UNIQUE,                   -- SHA-256 of the token in the link's fragment
  code_hash     TEXT NOT NULL,                          -- HMAC-SHA-256(ENC_KEY, code)
  by_username   TEXT NOT NULL,                          -- the owner who made it, as shown to the person
  tries         INTEGER NOT NULL DEFAULT 0,             -- wrong codes; the link goes at 5
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL                        -- 24 hours
);

CREATE TABLE pow_used (
  challenge_hash TEXT PRIMARY KEY,
  expires_at    INTEGER NOT NULL
);
