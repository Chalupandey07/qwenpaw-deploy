#!/usr/bin/env python3
"""Turn daily logs into lesson CANDIDATES — the missing consolidation step.

THE GAP THIS FILLS
------------------
QwenPaw v2.3.0 already ships ReMe (daily/distill markdown) and FTS5 history
recall, and `features/memory/` already adds token-budgeted, redacting,
host-side recall plus a candidate/accept lessons ledger. The one thing nothing
does is **carry experience forward**: daily notes accumulate and nothing turns
them into durable lessons.

This script reads `daily_dir` + `digest_dir` markdown and proposes lesson
CANDIDATES via the existing `lessons.py` ledger. It never accepts anything.
That separation is the whole design: an agent that can silently write its own
long-term memory accumulates confident nonsense.

WHY IT IS RULE-BASED, NOT LLM-BASED
-----------------------------------
Consolidation is a *selection* problem, not a generation problem, and doing it
with a model would cost a model call per run and produce plausible-sounding
lessons that no failure justifies. The rules here look for the shapes that
actually precede a durable lesson in this repo's own history:

  * a mistake and its correction ("should have", "actually", "turns out")
  * a root cause (because / caused by / the reason was)
  * a constraint discovered the hard way (cannot / only works if / free tier)
  * an explicit "never again" instruction

Anything that does not match stays in the daily log and is *not* promoted.
Zero candidates is the normal, healthy outcome for a quiet day — and the
script says so rather than manufacturing something to look productive.

SECRETS ARE REJECTED, NOT SCRUBBED
----------------------------------
Every candidate field goes through the same redactor as `recall.py`. A line
that trips it is DROPPED with a warning, not edited: a lesson containing a
token is a bug in the notes, and silently rewriting it would hide that.

USAGE
-----
    # dry run (default): show what WOULD be proposed, change nothing
    python3 consolidate.py --memory MEMORY.md --daily memory/ --digest digest/

    # actually write candidates into the ledger
    python3 consolidate.py --memory MEMORY.md --daily memory/ --write

    # machine-readable
    python3 consolidate.py ... --json

    # selftest, no files needed
    python3 consolidate.py --selftest

Designed to be cron-invoked (the routines Worker already wakes the box). It is
idempotent: a candidate whose guidance already exists in the ledger is
skipped, so running it hourly does not stack duplicates.

Exit: 0 ok, 1 usage/ledger error, 2 nothing to do is NOT an error.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import lessons as L  # noqa: E402
from recall import redact  # noqa: E402

# --------------------------------------------------------------- extraction

# Each rule is (kind, scope-hint, pattern, why-this-shape). The `why` is not
# documentation — it is reported to the human reviewing the candidate, so they
# can judge the extraction rather than trust it.
RULES: list[tuple[str, str, re.Pattern[str], str]] = [
    ("gottcha", "general",
     re.compile(r"(?i)\b(turns? out|actually|in fact|it was not|wasn'?t)\b[^.]{10,200}"),
     "a claim was corrected — the correction is the lesson"),
    ("gottcha", "general",
     re.compile(r"(?i)\b(should have|should'?ve|next time|never again)\b[^.]{10,200}"),
     "an explicit retrospective statement"),
    ("constraint", "general",
     re.compile(r"(?i)\b(cannot|can'?t|only works (?:if|when)|not possible|"
                r"free tier|quota|rate.?limit)\b[^.]{10,200}"),
     "a hard limit discovered — constraints are the most valuable lessons"),
    ("workflow", "general",
     re.compile(r"(?i)\b(the reason (?:was|is)|caused by|because of|root cause)\b[^.]{10,200}"),
     "a root cause rather than a symptom"),
    ("workflow", "general",
     re.compile(r"(?i)\b(root cause|fix(?:ed)? by|the fix (?:was|is))\b[^.]{10,200}"),
     "a fix with its mechanism attached"),
    ("fact", "general",
     re.compile(r"(?i)\b(verified|confirmed|measured)\b[^.]{15,200}"),
     "a measured fact, which beats a remembered one"),
]

# Lines that look like lessons but are not: headings, table rows, links,
# front matter, and the lesson entries themselves (already in the ledger).
SKIP_LINE = re.compile(
    r"^\s*(?:#|>|\||-{3,}|[*_]{3,}|```|\[[ x]\]|L-\d{3,}\b|"
    r"<!--|\s*$)"
)

MAX_LINE_CHARS = 400
MAX_CANDIDATES_PER_RUN = 3  # matches lessons.py's pending cap


@dataclass
class Candidate:
    guidance: str
    reason: str
    evidence: str
    kind: str = "gottcha"
    scope: str = "general"
    matched_rules: list[str] = field(default_factory=list)
    source: str = ""
    rejected: str = ""          # non-empty => do not propose, say why

    def key(self) -> str:
        """Normalised form used for duplicate detection."""
        return re.sub(r"[^a-z0-9]+", " ", self.guidance.lower()).strip()


def sentences(text: str) -> list[str]:
    out = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if SKIP_LINE.match(line):
            continue
        if len(line) > MAX_LINE_CHARS:
            line = line[:MAX_LINE_CHARS]
        for part in re.split(r"(?<=[.!?])\s+", line):
            part = part.strip(" -*\t")
            if len(part) >= 25:
                out.append(part)
    return out


def extract(text: str, source: str) -> list[Candidate]:
    """Extract candidate lessons from one document."""
    found: list[Candidate] = []
    for sent in sentences(text):
        hits: list[tuple[str, str, str]] = []
        for kind, scope, pattern, why in RULES:
            if pattern.search(sent):
                hits.append((kind, scope, why))
        if not hits:
            continue
        # One candidate per sentence, using the first matching rule's kind.
        kind, scope, why = hits[0]
        cand = Candidate(
            guidance=_to_guidance(sent),
            reason=f"Extracted from a daily note because it matches: {why}.",
            evidence=f"{source}: {sent[:200]}",
            kind=kind,
            scope=scope,
            matched_rules=[h[2] for h in hits],
            source=source,
        )
        # Secrets: DROP, never scrub.
        for fname in ("guidance", "reason", "evidence"):
            _, rule_hits = redact(getattr(cand, fname))
            if rule_hits:
                cand.rejected = (
                    f"{fname} looks like it contains a secret "
                    f"({', '.join(rule_hits)}) — dropped, not scrubbed"
                )
                break
        found.append(cand)
    return found


def _to_guidance(sentence: str) -> str:
    """Turn a narrative sentence into an imperative instruction.

    Deliberately mechanical. The candidate is reviewed by a human before it
    becomes durable, so a slightly awkward imperative is fine — a
    plausible-but-wrong paraphrase is not.
    """
    s = sentence.strip().rstrip(".")
    s = re.sub(r"(?i)^(i |we )?(turns? out|actually|in fact)\s+", "", s)
    s = re.sub(r"(?i)^(i |we )?(should have|should'?ve)\s+", "", s)
    if not re.match(r"(?i)^(never|always|use|avoid|check|verify|prefer|"
                    r"do not|don'?t|keep|treat|remember|cap|clamp|budget)\b", s):
        s = "Remember: " + s
    return s[:L.MAX_FIELD_CHARS]


# ---------------------------------------------------------------- dedupe

def existing_guidance(memory_file: Path) -> set[str]:
    """Normalised guidance of every entry already in the ledger."""
    try:
        _, _, _, entries, _ = L.load(memory_file)
    except Exception:
        return set()
    return {re.sub(r"[^a-z0-9]+", " ", e.guidance.lower()).strip()
            for e in entries if e.guidance}


def is_duplicate(cand: Candidate, existing: set[str]) -> bool:
    """Duplicate if identical, contained, or a high token overlap.

    Containment alone was not enough (the selftest caught it): "the generation
    write must throw on failure now" and "remember the generation write must
    throw on failure" contain neither the other, because the prefix and suffix
    differ — yet they are obviously the same lesson. Token-overlap (Jaccard)
    catches the reordered/reworded case that containment misses.
    """
    key = cand.key()
    if not key:
        return True
    if key in existing:
        return True
    for other in existing:
        if len(other) < 30 or len(key) < 30:
            continue
        if key in other or other in key:
            return True
        a, b = set(key.split()), set(other.split())
        if not a or not b:
            continue
        overlap = len(a & b) / len(a | b)
        if overlap >= 0.6:
            return True
    return False


# ------------------------------------------------------------------- main

def collect(dirs: Iterable[Path], suffixes=(".md",)) -> list[tuple[str, str]]:
    """Read every markdown file in the given dirs. Returns (label, text)."""
    out: list[tuple[str, str]] = []
    for d in dirs:
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*")):
            if p.is_file() and p.suffix in suffixes:
                try:
                    out.append((str(p), p.read_text(encoding="utf-8")))
                except (OSError, UnicodeDecodeError):
                    continue
    return out


def consolidate(memory_file: Path, dirs: list[Path],
                write: bool = False) -> dict[str, Any]:
    docs = collect(dirs)
    existing = existing_guidance(memory_file)
    all_cands: list[Candidate] = []
    for label, text in docs:
        all_cands.extend(extract(text, label))

    seen: set[str] = set()
    kept: list[Candidate] = []
    skipped_dup = 0
    for c in all_cands:
        if c.rejected:
            continue
        if is_duplicate(c, existing) or c.key() in seen:
            skipped_dup += 1
            continue
        seen.add(c.key())
        kept.append(c)

    # Cap per run: the ledger allows 3 pending, so proposing more would fail.
    to_write = kept[:MAX_CANDIDATES_PER_RUN]
    written: list[str] = []
    errors: list[str] = []

    if write and to_write:
        for c in to_write:
            try:
                before, _, after, entries, other = L.load(memory_file)
                pending = [e for e in entries if e.state == "candidate"]
                if len(pending) >= L.MAX_CANDIDATES:
                    errors.append(
                        f"ledger already has {len(pending)} pending candidates "
                        f"(cap {L.MAX_CANDIDATES}); stopping"
                    )
                    break
                entry = L.Entry(
                    id=L.next_id(entries), state="candidate", kind=c.kind,
                    scope=c.scope, guidance=c.guidance, reason=c.reason,
                    evidence=c.evidence,
                )
                trial = entries + [entry]
                problems = L.validate(trial)
                if problems:
                    errors.append(f"{entry.id}: {'; '.join(problems)}")
                    continue
                L.save(memory_file, before, trial, other, after)
                written.append(entry.id)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{type(exc).__name__}: {exc}")

    return {
        "documents_scanned": len(docs),
        "sentences_matched": len(all_cands),
        "rejected_for_secrets": sum(1 for c in all_cands if c.rejected),
        "skipped_duplicate": skipped_dup,
        "candidates": [asdict(c) for c in kept],
        "written": written,
        "capped_to": MAX_CANDIDATES_PER_RUN,
        "errors": errors,
        "mode": "write" if write else "dry-run",
    }


def render(report: dict[str, Any]) -> str:
    lines = [
        f"consolidate ({report['mode']}) — scanned {report['documents_scanned']} "
        f"document(s)"
    ]
    if not report["candidates"]:
        lines.append("  no candidates — that is a normal, healthy result for a "
                     "quiet period. Nothing is promoted without a reason.")
        return "\n".join(lines)
    lines.append(
        f"  {len(report['candidates'])} candidate(s), "
        f"{report['skipped_duplicate']} duplicate(s) skipped, "
        f"{report['rejected_for_secrets']} dropped for secrets"
    )
    for c in report["candidates"][:report["capped_to"]]:
        lines.append(f"  - [{c['kind']}/{c['scope']}] {c['guidance'][:100]}")
        lines.append(f"      why: {', '.join(c['matched_rules'])[:120]}")
        lines.append(f"      from: {c['source']}")
    if len(report["candidates"]) > report["capped_to"]:
        lines.append(f"  (+{len(report['candidates']) - report['capped_to']} more, "
                     f"deferred to the next run — the ledger caps pending at "
                     f"{report['capped_to']})")
    if report["written"]:
        lines.append(f"  wrote candidate(s): {', '.join(report['written'])}")
        lines.append("  NOTE: candidates are NOT durable. A human accepts them:")
        lines.append("    python3 lessons.py --file MEMORY.md accept --id L-00X --why '...'")
    if report["errors"]:
        lines.append("  errors:")
        for e in report["errors"]:
            lines.append(f"   - {e}")
    return "\n".join(lines)


# ----------------------------------------------------------------- selftest

def selftest() -> int:
    import tempfile
    failures: list[str] = []

    def expect(name: str, cond: bool, detail: str = "") -> None:
        print(f"  {'ok  ' if cond else 'FAIL'} {name}  {detail if not cond else ''}")
        if not cond:
            failures.append(name)

    print("extraction")
    text = (
        "# 2026-11-15\n\n"
        "- Turns out the generation write was swallowed, so takeover lied.\n"
        "- We should have checked the D1 row cap before sizing the preview.\n"
        "- Free tier caps KV writes at 1,000/day.\n"
        "- The reason was that getGeneration returned 0 on error.\n"
        "- Verified the binary exists before installing it.\n"
        "- Just a normal log line with nothing to learn.\n"
    )
    cands = extract(text, "memory/2026-11-15.md")
    expect("extracts something", len(cands) >= 4, str(len(cands)))
    kinds = {c.kind for c in cands}
    expect("finds a gottcha", "gottcha" in kinds, str(kinds))
    expect("finds a constraint", "constraint" in kinds, str(kinds))
    expect("ignores the plain log line",
           not any("normal log line" in c.guidance for c in cands),
           str([c.guidance for c in cands]))
    expect("every candidate carries evidence",
           all(c.evidence for c in cands))
    expect("every candidate carries a why", all(c.matched_rules for c in cands))

    print("guidance shape")
    expect("guidance is imperative-ish",
           all(len(c.guidance) > 0 and len(c.guidance) <= L.MAX_FIELD_CHARS
               for c in cands))
    expect("guidance does not start mid-clause",
           all(not c.guidance.startswith(("that ", "which ")) for c in cands))

    print("secrets are dropped, not scrubbed")
    secret_text = (
        "- Turns out the key ghp_" + "a" * 36 + " was in the log all along.\n"
    )
    sc = extract(secret_text, "x.md")
    expect("a secret-bearing line is DROPPED",
           all(c.rejected for c in sc), str([c.rejected for c in sc]))
    expect("the rejection says dropped not scrubbed",
           all("dropped, not scrubbed" in c.rejected for c in sc),
           str([c.rejected for c in sc]))
    expect("the dropped text is not rewritten in place",
           all("ghp_" + "a" * 36 in c.guidance for c in sc),
           "guidance must be untouched so the bug is visible")

    print("structure is skipped")
    struct = "# Heading\n| a | b |\n---\n[ ] task\n- **L-001** · accepted\n"
    expect("no candidates from structure alone", extract(struct, "x") == [])

    print("dedupe")
    exist = {"remember the generation write must throw on failure"}
    dup = Candidate(guidance="Remember the generation write must throw on failure",
                    reason="r", evidence="e")
    expect("exact duplicate detected", is_duplicate(dup, exist))
    near = Candidate(guidance="the generation write must throw on failure now",
                     reason="r", evidence="e")
    expect("near-duplicate detected", is_duplicate(near, exist))
    fresh = Candidate(guidance="Always clamp capability expiry to the lease deadline",
                      reason="r", evidence="e")
    expect("genuinely new is not a duplicate", not is_duplicate(fresh, exist))

    print("end to end (dry run and write)")
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "memory").mkdir()
        (root / "digest").mkdir()
        (root / "memory" / "2026-11-15.md").write_text(text, encoding="utf-8")
        (root / "digest" / "d.md").write_text(
            "- Verified that a D1 row caps at 2,000,000 bytes.\n", encoding="utf-8")
        mem = root / "MEMORY.md"
        mem.write_text(
            "# MEMORY.md\n\n## Important Decisions and Lessons\n\n"
            "- **L-001** · accepted · kind=constraint\n"
            "  - **Guidance:** Treat the KV write budget as zero.\n"
            "  - **Reason:** A spent quota broke every desktop write.\n"
            "  - **Evidence:** 2026-11-15 incident.\n"
            "\n## Other\n\nkeep me\n", encoding="utf-8")

        dry = consolidate(mem, [root / "memory", root / "digest"], write=False)
        expect("dry run finds candidates", len(dry["candidates"]) > 0)
        expect("dry run writes nothing", dry["written"] == [])
        expect("dry run leaves MEMORY.md untouched",
               "L-002" not in mem.read_text())

        got = consolidate(mem, [root / "memory", root / "digest"], write=True)
        expect("write run writes at most the cap",
               len(got["written"]) <= MAX_CANDIDATES_PER_RUN, str(got["written"]))
        expect("write run records ids", all(re.fullmatch(r"L-\d{3,}", i)
                                            for i in got["written"]),
               str(got["written"]))
        after = mem.read_text()
        expect("written entries are CANDIDATES, never accepted",
               "**L-002** · candidate" in after, after[:400])
        expect("nothing was auto-accepted", "**L-002** · accepted" not in after)
        expect("surrounding document preserved",
               "keep me" in after and "L-001" in after)
        expect("ledger still validates", L.validate(L.load(mem)[3]) == [],
               str(L.validate(L.load(mem)[3])))

        # Idempotency: a second write must not duplicate.
        again = consolidate(mem, [root / "memory", root / "digest"], write=True)
        expect("second run proposes no duplicates of its own output",
               len(again["written"]) == 0 or
               len(again["skipped_duplicate"]) > 0,
               f"written={again['written']} dup={again['skipped_duplicate']}")

    print("empty input")
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "memory").mkdir()
        mem = root / "MEMORY.md"
        mem.write_text("# MEMORY.md\n\n## Important Decisions and Lessons\n",
                       encoding="utf-8")
        rep = consolidate(mem, [root / "memory"], write=False)
        expect("no documents is not an error",
               rep["documents_scanned"] == 0 and rep["candidates"] == [])
        expect("missing dir is tolerated",
               consolidate(mem, [root / "nope"], write=False)["documents_scanned"] == 0)

    print()
    total = 27
    print(f"{total - len(failures)} passed, {len(failures)} failed")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--memory", help="path to MEMORY.md")
    ap.add_argument("--daily", action="append", default=[],
                    help="daily notes dir (repeatable)")
    ap.add_argument("--digest", action="append", default=[],
                    help="digest dir (repeatable)")
    ap.add_argument("--write", action="store_true",
                    help="actually write candidates (default: dry run)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if not args.memory:
        print("error: --memory is required (or --selftest)", file=sys.stderr)
        return 1

    dirs = [Path(p).expanduser() for p in (args.daily + args.digest)]
    try:
        report = consolidate(Path(args.memory).expanduser(), dirs, write=args.write)
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(report, indent=2) if args.json else render(report))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
