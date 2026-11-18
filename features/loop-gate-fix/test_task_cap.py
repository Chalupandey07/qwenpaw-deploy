#!/usr/bin/env python3
"""Unit test for the per-task cap + structured stop audit (T126).

Tests the gatefix4 additions to ToolCallBudgetGate (limits.py) in
isolation, machine-free, in the same harness style as test_gate.py
(T115): it builds a minimal fake ``qwenpaw`` package in a temp dir
(pristine ``base.py`` / ``loop_gate.py``, a stub ``agent_context``,
and the ``limits.py`` under test) and drives the gate with fake agents
whose context mimics the parent's merged-message behaviour. The SAME
fake agent object is reused across turns (its state.context grows and
its state.reply_id changes), because the task budget lives on the
agent for the chat session, like the per-turn exec counter.

The failure under test (live test, browser task 146acf9e,
2026-11-18): the gatefix3 per-turn cap works (turn 1: 20 shell calls
executed, 180 refused) BUT the cap resets every turn, so on the
follow-up "hello" the agent resumed the echo-1-to-200 task and did
21-40 (cumulative 40 across the chat). A per-task cap closes that:
the task budget is 2x the per-turn cap (60 total / 40 shell),
cumulative across turns; a task that spends it is finalised and a
resumed turn is refused until a new explicit instruction starts a
new task.

Discriminating tests (must FAIL on the gatefix3 gate, PASS on patched):
  J  the live shape: turn 1 spends 20 shell, turn 2 ("hello") gets 20
     more (task shell 40 = cap) and is finalised, turn 3 ("hello")
     executes 0, a new instruction gets a fresh budget.
  K  sub-cap creep: 25 web_search calls per turn never trip the
     per-turn cap (30), but the task cap (60) stops turn 3 after 10.
  L  the stop audit records every stop with the true turn + task
     totals, the kind, and the refused count (fuse 180, finalised
     resume 200).
  M  an explicit task id gets a fresh budget; re-issuing the capped
     instruction inherits the spent budget (repeat guard).
  N  an unreadable batch's sub-calls are charged to the task from the
     completed-batch result JSON (DeepSeek review fix).
  O  a batch that would jump over the task cap is refused whole.
  P  (T140, gatefix5) the per-turn agent rebuild: the runtime builds a
     FRESH agent object for every user turn and restores the session
     via load_state_dict, which restores only self.state -- NOT plain
     attributes. Gatefix4 stored the task budget as such an attribute,
     so every turn started with a fresh task and the per-task cap never
     bound (live failure b6180034: 20 shell per turn for 4 turns,
     cumulative 80). Gatefix5 persists the task budget through the
     state_dict round-trip. P replays the live shape WITH a fresh agent
     object per turn (same context, task state round-tripped through
     task_budget_state_dict / load_task_budget_state_dict when they
     exist): turn 2 gets 20 more to 40 and finalises, turns 3 and 4
     execute 0. P2 checks the snapshot round-trip; P3 checks the loader
     fails open on bad data. P FAILS on the gatefix4 gate (no
     persistence functions: every rebuild loses the task) and PASSES
     on gatefix5.
  Q  (T141, gatefix6) realistic resume messages: the blind spot P
     missed. P used bare "hello" turns, but the live test (browser
     task d0f77cb7, chat 0b220b4f) used "hello, are you working?" and
     "Yes, continue from 21". Gatefix5's _is_continuation required an
     EXACT match against a fixed set of bare words, so those messages
     each minted a FRESH task budget and abandoned the echo task --
     the per-task cap never accumulated (live: 20 shell/turn,
     cumulative 60, past the 40-shell cap). Gatefix6 matches a
     continuation phrase at the START of the message at a word
     boundary. Q1 replays the live shape WITH fresh agent objects
     per turn and the realistic messages: "hello, are you working?"
     resumes the same task (0 calls), "Yes, continue from 21"
     resumes and spends 20 more to 40 and finalises, "continue"
     executes 0. Q2 unit-checks the matcher (prefix + word
     boundary: "yesterday" / "history" / "surely" / "thanksgiving"
     are NOT continuations). Q3 checks a genuinely new instruction
     after finalisation still mints a fresh task. Q FAILS on the
     gatefix5 gate (11/30: Q1f/Q1g/Q1h/Q1l/Q1m/Q1o/Q1p/Q2a/Q2b/Q2c/
     Q2e) with byte-identical task ids to the live session file,
     and PASSES on gatefix6.

Regression tests (must PASS on both):
  N1 a small run executes fully, is not finalised, writes no stops.

Usage:
  python3 test_task_cap.py --limits src/gatefix3/limits.py  # FAILs (bug)
  python3 test_task_cap.py --limits src/gatefix4/limits.py  # FAILs (P only)
  python3 test_task_cap.py --limits src/patched/limits.py   # 87/87 (fix)
  python3 test_task_cap.py                                  # defaults to patched
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

SHELL = "execute_shell_command"
BATCH = "run_tool_batch"
ECHO = ("Please print the numbers from 1 to 200, one number per shell "
        "echo call, each echo as its own tool call.")


# ---------------------------------------------------------------------------
# Fake agent / messages (same shapes as test_gate.py, plus user turns)
# ---------------------------------------------------------------------------
class FakeMsg:
    """Minimal stand-in for agentscope Msg (id + content blocks)."""

    def __init__(self, msg_id, blocks):
        self.id = msg_id
        self.role = "assistant"
        self.name = "default"
        self.content = blocks


def user_msg(msg_id, text):
    """A user message (plain-string content, as the parent stores it)."""
    msg = FakeMsg(msg_id, text)
    msg.role = "user"
    return msg


class FakeState:
    def __init__(self, context, reply_id):
        self.context = context
        self.reply_id = reply_id


class FakeAgent:
    def __init__(self, context, reply_id):
        self.state = FakeState(context, reply_id)


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
    """n batch steps, each one call (plus a control-flow step)."""
    steps = [{"tool_name": name,
              "arguments": {"command": f"echo {i + 1}"}}
             for i in range(n)]
    steps.append({"tool_name": "set_var",
                  "arguments": {"expr": "i=1"}})
    return steps


def msg_with_calls(msg_id, n, name=SHELL):
    return FakeMsg(msg_id, [tool_block(name) for _ in range(n)])


def begin_turn(agent, reply_id, user_text, blocks):
    """Start a turn on a reused agent: user message + assistant msg.

    Returns the assistant message (so the test can append results to
    it later, as the parent appends tool results to the reply-scoped
    message). The same agent object is reused across turns: that is
    the lifetime the task budget relies on.
    """
    agent.state.context.append(user_msg(f"u-{reply_id}", user_text))
    msg = FakeMsg(reply_id, list(blocks))
    agent.state.context.append(msg)
    agent.state.reply_id = reply_id
    return msg


# ---------------------------------------------------------------------------
# Package builder: import limits.py under test as qwenpaw.loop.gates.limits
# ---------------------------------------------------------------------------
def load_gate_module(limits_path):
    tmp = Path(tempfile.mkdtemp(prefix="task-cap-test-"))
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
def run_tests(limits_mod, section=None):
    ToolCallBudgetGate = limits_mod.ToolCallBudgetGate
    StopAction = limits_mod.StopAction
    get_task_state = getattr(limits_mod, "get_task_state", None)
    get_stop_audit = getattr(limits_mod, "get_stop_audit", None)
    reserve_fn = getattr(limits_mod, "try_reserve_execution", None)
    results = []

    def check(name, cond, detail=""):
        # --section P runs only the P checks (T140); the other sections
        # still execute (they are independent) but are not recorded.
        if section is not None and not name.startswith(section):
            return
        results.append((name, bool(cond), detail))
        print(f"  {'PASS' if cond else 'FAIL'}  {name}"
              + (f"  ({detail})" if detail else ""))

    def task_of(agent):
        if get_task_state is None:
            return None
        try:
            return get_task_state(agent)
        except Exception:
            return None

    def audit_of(agent):
        if get_stop_audit is None:
            return []
        try:
            return get_stop_audit(agent)
        except Exception:
            return []

    def make_gate():
        """Gate with the task cap; fall back to plain on old code.

        On the gatefix3 gate the task kwargs do not exist, so the
        constructor raises TypeError and the test runs against the
        plain gate -- which must FAIL the task-cap checks (fail-first).
        """
        try:
            return ToolCallBudgetGate(
                max_calls=30, per_tool={SHELL: 20},
                task_max_calls=60, task_per_tool={SHELL: 40},
            )
        except TypeError:
            return ToolCallBudgetGate(
                max_calls=30, per_tool={SHELL: 20},
            )

    def simulate_execute(agent, blocks):
        """Execute tool-call blocks through the enforcer.

        Returns (executed, refused). Without an enforcer every block
        executes.
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

    async def run_all():
        # -- J: the live shape (browser task 146acf9e) ----------------
        # Turn 1 spends 20 shell; turn 2 ("hello") resumes and gets 20
        # more (task shell 40 = cap) and is finalised; turn 3 ("hello")
        # executes nothing; a new instruction gets a fresh budget.
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r1", ECHO, blocks)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("J1a turn1 gate TERMINATEs (per-turn)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        task = task_of(agent)
        task_a_id = task.get("task_id") if task else None
        check("J1b turn1 has a task id",
              bool(task_a_id), f"task_id={task_a_id!r}")
        executed, refused = simulate_execute(agent, blocks)
        check("J1c turn1 20 shell execute",
              executed == 20, f"executed={executed}")
        check("J1d turn1 180 refused",
              refused == 180, f"refused={refused}")
        task = task_of(agent)
        check("J1e task shell total == 20",
              task is not None
              and task.get("by_tool", {}).get(SHELL) == 20,
              f"task={task}")
        check("J1f task total == 20",
              task is not None and task.get("total") == 20,
              f"task={task}")
        audit_len_j1 = len(audit_of(agent))

        # Turn 2: the follow-up "hello". Same task, no fresh budget.
        gate.reset_turn()
        blocks2 = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r2", "hello", blocks2)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("J2a turn2 gate TERMINATEs",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks2)
        check("J2b turn2 20 more shell execute (not a fresh 20/30)",
              executed == 20, f"executed={executed}")
        check("J2c turn2 180 refused",
              refused == 180, f"refused={refused}")
        task = task_of(agent)
        check("J2d task shell total == 40 (the cap)",
              task is not None
              and task.get("by_tool", {}).get(SHELL) == 40,
              f"task={task}")
        check("J2e task is finalised at the cap",
              task is not None and task.get("finalized") is True,
              f"task={task}")

        # Turn 3: another "hello" must NOT silently continue the task.
        gate.reset_turn()
        blocks3 = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r3", "hello", blocks3)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("J3a turn3 gate TERMINATEs (finalised task)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        check("J3b turn3 reason names the task total 40",
              "40" in (res.reason or "") and "Task" in (res.reason or ""),
              f"reason={res.reason!r}")
        executed, refused = simulate_execute(agent, blocks3)
        check("J3c turn3 0 execute",
              executed == 0, f"executed={executed}")
        check("J3d turn3 200 refused",
              refused == 200, f"refused={refused}")

        # Turn 4: a genuinely new instruction starts a new task.
        gate.reset_turn()
        blocks4 = [tool_block(SHELL) for _ in range(5)]
        begin_turn(agent, "r4",
                   "Please echo 42 once with a shell call.", blocks4)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("J4a new instruction does NOT fire the gate",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks4)
        check("J4b new task 5 shell execute",
              executed == 5, f"executed={executed}")
        task = task_of(agent)
        check("J4c new task has a different task id",
              task is not None
              and task.get("task_id") not in (None, task_a_id),
              f"task_id={task.get('task_id') if task else None!r}")
        check("J4d new task total == 5 (fresh budget)",
              task is not None and task.get("total") == 5,
              f"task={task}")
        check("J4e new task is not finalised",
              task is not None and task.get("finalized") is False,
              f"task={task}")

        # -- K: sub-cap creep (never trips the per-turn cap) -----------
        # 25 web_search per turn: under the 30 total cap every turn,
        # but the 60 task cap stops turn 3 after 10.
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block("web_search") for _ in range(25)]
        begin_turn(agent, "r1",
                   "Search the web for 75 facts, one search per call.",
                   blocks)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("K1a turn1 does NOT fire (25 < 30)",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, _ = simulate_execute(agent, blocks)
        check("K1b turn1 25 execute",
              executed == 25, f"executed={executed}")
        task = task_of(agent)
        check("K1c task total == 25",
              task is not None and task.get("total") == 25,
              f"task={task}")
        gate.reset_turn()
        blocks = [tool_block("web_search") for _ in range(25)]
        begin_turn(agent, "r2", "hello", blocks)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("K2a turn2 does NOT fire (25 < 30)",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, _ = simulate_execute(agent, blocks)
        check("K2b turn2 25 execute",
              executed == 25, f"executed={executed}")
        task = task_of(agent)
        check("K2c task total == 50",
              task is not None and task.get("total") == 50,
              f"task={task}")
        gate.reset_turn()
        blocks = [tool_block("web_search") for _ in range(25)]
        begin_turn(agent, "r3", "hello", blocks)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("K3a turn3 does NOT fire at check (25 < 30, 50 < 60)",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks)
        check("K3b turn3 only 10 execute (task cap 60)",
              executed == 10, f"executed={executed}")
        check("K3c turn3 15 refused",
              refused == 15, f"refused={refused}")
        task = task_of(agent)
        check("K3d task total == 60 (the cap)",
              task is not None and task.get("total") == 60,
              f"task={task}")
        check("K3e task is finalised at the cap",
              task is not None and task.get("finalized") is True,
              f"task={task}")

        # -- L: the stop audit ---------------------------------------
        # Replay J on a fresh agent so the audit counts are exact.
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r1", ECHO, blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        audit_len_j1 = len(audit_of(agent))
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r2", "hello", blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r3", "hello", blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        audit = audit_of(agent)
        check("L1 audit has 6 records (one per stop)",
              len(audit) == 6, f"len={len(audit)}")
        kinds = {r.get("kind") for r in audit}
        check("L2 audit kinds cover all four stop kinds",
              kinds == {"per-turn gate", "fuse", "per-task cap",
                        "task_finalized"},
              f"kinds={sorted(kinds)}")
        cap_records = [r for r in audit if r.get("kind") == "per-task cap"]
        check("L3 per-task cap record: task_total 40, finalised it",
              len(cap_records) == 1
              and cap_records[0].get("task_total") == 40
              and cap_records[0].get("finalized_by_this_stop") is True,
              f"cap_records={cap_records}")
        required = {"seq", "ts", "kind", "reason", "task_id", "turn_id",
                    "turn_total", "task_total"}
        check("L4 every record has ts/kind/reason/task/turn/totals",
              bool(audit) and all(
                  required <= set(r) for r in audit),
              f"keys={sorted(audit[0]) if audit else []}")
        fuse_records = [r for r in audit
                        if r.get("kind") == "fuse"
                        and r.get("turn_id") == "r1"]
        check("L5 fuse record (turn 1): refused == 180",
              len(fuse_records) == 1
              and fuse_records[0].get("refused") == 180,
              f"fuse_records={fuse_records}")
        fin_records = [r for r in audit
                       if r.get("kind") == "task_finalized"
                       and r.get("turn_id") == "r3"]
        check("L6 finalised-resume record (turn 3): refused 200, "
              "task_total 40",
              len(fin_records) == 1
              and fin_records[0].get("refused") == 200
              and fin_records[0].get("task_total") == 40,
              f"fin_records={fin_records}")
        check("L7 audit is append-only (grew across turns)",
              audit_len_j1 == 2 and len(audit) == 6,
              f"after turn1={audit_len_j1} after turn3={len(audit)}")

        # -- M: explicit task id + repeat guard (J's agent shape) ------
        # A fresh agent replays J1-J4, then an explicit task id and a
        # repeat of the capped instruction.
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r1", ECHO, blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        task_a_id = (task_of(agent) or {}).get("task_id")
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r2", "hello", blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(5)]
        begin_turn(agent, "r4",
                   "Please echo 42 once with a shell call.", blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        # M1: an explicit task id starts a fresh task mid-chat.
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(5)]
        begin_turn(agent, "r5",
                   "Count the files in /tmp, one per shell call.",
                   blocks)
        res = await gate.check({"iteration": 0, "agent": agent,
                                "task_id": "task-B"})
        check("M1a explicit task id does NOT fire the gate",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, _ = simulate_execute(agent, blocks)
        check("M1b explicit task 5 shell execute",
              executed == 5, f"executed={executed}")
        task = task_of(agent)
        check("M1c explicit task id task-B, total 5",
              task is not None
              and task.get("task_id") == "task-B"
              and task.get("total") == 5,
              f"task={task}")
        # M2: re-issuing the capped instruction inherits the spend.
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(200)]
        begin_turn(agent, "r6", ECHO, blocks)
        res = await gate.check({"iteration": 0, "agent": agent,
                                "task_id": task_a_id})
        check("M2a repeat of capped instruction TERMINATEs",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        check("M2b repeat reason names the task total 40",
              "40" in (res.reason or ""),
              f"reason={res.reason!r}")
        executed, refused = simulate_execute(agent, blocks)
        check("M2c repeat executes 0 (no fresh budget)",
              executed == 0, f"executed={executed}")
        task = task_of(agent)
        check("M2d repeat task is finalised with total 40",
              task is not None
              and task.get("finalized") is True
              and task.get("total") == 40,
              f"task={task}")

        # -- N: per-turn regression + unreadable-batch charge ----------
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block(SHELL) for _ in range(5)]
        begin_turn(agent, "r1", "Echo hello five times.", blocks)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("N1a small run does NOT fire the gate",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks)
        check("N1b small run all 5 execute",
              executed == 5, f"executed={executed}")
        task = task_of(agent)
        check("N1c small run is not finalised",
              task is not None and task.get("finalized") is False,
              f"task={task}")
        check("N1d small run writes no stop records",
              audit_of(agent) == [], f"audit={audit_of(agent)}")

        # N2: a batch whose file cannot be read reserves 1 slot, but
        # its 50 sub-calls execute inside the runner; the gate counts
        # them from the result JSON and charges them to the task.
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        msg = begin_turn(agent, "r1", "Run the batch file.",
                         [batch_call_block("b1",
                                          "/nonexistent/echo.json")])
        res = await gate.check({"iteration": 0, "agent": agent})
        check("N2a batch call alone does NOT fire (total 1)",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, refused = simulate_execute(
            agent, [batch_call_block("b1", "/nonexistent/echo.json")])
        check("N2b batch call reserves 1 slot",
              executed == 1 and refused == 0,
              f"executed={executed} refused={refused}")
        msg.content.append(batch_result_block("b1", 50))
        res = await gate.check({"iteration": 1, "agent": agent})
        check("N2c completed batch fires the gate (total 51)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        task = task_of(agent)
        check("N2d task total == 51 (1 reserved + 50 charged)",
              task is not None and task.get("total") == 51,
              f"task={task}")
        # N3: the charged task already spent 50 shell calls -- over
        # its 40 shell cap -- so it was finalised in N2's check and
        # the resume is refused outright (0 execute).
        gate.reset_turn()
        blocks = [tool_block("web_search") for _ in range(25)]
        begin_turn(agent, "r2", "hello", blocks)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("N3a resume TERMINATEs (finalised task)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        check("N3b resume reason names the task total 51",
              "51" in (res.reason or ""),
              f"reason={res.reason!r}")
        executed, refused = simulate_execute(agent, blocks)
        check("N3c resume 0 execute, 25 refused",
              executed == 0 and refused == 25,
              f"executed={executed} refused={refused}")
        task = task_of(agent)
        check("N3d task is finalised with total 51",
              task is not None
              and task.get("finalized") is True
              and task.get("total") == 51,
              f"task={task}")

        # -- O: a batch that would jump over the task cap -------------
        # Task at 55; a batch of 11 names (1 + 10) would take it to 66,
        # so the whole batch is refused and the task finalises.
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block("web_search") for _ in range(25)]
        begin_turn(agent, "r1", "Search for 50 facts.", blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        gate.reset_turn()
        blocks = [tool_block("web_search") for _ in range(25)]
        begin_turn(agent, "r2", "hello", blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        gate.reset_turn()
        blocks = [tool_block("web_search") for _ in range(5)]
        begin_turn(agent, "r3", "hello", blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        task = task_of(agent)
        check("O0 task total == 55 before the batch",
              task is not None and task.get("total") == 55,
              f"task={task}")
        batch = batch_call_block("b1", actions=batch_steps(10,
                                                          "web_search"))
        agent.state.context[-1].content.append(batch)
        res = await gate.check({"iteration": 1, "agent": agent})
        check("O1a batch does NOT fire at check (16 < 30, 55 < 60)",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, refused = simulate_execute(agent, [batch])
        check("O1b batch refused whole (0 execute, 1 refused)",
              executed == 0 and refused == 1,
              f"executed={executed} refused={refused}")
        task = task_of(agent)
        check("O1c task is finalised, total still 55",
              task is not None
              and task.get("finalized") is True
              and task.get("total") == 55,
              f"task={task}")

        # -- P: the per-turn agent rebuild (T140, gatefix5) -------------
        # The live gatefix4 failure (browser task b6180034, 2026-11-18):
        # the runtime builds a FRESH agent object for every user turn
        # (runtime/runtime.py: ctx.agent = builder.build(ctx) per
        # request) and restores the session via load_state_dict, which
        # restores only self.state -- NOT plain attributes on the agent.
        # Gatefix4 stored the task budget as such an attribute, so every
        # turn started with a fresh task (total=0) and the per-task cap
        # never bound: 20 shell calls per turn for 4 turns (cumulative
        # 80, past the 40-shell cap). Gatefix5 persists the task budget
        # through the state_dict round-trip. These tests rebuild a fresh
        # agent object per turn (same context, task state round-tripped
        # through the persistence functions when they exist) and verify
        # the cap holds. They FAIL on the gatefix4 gate (no persistence
        # functions: every rebuild loses the task) and PASS on gatefix5.
        snapshot_fn = getattr(limits_mod, "task_budget_state_dict", None)
        load_fn = getattr(limits_mod, "load_task_budget_state_dict", None)

        def rebuild_agent(agent, reply_id):
            """Fresh agent object, same context, task state restored.

            Mirrors the real runtime: a new agent per turn, the context
            restored from the session state, the task budget restored
            only if the persistence functions exist (gatefix5). On
            gatefix4 code the snapshot/load functions are absent, so
            the rebuild loses the task -- exactly the live failure.
            """
            snapshot = None
            if snapshot_fn is not None:
                try:
                    snapshot = snapshot_fn(agent)
                except Exception:
                    snapshot = None
            fresh = FakeAgent(agent.state.context, reply_id)
            if snapshot is not None and load_fn is not None:
                try:
                    load_fn(fresh, snapshot)
                except Exception:
                    pass
            return fresh

        # P1: the live shape WITH rebuilds (browser task b6180034).
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block(SHELL) for _ in range(50)]
        begin_turn(agent, "r1", ECHO, blocks)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("P1a turn1 gate TERMINATEs (per-turn)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks)
        check("P1b turn1 20 shell execute",
              executed == 20, f"executed={executed}")
        check("P1c turn1 30 refused",
              refused == 30, f"refused={refused}")
        task = task_of(agent)
        task_a_id = task.get("task_id") if task else None
        check("P1d task shell total == 20 after turn1",
              task is not None
              and task.get("by_tool", {}).get(SHELL) == 20,
              f"task={task}")
        # Turn 2: a FRESH agent object (the rebuild), same context.
        agent = rebuild_agent(agent, "r2")
        gate.reset_turn()
        blocks2 = [tool_block(SHELL) for _ in range(20)]
        begin_turn(agent, "r2", "hello", blocks2)
        task = task_of(agent)
        check("P1e rebuild preserves the task (same task id)",
              task is not None and task.get("task_id") == task_a_id,
              f"task_id={task.get('task_id') if task else None!r} "
              f"expected={task_a_id!r}")
        res = await gate.check({"iteration": 0, "agent": agent})
        check("P1f turn2 gate TERMINATEs",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks2)
        check("P1g turn2 20 more shell execute (not a fresh 20/30)",
              executed == 20, f"executed={executed}")
        check("P1h turn2 0 refused (the model only sent 20)",
              refused == 0, f"refused={refused}")
        task = task_of(agent)
        check("P1i task shell total == 40 (the cap) after turn2",
              task is not None
              and task.get("by_tool", {}).get(SHELL) == 40,
              f"task={task}")
        check("P1j task is finalised at the cap after turn2",
              task is not None and task.get("finalized") is True,
              f"task={task}")
        # Turn 3: another rebuild; the finalised task must refuse all.
        agent = rebuild_agent(agent, "r3")
        gate.reset_turn()
        blocks3 = [tool_block(SHELL) for _ in range(20)]
        begin_turn(agent, "r3", "hello", blocks3)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("P1k turn3 gate TERMINATEs (finalised task)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks3)
        check("P1l turn3 0 execute",
              executed == 0, f"executed={executed}")
        check("P1m turn3 20 refused",
              refused == 20, f"refused={refused}")
        # Turn 4: the live failure's fourth turn -- also 0.
        agent = rebuild_agent(agent, "r4")
        gate.reset_turn()
        blocks4 = [tool_block(SHELL) for _ in range(20)]
        begin_turn(agent, "r4", "hello", blocks4)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("P1n turn4 gate TERMINATEs (still finalised)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks4)
        check("P1o turn4 0 execute, 20 refused",
              executed == 0 and refused == 20,
              f"executed={executed} refused={refused}")

        # P2: the persistence round-trip itself.
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block(SHELL) for _ in range(50)]
        begin_turn(agent, "r1", ECHO, blocks)
        await gate.check({"iteration": 0, "agent": agent})
        simulate_execute(agent, blocks)
        snapshot = None
        if snapshot_fn is not None:
            try:
                snapshot = snapshot_fn(agent)
            except Exception:
                snapshot = None
        check("P2a snapshot exists (persistence function present)",
              snapshot is not None, f"snapshot={snapshot!r}"[:120])
        snap = snapshot or {}
        check("P2b snapshot version is 1",
              snap.get("version") == 1, f"version={snap.get('version')!r}")
        snap_task = snap.get("task") or {}
        check("P2c snapshot task: total 20, shell 20, not finalised",
              snap_task.get("total") == 20
              and (snap_task.get("by_tool") or {}).get(SHELL) == 20
              and snap_task.get("finalized") is False,
              f"task={snap_task}")
        fresh = FakeAgent(agent.state.context, "r2")
        loaded = False
        if load_fn is not None and snapshot is not None:
            try:
                loaded = bool(load_fn(fresh, snapshot))
            except Exception:
                loaded = False
        check("P2d load onto a fresh agent returns True",
              loaded is True, f"loaded={loaded!r}")
        task = task_of(fresh)
        check("P2e restored task matches (total 20, shell 20, same id)",
              task is not None
              and task.get("total") == 20
              and task.get("by_tool", {}).get(SHELL) == 20
              and task.get("task_id") == task_a_id
              and task.get("finalized") is False,
              f"task={task}")

        # P3: the loader fails open on bad data (never crashes, never
        # restores a half-valid task). On gatefix4 the loader does not
        # exist, so these fail (the feature is missing).
        fresh = FakeAgent([], "r1")
        r_none = load_fn(fresh, None) if load_fn is not None else "MISSING"
        check("P3a load(None) returns False",
              r_none is False, f"result={r_none!r}")
        r_ver = (
            load_fn(fresh, {"version": 999, "task": None, "prior": {}})
            if load_fn is not None else "MISSING"
        )
        check("P3b load(wrong version) returns False",
              r_ver is False, f"result={r_ver!r}")
        r_bad = (
            load_fn(fresh, {"version": 1,
                            "task": {"total": "not-an-int"},
                            "prior": {}})
            if load_fn is not None else "MISSING"
        )
        check("P3c load(bad task payload) returns False",
              r_bad is False, f"result={r_bad!r}")
        check("P3d agent has no task after failed loads",
              task_of(fresh) is None, f"task={task_of(fresh)}")
        gate = make_gate()
        gate.reset_turn()
        blocks = [tool_block(SHELL) for _ in range(5)]
        begin_turn(fresh, "r1", "Echo hello five times.", blocks)
        res = await gate.check({"iteration": 0, "agent": fresh})
        check("P3e a fresh task starts normally after failed loads",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, _ = simulate_execute(fresh, blocks)
        check("P3f fresh task 5 shell execute",
              executed == 5, f"executed={executed}")

        # -- Q: realistic resume messages (T141, gatefix6) -----------
        # The blind spot section P missed: it used bare "hello" turns,
        # but the live test (browser task d0f77cb7, chat 0b220b4f) used
        # realistic messages. Gatefix5's _is_continuation required an
        # EXACT match against a fixed set of bare words, so "hello,
        # are you working?" and "Yes, continue from 21" each minted a
        # FRESH task budget and abandoned the echo task -- the per-task
        # cap never accumulated (live: 20 shell/turn, cumulative 60,
        # past the 40-shell cap). Gatefix6 matches a continuation
        # phrase at the START of the message at a word boundary, so
        # those messages resume the current task. Q replays the live
        # shape WITH a fresh agent object per turn (like P): turn 1
        # spends 20, "hello, are you working?" resumes (same task,
        # 0 calls), "Yes, continue from 21" resumes and spends 20
        # more to 40 and finalises, "continue" executes 0.
        # Q1: the live shape with realistic messages + rebuilds.
        gate = make_gate()
        gate.reset_turn()
        agent = FakeAgent([], "r1")
        blocks = [tool_block(SHELL) for _ in range(50)]
        begin_turn(agent, "r1", ECHO, blocks)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("Q1a turn1 gate TERMINATEs (per-turn)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks)
        check("Q1b turn1 20 shell execute",
              executed == 20, f"executed={executed}")
        check("Q1c turn1 30 refused",
              refused == 30, f"refused={refused}")
        task = task_of(agent)
        task_a_id = task.get("task_id") if task else None
        check("Q1d task shell total == 20 after turn1",
              task is not None
              and task.get("by_tool", {}).get(SHELL) == 20,
              f"task={task}")
        # Turn 2: "hello, are you working?" on a FRESH agent. The
        # model sends no tool calls (prose reply), but the task must
        # be the SAME task -- not a fresh one.
        agent = rebuild_agent(agent, "r2")
        gate.reset_turn()
        begin_turn(agent, "r2", "hello, are you working?", [])
        res = await gate.check({"iteration": 0, "agent": agent})
        check("Q1e turn2 'hello, are you working?' does NOT fire",
              res.action == StopAction.BYPASS, f"action={res.action}")
        task = task_of(agent)
        check("Q1f turn2 resumes the SAME task (no fresh budget)",
              task is not None and task.get("task_id") == task_a_id,
              f"task_id={task.get('task_id') if task else None!r} "
              f"expected={task_a_id!r}")
        check("Q1g turn2 task shell total still 20",
              task is not None
              and task.get("by_tool", {}).get(SHELL) == 20,
              f"task={task}")
        # Turn 3: "Yes, continue from 21" on a FRESH agent. Resumes
        # the echo task and spends 20 more to the 40 cap.
        agent = rebuild_agent(agent, "r3")
        gate.reset_turn()
        blocks3 = [tool_block(SHELL) for _ in range(20)]
        begin_turn(agent, "r3", "Yes, continue from 21", blocks3)
        task = task_of(agent)
        check("Q1h turn3 'Yes, continue from 21' resumes SAME task",
              task is not None and task.get("task_id") == task_a_id,
              f"task_id={task.get('task_id') if task else None!r} "
              f"expected={task_a_id!r}")
        res = await gate.check({"iteration": 0, "agent": agent})
        check("Q1i turn3 gate TERMINATEs",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks3)
        check("Q1j turn3 20 more shell execute",
              executed == 20, f"executed={executed}")
        check("Q1k turn3 0 refused (the model only sent 20)",
              refused == 0, f"refused={refused}")
        task = task_of(agent)
        check("Q1l task shell total == 40 (the cap) after turn3",
              task is not None
              and task.get("by_tool", {}).get(SHELL) == 40,
              f"task={task}")
        check("Q1m task is finalised at the cap after turn3",
              task is not None and task.get("finalized") is True,
              f"task={task}")
        # Turn 4: "continue" on a FRESH agent; the finalised task
        # must refuse all.
        agent = rebuild_agent(agent, "r4")
        gate.reset_turn()
        blocks4 = [tool_block(SHELL) for _ in range(20)]
        begin_turn(agent, "r4", "continue", blocks4)
        res = await gate.check({"iteration": 0, "agent": agent})
        check("Q1n turn4 gate TERMINATEs (finalised task)",
              res.action == StopAction.TERMINATE, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks4)
        check("Q1o turn4 0 execute",
              executed == 0, f"executed={executed}")
        check("Q1p turn4 20 refused",
              refused == 20, f"refused={refused}")

        # Q2: the continuation matcher itself (prefix + word
        # boundary). Direct unit checks on _is_continuation.
        is_cont = getattr(limits_mod, "_is_continuation", None)
        if is_cont is None:
            check("Q2a _is_continuation exists",
                  False, "missing (no task-cap code)")
        else:
            check("Q2a 'hello, are you working?' is a continuation",
                  is_cont("hello, are you working?") is True)
            check("Q2b 'Yes, continue from 21' is a continuation",
                  is_cont("Yes, continue from 21") is True)
            check("Q2c 'continue from 21' is a continuation",
                  is_cont("continue from 21") is True)
            check("Q2d 'please continue' is a continuation",
                  is_cont("please continue") is True)
            check("Q2e 'go on with it' is a continuation",
                  is_cont("go on with it") is True)
            check("Q2f 'yesterday I was working' is NOT a continuation",
                  is_cont("yesterday I was working on this") is False)
            check("Q2g 'history of the loop gate' is NOT a continuation",
                  is_cont("history of the loop gate") is False)
            check("Q2h 'surely you can do better' is NOT a continuation",
                  is_cont("surely you can do better") is False)
            check("Q2i 'thanksgiving dinner' is NOT a continuation",
                  is_cont("thanksgiving dinner") is False)
            check("Q2j 'please print the numbers' is NOT a continuation",
                  is_cont("Please print the numbers from 1 to 200") is False)

        # Q3: a genuinely new instruction after finalisation still
        # mints a fresh task with a fresh budget (the fix must not
        # collapse every message into the old task). The new task is
        # resolved by gate.check, so the identity is read after it.
        agent = rebuild_agent(agent, "r5")
        gate.reset_turn()
        blocks5 = [tool_block(SHELL) for _ in range(5)]
        begin_turn(agent, "r5",
                   "What is 2 + 2? Please use a shell echo.", blocks5)
        res = await gate.check({"iteration": 0, "agent": agent})
        task = task_of(agent)
        check("Q3a new instruction mints a DIFFERENT task",
              task is not None and task.get("task_id") != task_a_id,
              f"task_id={task.get('task_id') if task else None!r}")
        check("Q3b new instruction does NOT fire (5 < 30)",
              res.action == StopAction.BYPASS, f"action={res.action}")
        executed, refused = simulate_execute(agent, blocks5)
        check("Q3c new instruction 5 shell execute",
              executed == 5, f"executed={executed}")
        task = task_of(agent)
        check("Q3d new task is not finalised",
              task is not None and task.get("finalized") is False,
              f"task={task}")

    asyncio.run(run_all())
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limits", default=str(PATCHED / "limits.py"),
                    help="limits.py to test (default: patched)")
    ap.add_argument("--section", default=None,
                    help="run only one section (e.g. P for T140)")
    args = ap.parse_args()
    limits_path = Path(args.limits)
    if not limits_path.exists():
        print(f"limits.py not found: {limits_path}")
        return 2
    print(f"Testing task cap from: {limits_path}")
    limits_mod = load_gate_module(limits_path)
    results = run_tests(limits_mod, section=args.section)
    n_pass = sum(1 for r in results if r[1])
    n_fail = len(results) - n_pass
    print(f"\n{n_pass} passed, {n_fail} failed")
    if n_fail:
        print("FAILED: " + ", ".join(r[0] for r in results if not r[1]))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
