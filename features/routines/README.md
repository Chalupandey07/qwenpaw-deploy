# Routines — QwenPaw on InstaBox Free

Date: 2026-11-15. Status: Worker live; native routines NOT yet created (they need
a logged-in console session — see "How to add a routine").

## TL;DR — the design, and why it is this way

QwenPaw v2.3.0 **already has a routines system built in**: an APScheduler
cron manager (`/app/src/qwenpaw/app/crons/`), a `jobs.json` v2 file per
workspace, a `POST /api/cron/jobs` API, run history, pause/resume/manual-run,
and a heartbeat job. The earlier assumption ("QwenPaw has no scheduler")
was wrong. So the scheduler of record is **native QwenPaw cron jobs**.

The Cloudflare Worker in `worker/` (`qwenpaw-routines`) is the **wake +
history layer** around it: on InstaBox Free the machine pauses after 30 min
idle, so a native cron job alone would often miss its slot. The Worker
probes the public URL every 30 min and at 07:00 IST daily, which counts as
activity and keeps the machine awake (the keepalive Worker already does
this every 5 min; this Worker adds routine-aware logging). It does **not**
deliver prompts itself — that would need the QwenPaw login password stored
as a Worker secret, a standing credential with full console access. GPT
Astra agreed with this split (2026-11-15), and it was verified against the
source: `POST /api/console/chat` requires an authenticated user token
(`POST /api/auth/login`).

## Verified facts (live, 2026-11-15)

- Container `qwenpaw` healthy (`agentscope/qwenpaw:v2.3.0`).
- `GET /api/auth/status` → 200 `{"enabled":true,"has_users":true}`.
- `GET /api/cron/jobs` without auth → **401** (route mounted, auth enforced).
  Full API surface in `/app/src/qwenpaw/app/crons/api.py`: `GET /cron/jobs`,
  `GET /cron/jobs/{id}`, `POST /cron/jobs`, `PUT /cron/jobs/{id}`,
  `DELETE /cron/jobs/{id}`, `POST /cron/jobs/{id}/pause|resume|run|promote`,
  `GET /cron/jobs/{id}/state|history`, `GET /cron/dispatch-targets`.
  All are under the `/api` prefix (`_app.py:958`).
- `jobs.json` format (`/app/src/qwenpaw/app/crons/models.py`, `JobsFile`
  version 2; live file `working/workspaces/default/jobs.json` is
  `{"jobs": [], "version": 2}`):
  - `schedule`: `{type: "cron", cron: "0 7 * * *", timezone: "Asia/Kolkata"}`
    (5 fields; day-of-week numbers are normalised to mon–sun names) or
    `{type: "once", run_at: "<ISO datetime>"}`.
  - `task_type`: `"agent"` (needs `request: {input: "<prompt>"}`) or
    `"text"` (needs `text: "<message>"`, sent to the channel without an
    agent run).
  - `dispatch`: `{type: "channel", channel: "console", target:
    {user_id, session_id}, mode: "stream"|"final", silent: false}`.
    Get real `user_id`/`session_id` values from `GET /api/cron/dispatch-targets`
    while logged into the console.
  - `runtime`: `{max_concurrency: 1, timeout_seconds: 120,
    misfire_grace_seconds: 600, share_session: false, tool_safety: false}`.
    **Read this carefully:** `tool_safety: false` (default) runs the job
    with approval level **OFF** — all tools run without approval checks.
    `tool_safety: true` uses **AUTO** — guarded tools need approval and can
    block an unattended run waiting for a human. For a read-only daily
    summary, `false` is what makes it work unattended; for anything that
    writes files / runs shell commands, prefer `true` and accept that it
    may stall until approved. There is no per-routine model setting in
    `CronJobSpec` (Rakazo has one; QwenPaw does not).
  - `save_result_to_inbox`: defaults ON except recurring `text` jobs (OFF).
- Heartbeat: `agents.defaults.heartbeat` in `working/config.json` is
  `{enabled: false, every: "6h", target: "main", timeoutSeconds: 300,
  activeHours: null}`. Model: `HeartbeatConfig` in
  `/app/src/qwenpaw/config/config.py:763` (defaults from `constant.py`:
  `HEARTBEAT_DEFAULT_EVERY = "6h"`, `HEARTBEAT_DEFAULT_TARGET = "main"`,
  `HEARTBEAT_MAX_TIMEOUT_SECONDS = 3600`). `every` accepts `"30m"/"1h"/"6h"`
  intervals or a 5-field cron expression. Targets: `"main"`, `"last"`,
  `"inbox"`. It runs the `HEARTBEAT.md` checklist as a query.
  **No restart is needed to enable it:** `PUT /api/config/heartbeat`
  (`routers/config.py:1105`) saves the config and calls
  `CronManager.reschedule_heartbeat()` in the background. The file patch
  in `config-patch.md` is the batched-change record; the API route is the
  no-restart way to apply it.
