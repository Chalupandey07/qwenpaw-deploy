#!/usr/bin/env python3
"""Unit test for ToolCallBudgetGate counting (features/loop-gate-fix).

Tests the gate in isolation against a limits.py file given by --limits
(pristine upstream or patched). Builds a minimal fake ``qwenpaw`` package
in a temp dir (base.py + loop_gate.py from the repo's pristine copies,
a stub agent_context, and the limits.py under test) so no container or
machine is needed.

The bug under test: the parent AgentScope merges all of a turn's
tool-call blocks into the assistant message(s) carrying the current
``reply_id``. The old gate added the *cumulative* latest message to its
running total once per round, so the reported total inflated
(50, then 150, then 300, ...) and the gate fired with a wrong count.
The fix recomputes the turn total from the reply-scoped blocks on every
check, so every call is counted exactly once.

Discriminating tests (must FAIL on pristine, PASS on patched):
  A  merged message, two rounds: total must be 50 then 100 (not 150).
  E  stale last_iteration: the gate must still count round 0 (not skip).

Bypass tests (must FAIL on the gatefix1 gate, PASS on patched):
  H  a "Run workflow" (run_tool_batch) call must be expanded into its
     sub-calls: a batch of 50 shell steps counts as 51 (1 batch + 50
     sub-calls) and fires; 4 batches count 204. A completed batch is
     counted from its result JSON when its call could not be expanded.
     A batch is never counted twice (call + result = 51, not 101).
     A small batch (3 steps) must NOT fire (no false positive).

Execution-time tests (must FAIL on the gatefix2 gate, PASS on patched):
  I  a single model response with 200 direct parallel tool calls must
     stop at execution time: the enforcer (try_reserve_execution)
     refuses calls past the budget BEFORE they execute, so only the
     first 20 shell calls (per-tool cap) or 30 calls (total cap)
     execute. On the gatefix2 gate there is no enforcer, so the
     simulator executes all 200 -- the live failure (2026-11-18).
     A small run must NOT be refused, the counter must persist across
     rounds of one turn and reset on a new turn, and a batch call must
     be refused whole when its sub-calls would exceed the budget.

Regression tests (must PASS on both):
  B  fires in round 0 when the first batch already exceeds max_calls.
  C  per-tool cap fires on the true count.
  D  separate message per round (no merge): total must be 50 then 100.
  F  previous turn's calls (different reply_id) are excluded.
  G  fallback when reply_id is missing: old incremental counting still works.

Usage:
  python3 test_gate.py --limits src/pristine/limits.py   # 18/47 (bug)
  python3 test_gate.py --limits src/gatefix1/limits.py   # 22/47 (H + I fail)
  python3 test_gate.py --limits src/gatefix2/limits.py   # 36/47 (I fails)
  python3 test_gate.py --limits src/patched/limits.py    # 47/47 (fix)
  python3 test_gate.py                                    # defaults to patched
Exit code 0 when every test passes, 1 otherwise.
"""

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

REPO_FEATURE = Path(__file__).resolve().parent
PRISTINE = REPO_FEATURE / "src" / "pristine"
PATCHED = REPO_FEATURE / "src" / "patched"
GATEFIX1 = REPO_FEATURE / "src" / "gatefix1"

SHELL = "execute_shell_command"
BATCH = "run_tool_batch"


# ---------------------------------------------------------------------------
# Fake agent / messages
# ---------------------------------------------------------------------------
class FakeMsg:
    """Minimal stand-in for agentscope Msg (id + content blocks)."""

    def __init__(self, msg_id, blocks):
        self.id = msg_id
        self.role = "assistant"
        self.name = "default"
        self.content = blocks


class FakeState:
    def __init__(self, context, reply_id):
        self.context = context
        self.reply_id = reply_id


class FakeAgent:
    def __init__(self, context, reply_id):
        self.state = FakeState(context, reply_id)


class FakeAgentNoReplyId:
    """State without a reply_id attribute (fallback path)."""

    class _State:
        def __init__(self, context):
            self.context = context

    def __init__(self, context):
        self.state = self._State(context)


def tool_block(name=SHELL):
    return {"type": "tool_call", "name": name}


