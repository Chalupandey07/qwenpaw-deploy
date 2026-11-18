# Loop-gate fix: make the tool-call budget actually enforce

## The bug (round 1: counting)

A custom loop mode "Guarded" used the built-in `ToolCallBudgetGate`
(`max_calls` 30, per-tool `execute_shell_command` 20). Two live tests
(echo 1–200, one echo per shell call) both executed **100 shell calls**
and stopped with "Tool call budget reached (100 calls)" / "(150 calls)"
— not 30 total, not 20 shell. The stored config was correct; the
running loop did not enforce it. The original incident was a 167-call
loop that ran ~6 minutes with no reply.

## Root cause, round 1 (read from the source, confirmed by the live log)

Two defects, both in the gate's counting:

1. **Double-counting via the merged message.** The parent AgentScope
   accumulates all of a turn's tool-call blocks into the assistant
   message(s) carrying the current `reply_id`
   (`state.append_context` merges blocks into the message with the
   current `reply_id`). The old gate read only the *latest* message
   with tool calls (`_latest_tool_names`) and **added** its names to
   the running total once per round. Because that message already held
   every call issued so far, the total inflated superlinearly:
   round 0 counted 50 (total 50), round 1 counted the accumulated 100
   (total 150), round 2 would count 150 (total 300). Live test 1
   fired at "(150 calls)" with 100 executed — exactly this.
2. **Stale `last_iteration` can skip a count.** The gate only counted
   when `iteration != state.last_iteration`. If the state was stale,
   a whole round was never counted. Live test 2 fired at
   "(100 calls)" instead of "(50 calls)", consistent with round 0
   not being counted.

A third, structural fact limits what any gate-only fix can do: the
model emits a large batch of parallel tool calls in one response
(~50–100), the gate only checks *after* the model response, and a
TERMINATE on a tool-call iteration is **deferred** (the triggering
batch still executes; the stop only prevents the next model call).
So a gate cannot enforce a bound below one batch.

## The bug (round 2: the workflow bypass)

The round-1 fix (image `qwenpaw-agentx:2.3.0-gatefix1`) was deployed
and live-tested in a fresh ordinary chat (echo 1–200). **The agent
reached 200 with NO budget stop.** It did not emit 200 direct tool
calls — it used the "Run workflow" batch runner (`run_tool_batch`):
4 batches of 50 (echo_batch*.json), turn header "Completed 15 steps"
(8 Thinking + 5 "Run workflow"). The gate counts only top-level tool
calls, so it saw 5 calls and never fired. The batch runner executes
its sub-calls internally (via `toolkit.call_tool`); those sub-calls
never appear as top-level tool-call blocks, so the gate was blind
to the workflow path.

## Root cause, round 2 (read from the source)

`run_tool_batch` (`qwenpaw/agents/tools/run_tool_batch.py`) reads a
JSON batch file (or inline `actions`, max 50 steps per invocation)
and executes each step through the toolkit. The parent appends both
the tool-call blocks and the tool-result blocks to the assistant
message(s) carrying the current `reply_id` (`AgentState.append_context`
merges every block into the message with the current `reply_id`, and
`_save_to_context` uses it for results too). So the sub-calls are
recoverable from the context — but only if the gate looks for them:
from the batch call's arguments (before it executes) and from the
batch result JSON (after it executes). The gatefix1 gate looked at
neither.

## The fix (round 2, image `qwenpaw-agentx:2.3.0-gatefix2`)

`qwenpaw-loop-gate-fix.patch` (against pinned upstream
`agentscope/qwenpaw:v2.3.0`, digest `sha256:46a782f4…`) changes three
files (the `mode.py` / `config.py` wiring is unchanged from round 1;
only `limits.py` changed):

- `src/qwenpaw/loop/gates/limits.py` — `ToolCallBudgetGate.check`
  now **recomputes** the turn total from the context on every check,
  scoped to the current reply (`agent.state.reply_id`): it counts
  every `tool_call`/`tool_use` block in every message whose `id`
  matches the current `reply_id`, and sets `state.total` /
  `state.by_tool` from that recomputation (no `+=`, no
  `last_iteration` dependence). This counts every call exactly once
  whether the parent merges a turn's blocks into one message or keeps
  one message per round, and it excludes previous turns. When
  `reply_id` is unavailable it falls back to the previous
  incremental counting, so the gate never fails open.
  **Plus the round-2 batch expansion:** a `run_tool_batch` call is
  expanded into the sub-calls it will execute, read from its
  arguments — inline `actions` (a list, or a JSON string) or the JSON
  batch `file_path` (absolute; a list of steps or an object with an
  `actions` key; `.json` only, 1 MB size guard). Control-flow steps
  (`set_var`, `goto`, recursive `run_tool_batch`) are not real tool
  calls and are excluded. A completed batch whose call could not be
  expanded (unreadable file, invalid JSON) is counted from its result
  JSON instead (`results` list, or `total` in `last_only` mode, where
  per-tool attribution is unavailable). A batch is never counted
  twice: a result whose call id was already expanded is skipped
  (the result block's `id` matches its call block's `id`).
- `src/qwenpaw/config/config.py` — new `ToolCallBudgetConfig`
  (`enabled` True, `max_calls` 30, `per_tool`
  `{"execute_shell_command": 20}`) and a `tool_call_budget` field on
  `LoopConfig`. Existing workspaces pick up the defaults (the field
  is absent from the stored `agent.json`; pydantic fills it in), so
  the cap is on by default.
