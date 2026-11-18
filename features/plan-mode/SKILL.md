---
name: plan-mode
description: "Read-only plan mode: enter with /plan, explore without mutating anything, write a numbered plan (files, commands, expected diff, risks) to plans/<timestamp>.md, and execute it only after the user approves. Enforcement is at the tool layer (features/plan-mode/plan_mode.py) — the gate refuses mutating calls with the blocked tool named. Modelled on OpenCode's Plan agent (read-only) vs Build, Claude Code's EnterPlanMode / --permission-mode plan, and Gemini CLI's EnterPlanMode + WriteTodos."
version: "1.0"
when_to_use:
  - "Before any multi-step change: a new feature, a refactor, a fix touching more than one file, a deploy, or anything the user has not already approved step by step."
  - "When the user says /plan, 'plan first', 'don't change anything yet', or 'show me the plan'."
  - "When you are unsure what a task touches — plan mode is how you find out without breaking anything."
allowed_tools:
  - "read_file"
  - "list_dir"
  - "glob"
  - "grep"
  - "search"
  - "web_search"
  - "web_fetch"
  - "memory_search"
  - "memory_read"
  - "git_status"
  - "git_log"
  - "git_diff"
  - "bash (read-only commands only: ls, cat, grep, git status/log/diff — any command that writes is refused)"
metadata:
  qwenpaw:
    emoji: "📋"
    requires:
      bins: ["python3"]
---

# Plan mode — read-only plan before any mutation

You are in plan mode. Your job is to **understand first, change nothing**.
The plan you write is what the user approves — or rejects — before a
single file changes.

## How to enter and exit

- **Enter:** the user says `/plan` (or "plan first", "don't change
  anything yet"). Run:
  `python3 features/plan-mode/plan_mode.py enter --task "<the task>"`
  From here the gate is on.
- **Exit without executing:** the user says `/exit-plan`, or the plan is
  rejected. Run: `python3 features/plan-mode/plan_mode.py exit`
  The draft plan file stays on disk as a record; it is never executed
  after an exit.
- **Approve and execute:** only the user approves, by saying `approve`
  (or running `python3 features/plan-mode/plan_mode.py approve
  plans/<timestamp>.md`). There is no auto-approve, no timeout-approve,
  and no approval by silence.

## What you may do in plan mode (the gate enforces this, not your prompt)

Allowed — read-only only:

- Read files, list directories, search the codebase (`grep`, `glob`).
- Read the web (`web_search`, `web_fetch`) and read memory
  (`memory_search`, `memory_read`).
- Read git state (`git status`, `git log`, `git diff`).
- Run read-only shell commands: `ls`, `cat`, `grep`, `git status`.
  The gate classifies the command text; anything that writes is refused.

Refused — the gate raises `PLAN MODE DENIED` naming the blocked tool:

- `write_file`, `edit_file`, `delete_file`, `move_file`, `create_dir`.
- Any shell command that writes: redirection (`>`), `rm`/`mv`/`cp`/
  `mkdir`/`touch`, `sed -i`, `git commit`/`push`/`add`/`checkout`,
  `docker …`, `curl -X POST` (or any curl with a body), `chmod`, `kill`.
- `git_commit`, `git_push`, `deploy`, `docker_restart`, `vault_write`,
  `send_message`, and any tool not on the read-only allowlist
  (unknown tools are denied by default).

If the gate refuses you, **do not work around it** — do not rephrase a
write as a read, do not split a command to dodge the classifier, do not
ask another tool to do it. Tell the user what was refused and put it in
the plan instead.

## What you must produce: the plan file

Write the plan with the module (it is the one write plan mode performs,
and it goes to `plans/` only):

```python
import importlib.util
spec = importlib.util.spec_from_file_location(
    "plan_mode", "features/plan-mode/plan_mode.py")
pm_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pm_mod)
Plan, PlanStep, PlanMode = pm_mod.Plan, pm_mod.PlanStep, pm_mod.PlanMode

pm = PlanMode("features/plan-mode/plans")
pm.enter("<the task>")
pm.write_plan(Plan(
    task="<the task>",
    steps=[
        PlanStep(id="step-1", tool="write_file",
                 description="Create <file>"),
        PlanStep(id="step-2", tool="bash",
                 description="Run the machine-free suite subset",
                 command="python3 features/test-project/run-tests.py --only T122"),
    ],
    files=["<file> (create/edit/delete — one line per file)"],
    commands=["<exact command, one per line>"],
    diff="<what the diff will look like, in words>",
    risks=["<one risk per line, with what could go wrong>"],
))
```

The file lands at `plans/<timestamp>.md` (UTC, e.g.
`plans/20261118T143000Z.md`) with these required sections — a plan
missing any of them cannot be approved:

- `## Steps` — numbered, one per step: `1. [step-1] (tool: write_file)
  Create <file>`. Every step names its tool. Bash steps carry the exact
  command in backticks.
- `## Files to touch` — every file, with create/edit/delete.
- `## Commands to run` — exact commands, no paraphrase.
- `## Expected diff` — what the change will look like.
- `## Risks` — what could go wrong, including the worst case.

Then show the plan to the user and stop. Do not execute anything.
Do not "just do the first small step" while waiting — there is no small
step in plan mode.

## After approval: execution starts FROM the plan

Once the user approves, run the plan through the module — never by
hand, never from memory:

```python
pm.approve("features/plan-mode/plans/<timestamp>.md")
pm.execute("features/plan-mode/plans/<timestamp>.md", runner)
```

- `approve()` validates the plan (all sections + at least one step,
  unique ids, known tools) and records exactly which step ids may run,
  bound to the plan file itself: its path, its SHA-256, and its ordered
  steps (id, tool, and for bash steps the exact command). Editing or
  reordering the plan after approval voids the approval.
- `execute()` re-checks every step through the gate. A mutating call
  needs the `step_id` of a step in the approved plan, and the tool must
  be that step's tool (for bash, the command must be the step's exact
  command) — an approved step id cannot be reused for a different tool
  or command. A call with no step, or a step that is not in the plan,
  is refused. The executed steps are exactly the plan's steps, in
  order — no silent extras — and a plan executes at most once: a second
  `execute()` or a replayed step is refused.