def batch_call_block(call_id, file_path=None, actions=None):
    """A run_tool_batch tool-call block (file or inline actions)."""
    args = {}
    if file_path is not None:
        args["file_path"] = file_path
    if actions is not None:
        args["actions"] = actions
    return {"type": "tool_call", "id": call_id, "name": BATCH,
            "input": args}


def batch_result_block(call_id, n, name=SHELL, last_only=False):
    """A run_tool_batch tool-result block with n sub-call results."""
    if last_only:
        payload = {"ok": True, "total": n, "completed": n,
                   "last_step_result": {"step": n - 1, "tool_name": name,
                                        "ok": True}}
    else:
        payload = {"ok": True, "total": n, "completed": n,
                   "results": [{"step": i, "tool_name": name, "ok": True,
                                "value": i + 1} for i in range(n)]}
    return {"type": "tool_result", "id": call_id, "name": BATCH,
            "output": [{"type": "text", "text": json.dumps(payload)}]}


def batch_steps(n, name=SHELL):
    """n batch steps, each one shell call (plus a control-flow step)."""
    steps = [{"tool_name": name,
              "arguments": {"command": f"echo {i + 1}"}}
             for i in range(n)]
    steps.append({"tool_name": "set_var",
                  "arguments": {"expr": "i=1"}})
    return steps


def write_batch_file(directory, n, name=SHELL):
    """Write a batch JSON file with n shell steps; return its path."""
    path = Path(directory) / f"echo_batch_{n}.json"
    path.write_text(json.dumps(batch_steps(n, name)))
    return str(path)


def msg_with_calls(msg_id, n, name=SHELL):
    return FakeMsg(msg_id, [tool_block(name) for _ in range(n)])


