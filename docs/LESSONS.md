# Lessons — what this project learned the hard way

**This file is NOT loaded into every session.** `AGENTS.md` holds the
distilled one-line rules; read this file when you need the reasoning behind
a rule — search by symptom, date, or feature name.

**Append-only, timestamped, never rewritten.** When you learn something new,
add the one-line rule to the matching section of `AGENTS.md` and the full
symptom → cause → fix story here. A lesson rewritten later to sound smarter
is a lesson you will not trust. Each entry keeps the date it was learned and
the incident that paid for it.

**Format per entry:** bold symptom → root cause → fix (exact commands) →
verification. Then the one-line rule that went into `AGENTS.md`.

---

## 2026-11-15 — "admin login 200" was wrong; the real account is satwik

**Symptom:** a deploy-generated admin password was reported as working
("login 200") for hours; the real account was a different user.

**Root cause:** the `.env` admin password was tested, but the account on the
machine is `satwik`, not `admin`. The admin password does not log in as
satwik (401 everywhere, including localhost). The "login 200" was never
checked against WHO was logged in.

**Fix:** verify the actual account — read `working.secret/auth.json` for the
username, then test login as that user. Do not trust a "login 200" without
checking who is logged in.

**Verification:** 2026-11-15 01:04 IST — satwik logs in to
qwenpawx.pages.dev, console loads, Default agent Running.

**Rule (AGENTS.md §1):** verify the actual thing — a "login 200" is not
proof until you know WHO is logged in.

---

## 2026-11-15 — GitHub Actions failures misdiagnosed as missing secrets; the real cause was a billing lock

**Symptom:** all 36 GitHub Actions runs failed with 0 steps since Nov 14.

**Root cause:** diagnosed as missing secrets / a broken workflow. The real
cause was the account locked for billing, which stops jobs before any step
runs. A job that fails with 0 steps never started — it is an account-level
failure, not a step-level one.

**Fix:** check the account/billing state before diagnosing the workflow or
the secrets. Read the run's failure point first: 0 steps = never started.

**Verification:** fix staged (3 secrets set, workflow rewritten cf1c267d),
test runs dispatched, both failed on the account lock — proving the lock,
not the secrets. Live deploy unaffected (Cloudflare connector, not Actions).
Still blocked on the user clearing Settings → Billing.

**Rule (AGENTS.md §8):** if a job fails with 0 steps, it never started —
check the account/billing state before touching secrets or the workflow.

---

## 2026-11-15/17 — KV write quota spent by a preview upload every 15s; three browser tests lost

**Symptom:** a browser round lost three tests to a spent Cloudflare KV write
quota that no protocol test could see.

**Root cause:** a preview upload ran every 15s whether or not anything
changed — ~11,500 writes/day against a 1,000/day KV budget. Cost was
proportional to wall-clock time, not to user action.

**Fix:** cost must be proportional to user action, never wall-clock. State
moved to D1 (100k rows/day); KV kept for rollback only and treated as zero.
`scripts/checks/check-no-polling.sh` now enforces "no polling as the main
path" in server code.

**Verification:** D1 migration live 2026-11-15, storage harness 38/38.

**Rule (AGENTS.md §6):** cost must be proportional to user action, never
wall-clock. Check the quota before spending a session.

---

## 2026-11-17 — Pages _worker.js must be bundled with esbuild; relative imports are not resolved

**Symptom:** Pages direct-upload treats `_worker.js` as a single-file
Worker — relative imports are NOT resolved, and the deploy fails silently.

**Root cause:** direct-upload cannot resolve relative imports.

**Fix:** bundle `_worker.js` with esbuild before deploy.
`scripts/deploy-pages-proxy.py` bundles automatically and refuses
unbundled (esbuild required).

**Verification:** bundled deploys succeed first try; /computer UI/state 200,
COMPUTER_DB D1 binding works.

**Rule (AGENTS.md §4):** bundle `_worker.js` with esbuild before every
Pages deploy. Never deploy an unbundled `_worker.js`.

---

## 2026-11-17 — Browser tests: never two sessions on one computer; never type into the terminal with fill

**Symptom:** an overlapping browser run made working commands look broken.

**Root cause:** two sessions on the same computer interfere with each other,
and fill/set-value injects `^A` into the terminal.

**Fix:** one browser session per computer at a time; type into the terminal
key by key, never with fill/set-value.

**Verification:** B-36 + B-39 verified live in a real browser (T106, all 8
steps pass, 2026-11-17).

**Rule (AGENTS.md §1):** one browser session per computer at a time. Never
type into the terminal with fill/set-value.

---

## 2026-11-17 — _worker.js reads were twice flagged by a safety check; stop, disclose, ask

