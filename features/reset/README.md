# Settings Reset

A Settings page (`/reset` on the console) where the user picks categories to
wipe, sees exactly what will be deleted, and confirms with a typed `DELETE`
plus a checkbox. Destructive by design — and fail-closed by design.

## Build status (2026-11-18)

**Code complete, machine-free tests green, NOT yet live-verified.**
Built by Muse + DeepSeek (design) / Muse (code), no AutoClaw. Files:
`features/reset/` (broker, categories, guard, harness, selftest, service,
env example) + `pages/public/reset/` (router, page, UI, route README) +
`_worker.js` wiring. Tests: T110 (harness, 43 checks) + T111 (selftest,
20 checks), both PASS; full machine-free suite 21 PASS / 4 known
NEEDS-REBUILD. Secret-scan clean. Not yet deployed, not yet live-verified
— see "Live verify" in the test plan below.

Three real bugs found by the harness, all fixed in the build commit:
1. **Keep-alive desync** — a 401 returned without reading the request body
   left bytes on an HTTP/1.1 keep-alive connection; the next request was
   parsed as the body and answered 501. Fix: `do_POST` reads the body
   before any auth decision.
2. **Threading lock defeated the flock** — a `threading.Lock` around the
   flock serialized two concurrent executes, so the second waited and then
   succeeded instead of getting 409 busy. Fix: the flock IS the gate; the
   threading lock is gone.
3. **Preview double-counted MEMORY.md** — when both memories and lessons
   were selected, the preview counted the file once as a delete and once
   as a section rewrite (full file size). Fix: `_compute_plan` skips
   lessons when superseded, and `_target_size` for a section now returns
   the actual bytes the rewrite frees (not the whole file), so preview
   bytes == execute bytes_freed exactly.

## The one rule

**Deletion is allowlist-only.** Every category is a literal list of absolute
paths. A path that matches no category row is never removed. There is no
denylist anywhere. If a category, a path, or a confirmation is wrong, the
run aborts and nothing is deleted.

## Categories (non-overlapping)

Glob root `W = working/workspaces/*` (default + QwenPaw_QA_Agent_0.2).
`RESET_ROOT` is `/data/home/qwenpaw` on the machine. D1 `qwenpaw-state` is
never written by Reset — vault items, board tickets, sleep/wake state
survive every category.

| Category | Exact deletable paths | Explicitly excluded (stays) |
|---|---|---|
| **Memories** | `W/MEMORY.md` · `W/memory/` · `W/mem_session/` · `W/mem_agent/` · `W/mem_metadata/{file_catalog,file_graph,file_store,keyword_index}` | `PROFILE.md`, `SOUL.md`, `AGENTS.md` |
| **Skills** | `W/skill.json` · `W/skills/` (all dirs) · `working/skill_pool/` | `*.lock` files (never deleted while running), `working/plugins*`, `plugin_provisions`, `plugin_runtime` |
| **Lessons** | `W/MEMORY.md` — section rewrite only (`## Important decisions and lessons` … next `##`), no file deletion | rest of `MEMORY.md` |
| **Models** | `working.secret/providers/custom/*.json` EXCEPT the active provider | `providers/builtin/*.json`, `providers/custom/` dir itself, `envs.json`, `chatgpt/`, `auth.json`, `vault-broker.token`, `active_model.json` (never rewritten, never deleted) |
| **Logs** | `working/qwenpaw.log` (+ `qwenpaw.log.*` rotations) | `governance/audit.db`, `token_usage.json`, `working/logs/reset.log` (the audit trail), journald, docker logs |
| **Sessions** | `W/sessions/` · `working/channel_state/` | `W/history.db*`, `W/*.lock` |
| **Chats** | `W/chats.json` (truncate in place) · `W/history.db` (+ `-wal`, `-shm`) via the §Chats sequence | `W/checkpoints/`, `W/media/` |
| **Workspaces** | Shell only, does NOT imply children: `W/{agent.json,AGENTS.md,BOOTSTRAP.md,.bootstrap_completed,CONTACTS.md,MAIL_TRIAGE.md,PROFILE.md,SOUL.md,HEARTBEAT.md,jobs.json}` · `W/resource/` · `W/drivers/` · `W/digest/` · `W/checkpoints/` · `W/*.png` · `working/{jobs.json,HEARTBEAT.md}` · `working/profile/avatars.sqlite3` | `W/media/` (user-owned), `W/{MEMORY.md,skill.json,chats.json,history.db,sessions/,skills/}` — those belong to their own category |
| **Backups** | `working.backups/` (whole tree) | nothing else on the box |

