# Intelligent sleep/wake (2026-11-17)

## The problem
The keep-alive Worker probed the public console URL every 5 minutes.
A probe WAKES a paused machine — so the machine never idle-paused, ran
its full 8-hour max run, then took a ~2-hour cooldown. The user asked:
sleep when idle (no schedule, no agent work); wake 5 minutes before a
schedule; keep-alive pings only when the AI is active or before a
schedule.

## The design (DeepSeek-reviewed)
The cron tick DECIDES BEFORE IT PROBES. Probing wakes the machine, so a
probe-first tick can never sleep. The decision is a pure function
(`decideSleepWake`, exported from `worker/src/index.js` for the harness)
over D1 state; the tick only probes / suspends based on it.

**Decision inputs** (all from D1 `meta`, plus the routine registry):
- `sleepwake:report` — the machine reporter (POST /report, REPORTER_TOKEN):
  next native run, agent activity, uptime.
- `sleepwake:state` — {mode, since, reason, lastWakeAt, lastSleepAt}.
- `sleepwake:last-visit` — epoch ms of the last console page load (Pages
  writes it, throttled to once per 5 min; only page loads count, not
  /api/* polling).
- `routines_definitions` — routine registry; each active routine carries a
  structured `cron` + `timezone` so the next run is computable.

**The decision** (`decideSleepWake`):
- WAKE wins: a routine due within 10 min (5 min lead + wake buffer) and
  the machine down -> wake. Overdue routines count as imminent.
- SLEEP only when EVERY guard passes: routine beyond the 10-min window,
  no visit in 30 min, no agent activity in 10 min, uptime >= 15 min, no
  manual rest, reporter fresh (< 10 min), machine up, state running, and
  at least 20 min since the last wake (deadband > lookahead: kills
  sleep-wake-sleep flap).
- FAIL CLOSED: an unknown next-routine (null), a stale reporter, or an
  in-flight transition -> HOLD (stay awake). A null next-routine is
  "unknown", Infinity is "definitively no routines" — the two are never
  confused. A machine that is asleep is never probed by the cron.

**Suspend goes through Pages** (POST /api/machine/sleep, SLEEP_TOKEN):
Pages already holds INSTABOX_API_KEY and the tested suspend call; the
keep-alive Worker does not have that key and must never invent one.
The keep-alive writes the sleep marker FIRST, then suspends, then
records the outcome — a failed suspend reverts to running (fail-awake).

**The routines Worker is sleep-aware too**: its 30-min tick checks the
next routine first and only probes when a routine is due within 15 min
(a backup wake for the keep-alive, which owns waking). A blind probe
every 30 min would wake the machine around the clock and defeat sleep.

**Wake experience + slow open (same job)**: the waking page now shows
live progress (elapsed timer, progress bar, status line, 5 s polling,
reloads the moment the console answers) instead of a static 30 s
meta-refresh. Content-hashed /assets/* (e.g. index-DZrIuh3B.js) get
`Cache-Control: public, max-age=31536000, immutable` — a hashed filename
can never go stale, so the 1 MB bundle stops re-downloading every load.
HTML and API responses keep no-store.

## Files
- `worker/src/index.js` — decideSleepWake, nextRun, D1 state, reworked
  keepAliveTick, POST /report, GET /sleepwake/state.
- `pages/public/machine-control.js` — sleepMachine (POST /api/machine/sleep).
- `pages/public/_worker.js` — /api/machine/sleep route, last-visit
  recording, waking-page progress, /assets/* caching.
- `features/routines/worker/src/index.js` — sleep-aware scheduledTick,
  POST /api/routines accepts cron + timezone (validated).
- `features/sleepwake/reporter.py` — machine-side reporter (systemd
  timer, every 2 min). Reads jobs.json (next native run), file mtimes
  (agent activity: qwenpaw.log, token_usage.json, history.db, workspaces),
  POSTs to /report. uptimeSec is null (unknown, not invented — the
  Worker falls back to its stored lastUpAt).
- `features/sleepwake/qwenpaw-sleepwake-reporter.{service,timer}`.
- `features/sleepwake/harness-sleepwake.mjs` — T108 (47 checks).
- `features/sleepwake/reporter.py --selftest` — T109 (12 checks).

## Secrets (all generated, never in git)
- REPORTER_TOKEN — keep-alive Worker secret + machine .env (reporter).
- SLEEP_TOKEN — keep-alive Worker secret + both Pages projects.
Both are set by the deploy (provision script), never printed.

## Quota
- Reporter: 720 D1 meta writes/day (one row, updated in place) = 0.7%
  of the 100k/day limit. The write is the liveness signal; a report that
  only wrote on change would go stale while the machine is idle, and the
  Worker would (correctly) refuse to sleep it.
- Keep-alive tick: D1 reads per tick (meta + routines + status), writes
  only on state change (same change-only rule as the status writer).
- Routines tick: 49/day, one history write each (skipped ticks included).

## Status
- DEPLOYED + LIVE 2026-11-17 (see below for the live verification).
- Daily summary backfilled with cron `0 7 * * *` + timezone Asia/Kolkata
  in D1 routines_definitions (was free-text scheduleNote only).

## Live verification (Muse, 2026-11-17)
Deploy verified live 2026-11-17 ~22:2x–22:4x IST:
- Secrets provisioned (REPORTER_TOKEN + SLEEP_TOKEN; keep-alive Worker
  secret + machine .env + both Pages; all 6 provisioning steps OK).
- Keep-alive Worker deployed via cf.py put-worker; REPORTER_TOKEN +
  SLEEP_TOKEN + WAKE_TOKEN survived; cron */5 survived; bindings correct
  (incl. new PAGES_URL). First /sleepwake/state call returned the old 404
  (propagation delay); retry returned the full state JSON.
- Routines Worker deployed; ROUTINE_WEBHOOK_TOKEN survived; both
  schedules (*/30 * * * *, 30 1 * * *) survived.
- Both Pages deployed (bundled _worker.js, 116,902 B). POST
  /api/machine/sleep without a token -> 401 on both (endpoint exists and
  is gated). /assets/* caching verified live:
  index-DZrIuh3B.js -> `Cache-Control: public, max-age=31536000,
  immutable`.
- D1 backfill verified: daily-summary cron `0 7 * * *` + timezone
  Asia/Kolkata present (json_extract).
- Reporter installed on the machine; selftest 12/12 on the machine;
  --once POST /report -> HTTP 200.
- /sleepwake/state live (checked 22:47 IST): mode running,
  nextRoutineAt 2026-11-18T01:30:00Z (07:00 IST), source
  d1:daily-summary, reporterFresh true, machineStatus up.
- Harnesses: T108 47/47, T109 12/12; full machine-free suite green
  except the 4 known NEEDS-REBUILD rows.

NOT YET OBSERVED (do not claim done until these are seen live):
- A real idle -> suspend (machine idle 30 min, no agent activity 10 min,
  reporter fresh, uptime >= 15 min, >= 20 min since last wake).
- The wake ~5-10 min before the 07:00 IST daily summary (2026-11-18).
- The new waking page's live progress in a real browser during a real
  wake.

## Risks (recorded, not hidden)
- The reporter is the only source of native-run and agent-activity facts.
  If it breaks, the Worker fails closed (holds the machine awake) — safe,
  but the machine will not sleep until the reporter is fixed.
- A native job created while the machine is up is only known to the
  Worker after the next reporter tick (<= 2 min). A job due within that
  window could be woken late; the D1 routines are the reliable schedule.
- The 10-min wake lookahead assumes a wake takes <= ~5 min. If InstaBox
  is slow to wake (cold start), a routine could start late; the keep-alive
  retries every 5 min and the routines Worker is a backup wake.
