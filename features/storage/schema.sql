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
