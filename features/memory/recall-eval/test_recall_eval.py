#!/usr/bin/env python3
"""Tests for the memory-recall eval (provisional T137, gap #19 recall half).

Provisional T-number T137 — see features/memory/recall-eval/README.md.
Run: python3 features/memory/recall-eval/test_recall_eval.py
Exit 0 = all pass. Prints "N passed, M failed" as the last line.

What this proves, against the real facts.py memory v2 retriever
(stdlib only, temp scratch DBs — never the live memory.db):

RECALL HALF (deterministic, no judge — the Layer-1 baseline):
  (a) a seeded fact surfaces in top-k for its query (hit@1/3, MRR,
      candidate-pool hit — the pool check separates an FTS MATCH
      failure from an RRF mis-ranking);
  (b) its rank is reported per query, and the run is deterministic
      (same ordering on a second run);
  (c) a stale/superseded fact does not outrank the current one
      (absent by default, present via --as-of inside its window,
      absent outside it);
  (d) a query with no matching fact returns empty (no hallucinated
      hit), including the paraphrase canary that documents the
      AND-vocabulary limitation of FTS MATCH;
  (e) the eval itself is sensitive: it reports FAIL on a store with
      a target fact removed (a harness that cannot fail is a rumour);
  (f) the recall cases added to features/infra/evals/cases.json
      exist and run-evals.py --dry-run lists them.

INTEGRITY HALF (staged, NOT graded — pending the gap #5 LLM judge):
  (g) the contradiction + tool-failure fixtures exist, are all
      marked grade=judge-only, and pin the rubric;
  (h) the judge-call wiring fails closed: judge absent -> verdict
      "skip", status "pending-judge" — even for a reply that a
      substring check would PASS (the substring trap). A stub judge
      proves the wiring calls through when one exists, and that a
      raising or malformed judge also degrades to skip, never pass.

Fail-first proven: the first run failed with ModuleNotFoundError
(no recall_eval.py yet). The pristine tree has no eval module, no
fixtures, and no judge — so every section above fails there.

NOT verified here: anything live. The machine is suspended; no
deploy, no browser check, no live console run of the cases.json
recall cases (those need the fixtures seeded on the machine first).
"""
# T137, 64 checks. The runner parses the printed tally, not this line.

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
EVALS_DIR = REPO / "features" / "infra" / "evals"

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import facts as F  # noqa: E402
import recall_eval as RE  # noqa: E402
import judge_wiring as JW  # noqa: E402

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


def fresh_db() -> tuple[object, Path]:
    tmp = Path(tempfile.mkdtemp())
    path = tmp / "memory.db"
    return F.open_db(path), path


def seeded_conn():
    conn, _path = fresh_db()
    fixtures = RE.load_json(HERE / "fixtures.json")
    seeded = RE.seed_fixtures(conn, fixtures)
    queries = RE.load_json(HERE / "queries.json")
    return conn, fixtures, queries, seeded


# ------------------------------------------------------------ A. files load

def test_files_load() -> None:
    fixtures = RE.load_json(HERE / "fixtures.json")
    check("fixtures.json loads with 12 facts",
          len(fixtures["facts"]) == 12, str(len(fixtures.get("facts", []))))
    queries = RE.load_json(HERE / "queries.json")
    recall_qs = [q for q in queries["queries"] if "expected_text" in q]
    abstain_qs = [q for q in queries["queries"] if q.get("expected") == "none"]
    check("queries.json loads with 6 recall queries",
          len(recall_qs) == 6, str(len(recall_qs)))
    check("queries.json loads with 2 abstention queries",
          len(abstain_qs) == 2, str(len(abstain_qs)))
    integrity = RE.load_json(HERE / "integrity_fixtures.json")
    check("integrity_fixtures.json loads with 4 cases",
          len(integrity["cases"]) == 4, str(len(integrity.get("cases", []))))


# ------------------------------------------------------------ B. seeding

def test_seeding() -> None:
    conn, fixtures, _queries, seeded = seeded_conn()
    info = F.check_db(conn)
    check("seeded scratch DB holds 12 facts",
          info["facts"] == 12, str(info))
    old_id = seeded["ids"]["keepalive-old"]
    row = conn.execute(
        "SELECT superseded_by FROM facts WHERE id=?", (old_id,)).fetchone()
    check("superseded old fact carries superseded_by",
          row is not None and row["superseded_by"] is not None, str(row))
    check("new fact exists in the seeded store",
          seeded["ids"]["keepalive-new"] in
          {r["id"] for r in conn.execute("SELECT id FROM facts")})


