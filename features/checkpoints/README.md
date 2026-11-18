# Checkpoints + rollback — per-run workspace snapshot (gap #7)

Gap #7 from the 2026-11-18 agent research (§2 gap 3, §6 recommendation 7;
Cline, Claude Code, OpenCode): before the first mutation in a run,
snapshot the workspace, tag it with the run ID, expose a restore
command. This is the recovery half of the approval system — one bad
`rm` or one bad write is unrecoverable without it.

## What already existed (verified, not assumed)

The research said QwenPaw "HAS shadow-git checkpoints for workspace
files". Verified against this repo (2026-11-18):

- **No shadow-git implementation exists in this repo.** A search of
  `features/` (Python, Markdown, JS) finds the word `shadow` only as
  `shadow.git` in one place: `features/reset/reset_guard.py`
  (`PROTECTED_NAMES = {".git", "shadow.git", "media"}`) — i.e. the
  reset tool *protects* a `shadow.git` directory if one exists. That
  is a name in an allowlist, not an implementation: no code here
  creates, reads, or restores from `shadow.git`, and no checkpoint
  tool exists anywhere in the repo.
- `shadow.git` is therefore **upstream-only**: it is a directory the
  QwenPaw agent itself (v2.3.0 on the machine) maintains inside a
  workspace. Whether it actually contains per-run checkpoints on the
  live machine was **not verified** — it needs a live check on the
  machine (`ls /data/home/qwenpaw/working/workspaces/default/`), which
  this task does not do.
- What the repo *does* already know about workspace checkpoints:
  `features/infra/19-import-export.md` and `workspace-export.py`
  exclude `checkpoints/` from exports by design, and the reset tool
  deletes `W/checkpoints/` as part of the Workspaces category.

So this feature builds the missing half in the repo itself, on
tarball snapshots — it does not claim, use, or depend on shadow-git.

## Why a tarball, not a git worktree/branch

The agent workspace (`working/workspaces/default/`) is usually **not**
a git repo. A branch would need repo setup first, would silently drop
empty directories and git-ignored files, and handles large binaries
and permission bits awkwardly. A gzip tarball captures the exact bytes
(including empty directories and modes) with no repo at all, and it is
verifiable: every file is sha256-checked on restore. A DeepSeek design
review (2026-11-18, deepseek-v4.1-flash-free) agreed, and contributed
three points adopted below: full-workspace drift enumeration by
content hash (not mtime), never delete post-snapshot files without a
safety net, and 0700/0600 permissions on the store.

## Snapshot format

Default store: `<workspace>/checkpoints/` — the same name upstream
already uses, so export/reset tooling treats snapshots consistently.
`--store` overrides it (e.g. a directory outside the workspace).

```
<store>/<run-id>.tgz    gzip tarball, members sorted, mtime zeroed
<store>/<run-id>.json   manifest (see below)
```

Manifest (`<run-id>.json`, mode 0600):

| Field | Meaning |
|---|---|
| `run_id`, `created_utc` | tag + UTC timestamp |
| `workspace` | absolute workspace path the snapshot was taken from |
| `files` | `{relpath: {size, sha256, mode[, link]}}` for every in-scope file |
| `file_count`, `total_bytes` | counts over the in-scope files |
| `skipped` | entries seen but NOT snapshotted, with a reason (e.g. a symlink escaping the workspace) |
| `excluded_dirs`, `excluded_file_suffixes`, `excluded_file_names` | the exclusion list that was applied |
| `tarball`, `tarball_sha256`, `tarball_bytes` | integrity of the tarball itself |

The store directory is created mode 0700; snapshot files are 0600.

## When a snapshot is taken

**Before the FIRST mutation in a run.** The agent (or operator) runs
`snapshot` once, with the run ID, before any tool writes to the
workspace. A second snapshot with the same run ID is a **no-op that
returns the existing snapshot** — the first (pre-mutation) state
always wins. Overwriting a pre-mutation snapshot with post-mutation
state would defeat the tool, so there is no `--overwrite`.

```bash
python3 features/checkpoints/checkpoints.py snapshot \
  --workspace /data/home/qwenpaw/working/workspaces/default \
  --run-id sess-20261118-1430
```