**Symptom:** reads of `pages/public/_worker.js` were twice flagged by a
system safety check.

**Root cause:** the file is the most important file (proxy, auth gate,
lease, capabilities) and reads of it trigger a safety flag.

**Fix:** stop, disclose plainly, ask, and proceed only on an informed
go-ahead. Follow the same pattern if flagged again.

**Verification:** both times the user gave informed go-aheads.

**Rule:** if a safety check flags a read, stop, disclose plainly, and ask.
Never work around a safety flag.

---

## 2026-11-18 — Loop-gate round 1: the gate double-counted 50 → 150 → 300

**Symptom:** a live test fired "Tool call budget reached (150 calls)" with
100 echoes executed.

**Root cause:** the parent merges a turn's tool-call blocks into the message
carrying the current `reply_id`, and the gate added the cumulative message
each round (50 → 150 → 300).

**Fix:** recompute the turn total from the reply-scoped blocks on every
check (gatefix1). Wire the gate into `DefaultMode` so it protects every
chat. `features/loop-gate-fix/`, T115 14/14.

**Verification:** derived image `qwenpaw-agentx:2.3.0-gatefix1` deployed;
honest bound ~50 (one batch), NOT a strict 30.

**Rule:** recompute a turn total from the reply-scoped source on every
check; never accumulate a cumulative message.

---

## 2026-11-18 — Loop-gate round 2: the gate was blind to the batch runner; 200 calls in 4 batches of 50

**Symptom:** a live test reached 200 echoes via 4 batches of 50; the gate
counted 4 top-level calls.

**Root cause:** the gate counted only top-level tool calls. The "Run
workflow" batch runner (`run_tool_batch`) executes sub-calls the gate never
saw.

**Fix:** expand a `run_tool_batch` call into its sub-calls (from its
arguments: inline actions or the JSON batch file) and count a completed
batch from its result JSON when its call could not be expanded; never count
twice (gatefix2). T115 29/29; a 50-step batch counts as 51.

**Verification:** derived image `qwenpaw-agentx:2.3.0-gatefix2` deployed.

**Rule:** a gate must count what actually executes, including sub-calls
inside a batch runner — not just top-level calls.

---

## 2026-11-18 — Loop-gate round 3: the gate fired but too late; 200 direct parallel calls in one response all executed

**Symptom:** a live test reached 200 echoes via 200 direct parallel calls
in ONE model response. The gate fired "Tool call budget reached (200
calls)" but its TERMINATE is deferred, so all 200 executed.

**Root cause:** the gate checks AFTER a model response and the stop is
deferred. A single-response burst executes before the stop can apply. A
gate that checks after the fact cannot stop a single-response burst.

**Fix:** enforce at execution time — `try_reserve_execution()` in
`ReactAgent._execute_tool_call` (the single funnel for tool-call
execution) reserves a slot synchronously before the first await; a refused
call yields a DENIED result and never executes. A batch call reserves its
sub-calls and is refused whole (gatefix3). T115 47/47.

**Verification:** machine-side live check 20 executed / 180 refused;
live browser test partial pass (20 executed / 30 refused, stopped at 50,
never reached 200).

**Rule:** a budget checked after the fact cannot stop a single-response
burst. Enforce at the execution funnel, before the first await.

---

## 2026-11-18 — Loop-gate live test: the per-turn cap resets; the agent resumed the task on "hello" (21–40)

**Symptom:** on the follow-up "hello", the agent resumed the number task
and executed echoes 21–40 (cumulative 40 across the chat).

**Root cause:** the cap is per-turn and resets every turn. A task can creep
forward across turns if the agent keeps resuming it.

**Fix:** a per-task cap (not per-turn) is a separate feature. The fork
already designed it (gogibeta/rakazo PR #73 per-turn fuse + PR #51
windowed loop-guard with structured stop audit).

**Verification:** live browser test partial pass, not a clean pass
(2026-11-18 ~13:43 IST).

**Rule:** a per-turn cap does not bound a task. If the task must be
bounded, cap the task, not the turn.

---

## 2026-11-18 — Derived image patched only /app/src; the fix was NOT live at runtime

**Symptom:** the first loop-gate build patched only `/app/src` and the fix
was not live at runtime.

**Root cause:** Python imports `qwenpaw` from
`/app/venv/lib/python3.11/site-packages/`, NOT `/app/src`.

**Fix:** apply any source patch to BOTH `/app/src` and site-packages.

**Verification:** gatefix1 redeployed with the patch in both copies;
console 200.

**Rule:** a derived-image patch must be applied to BOTH `/app/src` and
site-packages — Python imports from site-packages, not `/app/src`.

---

## 2026-11-18 — Log loss: truncate ran before the backup was verified; 1.39 MB of log lost