# ------------------------------------------------------------ C+D. recall

def test_recall() -> None:
    conn, _fixtures, queries, _seeded = seeded_conn()
    report = RE.run_eval(conn, queries, limit=5)
    per = {r["id"]: r for r in report["per_query"]}
    recall_ids = [q["id"] for q in queries["queries"] if "expected_text" in q]
    for qid in recall_ids:
        r = per[qid]
        check(f"{qid}: target in top-3 (rank {r['rank']})",
              r["rank"] is not None and r["rank"] <= 3, str(r))
        check(f"{qid}: target in the candidate pool",
              r["pool_hit"] is True, str(r))
    agg = report["aggregate"]
    check("hit@1 >= 0.8 (5/6 measured; Q1 misses, see README)",
          agg["hit_at_1"] >= 0.8, str(agg))
    check("hit@3 == 1.0", agg["hit_at_3"] == 1.0, str(agg))
    check("MRR >= 0.9", agg["mrr"] >= 0.9, str(agg))
    check("false-top rate <= 1/6 (only the Q1 distractor wins)",
          agg["false_top_rate"] <= 1 / 6 + 1e-9, str(agg))
    check("candidate-pool hit rate == 1.0",
          agg["pool_hit_rate"] == 1.0, str(agg))
    check("hit@5 is reported (informational, not thresholded)",
          "hit_at_5" in agg, str(agg))
    check("eval verdict is pass on the good store",
          report["verdict"] == "pass", str(report["verdict"]))
    return report


def test_determinism() -> None:
    conn, _fixtures, queries, _seeded = seeded_conn()
    first = RE.run_eval(conn, queries, limit=5)
    second = RE.run_eval(conn, queries, limit=5)
    same = all(
        a["result_ids"] == b["result_ids"]
        for a, b in zip(first["per_query"], second["per_query"]))
    check("second run returns identical ordering for every query", same)


# ------------------------------------------------------------ F. staleness

def test_staleness() -> None:
    conn, _fixtures, _queries, seeded = seeded_conn()
    old_text = "The keep-alive Worker pings every 10 minutes."
    new_text = "The keep-alive Worker pings every 5 minutes."
    q = "keep-alive Worker pings every minutes"
    res = RE.run_staleness(conn, old_text, new_text, q)
    check("stale fact absent from default search",
          res["default_old_absent"] is True, str(res))
    check("current fact rank 1 in default search",
          res["default_new_rank"] == 1, str(res))
    check("as-of inside old window returns the old fact",
          res["asof_old_returns_old"] is True, str(res))
    check("as-of inside old window does NOT return the new fact",
          res["asof_old_returns_new"] is False, str(res))
    check("as-of after supersession returns the new fact",
          res["asof_new_returns_new"] is True, str(res))
    check("as-of after supersession does NOT return the old fact",
          res["asof_new_returns_old"] is False, str(res))
    check("as-of before the old window returns neither fact",
          res["asof_early_returns_neither"] is True, str(res))
    _ = seeded


# ------------------------------------------------------------ G+H. no-hit + budget

def test_no_hit_and_budget() -> None:
    conn, _fixtures, queries, _seeded = seeded_conn()
    report = RE.run_eval(conn, queries, limit=5)
    abstain = {r["id"]: r for r in report["abstention"]}
    check("nonsense query returns exactly 0 results",
          abstain["nohit-quantum"]["n_results"] == 0, str(abstain))
    check("paraphrase canary returns exactly 0 results (AND-vocabulary limit)",
          abstain["paraphrase-budget"]["n_results"] == 0, str(abstain))
    check("empty query raises FactError (never a hallucinated hit)",
          _raises(lambda: F.search_facts(conn, "   ", limit=5)))
    small = F.search_facts(
        conn, "loop gate budget per task", limit=5, budget_tokens=1)
    check("tiny token budget truncates instead of returning a maimed set",
          small["truncated_by_budget"] is True, str(small))
    check("tiny token budget still returns the first result whole",
          len(small["results"]) == 1, str(len(small["results"])))


def _raises(fn) -> bool:
    try:
        fn()
    except Exception:
        return True
    return False


# ------------------------------------------------------------ I. sensitivity

