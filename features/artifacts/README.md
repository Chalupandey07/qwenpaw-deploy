# Artifacts library — gap #14 (provisional T138)

An index, not new infrastructure. Walk a workspace directory plus
sent-file metadata plus history.db, store name / slug / date / size /
type / source in SQLite, and expose one searchable static page.
Backfill covers files that were sent before the index existed.

Built 2026-11-18. English only, no China endpoints, cloud LLM only,
InstaBox Free only. Stdlib-only Python, no network. Nothing on the
machine was modified; no container restart; no secrets in git.

## What already existed (verified, not assumed)

- **The open-work list already exists** (`features/board/README.md`
  #20: `open-work.html` + `refresh-open-work.py` + `follow-ups.md`,
  snapshot-based). It is **not** rebuilt here, and no live open-work
  feed is promised: snapshot + refresh is the ceiling on Free (no
  inbound route, Pages is static; near-live via Worker/D1 + cron is
  the best achievable and is out of scope here).
- The artifacts library itself did **not** exist: the board README
  records "no agent-produced artifacts yet, so the page lists recent
  workspace files instead". This feature is the library half of gap
  #14 only (evaluation `~/workspace/all-20-gaps-evaluation-2026-11-18.md`,
  gap #14 row + todo #7).

## Files

| File | What it is |
|---|---|
| `artifacts.py` | Indexer + search + backfill + page renderer (CLI) |
| `test_artifacts.py` | Machine-free test, provisional **T138 — 44/44** |
| `artifacts.html` | Shipped page (generated, 0 rows — regenerate on the machine) |
| `README.md` | This file |

## Usage

```bash
# Index a workspace (walk + optional backfill in one pass)
python3 artifacts.py index --workspace /data/home/qwenpaw/working/workspaces/default \
    --db artifacts.db --history /data/home/qwenpaw/working/workspaces/default/history.db \
    --sent-files sent.json

# Backfill only (files sent before the index existed)
python3 artifacts.py backfill --db artifacts.db \
    --workspace /data/home/qwenpaw/working/workspaces/default \
    --sent-files sent.json --history .../history.db

# Search (JSON)
python3 artifacts.py search --db artifacts.db --query "report"

# Render the searchable page (static, works from any static host)
python3 artifacts.py render --db artifacts.db --out artifacts.html
```

Sent-file metadata is a JSON list of
`{"path": "rel/path.png", "sent_at": "...", "session_id": "...",
"channel": "console"}` records — one per file the agent already sent.
Only files that still exist under the workspace are indexed; a
missing file is skipped, not recorded.

## Schema (`artifacts` table in the index SQLite file)

`slug, name, path, date, size_bytes, type, source, session_id,
indexed_at`, with `UNIQUE (path, source)` and indexes on slug, type,
date, name. The idempotency key is `(path, source)`: re-indexing the
same file from the same source updates the row in place and never
creates a duplicate. A file can hold several rows — one per source
(e.g. `workspace` + `sent` + `history` for the same path).

- **slug:** lowercase, non-alphanumerics collapsed to one hyphen;
  a second path with the same slug gets `-2`, `-3`, …
- **type:** from the extension (document / image / data /
  spreadsheet / presentation / code / audio / video / archive,
  else `other`).
- **date:** file mtime for workspace rows, `sent_at` for sent rows,
  the history row's `created_at` for history rows.
- **source:** `workspace` (walk), `sent` (sent-file metadata),
  `history` (path mentioned in history.db content).

## history.db is read-only — the guarantee, not a promise

- Opened as `file:<path>?mode=ro` (URI) with a 5 s busy timeout and
  an authorizer that denies every mutating SQLite action, mirroring
  `features/memory/recall.py` (`open_readonly`).
- Only file-path references are matched, and only against files that
  actually exist on disk (a path regex cannot see spaces in names
  like "Meeting Notes.md", so the matcher checks each real workspace
  file's relative path / name against the content). No message content
  enters the index — only name, date, size, type, source, session id.
- The test proves it: fixture history.db hash and mtime are identical
  before and after backfill, and no `-wal` / `-journal` file appears.

## What the walk skips (deliberately)

Hidden files/dirs, `.git`, `__pycache__`, `node_modules`, venvs,
`history.db*`, the index DB itself, `*.lock`, and symlinks that
escape the workspace root (never followed). A mentioned file that no
longer exists on disk is skipped.

## Search

Token search over name, path, type and source, case-insensitive,
every token must match (AND); `%` / `_` in the query match literally.
The rendered page embeds the rows as JSON and filters them with the
same AND rule in the browser — no server, no fetch.

## Honest limits

- **Snapshot, not live.** The page says so in its header. Re-run
  `index` + `render` to refresh. A live feed would need an inbound
  route the Free machine does not have.
- **Backfill is only as good as its inputs.** History backfill finds
  a file only if its path or name appears in conversation content;
  sent backfill needs the sent-file metadata JSON to exist. Neither
  recovers a file that was sent and then deleted from the workspace.
- **DeepSeek design help was attempted and failed:** one call to
  `deepseek-v4.1-flash-free` via `seek.py` returned malformed JSON
  (provider response was not valid JSON) and was not retried — the
  design here was verified against the repo instead
  (`features/memory/recall.py` read-only pattern,
  `features/board/refresh-open-work.py` metadata-only history reads).
- **Not verified live:** no machine deploy, no browser check (the
  machine was suspended, cooldown until ~16:36 IST, 2026-11-18).
  The shipped `artifacts.html` is a generated 0-row page; the real
  index + page must be generated on the machine after it unlocks.

## Tests

`python3 test_artifacts.py` — **44/44**, fail-first proven
(`--code /tmp/empty-artifacts-stub.py` fails: no `init_db`).
Covers the T138 brief: (a) walk indexes every fixture file with
full metadata, (b) search finds the right artifact and misses the
wrong one, (c) sent backfill picks up a pre-index file, (d)
re-indexing adds zero rows, (e) history.db hash/mtime unchanged and
no journal files; plus history backfill, slug-collision dedupe,
hidden-file / symlink exclusions, render + both CLIs, bad inputs.