- `src/qwenpaw/modes/default/mode.py` — `_build_gates()` now appends
  a `ToolCallBudgetGate` (from the new config) after the doom-loop
  gate, so the cap applies to **every chat**, not just `/guarded`.
  The Guarded custom mode is untouched. The config key
  (`_make_config_key`) already hashes the whole `loop` config, so
  changing the budget hot-reloads the gate chain.

## What bound this actually enforces — read this before claiming 30

**About one batch, typically ~50 executed calls — NOT a strict 30.**
The gate now fires reliably in round 0 (the first batch of ~50
already exceeds `max_calls` 30), the deferred stop lets that batch
execute, and the turn ends before a second batch. So a runaway that
used to run 167 calls (direct) or 200 calls (via the batch runner)
now stops after one batch (~50). The exact number is the model's
first-batch size (typically ~50, up to ~100 if the model emits a
larger single batch); the gate cannot go below one batch.

For the workflow path specifically: the gate expands the batch call
from its arguments at round 0, so it fires before the second batch
is even issued — the run stops after the first batch (~50 executed,
51 counted: 1 batch call + 50 sub-calls). If the batch arguments
cannot be read (unreadable file), the gate falls back to counting
the completed batch from its result JSON, so it fires at round 1
and the run stops after the second batch (~100 executed). The
`last_only` result form counts via `total` (no per-tool attribution
there, but the total cap still fires).

## The bug (round 3: the single-response burst)

The round-2 fix (image `qwenpaw-agentx:2.3.0-gatefix2`) was deployed
and live-tested in a fresh ordinary chat (echo 1–200). **The agent
reached 200 again.** This time it did NOT use the batch runner — it
issued all 200 as DIRECT parallel calls in a SINGLE model response
("I'll issue all 200 echo calls — each as its own
execute_shell_command tool call, in parallel since they're
independent"). Turn header "Completed 201 steps" (Run echo 1 through
Run echo 200). Stop message "Tool call budget reached (200 calls)" —
the counted total, so the gate DID fire (200 exceeds the max_calls 30
limit) but too late.

## Root cause, round 3 (read from the source)

Structural, not a bypass. The gate checks AFTER a model response, and
a TERMINATE on a tool-call iteration is DEFERRED
(`loop/gates/runner.py` `apply_stop_result` sets
`agent._gate_pending_stop`; the batch still executes; the deferred
stop applies at the next reasoning step via `check_pending_gates`).
When the model emits all 200 calls in one response, the gate counts
200 and fires, but the deferred TERMINATE cannot prevent those 200
calls from executing — they are already in the response and all
execute. The gate only stops MULTI-RESPONSE runaways (calls spread
across several responses, so it can fire between responses and prevent
the next batch). It cannot stop a SINGLE-RESPONSE burst. Gatefix2's
batch-expansion is correct for the batch-runner path but was not
exercised here (no batch runner used).

## The fix (round 3, image `qwenpaw-agentx:2.3.0-gatefix3`)

Enforce the budget BEFORE each tool call executes, at the single
funnel both the sequential and concurrent paths reach. Two files
change (the `mode.py` / `config.py` wiring is unchanged from round 1;
`limits.py` gains the enforcer):

- `src/qwenpaw/loop/gates/limits.py` — a per-turn execution counter
  (`_ToolCallBudgetExec`: `reply_id`, `total`, `by_tool`, `max_calls`,
  `per_tool`), stored ON the agent as `_tool_call_budget_exec`, keyed
  by `reply_id` (the same turn-scoping the gate uses — one reply_id
  per user turn, shared by all rounds of that turn). The gate's
  `check()` installs/refreshes it (`install_execution_budget`) before
  any return, so it is in place before any call of the round executes
  — including when the gate fires (the live failure is exactly the
  case where it fires). Counters reset only when `reply_id` changes,
  so they accumulate across rounds of one turn.
  `try_reserve_execution(agent, tool_call)` reserves a slot
  synchronously and returns None when the call may execute, or a
  refusal reason when the total cap or a per-tool cap would be
  exceeded. A `run_tool_batch` call is expanded into the sub-calls it
  will execute (the same expansion the gate uses) and reserves all of
  them; when the batch would exceed the budget the WHOLE batch is
  refused (none of its sub-calls execute). When a batch cannot be
  expanded (unreadable file) only the batch call itself is reserved,
  and the gate's result-JSON fallback bounds that case to one batch.
  Fail-open: when no enforcement state is installed (gate inactive,
  `reply_id` missing) the call is allowed, so a missing enforcer can
  never break normal execution.
- `src/qwenpaw/agents/react_agent.py` — `ReactAgent._execute_tool_call`
  (the single funnel; its docstring confirms both paths reach it)
  now reserves a budget slot after `_coerce_tool_call_input` and
  before the first await, then delegates to `super()` as before. When
  the reserve refuses, it yields `self._handle_error_tool_call(...)`
  with `state=ToolResultState.DENIED` (the same helper the base uses
  for denied calls) and returns WITHOUT calling `super()`, so the
  refused call produces exactly one DENIED tool result the model can
  read and never executes. `ToolResultState` is added to the existing
  `agentscope.message` import.