def test_sensitivity() -> None:
    conn, fixtures, queries, seeded = seeded_conn()
    target_id = seeded["ids"]["loop-gate-budget"]
    conn.execute("DELETE FROM facts WHERE id=?", (target_id,))
    conn.commit()
    report = RE.run_eval(conn, queries, limit=5)
    check("eval reports FAIL when a target fact is removed",
          report["verdict"] == "fail", str(report["verdict"]))
    check("degraded hit@3 drops below 1.0 (5/6)",
          report["aggregate"]["hit_at_3"] == 5 / 6,
          str(report["aggregate"]))
    _ = fixtures


# ------------------------------------------------------------ J. CLI

def test_cli() -> None:
    tmp = Path(tempfile.mkdtemp())
    db = tmp / "memory.db"
    proc = subprocess.run(
        [sys.executable, str(HERE / "recall_eval.py"), "--check",
         "--db", str(db), "--fixtures", str(HERE / "fixtures.json"),
         "--queries", str(HERE / "queries.json"), "--json"],
        capture_output=True, text=True, timeout=120)
    check("recall_eval.py --check exits 0 on the good store",
          proc.returncode == 0, proc.stdout[-300:] + proc.stderr[-300:])
    try:
        out = json.loads(proc.stdout)
        check("--check --json output parses and reports hit@3 == 1.0",
              out["aggregate"]["hit_at_3"] == 1.0, proc.stdout[-300:])
    except (json.JSONDecodeError, KeyError):
        check("--check --json output parses and reports hit@3 == 1.0",
              False, proc.stdout[-300:])


# ------------------------------------------------------------ K. cases.json

def test_cases_json() -> None:
    suite = json.loads((EVALS_DIR / "cases.json").read_text(encoding="utf-8"))
    cases = {c["id"]: c for c in suite["cases"]}
    for cid in ("recall-loop-gate", "recall-keepalive", "recall-daily-summary"):
        check(f"cases.json has live recall case {cid}", cid in cases)
    pointed = all(
        cases[cid].get("recall_eval") == cid
        for cid in ("recall-loop-gate", "recall-keepalive",
                    "recall-daily-summary"))
    check("live recall cases point back at the offline eval id",
          pointed)
    proc = subprocess.run(
        [sys.executable, str(EVALS_DIR / "run-evals.py"), "--dry-run"],
        capture_output=True, text=True, timeout=120)
    check("run-evals.py --dry-run exits 0 with the new cases",
          proc.returncode == 0, proc.stderr[-300:])
    listed = all(cid in proc.stdout for cid in
                 ("recall-loop-gate", "recall-keepalive", "recall-daily-summary"))
    check("dry-run lists all three recall cases", listed, proc.stdout[-500:])


# ------------------------------------------------------------ L. integrity fixtures

def test_integrity_fixtures() -> None:
    data = RE.load_json(HERE / "integrity_fixtures.json")
    kinds = [c["kind"] for c in data["cases"]]
    check("integrity fixtures: 2 contradiction + 2 tool-failure cases",
          kinds.count("contradiction") == 2 and kinds.count("tool-failure") == 2,
          str(kinds))
    check("every integrity case is grading=judge (never substring)",
          all(c.get("grading") == "judge" for c in data["cases"]))
    check("every integrity case pins the rubric",
          all(c.get("rubric") == "features/infra/evals/rubrics/v1.md"
              for c in data["cases"]))
    check("every integrity case states its expected behaviour",
          all(c.get("expected_behaviour") for c in data["cases"]))


# ------------------------------------------------------------ M. judge wiring

def _trap_reply() -> str:
    # A reply a substring check would PASS ("5 minutes" is present) —
    # the wiring must still return skip while no judge exists.
    return ("The keep-alive Worker pings every 5 minutes. "
            "It also used to ping every 10 minutes.")


def _write_fake_judge(tmp: Path, body: str) -> Path:
    path = tmp / "judge.py"
    path.write_text(body, encoding="utf-8")
    return tmp


