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

A strict 30 would additionally require execution-time enforcement
(deny tool calls beyond the budget as they execute, e.g. a
ToolCoordinator `before` hook or a resource-governor check) or
aborting the model call mid-stream. Both are invasive changes to
shared execution paths and are out of scope for this fix. Do not
claim 30 unless a live test shows 30.

## Test

`test_gate.py` is a machine-free unit test for the counting fix. It
builds a minimal fake `qwenpaw` package (pristine `base.py` /
`loop_gate.py`, a stub `agent_context`, and the `limits.py` under
test) and drives the gate with fake agents whose context mimics the
parent's merged-message behaviour.

```bash
# Fail-first: the pristine gate must FAIL (it reproduces the live bug)
python3 test_gate.py --limits src/pristine/limits.py   # 11/29
# The gatefix1 gate must FAIL only the workflow-bypass tests
python3 test_gate.py --limits src/gatefix1/limits.py   # 15/29, H fails
# The patched gate must PASS
python3 test_gate.py --limits src/patched/limits.py    # 29/29
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
does NOT fire (H7, no false positive). Regression tests B–D, F, G
cover firing, the per-tool cap, the separate-message-per-round
layout, previous-turn exclusion, and the `reply_id`-missing
fallback.

`src/pristine/` holds the exact upstream files (sha256-verified
against the pinned image), `src/gatefix1/` holds the round-1 gate
(which passes A–G but fails H — the live workflow bypass), and
`src/patched/limits.py` is the fixed gate the test runs against.
The patch file is the authoritative diff; it was verified to apply
cleanly to the pristine files and reproduce the patched files
byte-for-byte.

The default-chain wiring (`mode.py` + `config.py`) is not covered by
the machine-free unit test (it needs the full QwenPaw import chain).
It is verified after the derived image is built, inside the image:
import the default mode, build the gates from a config, and assert a
`ToolCallBudgetGate` is present — see "Verify the image" below.

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
docker build -t qwenpaw-agentx:2.3.0-gatefix2 .
docker images qwenpaw-agentx:2.3.0-gatefix2   # record the digest
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
docker run --rm qwenpaw-agentx:2.3.0-gatefix2 python3 -c "
from qwenpaw.loop.gates.limits import ToolCallBudgetGate
from qwenpaw.modes.default.mode import DefaultMode
print('gate imports OK')
"
# Start it briefly on a scratch port and confirm the console serves
# (do NOT point it at the live data dir for this check)
docker run -d --name gatefix-smoke -p 18099:8080 \
  qwenpaw-agentx:2.3.0-gatefix2
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
#    line to qwenpaw-agentx:2.3.0-gatefix2. Keep every mount, env var,
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
message, whether it reached 200. **Target: ~50 executed (one batch),
not 30** — report the real number honestly. If it still executes
~100, the fix did not work; say so plainly. Also confirm normal
function: one short harmless message gets a reply, and the console
loads normally.

Note the model may route through the batch runner again (that is the
path this round fixes) or through direct calls (fixed in round 1).
Either way the run must stop after about one batch. If it completes
200 by any path, the gate is still bypassed — say so plainly.