There is no lifecycle hook yet: until one is layered on the derived
image (a follow-up, like the memory skill), the agent takes the
snapshot by convention at run start. A snapshot is cheap — one pass
over the workspace, one gzip — and costs nothing when no run mutates
anything (no snapshot is taken).

## Restore safety rule

Restore returns the workspace to the **exact snapshot state**. Three
rules make that safe instead of destructive:

1. **Refuse on drift (default).** Restore enumerates the whole
   workspace and hashes every file. If anything was added, modified,
   or deleted since the snapshot, restore **refuses** (exit 2) and
   leaves the workspace untouched. Same bytes = no drift, even if the
   file was touched (content is what matters, not mtime).
2. **`--force` names what will be lost.** With `--force`, the CLI
   prints the full drift list first (`added:` / `modified:` /
   `deleted:` with paths) and only then proceeds. A restore that
   cannot say what it destroys does not run.
3. **Every restore takes a pre-restore safety snapshot first.**
   Before anything is removed, the current state is snapshotted as
   `pre-restore-<run-id>-<UTC timestamp>`. A restore is therefore
   itself reversible: restoring the safety snapshot returns the
   workspace to exactly where it was before the restore. If the safety
   snapshot cannot be taken, the restore aborts. `--no-safety-snapshot`
   skips this; it exists for a full store only, and is discouraged.
   Files created after the snapshot are removed by the restore — but
   they are preserved in the safety snapshot, never silently deleted.

Verification happens twice, before the workspace is touched: the
tarball's sha256 is checked against the manifest, and every extracted
file's sha256 is checked against the manifest after extraction to a
temp dir. A corrupt snapshot never half-restores. After the swap, the
workspace is re-hashed and must match the manifest exactly, or the
restore reports failure and names the safety snapshot holding the
prior state. Tar members are validated against path traversal and
symlink escapes (`filter="data"` on extract, plus an explicit member
check); a member that would escape the workspace aborts the restore.

```bash
# refuses when the workspace drifted since the snapshot
python3 features/checkpoints/checkpoints.py restore \
  --workspace /data/home/qwenpaw/working/workspaces/default \
  --run-id sess-20261118-1430

# proceeds, after printing exactly what will be lost
python3 features/checkpoints/checkpoints.py restore \
  --workspace /data/home/qwenpaw/working/workspaces/default \
  --run-id sess-20261118-1430 --force
```

## List command

```bash
python3 features/checkpoints/checkpoints.py list \
  --store /data/home/qwenpaw/working/workspaces/default/checkpoints
```

Prints run ID, UTC timestamp, file count, snapshot bytes, and tarball
bytes, newest first; flags a missing tarball or an unreadable
manifest instead of silently skipping the row.

## Exclusion list

Everything excluded, and why. The exclusion list is recorded in every
manifest, so a snapshot can always say what it left out.

| Excluded | Why |
|---|---|
| `checkpoints/`, `.checkpoints/` | the store itself — a snapshot must never contain its own snapshots |
| `history.db`, `history.db-wal`, `history.db-shm`, `history.db-journal`, and any `*.db-wal` / `*.db-shm` / `*.db-journal` | live SQLite must never be copied mid-write (the copy is corrupt/unusable); AGENTS.md forbids touching `history.db`. Rollback is **files-only** — history, chats, and sessions are NOT rolled back |
| `sessions/` | per-run session state (bloat audit: a 9.2 MB session file re-serialized every turn). Live state, not workspace content; restoring it would resurrect a dead run |
| `media/` | user-owned media, large binaries, protected from reset for the same reason; not agent work product |
| `digest/` | generated summaries; regenerable from history |
| `*.log`, `*.log.gz` | logs are diagnostics, unbounded, never restorable state (see the 2026-11-18 log-loss incident) |
| `__pycache__/`, `*.pyc`, `*.pyo`, `.pytest_cache/` | regenerable bytecode / test cache |
| `node_modules/`, `.venv/`, `venv/`, `.cache/` | regenerable, routinely hundreds of MB |
| `.git/` | not a repo snapshot; `.git` can be GBs and is not workspace content (if the workspace IS a repo, use git for that) |
| `*.tmp`, `*.swp`, `.swo`, `.DS_Store` | editor / temp files |
| Symlinks whose target escapes the workspace; sockets, FIFOs, devices | cannot be restored safely; recorded in the manifest's `skipped` list with a reason |

