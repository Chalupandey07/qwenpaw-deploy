#!/usr/bin/env python3
"""Check every relative markdown link and every backticked repo path.

Fifteen feature READMEs and six root docs reference each other by path. A
rename silently breaks them, and a broken link in AGENTS.md sends a new agent
somewhere that does not exist — which is worse than no link.

Two checks:
  1. relative markdown links (`[text](path)`) resolve to a real file
  2. backticked paths that look like repo paths (`features/x/y.py`) exist

Deliberately conservative: it only reports a backticked path as missing when
it *looks like* a repo path (starts with a known top-level dir) and contains a
dot-extension, so prose like `installed: true` is not flagged.

Run: python3 scripts/check-links.py
Exit 0 = clean, 1 = broken links found.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

REPO = Path(__file__).resolve().parents[1]

# Directories that mark a backticked string as "a repo path, so it must exist".
TOP_LEVEL = (
    "features", "instabox", "pages", "scripts", "worker", ".github",
)
# Root files that may be referenced by bare name.
ROOT_FILES_HINT = re.compile(r"^[A-Z][A-Z0-9_-]*\.md$")

# Files that are a verbatim copy of third-party READMEs. Their relative links
# resolve against the ORIGINAL repo on github.com, never against our tree, so
# checking them here produces guaranteed false positives.
SKIP_FILES = ("features/jev/awesome-jev-tools-full-list.md",)

# [text](target) — not images, not absolute URLs, not anchors.
MD_LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
# `some/path.ext` in backticks.
CODE_PATH = re.compile(r"`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`")


def md_files() -> list[Path]:
    out = []
    for p in REPO.rglob("*.md"):
        if ".git" in p.parts:
            continue
        out.append(p)
    return sorted(out)


def is_external(target: str) -> bool:
    return bool(
        re.match(r"^(https?:|mailto:|tel:|data:|#)", target)
    )


def resolve(base: Path, target: str) -> Path:
    # Strip an anchor and any query.
    target = target.split("#", 1)[0].split("?", 1)[0]
    target = unquote(target)
    if not target:
        return base
    if target.startswith("/"):
        return REPO / target.lstrip("/")
    return (base.parent / target).resolve()


def looks_like_repo_path(text: str) -> bool:
    if text.startswith(("/", "~")) or "://" in text:
        return False
    if any(ch in text for ch in ' "<>()[]{}*'):
        return False
    first = text.split("/", 1)[0]
    if first in TOP_LEVEL and "/" in text:
        return True
    return False


def main() -> int:
    problems: list[str] = []
    files = md_files()
    checked_links = 0
    checked_paths = 0

    for md in files:
        rel_posix = md.relative_to(REPO).as_posix()
        if rel_posix in SKIP_FILES:
            continue
        try:
            text = md.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rel = md.relative_to(REPO)

        for m in MD_LINK.finditer(text):
            raw = m.group(1).strip()
            if is_external(raw):
                continue
            # A link with a title: [x](path "title")
            target = raw.split(" ")[0].strip()
            if is_external(target):
                continue
            checked_links += 1
            if not resolve(md, target).exists():
                line = text[: m.start()].count("\n") + 1
                problems.append(f"{rel}:{line}  broken link -> {target}")

        for m in CODE_PATH.finditer(text):
            cand = m.group(1)
            if not looks_like_repo_path(cand):
                continue
            checked_paths += 1
            # A path annotated as removed is intentionally gone: the docs keep
            # the name so the history is readable, with a pointer to where the
            # thing lives now. Flagging it would force us to delete history.
            tail = text[m.end():m.end() + 60]
            if "(removed" in tail:
                continue
            if not (REPO / cand).exists():
                line = text[: m.start()].count("\n") + 1
                problems.append(f"{rel}:{line}  missing path -> {cand}")

    print(f"scanned {len(files)} markdown files")
    print(f"  {checked_links} relative links, {checked_paths} repo paths")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for p in problems:
            print(f"  {p}")
        return 1
    print("all links and paths resolve")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
