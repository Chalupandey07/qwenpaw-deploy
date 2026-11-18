#!/usr/bin/env python3
"""recall_eval.py — memory-recall eval for QwenPaw memory v2 (gap #19).

The Layer-1 baseline: memory v2 recall quality had never been measured.
This is deterministic and needs no judge, no model call, no machine:
it seeds a scratch memory.db from fixtures.json, runs the queries from
queries.json through the real facts.py search_facts, and reports hit
rate, rank, and staleness.

Metrics (per recall query, expected fact = the fixture fact whose text
the query must surface):
  - hit@1 / hit@3 / hit@5: expected fact at rank <= k (hit@5 is
    reported, not thresholded — with 6 queries hit@3 == 1.0 implies it).
  - MRR: mean 1/rank (a miss scores 0; miss rank is reported as limit+1).
  - false_top_rate: fraction of queries where a non-target fact ranks #1.
  - pool_hit_rate: fraction of queries where the expected fact is in
    the candidate pool (the 3x-limit BM25 fetch). This separates an FTS
    MATCH failure (target never fetched) from an RRF mis-ranking
    (target fetched, ranked below the top-k).
  - latency_ms / tokens per query (informational; the token budget is
    asserted separately by the test, not thresholded here).

Thresholds (measured baseline, 2026-11-18 probe — see README;
re-baselined 2026-11-19 after the T137 hyphen fix in facts.py:
hit@1 1.0, false-top 0):
  hit@1 == 1.0, hit@3 == 1.0, MRR >= 0.9, false_top_rate == 0,
  pool_hit_rate == 1.0. n=6, so every threshold moves in 1/6 steps;
  that coarseness is declared, not hidden. The loop-gate query used
  to miss at rank 1 (hyphenated target lost the entity signal to a
  space-spelled distractor); facts.py now normalises hyphens to
  spaces before lexicon matching, and the eval thresholds were
  tightened to the new measured baseline so a regression fails loudly.

Staleness (run_staleness): the superseded fact must be absent from
default search while the current fact ranks #1; --as-of inside the
old validity window returns the old fact, after it returns the new
fact, before it returns neither. The seeder backdates the validity
windows in the SCRATCH database only (fixture valid_from/valid_to),
so time travel is testable without waiting.

Integrity grading (--grade-integrity) does NOT grade by substring.
It delegates to judge_wiring.grade_with_judge, which imports the gap
#5 judge (features/infra/evals/judge.py) when it exists and fails
closed to verdict "skip", status "pending-judge" when it does not.
Exit codes: 0 pass, 1 fail, 3 pending-judge (distinct, so no
automation can misread a skip as a pass).

Stdlib only. Never touches the live memory.db: the default database
is a fresh temp file; --db must be given explicitly to use another
path, and the tool refuses to open a path named like the live store
unless --allow-live-path is passed (the live run is Muse's job, after
seeding is approved).

Usage:
  recall_eval.py --check [--db memory.db] [--json]
  recall_eval.py --seed-only --db memory.db
  recall_eval.py --grade-integrity --case-id <id> --reply-file <file>
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import facts as F  # noqa: E402
import recall as _recall  # noqa: E402
import judge_wiring as JW  # noqa: E402

# Thresholds for the verdict. n=6 recall queries: each step is 1/6.
THRESHOLDS = {
    "hit_at_1": 1.0,
    "hit_at_3": 1.0,
    "mrr": 0.9,
    "false_top_rate_max": 0.0,
    "pool_hit_rate": 1.0,
}

DEFAULT_LIMIT = 5
FETCH_MULTIPLIER = 3  # facts.py fetches 3x the limit for re-ranking

# The live store path (never opened by accident).
LIVE_DB_SUFFIX = "workspaces/default/memory.db"


def load_json(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def seed_fixtures(conn, fixtures: dict) -> dict:
    """Seed a scratch fact store from fixtures.json. Returns {ids, count}.

    Fixture facts may carry "supersedes": <key> (the old fact is
    superseded, never deleted) and "valid_from" / "valid_to" overrides,
    applied by UPDATE to the scratch DB only so --as-of time travel is
    testable with fixed dates.
    """
    ids: dict[str, int] = {}
    for fact in fixtures["facts"]:
        key = fact["key"]
        if "supersedes" in fact:
            old_id = ids[fact["supersedes"]]
            new_id = F.supersede_fact(
                conn, old_id, fact["text"], kind=fact.get("kind", "fact"))
            ids[key] = new_id
        else:
            ids[key] = F.add_fact(
                conn, fact["text"], kind=fact.get("kind", "fact"),
                importance=fact.get("importance", 2))
    for fact in fixtures["facts"]:
        updates = []
        params: list = []
        if fact.get("valid_from") is not None:
            updates.append("valid_from=?")
            params.append(fact["valid_from"])
        if fact.get("valid_to") is not None:
            updates.append("valid_to=?")
            params.append(fact["valid_to"])
        if updates:
            params.append(ids[fact["key"]])
            conn.execute(
                f"UPDATE facts SET {', '.join(updates)} WHERE id=?", params)
    conn.commit()
    return {"ids": ids, "count": len(ids)}


def candidate_pool(conn, query: str, fetch: int = 15) -> list[int]:
    """Fact ids in the BM25 fetch pool, replicating facts.py's fetch.

    Same MATCH expression, same default superseded exclusion, same
    ORDER BY bm25 — but no RRF re-rank, so this answers "was the
    target retrievable at all" before ranking is blamed.
    """
    match = _recall.fts_match_query(query)
    rows = conn.execute(
        "SELECT f.id FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid"
        " WHERE facts_fts MATCH ? AND f.superseded_by IS NULL"
        " ORDER BY bm25(facts_fts) LIMIT ?",
        (match, fetch)).fetchall()
    return [int(r["id"]) for r in rows]


def _rank_of(results: list[dict], expected_text: str) -> int | None:
    for pos, r in enumerate(results, 1):
        if r["text"] == expected_text:
            return pos
    return None


def run_query(conn, query: str, expected_text: str,
              limit: int = DEFAULT_LIMIT) -> dict:
    """One recall query: rank, pool hit, determinism, latency, tokens."""
    t0 = time.perf_counter()
    first = F.search_facts(conn, query, limit=limit)
    latency_ms = round((time.perf_counter() - t0) * 1000, 2)
    second = F.search_facts(conn, query, limit=limit)
    rank = _rank_of(first["results"], expected_text)
    pool = candidate_pool(conn, query, fetch=min(limit * FETCH_MULTIPLIER, 30))
    expected_id = None
    row = conn.execute(
        "SELECT id FROM facts WHERE text=?", (expected_text,)).fetchone()
    if row is not None:
        expected_id = int(row["id"])
    return {
        "query": query,
        "expected_text": expected_text,
        "expected_id": expected_id,
        "rank": rank,
        "miss_rank": limit + 1 if rank is None else rank,
        "in_top_1": rank == 1,
        "in_top_3": rank is not None and rank <= 3,
        "in_top_5": rank is not None and rank <= 5,
        "pool_hit": expected_id is not None and expected_id in pool,
        "false_top": bool(first["results"]) and
        first["results"][0]["text"] != expected_text,
        "deterministic": [r["id"] for r in first["results"]] ==
        [r["id"] for r in second["results"]],
        "n_results": len(first["results"]),
        "result_ids": [r["id"] for r in first["results"]],
        "latency_ms": latency_ms,
        "tokens": first["tokens"],
    }


def run_eval(conn, queries_doc: dict,
             limit: int = DEFAULT_LIMIT) -> dict:
    """Run every query in queries.json; aggregate; verdict vs thresholds."""
    recall_qs = [q for q in queries_doc["queries"] if "expected_text" in q]
    abstain_qs = [q for q in queries_doc["queries"]
                  if q.get("expected") == "none"]
    per_query = [run_query(conn, q["query"], q["expected_text"], limit=limit)
                 | {"id": q["id"]} for q in recall_qs]
    abstention = []
    for q in abstain_qs:
        res = F.search_facts(conn, q["query"], limit=limit)
        abstention.append({
            "id": q["id"], "query": q["query"],
            "kind": q.get("kind", "no-hit"),
            "n_results": len(res["results"]),
            "abstained": len(res["results"]) == 0,
        })
    n = len(per_query)
    agg = {
        "n": n,
        "hit_at_1": sum(1 for r in per_query if r["in_top_1"]) / n if n else 0.0,
        "hit_at_3": sum(1 for r in per_query if r["in_top_3"]) / n if n else 0.0,
        "hit_at_5": sum(1 for r in per_query if r["in_top_5"]) / n if n else 0.0,
        "mrr": sum(1 / r["rank"] if r["rank"] else 0.0
                   for r in per_query) / n if n else 0.0,
        "mean_rank": sum(r["miss_rank"] for r in per_query) / n if n else 0.0,
        "false_top_rate": sum(1 for r in per_query if r["false_top"]) / n
        if n else 0.0,
        "pool_hit_rate": sum(1 for r in per_query if r["pool_hit"]) / n
        if n else 0.0,
        "all_deterministic": all(r["deterministic"] for r in per_query),
        "max_latency_ms": max((r["latency_ms"] for r in per_query), default=0.0),
        "max_tokens": max((r["tokens"] for r in per_query), default=0),
        "abstention_ok": all(a["abstained"] for a in abstention),
    }
    verdict = "pass" if (
        agg["hit_at_1"] >= THRESHOLDS["hit_at_1"]
        and agg["hit_at_3"] >= THRESHOLDS["hit_at_3"]
        and agg["mrr"] >= THRESHOLDS["mrr"]
        and agg["false_top_rate"] <= THRESHOLDS["false_top_rate_max"]
        and agg["pool_hit_rate"] >= THRESHOLDS["pool_hit_rate"]
        and agg["abstention_ok"]
    ) else "fail"
    return {
        "verdict": verdict,
        "thresholds": dict(THRESHOLDS),
        "aggregate": agg,
        "per_query": per_query,
        "abstention": abstention,
    }


def run_staleness(conn, old_text: str, new_text: str, query: str,
                  as_of_old: str = "2026-11-05",
                  as_of_new: str = "2026-11-15",
                  as_of_early: str = "2026-10-01",
                  limit: int = DEFAULT_LIMIT) -> dict:
    """Staleness checks for one superseded pair (see module docstring)."""
    default = F.search_facts(conn, query, limit=limit)
    default_texts = [r["text"] for r in default["results"]]
    asof_old = F.search_facts(conn, query, limit=limit, as_of=as_of_old)
    asof_new = F.search_facts(conn, query, limit=limit, as_of=as_of_new)
    asof_early = F.search_facts(conn, query, limit=limit, as_of=as_of_early)
    return {
        "query": query,
        "default_old_absent": old_text not in default_texts,
        "default_new_rank": _rank_of(default["results"], new_text),
        "asof_old_returns_old":
            old_text in [r["text"] for r in asof_old["results"]],
        "asof_old_returns_new":
            new_text in [r["text"] for r in asof_old["results"]],
        "asof_new_returns_new":
            new_text in [r["text"] for r in asof_new["results"]],
        "asof_new_returns_old":
            old_text in [r["text"] for r in asof_new["results"]],
        "asof_early_returns_neither":
            old_text not in [r["text"] for r in asof_early["results"]]
            and new_text not in [r["text"] for r in asof_early["results"]],
    }


def _open_db_guarded(path: str, allow_live: bool):
    if not allow_live and LIVE_DB_SUFFIX in str(path):
        raise SystemExit(
            "refusing to open the live memory.db — this eval runs on a "
            "scratch database. Pass --allow-live-path only if the "
            "coordinator approved a live seeded run.")
    return F.open_db(path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="recall_eval.py",
        description="Memory-recall eval (gap #19 recall half).")
    ap.add_argument("--db", default=None,
                    help="scratch memory.db path (default: fresh temp file)")
    ap.add_argument("--allow-live-path", action="store_true",
                    help="allow opening the live memory.db path (needs approval)")
    ap.add_argument("--fixtures", default=str(HERE / "fixtures.json"))
    ap.add_argument("--queries", default=str(HERE / "queries.json"))
    ap.add_argument("--integrity-fixtures",
                    default=str(HERE / "integrity_fixtures.json"))
    ap.add_argument("--evals-dir", default=None,
                    help="features/infra/evals dir (judge lookup)")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true",
                    help="seed + run the eval; exit 0 pass, 1 fail")
    ap.add_argument("--seed-only", action="store_true",
                    help="seed the fixtures and print the ids, then stop")
    ap.add_argument("--grade-integrity", action="store_true",
                    help="grade one integrity case with the LLM judge "
                         "(exit 0 pass, 1 fail, 3 pending-judge)")
    ap.add_argument("--case-id", default=None)
    ap.add_argument("--reply-file", default=None)
    args = ap.parse_args(argv)

    if args.grade_integrity:
        if not args.case_id or not args.reply_file:
            print("grade-integrity needs --case-id and --reply-file",
                  file=sys.stderr)
            return 2
        data = load_json(args.integrity_fixtures)
        case = next((c for c in data["cases"] if c["id"] == args.case_id),
                    None)
        if case is None:
            print(f"unknown integrity case: {args.case_id}", file=sys.stderr)
            return 2
        reply = Path(args.reply_file).read_text(encoding="utf-8")
        result = JW.grade_with_judge(
            case, reply,
            evals_dir=Path(args.evals_dir) if args.evals_dir else None)
        print(json.dumps(result, indent=2))
        return {"pass": 0, "fail": 1, "skip": 3}[result["verdict"]]

    if args.db:
        conn = _open_db_guarded(args.db, args.allow_live_path)
    else:
        tmp = Path(tempfile.mkdtemp())
        conn = F.open_db(tmp / "memory.db")
    fixtures = load_json(args.fixtures)
    seeded = seed_fixtures(conn, fixtures)
    if args.seed_only:
        print(json.dumps(seeded, indent=2))
        return 0
    queries = load_json(args.queries)
    report = run_eval(conn, queries, limit=args.limit)
    staleness = run_staleness(
        conn,
        "The keep-alive Worker pings every 10 minutes.",
        "The keep-alive Worker pings every 5 minutes.",
        "keep-alive Worker pings every minutes",
        limit=args.limit)
    report["staleness"] = staleness
    report["seeded"] = seeded["count"]
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        agg = report["aggregate"]
        print(f"recall eval: {report['verdict']} "
              f"(hit@1={agg['hit_at_1']:.3f} hit@3={agg['hit_at_3']:.3f} "
              f"MRR={agg['mrr']:.3f} false-top={agg['false_top_rate']:.3f} "
              f"pool={agg['pool_hit_rate']:.3f})")
        for r in report["per_query"]:
            print(f"  [{r['id']}] rank={r['rank']} "
                  f"pool={'yes' if r['pool_hit'] else 'NO'} "
                  f"{r['latency_ms']}ms {r['tokens']}tok")
        print(f"  staleness: old absent={staleness['default_old_absent']} "
              f"new rank={staleness['default_new_rank']}")
    if args.check:
        return 0 if report["verdict"] == "pass" else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
