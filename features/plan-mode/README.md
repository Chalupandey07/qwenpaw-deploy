# Plan mode — a read-only plan before any mutation

**Status:** code complete, machine-free test T122 green (43/43).
**Not verified live:** no browser check, no machine check, no run of the
agent loop through the gate. That verification is the parent's job.

**Design review:** DeepSeek (deepseek-v4.1-flash-free) reviewed the
finished design on 2026-11-18 (10,469 tokens: 894 in, 9,575 out) and
returned 12 findings; 9 were real and are fixed in the code + covered
by tests (see "DeepSeek review" below). Two of its claims were checked
against the real code and are wrong (`enter`/`approve` merging stale
approvals — both replace, not merge). The rest are documented limits.

Gap #2 from the 2026-11-18 agent research
(`~/workspace/agent-research-2026-11-18.md` §2 gap 2, §4 "Planning",
§6 recommendation 2). Modelled on OpenCode's Plan agent (read-only) vs
Build, Claude Code's `EnterPlanMode` / `--permission-mode plan`, and
Gemini CLI's `EnterPlanMode` + `WriteTodos`. The biggest cause of wasted
loops and destructive mistakes is acting before understanding — so the
plan comes first, and the enforcement is at the tool layer, not in a
prompt.

## Files

| File | What it is |
|---|---|
| `plan_mode.py` | The enforcer: `ToolGate`, `PlanMode`, plan-file read/write/validate, CLI. Stdlib only. |
| `test_plan_mode.py` | Machine-free test (T122, 35 checks) incl. fail-first `--gate permissive` mode. |
| `SKILL.md` | The `plan-mode` skill: frontmatter (name, description, when-to-use, allowed tools) + the agent-facing procedure. New skills default to DISABLED until enabled. |
| `plans/` | Where plan files land (`plans/<timestamp>.md`) + the mode state file `.plan-mode-state.json`. |

## How to enter / exit plan mode