def test_judge_wiring() -> None:
    case = RE.load_json(HERE / "integrity_fixtures.json")["cases"][0]
    empty = Path(tempfile.mkdtemp())
    check("find_judge raises JudgeUnavailable when judge.py is absent",
          _raises(lambda: JW.find_judge(empty)))
    graded = JW.grade_with_judge(case, _trap_reply(), evals_dir=empty)
    check("grade with no judge returns skip, never pass",
          graded["verdict"] == "skip", str(graded))
    check("grade with no judge reports status pending-judge",
          graded["status"] == "pending-judge", str(graded))
    check("substring-trap reply still skips (no substring fallback)",
          graded["verdict"] != "pass", str(graded))

    tmp = Path(tempfile.mkdtemp())
    _write_fake_judge(tmp,
                      "def grade_case(case, reply):\n"
                      "    return {'verdict': 'pass', 'pass': True,"
                      " 'qualified': True, 'reason': 'current fact used',"
                      " 'evidence': '5 minutes'}\n")
    graded = JW.grade_with_judge(case, _trap_reply(), evals_dir=tmp)
    check("stub grade_case returning pass is honoured (status judged)",
          graded["verdict"] == "pass" and graded["status"] == "judged",
          str(graded))

    tmp2 = Path(tempfile.mkdtemp())
    _write_fake_judge(tmp2,
                      "def grade_case(case, reply):\n"
                      "    return {'verdict': 'fail', 'pass': False,"
                      " 'qualified': True, 'reason': 'old value as current',"
                      " 'evidence': '10 minutes'}\n")
    graded = JW.grade_with_judge(case, _trap_reply(), evals_dir=tmp2)
    check("stub grade_case returning fail is honoured",
          graded["verdict"] == "fail" and graded["status"] == "judged",
          str(graded))

    tmp_unq = Path(tempfile.mkdtemp())
    _write_fake_judge(tmp_unq,
                      "def grade_case(case, reply):\n"
                      "    return {'verdict': 'unqualified', 'pass': False,"
                      " 'qualified': False,"
                      " 'reason': 'judge error: no transport'}\n")
    graded = JW.grade_with_judge(case, _trap_reply(), evals_dir=tmp_unq)
    check("unqualified judge maps to skip, NOT fail (pass=False is a trap)",
          graded["verdict"] == "skip"
          and graded["status"] == "pending-judge", str(graded))

    tmp_jr = Path(tempfile.mkdtemp())
    _write_fake_judge(tmp_jr,
                      "def load_rubric(path=None):\n"
                      "    return ('rubric text', 'v1', 'sha')\n"
                      "def judge_reply(reply, rubric, task, case_id=None):\n"
                      "    assert rubric == 'rubric text', rubric\n"
                      "    assert 'keep-alive' in task, task\n"
                      "    return {'pass': True, 'qualified': True,"
                      " 'reason': 'current fact used',"
                      " 'evidence': '5 minutes'}\n")
    graded = JW.grade_with_judge(case, _trap_reply(), evals_dir=tmp_jr)
    check("judge_reply fallback is called with rubric text + task",
          graded["verdict"] == "pass" and graded["status"] == "judged",
          str(graded))

    tmp3 = Path(tempfile.mkdtemp())
    _write_fake_judge(tmp3,
                      "def grade_case(case, reply):\n"
                      "    raise RuntimeError('judge unavailable')\n")
    graded = JW.grade_with_judge(case, _trap_reply(), evals_dir=tmp3)
    check("raising judge degrades to skip, never pass",
          graded["verdict"] == "skip", str(graded))

    tmp4 = Path(tempfile.mkdtemp())
    _write_fake_judge(tmp4,
                      "def grade_case(case, reply):\n"
                      "    return {'note': 'no verdict key'}\n")
    graded = JW.grade_with_judge(case, _trap_reply(), evals_dir=tmp4)
    check("malformed judge result degrades to skip, never pass",
          graded["verdict"] == "skip", str(graded))

    tmp5 = Path(tempfile.mkdtemp())
    reply_file = tmp5 / "reply.txt"
    reply_file.write_text(_trap_reply(), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(HERE / "recall_eval.py"), "--grade-integrity",
         "--case-id", "integrity-contradiction-keepalive",
         "--reply-file", str(reply_file),
         "--integrity-fixtures", str(HERE / "integrity_fixtures.json"),
         "--evals-dir", str(empty)],
        capture_output=True, text=True, timeout=120)
    check("CLI --grade-integrity without a judge exits 3 (pending-judge)",
          proc.returncode == 3, f"rc={proc.returncode} {proc.stdout[-200:]}")


def main() -> int:
    test_files_load()
    test_seeding()
    test_recall()
    test_determinism()
    test_staleness()
    test_no_hit_and_budget()
    test_sensitivity()
    test_cli()
    test_cases_json()
    test_integrity_fixtures()
    test_judge_wiring()
    print(f"\n{PASS} passed, {len(FAIL)} failed")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    raise SystemExit(main())
