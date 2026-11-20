# Smart sleep/wake, part 1: keep-alive ON/OFF toggle + max-run guard (2026-11-19)

Two additions to the intelligent sleep/wake system in `worker/src/index.js`
(see `features/sleepwake/README.md` for the base design). The §3
recovery fix was DEPLOYED LIVE 2026-11-19 ~13:20 IST (flip verified:
07:55 tick sleeping→running, reason `reporter_up`); that deploy
exposed the §4 stale-baseline defect, whose fix (§4) is code-complete
and NOT yet deployed — see §4 for the deploy condition.

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
- **Uptime source (updated 2026-11-19 — see §4):** the EXISTING
  `uptimeMin` — reporter `uptimeSec` when fresh, else the D1
  `sleepwake:run-start` baseline, else 0 (unknown). The stored
  `lastUpAt` is NO LONGER an uptime source: it is the last up-transition
  / last meaningful status change, write-on-change froze it for 17h
  through a cooldown, and it can predate the current run entirely — so
  it is not even a lower bound across run boundaries. Unknown uptime
  yields `uptimeMin` 0, which fails the 420 threshold, so the
  fail-closed property holds automatically. Reporter staleness does not
  block the guard: the baseline is a real run-start observation, so a
  420-min reading is real either way.
- **Precedence:** WAKE still wins — a routine due within the lookahead
  returns from the earlier branch first (wake if down, hold if up), so
  the guard can never sleep past a routine. Manual rest still wins
  (`restActive` check). The guard respects the toggle automatically:
  the tick early-returns before `decideSleepWake` when OFF.

### The wake lookahead is 5 min (tightened 2026-11-21, user-set)
The 10-min lookahead was deliberately kept on 2026-11-19 (5 min lead +
wake buffer) because the cron runs every 5 min and a 5-min lookahead
could miss the window. The user tightened it to 5 min on 2026-11-21:
the wake itself takes ~1-2 min (probe + retry), so the machine is
ready ~3 min before the routine, and the routines Worker's 15-min
backup wake covers a slow wake. A routine due in 6 min at tick time is
caught at the next tick, when it is due in ~1 min — inside the 5-min
window — so the 5-min cron still cannot miss it outright; the margin
is thinner than the old 10-min one, and that is the user's call. Do
NOT tighten it further, and do NOT loosen it back to 10 min without
the user asking.

## Files
- `worker/src/index.js` — `readKeepAliveEnabled` + `readKeepAlivePublic`,
  tick gate, `POST /keepalive`, `/status` + `/sleepwake/state` fields,
  `SW_MAX_RUN_MIN = 420` guard in `decideSleepWake`.
- `features/smart-sleep/harness-smart-sleep.mjs` — 131 checks, node stdlib
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