- **Enter** — the user says `/plan` (or "plan first", "don't change
  anything yet"):
  ```bash
  python3 features/plan-mode/plan_mode.py enter --task "<the task>"
  ```
  The gate is on from here. State is saved to
  `plans/.plan-mode-state.json` so the CLI and the agent loop share one
  mode.
- **Exit without executing** — the user says `/exit-plan`, or rejects
  the plan:
  ```bash
  python3 features/plan-mode/plan_mode.py exit
  ```
  The draft plan file stays on disk as a record; it is never executed
  after an exit.
- **Check the mode / ask the gate about one call:**
  ```bash
  python3 features/plan-mode/plan_mode.py status
  python3 features/plan-mode/plan_mode.py check --tool write_file
  python3 features/plan-mode/plan_mode.py check --tool bash --command "git status"
  ```
  `check` exits 1 with the denial when the call would be refused.

## The read-only allowlist

In planning mode these tools run; everything else is refused:

- **Allowed:** `read_file`, `list_dir`, `glob`, `grep`, `search`,
  `web_search`, `web_fetch`, `memory_search`, `memory_read`,
  `git_status`, `git_log`, `git_diff`, `show_plan`, `plan_status`.
- **Allowed conditionally:** `bash` / `shell` — only when the command
  text is read-only (`ls`, `cat`, `grep`, `git status/log/diff`,
  read-only pipelines). The classifier is conservative: any segment
  that writes makes the whole command mutating. It covers redirection,
  `rm`/`mv`/`cp`/`mkdir`/`touch`/`ln`/`unlink`/`dd`, `tar` extract,
  `unzip`, `patch`, `make`, `find -delete`, `sed -i` (incl. `-ni` and
  `--in-place`), `perl -pi`, mutating `git` subcommands (incl. through
  global options like `git -C <dir> commit`, and `clone`/`init`/`apply`/
  `restore`/`clean`/`pull`/`fetch`), `docker …`, `curl` with a write
  method / body / `-o` / `-T`, `wget -O` / `--post-*`, `chmod`/`chown`/
  `kill`/`truncate`/`systemctl`, `python -c`/`-m`, `node`/`ruby`/`perl
  -e`, `python open(…, 'w'/'a')`, `os.remove`/`shutil`/`subprocess`,
  `pip`/`npm`/`apt install`.
- **Read-only tools, writing arguments — refused:** a nominally
  read-only tool is checked too: `git_diff --output=<file>` is refused,
  as is any `git_*` flag outside the safe set, and `web_fetch` with a
  non-GET method or a request body.
- **Refused, denial naming the tool:** `write_file`, `edit_file`,
  `delete_file`, `move_file`, `create_dir`, `git_commit`, `git_push`,
  `git_checkout`, `git_add`, `git_reset`, `deploy`, `docker_restart`,
  `docker_exec`, `vault_write`, `send_message`, and any tool not on
  the allowlist (unknown tools are denied by default — an allowlist
  that silently passes a tool it has never seen is not an allowlist).

A refusal looks like this (the tool is always named):

```
PLAN MODE DENIED: tool 'write_file' — tool 'write_file' mutates state
and plan mode is active — write the plan first, then get it approved;
no file, repo, deploy or container change is allowed until approval
```

The agent loop must call `PlanMode.enforce(tool, args)` before
dispatching any tool, and must not work around a refusal (no rephrasing
a write as a read, no splitting a command to dodge the classifier).
Until the loop calls the gate, this module is a library, not a live
guard — wiring it into the loop is a deploy step, not done here.

## The plan file format

Written by `PlanMode.write_plan()` to `plans/<timestamp>.md` (UTC,
e.g. `plans/20261118T143000Z.md`). Writing the plan is the one write
plan mode itself performs, and it goes to `plans/` only.

```markdown
# Plan: <task>

- Created: <ISO UTC>
- Status: draft | approved

## Goal

<the task>

## Steps

1. [step-1] (tool: write_file) Create <file>
2. [step-2] (tool: bash) Run the machine-free suite subset — `python3 features/test-project/run-tests.py --only T122`

## Files to touch

- <file> (create/edit/delete — one line per file)

## Commands to run

- `<exact command>`

## Expected diff

<what the change will look like, in words>

## Risks

- <one risk per line, including the worst case>

## Approval

Not yet approved. / Approved — execution may run only the steps above, in order.
```

Required sections (a plan missing any of them cannot be approved —
`validate_plan()` returns the missing list): `## Steps` (at least one
numbered step, each naming its tool; bash steps carry the exact command
in backticks), `## Files to touch`, `## Commands to run`,
`## Expected diff`, `## Risks`.

## The approval step

Exactly one mechanism: **the user says `approve`** (or runs
`plan_mode.py approve <plan-file>`). No auto-approve, no
timeout-approve, no approval by silence.

```bash
python3 features/plan-mode/plan_mode.py approve plans/20261118T143000Z.md
```

`approve()` validates the plan, flips the mode to `approved`, marks
the file `Status: approved`, and records exactly which step ids may
run. Nothing executes at approval time — approval only unlocks the
plan's steps. Approval is bound to that exact file: its path, its
SHA-256, and its ordered steps (id, tool, and for bash steps the exact
command). Editing, reordering, or swapping the plan after approval
voids the approval — `execute()` re-hashes and re-compares and refuses
on any difference. Approving plan A never authorises plan B.
`approve()` only runs from planning mode and only for a plan inside
`plans/`. A plan with a duplicate step id, an unknown tool, or a
malformed step line cannot be approved at all.

Execution then starts **from the plan**, through the module — never by
hand, never from memory:

```python
pm.execute("features/plan-mode/plans/<timestamp>.md", runner)
```

`runner` is a callable taking one `PlanStep` and performing it (in
production: the agent loop's tool dispatcher). Each step is re-checked
through the gate: a mutating call needs the `step_id` of a step in the
approved plan, and the tool must be that step's tool (for bash, the
command must be the step's exact command) — an approved step id cannot
be reused for a different tool or command. A call with no step, or a
step not in the plan, is refused. The executed steps are exactly the
plan's steps, in order — no silent extras. A plan executes at most
once: each step is recorded (and the state saved) as soon as it runs,
so a second `execute()` or a replayed step is refused, and a mid-run
failure leaves the executed prefix on record. If the user changes their
mind mid-execution, exit plan mode; the remaining steps do not run.

## Test (T122)

```bash
python3 features/plan-mode/test_plan_mode.py --selftest          # must PASS 43/43
python3 features/plan-mode/test_plan_mode.py --selftest --gate permissive  # must FAIL
```

43 checks: (a) 7 read-only calls allowed in plan mode; (b) 12 mutating
calls refused with the tool named (write/edit/delete, git commit,
deploy, shell `>` / `rm` / `git push` / `curl -X POST`, unknown tool,
`git_diff --output`, `web_fetch` POST); (c) 10 plan-file checks
(written under `plans/<timestamp>.md`, all five required sections
present, validates, a plan missing `## Risks` fails validation, a
duplicate step id fails validation, two plans in the same second get
distinct paths); (d) execution before approval refused
(`PlanNotApproved`, nothing ran); (e) 13 approval/execution checks
(approve accepts the valid plan and marks it approved, approved step
runs, unlisted step refused, no-step call refused, approved step id +
wrong tool refused, approved bash step + different command refused,
`execute()` runs exactly the 3 plan steps in order, a second
`execute()` refused, an extra step refused, exit returns the gate to
off, `write_plan` works in planning mode but not after exit, a corrupt
state file loads as planning, fail closed).

Fail-first, measured: with the enforcer swapped for the permissive
stand-in (what "plan mode" is when it is only a prompt), **23 passed,
20 failed** (exit 1) — all 12 mutation refusals fail (calls allowed),
execution starts before approval and runs the steps, an unlisted step
runs, an approved id is reused for another tool/command, and the plan
executes three times in one run (the double/triple-run shows up as a
duplicated execution record). With the enforcer, **43 passed, 0 failed**.

## DeepSeek design review (2026-11-18)

One call, deepseek-v4.1-flash-free via `seek.py`, `--max-tokens 65536`,
`--context` the finished `plan_mode.py` plus a short design summary
(the first two attempts returned nothing usable — a 503 `upstream_busy`,
then an empty response — so the successful call used the summary as
context; the tool itself was verified working with a trivial call in
between). Tokens: 894 prompt + 9,575 completion = 10,469 total.
No `<DSML>` block, no instructions followed from the output — every
finding was checked against the real code before acting.

Fixed (9 findings, each covered by a new test):

1. **Bash denylist incomplete** — `dd`, `git clone/init/apply/restore/
   clean/pull/fetch`, `ln`, `tar xf`, `unzip`, `patch`, `make`,
   `pip/npm/apt install`, `curl -o/-d/-T`, `wget -O`, `perl -pi`,
   `find -delete`, `node/ruby/perl -e` all passed as "read-only".
   The pattern list now covers them (tests B6–B9 + the new patterns).
2. **Pattern evasions** — `git -C repo commit`, `sed -ni`,
   `python3 -c "open(...)"`, append mode `'a'`. The git pattern now
   skips global options; `sed` matches flag clusters and `--in-place`;
   `python -c`/`-m` is refused outright.
3. **Approved step-id reuse** — the gate checked only `step_id in
   approved_steps`, so an approved id could run any tool. Approval
   now binds id → tool (and bash command); mismatches are refused
   (tests E10, E11).
4. **Read-only tools with writing args** — `git_diff --output=<file>`
   and `web_fetch` POST. Both are now validated and refused
   (tests B11, B12).
5. **Execute compared id sets, not content** — editing/reordering the
   plan after approval kept the same ids. Approval now records the
   plan SHA-256 + ordered (id, tool, command); `execute()` re-hashes
   and re-compares.
6. **Duplicate step ids** — set comparison collapsed them. Validation
   now rejects duplicates (test C9).
7. **Approval was global, not per-plan** — approving A could authorise
   B with matching ids. `execute()` now requires the approved path +
   hash (finding 5's fix).
8. **Approve under-constrained** — it now requires planning mode, a
   path inside `plans/`, unique ids, and known tools.
9. **No execution ledger** — `execute()` twice reran everything. Each
   step is recorded + state saved as it runs; a second execute or a
   replay is refused (test E12). Same-second plan filenames now get
   `-2`/`-3` suffixes so a draft cannot overwrite the reviewed plan
   (test C10), and a corrupt state file loads as planning, fail closed
   (test E13).

Checked against the real code and NOT a bug: the review (which saw
only the summary, not the code) claimed `enter` does not clear
approved steps and `approve` merges rather than replaces — both are
wrong: `enter()` clears `approved_steps`/`executed_steps` and
`approve()` assigns fresh values. The parser claim (descriptions
containing `##` or `[id] (tool:`) is also not a hole: step lines are
matched by a line-anchored regex, so a description cannot inject a
step or a section; malformed numbered lines are now rejected by
validation anyway.

Still open, documented as limits (see below): the denylist can never
be complete (a command whose *program* writes despite looking
read-only); `exit` cannot recall a call already dispatched; `git
status` may refresh `.git/index` as git bookkeeping.

Registration (for the parent to add — this feature does not edit
`run-tests.py` or `TESTS.md` itself):

```python
("T122", "plan mode: read-only plan before any mutation — ToolGate refuses mutating calls naming the tool, plan file with required sections, no execution before approval, after approval only the plan's steps run in order and at most once (selftest)", "plan-mode", "protocol", t122),
```

## What is NOT verified live

- No browser check (the console has no plan-mode UI; there is nothing
  to click yet).
- No machine check (the module has never run on the InstaBox box).
- No run of the agent loop through the gate: `PlanMode.enforce()`
  must be wired into the loop's tool dispatch, and the `plan-mode`
  skill must be enabled (new skills default to DISABLED). Both are
  deploy steps for the parent/Muse, not done here.
- The shell classifier judges command text, not what the program it
  runs does. A command that *looks* read-only but whose program writes
  files (a test run, a build) is the residual risk: while planning,
  prefer `ls`/`cat`/`grep`/`git status`, and put anything with side
  effects in the plan as a step instead of running it. A denylist can
  never be complete — new mutating shapes are found by review, not by
  proof.
- `exit` cannot recall a call already dispatched: leaving plan mode
  stops *future* steps, not one already running.
- `git status` may refresh `.git/index` as git's own bookkeeping.
  That is not agent data loss, but it is a write the gate does not
  (and cannot, short of forbidding `git status`) prevent.
- Plan mode does not snapshot or roll back the workspace — that is
  gap #3 (checkpoints + rollback). It stops bad changes from starting;
  it cannot undo one that already ran.
