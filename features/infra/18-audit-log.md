# #18 — Audit log

Status: **Done (report) / Partial (coverage).** QwenPaw already logs more
than was assumed; the report script reads it. Coverage is honestly narrow.

## What QwenPaw already logs (verified live 2026-11-15)

### 1. Governance audit DB — exists, narrow

`working/governance/audit.db`, one table:

```sql
CREATE TABLE audit_events (
  ts            INTEGER NOT NULL,
  workspace_dir TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  target        TEXT NOT NULL,
  decision      TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  extra         TEXT NOT NULL DEFAULT '{}'
)
```

At check time: **5 rows**, all `Read … allow` (SOUL.md, MEMORY.md,
PROFILE.md) from one console session. This table records **tool-guard
decisions only** — what the agent was allowed/denied to do with tools and
files. It does **not** record logins, chat content, sent messages,
config changes, or console clicks.

### 2. Application log — exists, verbose

`working/qwenpaw.log` (181 KB, 1,080 lines at check time). INFO lines for
sessions, agent startup (`Agent startup complete: 2/2 agents started`),
model use (`model=kilo/kilo-auto/free tools=26`), token usage, and
ERROR/WARNING lines (e.g. mailbox skill skipped, proxy-header warnings).
No structured audit fields; it is a debug log, not an audit trail.

### 3. What does NOT exist

- No login-attempt log exposed by the console (rate limiter keeps its own
  state; failed logins are not in `audit_events`).
- No per-user action log (QwenPaw has single-user auth).
- No export/retention policy, no tamper evidence, no row-level security.

## What is built

`scripts/audit-report.py` (read-only; run on the machine with sudo):

```
sudo python3 scripts/audit-report.py [--lines 200] [--events 20] [--out report.txt]
```

It prints: audit DB row counts by decision/tool + latest events;
log-tail ERROR/WARNING counts + last 15 lines; and the manual-append log
(see below).

## Manual-append convention (fills the gap honestly)

Operator actions that QwenPaw does not log (config edits, restarts,
key rotations, template imports, access grants) go in:

`working/governance/manual-audit.jsonl` — one JSON object per line:

```json
{"ts": "2026-11-15T12:00:00+05:30", "actor": "rohan", "action": "import-template", "target": "workspaces/research-assistant", "detail": "imported from features/infra/templates/research-assistant", "result": "ok"}
```

Rules: append-only (never rewrite history); `ts` in ISO 8601 with
timezone; `actor` is a person, not a system; `result` is `ok`/`failed`.
The file was created on the machine with a bootstrap entry by this build
(2026-11-15 01:05 IST, verified present). `audit-report.py` includes its
last 50 entries. Live run 2026-11-15: report printed 5 audit rows
(Glob 1, Read 4, all `allow`) and, over the last 120 log lines, 14 ERROR
/ 6 WARNING — the ERRORs are almost all skill skips (`mailbox`:
qwenpawmail not configured; `build-page`: `CLOUDFLARE_API_TOKEN` not set;
`github`: `GITHUB_TOKEN` not set), plus one Astra stream-startup timeout
that retried and succeeded. Those skill skips are pre-existing config
gaps, not failures caused by this build.

## Limits, stated plainly

- **No RLS, no encryption at rest, no tamper evidence.** The audit trail
  is a SQLite file + a JSONL file on the machine's disk, root-owned.
  Anyone with machine root can read or rewrite both. A tamper-evident log
  needs an external store (e.g. append-only object storage), which does
  not exist on InstaBox Free.
- **No real-time alerting.** This is a pull report, not a watcher.
- **Retention is manual.** Nothing rotates `audit.db` or `qwenpaw.log`;
  the log grows unboundedly. If it gets large, archive it into
  `working.backups/` (coordinator step).