Secrets are **not** scrubbed from snapshots: scrubbing them would
make a restore silently leave stale credentials behind. Snapshots may
therefore contain secrets — that is why the store is 0700 / files
0600, and why snapshots must **never be committed, uploaded, or
copied off the machine**. A snapshot is 500 MB-capped by default
(`--max-bytes` overrides); a workspace over the cap is refused
rather than half-snapshotted.

## What is NOT verified live

- **Nothing in this feature has been run on the machine.** The tests
  below are machine-free, on temporary scratch directories. Live
  verification (Muse, after sync) still needs: snapshot + restore on
  the real workspace path, `list` output on the real store, and
  confirmation that `shadow.git` on the machine does or does not hold
  per-run checkpoints.
- **Settings Reset wipes snapshots.** The reset tool deletes
  `W/checkpoints/` as part of the Workspaces category, so a reset
  destroys the snapshots stored there. If snapshots must survive a
  reset, store them outside the workspace with `--store` (a
  follow-up; the default keeps them where export/reset already
  expect `checkpoints/` to be).
- **Rollback is files-only.** After a restore, `history.db` still
  records the run that produced the rolled-back files, and the
  memory fact store still holds facts from it. That mismatch is a
  known limitation, documented here, not a bug to discover later.
- **No per-run isolation.** Per-run branches doubling as isolation
  for parallel subagents (the research's second half of this gap) is
  NOT built: tarballs snapshot one shared workspace; two subagents
  writing the same workspace still collide. That needs per-agent
  workspaces first.
- **No lifecycle hook.** Nothing yet calls `snapshot` automatically
  at run start; it runs by convention until a hook is layered on the
  derived image.

## Tests

```bash
python3 features/checkpoints/test_checkpoints.py            # 48 checks, machine-free
python3 features/checkpoints/test_checkpoints.py --code /tmp/empty-checkpoints-stub.py
    # fail-first: 8 passed, 29 failed (no snapshot/restore exists)
```

Registered as **T127** (see `features/test-project/TESTS.md`).
The test proves, on a temporary scratch workspace only: (a) a
snapshot captures the files before mutation; (b) after mutation the
restore returns the exact original bytes; (c) restore REFUSES on
drift without `--force` and leaves the workspace untouched; (d)
restore with `--force` proceeds and prints what was lost; (e) list
shows the snapshot with run ID + timestamp + size; (f) the exclusion
list keeps caches/logs/live DBs/session state/node_modules/media out
of the snapshot and the tarball. Plus: same-run-id snapshot is a
first-wins no-op; the pre-restore safety snapshot makes a restore
reversible; a corrupt tarball refuses to restore; an escaping symlink
is skipped, not followed; an invalid run id is rejected; restoring a
missing snapshot fails; listing an empty store works.

One real bug was found by the test suite itself: the tarball writer
re-walked the workspace and looked up skipped entries (escaping
symlinks) in the scanned file list, raising `KeyError`. It now
iterates the scanned list. Fail-first proven against a stub file
with no implementation (8 passed / 29 failed, of the 37 checks that
run — F1–F8 cannot run with no manifest/tarball to inspect, and
S2–S4 cannot run with no safety snapshot; the 8 that pass are the
negative checks that a missing implementation also satisfies, e.g.
refusing an invalid run id or a missing snapshot).

## Machine sync (Muse does this)

Repo file → live path (same pattern as `features/memory/`):

| Repo | Live path on the machine |
|---|---|
| `features/checkpoints/checkpoints.py` | `/data/home/qwenpaw/working/memory-tools/checkpoints.py` |
| `features/checkpoints/test_checkpoints.py` | `/data/home/qwenpaw/working/memory-tools/` |

No container restart, no write to `auth.json`, `.env`, or any user
chat. The tool only ever reads/writes inside the workspace it is
pointed at plus its own store directory.
