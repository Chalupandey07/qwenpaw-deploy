# Bloat win-win: data-layer optimizations (no source change)

Done live on the machine 2026-11-18 ~13:4x–14:0x IST by the parent
agent (the source changes are in README.md, done by a subagent).
Win-win rule: faster/smaller with ZERO data loss and ZERO capability
loss. Every number below was measured on the live machine, not claimed.

## Results (measured before / after)

| Item | Before | After | What was preserved |
|---|---|---|---|
| `history.db` main file | 20,451,328 B (980 rows, FTS 980) | 20,393,984 B (980 rows, FTS 980, FTS MATCH 'summary' = 13 before and after) | Every row. VACUUM saved only 57,344 B because freelist was 0 (see below). |
| `history.db-wal` | 4,148,872 B | 0 B | The WAL was already checkpointed by the graceful container stop (`docker compose stop` closes the last connection, which checkpoints). The VACUUM + explicit `wal_checkpoint(TRUNCATE)` confirmed it. |
| `audit.db` main file | 270,336 B (828 rows) | 290,816 B (828 rows) | Every row. The main file GREW by 20,480 B because checkpointing moved WAL pages into it (most WAL pages were overwrites of existing pages, not new data). |
| `audit.db-wal` | 4,132,392 B | 0 B | Reclaimed by the checkpoint. |
| Screenshots (12 PNGs) | 3,923,891 B | 3,365,719 B (-558,172, -14.2%) | Every screenshot, pixel-for-pixel. 8 of 12 shrank (Pillow `optimize=True`, lossless); 4 were already optimal and were left untouched. Originals backed up to `working.backups/bloat-winwin-20261118/screenshots/` (8 files). Verified by pixel-hash before/after. |
| `qwenpaw.log` | 1,389,438 B | 0 B (fresh log, growing again) | **NOT preserved — see the incident below.** The old log content was lost. |
| **Total on-disk saving** | — | **~8.9 MB** (both WALs ~8.3 MB + screenshots 0.56 MB + history VACUUM 0.06 MB) | — |

## Why history.db barely shrank (honest)

The main file is 98% live data: `conversation_history` is 4,883 pages
(19,532 KB) of the 4,993-page file; the FTS index is only ~224 KB
(`fts_data` 51 pages, `fts_docsize` 4, `fts_idx` 1, `fts_config` 1).
`PRAGMA freelist_count` was **0** — there are no free pages, so VACUUM
cannot reclaim space from the main file. The file IS the data (980
rows × ~21 KB). It cannot get smaller without deleting rows, which the
win-win rule forbids. The FTS external-content suggestion (DeepSeek)
would save almost nothing here because the FTS index is already small
(it does not store a duplicate copy of the text at this size). So the
real, honest outcome for history.db is: the WAL is reclaimed and the
file is verified intact, but the main file stays ~20 MB because that
is the history itself. The same applies to `audit.db` (main file
~270 KB, all live rows).

## The log loss (incident — owned plainly)

**What happened:** during the maintenance window the log rotation ran
`sudo gzip -c /data/home/qwenpaw/working/qwenpaw.log >
/data/home/qwenpaw/working.backups/bloat-winwin-20261118/qwenpaw.log.2026-11-18.gz`
and then `sudo truncate -s 0` on the live log. The `>` redirect runs
in the unprivileged user's shell, NOT under sudo, and the backup
directory was root-owned — so the redirect failed with "Permission
denied" (twice, including the fallback branch), the `.gz` was never
written, and the `truncate` then zeroed the live log anyway. The
original 1.39 MB log (2026-11-14 18:12 to 2026-11-18 13:42, ~4 days of
INFO lines) was lost. No backup existed anywhere (`docker logs` holds
only 13 supervisor lines, not the app log; `working.backups/` has no
log copy). This was my sequencing error: truncate ran before the
backup was verified.