- If the plan file changes after approval, `execute()` refuses it:
  re-approve.
- If the user changes their mind mid-execution, exit plan mode
  (`/exit-plan`); the remaining steps do not run.

## What this skill does NOT do

- It does not approve itself. Approval is the user's word, nothing else.
- It does not snapshot or roll back the workspace — that is gap #3
  (checkpoints + rollback), not this skill. Plan mode stops bad changes
  from starting; it cannot undo one that already ran.
- It does not sandbox the shell: the classifier judges the command
  text. A command that *looks* read-only but whose program writes
  files (running a test suite, a build) is allowed in planning mode
  only if it is genuinely read-only — prefer `ls`/`cat`/`grep`/
  `git status` while planning, and put anything with side effects in
  the plan as a step instead.
- It is not enabled by default. New skills in this repo default to
  DISABLED until enabled — enabling this skill on the machine (and
  wiring the agent loop to call `PlanMode.enforce()` before dispatching
  a tool) is a deploy step, not verified here. Until the loop calls the
  gate, the module is a library the agent can import, not a live guard.

## Status

- Code complete, machine-free test T122 green (43/43). Fail-first
  proven: with the enforcer swapped for a permissive stand-in, 20 of
  43 checks fail (mutations allowed, execution starts before approval,
  the plan executes three times in one run).
- DeepSeek design review done 2026-11-18 (10,469 tokens): 9 real
  findings fixed — shell denylist expanded, approved step ids bound to
  tool + command, plan approval bound to file SHA-256 + ordered steps,
  at-most-once execution, duplicate ids rejected, corrupt state fails
  closed. Details in features/plan-mode/README.md.
- NOT verified live: no browser check, no machine check, no run of the
  agent loop through the gate. That verification is the parent's job.
