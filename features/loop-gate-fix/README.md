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
single-response burst), and `src/patched/limits.py` is the fixed gate
the test runs against. The patch file is the authoritative diff; it
was verified to apply cleanly to the pristine files and reproduce the
patched files byte-for-byte (limits.py verified locally;
react_agent.py verified on the machine against the container's
pristine copy, which is identical in `/app/src` and site-packages
because gatefix2 did not touch it).

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
docker build -t qwenpaw-agentx:2.3.0-gatefix3 .
docker images qwenpaw-agentx:2.3.0-gatefix3   # record the digest
```

The Dockerfile fails the build if the patch does not apply cleanly.

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
docker run --rm qwenpaw-agentx:2.3.0-gatefix3 python3 -c "
from qwenpaw.loop.gates.limits import ToolCallBudgetGate
from qwenpaw.modes.default.mode import DefaultMode
print('gate imports OK')
"
# The enforcer refuses past the budget (machine-side, no browser):
# install it for a fake turn, reserve 200 shell calls, expect 20
# allowed and 180 refused, and a fresh turn to allow 20 again.
docker run --rm qwenpaw-agentx:2.3.0-gatefix3 python3 -c "
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
# Start it briefly on a scratch port and confirm the console serves
# (do NOT point it at the live data dir for this check)
docker run -d --name gatefix-smoke -p 18099:8080 \
  qwenpaw-agentx:2.3.0-gatefix3
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
#    line to qwenpaw-agentx:2.3.0-gatefix3. Keep every mount, env var,
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