Why the reserve is in-order for concurrent batches: the parent
AgentScope runs `asyncio.gather(*[self._into_queue(tc, ...) ...])`
and `_into_queue` does `async for evt in self._execute_tool_call(...)`.
Tasks run in creation order on the single-threaded event loop, each
running synchronously until its first await. The reserve is plain
synchronous counter mutation before the first await (the `async for`
on `super()`), and `_coerce_tool_call_input` is a plain sync `def`,
so all 200 reservations happen in call order before any tool
executes. A DeepSeek design review (2026-11-18) confirmed this
reasoning and the DENIED-result mechanism, and flagged three points
that are handled: (1) `reply_id` is turn-scoped, not per-round — the
gate's own tests D/F and the live counts prove it (one reply_id per
user turn, shared by all rounds); the pending stop is applied at the
start of the next `_reasoning`, which returns the stop text without
a new model call, so no fresh allowance is granted. (2) A call that
stays PENDING (ASK de-dup) and is re-emitted later is a NEW block
with a new id, so it reserves a new slot — correct, because a retry
is a real execution. (3) The 180 DENIED results are saved to context
(~5k tokens); the turn ends at the pending stop, so they are never
fed to a new model call in that turn, and normal context compression
cleans them up later.

## What bound this actually enforces — read this before claiming 30

**About 20 executed calls for a shell-only burst (the per-tool cap),
about 30 for a mixed-tool burst (the total cap) — NOT 50, and NOT a
strict 30 for every shape.** The enforcer reserves before execution,
so a 200-echo run executes 20 shell calls (per-tool
`execute_shell_command` 20 binds first) and refuses 180; a mixed
burst executes 30 (total `max_calls` 30) and refuses the rest. A
batch of 50 sub-calls is refused whole at reserve time (51 > 30), so
0 of its sub-calls execute. The gate still fires at check time
("Tool call budget reached (200 calls)") and its deferred stop ends
the turn after the batch, so the agent sees the refusals plus the
stop message.

The remaining gap: a batch whose steps cannot be read from its
arguments (unreadable file) is reserved as 1 call only; its sub-calls
bypass `_execute_tool_call` (the batch runner calls
`toolkit.call_tool` directly), so up to 50 sub-calls can execute
before the gate's result-JSON fallback fires at the next check and
bounds it to one batch (~50). That is the pre-existing gatefix2
behaviour for that edge case, not a regression. A strict 30 in every
shape would additionally require a guard inside the batch runner
itself; that is out of scope for this fix. Do not claim 30 unless a
live test shows 30.

Round 4 (below) narrows this gap for the TASK total: the gate now
charges those sub-calls to the task from the completed-batch result
JSON at the next check (once per result id), so they count against
the 60-call task budget even though the per-turn enforcer never saw
them. Residual: if the model ends the turn immediately after such a
batch with no further model response, no check runs to charge them,
and the task total undercounts by up to one batch (~50). The per-turn
bound above is unchanged.

## The bug (round 4: the cross-turn creep)

The round-3 fix (image `qwenpaw-agentx:2.3.0-gatefix3`) was deployed
and live-tested in a fresh ordinary chat (echo 1–200, browser task
146acf9e, 2026-11-18). **The per-turn cap worked (20 executed, 180
refused, stopped at 50) BUT the agent resumed the same task on the
follow-up "hello" and did 21–40 (cumulative 40 across the chat).**
The per-turn counter is keyed by `reply_id`, which changes every
turn, so each turn grants a fresh 20/30. A task that needs 200 calls
creeps there in 10 turns. The gate had no memory of the task across
turns, no record of why it stopped, and nothing marking the task
finished.

## The fix (round 4, image `qwenpaw-agentx:2.3.0-gatefix4`)

A per-task cap, a structured stop audit, and a finalize flag — all in
`limits.py` (the `mode.py` / `config.py` wiring gains two fields;
`react_agent.py` is unchanged, it already calls the enforcer).

**Per-task cap: 60 total / 40 shell — 2x the per-turn cap.** The
multiple is the design: one full turn plus one genuine resume turn.
A task that needs a second turn to finish gets it; a runaway cannot
creep past two turns' worth. Echo 1–200 needs 10 turns at 20/turn
and stops at 40 shell / 60 total. 1x would forbid any legitimate
cross-turn continuation; 3x (90/60) would let the runaway reach 60.
The cap is cumulative EXECUTED calls across every turn of the task
(reserved slots, the same ground truth the per-turn enforcer uses),
not emitted calls. `ToolCallBudgetGate` takes
`task_max_calls` / `task_per_tool` (default: 2x the per-turn values);
`ToolCallBudgetConfig` gains the same two fields (default `None` /
empty, meaning 2x). Limits are frozen when the task starts, so a
config reload cannot move the goalposts mid-task.

