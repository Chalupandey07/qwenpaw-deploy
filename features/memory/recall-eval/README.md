# Memory-recall eval (gap #19, provisional T137)

The first measurement of memory v2 recall quality. Before this, the
retriever (facts.py multi-signal search) had tests for its mechanics
(T117/T120) but no measurement of whether the *right fact surfaces*
for a query. This is the Layer-1 baseline: deterministic, no judge,
no model call, no machine.

## Status: two halves, one done

| Half | Status |
|---|---|
| Recall (deterministic) | **DONE** — measured below, test green |
| Integrity (contradiction + tool-failure) | **STAGED, NOT GRADED** — fixtures + judge-call wiring exist and are verified against the landed judge (see below); grading waits on a live judge call (needs console creds + the machine back). Every grade today is verdict `skip`, status `pending-judge`. This half is NOT done and is not claimed as done. |

## What was touched and why

| File | Change |
|---|---|
| `features/memory/recall-eval/recall_eval.py` | NEW — the eval: seeds a scratch DB, runs the queries, reports hit@k / MRR / rank / pool hit / staleness. |
| `features/memory/recall-eval/judge_wiring.py` | NEW — finds and calls the gap #5 judge, fail-closed to skip. |
| `features/memory/recall-eval/fixtures.json` | NEW — 12 seed facts (6 targets, 5 near-miss distractors, 1 superseded pair). |
| `features/memory/recall-eval/queries.json` | NEW — 6 recall queries, 1 no-hit query, 1 paraphrase canary. |
| `features/memory/recall-eval/integrity_fixtures.json` | NEW — 4 staged integrity cases (2 contradiction, 2 tool-failure), grade=judge-only. |
| `features/memory/recall-eval/test_recall_eval.py` | NEW — provisional T137, 64 checks. |
| `features/infra/evals/cases.json` | APPENDED 3 recall cases only (8 cases total now). Nothing existing changed; version left at 1 — the coordinator owns versioning. `run-evals.py` was NOT modified (the gap #5 sibling owns the judge wiring there). |
| `features/memory/facts.py` | NOT touched — a parallel build (gap #20) owns its write path. |
| `features/test-project/run-tests.py`, `TESTS.md`, `RESULTS.md`, `PLAN.md` | NOT touched — the coordinator registers T137 sequentially. |

## How to run

```bash
python3 features/memory/recall-eval/test_recall_eval.py   # 64 checks
python3 features/memory/recall-eval/recall_eval.py --check --json
python3 features/infra/evals/run-evals.py --dry-run        # lists the 3 new cases
```

The eval runs on a fresh temp scratch database by default. It refuses
to open the live `workspaces/default/memory.db` unless
`--allow-live-path` is passed (a live seeded run needs coordinator
approval — seeding test facts into real memory would pollute it).

## Measured baseline (2026-11-18, scratch DB, `recall_eval.py --check`)

| Metric | Measured | Threshold |
|---|---|---|
| hit@1 | 0.833 (5/6) | >= 0.8 |
| hit@3 | 1.0 (6/6) | == 1.0 |
| hit@5 | 1.0 (6/6) | reported only |
| MRR | 0.917 | >= 0.9 |
| mean rank | 1.17 (miss rank = limit+1) | reported only |
| false-top rate | 1/6 | <= 1/6 |
| candidate-pool hit rate | 1.0 | == 1.0 |
| determinism (2nd run identical) | yes, all 6 queries | required |
| max latency | 1.17 ms | informational |
| max tokens per query | 38 | informational |
| staleness | old absent by default, new rank 1; as-of 2026-11-05 returns old, 2026-11-15 returns new, 2026-10-01 returns neither | required |
| abstention | nonsense query 0 results; paraphrase canary 0 results; empty query raises FactError | required |

n=6, so every threshold moves in 1/6 steps — that coarseness is
declared, not hidden. DeepSeek design review (2026-11-18, 1,160 prompt
+ 3,442 completion tokens) caught: hit@5 is implied by hit@3 (now
reported, not thresholded); mean rank is dominated by MRR (now
reported, not thresholded); latency/tokens need to be labelled
informational (done); the pool-hit metric, false-top rate,
determinism check, as-of boundary checks, and the paraphrase canary
as an expected-zero check were all added from that review.

## Finding: the loop-gate query misses at rank 1 (measured, not fixed)

Query `loop gate budget per task` returns the distractor
("The loop gate budget per task counts shell calls and total calls.",
fused 0.439) above the target ("The loop-gate budget is 60 total tool
calls and 40 shell calls per task.", fused 0.432). Mechanism,
verified in the probe: the target spells it `loop-gate` (hyphen), and
the lexicon entity regex `\bloop gate\b` does not match across a
hyphen, so the target gets entity_overlap 0 while the space-spelled
distractor gets 1 — and the shorter distractor also wins BM25. The
answer is still in the top-3 (rank 2), so hit@3 is unaffected. This
is reported as a finding for a follow-up in facts.py; it is NOT fixed
here (facts.py is owned by the parallel gap #20 build, and the eval's
job is to measure, not to re-tune the retriever).

## Known limitation: queries must share vocabulary with the fact

facts.py builds an FTS5 MATCH in which EVERY query token must occur
in the fact. A paraphrased question using words the fact does not
contain returns zero results — the `paraphrase-budget` query
("what is the per-task tool budget") is an expected-zero canary for
exactly this, so a future retriever change that alters matching fails
loudly instead of silently changing behaviour. This is the limitation
the memory README already notes ("revisit only if real queries fail
on paraphrase"); now it is measured rather than asserted.

## Integrity half — staged, pending the judge

`integrity_fixtures.json` holds 4 cases (fork PR #57 style): two
contradictions (a superseded fact vs the current one) and two
tool-failure cases (recall/history unavailable — the agent must say
it does not know, never invent an answer). Every case is
`grading: "judge"` and pins `rubric:
features/infra/evals/rubrics/v1.md` — the rubric the gap #5 judge
loads. The cases pass the judge's own `audit_cases()` (verified:
`[]` — no substring fields, grading declares its rubric).

`judge_wiring.py` calls the judge's real API, read from
`features/infra/evals/judge.py` (provisional T136). The judge has
since landed on origin/main, and the wiring was verified against
the landed module (read-only probe): `find_judge` resolves
`grade_case`, and a no-transport call returns the judge's
unqualified verdict ("judge needs QWENPAW_USER and QWENPAW_PASS in
the environment; no live judge call was made"), which the wiring
maps to skip / pending-judge.
`grade_case(case, reply)` — it takes the case dict, refuses legacy
substring cases, loads the rubric itself, and returns `{"verdict":
"pass"|"fail"|"unqualified", "pass": bool, "qualified": bool, ...}`.
Fallback: `judge_reply(reply, rubric_text, task, case_id=...)` with
the rubric text loaded via the module's `load_rubric()`. It fails
closed, by failure mode: judge absent, unimportable, no entry point,
raising, **unqualified**, or malformed — every one returns verdict
`skip`, status `pending-judge`. Unqualified is the important one:
the real judge returns `pass: False` for unqualified verdicts, so
reading the `pass` bool first would misreport a harness failure
(no transport / no creds / judge error / timeout) as a case
failure — the wiring checks `qualified` first. Verified against the
real judge (read-only probe, no live call): `grade_case` with a stub
transport returns pass/qualified, and with no transport returns
unqualified/pass False. There is NO substring fallback: grading prose
by substring is the exact flaw gap #5 exists to fix. The CLI exit
code for a skip is 3, distinct from pass (0) and fail (1), so no
automation can misread it as a pass. The test proves the wiring both
ways: a reply a substring check would pass still skips with no judge,
and stub judges (grade_case pass / fail / unqualified / raising /
malformed, plus the judge_reply fallback) are honoured or degraded
to skip as specified.

To finish this half when the machine is back: set QWENPAW_USER /
QWENPAW_PASS in the environment (never stored) and run
`recall_eval.py --grade-integrity --case-id <id> --reply-file
<reply>` for each case — `grade_case` will then build the live
console transport and return a real verdict. No fixture change is
needed — the wiring already calls through.

## Live cases in cases.json — smoke checks only

The three appended cases (`recall-loop-gate`, `recall-keepalive`,
`recall-daily-summary`) ask the live console the same questions the
offline harness measures. Their `expect_contains` is a distinctive
observable phrase (the number / time), which the all-20 evaluation
allows for observable effects — but they are smoke checks, not the
grade: the authoritative measurement is this offline harness. They
need the fixtures seeded on the machine first, and seeding test facts
into live memory needs approval, so no live run is claimed here.
`run-evals.py --dry-run` lists them; no live run has been attempted.

## Deliberately not done

- **No fix to facts.py** (hyphen/entity finding above) — parallel
  ownership (gap #20) + eval measures, does not re-tune.
- **No substring grading of integrity cases** — that repeats the
  flaw gap #5 fixes.
- **No `run-evals.py` change** — the gap #5 sibling owns judge
  wiring there; this build only appended cases to `cases.json`.
- **No live/machine verification** — machine suspended (cooldown
  until ~16:36 IST on 2026-11-18); live console runs and browser
  checks are the parent's job when it unlocks.
- **No semantic/vector search** — needs an embedding model/key (user
  decision, already recorded in the memory README).