Rules that make this non-overlapping:
- **Workspaces ≠ parent.** It never implies Memories/Skills/Chats/Sessions.
  If the user ticks Workspaces only, the agent keeps its memory, skills, and
  chat history. The UI says so in one line.
- **Lessons ⊆ Memories.** If Memories is ticked, Lessons is force-ticked and
  disabled. Lessons alone = surgical `MEMORY.md` section rewrite (the only
  category that isn't a file delete). The section is currently an empty
  placeholder, so Lessons alone is a no-op until content exists.
- **Models is fail-closed.** It never rewrites `active_model.json` and never
  deletes the active provider's JSON. To remove the active provider, switch
  the active model first (Settings → Models), then re-run. This respects the
  workspace `MEMORY.md` preference "No Kilo default model" — Kilo is never
  used as a fallback default, even though its gateway works keyless.
- **Locks are never deleted while the container runs** (`history.db.migration.lock`,
  `.scroll-migration.lock`, `.skill.json.lock`).

## Chats — the history.db sequence (no restart)

Why not `rm`: unlink under a live process is a silent no-op. QwenPaw keeps
`history.db` open, so the inode survives; the agent keeps appending to the
unlinked file, the reset reports success, and on the next restart the
"deleted" history vanishes with the last container — or the file reappears
from `-wal` replay. Same for `chats.json` if replaced by `rename()` (new
inode, live fd still writes the old one). And `-wal`/`-shm` are live;
unlinking them corrupts the running connection.

Sequence (the reset broker runs as root on the host; no `docker exec` needed):
1. **Gate.** `flock` a reset lockfile; refuse if held. Check the agent is idle
   (`jobs.json` + `HEARTBEAT.md` idle and `history.db-wal` not growing over a
   5 s window). Busy → refuse with "agent active, retry".
2. **Snapshot.** Copy `W/chats.json` to `working.backups/reset-<ts>/chats.json`
   and record `stat` sizes of `chats.json`, `history.db`, `-wal`, `-shm` (for
   the bytes-freed report).
3. **Logical clear of history.db** — keep the same inode, never unlink:
   `sqlite3` → `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;` → enumerate
   `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
   and `DELETE FROM "<t>"` for each (schema-agnostic) → `DELETE FROM sqlite_sequence;`
   → `COMMIT;` → `PRAGMA wal_checkpoint(TRUNCATE);` → `VACUUM;` for the reclaim.
   `VACUUM` needs an exclusive lock — if it returns `SQLITE_BUSY`, skip it and
   report `bytes_freed: 0, rows_cleared: N` (logical clear, space not reclaimed).
   Do not retry-loop against the live agent.
4. **chats.json — truncate in place, not rename:** copy contents aside, then
   `open(O_WRONLY|O_TRUNC)` and write `{}`. Same inode ⇒ the live fd sees an
   empty file, and a stale in-memory rewrite is *observable* rather than invisible.
5. **Verify + reconcile marker.** Re-open history.db, assert 0 rows; re-`stat`.
   Write `working/.reset_pending_reconcile` with the chats.json hash. On the next
   Reset/preview, if `chats.json` is non-empty again, the agent re-persisted its
   in-memory chat list → report `chats: reverted_by_live_process` and offer step 6
   (never silently claim success).
6. **Fallback, only when step 5 fires (or the user explicitly asks for a guaranteed
   wipe)** — one controlled restart, justified because it is the only way to drop
   the in-memory chat list: `docker compose stop qwenpaw` → `rm -f W/chats.json
   W/history.db{,-wal,-shm}` (safe now: no open fds) → `start qwenpaw` → verify
   the service is active, `providers/builtin/kilo.json` present, `active_model.json`
   resolves, workspaces intact. **Cost:** full container downtime (tens of seconds)
   and every in-flight agent turn is lost. This is the only restart Reset may ever
   perform, and only inside the Chats confirmation, never as a side effect of
   another category. The restart is never automatic — the UI offers it and the user
   approves it explicitly.

Order matters: history.db logical clear **before** chats.json truncate, so a crash
mid-way leaves metadata pointing at empty history rather than history orphaned
behind an empty index. Re-running the whole sequence is idempotent — step 3 on an
empty DB is a no-op, step 4 on `{}` writes `{}`.

## Auth + transport

A dedicated service, not the vault broker. The vault broker is scoped to vault
paths + the vault token + D1; widening it to filesystem deletion breaks least
privilege. Separate unit = separate token, separate allowlist, separate audit log.

Chain:
1. **Pages route** `pages/public/reset/router.js` (`POST /reset/api/preview`,
   `POST /reset/api/execute`). First line: `authenticate(request, env)` from
   `pages/public/machine-control.js` — server-to-server token header **or**
   forward the caller's Bearer token to the console's `/api/cron/jobs` and trust
   only a 200 with a JSON body. Never `/api/auth/status`. Fail → 401, no forward.
2. **Forward** to `env.RESET_BROKER_URL` (`http://172.18.0.1:8895`), headers
   `X-Reset-Token: env.RESET_TOKEN`, `X-Request-Id: <uuid>`, `User-Agent:
   qwenpaw-reset/1`. Port 8895: 8896 is the vault broker, 8897/8898 are the MCP
   proxies, 8899 is the Camoufox bridge.
3. **Broker** (`features/reset/reset-broker.py`, stdlib only) rejects missing/wrong
   token with constant-time compare → 401. It accepts **only** a fixed category
   enum + `confirm`/`ack`/`plan_id` — never client-supplied paths, never a shell.
4. **Runtime identity**: `User=root` (workspace files are root-owned) contained by
   `ProtectSystem=strict` + `ReadWritePaths=` listing only the allowlist roots,
   `PrivateTmp=yes`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=`, no network
   egress binding except the listener.
5. **Token provisioning, once**: generate `openssl rand -hex 32` → machine
   `/data/home/qwenpaw/.env` (`RESET_TOKEN=…`), Pages secret `RESET_TOKEN` on both
   projects + `RESET_BROKER_URL`, and
   `/data/home/qwenpaw/working.secret/reset-broker.token` (0600) for parity with
   `vault-broker.token`. Never touches `auth.json`. Same shape as
   `VAULT_BROKER_TOKEN` / `SLEEP_TOKEN`.

## Confirmation flow

- **Preview** — `POST /reset/api/preview {categories:[…]}` → per category
  `{id,label,paths[],bytes,files,top_entries[],warnings[]}` + totals +
  **`plan_id = sha256(sorted paths + sizes + mtimes)`**. Preview never deletes;
  sizes computed live by walking the same allowlist the executor uses.
- **UI** — `/reset` page: checkbox per category with live size + file count +
  warning line (Chats: "all conversation history, irreversible"; Backups:
  "removes your only rollback"; Chats also "requires stopping the agent" only if
  the restart fallback is chosen).
- **Mandatory final confirmation = type-to-confirm + checkbox, both.** Type exactly
  `DELETE` **and** tick "I understand this cannot be undone"; the execute button
  stays disabled until both, and `plan_id` is echoed from the preview.
- **Execute** — `POST /reset/api/execute {categories, confirm:"DELETE", ack:true,
  plan_id}`. Broker re-previews internally; if the recomputed `plan_id` differs →
  `409 {"error":"plan_changed"}` and nothing is deleted. Missing/wrong confirm or
  ack → `400 {"error":"confirmation_required"}`, nothing deleted. Single-writer
  `flock`; concurrent execute → `409 {"error":"busy"}`.
- **Report** — `200` (all ok) / `207` (partial):
  `{status:"ok"|"partial"|"failed", plan_id, request_id, per_category:[{id,status,
  bytes_freed,files_deleted,errors:[{path,error}],skipped:[{path,reason}]}], totals}`.
  Also appended as one JSONL line to `working/logs/reset.log` (never deleted by
  the Logs category — it is the audit trail).
- **Partial failure**: continue-on-error *within* a category and across categories;
  abort the whole run only on precondition failures (lock, `plan_changed`,
  allowlist violation, broker-side precondition). Every category is independently
  reported; no rollback (there is no undo — that is why the confirmation is heavy).
- **Idempotency**: a missing path is `skipped:"not_found"`, not an error; re-running
  a completed reset returns `status:"ok"`, `bytes_freed:0`, all categories
  `nothing_to_delete`. `X-Request-Id` replay within the last 100 ids returns the
  cached report with `200` and deletes nothing.
- `dry_run:true` is the default unless `confirm`+`ack`+matching `plan_id` are present.

## Never-delete — allowlist only, fail-closed

Three layers, no denylist anywhere:
1. **Route**: category enum only; zero client path input.
2. **Broker**: each category = a literal list of absolute paths. Every path is
   `realpath`-resolved and must be (a) under one of `ALLOWED_ROOTS`, (b) not equal
   to nor under any `PROTECTED` entry, (c) free of symlinks at any component,
   (d) not a mount point. Anything outside the literal list → `path_not_allowed`
   and the **whole run aborts**. Unlisted = undeletable, by construction.
3. **Kernel**: `ProtectSystem=strict` + `ReadWritePaths=` = the allowlist roots only,
   so even a broker bug cannot write outside them.

`PROTECTED` (checked before every category; a selected category that would touch
one → `409`, nothing deleted):
- `working.secret/auth.json`, `working.secret/vault-broker.token`,
  `working.secret/reset-broker.token`, `working.secret/chatgpt/`,
  `working.secret/providers/builtin/kilo.json`
- `/data/home/qwenpaw/.env` and any `.env*` in the tree
- `working/governance/audit.db` (governance audit trail — survives by design)
- the vault D1 data (`qwenpaw-state`): the broker has no D1 binding and no CF API
  token in its env, so it structurally cannot touch it
- `working/workspaces/*/media/` (user-owned)
- `/data/home/qwenpaw/vault/`, `sleepwake/`, `codemode/`, `computer/`,
  `terminal-server.py`, `*.service`, `docker-compose.yml`
- the repo clone + all `.git`/`shadow.git`
- `features/reset/*` (broker's own code/log), systemd units, Pages project
- `working/logs/reset.log` (the audit trail)
- every active provider file; `active_model.json` is never deleted or rewritten

## File layout

```
features/reset/README.md                     # this design doc
features/reset/reset_categories.py           # THE category→paths table (pure data, no I/O)
features/reset/reset_guard.py                # allowlist/never-delete/realpath/symlink checks (pure fns)
features/reset/reset-broker.py               # stdlib HTTP server, 172.18.0.1:8895, token + lock + report
features/reset/qwenpaw-reset-broker.service  # systemd unit, hardening flags
features/reset/reset.env.example             # RESET_TOKEN=, RESET_BIND=172.18.0.1:8895, RESET_ROOT=
features/reset/harness-reset.mjs             # machine-free test harness
features/reset/test-fixtures/build-tree.mjs  # builds the fake /data tree in a tmpdir
pages/public/reset/router.js                 # routes, authenticate(), forward, 401/409/207 mapping
pages/public/reset/ui.js                     # category list, plan_id, type-DELETE + checkbox gate
pages/public/reset/index.html                # page shell served at /reset
pages/public/reset/README.md                 # route contract
```
Edits: `pages/public/_worker.js` (wire `/reset/*`; esbuild bundles the relative
import, no build change), `features/test-project/TESTS.md` (T-rows), and
`pages/public/machine-control.js` is **imported, not modified**.

## Test plan

`node features/reset/harness-reset.mjs` — no machine, no Docker, no network:
starts the broker on `127.0.0.1:0` with `RESET_ROOT=$(mktemp -d)` over a fake tree
(fake `chats.json`, a real sqlite `history.db`, screenshots, `auth.json`, `.env`,
`kilo.json`, a symlink to `/etc`), `authenticate()` stubbed.

1. anon → 401; wrong token → 401; right token, no session → 401.
2. allowlist: `auth.json`, `.env`, `providers/builtin/kilo.json`, `../../etc/passwd`,
   the escaping symlink → 403 `path_not_allowed`; **tree hash identical before/after**.
3. unknown category id → 400.
4. preview accuracy: bytes/counts equal an independent walk; `plan_id` stable
   across calls, changes after touching a file.
5. execute without `confirm`/`ack`/`plan_id` → 400 `confirmation_required`,
   nothing deleted.
6. stale `plan_id` → 409 `plan_changed`, nothing deleted.
7. happy path → 200, per-category report, `bytes_freed` == preview, files gone,
   protected files still present.
8. idempotency: same `X-Request-Id` → cached report; fresh id → `ok`,
   `nothing_to_delete`, 0 bytes.
9. partial failure: one undeletable dir → 207, other categories still complete,
   error listed.
10. concurrency: second execute → 409 `busy`.

T-rows in `features/test-project/TESTS.md`: **T-RESET-1** auth (1) ·
**T-RESET-2** allowlist/never-delete (2,3) · **T-RESET-3** preview+plan_id (4) ·
**T-RESET-4** confirmation required (5,6) · **T-RESET-5** idempotency (8) ·
**T-RESET-6** partial failure (9) · **T-RESET-7** concurrency (10). Each row = the
exact command + expected exit 0.

**Live at deploy, nothing real destroyed:**
- `curl` from inside the container to `http://172.18.0.1:8895/health` → 200;
  POST `/execute` anon → 401.
- Preview with **zero** categories → 200, counts only, zero writes (hash
  `working.secret/`, `kilo.json`, `audit.db`, `media/` before/after — prove
  byte-identical).
- **Full-category rehearsal**: second broker on `127.0.0.1:8898` with
  `RESET_ROOT=/tmp/reset-rehearsal`, populated by a `cp -a` of the real subtree →
  execute all 9 categories there. Proves every category's destructive path without
  touching the live machine.
- Then one real category: **Backups** only (copies-of-copies, regenerable). Verify
  reported `bytes_freed` ≈ `du -sb working.backups`, and prove the protected set
  unchanged.
- Chats/`history.db` live test: only after the user approves the restart window.

## Design history

- 2026-11-18: DeepSeek design (brief `~/workspace/reset-design-brief.md`,
  outputs `/tmp/reset-design-short.txt` + `/tmp/reset-design-rest.txt`) + Muse
  reconciliation. DeepSeek's two long calls returned empty and one 503'd (service
  busy); short prompts worked. Corrections by Muse: port 8897→8895 (8897 is the
  second MCP proxy); Models never rewrites `active_model.json` and never deletes
  the active provider (workspace `MEMORY.md` says "No Kilo default model"; Kilo
  gateway works keyless but must not be the fallback); Chats uses the logical-clear
  sequence, restart only as an approved fallback (DeepSeek's two outputs
  contradicted each other here — part 1's sequence wins, it keeps the inode);
  Logs = `qwenpaw.log` only (not `audit.db`, not `token_usage.json`); Skills
  excludes `*.lock`; Lessons targets the real heading
  `## Important decisions and lessons`.
