# #19 — Import / export / templates

Status: **Done.** Export/import script built and tested on a copy of the
live QA workspace (never the live workspace). 3 starter templates built.

## What is built

### `features/infra/scripts/workspace-export.py`

Usage (run on the machine via `ib.py exec`, or anywhere with a workspace
copy):

```
python3 workspace-export.py export <workspace-dir> <out.tgz>
python3 workspace-export.py import <archive.tgz> <dest-workspace-dir> [--backup-dir DIR]
python3 workspace-export.py verify <archive.tgz>
```

- **Export allowlist only** (identity + prompts + skills, no history):
  top-level `agent.json`, `SOUL.md`, `PROFILE.md`, `MEMORY.md`,
  `AGENTS.md`, `HEARTBEAT.md`, `CONTACTS.md`, `BOOTSTRAP.md`,
  `MAIL_TRIAGE.md`, `skill.json`, `jobs.json`, and the `skills/` directory.
- **Always excluded**: `history.db*`, `sessions/`, `checkpoints/`,
  `state/`, `memory/`, `mem_agent/`, `mem_session/`, `mem_metadata/`,
  `media/`, `resource/`, `drivers/`, `digest/`, `*.shm`, `*.wal`.
  Export never carries chats, sessions, or credentials.
- Safety checks: source must contain `agent.json` + `SOUL.md`; the
  tarball carries a `manifest.json` (agent id, exported_at, per-file
  sha256); import verifies every hash, refuses path traversal in tar
  members, refuses to overwrite an existing workspace unless
  `--backup-dir` is given (existing dir is moved aside first, never
  deleted).
- The script never touches the live workspace unless you point it at one.
  The documented test flow exports a **copy**.

### Test evidence (2026-11-15, live machine)

- Copied `/data/home/qwenpaw/working/workspaces/QwenPaw_QA_Agent_0.2` to
  `/tmp/ws-test-src` (a copy; live workspace untouched).
- Ran export on the copy → tarball created; `verify` passed (manifest
  hashes matched).
- Ran import into `/tmp/ws-test-dst` → identity files (`agent.json`,
  `SOUL.md`, `PROFILE.md`, `AGENTS.md`) byte-identical to the copy;
  `history.db*` and `sessions/` confirmed absent from the archive.
- Live workspace checksums were not modified (no writes to
  `/data/home/qwenpaw/working/workspaces/` at any point).

### `templates/` — starter agent templates

Three English templates, each a ready-to-import workspace folder
(`agent.json` + `SOUL.md` + `PROFILE.md` + `MEMORY.md` + `AGENTS.md`).
`workspace_dir` in each `agent.json` is a placeholder
(`/app/working/workspaces/<id>`) — set the real id on import.

| Template | Purpose |
|----------|---------|
| `research-assistant/` | Web research + summarising, cites sources, never invents citations |
| `household-manager/` | Routines, reminders, shopping lists, home admin for Rohan |
| `code-helper/` | Code review + small fixes, tests before claiming done, no destructive commands |

Import a template with:
`python3 features/infra/scripts/workspace-export.py import` — no: templates are plain
folders, copy one to `/data/home/qwenpaw/working/workspaces/<new-id>/`
on the machine (coordinator step — creating a workspace is a write to the
live tree, so it is not done by this build), then restart is required for
QwenPaw to preload it (restart needs user approval; not done here).
New workspaces are **not** auto-discovered without a restart — the
multi-agent manager preloads agents at startup (verified in the log:
`Agent startup complete: 2/2 agents started`).

## Limits (honest)

- Export is identity/prompts/skills only. Chat history, sessions, memory
  stores (`mem_*`, `memory/`), checkpoints and media are deliberately
  **not** portable by this tool. Full backup remains `scripts/backup.sh`
  / snapshots.
- Import does not register the agent in `config.json`
  (`agents.profiles` / `agent_order`) — that file must never be edited by
  a script without approval, and the agent must be picked up at startup.
  Registration is a coordinator step, documented in `11-fleet-manager.md`.
