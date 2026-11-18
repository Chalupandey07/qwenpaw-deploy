# Loop-gate fix: make the tool-call budget actually enforce

## The bug

A custom loop mode "Guarded" used the built-in `ToolCallBudgetGate`
(`max_calls` 30, per-tool `execute_shell_command` 20). Two live tests
(echo 1–200, one echo per shell call) both executed **100 shell calls**
and stopped with "Tool call budget reached (100 calls)" / "(150 calls)"
— not 30 total, not 20 shell. The stored config was correct; the
running loop did not enforce it. The original incident was a 167-call
loop that ran ~6 minutes with no reply.

## Root cause (read from the source, confirmed by the live log)

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

## The fix

`qwenpaw-loop-gate-fix.patch` (against pinned upstream
`agentscope/qwenpaw:v2.3.0`, digest `sha256:46a782f4…`) changes three
files:

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
used to run 167 calls now stops after one batch (~50). The exact
number is the model's first-batch size (typically ~50, up to ~100
if the model emits a larger single batch); the gate cannot go below
one batch.

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
python3 test_gate.py --limits src/pristine/limits.py   # 10/14, A2=150, A3=300
# The patched gate must PASS
python3 test_gate.py --limits src/patched/limits.py    # 14/14
python3 test_gate.py                                   # defaults to patched
```

Discriminating tests: **A** (merged message, total 50→100→150, not
50→150→300) and **E** (stale `last_iteration` still counts).
Regression tests B–D, F, G cover firing, the per-tool cap, the
separate-message-per-round layout, previous-turn exclusion, and the
`reply_id`-missing fallback.

`src/pristine/` holds the exact upstream files (sha256-verified
against the pinned image) and `src/patched/limits.py` is the fixed
gate the test runs against. The patch file is the authoritative diff;
it was verified to apply cleanly to the pristine files and reproduce
the patched files byte-for-byte.

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
docker build -t qwenpaw-agentx:2.3.0-gatefix1 .
docker images qwenpaw-agentx:2.3.0-gatefix1   # record the digest
```

The Dockerfile fails the build if the patch does not apply cleanly.

## Verify the image (before switching the live container)

```bash
# The patched modules import and the gate is in the default chain
docker run --rm qwenpaw-agentx:2.3.0-gatefix1 python3 -c "
from qwenpaw.loop.gates.limits import ToolCallBudgetGate
from qwenpaw.modes.default.mode import DefaultMode
print('gate imports OK')
"
# Start it briefly on a scratch port and confirm the console serves
# (do NOT point it at the live data dir for this check)
docker run -d --name gatefix-smoke -p 18099:8080 \
  qwenpaw-agentx:2.3.0-gatefix1
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18099/
docker rm -f gatefix-smoke
```

Do NOT switch the live container to an image that has not passed
these checks.

## Deploy (snapshot first)

```bash
# 1. Snapshot the machine in the InstaBox console (record the snapshot id).
# 2. Edit /data/home/qwenpaw/docker-compose.yml: change only the image
#    line to qwenpaw-agentx:2.3.0-gatefix1. Keep every mount, env var,
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
