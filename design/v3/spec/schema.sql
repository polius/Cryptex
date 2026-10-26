-- Cryptex 3.0 schema (SQLite, WAL mode). Migration 0001.
-- Rule: no column ever holds plaintext content, file names, titles, sender names or link keys.
-- Every *_hash column is hex(SHA-256(token)) of a 256-bit token. Times are unix seconds (UTC).
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL);

-- ---------------------------------------------------------------- people
CREATE TABLE users (
  id            TEXT PRIMARY KEY,                       -- random 16 chars
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner')),
  oidc_sub      TEXT UNIQUE,                            -- issuer-qualified subject
  password_hash TEXT,                                   -- argon2id (owners without SSO only)
  totp_ct       BLOB,                                   -- TOTP secret encrypted with ENC_KEY
  totp_last_step INTEGER,                               -- blocks code replay
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,                       -- 14 days, sliding
  reauth_until  INTEGER                                 -- sensitive changes allowed until
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  scopes        TEXT NOT NULL,                          -- comma list: send,request
  token_hash    TEXT NOT NULL UNIQUE,
  hint          TEXT NOT NULL,                          -- last 4 characters
  legacy        INTEGER NOT NULL DEFAULT 0,             -- imported from 2.4 API keys
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  last_used_at  INTEGER
);

-- ---------------------------------------------------------------- secrets
CREATE TABLE secrets (
  id              TEXT PRIMARY KEY CHECK (length(id) = 10),
  owner_id        TEXT REFERENCES users(id) ON DELETE SET NULL,   -- NULL for anonymous senders
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  max_views       INTEGER NOT NULL CHECK (max_views >= 1),
  views           INTEGER NOT NULL DEFAULT 0,
  access          TEXT NOT NULL CHECK (access IN ('link','email','org')),
  email_ct        BLOB,                                 -- allowed recipient, encrypted with ENC_KEY
  email_hint      TEXT,                                 -- "l•••@globex.example"
  passphrase_salt BLOB,                                 -- 16 bytes, NULL when no passphrase
  passcheck_hash  TEXT,
  failed_tries    INTEGER NOT NULL DEFAULT 0,
  reveal_hash     TEXT NOT NULL,
  manage_hash     TEXT NOT NULL,
  upload_hash     TEXT,                                 -- NULL once sealed
  upload_active_at INTEGER,
  sealed          INTEGER NOT NULL DEFAULT 0,
  consumed_at     INTEGER,                              -- last view used; data purged when read session ends
  notify          INTEGER NOT NULL DEFAULT 0,
  meta_ct         BLOB NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX secrets_expiry ON secrets(expires_at);
CREATE INDEX secrets_owner ON secrets(owner_id);

CREATE TABLE streams (
  secret_id     TEXT REFERENCES secrets(id) ON DELETE CASCADE,
  request_id    TEXT REFERENCES requests(id) ON DELETE CASCADE,
  stream        INTEGER NOT NULL,
  prefix        BLOB NOT NULL CHECK (length(prefix) = 7),
  chunks        INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL,
  received      INTEGER NOT NULL DEFAULT 0,             -- chunks stored so far
  CHECK ((secret_id IS NULL) <> (request_id IS NULL))
);
CREATE UNIQUE INDEX streams_secret ON streams(secret_id, stream) WHERE secret_id IS NOT NULL;
CREATE UNIQUE INDEX streams_request ON streams(request_id, stream) WHERE request_id IS NOT NULL;

CREATE TABLE chunks (
  owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('secret','answer')),
  owner_id      TEXT NOT NULL,
  stream        INTEGER NOT NULL,
  n             INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL,
  blob_key      TEXT NOT NULL,                          -- random name in the Storage backend
  served        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_kind, owner_id, stream, n)
);

CREATE TABLE read_sessions (
  token_hash    TEXT PRIMARY KEY,
  secret_id     TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,                       -- 10 minutes
  last_view     INTEGER NOT NULL DEFAULT 0              -- purge data when this session ends
);

CREATE TABLE email_codes (
  secret_id     TEXT PRIMARY KEY REFERENCES secrets(id) ON DELETE CASCADE,
  code_hash     TEXT NOT NULL,                          -- argon2id of the 6 digits (low entropy)
  sent_at       INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  tries         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE access_grants (
  grant_hash    TEXT PRIMARY KEY,
  secret_id     TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL
);

-- Answers 410 for 7 days after a secret or request is gone. Holds no content.
CREATE TABLE tombstones (
  kind          TEXT NOT NULL CHECK (kind IN ('secret','request')),
  id            TEXT NOT NULL,
  token_hash    TEXT NOT NULL,                          -- reveal_hash or answer_token_hash
  manage_hash   TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('opened','expired','destroyed','cancelled','answered','too_many_tries')),
  at            INTEGER NOT NULL,
  purge_after   INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);

-- ---------------------------------------------------------------- requests
CREATE TABLE requests (
  id                 TEXT PRIMARY KEY CHECK (length(id) = 10),
  owner_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,                  -- link lifetime
  keep_answer_s      INTEGER NOT NULL,
  allow_files        INTEGER NOT NULL DEFAULT 0,
  notify             INTEGER NOT NULL DEFAULT 0,
  public_key         BLOB NOT NULL,                     -- SPKI DER, P-256
  prompt_ct          BLOB NOT NULL,
  answer_token_hash  TEXT NOT NULL,
  manage_hash        TEXT NOT NULL,
  answer_upload_hash TEXT,
  ephemeral_key      BLOB,                              -- responder's SPKI DER
  answered_at        INTEGER,
  answer_size        INTEGER
);
CREATE INDEX requests_expiry ON requests(expires_at);

-- ---------------------------------------------------------------- receipts sync and events
CREATE TABLE user_receipts (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('secret','request')),
  item_id       TEXT NOT NULL,
  manage_hash   TEXT NOT NULL,                          -- proves the user held the token
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, item_id)
);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  type          TEXT NOT NULL,                          -- see events.md
  secret_id     TEXT,
  request_id    TEXT,
  actor_user_id TEXT,                                   -- NULL means "link holder" or system
  actor         TEXT NOT NULL DEFAULT 'link' CHECK (actor IN ('user','link','system','token')),
  detail        TEXT NOT NULL DEFAULT '{}'              -- JSON; never content, titles or IPs
);
CREATE INDEX events_at ON events(at);
CREATE INDEX events_secret ON events(secret_id);
CREATE INDEX events_request ON events(request_id);

-- ---------------------------------------------------------------- server
CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,                          -- JSON
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  events        TEXT NOT NULL DEFAULT '*',
  secret_ct     BLOB NOT NULL,                          -- HMAC signing secret, encrypted with ENC_KEY
  created_at    INTEGER NOT NULL,
  last_status   INTEGER,
  last_error    TEXT,
  last_attempt_at INTEGER
);

CREATE TABLE webhook_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id    TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE rate_limits (
  bucket        TEXT NOT NULL,                          -- e.g. "create:ip:203.0.113.0/24" or "create:ip6:2001:db8:1:2::/64"
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE jobs (
  name          TEXT PRIMARY KEY,                       -- cleanup, webhooks, demo_wipe
  last_run_at   INTEGER,
  last_result   TEXT
);

INSERT INTO schema_version VALUES (1, CAST(strftime('%s','now') AS INTEGER));
