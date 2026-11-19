# Smart sleep/wake, part 1: keep-alive ON/OFF toggle + max-run guard (2026-11-19)

Two additions to the intelligent sleep/wake system in `worker/src/index.js`
(see `features/sleepwake/README.md` for the base design). Both are code +
machine-free harness only — NOT verified live (deploy + browser blocked by
the Cloudflare 1027 Workers outage and the machine cooldown until 05:30 IST
2026-11-19).

## 1. Keep-alive ON/OFF toggle

### Storage
D1 `meta` table, two keys:
- `keepalive:enabled` — `'1'` (ON) | `'0'` (OFF). **Absent = ON.**
- `keepalive:updated` — ISO timestamp of the last flip.

No seed row was added, deliberately: `features/storage/schema.sql`
predates the `meta` table entirely (it has no `meta` table and no seed
for it — the live `meta` table was created via the D1 API, see
`features/storage/SCHEMA.md`), so there is no migration/seed file for
this key to live in. Absent = ON makes a seed unnecessary for the live
DB: a database that has never seen a flip behaves exactly as today.

### Endpoint: POST /keepalive
- Auth: header `Authorization: Bearer <WAKE_TOKEN>` **only** — never
  `?token=` (tokens in URLs leak in logs/Referer). The token is
  `WAKE_TOKEN`, already a Worker secret; **no new secret was invented**.
  The comparison copies the `/report` handler's length + `charCodeAt`
  loop pattern.
- Body: a JSON object with boolean `enabled` (`{"enabled": false}`).
- Success: `200 {ok: true, enabled: boolean, updatedAt: ISO}` and
  exactly **2 D1 meta writes** (`keepalive:enabled` + `keepalive:updated`).
  It does NOT sleep, wake, or probe — it only flips the toggle the next
  cron tick reads.
- Errors: `400` bad body (not JSON, not an object, or `enabled` not a
  boolean — no writes); `401` bad/missing token (no writes);
  `503` not-configured (`WAKE_TOKEN` unset) or storage failure (no D1 /
  write failed); `405` for non-POST (`GET /keepalive` -> 405 with
  `Allow: POST`).

### Tick gate (in `keepAliveTick`)
At the VERY TOP of the D1 branch — before any probe, wake, sleep, or
state write, but AFTER the no-D1 legacy-probe branch, which is
unchanged: the toggle requires D1, which is the deployed configuration
(`USE_D1=1`); a Worker without D1 keeps the old probe behaviour and the
toggle simply does not apply there.

The toggle is read with the new exported `readKeepAliveEnabled(db)`,
folded into the same D1 meta reads as the other decision inputs (0 extra
Worker requests — D1 queries are not requests). It does NOT reuse
`swMetaGet`, which swallows errors and returns null: the gate must be
able to tell "absent" (ON) from "unreadable" (HOLD). The function
returns the raw value (`null` absent, `'0'`, `'1'`, or any invalid value
as-is) and THROWS on a read error; the tick maps both error cases to
HOLD:

| Toggle value | Tick result |
|---|---|
| `'1'` or absent | Falls through to `decideSleepWake` exactly as today |
| `'0'` | `{action: 'skip', reason: 'keepalive-off'}` — no probe, no wake, no sleep, no state write |
| read throws | `{action: 'hold', reason: 'keepalive-read-error'}` — ZERO fetches, ZERO writes |
| anything else (e.g. `'yes'`) | Same HOLD as a read error |

Fail-closed throughout: an unreadable or invalid toggle never assumes
ON (which would keep waking a machine the user switched off) and never
assumes OFF (which would silently stop waking for routines).

### Status fields
- `GET /status` gains public read-only `keepAlive` (`"on" | "off" |
  "unknown"`) and `keepAliveUpdatedAt` (ISO string or null), read from D1
  in the handler — no extra client request. If D1 is unavailable the
  fields are omitted. Absent = `"on"`; unreadable or invalid = `"unknown"`.
- `GET /status` also gains `sleepwake: {nextRoutineAt, nextRoutineSource}`
  — the next scheduled run, computed with the same `computeNextRoutine`
  the cron tick uses. Fix 2026-11-19 (found in integration review): the
  stored status never carried a `sleepwake` field — the tick's
  hold-sleeping branch returns it without saving — so the status page's
  "next scheduled run" always showed "Not scheduled". `nextRoutineAt` is
  a finite ms epoch when a routine exists, else `null` (no routines and
  unknown both render as "Not scheduled"). `/status` is user-paced (one
  GET on load + Refresh clicks), so the extra D1 reads are proportional
  to user action.
- `GET /sleepwake/state` gains `keepAlive` (same `"on" | "off" |
  "unknown"` string).

