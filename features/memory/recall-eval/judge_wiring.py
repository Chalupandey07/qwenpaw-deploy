#!/usr/bin/env python3
"""judge_wiring.py — call the gap #5 LLM judge for integrity cases.

Contract (the real judge API, features/infra/evals/judge.py,
provisional T136 — read from the sibling's module, not assumed):
  - The judge lives at <evals-dir>/judge.py.
  - Preferred entry point: grade_case(case, reply) — it takes the
    case dict (prompt/task + rubric), refuses legacy expect_contains
    / must_not_contain cases by raising ValueError, loads the rubric
    itself, and returns {"verdict": "pass"|"fail"|"unqualified",
    "pass": bool, "qualified": bool, "reason": str, "evidence": str,
    ...}. Our integrity cases carry "grading": "judge" and a "rubric"
    path and no substring fields, so grade_case accepts them.
  - Fallback entry point: judge_reply(reply, rubric, task, *,
    case_id=None) — rubric is the rubric TEXT, loaded here via the
    module's load_rubric() when it exists; task is the case prompt.
  - Other accepted names (generic call): grade_reply, judge, grade.
  - "unqualified" (qualified False) is a harness failure, not a case
    failure: the judge errored, timed out, or returned a malformed
    verdict. It maps to skip, never fail and never pass.

Fail-closed, by failure mode — every one of these returns verdict
"skip", status "pending-judge", and NEVER "pass":
  absent:      judge.py does not exist in the evals dir.
  import-error: judge.py exists but cannot be imported.
  no-entry:    no known callable is defined in the module.
  raised:      the judge callable raised (including a timeout raised
               by the judge itself, or a ValueError refusing the case).
  unqualified: the judge returned verdict "unqualified" / qualified
               False (no transport, no creds, judge error, timeout,
               malformed verdict — verified live against the real
               judge: grade_case with no transport returns
               unqualified, pass False).
  malformed:   the judge returned something with no usable verdict.

There is deliberately NO substring fallback: grading prose by
substring is the exact flaw gap #5 exists to fix, and a fallback
would silently reintroduce it. A skip is reported as exit code 3
by the recall_eval.py CLI so no automation can misread it as a
pass (0) or a fail (1).

Stdlib only. No model call happens here — the judge module owns
that (live console transport, credentials from the environment at
call time); this file only finds it, calls it, and normalises the
result. With no transport and no credentials the real judge returns
unqualified, which this file maps to skip — so a grade attempt
today (machine suspended, no creds) is a skip, not a fake pass.
"""
from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_EVALS_DIR = HERE.parents[2] / "features" / "infra" / "evals"

# grade_case first: it takes (case, reply) and owns rubric loading.
ENTRYPOINTS = ("grade_case", "judge_reply", "grade_reply", "judge", "grade")


class JudgeUnavailable(Exception):
    """The judge cannot be used (absent / unimportable / no entry point)."""


def find_judge(evals_dir: str | Path | None = None):
    """Load judge.py and return (module, callable, entrypoint name).

    Raises JudgeUnavailable for absent / import-error / no-entry.
    The module is loaded by path under a probe name so it cannot
    collide with any other judge module already imported.
    """
    directory = Path(evals_dir) if evals_dir else DEFAULT_EVALS_DIR
    path = directory / "judge.py"
    if not path.exists():
        raise JudgeUnavailable(
            f"judge.py not found in {directory} — gap #5 has not landed "
            "yet; integrity grading is pending-judge, not passed.")
    spec = importlib.util.spec_from_file_location(
        "_recall_eval_judge_probe", path)
    if spec is None or spec.loader is None:
        raise JudgeUnavailable(f"cannot load judge module from {path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 - any import failure = unusable
        raise JudgeUnavailable(
            f"judge.py exists but cannot be imported: {exc}") from exc
    for name in ENTRYPOINTS:
        func = getattr(module, name, None)
        if callable(func):
            return module, func, name
    raise JudgeUnavailable(
        f"judge.py defines none of {', '.join(ENTRYPOINTS)} — "
        "no known judge entry point.")


def _rubric_text(module, case: dict) -> str:
    """Rubric text for the judge_reply fallback, via load_rubric()."""
    loader = getattr(module, "load_rubric", None)
    if callable(loader):
        text, _version, _sha = loader()
        return str(text)
    return str(case.get("rubric") or "")


def _call_judge(module, func, name: str, case: dict, reply: str):
    """Call the judge entry point with the arguments it expects."""
    if name == "grade_case":
        return func(case, reply)
    if name == "judge_reply":
        task = case.get("task") or case.get("prompt")
        return func(reply, _rubric_text(module, case), task,
                    case_id=case.get("id"))
    try:
        params = inspect.signature(func).parameters
    except (TypeError, ValueError):
        params = {}
    accepts_kwargs = any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
    kwargs = {}
    for key, value in (("case", case), ("reply", reply),
                       ("rubric", case.get("rubric"))):
        if accepts_kwargs or key in params:
            kwargs[key] = value
    if kwargs:
        try:
            return func(**kwargs)
        except TypeError:
            pass  # fall through to the positional call below
    return func(case, reply)


def _normalise(result) -> dict | None:
    """Map a judge result to verdict/status, or None if malformed.

    "unqualified" (qualified False) is checked FIRST: the real judge
    returns pass=False for unqualified verdicts, so reading the pass
    bool first would misreport a harness failure as a case failure.
    """
    if not isinstance(result, dict):
        return None
    if result.get("verdict") == "unqualified" \
            or result.get("qualified") is False:
        return {
            "verdict": "skip",
            "status": "pending-judge",
            "reason": "judge unqualified: " +
                      str(result.get("reason", "no reason given")),
            "evidence": result.get("evidence", ""),
            "judge_result": result,
        }
    if isinstance(result.get("pass"), bool):
        verdict = "pass" if result["pass"] else "fail"
    elif result.get("verdict") in ("pass", "fail", "skip"):
        verdict = result["verdict"]
    else:
        return None
    return {
        "verdict": verdict,
        "status": "judged" if verdict in ("pass", "fail") else "pending-judge",
        "reason": result.get("reason", ""),
        "evidence": result.get("evidence", ""),
        "judge_result": result,
    }


def grade_with_judge(case: dict, reply: str,
                     evals_dir: str | Path | None = None) -> dict:
    """Grade one integrity case with the LLM judge, fail-closed.

    Returns {"verdict": "pass"|"fail"|"skip",
             "status": "judged"|"pending-judge", "reason": ...}.
    "skip" is the answer whenever the judge is absent, unimportable,
    entry-point-less, raising, unqualified, or malformed. It is never
    a pass.
    """
    try:
        module, func, name = find_judge(evals_dir)
    except JudgeUnavailable as exc:
        return {"verdict": "skip", "status": "pending-judge",
                "reason": str(exc)}
    try:
        result = _call_judge(module, func, name, case, reply)
    except Exception as exc:  # noqa: BLE001 - any judge failure = skip
        return {"verdict": "skip", "status": "pending-judge",
                "reason": f"judge {name} raised: {exc}"}
    normalised = _normalise(result)
    if normalised is None:
        return {"verdict": "skip", "status": "pending-judge",
                "reason": f"judge {name} returned a malformed result "
                          f"(no boolean 'pass' or 'verdict'): {result!r}"}
    return normalised