**Impact:** diagnostic only. `qwenpaw.log` is runtime diagnostics
(session state updates, auth events, usage lines). It is NOT
conversation history (`history.db`, 980 rows, intact and verified),
NOT memory (`memory.db`, intact), NOT session state (`sessions/`,
intact), NOT user chats. No user-facing function is affected; the
container restarted cleanly and the log is growing again (18,783 B
within a minute of restart). But it IS a loss of data (log history),
which violates the "no loss" rule for this item, and it is recorded
here as a failure, not hidden.

**The fix (so it cannot recur):** `rotate-log.py` (in this directory,
installed on the machine at `/data/home/qwenpaw/rotate-log.py`) now
verifies the archive BEFORE truncating: it gzips the log, checks the
archive exists, is non-empty, and decompresses to exactly the
original byte count — and only then truncates the live log in place
(the app keeps its open handle, so no restart is needed). If the
archive cannot be created or written, it exits 1 and leaves the live
log untouched. `test_bloat_winwin_data.py` covers both paths (verified
archive + failed archive leaves the log untouched). A systemd timer
(`qwenpaw-log-rotate.timer`, daily 03:30 UTC, installed and enabled
on the machine) runs it; the script lives in `/data` (persistent) and
the timer unit in `/etc/systemd/system` (re-enable after a VM
rebuild). The timer was test-run once (log below the 5 MB threshold,
nothing rotated).

## journal_size_limit is NOT persistent (correction)

DeepSeek's recommendation and the first version of
`db_maintenance.py` assumed `PRAGMA journal_size_limit` is persistent
(stored in the DB header). **It is not.** Verified 2026-11-18 on
SQLite 3.45.1 (VM) and 3.46.1 (machine): a fresh connection reads -1
(no limit) even after another connection set it and wrote. So the
maintenance-time setting (1048576, confirmed on that connection) does
NOT bound future WAL growth. The durable bound is SQLite's
auto-checkpoint (~1000 pages, ~4 MB) — that is why both WALs sat at
~4.1 MB and why they will regrow to ~4 MB over time, then checkpoint.
A tighter durable bound needs the app to set the pragma on each DB
open (a source change in the derived image; follow-up, not claimed
here). `db_maintenance.py` and `test_bloat_winwin_data.py` now assert
the correct per-connection behaviour. The live WALs are currently 0
(post-maintenance) and will regrow to the ~4 MB auto-checkpoint
ceiling, which is the natural bound.

## What was done, step by step (so it is reproducible)

1. Screenshots first (live, no container stop — they are static files):
   `recompress_screenshots.py prepare` (as user, PIL) decoded each PNG,
   re-encoded with `optimize=True`, verified pixels identical, and wrote
   a manifest of the 8 that shrink. `apply_screenshots.py` (as user,
   `sudo` only for the copies) backed up each original, replaced it,
   and re-verified pixels. The first `sudo python3` attempt failed
   because root's Python has no Pillow (the user Python does) — the
   two-phase script is the fix for that.
2. Maintenance window (container stopped via `docker compose stop`):
   `db_maintenance.py` (sudo) backed up both DBs + WALs to
   `working.backups/bloat-winwin-20261118/db/`, verified the backup
   row counts, ran VACUUM + `wal_checkpoint(TRUNCATE)` on each, and
   verified row counts + FTS MATCH before/after. Then the log rotation
   (which failed as described above), then `docker compose up -d`.
3. Verified after restart: container healthy, console 200, log growing
   again, history rows 980, audit rows 828, memory.db schema v2 (see
   below).
4. Log rotation timer installed (see above).

## Memory v2 (the user's follow-up, also in this task)

The user asked (2026-11-18 ~12:57 IST) for memory search that costs
fewer tokens, is super fast, and is built on the latest trending
GitHub memory architecture — and for every new session to recall all
memory (continue where the last session left off). That is
`features/memory/facts.py` v2 (not a bloat item, but the same task):

