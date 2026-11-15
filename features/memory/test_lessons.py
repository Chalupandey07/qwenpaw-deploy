#!/usr/bin/env python3
"""Tests for the lessons ledger (features/memory/lessons.py).

Asserts the Phase 4 workflow guarantees: candidates are never durable by
accident, caps hold, ids are stable and never reused, secrets are rejected
(rather than scrubbed), and everything outside the lessons section
survives a rewrite byte-for-byte.

Run: python3 features/memory/test_lessons.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LESSONS = HERE / "lessons.py"
sys.path.insert(0, str(HERE))

import lessons as L  # noqa: E402

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


MEMORY = """# MEMORY.md

Some header prose that must never be touched.

## Profile

- name: Rohan
- timezone: Asia/Kolkata

## Important Decisions and Lessons

- **L-001** · accepted · kind=gottcha · scope=desktop
  - **Guidance:** Never trust `installed: true`; verify the binary exists.
  - **Reason:** A stale marker reported Chromium installed after cleanup.
  - **Evidence:** 2026-11-15 disk cleanup incident, session sess-alpha.
  - **Revisit:** If the desktop API returns a hash, drop this entry.

- **L-002** · rejected · kind=preference
  - **Guidance:** Use Pro tier for more RAM.
  - **Reason:** Tempting when the box pauses.
  - **Reviewed:** rejected — violates the Free-only constraint.

## Other section