**Symptom:** the 1.39 MB `qwenpaw.log` (2026-11-14 18:12 to 2026-11-18
13:42) was lost during a maintenance window. No backup existed anywhere
(`docker logs` holds only 13 supervisor lines).

**Root cause:** the rotation ran `sudo gzip -c … > <backup>.gz` then
`sudo truncate -s 0`, but the `>` redirect runs in the unprivileged shell
(not under sudo) and the backup dir was root-owned, so the redirect failed
with Permission denied (twice), the `.gz` was never written, and the
truncate zeroed the live log anyway. Truncate ran before the backup was
verified. Impact was diagnostic only (not conversation history, not memory,
not session state), but it IS a loss of data, violating the no-loss rule
for that item.

**Fix:** `rotate-log.py` now verifies the archive BEFORE truncating (gzip →
check exists/non-empty/decompresses to exactly the original byte count →
only then truncate; on any failure exit 1 and leave the log untouched). A
systemd timer (`qwenpaw-log-rotate.timer`, daily 03:30 UTC) runs it.

**Verification:** rotate-log.py test-run once; timer installed + enabled.

**Rule:** never truncate/destroy before verifying the backup exists and
decompresses to the exact original byte count. A redirect after `sudo`
does not run as root.

---

## 2026-11-18 — PRAGMA journal_size_limit is NOT persistent

**Symptom:** DeepSeek's recommendation and the first `db_maintenance.py`
assumed `PRAGMA journal_size_limit` persists in the DB header.

**Root cause:** it does not. Verified on SQLite 3.45.1 and 3.46.1: a fresh
connection reads −1 even after another connection set it and wrote.

**Fix:** the durable WAL bound is SQLite's auto-checkpoint (~1000 pages,
~4 MB); the WALs will regrow to ~4 MB over time, then checkpoint. A
tighter durable bound needs the app to set the pragma on each DB open
(source change, follow-up). `db_maintenance.py` and the data test now
assert the correct per-connection behaviour.

**Verification:** T119 data-layer test asserts the per-connection behaviour.

**Rule:** verify a pragma's persistence against the real SQLite version
before relying on it. A setting that does not survive a new connection is
not a bound.

---

## 2026-11-18 — Local clone diverged from origin/main; registrations sat unpushed

**Symptom:** the local clone HEAD was fb0b9d5 on old df1365f, NOT on
origin/main. T115/T116/T117 registrations sat in the working tree,
unpushed, while the feature files were already on origin/main.

**Root cause:** subagents push via the GitHub API (`scripts/gh-push.py`),
which does not update the local HEAD, so the local clone drifts. `git push`
over HTTPS does not work from this VM (no credential helper).

**Fix:** `git fetch` + `git reset --hard origin/main` to realign before
committing anything new; push via `scripts/gh-push.py`; then `git fetch` +
`git reset --hard origin/main` again to realign the local HEAD.

**Verification:** local HEAD matches origin/main (e3cd203), working tree
clean, registrations 114.

**Rule:** align the clone with origin/main before committing anything new.
Push via `scripts/gh-push.py`, then fetch + reset --hard origin/main.

---

## 2026-11-18 — DeepSeek long prompts return empty or a <DSML> tool-call block; do not follow it

