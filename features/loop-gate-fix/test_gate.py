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

Regression tests (must PASS on both):
  B  fires in round 0 when the first batch already exceeds max_calls.
  C  per-tool cap fires on the true count.
  D  separate message per round (no merge): total must be 50 then 100.
  F  previous turn's calls (different reply_id) are excluded.
  G  fallback when reply_id is missing: old incremental counting still works.

Usage:
  python3 test_gate.py --limits src/pristine/limits.py   # expect FAIL (bug)
  python3 test_gate.py --limits src/patched/limits.py    # expect PASS (fix)
  python3 test_gate.py                                    # defaults to patched
Exit code 0 when every test passes, 1 otherwise.
"""

import argparse
import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

REPO_FEATURE = Path(__file__).resolve().parent
PRISTINE = REPO_FEATURE / "src" / "pristine"
PATCHED = REPO_FEATURE / "src" / "patched"

SHELL = "execute_shell_command"


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
