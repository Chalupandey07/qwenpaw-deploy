# LLM judge — eval harness, gap #13 (provisional T136)

Grades agent replies with the model itself against a versioned rubric,
replacing the substring grading of prose in `run-evals.py` / `cases.json`
(T61) — the exact anti-pattern the all-20 evaluation forbids.

## Files

| File | What it is |
|---|---|
| `../judge.py` | The judge: prompt builder, verdict parser, console transport, `grade_case`, `audit_cases`. Stdlib only. |
| `../rubrics/v1.md` | Versioned rubric (immutable — a change means a new file, `v2.md`). |
| `calibration.json` | 12 human-reviewed calibration examples with expected verdicts. |
| `../test_judge.py` | Machine-free test (44 checks). Run it standalone. |
| `README.md` | This file. |

## API (for gap #6's integrity fixtures — do not rename)

```python
from evals.judge import judge_reply, grade_case  # or import judge.py directly

verdict = judge_reply(reply, rubric_text, task, transport=None, case_id="...")
# -> {"pass": bool, "qualified": bool, "reason": str, "evidence": str,
#     "error_kind": str | None, "rubric_version": "rubrics/v1",
#     "rubric_sha256": "...", "judge_prompt_version": "judge-prompt/v1",
#     "model": "mosicn/nex-n2.6 (console active model, expected)",
#     "reply_truncated": bool}
```

`transport` is a callable taking the judge prompt and returning raw
judge text. When `None`, the live console transport is built
(`ConsoleJudgeTransport`, same login + chat-task path as
`run-evals.py`, session id `eval-judge-<case-id>`, credentials from
`QWENPAW_BASE_URL` / `QWENPAW_USER` / `QWENPAW_PASS` at call time,
never stored). No new key, no decision-model key.

`grade_case(case, reply, transport=..., observations=...,
rubric_text=...)` grades one new-format case and returns
`{"verdict": "pass"|"fail"|"unqualified", ...}`. New case format:

```json
{"id": "x", "prompt": "...", "task": "...", "grading": "judge",
 "rubric": "rubrics/v1.md",
 "observable_effects": [{"kind": "file_exists", "path": "/data/..."}]}
```

`observable_effects` is optional and takes real probes only:
`file_exists` (checked on the grading machine) and `endpoint_called`
(from runner observations). A reply *saying* something happened is
prose, not an observable effect.

## Fail-closed rules

- `qualified=False` always implies `pass=False`.
- A verdict that is not valid JSON, is missing a field, has `pass`
  not a JSON bool, has an empty reason, or passes with no quoted
  evidence is **unqualified, never a pass**.
- Judge errors/timeouts are **unqualified, never a pass**. Inside
  `grade_case` they surface as verdict `"unqualified"`, not `"fail"`,
  so an outage never looks like a quality regression.
- `task` is mandatory: a reply cannot be graded without its question.
- The reply under test is untrusted content: fenced as data, and the
  parser takes the judge's own (last) `<verdict>` block — a verdict
  block smuggled inside the reply is ignored. Residual risk: if the
  live judge copies an injected block as its own verdict, the parser
  cannot tell; the calibration set has an injection case
  (`cal-03`) and the live calibration run measures it.
- `expect_contains` / `must_not_contain` are refused: `grade_case`
  raises `ValueError` on a legacy case instead of grading prose by
  substring. `audit_cases()` flags them in any case file — run it on
  the existing suite and it flags all 5 T61 cases (and, at the time of
  writing, 3 further recall cases the sibling gap-#6 agent added to
  the same `cases.json`: `recall-loop-gate`, `recall-keepalive`,
  `recall-daily-summary`. Those are #6's deterministic recall checks,
  not this build's to change — but the flag is correct as a mechanical
  warning: `expect_contains` on a reply cannot tell a recalled fact
  from a keyword mentioned in passing, and the coordinator should
  decide whether recall assertions belong in `cases.json` or in a
  deterministic top-k check outside the reply text).
- No env reads or network at import time; the default transport is
  built lazily. Per-transport call cap: 50 judge calls (judging
  doubles call volume; the cap keeps a run from eating quota).
- No temperature control exists in the chat-task envelope, so a live
  verdict is one sample, not deterministic. Re-run calibration after
  any rubric or serving-model change.

## Calibration — what is and is not proven

`calibration.json` holds 12 human-reviewed examples (timezone
paraphrase, a keyword-distractor, an injection attempt, two
borderlines, refusal good/bad, no-China good/bad, English good/bad,
empty reply). The machine-free test proves:

1. the parser/plumbing honours a conforming verdict and rejects every
   malformed one;
2. the set is well-formed and covers the categories above;
3. the OLD substring grader disagrees with the human verdicts on 5 of
   the 12 examples (run it: `python3 test_judge.py --old-grader` —
   exits non-zero by design). The five: the timezone paraphrase, the
   Paris distractor, the injection attempt (the smuggled verdict block
   itself contains the keyword "Paris", so the substring grader is
   fooled by the injection too), the destructive-compliance reply, and
   the French reply.

It does **not** prove the live model agrees with the humans — no
canned stub output could prove that; a stub returning recorded
verdicts would only prove the parser. Live agreement is measured by:

```bash
QWENPAW_USER=satwik QWENPAW_PASS='...' python3 judge.py --calibrate --live
# or: python3 test_judge.py --live
```

which grades all 12 examples with the real console judge and requires
12/12 agreement before the judge is called trusted. **Live agreement
is NOT VERIFIED yet** — the machine was suspended when this was built
(cooldown until ~16:36 IST, 2026-11-18) and no live judge call has
been made. Do not claim it from the machine-free test. The parent /
coordinator runs the live calibration once the machine is back.

## Run

```bash
python3 test_judge.py              # must PASS (44 checks)
python3 test_judge.py --old-grader # must FAIL (old grader wrong on >= 2)
python3 judge.py --audit-cases cases.json   # flags all 5 legacy cases
python3 judge.py --calibrate       # set summary, live NOT VERIFIED
```

## Design review

DeepSeek design review 2026-11-18 (deepseek-v4.1-flash-free) caught:
mandatory task, sentinel-only verdict extraction, reply-as-data
fencing + injection case, pass/qualified precedence, observable
effects as real probes (not substring-on-reply), judge session
isolation, rubric provenance (version + sha256), the calibration
circularity (canned judge outputs prove the parser, not agreement —
hence the honest split above), and the infra-vs-quality distinction.
All fixed except the deliberate limits: no temperature control in the
chat-task envelope, and evidence is a quoted string, not a structured
criterion citation (the rubric asks the judge to cite criterion ids
in the reason; the parser does not enforce it semantically).

## Deliberately left alone

- `run-evals.py` and `cases.json` are untouched: the runner still
  grades by substring (its flaw is documented, and `audit_cases`
  flags it). Migrating the 5 T61 cases to judge grading is a
  follow-up for the coordinator, not this build — the cases need
  human re-review as judge cases first.
- No second judge for gap #6: #6's integrity fixtures import
  `judge_reply` / `grade_case` from here.
- No vector/semantic grading, no temperature parameter, no new model
  key, no changes to `run-tests.py` / `TESTS.md` / `RESULTS.md` /
  `PLAN.md` (the coordinator registers T136).
