#!/usr/bin/env python3
"""Lessons ledger for QwenPaw's MEMORY.md (candidates in, accepted out).

WHY A LEDGER AND NOT A NEW FILE
-------------------------------
QwenPaw's shipped MEMORY.md template already has a
`## Important Decisions and Lessons` section, and MEMORY.md is read whole
at task start (it is not in the memory_search index). A separate
LESSONS.md today would duplicate that section and double the read cost.
So the section stays, and this tool manages its contents as structured
entries with a review workflow.

WHAT IT ENFORCES (PLAN.md Phase 4)
----------------------------------
  * <= 10 accepted entries, <= 800 words across the block,
  * <= 3 pending candidates at any time,
  * stable `L-001` ids that are never reused,
  * every entry carries State / Kind / Scope / Guidance / Reason /
    Evidence / Revisit,
  * a durable write (candidate -> accepted) is never automatic: the
    propose step only writes candidates, and `accept` is an explicit,
    separate command with a required `--why`,
  * no secrets: every field is scanned with the same redactor the
    recall CLI uses, and anything credential-shaped is REJECTED, not
    silently scrubbed (a lesson containing a token is a bug upstream).

Entry format written into MEMORY.md (one bullet block per entry):

  - **L-003** · accepted · kind=gottcha · scope=desktop
    - **Guidance:** Never trust `installed: true`; verify the binary exists.
    - **Reason:** A stale marker reported Chromium installed when it was gone.
    - **Evidence:** 2026-11-15 session sess-alpha, disk cleanup incident.
    - **Revisit:** If the desktop API starts returning a hash, drop this.

Usage:
  python3 lessons.py --file MEMORY.md list
  python3 lessons.py --file MEMORY.md propose --guidance "..." --reason "..."
  python3 lessons.py --file MEMORY.md accept --id L-004 --why "user confirmed"
  python3 lessons.py --file MEMORY.md reject --id L-004 --why "duplicate"
  python3 lessons.py --file MEMORY.md check
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from recall import redact  # noqa: E402  (same redactor, one source of truth)

SECTION_HEADING = "## Important Decisions and Lessons"
MAX_ACCEPTED = 10
MAX_CANDIDATES = 3
MAX_BLOCK_WORDS = 800
MAX_FIELD_CHARS = 400
VALID_STATES = ("candidate", "accepted", "rejected", "superseded")
VALID_KINDS = ("gottcha", "constraint", "workflow", "preference", "fact")

_ID_RE = re.compile(r"^L-(\d{3,})$")
_ENTRY_HEAD_RE = re.compile(
    r"^\s*-\s*\*\*(L-\d{3,})\*\*"
    r"(?:\s*[·|]\s*(candidate|accepted|rejected|superseded))?"
    r"(?:\s*[·|]\s*kind=([a-z]+))?"
    r"(?:\s*[·|]\s*scope=([A-Za-z0-9_.,\-]+))?\s*$"
)
_FIELD_RE = re.compile(r"^\s{2,}-\s*\*\*(Guidance|Reason|Evidence|Revisit):\*\*\s*(.*)$")


@dataclass
class Entry:
    id: str
    state: str = "candidate"
    kind: str = "gottcha"
    scope: str = ""
    guidance: str = ""
    reason: str = ""
    evidence: str = ""
    revisit: str = ""
    extra: list[str] = field(default_factory=list)

    def words(self) -> int:
        return len(
            " ".join(
                [self.guidance, self.reason, self.evidence, self.revisit]
            ).split()
        )

    def render(self) -> str:
        head = f"- **{self.id}** · {self.state} · kind={self.kind}"
        if self.scope:
            head += f" · scope={self.scope}"
        lines = [head]
        if self.guidance:
            lines.append(f"  - **Guidance:** {self.guidance}")
        if self.reason:
            lines.append(f"  - **Reason:** {self.reason}")
        if self.evidence:
            lines.append(f"  - **Evidence:** {self.evidence}")
        if self.revisit:
            lines.append(f"  - **Revisit:** {self.revisit}")
        lines.extend(f"  {line}" for line in self.extra)
        return "\n".join(lines)


class LessonsError(RuntimeError):
    pass


# ------------------------------------------------------------------ parsing

def split_document(text: str) -> tuple[str, str, str]:
    """Return (before, section_body, after) around the lessons heading."""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip().rstrip(":").strip() == SECTION_HEADING:
            start = i
            break
    if start is None:
        raise LessonsError(
            f"section {SECTION_HEADING!r} not found — add it to MEMORY.md first"
        )
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    before = "\n".join(lines[: start + 1])
    body = "\n".join(lines[start + 1 : end])
    after = "\n".join(lines[end:])
    return before, body, after


def parse_entries(body: str) -> tuple[list[Entry], list[str]]:
    """Parse entries out of a section body. Returns (entries, other_lines)."""
    entries: list[Entry] = []
    other: list[str] = []
    current: Entry | None = None
    for line in body.splitlines():
        head = _ENTRY_HEAD_RE.match(line)
        if head:
            current = Entry(
                id=head.group(1),
                state=head.group(2) or "candidate",
                kind=head.group(3) or "gottcha",
                scope=head.group(4) or "",
            )
            entries.append(current)
            continue
        field_match = _FIELD_RE.match(line)
        if field_match and current is not None:
            key, value = field_match.group(1), field_match.group(2).strip()
            setattr(current, key.lower(), value)
            continue
        if current is not None and line.startswith("  ") and line.strip():
            current.extra.append(line.strip())
            continue
        if line.strip():
            other.append(line)
    return entries, other


def render_document(before: str, entries: Iterable[Entry], other: list[str],
                    after: str) -> str:
    """Reassemble MEMORY.md, preserving everything that was not an entry."""
    parts = [before.rstrip("\n"), ""]
    kept = [e.render() for e in entries]
    if kept:
        parts.append("\n".join(kept))
        parts.append("")
    if other:
        parts.extend(other)
        parts.append("")
    tail = after.strip("\n")
    if tail:
        parts.append(tail)
    return "\n".join(parts).rstrip("\n") + "\n"


# ----------------------------------------------------------------- validation

def validate(entries: list[Entry]) -> list[str]:
    """Return a list of problems. Empty list means the block is valid."""
    problems: list[str] = []
    accepted = [e for e in entries if e.state == "accepted"]
    candidates = [e for e in entries if e.state == "candidate"]

    if len(accepted) > MAX_ACCEPTED:
        problems.append(
            f"{len(accepted)} accepted entries exceeds the cap of {MAX_ACCEPTED}"
        )
    if len(candidates) > MAX_CANDIDATES:
        problems.append(
            f"{len(candidates)} candidates exceeds the cap of {MAX_CANDIDATES}"
        )
    block_words = sum(e.words() for e in entries if e.state in ("accepted", "candidate"))
    if block_words > MAX_BLOCK_WORDS:
        problems.append(
            f"block is {block_words} words, over the {MAX_BLOCK_WORDS} cap"
        )

    seen: set[str] = set()
    for entry in entries:
        if not _ID_RE.match(entry.id):
            problems.append(f"{entry.id}: malformed id")
        if entry.id in seen:
            problems.append(f"{entry.id}: duplicate id")
        seen.add(entry.id)
        if entry.state not in VALID_STATES:
            problems.append(f"{entry.id}: bad state {entry.state!r}")
        if entry.kind not in VALID_KINDS:
            problems.append(f"{entry.id}: bad kind {entry.kind!r}")
        if entry.state in ("accepted", "candidate"):
            for name in ("guidance", "reason"):
                value = getattr(entry, name)
                if not value:
                    problems.append(f"{entry.id}: missing {name}")
                elif len(value) > MAX_FIELD_CHARS:
                    problems.append(
                        f"{entry.id}: {name} is {len(value)} chars "
                        f"(cap {MAX_FIELD_CHARS})"
                    )
            if entry.state == "accepted" and not entry.evidence:
                problems.append(f"{entry.id}: accepted entry needs Evidence")
            for name in ("guidance", "reason", "evidence", "revisit"):
                value = getattr(entry, name)
                if value:
                    _, hits = redact(value)
                    if hits:
                        problems.append(
                            f"{entry.id}: {name} looks like it contains a "
                            f"secret ({', '.join(hits)}) — rejected, not scrubbed"
                        )
    return problems


def next_id(entries: list[Entry]) -> str:
    highest = 0
    for entry in entries:
        match = _ID_RE.match(entry.id)
        if match:
            highest = max(highest, int(match.group(1)))
    return f"L-{highest + 1:03d}"


# ------------------------------------------------------------------ commands

def load(path: Path) -> tuple[str, str, str, list[Entry], list[str]]:
    if not path.is_file():
        raise LessonsError(f"file not found: {path}")
    before, body, after = split_document(path.read_text())
    entries, other = parse_entries(body)
    return before, body, after, entries, other


def save(path: Path, before: str, entries: list[Entry], other: list[str],
         after: str) -> None:
    path.write_text(render_document(before, entries, other, after))


def cmd_list(path: Path, as_json: bool) -> int:
    _, _, _, entries, _ = load(path)
    if as_json:
        import json
        print(json.dumps([e.__dict__ for e in entries], indent=2))
        return 0
    accepted = [e for e in entries if e.state == "accepted"]
    candidates = [e for e in entries if e.state == "candidate"]
    print(f"{len(accepted)} accepted / {MAX_ACCEPTED} · "
          f"{len(candidates)} candidate / {MAX_CANDIDATES} · "
          f"{sum(e.words() for e in entries if e.state in ('accepted','candidate'))}"
          f"/{MAX_BLOCK_WORDS} words")
    for entry in entries:
        marker = {"accepted": "✓", "candidate": "?", "rejected": "✗",
                  "superseded": "~"}.get(entry.state, " ")
        print(f"  {marker} {entry.id} [{entry.kind}"
              f"{'/' + entry.scope if entry.scope else ''}] {entry.guidance[:70]}")
    problems = validate(entries)
    if problems:
        print("\nproblems:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    return 0


def cmd_propose(path: Path, args: argparse.Namespace) -> int:
    before, _, after, entries, other = load(path)
    problems = validate(entries)
    if problems:
        print("refusing to propose into an invalid block:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    candidates = [e for e in entries if e.state == "candidate"]
    if len(candidates) >= MAX_CANDIDATES:
        print(
            f"refusing: {len(candidates)} candidates already pending "
            f"(cap {MAX_CANDIDATES}) — accept or reject one first",
            file=sys.stderr,
        )
        return 1
    entry = Entry(
        id=next_id(entries),
        state="candidate",
        kind=args.kind,
        scope=args.scope or "",
        guidance=args.guidance.strip(),
        reason=args.reason.strip(),
        evidence=(args.evidence or "").strip(),
        revisit=(args.revisit or "").strip(),
    )
    trial = entries + [entry]
    problems = validate(trial)
    if problems:
        print("refusing: the new candidate is invalid:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    save(path, before, trial, other, after)
    print(f"proposed {entry.id} (candidate) — accept it with:")
    print(f"  python3 lessons.py --file {path} accept --id {entry.id} --why \"...\"")
    return 0


def cmd_transition(path: Path, args: argparse.Namespace, state: str) -> int:
    before, _, after, entries, other = load(path)
    target = None
    for entry in entries:
        if entry.id == args.id:
            target = entry
            break
    if target is None:
        print(f"no such entry: {args.id}", file=sys.stderr)
        return 1
    if not args.why or not args.why.strip():
        print("--why is required for a durable state change", file=sys.stderr)
        return 1
    if state == "accepted" and target.state != "candidate":
        print(f"{target.id} is {target.state}, not candidate", file=sys.stderr)
        return 1
    target.state = state
    if state == "rejected":
        target.extra.append(f"- **Reviewed:** rejected — {args.why.strip()}")
    else:
        target.extra.append(f"- **Reviewed:** accepted — {args.why.strip()}")
    problems = validate(entries)
    if problems:
        print(f"refusing: taking {target.id} {state} breaks the block:",
              file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    save(path, before, entries, other, after)
    print(f"{target.id} -> {state}")
    return 0


def cmd_check(path: Path) -> int:
    _, _, _, entries, _ = load(path)
    problems = validate(entries)
    if not problems:
        print(f"OK: {len(entries)} entries, block valid")
        return 0
    for problem in problems:
        print(f"  - {problem}")
    return 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--file", required=True, help="path to MEMORY.md")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="show entries and validation state")
    p_list.add_argument("--json", action="store_true")

    p_prop = sub.add_parser("propose", help="add a candidate (not durable)")
    p_prop.add_argument("--guidance", required=True,
                        help="one imperative sentence")
    p_prop.add_argument("--reason", required=True)
    p_prop.add_argument("--evidence", default="")
    p_prop.add_argument("--revisit", default="")
    p_prop.add_argument("--kind", default="gottcha", choices=VALID_KINDS)
    p_prop.add_argument("--scope", default="")

    for name in ("accept", "reject"):
        p = sub.add_parser(name, help=f"move a candidate to {name}ed")
        p.add_argument("--id", required=True)
        p.add_argument("--why", required=True)

    sub.add_parser("check", help="validate only")

    args = ap.parse_args(argv)
    path = Path(args.file).expanduser()
    try:
        if args.cmd == "list":
            return cmd_list(path, args.json)
        if args.cmd == "propose":
            return cmd_propose(path, args)
        if args.cmd == "accept":
            return cmd_transition(path, args, "accepted")
        if args.cmd == "reject":
            return cmd_transition(path, args, "rejected")
        if args.cmd == "check":
            return cmd_check(path)
    except LessonsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
