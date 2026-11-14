# Config patch proposal — Routines / heartbeat (FILE ONLY, NOT APPLIED)

Date: 2026-11-15. Machine: m_agq5wqqo2fvypym7rjlpvngc2m.
Source proving every key: `/app/src/qwenpaw/config/config.py:763`
(`HeartbeatConfig`) and `/app/src/qwenpaw/constant.py:213-216`.
Live current value (read 2026-11-15, `working/config.json`):
`agents.defaults.heartbeat = {enabled: false, every: "6h", target: "main",
timeoutSeconds: 300, activeHours: null}`.

## Proposed change (one key)

File: `/data/home/qwenpaw/working/config.json`, path
`agents.defaults.heartbeat.enabled`:

```json
"agents": {
  "defaults": {
    "heartbeat": {
      "enabled": true,
      "every": "6h",
      "target": "main",
      "timeoutSeconds": 300,
      "activeHours": null
    }
  }
}
```

Only `enabled` changes (`false` → `true`). Everything else keeps its
current value. `every: "6h"` matches the existing `HEARTBEAT.md`
checklist (scan inbox, calendar next 2h, stuck todos, light check-in if
quiet 8h). A shorter interval such as `"30m"` is valid
(`parse_heartbeat_every` accepts `30m`/`1h`/`2h30m`/`90s`, or a 5-field
cron expression) but is NOT proposed here: every heartbeat run is a full
agent run against the Kilo free model, and 6h is the shipped default.

## No restart is needed to apply this

Verified in source: `PUT /api/config/heartbeat`
(`/app/src/qwenpaw/app/routers/config.py:1105`, "Update heartbeat and
hot-reload the scheduler") saves the config via `save_agent_config` and
calls `CronManager.reschedule_heartbeat()` in the background
(`manager.py:656`), which removes/registers the `_heartbeat` APScheduler
job in place. So the batched-restart requirement does NOT apply to this
particular change — the coordinator can apply it from the console
(Settings → heartbeat) or via the API while logged in:

```
PUT https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/api/config/heartbeat
{"enabled": true, "every": "6h", "target": "main", "timeoutSeconds": 300, "activeHours": null}
```

Then verify with `GET /api/config/heartbeat` and
`POST /api/config/heartbeat/run` (runs one heartbeat immediately).

## What this does NOT do

- It does not create routines. Routines are native cron jobs
  (`POST /api/cron/jobs`, see `native-cron-jobs.example.json`).
- Heartbeat target `"main"` runs the checklist in the main session;
  `"inbox"` and `"last"` are the other valid targets
  (`constant.py:223-224`).
- On InstaBox Free the heartbeat only fires while the machine is awake;
  the `qwenpaw-routines` Worker (30-min wake ticks) + the keepalive
  Worker (5-min pings) keep it awake.