- Worker live: https://qwenpaw-routines.qwenpaw-rohan.workers.dev
  - `GET /api/status` → 200, QwenPaw probe `up` (HTTP 200), routines list
    from KV. `GET /` → status/history HTML page. `POST /trigger` → 202,
    verified live 2026-11-15 (test pending entry created and then deleted;
    history keeps the manual-trigger record).
  - Cron triggers verified via API GET: `*/30 * * * *` and `30 1 * * *`
    (01:30 UTC = 07:00 Asia/Kolkata). Account cron budget: keepalive uses
    1 of 5, this Worker 2 of 5. **First live wake-tick observed
    2026-11-14T20:00:13Z** (`kind: wake-tick`, `cron: */30 * * * *`,
    QwenPaw `up`, HTTP 200) — the cron → probe → KV history path works
    end to end, not just the registered schedules.
  - KV: reuses the existing `STATUS` namespace
    (`6a91d8099ed8419c88c94b0946186a27`); all keys prefixed `routines:`.
    Seeded key `routines:definitions` = `routines.example.json` (2 routines;
    `daily-summary` active, `inbox-check-30m` paused).
  - Free-tier use: ~49 scheduled invocations/day + manual triggers, 1 probe
    fetch each — far under 100k requests/day.

## How to add a routine (the real flow)

1. **Create the native cron job** (this is what actually runs the prompt).
   Log into the console at https://qwenpawx.pages.dev, then either use the
   console's cron UI or call the API, e.g.:
   `POST https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/api/cron/jobs`
   with a body from `native-cron-jobs.example.json` (replace
   `TARGET_USER_ID` / `TARGET_SESSION_ID` with values from
   `GET /api/cron/dispatch-targets`). The API generates the job id.
   Verify with `GET /api/cron/jobs/{id}/state` and Test-run with
   `POST /api/cron/jobs/{id}/run`.
2. **Register it in the Worker registry** (so the status page and wake
   ticks list it). Edit `routines.example.json`, then write it to KV:
   `python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py put-raw
   /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/storage/kv/namespaces/6a91d8099ed8419c88c94b0946186a27/values/routines:definitions
   routines.example.json application/json`
   (Do NOT add routines through the public internet — `POST /api/routines`
   is fail-closed unless a `ROUTINE_WEBHOOK_TOKEN` secret is set; see below.)
3. **Optional: enable the heartbeat** for the `HEARTBEAT.md` checklist
   (`PUT /api/config/heartbeat`, see `config-patch.md`). It is a second,
   independent scheduled check, not a replacement for cron jobs.
4. **Manual trigger** (no login needed, wake + log only):
   `POST https://qwenpaw-routines.qwenpaw-rohan.workers.dev/trigger`
   `{"routine_id": "daily-summary", "prompt": "..."}` → 202 with a
   `pending` entry. Rate limit: 1/min. The prompt is **not** delivered to
   QwenPaw — run it in the console or make it a native cron job.

## What Rakazo routines have that this does NOT

- Change-watch triggers (watch files / command output / app), Git-event,
  email and Slack triggers — not implemented; only schedule + manual webhook.
- Per-routine model / thinking level — `CronJobSpec` has no model field.
- Run reporting back "in the same chat" happens via the native job's
  dispatch channel, which is equivalent for console delivery.

## Worker ops (deploy / redeploy)

Deploy script (no wrangler installed locally; uses the Cloudflare API via
the registered credential surrogate, same pattern as the Pages deploy script):

```
# 1. Syntax-check
node --check worker/src/index.js
# 2. Upload (metadata: plain_text bindings, NOT a top-level "vars" key —
#    a "vars" key is silently ignored and QWENPAW_URL ends up unset)
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py put-worker \
  /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/scripts/qwenpaw-routines \
  worker/src/index.js @/tmp/meta.json
# /tmp/meta.json:
# {"main_module":"index.js","compatibility_date":"2026-11-14","bindings":[
#   {"type":"kv_namespace","name":"STATUS","namespace_id":"6a91d8099ed8419c88c94b0946186a27"},
#   {"type":"plain_text","name":"QWENPAW_URL","text":"https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/"}]}
# 3. Cron triggers (re-upload does NOT wipe them, but verify after deploy)
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py put \
  /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/scripts/qwenpaw-routines/schedules \
  '[{"cron":"*/30 * * * *"},{"cron":"30 1 * * *"}]'
# 4. workers.dev subdomain (a plain script upload leaves it DISABLED —
#    the site returns "error code: 1042" until this is done; the legacy
#    PUT .../subdomain endpoint returns 10405 for this token, the beta
#    Workers API PATCH works)
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py patch \
  /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/workers/qwenpaw-routines \
  '{"subdomain": {"enabled": true}}'
# 5. Verify
curl -s https://qwenpaw-routines.qwenpaw-rohan.workers.dev/api/status
```

Gotchas found during this build (all verified live):
- `compatibility_date` must not be in the future in UTC — `2026-11-15`
  was rejected at 19:29 UTC on 2026-11-14; use `2026-11-14`.
- `vars` in upload metadata is ignored; use `plain_text` bindings.
- New Workers have `workers.dev` disabled by default (error 1042).

## Optional hardening (not done — needs a user/coordinator decision)

- Set a `ROUTINE_WEBHOOK_TOKEN` secret to enable authenticated
  `POST /api/routines` writes:
  `PUT /client/v4/accounts/<id>/workers/scripts/qwenpaw-routines/secrets`
  `{"name":"ROUTINE_WEBHOOK_TOKEN","text":"<generated>","type":"secret_text"}`.
  No token was created or stored by this build, so no secret needs rotating.
- The Worker never stores a QwenPaw password. If prompt delivery from the
  Worker is ever wanted, the safe form is a dedicated low-privilege
  QwenPaw account + a token with a short expiry (`expires_in` on
  `/api/auth/login`), not the `satwik` password — that is a design
  decision for the user, not something to improvise here.