### Bypass list — the toggle does NOT affect these
- `POST /wake` (manual wake, `X-Wake-Token`).
- Pages-visit auto-wake (visiting the console wakes the machine).
- The Rest button (manual rest / suspend via Pages).
- The routines Worker's scheduled wake (a separate worker; its own
  30-min tick and 07:00 slot keep working — a routine due while the
  toggle is OFF is still woken by the routines Worker, just not by the
  keep-alive cron).

The toggle gates ONLY the keep-alive cron tick.

### Quota
- Toggle OFF saves up to **288 requests/day** (the cron tick's probes:
  12 ticks/hour x 24h; each tick that would have probed now does nothing).
- A flip costs **1 request + 2 D1 writes**.
- The tick reads the toggle batched with the other meta reads: **0 extra
  requests** per tick. D1 row reads are 5,000,000/day free; one extra
  meta read per tick (288/day) is noise.

## 2. Max-run guard

### Why
Found 2026-11-18/19: the machine was busy all evening, so it never
qualified as idle (recent visit / recent agent activity kept failing
the idle guards), ran the full ~8h max run, and hit a forced ~2h
cooldown during which wakes are refused. The idle guards are correct
for a quiet machine and useless for a busy one — a busy machine needs a
time-based escape hatch, not an activity-based one.

### Rule (in `decideSleepWake`, after the WAKE branch and after the
`!known` fail-awake hold)
```
if (uptimeMin >= 420 && machineUp === true && sleepState === "running" && restActive === false)
  -> {action: 'sleep', reason: 'max_run_guard'}
```
- **Why 7h (420 min):** InstaBox's wall is ~8h. The 7h threshold leaves
  a 1h buffer before the wall. A sleep at 7h takes a much shorter
  cooldown than the forced ~2h cooldown after a full 8h run, and the
  user wakes the machine immediately on visit anyway — so sleeping an
  hour early costs almost nothing and avoids the worst outcome.
- **Why it overrides recent activity:** that is the point. A busy
  machine that hits 8h takes a forced ~2h cooldown; a 7h sleep does
  not. Recent visits and recent agent activity deliberately do NOT block
  the guard.
- **Uptime source:** the EXISTING `uptimeMin` — reporter `uptimeSec`
  when fresh, else the stored `lastUpAt` lower bound, else 0. No new
  uptime source was invented. Unknown uptime yields `uptimeMin` 0,
  which fails the 420 threshold, so the fail-closed property holds
  automatically. Reporter staleness does not block the guard: both
  uptime sources are lower bounds, so a 420-min reading is real either
  way.
- **Precedence:** WAKE still wins — a routine due within the lookahead
  returns from the earlier branch first (wake if down, hold if up), so
  the guard can never sleep past a routine. Manual rest still wins
  (`restActive` check). The guard respects the toggle automatically:
  the tick early-returns before `decideSleepWake` when OFF.

### The 10-min wake lookahead is deliberately KEPT
Do NOT tighten it to 5 min. The cron runs every 5 min, so a 5-min
lookahead could miss the window entirely (a routine due in 6 min at
tick time would not be "due" until the next tick, when it is due in
1 min — still inside 5 min, but a wake takes minutes and the margin
evaporates; with any tick jitter the routine starts late). The 10-min
lookahead (5 min lead + wake buffer) is the margin that makes the
5-min cron reliable.

## Files
- `worker/src/index.js` — `readKeepAliveEnabled` + `readKeepAlivePublic`,
  tick gate, `POST /keepalive`, `/status` + `/sleepwake/state` fields,
  `SW_MAX_RUN_MIN = 420` guard in `decideSleepWake`.
- `features/smart-sleep/harness-smart-sleep.mjs` — 105 checks, node stdlib
  only, real Worker module + mock D1 + mock fetch that counts every call.
  Fail-first run against the pre-change module: 23 passed, 45 failed
  (toggle endpoint 404, guard absent, gate absent). Post-change: 68/68.
- `features/smart-sleep/README.md` — this file.

## 3. Stuck-state recovery (`reporter_up`, 2026-11-19)

### The incident
2026-11-19 ~10:11 IST, verified live: the sleep/wake state was stuck
on `"sleeping"` since 2026-11-18 14:30:59 IST (reason
`probe_cooldown`) while the machine had actually been up and working
since ~03:06:55 IST that day (T136 calibration runs, the takeover2
redeploy, browser tests all ran on it). The reporter was fresh, the
machine was up, but the state never flipped. Consequence: the 7h
max-run guard did NOT fire at ~10:06:55 IST (it requires sleepState
`"running"`), so the 8h wall at ~11:06:55 IST was unguarded.

