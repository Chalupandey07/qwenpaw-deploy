# D1 schema — qwenpaw-state

Database: `qwenpaw-state`, uuid `5f58a2f8-e4bb-45e5-8a94-4fc283b90871`
(created 2026-11-15 via the D1 API; read replication DISABLED, so reads
are strongly consistent). One database for all three Workers. Free-tier
headroom after migration: ~4,700 rows written/day (4.7% of 100,000),
~45,000 rows read/day (0.9% of 5,000,000), < 10 MB stored (2% of 500 MB).
See QUOTA-BUDGET.md for the full audit.

## Design choice: KV-shaped store over typed tables

The three Workers already speak KV (`get` / `put` / `delete` /
`list({prefix})`). The store module (`store.js`, inlined into each
worker — Pages `_worker.js` and the API-uploaded standalone workers are
single files with no bundler, so a shared import is not possible)
exposes the SAME interface, backed by the typed tables below. Call
sites change only the binding source (`env.DESKTOP_KV` /
`env.STATUS` -> `store(env)`); no handler logic changes. The typed
tables make the atomic operations possible later (see "Follow-ups");
the cutover itself keeps behaviour identical.

`USE_D1` env var (`"1"` = D1, anything else / unset = KV) selects the
backend at runtime. KV stays as the fallback until D1 is verified live.

## Tables

```sql
-- One row per computer. expires_at is epoch ms; the worker checks it
-- (D1 has no TTL — expiry is enforced in SQL / in the reader).
CREATE TABLE IF NOT EXISTS leases (
  computer   TEXT PRIMARY KEY,   -- 'default' | 'qa'
  lease_id   TEXT NOT NULL,
  holder     TEXT NOT NULL,      -- 'user'
  granted_at INTEGER NOT NULL,   -- epoch ms
  expires_at INTEGER NOT NULL,   -- epoch ms
  fence      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS generations (
  computer TEXT PRIMARY KEY,     -- 'default' | 'qa'
  gen      INTEGER NOT NULL DEFAULT 0
);

-- One row per computer (the old global "needsyou" key is copied to
-- computer='default' by the migration; the worker also falls back to
-- the legacy key on reads until the copy lands).
CREATE TABLE IF NOT EXISTS needs_you (
  computer TEXT PRIMARY KEY,     -- 'default' | 'qa'
  text     TEXT NOT NULL,
  at       TEXT NOT NULL,        -- ISO timestamp
  run_id   TEXT
);

CREATE TABLE IF NOT EXISTS teach_skills (
  id         TEXT PRIMARY KEY,   -- 'taught-<random8>'
  payload    TEXT NOT NULL,      -- JSON: {id, name, goal, playbook, events, at}
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modes (
  agent TEXT PRIMARY KEY,        -- agent name, sanitised
  mode  TEXT NOT NULL            -- 'team' | 'private'
);

-- Previews: ONE row per computer, upsert replaces the image (no
-- history to prune). Stored as RAW BYTES (BLOB), not base64: the
-- worker still speaks base64 to its callers, and the store
-- decodes/encodes at the boundary. No index on the BLOB.
-- Decision (evidence): live previews are 500,476 B (:1) and 707,262 B
-- (:2) (measured on the machine 2026-11-15). D1's max row/BLOB is
-- 2 MB (official docs), so a raw 707 KB preview fits with 2.8x
-- headroom; the worker caps uploads at 1,500,000 B, so a row can never
-- exceed 1.5 MB. R2 was considered and REJECTED for previews: R2 is
-- not enabled on this account (API error 10042 — enabling it is a
-- separate user step, possibly billing-gated), and it would add a
-- second store for a value that fits in D1. If previews ever exceed
-- the cap, R2 is the documented fallback.
CREATE TABLE IF NOT EXISTS previews (
  computer   TEXT PRIMARY KEY,   -- 'default' | 'qa'
  png        BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- Routine run history: one row per tick (not one JSON blob). Bounded
-- to 50 rows by the writer (DELETE oldest beyond 50). `at` is ISO.
-- `raw` holds the full entry JSON so `get` reconstructs the array
-- losslessly (entries carry extra fields like `cron`).
CREATE TABLE IF NOT EXISTS routines_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  kind            TEXT NOT NULL,  -- 'wake-tick' | 'daily-summary-slot' | 'manual-trigger'
  qwenpaw         TEXT NOT NULL,  -- probe status
  http_status     INTEGER,
  note            TEXT,
  active_routines TEXT NOT NULL DEFAULT '[]',  -- JSON array of ids
  raw             TEXT NOT NULL DEFAULT ''     -- full entry JSON
);

-- Pending manual triggers. expires_at is epoch seconds (7-day TTL);
-- the reader deletes expired rows lazily (D1 has no automatic TTL).
CREATE TABLE IF NOT EXISTS routines_pending (
  id         TEXT PRIMARY KEY,   -- 'trig-<epoch ms>'
  payload    TEXT NOT NULL,      -- JSON entry
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routines_definitions (
  id      TEXT PRIMARY KEY,      -- routine id
  payload TEXT NOT NULL          -- JSON definition
);

-- Keep-alive status (one JSON document) + generic singletons.
CREATE TABLE IF NOT EXISTS status (
  key   TEXT PRIMARY KEY,        -- 'qwenpaw:status'
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,        -- 'lastWake' (epoch ms, Pages worker)
                                 -- 'routines:last-trigger-at' (epoch ms)
  value TEXT NOT NULL
);

-- Daily write counter. In the D1 phase the counter is updated with an
-- atomic `UPDATE ... SET count = count + 1` in the same batch as the
-- write itself — no separate flush, no per-isolate estimate. (In the
-- KV phase it is a plain key flushed on every 25th local write; see
-- QUOTA-BUDGET.md for why that is only approximate.)
CREATE TABLE IF NOT EXISTS write_budget (
  day   TEXT PRIMARY KEY,        -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL DEFAULT 0
);

-- Board tickets (migrated 2026-11-15 from ONE KV value `tickets` to
-- one row per ticket). The board worker does NOT use the KV-shaped
-- store.js — it has its own typed D1 layer (d1List/d1Get/d1Insert/
-- d1Update/d1Delete in features/board/worker/src/index.js) because
-- tickets are queried by column and mutated per row. KV stays the
-- fallback (same row shape as one JSON value). Export backup:
-- features/storage/board-kv-export-2026-11-15.json (0 tickets).
CREATE TABLE IF NOT EXISTS tickets (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  column           TEXT NOT NULL DEFAULT 'todo',
  agent            TEXT NOT NULL DEFAULT 'default',
  priority         TEXT NOT NULL DEFAULT 'normal',
  follow_up        INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  comments         TEXT NOT NULL DEFAULT '[]',  -- JSON array
  qwenpaw_session  TEXT,
  sent_to_qwenpaw_at TEXT,
  created_at       TEXT NOT NULL,               -- ISO timestamp
  updated_at       TEXT NOT NULL                -- ISO timestamp
);
CREATE INDEX IF NOT EXISTS idx_tickets_column ON tickets(column);

-- Rate limiting for the board is NOT a D1 table: it is a Durable
-- Object (BoardRateLimiter, features/board/worker/src/index.js) whose
-- buckets live in DO storage (fail:<ip> / mut:<ip>). A `rate_limits`
-- table was created during the migration and then dropped — rate
-- checks are DO subrequests, not D1 rows, so they cost nothing
-- against the 100,000 rows/day D1 budget.
```