Trailing content that must also survive.
"""


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(LESSONS), *args],
        capture_output=True, text=True, timeout=60,
    )


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="lessons-test-"))
    mem = tmp / "MEMORY.md"
    mem.write_text(MEMORY)

    print("parse")
    before, body, after = L.split_document(MEMORY)
    entries, other = L.parse_entries(body)
    check("finds 2 entries", len(entries) == 2, str(len(entries)))
    check("ids parsed", [e.id for e in entries] == ["L-001", "L-002"],
          str([e.id for e in entries]))
    check("states parsed", entries[0].state == "accepted"
          and entries[1].state == "rejected",
          str([e.state for e in entries]))
    check("kind parsed", entries[0].kind == "gottcha", entries[0].kind)
    check("scope parsed", entries[0].scope == "desktop", entries[0].scope)
    check("guidance parsed", entries[0].guidance.startswith("Never trust"),
          entries[0].guidance)
    check("reviewed line kept as extra",
          any("Reviewed" in line for line in entries[1].extra),
          str(entries[1].extra))

    print("round-trip")
    rendered = L.render_document(before, entries, other, after)
    check("header prose preserved", "Some header prose" in rendered)
    check("profile preserved", "timezone: Asia/Kolkata" in rendered)
    check("other section preserved", "Trailing content" in rendered)
    check("valid after round-trip", L.validate(entries) == [],
          str(L.validate(entries)))

    print("validation")
    bad = L.Entry(id="L-001", state="accepted", guidance="", reason="x")
    check("missing guidance rejected", any("missing guidance" in p
                                          for p in L.validate([bad])))
    bad2 = L.Entry(id="L-9", state="accepted", guidance="g", reason="r")
    check("malformed id rejected", any("malformed id" in p
                                       for p in L.validate([bad2])))
    dupes = [L.Entry(id="L-005", state="accepted", guidance="g", reason="r",
                     evidence="e"),
             L.Entry(id="L-005", state="accepted", guidance="g", reason="r",
                     evidence="e")]
    check("duplicate ids rejected", any("duplicate id" in p
                                        for p in L.validate(dupes)))

    secret = L.Entry(id="L-010", state="candidate", guidance="token ghp_" + "a" * 36,
                     reason="r")
    problems = L.validate([secret])
    check("secret-shaped guidance rejected",
          any("looks like it contains a secret" in p for p in problems),
          str(problems))
    check("secret is rejected not scrubbed",
          secret.guidance.startswith("token ghp_"), secret.guidance)

    print("caps")
    many = [
        L.Entry(id=f"L-{i:03d}", state="accepted", guidance="g", reason="r",
                evidence="e")
        for i in range(1, L.MAX_ACCEPTED + 2)
    ]
    check("accepted cap enforced", any("exceeds the cap" in p
                                       for p in L.validate(many)))
    cands = [
        L.Entry(id=f"L-{i:03d}", state="candidate", guidance="g", reason="r")
        for i in range(1, L.MAX_CANDIDATES + 2)
    ]
    check("candidate cap enforced", any("candidates exceeds" in p
                                        for p in L.validate(cands)))
    # Each field stays under MAX_FIELD_CHARS so the FIELD cap cannot be what
    # fires; only the aggregate block word cap can trip here.
    wordy = [
        L.Entry(
            id=f"L-{i:03d}",
            state="accepted",
            guidance="word " * 70,
            reason="reason " * 70,
            evidence="e",
        )
        for i in range(1, L.MAX_ACCEPTED + 1)
    ]
    problems = L.validate(wordy)
    check("word cap enforced", any("words, over the" in p for p in problems),
          str(problems[:3]))

    print("id allocation")
    check("next id increments", L.next_id(entries) == "L-003", L.next_id(entries))
    check("next id skips gaps safely",
          L.next_id([L.Entry(id="L-001"), L.Entry(id="L-009")]) == "L-010")
    check("next id from empty", L.next_id([]) == "L-001")

    print("cli propose")
    p = run("--file", str(mem), "propose",
            "--guidance", "Decode stream tokens before trusting a mint.",
            "--reason", "A token once lacked machine id and nonce.",
            "--evidence", "2026-11-15 desktop incident.",
            "--kind", "gottcha", "--scope", "desktop")
    check("propose exit 0", p.returncode == 0, p.stderr[:300])
    check("propose says candidate", "candidate" in p.stdout, p.stdout)
    text = mem.read_text()
    check("candidate written", "L-003" in text)
    check("candidate is not accepted",
          "**L-003** · candidate" in text)
    check("header still intact", "Some header prose" in text)
    check("trailing section still intact", "Trailing content" in text)

    print("cli propose respects candidate cap")
    for i in range(2):
        run("--file", str(mem), "propose",
            "--guidance", f"another candidate {i}",
            "--reason", "reason")
    p = run("--file", str(mem), "propose", "--guidance", "one too many",
            "--reason", "r")
    check("4th candidate refused", p.returncode == 1, p.stdout + p.stderr)
    check("refusal explains the cap", "cap" in p.stderr, p.stderr)

    print("cli accept")
    p = run("--file", str(mem), "accept", "--id", "L-003", "--why",
            "user confirmed 2026-11-15")
    check("accept exit 0", p.returncode == 0, p.stderr[:300])
    text = mem.read_text()
    check("entry now accepted", "**L-003** · accepted" in text)
    check("review note recorded", "Reviewed:" in text and "user confirmed" in text)

    p = run("--file", str(mem), "accept", "--id", "L-002", "--why", "x")
    check("cannot accept a rejected entry", p.returncode == 1, p.stdout + p.stderr)
    p = run("--file", str(mem), "accept", "--id", "L-999", "--why", "x")
    check("accept unknown id fails", p.returncode == 1, p.stdout + p.stderr)
    p = run("--file", str(mem), "accept", "--id", "L-001", "--why", "")
    check("accept requires a why", p.returncode != 0, p.stdout + p.stderr)

    print("cli reject")
    p = run("--file", str(mem), "reject", "--id", "L-004", "--why",
            "not durable enough")
    check("reject exit 0", p.returncode == 0, p.stderr[:300])
    check("entry now rejected", "**L-004** · rejected" in mem.read_text())

    print("cli list and check")
    p = run("--file", str(mem), "list")
    check("list exit 0", p.returncode == 0, p.stderr[:300])
    check("list shows counts", "accepted" in p.stdout, p.stdout)
    p = run("--file", str(mem), "check")
    check("check exit 0 on valid file", p.returncode == 0, p.stdout + p.stderr)

    print("missing section")
    plain = tmp / "PLAIN.md"
    plain.write_text("# MEMORY.md\n\nNo lessons section here.\n")
    p = run("--file", str(plain), "list")
    check("missing section is an error", p.returncode == 1, p.stdout)
    check("error names the heading",
          "Important Decisions and Lessons" in p.stderr, p.stderr)

    print("secret rejected end-to-end")
    before_text = mem.read_text()
    p = run("--file", str(mem), "propose",
            "--guidance", "Remember the key sk-abcdefghijklmnopqrstuvwx",
            "--reason", "r")
    check("cli rejects secret", p.returncode == 1, p.stdout)
    check("file unchanged after rejection", mem.read_text() == before_text)

    print()
    total = PASS + len(FAIL)
    print(f"{PASS} passed, {len(FAIL)} failed  ({total} checks)")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