- Researched the trending landscape (Nov 2026): Mem0 ~68K stars
  (vector + graph + KV, ADD-only extraction, hybrid retrieval),
  Zep/Graphiti ~32K (temporal knowledge graph), Letta ~25K
  (OS-tiered memory: core always-in-context + archival), Supermemory
  ~31K, Hindsight 91.4% LongMemEval (multi-strategy retrieval).
- Built from them, within the constraints (no new DB, no managed
  service, no embeddings, no new key, no local model, no data loss):
  **multi-signal retrieval** (BM25 + entity overlap + importance,
  weighted RRF, k=10, weights 1/2/2), **entity extraction**
  (rule-based, stdlib-only; auto-populated on add;
  `backfill-entities` for older facts), and **temporal validity
  windows** (`valid_from` / `valid_to`; `search --as-of DATE` is time
  travel). Cross-session recall (the handoff) already worked and was
  browser-verified 2026-11-18; v2 does not change it.
- Deliberately NOT added: semantic/vector search (needs an embedding
  model; none configured, local models forbidden, no cloud embedding
  key — a user decision), sleep-time consolidation (needs a
  background agent while idle; `consolidate.py` is the manual
  version), a graph DB (heavy; validity windows + entity overlap give
  the temporal + entity benefits without one).
- Tests: `features/memory/test_facts_v2.py`, 40 checks, all pass;
  v1 `test_facts.py` 41/41 still green (backward compatible);
  fail-first proven against origin/main v1 facts.py (crashes with
  `AttributeError: no attribute 'extract_entities'`).
- Live: pushed to origin/main (4 commits), synced via
  `sync-memory.py`; the live `memory.db` migrated v1 -> v2
  (schema_version 2, `valid_from` backfilled, 1 fact + 1 handoff
  preserved, history rows 980 untouched); live search returns
  `fused_score` + `entity_overlap` in 0.22 ms; live `--as-of` works;
  23/23 skills enabled. The one live fact has no entities (its text
  names none), so `facts_with_entities` is 0 — correct, not a bug.

## Tests

- `test_bloat_winwin.py` — 26 checks, telemetry removal (subagent;
  register as **T118**).
- `test_bloat_winwin_data.py` — 15 checks, this data layer (VACUUM
  preserves rows + FTS, WAL checkpoint, freelist-0 behaviour,
  journal_size_limit per-connection, PNG lossless, log rotation
  verify-before-truncate + failure path). Register as **T119**.
- `features/memory/test_facts_v2.py` — 40 checks, memory v2. The
  child claimed T118 for telemetry; this one needs the next free
  number — the parent decides (suggested **T120** if T118 = telemetry
  and T119 = data layer). `run-tests.py` / `TESTS.md` were NOT
  modified here (they carry unpushed T115/T116/T117 registrations);
  the parent handles registration.

## Files in this directory

| File | What it is |
|---|---|
| `README.md` | Source changes (telemetry) + what was left alone (subagent). |
| `DATA_LAYER.md` | This file: data-layer work + memory v2 + the log incident. |
| `qwenpaw-bloat-winwin.patch` | Telemetry stub patch (subagent). |
| `Dockerfile` | Derived image from gatefix3 (subagent). |
| `test_bloat_winwin.py` | Telemetry tests, 26 checks (subagent). |
| `test_bloat_winwin_data.py` | Data-layer tests, 15 checks (parent). |
| `db_maintenance.py` | The DB maintenance run on the machine (backup + VACUUM + checkpoint). |
| `recompress_screenshots.py` | Lossless PNG recompression, prepare phase (user Python + PIL). |
| `apply_screenshots.py` | Screenshot apply phase (sudo copies + pixel verify). |
| `rotate-log.py` | Log rotation (gzip + verify-before-truncate); installed on the machine + systemd timer. |
| `src/pristine/` + `src/patched/` | Telemetry stub pristine/patched copies (subagent). |
