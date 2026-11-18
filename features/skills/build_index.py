#!/usr/bin/env python3
"""Build the skill index — the only thing loaded by default (gap #10).

Progressive disclosure (Claude Code / OpenClaw / Hermes Agent pattern):
a skill pool can hold dozens of skills, but the always-loaded context
must stay tiny on an 8 GiB box. So the agent loads the INDEX — one
entry per skill with only name, description, when_to_use and
allowed_tools — and loads a skill's full SKILL.md body only when the
index says it matches the task.

This builder reads the YAML frontmatter of every SKILL.md under a
skills root (via features/skills/scan.py) and writes index.json with
those four fields plus version and path. It NEVER copies body text:
an index entry cannot contain a body sentence even by accident, and
the test (T129) proves it with a sentinel string.

The index is NOT a trust gate. A skill with schema-valid frontmatter
is indexed even if its body has a scope violation — the scanner
(`scan.py --fail-on high`) is the gate that blocks installing such a
skill. Indexing answers "what exists and when is it for"; scanning
answers "is it safe to install".

Usage:
    python3 features/skills/build_index.py features/skills --out index.json
    python3 features/skills/build_index.py <skills-root>   # JSON to stdout

Stdlib only. Exit 0 on success, 2 on a bad path.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
INDEX_VERSION = 1


def _load_scan():
    spec = importlib.util.spec_from_file_location(
        "skills_scan", str(HERE / "scan.py"))
    if spec is None or spec.loader is None:
        raise ImportError("cannot load scan.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["skills_scan"] = mod
    spec.loader.exec_module(mod)
    return mod


def build_index_dict(root: Path) -> list[dict]:
    """Index entries for every skill under root with valid frontmatter.

    A skill is indexed only when its frontmatter validates
    (name, description, when_to_use, allowed_tools all present and
    well-formed). A skill missing frontmatter is skipped — and listed
    on stderr so the omission is visible, not silent.
    """
    scan = _load_scan()
    entries: list[dict] = []
    skill_dirs = sorted({p.parent for p in root.rglob("SKILL.md")})
    for d in skill_dirs:
        report = scan.scan_skill(d)
        if not report.frontmatter_ok:
            print(f"skip {d.name}: frontmatter invalid "
                  f"({[f.rule for f in report.findings if 'frontmatter' in f.rule]})",
                  file=sys.stderr)
            continue
        meta = report.frontmatter
        # The directory name IS the skill's identity: the scanner
        # flags a frontmatter name that disagrees (name-mismatch,
        # MEDIUM) but the index never lets a skill load under a name
        # it does not live under.
        entries.append({
            "name": d.name,
            "description": meta.get("description"),
            "when_to_use": meta.get("when_to_use"),
            "allowed_tools": meta.get("allowed_tools"),
            "version": meta.get("version", ""),
            "path": str(d.relative_to(root)),
        })
    return entries


def build_index(root: Path, out_path: Path) -> list[dict]:
    """Write index.json for root; returns the entries written."""
    entries = build_index_dict(root)
    doc = {
        "version": INDEX_VERSION,
        "generated": datetime.now(timezone.utc).isoformat(),
        "skills": entries,
    }
    out_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return entries


def load_index(index_path: Path) -> list[dict]:
    """Load an index.json and return ONLY its entries (never bodies).

    This is the default-load path: the caller gets name, description,
    when_to_use and allowed_tools per skill, and nothing else. A full
    body is loaded separately, on a match, by reading that skill's
    SKILL.md directly.
    """
    doc = json.loads(index_path.read_text(encoding="utf-8"))
    return list(doc.get("skills", []))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("root", help="directory containing skill subdirectories")
    ap.add_argument("--out", default=None,
                    help="where to write index.json (default: stdout)")
    args = ap.parse_args(argv)
    root = Path(args.root)
    if not root.is_dir():
        print(f"error: no such directory: {root}", file=sys.stderr)
        return 2
    entries = build_index_dict(root)
    doc = {"version": INDEX_VERSION,
           "generated": datetime.now(timezone.utc).isoformat(),
           "skills": entries}
    text = json.dumps(doc, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"{len(entries)} skill(s) indexed -> {args.out}")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
