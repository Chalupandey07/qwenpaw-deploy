-- D1 schema for QwenPaw desktop + routine + board state.
--
-- DESIGN RULES (each earned by a bug in BUGS.md):
--   1. One row per mutable entity. KV stored whole JSON documents and did
--      read-modify-write, which lost updates (B-3, B-8) and made every edit
--      O(n). An UPDATE of one row is atomic and O(1).
--   2. The generation lives on `computer`, NOT on the lease, so it survives
--      lease deletion. B-1 happened because generation and lease were
--      separate uncoordinated writes.
--   3. Every WHERE / ORDER BY is indexed. On D1 an unindexed query is a
--      row-READ charge, not just slowness (5M rows/day free).
--   4. No image bytes. Previews are 243-707 KB; storing them here would
--      exhaust the 5 GB free storage in ~6 days (see README).
--   5. PRIMARY KEY on lease.computer makes "at most one lease per computer"
--      an engine guarantee rather than a convention.
--
-- Apply with: wrangler d1 execute <DB> --file=features/storage/schema.sql
-- Idempotent: every statement is IF NOT EXISTS.

-- ---------------------------------------------------------------- computers
CREATE TABLE IF NOT EXISTS computer (
  name       TEXT PRIMARY KEY,              -- 'default' | 'qa'
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO computer (name, generation, updated_at)
VALUES ('default', 0, '1970-01-01T00:00:00Z');
INSERT OR IGNORE INTO computer (name, generation, updated_at)
VALUES ('qa', 0, '1970-01-01T00:00:00Z');

-- ------------------------------------------------------------------- leases
-- Only a human holder ever gets a row. "No row" == the agent may act.
CREATE TABLE IF NOT EXISTS lease (
  computer   TEXT PRIMARY KEY REFERENCES computer(name),
  lease_id   TEXT NOT NULL,
  holder     TEXT NOT NULL,
  granted_at INTEGER NOT NULL,              -- epoch ms
  expires_at INTEGER NOT NULL,              -- epoch ms
  fence      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lease_expiry ON lease(expires_at);

-- ---------------------------------------------------------------- needs-you
-- Per computer (fixes B-2: one global record meant a :2 raise clobbered a :1
-- request and the banner previewed the wrong display).
CREATE TABLE IF NOT EXISTS needs_you (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  computer    TEXT NOT NULL,
  text        TEXT NOT NULL,
  run_id      TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  action      TEXT
);
-- The only hot query: "the open record for this computer". Partial index.
CREATE INDEX IF NOT EXISTS idx_needs_open
  ON needs_you(computer, resolved_at) WHERE resolved_at IS NULL;

-- ----------------------------------------------------------------- previews
-- METADATA ONLY. Bytes live in R2 under preview/<computer>.png, overwritten
-- in place so storage stays flat instead of growing per capture.
CREATE TABLE IF NOT EXISTS preview (
  computer    TEXT PRIMARY KEY,
  r2_key      TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  captured_at TEXT NOT NULL
);

-- --------------------------------------------------------------- agent mode
CREATE TABLE IF NOT EXISTS agent_mode (
  agent      TEXT PRIMARY KEY,
  mode       TEXT NOT NULL DEFAULT 'team'
             CHECK (mode IN ('team', 'private')),
  updated_at TEXT NOT NULL
);

-- ------------------------------------------------------------ taught skills
-- delivered_at NULL = pending. expires_at stops undelivered rows
-- accumulating forever (B-6: they had no TTL and were re-read every 30 s).
CREATE TABLE IF NOT EXISTS taught_skill (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  goal         TEXT,
  playbook     TEXT NOT NULL,               -- JSON text, opaque payload
  events       TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taught_pending
  ON taught_skill(delivered_at, expires_at) WHERE delivered_at IS NULL;

-- ----------------------------------------------------------------- routines
CREATE TABLE IF NOT EXISTS routine_run (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL,
  at      TEXT NOT NULL,
  status  TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_routine_recent ON routine_run(at DESC);

CREATE TABLE IF NOT EXISTS routine_pending (
  id         TEXT PRIMARY KEY,
  prompt     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routine_pending_expiry
  ON routine_pending(expires_at);

-- ---------------------------------------------------------------- keepalive
-- One row, id pinned to 1. B-7: the KV version wrote a whole JSON blob every
-- 5 minutes; here a write is a single UPDATE and only on change.
CREATE TABLE IF NOT EXISTS keepalive (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  status              TEXT NOT NULL,
  http_status         INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_up_at          TEXT,
  last_wake_at        TEXT,
  last_wake_result    TEXT,
  checked_at          TEXT NOT NULL
);

-- ------------------------------------------------------------------- board
-- Replaces "all tickets in one KV value" (B-3: lost updates, O(n) writes).
CREATE TABLE IF NOT EXISTS ticket (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT,
  status     TEXT NOT NULL DEFAULT 'todo',
  priority   TEXT NOT NULL DEFAULT 'normal',
  assignee   TEXT,
  labels     TEXT,                           -- JSON array text
  follow_up  INTEGER NOT NULL DEFAULT 0      -- 0/1: strict boolean, not "false"
             CHECK (follow_up IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1      -- optimistic concurrency
);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON ticket(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_assignee ON ticket(assignee, status);

CREATE TABLE IF NOT EXISTS ticket_comment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
  author     TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comment_ticket
  ON ticket_comment(ticket_id, created_at);

-- --------------------------------------------------------------------- vault
-- API-key vault (Rakazo-style, 2026-11-17). The model can USE a key but
-- never SEE it: the value is AES-256-GCM sealed in `ciphertext` and is
-- decrypted only inside the Worker, which builds the request itself and
-- redacts every byte back toward the model. See features/vault/README.md.
--
-- DESIGN RULES (each earned by the Rakazo study, ~/workspace/rakazo-vault-study.md):
--   1. One row per item. `name` is the model's handle; `id` is never
--      returned to the model (list returns metadata only, no row id).
--   2. `ciphertext` format is `v1:<base64url(iv|ciphertext|tag)>`; the AAD
--      binds `vault\0v1\0<itemId>\0<kind>\0<host>\0value\0<key_version>`
--      (DeepSeek design review, 2026-11-17): `name` is deliberately NOT in
--      the AAD (mutable display metadata — binding it forces a re-seal on
--      every rename); `kind` stops cross-type confusion; `host` stops the
--      key being re-pointed at an attacker server; `key_version` allows
--      rotation with dual-read. The CHECK on ciphertext is a backstop
--      against a future code path persisting plaintext.
--   3. `origin` pins where the key may be sent (bearer/header/basic only);
--      `command` items have origin '' and are env-only — /vault/request
--      refuses them.
--   4. Every use writes a `vault_use` row (tool, site, time — never a
--      value). Activity reads are capped at the latest 50.
CREATE TABLE IF NOT EXISTS vault_item (
  id         TEXT PRIMARY KEY,            -- random 24-hex
  name       TEXT NOT NULL UNIQUE,        -- lowercase-kebab ^[a-z][a-z0-9_-]{0,63}$
  kind       TEXT NOT NULL,               -- bearer | header | basic | command
  origin     TEXT NOT NULL DEFAULT '',    -- https origin the key may be sent to ('' for command)
  header_name TEXT,                       -- kind=header only
  username   TEXT,                        -- kind=basic only
  ciphertext TEXT NOT NULL CHECK (ciphertext LIKE 'v1:%'), -- v1:<base64url(iv|ciphertext|tag)>
  key_version TEXT NOT NULL DEFAULT '1', -- rotation: dual-read during a master-secret rotation
  title      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  policy     TEXT NOT NULL DEFAULT 'allow' -- allow | off
             CHECK (policy IN ('allow', 'off')),
  scope      TEXT NOT NULL DEFAULT 'agent', -- reserved for later scoping
  created_at INTEGER NOT NULL,             -- epoch ms
  updated_at INTEGER NOT NULL              -- epoch ms
);

CREATE TABLE IF NOT EXISTS vault_use (
  id         TEXT PRIMARY KEY,            -- random 24-hex
  item_id    TEXT NOT NULL,               -- vault_item.id (no FK: items are deleted with their uses)
  tool       TEXT NOT NULL,               -- 'request' | 'reveal' | 'export' | 'run'
  site       TEXT NOT NULL DEFAULT '',    -- origin the key was sent to ('' for reveal/remove)
  created_at INTEGER NOT NULL             -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_vault_use_item ON vault_use(item_id, created_at DESC);
