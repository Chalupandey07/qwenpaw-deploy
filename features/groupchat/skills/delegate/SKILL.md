---
name: delegate
description: Use this skill when one task splits into two or more independent sub-tasks that can run in parallel. Dispatch each sub-task to another agent with submit_to_agent (background) or chat_with_agent (quick), track every dispatch in delegations.json, then merge the results into one summary.
metadata:
  builtin_skill_version: "1.0"
  qwenpaw:
    emoji: "🧩"
---

# Delegate

## When to Use

Use this skill when **one task splits into two or more independent sub-tasks
that can run in parallel** — for example researching several topics at once,
reviewing several files, or drafting several sections of one document.

### Should Use

- The task has clearly independent parts with no dependency between them
- A part is clearly better suited to a specialized agent (list agents first)
- The user explicitly asks to split the work or run parts in parallel
- A part is slow (large analysis, batch work) and the rest should not wait

### Should Not Use

- The task is a single quick question you can answer yourself
- The parts depend on each other's output — do them in order instead
- You just received a delegated sub-task — do the work, do not re-delegate
  it to another agent (see Loop Guards)
- The target agent is unclear — ask the user or list agents first

## Decision Rules

1. **List agents before dispatching — do not guess IDs** (`list_agents()`)
2. **One sub-task = one dispatch.** Never send the same sub-task twice.
3. **Background by default for real work**: `submit_to_agent(...)`, then
   `check_agent_task(...)`. Use foreground `chat_with_agent(...)` only for
   quick questions that finish in seconds.
4. **Record every dispatch in `delegations.json` before moving on** — a
   dispatch that is not recorded is a dispatch that will be lost.
5. **Wait, then merge**: collect all results first, then write ONE summary.
   Never report partial results as final.

---

## Tracking File: `delegations.json`

Keep it in your own workspace root (for the default agent:
`/app/working/workspaces/default/delegations.json`). Never write it to
`jobs.json` — that file is QwenPaw's own job store.

Create the file when the first sub-task is dispatched, and update it after
every status check. Schema (one entry per sub-task):

```json
{
  "task": "Short title of the whole job",
  "created_at": "2026-11-15T00:00:00+05:30",
  "status": "running",
  "sub_tasks": [
    {
      "id": "research-pricing",
      "to_agent": "QwenPaw_QA_Agent_0.2",
      "task_id": "<returned by submit_to_agent>",
      "session_id": "<returned session, if any>",
      "brief": "Exact brief sent to the agent",
      "status": "submitted",
      "result": "",
      "checked_at": ""
    }
  ]
}
```

Sub-task `status` values: `submitted` → `running` → `done` | `failed` |
`timed_out`. Set the top-level `status` to `done` only when every sub-task
is `done`, `failed`, or `timed_out` — and say so in the summary.

---

## Minimal Workflow

### 1) Split the task

Write the split down first (in your reply or in `delegations.json`):
each sub-task needs an `id`, a one-sentence brief, and a target agent.
A sub-task brief must be self-contained: include the goal, the exact
inputs (file paths, facts, constraints), and what a finished result
looks like. Never write "see above" — the other agent has no context.

### 2) List agents, then dispatch in parallel (background)

```text
list_agents()

submit_to_agent(
  to_agent="<target_agent_id>",
  text="[Agent <your_agent_id> requesting] <self-contained brief for this sub-task only>",
  task_timeout=3600,
)
```

Record the returned `task_id` (and `session_id`, if any) in
`delegations.json` immediately, one entry per sub-task, then dispatch
the next sub-task. Do not wait for one dispatch to finish before
starting the next — that is the whole point of parallel delegation.

Quick questions only (seconds, not minutes):

```text
chat_with_agent(
  to_agent="<target_agent_id>",
  text="[Agent <your_agent_id> requesting] <short question>",
)
```

CLI equivalents (same API, same result):

```bash
qwenpaw agents list
qwenpaw agents chat --background \
  --from-agent <your_agent> --to-agent <target_agent> \
  --text "[Agent <your_agent> requesting] <brief>"
# returns [TASK_ID: ...] [SESSION: ...] — record both
```

### 3) Wait, then check each task once

Do other work first. Check on a backoff schedule — never in a tight loop:

| Sub-task type | First check after | Then every |
|---------------|-------------------|------------|
| Quick lookup | 10–20 seconds | 10 seconds |
| Analysis / report | 30–60 seconds | 20–30 seconds |
| Batch / large job | 1–3 minutes | 30–60 seconds |

```text
check_agent_task(task_id="<task_id>")
```

```bash
qwenpaw agents chat --background --task-id <task_id>
```

Outer status flow: `submitted` → `pending` → `running` → `finished`;
when `finished`, the inner result is `completed` or `failed`. On each
check, update that sub-task's `status`, `result`, and `checked_at` in
`delegations.json`. A task that hits its `task_timeout` finishes as
`failed` with `Task timed out after Ns` — record it as `timed_out`,
do not silently retry it (see Failures).

### 4) Merge and report ONE summary

When every sub-task is terminal (`done`, `failed`, or `timed_out`):

1. Read each result from `delegations.json`.
2. Resolve contradictions explicitly (say which source you trust and why).
3. Reply to the user ONCE with: what was asked, one section per
   sub-task (agent, result, or failure), and the combined conclusion.
4. Set the top-level `status` in `delegations.json` to `done`.

---

## Loop Guards (read before dispatching)

- **Never delegate back to the agent that delegated to you.** If you
  received this work via `chat_with_agent` / `submit_to_agent`, the
  sender's ID is in the `[Agent <id> requesting]` prefix — that agent
  is off-limits as a target.
- **Max 2 levels deep.** If a sub-task would itself need delegation,
  do it inline instead and note that in the result.
- **One agent, one turn each.** If you just received a message from
  Agent B, do not call Agent B again in the same turn — you will loop.
- **Never dispatch the same sub-task twice.** If a dispatch returns no
  `task_id`, check `delegations.json` first: it may already be recorded.
- **No self-delegation.** `to_agent` must never be your own agent ID.

## Failures

- **A sub-task fails**: record the error, try once with a narrower brief
  (smaller input, clearer success criteria). If it fails again, report
  it as failed in the summary — do not keep retrying.
- **A sub-task times out**: mark `timed_out`, note what was still
  missing, and report partial results as partial.
- **An agent does not exist** (`Agent not found`): re-run `list_agents()`
  and pick a real ID; never guess a corrected spelling.
- **All sub-tasks fail**: say so plainly, with each error. Do not
  fabricate results to fill the gap.

## Group Discussion vs Delegation

Delegation is for **parallel independent work**. For a **shared
discussion** where several agents must see the same thread and take
turns (for example default agent + QA agent reviewing one topic
together), use the group-chat thread instead — see
`features/groupchat/README.md` in the deploy repo: post to the
`qwenpaw-groupchat` Worker thread and let the relay deliver turns.
Do not use delegation to fake a group chat, and do not use the group
thread for independent parallel work.

## Help

```bash
qwenpaw agents -h
qwenpaw agents chat -h
```
