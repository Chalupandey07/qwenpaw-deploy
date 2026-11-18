#!/usr/bin/env python3
"""Machine-free tests for plan mode (T122).

Proves the enforcement is in code (:class:`ToolGate` /
:class:`PlanMode` in plan_mode.py), not in a prompt:

(a) in plan mode a read-only call is allowed;
(b) a mutating call (write / edit / delete / shell-write / git commit /
    deploy / curl POST / unknown tool / git_diff --output / web_fetch
    POST) is REFUSED by the enforcer, with the blocked tool named in
    the denial; an approved step id cannot be reused for a different
    tool or a different shell command;
(c) a plan file is written with the required sections (steps, files,
    commands, expected diff, risks) and validates; duplicate step ids
    fail validation; two plans in the same second get distinct paths;
(d) execution does not start before approval;
(e) after approval the plan's steps — and only the plan's steps, in
    order, at most once — are executed (no silent extra steps, no
    replays); a corrupt state file loads as planning (fail closed).

Fail-first: run with ``--gate permissive`` to swap in the no-enforcer
stand-in (what "plan mode" is when it is only a prompt: nothing is ever
refused, execution starts without approval). The same assertions must
FAIL there:

    python3 test_plan_mode.py --selftest --gate permissive   # must FAIL
    python3 test_plan_mode.py --selftest                     # must PASS

Everything runs against a temporary plans directory; no repo file, no
machine, and no network is touched. Stdlib only.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from plan_mode import (  # noqa: E402
    Decision, Plan, PlanInvalid, PlanMode, PlanModeDenied, PlanNotApproved,
    PlanStep, ToolGate, parse_plan_steps, validate_plan,
)

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def refused(pm, tool, args=None, step_id=None) -> tuple[bool, str]:
    """True + the denial text if the gate refuses this call."""
    try:
        pm.enforce(tool, args or {}, step_id=step_id)
    except PlanModeDenied as exc:
        return True, str(exc)
    return False, "call was allowed"


class NullGate(ToolGate):
    """Stand-in for 'no enforcer': a prompt-only plan mode. Allows
    everything, so every refusal assertion fails against it. Used only
    by the --gate permissive fail-first run."""

    def check(self, tool, args=None, *, mode="planning",
              step_id=None, approved_steps=None):
        return Decision(True, tool, "no enforcer — prompt only, nothing refused")


class NoEnforcementPlanMode(PlanMode):
    """PlanMode with no enforcement at all: enforce() never refuses and
    execute() never waits for approval. This is what a prompt-only
    'plan mode' behaves like — the fail-first control."""

    def __init__(self, plans_dir):
        super().__init__(plans_dir, gate=NullGate())

    def execute(self, plan_path, runner):
        steps = parse_plan_steps(Path(plan_path).read_text(encoding="utf-8"))
        executed = []
        for step in steps:
            runner(step)
            executed.append(step.id)
        return executed


def sample_plan() -> Plan:
    return Plan(
        task="Add a /status page to the console",
        steps=[
            PlanStep(id="step-1", tool="write_file",
                     description="Create the status page template"),
            PlanStep(id="step-2", tool="edit_file",
                     description="Wire the status route into the router"),
            PlanStep(id="step-3", tool="bash",
                     description="Run the machine-free suite subset",
                     command="python3 features/test-project/run-tests.py --only T122"),
        ],
        files=[
            "pages/public/status.html (create)",
            "pages/public/_worker.js (edit — add /status route)",
        ],
        commands=[
            "python3 features/test-project/run-tests.py --only T122",
        ],
        diff=("One new static page plus ~10 lines in _worker.js routing "
              "/status to it; no existing route changes."),
        risks=[
            "A wrong route pattern could shadow /desktop — keep /status exact.",
            "The suite subset takes minutes on the Free box; run it once.",
        ],
    )


def run_suite(pm_factory) -> int:
    """Run every check against a PlanMode built by pm_factory(tmpdir).
    Returns the number of failed checks."""
    with tempfile.TemporaryDirectory() as tmp:
        plans_dir = Path(tmp) / "plans"
        pm = pm_factory(plans_dir)

        # --- (a) read-only calls are allowed in plan mode ---------------
        pm.enter("Add a /status page to the console")
        check("A1 read_file allowed in plan mode",
              pm.check("read_file").allowed)
        check("A2 list_dir allowed in plan mode",
              pm.check("list_dir").allowed)
        check("A3 grep allowed in plan mode",
              pm.check("grep", {"pattern": "status"}).allowed)
        check("A4 web_search allowed in plan mode",
              pm.check("web_search", {"query": "opencode plan agent"}).allowed)
        check("A5 bash 'ls -la' allowed (read-only shell)",
              pm.check("bash", {"command": "ls -la"}).allowed)
        check("A6 bash 'git status' allowed (read-only shell)",
              pm.check("bash", {"command": "git status"}).allowed)
        check("A7 bash 'cat f | grep x' allowed (read-only pipeline)",
              pm.check("bash", {"command": "cat README.md | grep -i plan"}).allowed)

        # --- (b) mutating calls are REFUSED, tool named -----------------
        for name, tool, args in [
            ("B1 write_file refused, tool named", "write_file", {}),
            ("B2 edit_file refused, tool named", "edit_file", {}),
            ("B3 delete_file refused, tool named", "delete_file", {}),
            ("B4 git_commit refused, tool named", "git_commit", {}),
            ("B5 deploy refused, tool named", "deploy", {}),
            ("B6 bash 'echo hi > out.txt' refused, tool named",
             "bash", {"command": "echo hi > out.txt"}),
            ("B7 bash 'rm -rf x' refused, tool named",
             "bash", {"command": "rm -rf x"}),
            ("B8 bash 'git push' refused, tool named",
             "bash", {"command": "git push origin main"}),
            ("B9 bash 'curl -X POST' refused, tool named",
             "bash", {"command": "curl -X POST https://example.com/hook --data '{}'"}),
            ("B10 unknown tool refused (deny-by-default)",
             "teleport_files", {}),
        ]:
            ok, denial = refused(pm, tool, args)
            check(name, ok and tool in denial, denial)
        # Read-only tools can smuggle writes through their arguments.
        ok, denial = refused(pm, "git_diff", {"args": "--output=/tmp/out.diff"})
        check("B11 git_diff --output refused (read-only tool, writing arg)",
              ok and "git_diff" in denial, denial)
        ok, denial = refused(pm, "web_fetch", {"method": "POST", "body": "{}"})
        check("B12 web_fetch POST refused (read-only tool, write method)",
              ok and "web_fetch" in denial, denial)

        # --- (c) the plan file ------------------------------------------
        plan_path = pm.write_plan(sample_plan())
        check("C1 plan file written under plans/<timestamp>.md",
              plan_path.exists() and plan_path.parent == plans_dir
              and plan_path.name.endswith("Z.md"), str(plan_path))
        text = plan_path.read_text(encoding="utf-8")
        check("C2 plan has ## Steps with numbered steps",
              "## Steps" in text and "[step-1]" in text and "[step-3]" in text)
        check("C3 plan has ## Files to touch",
              "## Files to touch" in text and "status.html" in text)
        check("C4 plan has ## Commands to run",
              "## Commands to run" in text and "run-tests.py" in text)
        check("C5 plan has ## Expected diff",
              "## Expected diff" in text and "10 lines" in text)
        check("C6 plan has ## Risks",
              "## Risks" in text and "shadow /desktop" in text)
        ok, missing = validate_plan(plan_path)
        check("C7 written plan validates", ok, ", ".join(missing))
        broken = plans_dir / "broken.md"
        broken.write_text("# Plan: broken\n\n## Steps\n\n1. [step-1] (tool: write_file) Do it\n",
                          encoding="utf-8")
        ok, missing = validate_plan(broken)
        check("C8 plan missing ## Risks fails validation",
              not ok and "## Risks" in missing, ", ".join(missing))
        dup = plans_dir / "dup.md"
        dup.write_text(
            "# Plan: dup\n\n## Steps\n\n"
            "1. [step-1] (tool: write_file) Do it\n"
            "2. [step-1] (tool: edit_file) Do it again\n\n"
            "## Files to touch\n\n- x\n\n## Commands to run\n\n- `ls`\n\n"
            "## Expected diff\n\nx\n\n## Risks\n\n- y\n",
            encoding="utf-8")
        ok, missing = validate_plan(dup)
        check("C9 plan with a duplicate step id fails validation",
              not ok and "duplicate step id: step-1" in missing, ", ".join(missing))
        second_path = pm.write_plan(sample_plan())
        check("C10 two plans in the same second get distinct paths",
              second_path != plan_path and second_path.exists(),
              f"{plan_path} vs {second_path}")
        plan_path = second_path  # the live plan from here on

        # --- (d) no execution before approval ---------------------------
        ran: list[str] = []

        def runner(step: PlanStep) -> None:
            ran.append(step.id)

        try:
            pm.execute(plan_path, runner)
            executed_before_approval = True
        except PlanNotApproved:
            executed_before_approval = False
        check("D1 execution before approval is refused",
              not executed_before_approval and ran == [],
              f"ran={ran}")

        # --- (e) after approval, only the plan's steps run --------------
        steps = pm.approve(plan_path)
        check("E1 approve() accepts the valid plan (3 steps)",
              len(steps) == 3 and [s.id for s in steps] == ["step-1", "step-2", "step-3"])
        check("E2 plan file now says Status: approved",
              "Status: approved" in plan_path.read_text(encoding="utf-8"))
        ok, _ = refused(pm, "write_file", {}, step_id="step-1")
        check("E3 mutating call with an approved step id is allowed",
              not ok, "approved step-1 write_file was refused")
        ok, denial = refused(pm, "write_file", {}, step_id="step-9")
        check("E4 mutating call with a step NOT in the plan is refused",
              ok and "step-9" in denial, denial)
        ok, denial = refused(pm, "write_file", {})
        check("E5 mutating call with no step id is refused after approval",
              ok, denial)
        # An approved step id cannot be reused for a different tool or
        # a different shell command (DeepSeek review finding 3).
        ok, denial = refused(pm, "delete_file", {}, step_id="step-1")
        check("E10 approved step id + WRONG tool is refused (no id reuse)",
              ok and "step-1" in denial and "write_file" in denial, denial)
        ok, denial = refused(pm, "bash", {"command": "ls -la"}, step_id="step-3")
        check("E11 approved bash step + DIFFERENT command is refused",
              ok and "step-3" in denial, denial)
        executed = pm.execute(plan_path, runner)
        check("E6 execute() runs exactly the plan's steps, in order",
              executed == ["step-1", "step-2", "step-3"] and ran == executed,
              f"executed={executed} ran={ran}")
        try:
            pm.execute(plan_path, runner)
            reran = True
        except PlanInvalid:
            reran = False
        check("E12 a plan executes at most once (second execute refused)",
              not reran and ran == ["step-1", "step-2", "step-3"],
              f"ran={ran}")
        extra = PlanStep(id="step-9", tool="delete_file",
                         description="Delete a file nobody approved")
        try:
            pm.execute_extra(extra, runner)
            extra_ran = True
        except PlanModeDenied:
            extra_ran = False
        check("E7 an extra step outside the plan is refused (no silent extras)",
              not extra_ran and "step-9" not in ran, f"ran={ran}")
        pm.exit()
        check("E8 exit() returns the gate to off — write allowed again",
              pm.check("write_file").allowed)
        pm2 = pm_factory(plans_dir)
        pm2.enter("Second task")
        try:
            pm2.write_plan(sample_plan())
            wrote_while_planning = True
        except PlanModeDenied:
            wrote_while_planning = False
        pm2.exit()
        try:
            pm2.write_plan(sample_plan())
            wrote_after_exit = True
        except PlanModeDenied:
            wrote_after_exit = False
        check("E9 write_plan works in planning mode but not after exit",
              wrote_while_planning and not wrote_after_exit,
              f"planning={wrote_while_planning} after-exit={wrote_after_exit}")
        (plans_dir / ".plan-mode-state.json").write_text("{not json", encoding="utf-8")
        pm_corrupt = PlanMode.load_state(plans_dir)
        check("E13 corrupt state file loads as planning (fail closed, not off)",
              pm_corrupt.mode == "planning" and not pm_corrupt.approved_steps,
              f"mode={pm_corrupt.mode}")

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    return failed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true",
                        help="run the suite (same as no flags)")
    parser.add_argument("--gate", choices=["enforcer", "permissive"],
                        default="enforcer",
                        help="enforcer: the real ToolGate (must PASS); "
                             "permissive: no-enforcer stand-in (must FAIL)")
    args = parser.parse_args()
    if args.gate == "permissive":
        print("gate: permissive (no enforcer — prompt-only plan mode)")
        factory = NoEnforcementPlanMode
    else:
        print("gate: enforcer (plan_mode.ToolGate)")
        factory = PlanMode
    failed = run_suite(factory)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