# ---------------------------------------------------------------------------
# Package builder: import limits.py under test as qwenpaw.loop.gates.limits
# ---------------------------------------------------------------------------
def load_gate_module(limits_path):
    tmp = Path(tempfile.mkdtemp(prefix="gate-test-"))
    pkg = tmp / "qwenpaw"
    (pkg / "app").mkdir(parents=True)
    (pkg / "loop" / "gates").mkdir(parents=True)
    for p in (pkg, pkg / "app", pkg / "loop", pkg / "loop" / "gates"):
        (p / "__init__.py").write_text("")
    (pkg / "app" / "agent_context.py").write_text(
        "def get_current_session_id():\n"
        "    return 'test-session'\n"
    )
    shutil.copy(PRISTINE / "base.py", pkg / "loop" / "gates" / "base.py")
    shutil.copy(PRISTINE / "loop_gate.py", pkg / "loop" / "gates" / "loop_gate.py")
    shutil.copy(limits_path, pkg / "loop" / "gates" / "limits.py")
    sys.path.insert(0, str(tmp))
    try:
        import qwenpaw.loop.gates.limits as limits_mod
    finally:
        sys.path.pop(0)
    return limits_mod


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def run_tests(limits_mod):
    ToolCallBudgetGate = limits_mod.ToolCallBudgetGate
    StopAction = limits_mod.StopAction
    results = []

    def check(name, cond, detail=""):
        results.append((name, bool(cond), detail))
        print(f"  {'PASS' if cond else 'FAIL'}  {name}"
              + (f"  ({detail})" if detail else ""))

    async def run_all():
        # -- A: merged message, two rounds, no double-counting ---------
        gate = ToolCallBudgetGate(max_calls=1000, per_tool={})
        gate.reset_turn()
        ctx_msgs = [msg_with_calls("r1", 50)]
        agent = FakeAgent(ctx_msgs, "r1")
        res = await gate.check({"iteration": 0, "agent": agent})
        state = gate._state()
        check("A1 round0 total==50", state.total == 50, f"total={state.total}")
        # round 1: same message now holds 100 blocks (parent merged)
        ctx_msgs[0].content.extend([tool_block() for _ in range(50)])
        res = await gate.check({"iteration": 1, "agent": agent})
        state = gate._state()
        check("A2 round1 total==100 (not 150)", state.total == 100,
              f"total={state.total}")
        # round 2: same message now holds 150 blocks
        ctx_msgs[0].content.extend([tool_block() for _ in range(50)])
        res = await gate.check({"iteration": 2, "agent": agent})
        state = gate._state()
        check("A3 round2 total==150 (not 300)", state.total == 150,
              f"total={state.total}")

        # -- B: fires in round 0 when first batch exceeds budget -------
        gate = ToolCallBudgetGate(max_calls=30, per_tool={})
        gate.reset_turn()
        agent = FakeAgent([msg_with_calls("r1", 50)], "r1")
        res = await gate.check({"iteration": 0, "agent": agent})
        check("B1 round0 TERMINATE",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        check("B2 reason reports true total 50",
              res.reason == "Tool call budget reached (50 calls)",
              f"reason={res.reason!r}")

        # -- C: per-tool cap fires on the true count -------------------
        gate = ToolCallBudgetGate(max_calls=1000,
                                  per_tool={SHELL: 20})
        gate.reset_turn()
        agent = FakeAgent([msg_with_calls("r1", 50)], "r1")
        res = await gate.check({"iteration": 0, "agent": agent})
        check("C1 per-tool TERMINATE",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        check("C2 per-tool reason",
              res.reason == f"Tool '{SHELL}' call budget reached (20)",
              f"reason={res.reason!r}")

        # -- D: separate message per round (no merge) ------------------
        gate = ToolCallBudgetGate(max_calls=1000, per_tool={})
        gate.reset_turn()
        ctx_msgs = [msg_with_calls("r1", 50)]
        agent = FakeAgent(ctx_msgs, "r1")
        await gate.check({"iteration": 0, "agent": agent})
        check("D1 round0 total==50", gate._state().total == 50,
              f"total={gate._state().total}")
        ctx_msgs.append(msg_with_calls("r1", 50))
        await gate.check({"iteration": 1, "agent": agent})
        check("D2 round1 total==100", gate._state().total == 100,
              f"total={gate._state().total}")

        # -- E: stale last_iteration must not skip a count ------------
        gate = ToolCallBudgetGate(max_calls=30, per_tool={})
        gate.reset_turn()
        # simulate stale state: last_iteration already equals this round
        stale = gate._state()
        stale.last_iteration = 0
        agent = FakeAgent([msg_with_calls("r1", 50)], "r1")
        res = await gate.check({"iteration": 0, "agent": agent})
        check("E1 stale state still TERMINATEs",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        check("E2 stale state total==50", gate._state().total == 50,
              f"total={gate._state().total}")

        # -- F: previous turn's calls excluded -------------------------
        gate = ToolCallBudgetGate(max_calls=1000, per_tool={})
        gate.reset_turn()
        ctx_msgs = [msg_with_calls("r0", 40), msg_with_calls("r1", 50)]
        agent = FakeAgent(ctx_msgs, "r1")
        await gate.check({"iteration": 0, "agent": agent})
        check("F1 current-turn total==50 (not 90)",
              gate._state().total == 50, f"total={gate._state().total}")

        # -- G: fallback when reply_id is missing ----------------------
        gate = ToolCallBudgetGate(max_calls=30, per_tool={})
        gate.reset_turn()
        agent = FakeAgentNoReplyId([msg_with_calls("r1", 50)])
        res = await gate.check({"iteration": 0, "agent": agent})
        check("G1 fallback TERMINATEs",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        check("G2 fallback reason (50 calls)",
              res.reason == "Tool call budget reached (50 calls)",
              f"reason={res.reason!r}")

        # -- H: workflow bypass (run_tool_batch) -----------------------
        # The live test (2026-11-18) reached 200 echoes via 4 batches
        # of 50 while the gate saw only 5 top-level calls. A batch call
        # must expand into its sub-calls.
        tmpdir = tempfile.mkdtemp(prefix="gate-batch-")
        try:
            batch50 = write_batch_file(tmpdir, 50)

            # H1: one batch call (file, 50 steps) counts 51, fires.
            gate = ToolCallBudgetGate(max_calls=30, per_tool={})
            gate.reset_turn()
            agent = FakeAgent(
                [FakeMsg("r1", [batch_call_block("b1", batch50)])], "r1")
            res = await gate.check({"iteration": 0, "agent": agent})
            check("H1 file batch total==51 (1 + 50)",
                  gate._state().total == 51, f"total={gate._state().total}")
            check("H1 file batch TERMINATEs",
                  res.action == StopAction.TERMINATE,
                  f"action={res.action}")

            # H2: one batch call (inline actions, 50 steps) counts 51.
            gate = ToolCallBudgetGate(max_calls=30, per_tool={})
            gate.reset_turn()
            agent = FakeAgent(
                [FakeMsg("r1", [batch_call_block(
                    "b1", actions=batch_steps(50))])], "r1")
            res = await gate.check({"iteration": 0, "agent": agent})
            check("H2 inline batch total==51",
                  gate._state().total == 51, f"total={gate._state().total}")
            check("H2 inline batch TERMINATEs",
                  res.action == StopAction.TERMINATE,
                  f"action={res.action}")

            # H3: four batches (the live test) count 204, fire.
            gate = ToolCallBudgetGate(max_calls=30, per_tool={})
            gate.reset_turn()
            blocks = [batch_call_block(f"b{i}", batch50)
                      for i in range(4)]
            agent = FakeAgent([FakeMsg("r1", blocks)], "r1")
            res = await gate.check({"iteration": 0, "agent": agent})
            check("H3 four batches total==204",
                  gate._state().total == 204,
                  f"total={gate._state().total}")
            check("H3 four batches TERMINATEs",
                  res.action == StopAction.TERMINATE,
                  f"action={res.action}")

            # H4: completed batch counted from its result JSON when
            # the call could not be expanded (unreadable file path).
            gate = ToolCallBudgetGate(max_calls=30, per_tool={})
            gate.reset_turn()
            agent = FakeAgent(
                [FakeMsg("r1", [
                    batch_call_block("b1", "/nonexistent/echo.json"),
                    batch_result_block("b1", 50),
                ])], "r1")
            res = await gate.check({"iteration": 0, "agent": agent})
            check("H4 result fallback total==51 (1 + 50)",
                  gate._state().total == 51, f"total={gate._state().total}")
            check("H4 result fallback TERMINATEs",
                  res.action == StopAction.TERMINATE,
                  f"action={res.action}")

            # H5: no double-counting -- call expanded AND its result
            # present counts 51 once, not 101.
            gate = ToolCallBudgetGate(max_calls=1000, per_tool={})
            gate.reset_turn()
            agent = FakeAgent(
                [FakeMsg("r1", [
                    batch_call_block("b1", batch50),
                    batch_result_block("b1", 50),
                ])], "r1")
            await gate.check({"iteration": 0, "agent": agent})
            check("H5 expanded call + result == 51 (not 101)",
                  gate._state().total == 51, f"total={gate._state().total}")

            # H6: per-tool cap fires through a batch (50 shell steps).
            gate = ToolCallBudgetGate(max_calls=1000,
                                      per_tool={SHELL: 20})
            gate.reset_turn()
            agent = FakeAgent(
                [FakeMsg("r1", [batch_call_block("b1", batch50)])], "r1")
            res = await gate.check({"iteration": 0, "agent": agent})
            check("H6 per-tool via batch TERMINATEs",
                  res.action == StopAction.TERMINATE,
                  f"action={res.action}")
            check("H6 per-tool reason",
                  res.reason == f"Tool '{SHELL}' call budget reached (20)",
                  f"reason={res.reason!r}")

            # H7: small batch (3 steps) must NOT fire (no false
            # positive) -- control-flow step excluded, total == 4.
            gate = ToolCallBudgetGate(max_calls=30, per_tool={})
            gate.reset_turn()
            small = write_batch_file(tmpdir, 3)
            agent = FakeAgent(
                [FakeMsg("r1", [batch_call_block("b1", small)])], "r1")
            res = await gate.check({"iteration": 0, "agent": agent})
            check("H7 small batch total==4 (1 + 3)",
                  gate._state().total == 4, f"total={gate._state().total}")
            check("H7 small batch does NOT fire",
                  res.action == StopAction.BYPASS,
                  f"action={res.action}")

            # H8: last_only result (no results list) counts via total.
            gate = ToolCallBudgetGate(max_calls=30, per_tool={})
            gate.reset_turn()
            agent = FakeAgent(
                [FakeMsg("r1", [
                    batch_call_block("b1", "/nonexistent/echo.json"),
                    batch_result_block("b1", 50, last_only=True),
                ])], "r1")
            res = await gate.check({"iteration": 0, "agent": agent})
            check("H8 last_only total==51",
                  gate._state().total == 51, f"total={gate._state().total}")
            check("H8 last_only TERMINATEs",
                  res.action == StopAction.TERMINATE,
                  f"action={res.action}")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

        # -- I: execution-time enforcement (single-response burst) -----
        # The live test (2026-11-18) issued 200 direct parallel calls
        # in ONE model response. The gate counted 200 and fired, but
        # the deferred stop let all 200 execute. The enforcer must
        # refuse calls past the budget BEFORE they execute. The
        # simulator mirrors ReactAgent._execute_tool_call: it reserves
        # via try_reserve_execution and executes only when allowed.
        # On a limits.py without the enforcer (gatefix2) it executes
        # everything, reproducing the live failure (fail-first).
        reserve_fn = getattr(limits_mod, "try_reserve_execution", None)

        def simulate_execute(agent, blocks):
            """Execute tool-call blocks through the enforcer.

            Returns (executed, refused). A block is 'executed' when
            the enforcer allows it (reserve returns None); 'refused'
            when the enforcer returns a reason. Without an enforcer
            (gatefix2) every block executes.
            """
            executed = 0
            refused = 0
            for block in blocks:
                if reserve_fn is None:
                    executed += 1
                    continue
                if reserve_fn(agent, block) is None:
                    executed += 1
                else:
                    refused += 1
            return executed, refused

        # I1: 200 shell calls in one response. The per-tool cap (20)
        # binds first: 20 execute, 180 refused.
        gate = ToolCallBudgetGate(max_calls=30, per_tool={SHELL: 20})
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(200)]
        agent = FakeAgent([FakeMsg("r1", list(blocks))], "r1")
        res = await gate.check({"iteration": 0, "agent": agent})
        check("I1 gate fires on 200-call response",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks)
        check("I1 20 shell calls execute (per-tool cap)",
              executed == 20, f"executed={executed}")
        check("I1 180 shell calls refused",
              refused == 180, f"refused={refused}")

        # I2: 25 shell then 175 web_search. Shell cap 20 binds, then
        # the total cap 30 binds: 20 shell + 10 web execute, 170 refuse.
        gate = ToolCallBudgetGate(max_calls=30, per_tool={SHELL: 20})
        gate.reset_turn()
        blocks = ([tool_block(SHELL) for _ in range(25)]
                  + [tool_block("web_search") for _ in range(175)])
        agent = FakeAgent([FakeMsg("r1", list(blocks))], "r1")
        await gate.check({"iteration": 0, "agent": agent})
        executed, refused = simulate_execute(agent, blocks)
        check("I2 30 calls execute (20 shell + 10 web)",
              executed == 30, f"executed={executed}")
        check("I2 170 calls refused",
              refused == 170, f"refused={refused}")

        # I3: a small run (5 shell calls) must NOT be refused.
        gate = ToolCallBudgetGate(max_calls=30, per_tool={SHELL: 20})
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(5)]
        agent = FakeAgent([FakeMsg("r1", list(blocks))], "r1")
        res = await gate.check({"iteration": 0, "agent": agent})
        check("I3 small run does NOT fire the gate",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks)
        check("I3 all 5 shell calls execute",
              executed == 5, f"executed={executed}")
        check("I3 none refused", refused == 0, f"refused={refused}")

        # I4: the counter persists across rounds of one turn. Round 1:
        # 25 web_search (no per-tool cap) all execute. Round 2 (same
        # reply_id): 10 more web_search, only 5 execute (total 30).
        gate = ToolCallBudgetGate(max_calls=30, per_tool={SHELL: 20})
        gate.reset_turn()
        ctx_msgs = [FakeMsg("r1", [tool_block("web_search")
                                   for _ in range(25)])]
        agent = FakeAgent(ctx_msgs, "r1")
        await gate.check({"iteration": 0, "agent": agent})
        executed1, _ = simulate_execute(
            agent, list(ctx_msgs[0].content))
        check("I4 round1 all 25 execute",
              executed1 == 25, f"executed={executed1}")
        ctx_msgs[0].content.extend(
            [tool_block("web_search") for _ in range(10)])
        await gate.check({"iteration": 1, "agent": agent})
        executed2, refused2 = simulate_execute(
            agent, list(ctx_msgs[0].content[25:]))
        check("I4 round2 only 5 execute (total cap 30)",
              executed2 == 5, f"executed={executed2}")
        check("I4 round2 5 refused",
              refused2 == 5, f"refused={refused2}")
        check("I4 turn total executed == 30",
              executed1 + executed2 == 30,
              f"total={executed1 + executed2}")

        # I5: a new turn (new reply_id) resets the counter: 200 shell
        # calls in the new turn again allow 20, not 0.
        blocks = [tool_block(SHELL) for _ in range(200)]
        agent2 = FakeAgent([FakeMsg("r2", list(blocks))], "r2")
        await gate.check({"iteration": 0, "agent": agent2})
        executed, refused = simulate_execute(agent2, blocks)
        check("I5 new turn 20 shell calls execute again",
              executed == 20, f"executed={executed}")
        check("I5 new turn 180 refused",
              refused == 180, f"refused={refused}")

        # I6: a batch call is refused whole when its sub-calls would
        # exceed the budget (51 > 30); a small batch is allowed.
        tmpdir2 = tempfile.mkdtemp(prefix="gate-batch-exec-")
        try:
            big = write_batch_file(tmpdir2, 50)
            small = write_batch_file(tmpdir2, 3)
            gate = ToolCallBudgetGate(max_calls=30, per_tool={SHELL: 20})
            gate.reset_turn()
            agent = FakeAgent(
                [FakeMsg("r1", [batch_call_block("b1", big)])], "r1")
            await gate.check({"iteration": 0, "agent": agent})
            executed, refused = simulate_execute(
                agent, [batch_call_block("b1", big)])
            check("I6 big batch (50 steps) refused whole",
                  executed == 0 and refused == 1,
                  f"executed={executed} refused={refused}")
            gate = ToolCallBudgetGate(max_calls=30, per_tool={SHELL: 20})
            gate.reset_turn()
            agent = FakeAgent(
                [FakeMsg("r1", [batch_call_block("b1", small)])], "r1")
            await gate.check({"iteration": 0, "agent": agent})
            executed, refused = simulate_execute(
                agent, [batch_call_block("b1", small)])
            check("I6 small batch (3 steps) allowed",
                  executed == 1 and refused == 0,
                  f"executed={executed} refused={refused}")
        finally:
            shutil.rmtree(tmpdir2, ignore_errors=True)

        # I7: the gate and the enforcer agree. After a 200-call
        # response the gate's reason names the true total (200), and
        # the refusal reason names the budget.
        gate = ToolCallBudgetGate(max_calls=30, per_tool={SHELL: 20})
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(200)]
        agent = FakeAgent([FakeMsg("r1", list(blocks))], "r1")
        res = await gate.check({"iteration": 0, "agent": agent})
        check("I7 gate reason reports true total 200",
              res.reason == "Tool call budget reached (200 calls)",
              f"reason={res.reason!r}")
        reason = None
        if reserve_fn is not None:
            for block in blocks:
                reason = reserve_fn(agent, block)
                if reason is not None:
                    break
        check("I7 refusal reason names the budget",
              reason is not None and "budget" in reason,
              f"reason={reason!r}")

    asyncio.run(run_all())
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limits", default=str(PATCHED / "limits.py"),
                    help="limits.py to test (default: patched)")
    args = ap.parse_args()
    limits_path = Path(args.limits)
    if not limits_path.exists():
        print(f"limits.py not found: {limits_path}")
        return 2
    print(f"Testing gate from: {limits_path}")
    limits_mod = load_gate_module(limits_path)
    results = run_tests(limits_mod)
    n_pass = sum(1 for r in results if r[1])
    n_fail = len(results) - n_pass
    print(f"\n{n_pass} passed, {n_fail} failed")
    if n_fail:
        print("FAILED: " + ", ".join(r[0] for r in results if not r[1]))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