### Uptime in the state — and the live reporter's null (updated 2026-11-19, §4)
The state records the uptime the tick computed, as `uptimeSec`, so the
flip is auditable and `GET /sleepwake/state` exposes it (null when no
recovery has happened). The tick's uptime is the reporter's `uptimeSec`
when the report carries a finite one, else the D1 `sleepwake:run-start`
baseline — **never the stored `lastUpAt`** (see §4: it froze for 17h
and made the guard fire on a 10-minute-old run). **The live reporter
posts `uptimeSec: null` always** (`features/sleepwake/reporter.py`: it
cannot know run start — the container predates the wake, `/proc/uptime`
is machine boot, not run start), so in production the recorded uptime
comes from the baseline, which the flip resets to `now` when the
reporter carries no finite uptimeSec. The recovery deliberately does
NOT require a finite reporter `uptimeSec`: requiring it would make the
fix dead code in production. The guard reads the tick's `uptimeMin`,
not the state, so it fires correctly either way.

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
node features/smart-sleep/harness-smart-sleep.mjs   # 131/131
```
New section "stuck-state recovery — reporter_up" (33 checks): fresh
reporter flips sleeping→running with reason `reporter_up` and the
computed `uptimeSec` (exactly 1 console probe on the hold path, zero
Pages sleeps); 6-min-old and 11-min-old reports and no report never
flip (zero fetches); 7h uptime + fresh reporter fires the guard in the
same tick (one Pages sleep, zero console probes, final reason
`max_run_guard`); a stale report claiming 7h does not fire the guard;
419 min flips but does not fire; the live reporter shape (uptimeSec
null) flips with the run-start baseline reset to now and the state
carrying ~0 (see §4 — the pre-§4 text here used to say "the lastUpAt
lower bound", which was the bug); finite reporter uptimeSec wins over
the baseline; an already-running state is never overwritten and the
tick writes nothing to D1 meta; `GET /sleepwake/state` exposes the
recorded uptimeSec. Fail-first: 89/105 against the pre-recovery Worker
(16 fail — exactly the recovery checks; the 17 negative controls pass
on both, by design), 105/105 after.

## 4. Stale-baseline incident (2026-11-19) — the guard fired on a 10-minute-old run

### The incident
The §3 recovery fix was deployed live 2026-11-19 ~13:20 IST (Worker
deployment `183544040b6e4c25aa147045f41bd0f7`, cron */5 intact). The
machine had come back from its max-run cooldown at 13:15:03 IST
(direct origin first 200 ~13:20 IST / 07:50Z; true run start
~07:45–07:50Z). The 07:55 tick flipped the state sleeping→running
(reason `reporter_up`, uptimeSec 62729 recorded) and `/status`
showed keepAlive `on`. Then the guard fired at the 07:55, 08:00 and
08:05 ticks (`lastSleepAt` 07:55:58Z → 08:00:59Z → 08:05:59Z, reason
`sleep_failed:pages_sleep_failed` each time) on a run that was
~10–25 min old. The machine survived ONLY because every suspend
attempt failed — if one had succeeded, the machine would have been
suspended ~20 min into a fresh run; if they kept failing, the 7h
guard was toothless and the run would hit the 8h wall ~21:15 IST
with a forced ~2h cooldown.

### Root cause (verified in code + live state)
The guard's uptime came from the stored `lastUpAt` — the last
up-transition / last meaningful status change, kept in the D1 status
row. `saveStatus` is write-on-change and `lastUpAt` is deliberately
excluded from the meaningful-change list, so it froze at
2026-11-18T14:30:29Z while the stuck `"sleeping"` state suppressed
all probes and status writes through the cooldown. The 07:55
`reporter_up` flip recorded that frozen value (62729s = 17.4h) into
the sleep state, and every tick since recomputed uptime from the same
frozen `lastUpAt`. A second layer: even the probe's up-save after a
failed sleep did not refresh `lastUpAt`, because the write-on-change
check dropped it (nothing else meaningful changed). `lastUpAt` is not
a lower bound on the current run's uptime across run boundaries — it
can predate the current run entirely.

### Why the sleep kept failing (diagnosed, not fixed here)
`Pages POST /api/machine/sleep` returns 503 `instabox_machine_unset`:
`INSTABOX_MACHINE_ID` is ABSENT from the production `env_vars` of
BOTH Pages projects (qwenpawx and qwenpaw-frontend — verified via the
Cloudflare API 2026-11-19 ~13:45 IST). `sleepMachine` in
`pages/public/machine-control.js` checks it after auth and returns
503 before ever calling InstaBox. Ruled out: 503 SLEEP_TOKEN unset
(the Worker secrets list shows SLEEP_TOKEN present, and a
wrong-token probe of both Pages returned 401 `unauthorized`, proving
the secret is set); 401 token mismatch is unlikely (one provisioning
run set the same generated value on the Worker and both Pages, no
rotation recorded); 502 InstaBox refusing the PATCH suspend cannot be
the current failure (the code returns 503 first) but could become the
failure after the var is set. Worker console logs were unavailable
(Observability keys endpoint 404, `logpush: false`, no tail
consumers, wrangler not installed). **Fix, for the parent to do:**
set plain-text var `INSTABOX_MACHINE_ID` =
`m_agq5wqqo2fvypym7rjlpvngc2m` (already in `worker/wrangler.toml`,
not a secret) on both Pages projects' production env. The same
missing var also breaks the Rest button (`restMachine` has the
identical check). After it is set, the next guard tick will either
succeed (token matched) or fail 401 (token mismatch) — the first real
7h guard sleep is the live proof.

### The fix (in `worker/src/index.js`)
A D1 run-start baseline, `sleepwake:run-start` (epoch ms), set ONCE
per run at the observed down→up transition, never refreshed while up,
never derived from `lastUpAt`:
- Helpers after `readLastVisit`: `readRunStart(db)`,
  `writeRunStart(db, ms)`, `baselineFromReport(report, now)`
  (reporter's finite uptimeSec → `now - uptimeSec*1000`, exact; else
  `now`), `computeUptimeSec(report, reporterStale, runStart, now)` —
  ONE precedence shared by tick and endpoint: reporter uptimeSec
  (fresh) > run-start baseline > unknown (null). The `lastUpAt`
  fallback was deliberately DROPPED: unknown → 0 in the tick, which
  fails the 420 threshold — fail closed, as the guard's own comment
  requires.
- **R1 (flip):** in the `reporter_up` recovery, reset the baseline
  FIRST (from the report), then compute the uptime, then record the
  flip's `uptimeSec` from the corrected value (~0 when the reporter
  posts null).
- **R2 (reconcile):** if no baseline exists and the reporter is fresh
  within the same 5-min recovery bar, initialize the baseline from the
  report. This corrects the ALREADY-RUNNING live state on the first
  tick after deploy — a fix that only resets on a future flip would
  never fire, because the state is already `"running"`.
- **R4 (probe transition):** after a probe returns `up` (wake branch
  + final probe), if the pre-probe cached status was not `up` or no
  baseline exists, set baseline = `Date.now()`. Steady state
  (recorded up + baseline present) writes nothing.
- `GET /sleepwake/state`: `uptimeSec` is now the LIVE-computed value
  (same precedence as the tick), not the last flip's recorded value;
  new field `runStartAt` (ISO or null). The flip's recorded value
  stays in the state row for audit.

### Tests
```bash
node features/smart-sleep/harness-smart-sleep.mjs   # 131/131
node features/sleepwake/harness-sleepwake.mjs       # 53/53
```
New section "run-start baseline — stale-baseline incident
(2026-11-19)" (21 checks, T143 105 → 131): L1 the live case
(already-running + stale lastUpAt 17h + fresh reporter null-uptime +
no baseline → ZERO Pages sleeps, baseline ≈ now, 1 probe, state
running); L2 a genuinely 7h-old run still fires (425-min baseline,
lastUpAt fresh 60 min — pre-fix would NOT fire — → one Pages sleep,
zero probes, reason `max_run_guard`); L3 419-min baseline → hold;
L4 stale reporter claiming 420 min is ignored (baseline 60 min →
hold, baseline unchanged); L5 probe transition sets the baseline;
L6 steady state never refreshes the baseline; L7/L8 the endpoint
after the live-case tick (runStartAt ≈ now, uptimeSec < 300) and with
nothing known (uptimeSec null, runStartAt null). The H/J/K checks
were rewritten to the new behaviour (flip records ~0, baseline init
is 1 meta write, endpoint exposes the live value + `runStartAt`).
Fail-first: 111/131 against the pre-fix Worker (20 fail — exactly
the behaviour-changing checks; the 3 T108-style regression controls
+ the 2 vacuous baseline-presence checks pass on both, by design),
131/131 after. T108 gained the same live case (50 → 53, fail-first
50/53).

### DEPLOY CONDITION — unchanged
Deploy ONLY in a fresh run with uptime well under 7h, then verify
live: `GET /sleepwake/state` shows `runStartAt` ≈ the true run
start, `uptimeSec` in minutes and growing, mode `running`, and
`lastSleepAt` stops advancing (no new `sleep_failed` entries) across
at least 2 ticks (~10 min). If the guard still fires after the fix,
report the state body plainly — do not redeploy repeatedly.

## Tests
```bash
node features/smart-sleep/harness-smart-sleep.mjs   # 131/131
node features/sleepwake/harness-sleepwake.mjs       # 53/53 (regression)
node --input-type=module -e "import('./worker/src/index.js')"  # import smoke test
```

## NOT verified live (do not claim done until seen)
- Deploy of the §4 run-start baseline Worker code (deploy ONLY in a
  fresh run with uptime well under 7h; then watch 2 ticks: `runStartAt`
  ≈ the true run start, `uptimeSec` in minutes and growing, no new
  `lastSleepAt` / `sleep_failed` entries).
- The §3 recovery fix WAS deployed live 2026-11-19 ~13:20 IST (flip
  verified at the 07:55 tick; see §4 for the defect it exposed).
- A real `POST /keepalive` flip against the live Worker + a tick that
  skips, and a flip back that resumes.
- A real max-run-guard sleep at ~7h uptime (needs a busy 7h run) — and
  the first real sleep is also the proof that the Pages sleep works
  once `INSTABOX_MACHINE_ID` is set (see §4).
- `GET /status` / `/sleepwake/state` showing `keepAlive` in a browser.