**Task identity.** An explicit task id wins when present
(`ctx["task_id"]` or `agent.state.task_id` — the client-side "new
task" action, when one exists). Otherwise the task is derived from
the latest user message in `agent.state.context`: a
continuation-only message (empty, greeting, "continue" / "go on" /
"yes" / "ok" / "thanks") resumes the current task; a different
substantive message starts a new task (the old one is abandoned);
any substantive message after finalisation starts a new task. The
continuation rule is a small English-only heuristic (this deploy is
English-only) and is the fallback, not the primary signal. Two
known warts, documented not hidden: a non-English continuation
("weiter") reads as a new instruction and mints a fresh budget, and
"ok now do X" reads as a continuation and is charged to the old
task. A session-wide backstop counter was considered (DeepSeek
review) and rejected: a whole chat legitimately exceeds any such
number over a day, so it would cap normal use, not just runaways.

**Repeat guard.** A task finalised BY CAP leaves its instruction
fingerprint (normalised: lowercase, de-punctuated,
whitespace-collapsed, SHA-256) in the session's prior-task record.
Re-issuing the same instruction starts a task that INHERITS the
spent totals — and finalisation when they already reach the cap — so
replaying the same prompt N times cannot mint N fresh budgets. A
task that ended normally (abandoned, never capped) does not poison
repeats.

**Finalize semantics (read carefully).** Only the TASK cap
finalises a task. A per-turn gate TERMINATE does NOT finalise it:
the task may legitimately continue next turn within its task budget,
and finalising on a per-turn stop would collapse 2x to 1x. The
sequence for the live case is: turn 1 hits the per-turn cap (20
executed, task NOT finalised); turn 2 "hello" gets 20 more (task
shell 40 = cap) and the task finalises the moment the 40th call is
reserved; turn 3 "hello" is refused entirely (0 executed) with a
stop message naming the task total. Check order, everywhere, is:
finalised → task per-tool cap → task total cap → per-turn. Either
task cap finalises the WHOLE task (a per-tool cap does not merely
block that tool). The enforcer finalises when a reserve reaches the
cap; the gate finalises when a check observes the cap. Task state
lives ON the agent object, next to the per-turn exec counter — the
same lifetime the per-turn counter already relies on (it is keyed by
`reply_id`, which would be redundant if a fresh agent object were
built per turn). `reset_turn()` deliberately does not touch it. The
live check the parent should run after deploy: log `id(agent)`
across two turns and confirm it is the same object; if the agent
object were ever recreated per turn, the task budget would reset
with it.

**Structured stop audit.** An append-only list on the agent
(`_tool_call_stop_audit`), one record per stop, deduped per
(task, turn, kind) — a repeat stop of the same kind in the same
turn does not append a second record, it adds to `refused` and
refreshes the totals. Record fields:

```
seq, ts (ISO UTC), kind, reason, task_id, instruction (first 120
chars), turn_id (reply_id), turn_total, turn_executed, task_total,
task_by_tool, refused, finalized, finalized_by_this_stop
```

`turn_total` is the gate's emitted turn total for gate records and
the executed-so-far turn total for enforcer records; `task_total`
is always cumulative EXECUTED calls for the task. Kinds:
`per-turn gate` (gate check, per-turn total/per-tool),
`per-task cap` (gate or enforcer, task total/per-tool),
`fuse` (enforcer refusal on per-turn grounds),
`task_finalized` (a resumed turn on a finalised task). The gate
refuses no calls itself, so gate records carry `refused: 0`;
enforcer records count the calls they refused (fuse 180 in the live
shape). Accessors: `get_stop_audit(agent)` and
`get_task_state(agent)` return copies. The audit is in-memory for
the chat session (agent object lifetime); there is no disk
persistence in this change, so it is lost on a process restart.
Fail-open throughout: any error in task resolution or audit
recording falls through to the existing per-turn behaviour, and the
per-turn gate reasons stay byte-identical.

## The bug (round 5: the per-turn agent rebuild)

The round-4 fix (image `qwenpaw-agentx:2.3.0-gatefix4`) was deployed and
live-tested in a fresh ordinary chat (echo 1–200, browser task b6180034,
2026-11-18, chat 40b3a04a, Default, nex-n2.6, Smart Mode). **The per-turn
cap held (20 executed per turn) BUT the per-task cap did NOT hold across
turns.** Turn 1 executed 20 (1–20), refused 30 (denial cited "Task total
20/60"); turn 2 "hello" executed 20 more (21–40), refused 0, did NOT
finalise; turn 3 "hello" executed 20 more (41–60), refused 0 — the
40-shell per-task cap EXCEEDED; turn 4 "hello" executed 20 more (61–80).
No "hello" in the test chat ever got a plain prose reply.

## Root cause, round 5 (read from the source)

The task budget was stored as a plain Python attribute on the agent
object (`_tool_call_task_budget`), and the agent object does not survive
a turn. `runtime/runtime.py` builds a **fresh `QwenPawAgent` for every
user turn** (`ctx.agent = await builder.build(ctx)` per request, not per
session); the builder restores the session via
`agent.load_state_dict(ctx.session_state)`. `load_state_dict`
(`agents/react_agent.py`) restores ONLY `self.state` (the AgentState
pydantic model) + scroll-manager bookkeeping — it does NOT restore plain
Python attributes on the agent object. So every turn started with a
fresh task (total=0). The per-turn counter still worked (it resets per
`reply_id` anyway), but the per-task cap never accumulated. The round-4
README's own warning was prescient: "log `id(agent)` across two turns
and confirm it is the same object; if the agent object were ever
recreated per turn, the task budget would reset with it" — and it is
recreated per turn.

## The fix (round 5, image `qwenpaw-agentx:2.3.0-gatefix5`)

Persist the task budget through the session-state round-trip, following
the existing "scroll" pattern in `ReactAgent.state_dict()` /
`load_state_dict()`. Two files change (the `mode.py` / `config.py`
wiring is unchanged from round 1):

- `src/qwenpaw/loop/gates/limits.py` — two new functions.
  `task_budget_state_dict(agent)` returns a JSON-safe dict of the
  current task + prior-task record, or None (no task and no priors).
  `load_task_budget_state_dict(agent, data)` restores them and returns
  True, or False when there is nothing to restore (None / missing /
  wrong version / bad payload). The dict is `{"version": 1, "task":
  {task_id, instruction, fingerprint, total, by_tool, max_calls,
  per_tool, finalized, finalized_reason, reply_ids[],
  charged_batch_results[]} | None, "prior": {fingerprint: {total,
  by_tool, capped}}}`. The snapshot is a COPY (by_tool / reply_ids /
  charged_batch_results are copied), so a later mutation during
  serialization cannot tear it. The prior map is capped at 32 entries
  (bounded growth in long sessions). The loader validates BEFORE
  mutating anything on the agent and fails open (returns False, agent
  untouched) on any bad data — an old session file simply has no key
  and the task starts fresh. Limits are persisted frozen (round 4
  froze them at task creation); restoring them preserves the freeze,
  so a config reload cannot move the goalposts mid-task.
- `src/qwenpaw/agents/react_agent.py` — `state_dict()` writes the key
  unconditionally (`out["tool_call_task_budget"] =
  task_budget_state_dict(self)`, None = no budget) so a stale key can
  never be resurrected by a merge; wrapped in try/except so a snapshot
  failure never breaks the session save. `load_state_dict()` restores
  it in the 2.0 path, after the scroll restore, also try/except
  fail-open. Both imports are lazy (the same pattern as the enforcer's
  `try_reserve_execution` import in `_execute_tool_call`), so there is
  no import cycle. The hook is inside `state_dict()` itself, so it runs
  on every save path: normal end-of-turn, cancellation
  (`_try_save_on_cancel`), and the session hook.
- The cap numbers, check order, and enforcer are unchanged. The task
  budget is ~500 bytes; the session file is ~9 MB, so the size cost is
  nil.

A DeepSeek design review (2026-11-18, deepseek-v4.1-flash-free, 1,122
prompt + 5,644 completion tokens) confirmed the state_dict hook as the
right persistence point and flagged five points, all addressed: the
cancel-path save (the hook is inside state_dict, which all save paths
call); the stale-key resurrection (the key is written unconditionally);
snapshot copying; the prior-map cap (32); and the frozen-limits
semantics (persisted, consistent with round 4). Two of its findings
were checked out as non-issues against the real code: the restored task
is NOT reset by `_start_task` (the loader sets the attribute directly;
`_ensure_task` resumes it for a continuation and only starts a new
task for a new substantive instruction), and `charged_batch_results`
IS consulted before charging (`_uncharged_batch_result_names` skips
ids already charged). The audit is deliberately NOT persisted: it is a
diagnostics signal, not control flow; the cap lives in the task budget
(total / max_calls / finalized), which is persisted.

## Test

`test_gate.py` is a machine-free unit test for the counting fix and
the execution-time enforcer. It builds a minimal fake `qwenpaw`
package (pristine `base.py` / `loop_gate.py`, a stub `agent_context`,
and the `limits.py` under test) and drives the gate with fake agents
whose context mimics the parent's merged-message behaviour. The
execution tests simulate `ReactAgent._execute_tool_call` with a fake
executor that reserves via `try_reserve_execution` and executes only
when allowed; on a `limits.py` without the enforcer (gatefix2) it
executes everything, reproducing the live single-response failure.

```bash
# Fail-first: the pristine gate must FAIL (it reproduces the live bug)
python3 test_gate.py --limits src/pristine/limits.py   # 18/47
# The gatefix1 gate must FAIL only the workflow-bypass + execution tests
python3 test_gate.py --limits src/gatefix1/limits.py   # 22/47, H + I fail
# The gatefix2 gate must FAIL only the execution-time tests
python3 test_gate.py --limits src/gatefix2/limits.py   # 36/47, I fails
# The patched gate must PASS
python3 test_gate.py --limits src/patched/limits.py    # 47/47
python3 test_gate.py                                   # defaults to patched
```

Discriminating tests: **A** (merged message, total 50→100→150, not
50→150→300) and **E** (stale `last_iteration` still counts).
**H** (workflow bypass): a `run_tool_batch` call with 50 shell steps
counts 51 and fires (H1 file, H2 inline); 4 batches count 204 (H3,
the live test); a completed batch is counted from its result JSON
when its call could not be expanded (H4, H8 `last_only`); a batch
is never counted twice (H5: call + result = 51, not 101); the
per-tool cap fires through a batch (H6); a small batch (3 steps)
does NOT fire (H7, no false positive).
**I** (execution-time enforcement, the round-3 live failure): a single
response with 200 direct shell calls executes 20 and refuses 180
(I1, per-tool cap); 25 shell + 175 web_search executes 30 and refuses
170 (I2, total cap after the shell cap); a 5-call run executes all 5
(I3, no false positive); the counter persists across rounds of one
turn (I4: 25 + 5 = 30) and resets on a new turn (I5: 20 again); a
batch of 50 steps is refused whole (I6 big) while a batch of 3 is
allowed (I6 small); the gate's reason names the true total 200 and
the refusal reason names the budget (I7). Regression tests B–D, F, G
cover firing, the per-tool cap, the separate-message-per-round
layout, previous-turn exclusion, and the `reply_id`-missing
fallback.

`src/pristine/` holds the exact upstream files (sha256-verified
against the pinned image), `src/gatefix1/` holds the round-1 gate
(which passes A–G but fails H and I), `src/gatefix2/` holds the
round-2 gate (which passes A–H but fails I — the live
single-response burst), `src/gatefix3/` holds the round-3 gate
(which passes T115 47/47 but has no per-task cap), and
`src/patched/limits.py` is the fixed gate the test runs against. The
patch file is the authoritative diff; it was verified to apply
cleanly to the pristine files and reproduce the patched files
byte-for-byte (limits.py verified locally; react_agent.py verified
on the machine against the container's pristine copy, which is
identical in `/app/src` and site-packages because gatefix2 did not
touch it).

`test_task_cap.py` is the machine-free unit test for round 4
(T126, 87 checks) and round 5 (T140, 26 checks — section P), same
harness style, same fake package. The same fake agent object is reused
across turns (its context grows, its `reply_id` changes) because that
is the lifetime the task budget relies on — EXCEPT section P, which
rebuilds a fresh agent object per turn to reproduce the real runtime
(see round 5). Discriminating tests: **J** (the live cross-turn shape:
turn 1 spends 20 shell, turn 2 "hello" gets 20 more — task shell 40
= cap — and finalises, turn 3 "hello" executes 0, a new instruction
gets a fresh budget); **K** (sub-cap creep: 25 web_search per turn
never trips the per-turn cap, the 60 task cap stops turn 3 after
10); **L** (the stop audit: 6 records, all four kinds, the fuse
record refused 180, the finalised-resume record refused 200 with
task_total 40, append-only); **M** (an explicit task id gets a fresh
budget; re-issuing the capped instruction inherits the spent budget
and executes 0); **N** (an unreadable batch's 50 sub-calls are
charged to the task from the result JSON — task total 51 — and the
resume is refused because 50 shell already exceeds the 40 shell
cap); **O** (a batch that would jump the task cap from 55 to 66 is
refused whole); **P** (T140, gatefix5 — the per-turn agent rebuild:
turn 1 spends 20 shell, turn 2 "hello" on a FRESH agent object gets
20 more to task shell 40 = cap and finalises, turns 3 and 4 on fresh
agent objects execute 0; P2 snapshot round-trip; P3 loader fails open
on bad data). Regression: **N1** (a 5-call run executes fully, is
not finalised, writes no stops).

```bash
# Fail-first: the gatefix3 gate must FAIL (it reproduces the live bug:
# turn 2 resumes with a fresh budget, turn 3 executes 20 more)
python3 test_task_cap.py --limits src/gatefix3/limits.py  # 35/87
# The gatefix4 gate must FAIL only the P section (no persistence)
python3 test_task_cap.py --limits src/gatefix4/limits.py  # 73/87
# The patched gate must PASS
python3 test_task_cap.py --limits src/patched/limits.py   # 87/87
python3 test_task_cap.py                                  # defaults to patched
# T140 alone (section P)
python3 test_task_cap.py --section P                       # 26/26
python3 test_task_cap.py --limits src/gatefix4/limits.py --section P  # 12/26
```

A DeepSeek design review (2026-11-18, deepseek-v4.1-flash-free,
6,670 completion tokens, prompt 1,583; brief in
`task-cap-design.md`) confirmed the shape and caught four things,
all adopted except where noted: freeze task limits at creation
(adopted); check order finalised → task shell → task total →
per-turn, with either task cap finalising the whole task (adopted);
the instruction-repeat guard (adopted); audit magnitude fields
(`seq`, `refused`, `finalized_by_this_stop`) with dedupe per
(task, turn, kind) (adopted); charging unreadable-batch sub-calls to
the task from the result JSON (adopted). Rejected with reasons in
the fix section above: a session-wide backstop counter (would cap
legitimate long chats) and mirroring task state onto `agent.state`
(two truths; the agent object is the single source, as for the
per-turn counter). The reserve stays one synchronous function with
no await between check and increment, so concurrent workers cannot
overshoot (confirmed, no code change needed).

The default-chain wiring (`mode.py` + `config.py`) and the
`react_agent.py` funnel change are not covered by the machine-free
unit test (they need the full QwenPaw import chain). They are
verified after the derived image is built, inside the image:
import the default mode, build the gates from a config, and assert a
`ToolCallBudgetGate` is present, and call `try_reserve_execution`
against a fake agent to confirm the enforcer refuses past the budget
— see "Verify the image" below.

## Build the derived image (on the InstaBox machine)

No registry credentials exist, so build locally on the machine
(`m_agq5wqqo2fvypym7rjlpvngc2m`) with its Docker daemon. Sync this
directory to the machine first (via the GitHub API contents endpoint
+ `ib.py exec`; `raw.githubusercontent.com` can be stale right after
a push, so verify the files on the machine match the commit), check
disk space first (the base image is 4.3 GB; the build needs room for
one more image layer), then:

```bash
cd /data/home/qwenpaw/loop-gate-fix   # or wherever the files were synced
docker build -t qwenpaw-agentx:2.3.0-gatefix5 -f Dockerfile.gatefix5 .
docker images qwenpaw-agentx:2.3.0-gatefix5   # record the digest
```

Gatefix5 builds FROM the live image (`qwenpaw-agentx:2.3.0-deploy1`,
which already layers gatefix4 + bloat-winwin + cost-ledger + Telegram)
and applies only the gatefix5 delta (`qwenpaw-loop-gate-fix5.patch`,
via `Dockerfile.gatefix5`) — the full patch (`qwenpaw-loop-gate-fix.patch`,
`Dockerfile`) builds from pinned upstream and would LOSE the
bloat-winwin / cost-ledger / Telegram layers, so do NOT use it for a
gatefix5 deploy. The Dockerfile fails the build if the patch does not
apply cleanly.

**Gotcha (caught by the image verification, 2026-11-18): the package
is installed in site-packages, not run from `/app/src`.** Python
imports `qwenpaw` from
`/app/venv/lib/python3.11/site-packages/qwenpaw/` — `/app/src/qwenpaw/`
is only the source tree the install was built from. Patching
`/app/src` alone leaves the running code unpatched (the first
`gatefix1` build did exactly this: the patch applied, the image
built, but `LoopConfig` had no `tool_call_budget` at runtime). So the
Dockerfile applies the same patch to **both** copies (`-p1` from
`/app` for `src/qwenpaw/...`, `-p2` from site-packages for
`qwenpaw/...`). Both copies are byte-identical upstream, so the patch
applies cleanly to both. If you ever change the patch, verify the
import path again — `docker run --rm <image> python3 -c "import
qwenpaw.config.config as c; print(c.__file__)"` tells you which copy
actually runs.

## Verify the image (before switching the live container)

```bash
# The patched modules import and the gate is in the default chain
docker run --rm qwenpaw-agentx:2.3.0-gatefix5 python3 -c "
from qwenpaw.loop.gates.limits import ToolCallBudgetGate
from qwenpaw.modes.default.mode import DefaultMode
print('gate imports OK')
"
# The enforcer refuses past the budget (machine-side, no browser):
# install it for a fake turn, reserve 200 shell calls, expect 20
# allowed and 180 refused, and a fresh turn to allow 20 again.
docker run --rm qwenpaw-agentx:2.3.0-gatefix5 python3 -c "
from qwenpaw.loop.gates.limits import (
    install_execution_budget, try_reserve_execution)
class S:
    reply_id = 'r1'
class A:
    state = S()
a = A()
install_execution_budget(a, 'r1', 30, {'execute_shell_command': 20})
ok = sum(1 for _ in range(200)
         if try_reserve_execution(
             a, {'type': 'tool_call', 'name': 'execute_shell_command',
                 'input': {}}) is None)
print('executed:', ok, '(expect 20)')
"
# The task cap spans turns (machine-side, no browser): same fake
# agent, two turns with a "hello" between them. Turn 1 executes 20,
# turn 2 executes 20 more (task shell 40 = cap, task finalised), and
# get_stop_audit shows the per-task cap record with task_total 40.
docker run --rm qwenpaw-agentx:2.3.0-gatefix5 python3 -c "
from qwenpaw.loop.gates.limits import (
    install_execution_budget, try_reserve_execution,
    get_task_state, get_stop_audit)
class S:
    reply_id = 'r1'
    context = []
class A:
    state = S()
a = A()
def run(n):
    install_execution_budget(a, a.state.reply_id, 30,
                             {'execute_shell_command': 20})
    return sum(1 for _ in range(n)
               if try_reserve_execution(
                   a, {'type': 'tool_call',
                       'name': 'execute_shell_command',
                       'input': {}}) is None)
print('turn1 executed:', run(200), '(expect 20)')
a.state.reply_id = 'r2'
print('turn2 executed:', run(200), '(expect 20; task hits its 40 cap)')
print('task:', get_task_state(a))
print('audit kinds:', [r['kind'] for r in get_stop_audit(a)])
"
# Gatefix5: the task budget survives a FRESH agent object (the rebuild
# the runtime does every turn). Spend 20 shell on agent A, snapshot the
# task state, load it onto a fresh agent B with the same context, and
# confirm B's task already totals 20 -- so its next 20 shell calls hit
# the 40 cap and finalise, and a further fresh agent C executes 0.
docker run --rm qwenpaw-agentx:2.3.0-gatefix5 python3 -c "
from qwenpaw.loop.gates.limits import (
    install_execution_budget, try_reserve_execution,
    get_task_state, task_budget_state_dict,
    load_task_budget_state_dict)
class S:
    def __init__(self, reply_id, context):
        self.reply_id = reply_id
        self.context = context
class A:
    def __init__(self, reply_id, context):
        self.state = S(reply_id, context)
def run(a, n):
    install_execution_budget(a, a.state.reply_id, 30,
                             {'execute_shell_command': 20})
    return sum(1 for _ in range(n)
               if try_reserve_execution(
                   a, {'type': 'tool_call',
                       'name': 'execute_shell_command',
                       'input': {}}) is None)
ctx = []
a = A('r1', ctx)
print('A turn1 executed:', run(a, 200), '(expect 20)')
snap = task_budget_state_dict(a)
print('snapshot task total:', snap['task']['total'], '(expect 20)')
b = A('r2', ctx)
print('B restored:', load_task_budget_state_dict(b, snap), '(expect True)')
print('B task total:', get_task_state(b)['total'], '(expect 20)')
print('B turn2 executed:', run(b, 200), '(expect 20; task hits 40 cap)')
print('B finalised:', get_task_state(b)['finalized'], '(expect True)')
c = A('r3', ctx)
load_task_budget_state_dict(c, task_budget_state_dict(b))
print('C turn3 executed:', run(c, 200), '(expect 0)')
"
# Start it briefly on a scratch port and confirm the console serves
# (do NOT point it at the live data dir for this check). The server
# listens on 8088 inside the container (compose maps 127.0.0.1:8088).
docker run -d --name gatefix-smoke -p 18099:8088 \
  qwenpaw-agentx:2.3.0-gatefix5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18099/
docker rm -f gatefix-smoke
```

# The gate counts workflow sub-calls (machine-side live check, no browser):
# feed the patched gate a synthetic context with a batch call whose
# file holds 50 shell steps and confirm it counts 51 and fires.
# (Do this inside the built image or on the machine; see the test for
# the exact shape. The unit test T115 covers it machine-free.)

Do NOT switch the live container to an image that has not passed
these checks.

## Deploy (snapshot first)

```bash
# 1. Snapshot the machine in the InstaBox console (record the snapshot id).
#    At the 5-snapshot Free limit, delete the worst/oldest superseded
#    snapshot first per Rohan's standing delegation. Never delete
#    qwenpaw-phase0-verified.
# 2. Edit /data/home/qwenpaw/docker-compose.yml: change only the image
#    line to qwenpaw-agentx:2.3.0-gatefix5. Keep every mount, env var,
#    and port. Keep the pinned upstream image available for rollback.
# 3. Restart and confirm the console comes back:
docker compose -f /data/home/qwenpaw/docker-compose.yml up -d
curl -s -o /dev/null -w '%{http_code}\n' \
  https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/
curl -s https://qwenpawx.pages.dev/api/auth/status
```

## Rollback

If the console does not come back or the gate misbehaves:

```bash
# Revert docker-compose.yml to the pinned upstream image:
#   image: agentscope/qwenpaw:v2.3.0@sha256:46a782f4b39b673eac399c90294244e348e71a01bdf032f8e78b00776be3c87d
docker compose -f /data/home/qwenpaw/docker-compose.yml up -d
```

If the container will not start at all, restore the pre-deploy
InstaBox snapshot (id recorded at deploy time). Do not execute a
rollback unless the deploy is actually broken.

## Live verification (real browser, ordinary chat — the proof)

Sign in as satwik, open a **fresh ordinary chat** (do NOT activate
`/guarded` — the point is the default chain now enforces the cap),
send: "Please print the numbers from 1 to 200, one number per shell
echo call, each echo as its own tool call." Let it run until it stops
by itself. Report: how many tool calls executed, the exact stop
message, whether it reached 200. **Target: ~20 executed (the per-tool
shell cap), not 30 and not 200** — report the real number honestly.
If it still executes ~100 or 200, the fix did not work; say so
plainly. Also confirm normal function: one short harmless message
gets a reply, and the console loads normally.

Note the model may route through the batch runner again (that path is
bounded by the gate at ~50, and by the enforcer at reserve time — a
batch of 50 is refused whole) or through direct calls (bounded at
~20 by the enforcer). Either way the run must stop well before 200.
If it completes 200 by any path, the gate is still bypassed — say so
plainly.

Then the cross-turn proof (the round-4 fix): in the SAME chat, send
"hello" as the next message and let it run until it stops by itself.
Report: how many more tool calls executed, the exact stop message,
and the cumulative total across both turns. **Target: 20 more in
turn 2 (cumulative 40 shell, the task cap), then a third "hello"
executes 0** — report the real numbers honestly. If turn 2 executes
another 20 and turn 3 executes 20 again, the task cap did not hold;
say so plainly. Also confirm a new instruction in the same chat
afterwards ("What is 2 + 2? Please use a shell echo") still works
and gets a fresh budget.

## What is NOT verified live (parent's job after deploy)

- The derived image `qwenpaw-agentx:2.3.0-gatefix5` has NOT been
  built. The patch was verified to apply to the pristine
  `limits.py` and reproduce `src/patched/limits.py` byte-for-byte
  locally, and the `mode.py` / `config.py` hunks have identical
  context to the gatefix3 patch that applied cleanly to the real
  image — but the image build, the in-image import + gate-chain
  checks, and the container switch are all the parent's job.
- No live-browser check has run for round 4 (the single-turn echo
  test, the cross-turn "hello" test, or the new-instruction test
  above). The machine-free tests are evidence, not proof.
- The agent-object lifetime assumption (one agent object per chat
  session, so task state survives across turns) is inferred from the
  code's structure, not measured live: log `id(agent)` across two
  turns after deploy and confirm it is the same object.
- The stop audit is in-memory only; it has not been read from a
  live session (there is no console surface for it yet — it is
  reachable only through `get_stop_audit(agent)` in code).