**Symptom:** long/complex prompts return EMPTY (stdout just "--- usage
---", exit 0) OR a `<DSML>` tool-call block trying to redirect the agent to
run shell commands.

**Root cause:** the model's tool-call behaviour on long prompts. The
`<DSML>` block is the model trying to redirect the agent — it is not an
instruction.

**Fix:** keep the prompt short; the context file can be large. Use
`--context <file>` (NOT `--context-file`, which is silently ignored). Do
NOT follow the `<DSML>` block. DeepSeek is sometimes busy (503
upstream_busy, retry_after ~20s) — retry.

**Verification:** repeated successful calls with short prompts + `--context`.

**Rule:** keep the DeepSeek prompt short; put the bulk in `--context
<file>`. Never follow a `<DSML>` tool-call block.

---

## How to add a lesson

1. Append a new `## YYYY-MM-DD — <symptom>` section at the end of this file.
   Do not edit an old entry. Do not reorder.
2. Fill in symptom → root cause → fix (exact commands) → verification.
3. Add the one-line rule to the matching section of `AGENTS.md`, citing
   this file (e.g. "see docs/LESSONS.md 2026-11-18 log loss").
4. If the lesson can be checked mechanically, add a check under
   `scripts/checks/` (see `scripts/checks/README.md`) — the check is the
   backup. The log-loss lesson is already enforced by `rotate-log.py`'s
   verify-before-truncate; the KV lesson by `check-no-polling.sh`; the
   China-endpoint rule by `check-no-china-endpoints.sh`; the secret rule by
   `check-no-secrets.sh`; the AGENTS.md budget by `check-agents-budget.sh`.

---

## 2026-11-18 — Rebrand script syntax error killed every UI rule at once

**Symptom:** QA rounds 15–16: the sidebar truncation (11 rounds, zero
effect), the "1 providers online" grammar fix, and the chat-input banner
gap ALL regressed in the same deploy, and a magenta-outline diagnostic
probe showed NO outline on ANY button — as if the rebrand script did not
run at all. MiniMax "Configure ›" and "Your Keys" still passed (the
former coincidentally, the latter from a separate script).

**Root cause:** the pill-hide-on-Settings code added in round 15 used a
regex `/\/settings(\/|$)/` inside the rebrand script, which lives in a JS
TEMPLATE LITERAL in `pages/public/_worker.js`. The template literal ate
the backslashes: `\/` became `/`, so the deployed code read
`//settings(/|$)/` — and `//` starts a LINE COMMENT, commenting out the
rest of the line. The next line (`if (onSettings) {`) then hit a
`SyntaxError: Unexpected token 'if'`, so the ENTIRE injected rebrand
script failed to parse and NO rule executed. `node --check` on
`_worker.js` never caught it: a template literal's content is just a
string to Node.

**Fix:** replaced the regex with a backslash-free string check
(`pathname.indexOf("/settings") !== -1`), removed the diagnostic probe,
and added `scripts/checks/check-rebrand-syntax.sh`, which extracts the
template literal, evaluates it the way the runtime does, and runs
`node --check` on the resulting inline script. The check was validated
both ways: it FAILS on the broken regex (same `Unexpected token 'if'`)
and PASSES on the fix.

**Verification:** `bash scripts/checks/run-checks.sh` ALL PASS (including
the new check); the fixed script was extracted from the deployed HTML
and parses cleanly.

**Rule:** never put a regex starting with `/\/` (or any regex whose
leading backslash the template literal can eat) inside the rebrand
template literal — prefer a plain string check. Every `_worker.js`
change must pass `check-rebrand-syntax.sh`, which syntax-checks the
EVALUATED injected script, not just the file.

## 2026-11-18 — Workers 1027: Pages 404 was a spent daily quota, not a deploy failure

**Symptom:** at ~23:26 IST both Pages sites (`qwenpawx`, `qwenpaw-frontend`)
started returning empty-body 404 on every worker-only route (`/`, `/chat`,
`/status`, `/api/session/state`), while static files still served
(`/search-settings-ui.js` 200, `/reset/` 200). QA round 20 was blocked.
Two redeploys of the same code changed nothing, and older preview URLs
that had worked hours earlier 404'd too.

**Misdiagnosis path (what was tried first):** the breakage coincided with
the round-19 `_worker.js` deploy, so the first theory was a broken worker
— but the bundle imports cleanly in Node (`default.fetch` is a function),
the working tree is byte-identical to `origin/main`, and a trivial
468-byte worker on a brand-new test project also never ran. The code was
never the problem.

**Root cause:** the Cloudflare account hit the Workers free-tier daily
limit — 100,000 requests/day, error code 1027. Every Worker on the
account returned 429 `error code: 1027`, including the long-running
`qwenpaw-keepalive` cron and a freshly deployed standalone worker. Pages
Functions are Workers: when the quota is spent they cannot execute, so
Pages falls back to static-asset serving, and since there is no
`index.html` (the console is proxied), every route 404s. Standalone
Workers had only 1,593 invocations that day — the burn is in Pages
Functions (the console proxy serves every Pages request; the likely
driver is the console SPA's own API polling across long open sessions
and multiple tabs, plus the QA rounds). The limit resets 00:00 UTC.

**Fix (workaround, not a cure):** deployed the same proxy as a standalone
Worker `qwenpaw-console`
(`https://qwenpaw-console.qwenpaw-rohan.workers.dev/`), built by
`scripts/build-console-fallback-worker.py`, which bundles
`pages/public/_worker.js` and replaces `env.ASSETS` with a shim that
fetches static files from the Pages static server. D1/KV are bound so
sleep/wake signals keep flowing. It is 429 until the reset, then it
works. Deliberately degraded: `/computer` mint + desktop, `/vault`
reveal, `/reset`, Rest — the Pages secrets are not readable via the API
and are never invented. The direct origin
(`https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/`) is the only
console access during the outage. Test project `qwenpaw-test-worker` was
deleted after the experiment.

**Verification:** direct origin 200 (38,125 B) and machine `running`
during the outage; fallback worker uploaded (startup 2 ms, subdomain
enabled) but 429/1027 until the reset — its live proof is due after
00:00 UTC, with a QA round-20 re-run.

**Rule:** when Pages returns empty-body 404s on worker-only routes while
static files serve, check the Workers quota FIRST (a fresh standalone
Worker returning 429/1027 proves it in one curl) — do not redeploy the
same code repeatedly. And: a Pages Function runs on every request to the
site, so its invocation count is the account's burn rate; consider a
`_routes.json` exclude for `/assets/*` (hashed, immutable — the Function
only adds cache headers there) to cut it.

## 2026-11-19 — Smart sleep/wake: the busy machine that never slept, and the status page that never knew the next run

**Symptom:** the machine ran the full ~8h max run on the evening of
2026-11-18 and took a forced ~2h cooldown (suspended 00:57 IST, back
03:04 IST), even though intelligent sleep/wake was deployed and working.
The user asked why the cooldown was so long and whether the cycle
repeats (it does: 8h on, ~2h off, fresh 8h). Separately, in integration
review, the new status page's "next scheduled run" could never show a
time: it reads `d.sleepwake.nextRoutineAt` from `GET /status`, but the
stored status never carried a `sleepwake` field.

**Cause (1):** `decideSleepWake` only sleeps an IDLE machine — every
guard (no visit 30 min, no agent activity 10 min) must pass. A machine
that stays busy all evening never qualifies, so it runs the full 8h
into the forced cooldown. The smart system was working as designed; the
design had no answer for a continuously-busy machine.

**Cause (2):** the keep-alive tick's hold-sleeping branch returns
`{...cached, sleepwake: {nextRoutineAt, ...}}` WITHOUT calling
`saveStatus`, so the `sleepwake` object is only ever in a live tick
response, never in the stored `qwenpaw:status` row that `GET /status`
serves. The status page therefore always rendered "Not scheduled".
No harness caught it: the pages harness checks the page reads the
field, not that the Worker provides it.

**Fix:** (1) max-run guard in `decideSleepWake` (T143): uptime >= 420
min (7h, 1h buffer before InstaBox's 8h wall) + machine up + state
running + no manual rest -> sleep with reason `max_run_guard`, even
with recent visit/agent activity. WAKE still wins (the routine-due
branch returns first) and unknown uptime (0) fails the threshold
(fail-closed). The guard respects the keep-alive toggle automatically
(the tick early-returns before `decideSleepWake` when OFF). (2) `GET
/status` now computes `sleepwake.nextRoutineAt` itself with the same
`computeNextRoutine` the tick uses (user-paced endpoint, so the extra
D1 reads are proportional to user action); Infinity/no-routines and
null/unknown both serialize as null. (3) Keep-alive ON/OFF toggle:
`POST /keepalive` (Bearer <redacted>, header only) flips D1
`keepalive:enabled`; the tick skips entirely when OFF (up to 288
req/day saved); `/status` + `/sleepwake/state` expose `keepAlive`.
(4) Hallmark waking/cooldown/status pages (no polling on status;
waking/cooldown `<title>` changed from em dash to colon to clear
Hallmark gate 19). (5) 22 net new AgentX rebrand rules (table 19 -> 41).

**Verification:** machine-free only — T143 72/72 + 105/105 (fail-first
48/72 + 44/105), T114 174/174 (fail-first 54/174), T108/T109 still
green, `check-rebrand-syntax.sh` PASS, sloplint 0 FAIL (1 WARN F16 on
status). DeepSeek review attempted 3 times, returned empty each time
(known gateway failure mode: long/complex prompts return empty stdout
with exit 0); the toggle/guard paths were verified by direct diff
review instead, which is what caught cause (2). NOT verified live:
deploy + browser (a real flip + skipping tick, a real 7h guard sleep,
the pages in a real browser) — blocked by the 1027 outage until the
00:00 UTC reset.

**Rule:** an idle-only sleep rule cannot protect a busy machine —
every sleep/wake design needs a max-run guard with a buffer before
the platform's hard wall. And: a page field is only real if the
endpoint that serves the page provides it — a harness that checks the
page reads a field must also check the endpoint returns it.

---

## 2026-11-19 — Sandbox end-to-end job failed exit 125: `invalid tmpfs option "16m"` — a bare size is not a docker tmpfs option

**Symptom:** the first end-to-end sandbox runner job (T139 live proof, post-reset) failed in 51 ms with exit 125: `docker: Error response from daemon: invalid tmpfs option "16m"`. The container never started; no probe ran.

**Root cause:** `features/sandbox/sandbox.py` `build_profile` wrote the tmpfs sizes as bare values (`"16m,noexec,nosuid,nodev"`). Docker's `--tmpfs` grammar wants `size=16m`; a bare size token is invalid and the daemon refuses the whole `docker run`. The machine-free test (T139, 50/50) could not see it: it asserted the profile dict, never the rendered argv against a real daemon — and the compose renderer next to it already used the correct `size=` form for the token tmpfs, so the wrong form looked consistent.

**Fix:** tmpfs values are now `"rw,noexec,nosuid,nodev,size=64m"` (and `size=16m` for `/run`); `validate_profile` rejects any tmpfs option token that is not a valid docker tmpfs option, so a hand-built profile with a bare size can never render; test A15 asserts the rendered argv carries `size=` on all three tmpfs mounts and that a bare-size profile fails validation.

**Verification:** 2026-11-19 ~05:55 IST — T139 51/51 (fail-first 7 passed / 44 failed); runner selftest 218/218; live end-to-end job `t139-live-e2e` → status ok, exit 0, `probe.txt` landed on the host, gateway unreachable from inside the job.

**Rule (AGENTS.md §1):** a machine-free test cannot see a daemon rejection — validate rendered commands against the tool's real option grammar, and run the rendering live the first time it executes.

---

## 2026-11-19 — QA round 20: four UI misses that all looked like the feature was broken — silent revert, over-broad guard, duplicate control, first-paint flash

**Symptom:** the post-reset browser round (2026-11-19 ~06:00 IST) found four issues in one session: (1) picking XHigh/Low in the new per-chat Thinking selector snapped back to Default immediately, silently, with no error — the user sees a control that does nothing; (2) TWO Thinking dropdowns were visible at once — the injected per-chat selector in the Smart Mode row and the console's own "Thinking intensity" control below the toolbar, unsynced (the native one held XHigh across chats, the injected one said Default); (3) Settings → Community & messages still showed "QwenPaw" in settled text (warning + "Connect QwenPaw…" button) and Settings → Models still listed "AgentScope Platform"; (4) on every page load the header briefly rendered the old "QwenPaw" wordmark before settling to "AgentX".

**Root cause:** (1) the backend is correct — deepseek-v4.1-flash-free takes no thinking level, so PUT returns 422 "Thinking setting is invalid for this model" and the selector reverts by design; the bug was the silence, not the revert. Machine proof the same morning: PUT low/xhigh → 422, GET still level "inherit", control kind "unknown", efforts []. (2) The injected selector never removed the native control; both bind the same per-chat setting through different paths. (3) The rename-text rule skipped a node when ANY descendant of its parent held a load-bearing string (`agentxIsLoadBearing(parent.textContent)`) — the Community section shares a container with a load-bearing token reference, so the whole section survived; "AgentScope Platform" was simply never in the rename list. (4) The rebrand runs in JS after the SPA mounts, so the logo img paints in its pre-rename state on first paint.

**Fix:** (1) the 422/409 branch reads the server's `detail` and shows it in a note next to the selector (clears on the next successful save or chat change); a GET whose control reports kind "unknown" with no efforts sets the selector title to "Thinking depth cannot be adjusted for this model". (2) New `hide-native-thinking` rule (42nd): hides any button/select whose accessible label contains "Thinking intensity", but only when the injected selector exists, so the user is never left with zero controls. (3) The parent load-bearing check now only applies when the parent is CODE/PRE/KBD/SAMP — a plain container sharing a load-bearing sibling no longer blocks the rename; "AgentScope Platform" is renamed to "AgentX Platform" unconditionally (display name, never load-bearing). (4) The injection adds a `<style>` hiding `img[alt*="QwenPaw"]` until rename-logo sets `data-agentx-logo` — `visibility`, not `display`, because the logo rule's size gate needs a real displayed width; the style is parsed with the initial HTML, before React mounts the logo.

**Verification:** 2026-11-19 ~06:4x IST — T142 29/29 (fail-first 27/29 on the pre-feature file), T114 181/181 (fail-first by construction for the 8 new checks; no whole-harness count — the only baseline, git HEAD, predates the thinking-selector and the harness crashes in its per-rule runner on that file). NOT verified live: Pages redeploy + browser re-check of all four fixes (note text, single dropdown, Community + AgentScope renames, no flash) — pending. The banner gap (~8px) is still unverified: the blue banner never appeared in the session.

**Rule (AGENTS.md §1):** a control that silently reverts looks broken — show the server's reason next to it. And: a load-bearing guard scoped to a whole ancestor hides legitimate renames — scope it to code-like parents only.

---

## 2026-11-19 — QA round 20, DOM-inspection round: the hide rule matched the wrong screen's label, and the rename matched a phrase the DOM never contains

**Symptom:** after the first QA-round-20 fix round deployed, the browser re-check (2026-11-19 ~06:55 IST) still showed TWO Thinking dropdowns and the Models card still "AgentScope Plat…", while the 422 note, the logo flash fix and the Community rename all passed.

**Root cause:** (1) The hide-native-thinking rule matched the label "Thinking intensity", taken from the console bundle's i18n strings — but that label belongs to a different screen's control. The composer's native control is a plain `<select>` whose accessible name is "Thinking level for this chat" — IDENTICAL to the injected selector's name, same options, same default title. The rule could never match it. The two controls are indistinguishable by tag, name, options, value or parent; the only discriminator is the `data-agentx-thinking` attribute our select carries (set before append) — and the title after sync (ours becomes the lock hint on a locked model). (2) The Models provider card renders the display name TRUNCATED in the DOM ("AgentScope Plat…") — the card's accessible name is "AgentScope Plat… Configure" and a page search for "AgentScope Platform" finds nothing, so the full-phrase rename could never match. The name comes from the backend API; the truncation happens in the card render.

**Fix:** (1) the hide rule now matches "thinking level for this chat" as well as "thinking intensity", and relies on the data-agentx-thinking exclusion (not the label) to protect our select. (2) The rename now handles the truncated form "AgentScope Plat…" → "AgentX Plat…" plus a bare "AgentScope" token → "AgentX" (any truncation length), alongside the full phrase.

**Verification:** 2026-11-19 ~07:1x IST — T114 186/186 (fail-first: exactly the 5 new checks fail against the pre-fix file, 181 passed / 5 failed). NOT verified live: Pages redeploy + browser re-check of the two fixes — pending.

**Rule (AGENTS.md §1):** a hide/match rule must use the control's real live label, not a label found in the bundle's strings for another screen — verify against the live DOM. And: a display name may render truncated — rename the truncated form too, never only the full phrase.

## 2026-11-19 — the duplicate Thinking dropdown was our own selector (UI fix v3)

- **What happened:** the v2 browser re-check still showed two Thinking dropdowns in the chat composer. DOM inspection + a bundle grep proved the lower one was NOT the console's native control: the string "Thinking level for this chat" appears NOWHERE in the console bundles (index-DZrIuh3B.js, index-opcB8AGu.js, chat-vendor-C3WkBJSI.js) — its only source is our injected thinking-selector rule. The rule's creation guard was toolbar-scoped (`toolbar.querySelector("[data-agentx-thinking]")`), but the anchor resolves to a DIFFERENT container on different passes: the chat-input grandparent (fallback, before Smart Mode mounts) and the Smart Mode row (after). The fallback-created select stayed below the toolbar while a second one was created in the Smart Mode row. The sync only updated the first in DOM order, so the upper one carried the lock-hint title and the lower the default title — matching the observation exactly.
- **Fix:** the guard is now document-wide (`document.querySelector("[data-agentx-thinking]")` — one select per document, ever) and the rule MOVES its own label + select into the Smart Mode row when that anchor appears (appendChild on our own elements only, never React's nodes). The hide-native-thinking rule (which chased the real label "Thinking level for this chat" in v2) stays as a safety net for a future console update; it is harmless because the attribute exclusion protects the injected select.
- **Lesson (same class as the tmpfs bug):** before assuming a live UI element belongs to the upstream app, grep the deployed bundles for its distinguishing string. If the string exists nowhere in the app, the element is ours. And an injected element that can be created under different anchors needs a document-wide guard — an anchor-scoped guard cannot see an instance created under another anchor.
- **Tests:** T142 grew a two-container regression test (create under the fallback anchor with Smart Mode unmounted, mount Smart Mode, re-run: still exactly ONE select, now in the Smart Mode row) + a static check that the rule uses the document-wide guard. The mock's appendChild now models real DOM move semantics (a moved node leaves its old parent), or a moved node counts twice. T142 29 -> 32 (fail-first: the 2 discriminating new checks fail on the pre-fix file, 30 passed / 2 failed). T114 unchanged (186/186).
- **Status:** code + harness green, pushed, Pages deployed (qwenpawx 2cd389bf, frontend 02149bfd); live browser re-verified 2026-11-19 ~07:45-07:50 IST — ALL PASS, exactly one Thinking dropdown in the Smart Mode row.

## 2026-11-19 — multi-tab takeover needs a bundle patch, not just injection (Step 10)

- **What happened:** the console's single-sender ownership lock (Web Lock `qwenpaw:queue-owner:{chatUUID}`) leaves a non-owner tab queuing forever, and its "Interrupt & send" button is a dead no-op there (it returns early when the tab is not the owner). The fix has two halves that must land together: the owner tab must abort its ownership AbortController on a `BroadcastChannel("qwenpaw:queue")` `release-ownership` message (a bundle patch — the listener lives in the minified shared chunk `index-DZrIuh3B.js`, the controller in the chat chunk `index-opcB8AGu.js`), and the Pages `_worker.js` rule must add the "Take over sending" button that posts it (plus hide the dead Interrupt button while the banner is up).
- **Fix:** `features/queue-takeover/apply-queue-takeover.py` does exact string surgery (unified diff cannot address a fragment mid-line in a minified bundle), failing closed unless every anchor occurs exactly once in the file; a second run on patched output fails too (no double-patch). The anchors were verified exactly-once in BOTH copies of both files on the live machine (the console assets live in `/app/src/...` AND site-packages, byte-identical) before the patch was written. `Dockerfile.takeover1` builds FROM the live image, patches both copies, and `node --check`s both. T145 (26 checks) runs the apply script for real against the verbatim live excerpts.
- **Lesson:** a minified bundle is patched by exact-anchor string surgery with a count==1 guard, never by a line-based diff. And a container restart is a deployment event with a cost: it drops in-flight agent work, so a redeploy waits for the T136 judge to finish (repo AGENTS.md §3 says the same). The Pages half can ship first — a button posting to an unpatched bundle is a harmless no-op until the image lands.
- **Status:** code + harness green (T145 26/26, T114 195/195); image build next, container redeploy + live two-tab test pending after the T136 judge (~08:50–09:00 IST).

## 2026-11-19 — two workers, one working tree: the harness is the arbiter

- **What happened:** the post-reset-verify cron worker and a parallel worker both edited `pages/public/_worker.js` at ~08:04 IST (the cron's first-draft `settings-white-area` rule — bare first-`main`, 100vh only, body-only paint — and the parallel worker's T114 checks for the fuller rule). The parallel worker's harness ran the first-draft rule: 189/195, 6 dynamic checks failed (100vh not 100dvh, body-only paint, no ancestor walk, painted before the nav mounted). It upgraded the rule in place — no second rule added — to the nav-anchored shell, 100dvh + box-sizing, html + body paint, ancestor walk, and nav-mount guard. 195/195 after.
- **Lesson:** when two workers share a working tree, a first draft that passes its own checks can still fail the other worker's fuller harness — run the FULL harness (not just your own new test) before calling a rule done, and let the harness, not either worker's prose, decide what "done" means. Record who wrote what in PLAN.md/TESTS.md so the next reader can tell the drafts apart.
- **Status:** the fuller rule is live in the tree (T114 195/195, T144 9/9); its live browser check (light + dark, top + max scroll) is pending after the Pages deploy.

## 2026-11-19 — the white strip was a covering wrapper, not the body (settings-white-area round 3)

- **What happened:** round 2 of the settings-white-area fix changed nothing live — the strip stayed ~104px in light mode even though curl showed the new code in the served HTML. Diagnosis from the SERVED console bundle (index-tgCT4NPx.css): the shell (.page-content) is transparent inside a WHITE full-height .index-module__mainContentLayout wrapper (background:var(--app-surface), height:100%) that covers the <html>/<body> paint. Round 2 painted only the document elements, never the wrapper. The round-2 harness mock had no covering wrapper, so it passed 198/198 while live showed zero effect.
- **Fix:** the rule now paints the shell AND every ancestor with the theme paint (--app-bg, #f9f8f4 light / #141414 dark), keeps the 100dvh stretch, and writes a TEMPORARY visible diagnostic line (AX-DIAG, elementFromPoint strip probes) readable as page text — the cloud browser has no DevTools, so the probe must be readable as text; the line is removed in the follow-up round once the values are read. The mock now models the realistic DOM (transparent shell inside the white wrapper, offsetHeight 894 in a 998 viewport, elementFromPoint). A second bug surfaced while fixing: the rule's join with a newline escape broke check-rebrand-syntax — the rebrand section lives inside a template literal, so a backslash escape arrives in the injected script as a real newline (even inside a comment) and breaks parsing; the join now uses String.fromCharCode(10) and the section has zero backslashes. The old cleanup test also caught html paint surviving (the mock's querySelectorAll never searched <html>), so cleanup removes <html>'s paint directly and the mock searches from <html>.
- **Lesson:** an injected paint on <html>/<body> is invisible when a full-height wrapper between them and the shell carries its own background — paint the shell and every ancestor, not just the document elements. And a harness mock without the covering element passes while live fails — model the element that actually paints the pixels. Also: no backslash escapes anywhere in the rebrand section, not even in comments — the template literal unescapes them all.
- **Tests:** T114 198 -> 205, T144 12 -> 19 (fail-first: 198/205 against the round-2 rule, all 7 new checks failed). Machine-free subset 15 PASS + 4 pre-existing NEEDS-REBUILD; run-checks.sh ALL PASS; secret scan PASS.
- **Status:** code + harness green, pushed; Pages deploy + browser re-verification (light + dark, top + max scroll, reading the diagnostic line) pending with Muse.
