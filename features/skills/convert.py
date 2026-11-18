#!/usr/bin/env python3
"""Mechanically convert a legacy skill to the frontmatter schema (gap #10).

A legacy skill has the OLD frontmatter (name + description, as the
upstream QwenPaw skills and our memory / tinyfish / vault skills do)
and is missing the two new fields: ``when_to_use`` and
``allowed_tools``. This tool adds ONLY those header fields:

  * ``when_to_use`` — the first sentence of the description, verbatim.
    It is a draft trigger, not a finished one: a human rewords it into
    a real trigger ("when the user asks for X") before install.
  * ``allowed_tools`` — the tools the scanner detects in the body
    (features/skills/scan.py detect_tools), sorted. If no tool is
    detected the field is left missing and the run reports why.

The body is NEVER touched: the tool rebuilds the file as the original
frontmatter lines + the new header lines + the original body, byte for
byte. It is idempotent (a second run changes nothing) and dry-run by
default — pass --write to apply.

REVIEW REQUIRED: every converted skill must be read by a human before
it is installed. The derived when_to_use is a placeholder and the
derived allowed_tools is only as good as the scanner's detection.
Conversion is the mechanical half; review is the judgement half.

Usage:
    python3 features/skills/convert.py features/memory/SKILL.md
    python3 features/skills/convert.py <skill-dir> --write
    python3 features/skills/convert.py <skill-dir> --write --force
        # --force also converts a skill with NO frontmatter at all
        # (name from the directory, description from the first body
        # sentence). Without it, a frontmatter-less skill is skipped
        # with a reason instead of guessed at.

Stdlib only. Exit 0 when nothing more needs doing (or dry-run shows
the change), 1 when a skill cannot be converted.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_scan():
    spec = importlib.util.spec_from_file_location(
        "skills_scan", str(HERE / "scan.py"))
    if spec is None or spec.loader is None:
        raise ImportError("cannot load scan.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["skills_scan"] = mod
    spec.loader.exec_module(mod)
    return mod


def _first_sentence(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip().strip('"').strip("'")
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    return (m.group(1) if m else text).strip()


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def convert_skill(skill_dir: Path, write: bool = False,
                  force: bool = False) -> dict:
    """Convert one skill's frontmatter. Returns a result dict.

    Keys: changed (bool), added (list of field names), reason (str,
    when not changed), review_required (bool, when changed).
    With write=False nothing is written; the dict describes what
    WOULD change. The body is never modified in either mode.
    """
    scan = _load_scan()
    manifest = skill_dir / "SKILL.md" if skill_dir.is_dir() else skill_dir
    if not manifest.is_file():
        return {"changed": False, "reason": "no SKILL.md found"}
    text = manifest.read_text(encoding="utf-8")
    meta, body = scan.parse_frontmatter(text)
    added: list[str] = []
    new_lines: list[str] = []

    if not meta:
        if not force:
            return {"changed": False,
                    "reason": "no frontmatter — re-run with --force to "
                              "build one from the directory name and the "
                              "first body sentence"}
        first_body = body.strip().splitlines()
        first_body = [ln for ln in first_body if ln.strip()]
        heading = ""
        for ln in first_body:
            if ln.startswith("#"):
                heading = ln.lstrip("#").strip()
                break
        first_sentence = ""
        for ln in first_body:
            if not ln.startswith("#") and ln.strip():
                first_sentence = _first_sentence(ln)
                break
        meta = {"name": skill_dir.name,
                "description": first_sentence or heading}
        new_lines = [
            "---",
            f"name: {skill_dir.name}",
            f"description: {_quote(str(meta['description']))}",
        ]
        body_text = body
        # Fall through to add when_to_use / allowed_tools below.
        header_lines = new_lines
        closing = "---"
        new_text = "\n".join(header_lines) + "\n"
        # Rebuild below via the shared path: treat as a fresh header.
        return _finish(manifest, text, body_text, meta, new_text,
                       closing, added, write, scan)

    # Existing frontmatter: keep its lines verbatim, append the new
    # fields before the closing fence.
    end = text.find("\n---", 3)
    header = text[:end]  # includes the opening --- and all header lines
    body_text = text[end + 4:]
    if isinstance(meta.get("description"), str) and meta["description"]:
        when = _first_sentence(str(meta["description"]))
    else:
        when = ""
    if not meta.get("when_to_use") and when:
        added.append("when_to_use")
    tools = sorted({t for t, _, _ in scan.detect_tools(body_text)})
    if "allowed_tools" not in meta:
        # Always added: with the detected tools, or empty for a
        # guidance-only skill (an empty list is valid — such a skill
        # may invoke nothing).
        added.append("allowed_tools")
    if not added:
        missing = [f for f in ("when_to_use",)
                   if not meta.get(f)]
        if "allowed_tools" not in meta:
            missing.append("allowed_tools")
        return {"changed": False,
                "reason": ("already complete" if not missing else
                           "cannot derive " + ", ".join(missing) +
                           " (no description sentence to derive "
                           "when_to_use from)")}
    extra = []
    if "when_to_use" in added:
        extra.append(f"when_to_use: {_quote(when)}")
    if "allowed_tools" in added:
        if tools:
            extra.append("allowed_tools:")
            extra.extend(f"  - {t}" for t in tools)
        else:
            extra.append("allowed_tools: []")
    new_text = header.rstrip("\n") + "\n" + "\n".join(extra) + "\n---" + body_text
    if write:
        manifest.write_text(new_text, encoding="utf-8")
    return {"changed": True, "added": added, "review_required": True,
            "note": "derived when_to_use is a placeholder — reword it "
                    "into a real trigger before install"}


def _finish(manifest: Path, text: str, body_text: str, meta: dict,
            new_text: str, closing: str, added: list[str],
            write: bool, scan) -> dict:
    """Shared tail for the --force no-frontmatter path."""
    when = _first_sentence(str(meta.get("description") or ""))
    tools = sorted({t for t, _, _ in scan.detect_tools(body_text)})
    extra = []
    if when:
        extra.append(f"when_to_use: {_quote(when)}")
        added.append("when_to_use")
    if tools:
        extra.append("allowed_tools:")
        extra.extend(f"  - {t}" for t in tools)
    else:
        extra.append("allowed_tools: []")
    added.append("allowed_tools")
    if not added:
        return {"changed": False,
                "reason": "cannot derive when_to_use / allowed_tools"}
    full = new_text + "\n".join(extra) + "\n" + closing + "\n" + body_text
    if write:
        manifest.write_text(full, encoding="utf-8")
    return {"changed": True, "added": added, "review_required": True,
            "note": "frontmatter built from scratch — review every "
                    "field before install"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("path", help="skill directory (or a SKILL.md file)")
    ap.add_argument("--write", action="store_true",
                    help="apply the change (default is dry-run)")
    ap.add_argument("--force", action="store_true",
                    help="also build frontmatter for a skill that has none")
    args = ap.parse_args(argv)
    result = convert_skill(Path(args.path), write=args.write,
                           force=args.force)
    print(result)
    if result.get("changed"):
        print("REVIEW REQUIRED: read the converted skill before installing it.")
        return 0
    print("no change: " + str(result.get("reason", "")))
    return 0 if "already complete" in str(result.get("reason", "")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