## Key -> table routing (store.js)

| KV key (old) | D1 table | Notes |
|---|---|---|
| `lease:<computer>` | `leases` | JSON <-> columns. |
| `generation:<computer>` | `generations` | `gen` integer. |
| `needsyou:<computer>` | `needs_you` | JSON <-> columns. Legacy `needsyou` reads `needs_you['default']`. |
| `preview:<computer>` | `previews` | base64 string <-> raw BLOB at the boundary. |
| `teach-skill:<id>` | `teach_skills` | `list({prefix:'teach-skill:'})` = one `SELECT id FROM teach_skills` (fixes the KV N+1: list + N gets). |
| `computerMode:<agent>` | `modes` | Plain string value. |
| `budget:<day>` | `write_budget` | Count as a string (KV shape); atomic increment in the D1 phase. |
| `lastWake` | `meta` | Epoch-ms string. |
| `qwenpaw:status` | `status` | JSON document. |
| `routines:history` | `routines_history` | `get` returns the JSON array (SELECT ... ORDER BY id DESC LIMIT 50); `put` replaces the table contents in one batch. |
| `routines:definitions` | `routines_definitions` | `get` returns the JSON array; `put` replaces. |
| `routines:pending:<id>` | `routines_pending` | Payload + `expires_at` (7 days from write). |
| `routines:last-trigger-at` | `meta` | Epoch-ms string. |

## What D1 changes (and what it does not)

- Quota: writes move from the 1,000/day shared KV budget to D1's
  100,000 rows/day. The KV budget is spent again today (error 10048
  verified live 2026-11-15 on both namespaces) — D1 restores write
  functionality immediately, without waiting for the 00:00 UTC reset.
- Consistency: D1 is single-threaded per database and read
  replication is disabled, so reads are strongly consistent. The
  generation check keeps its +1 tolerance (harmless, and it protects
  the KV fallback path); it is not tightened in this cutover.
- Previews stay base64 at the worker boundary (call sites untouched);
  only the storage is raw bytes.
- The budget guard keeps the same caps (STATUS 250 + DESKTOP_KV 450
  = 700) and the same essential/non-essential split; only the counter
  becomes exact (atomic SQL) instead of approximate.
- KV remains the fallback: `USE_D1` unset / `"0"` = KV, and the
  migration script's rollback flips the flag back (see
  migrate-kv-to-d1.py). Rollback is a data migration once D1 has
  accepted writes: copy D1 -> KV under a write pause, or accept that
  KV state is stale (leases expire within 90 s; the only durable
  loss would be teach skills / routine definitions written after the
  cutover — the script prints exactly what would be lost).

## Follow-ups (not in this cutover)

1. Atomic lease ops: takeover / heartbeat / release as conditional
   SQL (`INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= ?`,
   `UPDATE ... WHERE lease_id = ? AND expires_at > ?`,
   `DELETE ... WHERE lease_id = ?`) instead of read-then-write. The
   typed tables make this possible; the emulation layer keeps the
   old behaviour for the cutover. Do this after the D1 cutover is
   verified live.
2. Board tickets: **DONE 2026-11-15** (was: the board worker stored
   ALL tickets in ONE KV value (`TICKETS` key), so every ticket
   mutation rewrote the whole list and concurrent writes could lose
   tickets). Migrated to a `tickets` table (one row per ticket, see
   above) + the board's open audit item `board-no-rate-limit-auth`
   fixed in the same pass (Durable Object `BoardRateLimiter`,
   30/min/IP failed-auth + 30/min/IP and 1,000/day/IP mutations,
   429 + Retry-After; live proof 30×401 + 5×429 from the machine;
   test T63). KV export backup:
   `features/storage/board-kv-export-2026-11-15.json` (0 tickets).
3. R2 for previews if a preview ever exceeds the 1.5 MB upload cap
   (requires the user to enable R2 on the account first).
4. Tighten the generation check to exact-match if read replication
   stays disabled (optional; the +1 tolerance is harmless).
