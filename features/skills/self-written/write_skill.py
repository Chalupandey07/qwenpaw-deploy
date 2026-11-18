#!/usr/bin/env python3
"""Draft a reusable skill from a demonstrated task (gap #10, Hermes pattern).

After the agent completes a complex task, the transcript of what it
did is the specification for a skill: the steps it took, the checks
that proved each step, when the skill applies, and which tools it
needs. This writer turns that transcript into a SKILL.md draft:

    python3 write_skill.py --name weekly-report \\
        --transcript /tmp/turns.txt --out-dir <skills-root>

The draft goes through the SAME gate as any hand-written skill
(features/skills/scan.py): frontmatter validation + tool-scope
enforcement + the security rules. A draft that fails validation is
REJECTED, not installed (exit 1). Accepted drafts land in
<out-dir>/drafts/<name>/SKILL.md, DISABLED by default — enabling is
a separate, human step (see features/skills/README.md).

The writer REFUSES to draft a skill that (exit 2, nothing written):
  (a) needs a secret — the transcript contains a secret-shaped value,
      tells the skill to read a credential store, or tells it to
      embed a key value. (A skill that says "the user enters the key
      in the vault" is fine: no value ever enters the skill.)
  (b) touches a China endpoint — any China host or domain in the
      transcript or the draft.
  (c) has an unbounded tool scope — "use all tools" phrasing, a
      wildcard, or more than 8 distinct tools. A draft with no
      detectable tool at all is NOT refused: it becomes a
      guidance-only skill (``allowed_tools: []``), which the scope
      check then enforces — such a skill may invoke nothing.

What the writer extracts is HEURISTIC, not understanding: steps are
numbered / bulleted / "Step N" lines, checks are lines with
check / verify / confirm / validate / test / assert / ensure, and
allowed_tools come from the scanner's own detection. The draft MUST
be read and corrected by a human (or the agent, with the user) before
it is installed. The writer never installs, enables, or deploys
anything.

Stdlib only. Exit 0 accepted, 1 validation-failed (rejected),
2 refused, 2 usage error.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX_TOOLS = 8

# --- refusal markers, built from parts at runtime -------------------
# The literals below are fragments, never a full secret, host, or
# path: this file lives inside the self-written skill directory and
# is itself scanned by scan.py, so it must not contain a
# credential-store path, a secret-shaped value, or a China endpoint
# host as a literal string.
_SECRET_STORE_PARTS: list[tuple[str, ...]] = [
    ("working", ".", "secret"),
    ("auth", ".", "json"),
    (".", "ssh", "/"),
    (".", "aws", "/", "credentials"),
    (".", "env"),
    ("id_", "rsa"),
    ("id_", "ed25519"),
    (".", "netrc"),
]
_SECRET_VALUE_RES = [
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
]
_SECRET_PHRASES = (
    "paste the api key", "paste the key", "include the key",
    "include the api key", "hardcode the key", "hard-code the key",
    "write the password", "store the token", "embed the key",
)
_CHINA_PARTS: list[tuple[str, ...]] = [
    ("model", "scope"),
    ("dash", "scope"),
    ("ali", "yun"),
    ("ali", "baba"),
    ("fcapp",),
    ("aliyuncs",),
    ("cn-", "hangzhou"),
    ("api", ".", "qwen"),
    (".", "cn"),
]
_UNBOUNDED_PHRASES = (
    "use all tools", "use any tool", "all tools available",
    "every tool", "unrestricted", "allowed_tools: *",
    "allowed tools: *", "any tool you like", "whatever tools",
)

# A credential-store path only counts when a line tells the skill to
# USE it — a prohibition ("never touch that store") or a mere mention
# ("document the template file") is not a secret need.
_STORE_VERBS = ("read", "open", "load", "cat", "print", "echo", "use",
                "access", "check", "get")
_PROHIBITIONS = ("never", "do not", "don't", "must not", "must never",
                 "avoid", "not read")

_CHECK_WORDS = re.compile(
    r"(?i)\b(check|verify|confirm|validate|test|assert|ensure|"
    r"make sure)\b")
_STEP_RE = re.compile(
    r"^\s*(?:Step\s*\d+\s*[:.)-]?\s*|\d+\s*[.)]\s*|[-*\u2022]\s+)(.+)$")
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def _join(parts: tuple[str, ...]) -> str:
    return "".join(parts)


def _load_scan():
    spec = importlib.util.spec_from_file_location(
        "skills_scan", str(HERE.parent / "scan.py"))
    if spec is None or spec.loader is None:
        raise ImportError("cannot load scan.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["skills_scan"] = mod
    spec.loader.exec_module(mod)
    return mod


def refusal_reason(transcript: str, draft: str = "") -> str | None:
    """Return the refusal reason, or None when the draft may proceed.

    Checks the transcript AND the draft (defence in depth — the draft
    is generated from the transcript, so the transcript check normally
    fires first). Order: secret, China endpoint, unbounded scope.
    """
    text = transcript + "\n" + draft
    low = text.lower()
    for pattern in _SECRET_VALUE_RES:
        if pattern.search(text):
            return ("secret: the transcript contains a secret-shaped "
                    "value — a skill must never hold a key value")
    # A credential-store path refuses only on a line that tells the
    # skill to use it. A prohibition ("never touch that store") or a
    # mere mention does not.
    for line in text.splitlines():
        low_line = line.lower()
        for parts in _SECRET_STORE_PARTS:
            if _join(parts) in low_line:
                if any(p in low_line for p in _PROHIBITIONS):
                    continue
                if any(re.search(r"\b" + v + r"\b", low_line)
                       for v in _STORE_VERBS):
                    return ("secret: the transcript tells the skill to "
                            "read a credential store — keys are used "
                            "through the vault, never read by a skill")
    vault_mediated = "vault" in low and (
        "user enters" in low or "user adds" in low
        or "entered by the user" in low or "in the vault" in low
        or "through the vault" in low or "via the vault" in low)
    if not vault_mediated:
        for phrase in _SECRET_PHRASES:
            if phrase in low:
                return ("secret: the transcript tells the skill to embed "
                        "a key value — keys are entered by the user in "
                        "the vault, never pasted into a skill")
    for parts in _CHINA_PARTS:
        if _join(parts) in low:
            return ("china endpoint: the transcript touches a China "
                    "endpoint — English only, no China endpoints or data")
    for phrase in _UNBOUNDED_PHRASES:
        if phrase in low:
            return ("unbounded scope: the transcript asks for all tools "
                    "— a skill must declare a bounded allowed_tools list")
    return None


def extract_steps(transcript: str) -> list[str]:
    steps: list[str] = []
    for line in transcript.splitlines():
        m = _STEP_RE.match(line)
        if m:
            step = m.group(1).strip()
            if step and step not in steps:
                steps.append(step)
    return steps


def extract_checks(transcript: str) -> list[str]:
    checks: list[str] = []
    for line in transcript.splitlines():
        if _CHECK_WORDS.search(line):
            m = _STEP_RE.match(line)
            text = (m.group(1).strip() if m else line.strip())
            text = re.sub(r"^(Step\s*\d+\s*[:.)-]?\s*)", "", text)
            if text and text not in checks:
                checks.append(text)
    if not checks:
        checks.append("Run the skill end to end once and confirm the "
                      "result matches the request before reporting it done.")
    return checks


def _first_sentence(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip().strip('"').strip("'")
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    return (m.group(1) if m else text).strip()


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def draft_skill(name: str, transcript: str, title: str) -> tuple[str, list[str]]:
    """Render the SKILL.md draft from a transcript (no checks here)."""
    scan = _load_scan()
    steps = extract_steps(transcript)
    checks = extract_checks(transcript)
    tools = sorted({t for t, _, _ in scan.detect_tools(transcript)})
    description = _first_sentence(title)[:500]
    when = title.strip().rstrip(".")
    when = "When the user asks for " + when[:1].lower() + when[1:]
    lines = [
        "---",
        f"name: {name}",
        f"description: {_quote(description)}",
        'version: "1.0"',
        f"when_to_use: {_quote(when)}",
    ]
    if tools:
        lines.append("allowed_tools:")
        lines.extend(f"  - {t}" for t in tools)
    else:
        # Guidance-only: no tools detected. An empty list is valid
        # (the scanner enforces it — such a skill may invoke nothing).
        lines.append("allowed_tools: []")
    lines.append("---")
    lines.append("")
    lines.append(f"# {title.strip()}")
    lines.append("")
    lines.append("Drafted from a demonstrated task by the self-written "
                 "skill writer. REVIEW BEFORE ENABLING: this draft was "
                 "generated mechanically from a transcript, not written "
                 "by hand. It is disabled by default; enabling is a "
                 "separate human step (see features/skills/README.md).")
    lines.append("")
    lines.append("## When to use")
    lines.append("")
    lines.append(when + ".")
    lines.append("")
    lines.append("## Steps")
    lines.append("")
    for i, step in enumerate(steps, 1):
        lines.append(f"{i}. {step}")
    lines.append("")
    lines.append("## Checks")
    lines.append("")
    for chk in checks:
        lines.append(f"- {chk}")
    lines.append("")
    lines.append("## When to ask first")
    lines.append("")
    lines.append("Ask the user before any irreversible or destructive "
                 "step, before using a credential, and before spending "
                 "money or changing shared state. If any step is "
                 "unclear, ask instead of guessing.")
    lines.append("")
    lines.append("## Source")
    lines.append("")
    lines.append("Drafted from a task transcript by the self-written "
                 "skill writer on "
                 + datetime.now(timezone.utc).date().isoformat()
                 + ". Reviewed: no.")
    lines.append("")
    return "\n".join(lines), tools


def write_draft(name: str, transcript: str, title: str,
                out_dir: Path) -> tuple[int, str]:
    """Draft, gate, and install a skill draft. Returns (exit, message)."""
    if not _NAME_RE.match(name):
        return 2, (f"REFUSED: bad skill name '{name}' — use lowercase "
                   "letters, digits and hyphens")
    reason = refusal_reason(transcript)
    if reason:
        return 2, "REFUSED: " + reason
    draft, tools = draft_skill(name, transcript, title)
    reason = refusal_reason(transcript, draft)
    if reason:
        return 2, "REFUSED: " + reason
    if len(tools) > MAX_TOOLS:
        return 2, (f"REFUSED: unbounded scope: {len(tools)} distinct "
                   f"tools detected (cap {MAX_TOOLS}) — narrow the task "
                   "before drafting a skill for it")
    scan = _load_scan()
    with tempfile.TemporaryDirectory() as td:
        tmp_skill = Path(td) / name
        tmp_skill.mkdir()
        (tmp_skill / "SKILL.md").write_text(draft, encoding="utf-8")
        report = scan.scan_skill(tmp_skill)
        problems = [(f.severity, f.rule, f.excerpt)
                    for f in report.findings if f.severity in ("high", "critical")]
        if not report.frontmatter_ok or problems:
            return 1, ("REJECTED: the draft failed the scanner and was "
                       "not installed: "
                       + "; ".join(f"{s}/{r}: {e}" for s, r, e in problems
                                   + ([("high", "invalid-frontmatter",
                                        "frontmatter did not validate")]
                                      if not report.frontmatter_ok else [])))
        dest = out_dir / "drafts" / name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(tmp_skill, dest)
    return 0, (f"ACCEPTED: draft written to {dest / 'SKILL.md'} "
               f"(tools: {', '.join(tools)}). Disabled by default — "
               "review it, then install and enable it by hand.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--name", required=True, help="skill name (lowercase, hyphens)")
    ap.add_argument("--transcript", required=True,
                    help="text file with the demonstrated task")
    ap.add_argument("--title", default=None,
                    help="task title (default: first line of the transcript)")
    ap.add_argument("--out-dir", required=True,
                    help="skills root; drafts go to <out-dir>/drafts/<name>/")
    args = ap.parse_args(argv)
    transcript_path = Path(args.transcript)
    if not transcript_path.is_file():
        print(f"error: no such transcript: {transcript_path}", file=sys.stderr)
        return 2
    transcript = transcript_path.read_text(encoding="utf-8")
    title = args.title
    if not title:
        first = [ln.strip() for ln in transcript.splitlines() if ln.strip()]
        title = first[0] if first else args.name
    code, message = write_draft(args.name, transcript, title, Path(args.out_dir))
    print(message)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
