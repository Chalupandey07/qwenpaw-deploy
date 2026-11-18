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