### Root cause (verified in code)
`keepAliveTick` early-returns without probing whenever the state is
`"sleeping"` (`if (state.mode === "sleeping")` — probing would wake an
intentionally sleeping machine), and the only flip back to `"running"`
on a live probe (`reason: "probe_up"`) sits below that return,
unreachable while sleeping. `POST /wake` and `GET /ping` never write
sleep state either. The machine was woken that morning outside the
Worker's own wake path, so the Worker never recorded the wake. The
only exit from `"sleeping"` was a routine coming due (next 2026-11-20
07:00 IST).

### The fix (in `keepAliveTick`, before the decision)
If the state says `"sleeping"` but the machine-side reporter reported
within the last 5 min (`SW_REPORTER_RECOVERY_MS = 5 * SW_MIN`), flip
the state to `"running"` (reason `"reporter_up"`) WITHOUT probing —
the reporter runs on the machine itself and posts every 2 min, so a
fresh report is proof the machine is up. The flip happens BEFORE
`decideSleepWake`, so the max-run guard can fire in the same tick when
uptime is >= 420 min. The 5-min bar is deliberately tighter than the
10-min reporter-staleness threshold: the flip is taken on reporter
evidence alone, without a probe. A stale or missing report never flips
(fail closed).

### Uptime in the state — and the live reporter's null
The state records the uptime the tick computed, as `uptimeSec`, so the
flip is auditable and `GET /sleepwake/state` exposes it (null when no
recovery has happened). The tick's uptime is the reporter's `uptimeSec`
when the report carries a finite one, else the stored `lastUpAt` lower
bound. **The live reporter posts `uptimeSec: null` always**
(`features/sleepwake/reporter.py`: it cannot know run start — the
container predates the wake, `/proc/uptime` is machine boot, not run
start), so in production the recorded uptime comes from `lastUpAt`.
The recovery deliberately does NOT require a finite reporter
`uptimeSec`: requiring it would make the fix dead code in production.
The guard reads the tick's `uptimeMin`, not the state, so it fires
correctly either way.

### DEPLOY CONDITION — read this before deploying
**Do NOT deploy this while a run is already past 7h uptime.** The
guard fires on the next tick after the state flips, and a machine past
7h would be slept immediately — mid-test, mid-work. Deploy ONLY in a
fresh run with uptime well under 7h (e.g. right after a wake or a
deliberate Rest), then verify live: `GET /sleepwake/state` shows
`"running"` with a fresh `uptimeSec`, and the guard's next 7h sleep is
the expected behaviour, not a surprise. The code fix was built and
pushed 2026-11-19 ~10:3x IST on Rohan's decision ("fix the stuck
state in code after") and was NOT deployed for exactly this reason.

### Follow-up (recorded, not built here)
`POST /wake` and `GET /ping` still never write sleep state. Writing
`"running"` there when their probe answers `"up"` would fix the stuck
state through those paths too, but the tick recovery already covers
every wake path generically (any wake restarts the reporter, which
flips the state within ~5 min), and touching an auth-gated endpoint's
behaviour plus adding a state write to a GET expands the blast radius
for no additional coverage. Left as a follow-up; do it only if a
stuck state is ever observed again after this fix is live.

### Tests
```bash
node features/smart-sleep/harness-smart-sleep.mjs   # 105/105
```
New section "stuck-state recovery — reporter_up" (33 checks): fresh
reporter flips sleeping→running with reason `reporter_up` and the
computed `uptimeSec` (exactly 1 console probe on the hold path, zero
Pages sleeps); 6-min-old and 11-min-old reports and no report never
flip (zero fetches); 7h uptime + fresh reporter fires the guard in the
same tick (one Pages sleep, zero console probes, final reason
`max_run_guard`); a stale report claiming 7h does not fire the guard;
419 min flips but does not fire; the live reporter shape (uptimeSec
null) flips with the lastUpAt lower bound; finite reporter uptimeSec
wins over lastUpAt; an already-running state is never overwritten and
the tick writes nothing to D1 meta; `GET /sleepwake/state` exposes the
recorded uptimeSec. Fail-first: 89/105 against the pre-recovery Worker
(16 fail — exactly the recovery checks; the 17 negative controls pass
on both, by design), 105/105 after.

## Tests
```bash
node features/smart-sleep/harness-smart-sleep.mjs   # 68/68
node features/sleepwake/harness-sleepwake.mjs       # 47/47 (regression)
node --input-type=module -e "import('./worker/src/index.js')"  # import smoke test
```

## NOT verified live (do not claim done until seen)
- Deploy of the new Worker code (blocked: Cloudflare 1027 quota until
  05:30 IST 2026-11-19; machine suspended until ~03:04 IST).
- A real `POST /keepalive` flip against the live Worker + a tick that
  skips, and a flip back that resumes.
- A real max-run-guard sleep at ~7h uptime (needs a busy 7h run).
- `GET /status` / `/sleepwake/state` showing `keepAlive` in a browser.
