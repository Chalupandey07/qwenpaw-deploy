#!/usr/bin/env python3
"""Machine-free tests for skills as progressive-disclosure packages (T129).

Covers the gap-#10 work in features/skills/:
  * frontmatter schema (name, description, when_to-use, allowed tools)
    validated by the scanner (features/skills/scan.py);
  * tool-scope enforcement (a skill body invoking a tool outside its
    declared allowed-tools list is flagged);
  * the index builder (features/skills/build_index.py) — only the index
    (name + description + when-to-use + allowed tools) is loaded by
    default, never full bodies;
  * the self-written skill writer (features/skills/self-written/
    write_skill.py) — drafts a reusable skill from a demonstrated task
    transcript, passes it through the SAME scanner before accepting it,
    and REFUSES drafts that need a secret, touch a China endpoint, or
    have an unbounded tool scope;
  * the mechanical frontmatter converter (features/skills/convert.py).

Usage:
    python3 test_skills_packages.py                       # must PASS
    python3 test_skills_packages.py --scan /tmp/old-scan.py
        # fail-first: point --scan at the PRE-change scan.py (no
        # frontmatter check, no scope enforcement) and the test FAILS.
        # Get one with: git show HEAD:features/skills/scan.py > /tmp/old-scan.py

Everything runs in a temporary directory; no live skill, machine file,
or repo skill is touched. Fixture strings that look like secrets or
China endpoints are built from parts at runtime, so this file itself
contains no secret-shaped literal and no China endpoint literal
(the repo's scripts/checks/ scan this file).
"""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILLS = HERE  # scan.py, build_index.py, convert.py live beside this test
WRITER = HERE / "self-written" / "write_skill.py"

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def load_module(path: Path, mod_name: str):
    """Load a .py file standalone; returns (module, error-or-None)."""
    spec = importlib.util.spec_from_file_location(mod_name, str(path))
    if spec is None or spec.loader is None:
        return None, f"no spec for {path}"
    mod = importlib.util.module_from_spec(spec)
    # exec_module needs the module registered first (dataclasses and
    # other module-level machinery look it up via sys.modules).
    sys.modules[mod_name] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 - the failure IS the check
        return None, f"{type(exc).__name__}: {exc}"
    return mod, None


# ---------------------------------------------------------------- fixtures

BODY_SENTINEL = "SENTINEL_BODY_TEXT_XYZ_9f31"

VALID_SKILL = f"""---
name: demo-search
description: "Search the web for a topic and summarise the top results."
version: "1.0"
when_to_use: "When the user asks for current information from the live web."
allowed_tools:
  - web_search
  - web_fetch
  - shell
---

# Demo search

Use the web_search tool for the query, then web_fetch on the best
result. {BODY_SENTINEL} — this sentence lives only in the body and
must never appear in the index.

```bash
python3 --version
```
"""

NO_FRONTMATTER_SKILL = """# No header at all

Use the web_search tool for the query.
"""

SCOPE_SKILL = """---
name: scope-demo
description: "A skill that only searches, but its body also fetches."
version: "1.0"
when_to_use: "When the user asks for current information."
allowed_tools:
  - web_search
---

# Scope demo

Use the web_search tool for the query, then web_fetch on the best
result. The fetch is outside the declared scope.
"""

SCOPE_OK_SKILL = SCOPE_SKILL.replace(
    "  - web_search\n", "  - web_search\n  - web_fetch\n")

LEGACY_SKILL = """---
name: legacy-copy
description: "Search the web for a topic and summarise the top results."
version: "1.0"
---

# Legacy copy

Use the web_search tool for the query.
"""

GOOD_TRANSCRIPT = """Weekly report from the ticket board

Step 1: Read the file tickets.json in the workspace.
Step 2: Run python3 report.py to summarise the open tickets.
Step 3: Check the summary lists every open ticket before sending it.
Verify the counts match the board before sharing the report.
"""

# Guidance only: real steps, no tool at all. This must NOT be
# refused — it becomes a guidance-only skill (allowed_tools: []).
GUIDANCE_TRANSCRIPT = """Weekly standup notes

Step 1: Review the open tickets and pick the three most important.
Step 2: Check the summary is accurate before sharing it.
"""

# Secret-shaped fixture, built from parts at runtime (never a literal).
_FAKE_KEY = "ghp_" + "A" * 36
SECRET_TRANSCRIPT = f"""Deploy the helper with the key

Step 1: Read the file deploy.sh in the workspace.
Step 2: Paste the API key {_FAKE_KEY} into the skill so it can call the API.
Step 3: Run python3 deploy.py to finish.
"""

# China-endpoint fixture, built from parts at runtime (never a literal).
_FAKE_HOST = "https://" + "api" + "." + "model" + "scope" + "." + "cn" + "/v1/search"
CHINA_TRANSCRIPT = f"""Search the mirror catalogue

Step 1: Read the file catalogue.json in the workspace.
Step 2: Fetch results from {_FAKE_HOST} with python3 fetch.py.
Step 3: Check the results are complete before sharing them.
"""

WILDCARD_TRANSCRIPT = """Do everything with every tool

Step 1: Read the file notes.md in the workspace.
Step 2: Use all tools available to finish the task however you like.
Step 3: Check the result before sharing it.
"""


def write_skill_dir(root: Path, name: str, text: str) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(text, encoding="utf-8")
    return d


def run_writer(transcript: Path, name: str, out_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(WRITER), "--name", name,
         "--transcript", str(transcript), "--out-dir", str(out_dir)],
        capture_output=True, text=True, timeout=60)


def main() -> int:
    global WRITER
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan", default=str(SKILLS / "scan.py"))
    parser.add_argument("--index", default=str(SKILLS / "build_index.py"))
    parser.add_argument("--writer", default=str(WRITER))
    parser.add_argument("--convert", default=str(SKILLS / "convert.py"))
    args = parser.parse_args()
    WRITER = Path(args.writer)

    scan, err = load_module(Path(args.scan), "t129_scan")
    check("scan.py loads standalone", scan is not None, err or "")
    index_mod, err = load_module(Path(args.index), "t129_index")
    check("build_index.py loads standalone", index_mod is not None, err or "")
    convert_mod, err = load_module(Path(args.convert), "t129_convert")
    check("convert.py loads standalone", convert_mod is not None, err or "")

    has_frontmatter_check = scan is not None and hasattr(scan, "validate_frontmatter")
    has_scope = scan is not None and hasattr(scan, "detect_tools")
    check("scanner exposes validate_frontmatter (new in gap #10)",
          has_frontmatter_check, "old scan.py has no frontmatter check")
    check("scanner exposes detect_tools for scope enforcement (new in gap #10)",
          has_scope, "old scan.py has no scope detection")
    if scan is None or index_mod is None or convert_mod is None:
        print(f"\n{sum(1 for _, ok, _ in CHECKS if ok)} passed, "
              f"{len(CHECKS) - sum(1 for _, ok, _ in CHECKS if ok)} failed")
        return 1

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        pool = root / "pool"
        pool.mkdir()
        valid = write_skill_dir(pool, "demo-search", VALID_SKILL)
        nofm = write_skill_dir(pool, "no-header", NO_FRONTMATTER_SKILL)
        scope = write_skill_dir(pool, "scope-demo", SCOPE_SKILL)
        scope_ok = write_skill_dir(pool, "scope-ok", SCOPE_OK_SKILL)

        # --- (a) valid frontmatter passes the scanner, index is index-only
        rep = scan.scan_skill(valid)
        check("(a) valid skill: frontmatter_ok is True",
              getattr(rep, "frontmatter_ok", False) is True)
        check("(a) valid skill: no missing-frontmatter finding",
              not any(f.rule == "missing-frontmatter" for f in rep.findings))
        check("(a) valid skill: no scope-violation finding",
              not any(f.rule == "scope-violation" for f in rep.findings),
              str([(f.rule, f.excerpt) for f in rep.findings]))
        check("(a) valid skill: worst is clean", rep.worst() == "clean",
              str([(f.severity, f.rule) for f in rep.findings]))
        entries = index_mod.build_index_dict(pool)
        by_name = {e["name"]: e for e in entries}
        check("(a) index: demo-search entry exists", "demo-search" in by_name)
        e = by_name.get("demo-search", {})
        check("(a) index: entry has name/description/when_to_use",
              bool(e.get("name")) and bool(e.get("description"))
              and bool(e.get("when_to_use")))
        check("(a) index: entry allowed_tools matches the declared list",
              e.get("allowed_tools") == ["web_search", "web_fetch", "shell"],
              str(e.get("allowed_tools")))
        check("(a) index: entry contains no body text (sentinel absent)",
              BODY_SENTINEL not in str(e))

        # --- (b) missing frontmatter FAILS the scanner
        rep2 = scan.scan_skill(nofm)
        check("(b) missing frontmatter: missing-frontmatter finding present",
              any(f.rule == "missing-frontmatter" for f in rep2.findings))
        check("(b) missing frontmatter: frontmatter_ok is False",
              getattr(rep2, "frontmatter_ok", True) is False)
        check("(b) missing frontmatter: worst is high",
              rep2.worst() == "high", rep2.worst())

        # --- (c) tool outside the declared scope is flagged
        rep3 = scan.scan_skill(scope)
        viol = [f for f in rep3.findings if f.rule == "scope-violation"]
        check("(c) scope: scope-violation finding present", len(viol) >= 1)
        check("(c) scope: finding names the out-of-scope tool (web_fetch)",
              any("web_fetch" in f.excerpt for f in viol),
              str([(f.excerpt) for f in viol]))
        check("(c) scope: worst is high", rep3.worst() == "high", rep3.worst())
        rep4 = scan.scan_skill(scope_ok)
        check("(c) scope control: same body with web_fetch allowed is clean",
              not any(f.rule == "scope-violation" for f in rep4.findings),
              str([(f.rule, f.excerpt) for f in rep4.findings]))

        # --- (d) writer drafts a valid skill from a demonstrated transcript
        transcript = root / "good-transcript.txt"
        transcript.write_text(GOOD_TRANSCRIPT, encoding="utf-8")
        out_dir = root / "out"
        res = run_writer(transcript, "weekly-report", out_dir)
        check("(d) writer: exit 0 on a clean transcript", res.returncode == 0,
              (res.stdout + res.stderr)[-300:])
        draft = out_dir / "drafts" / "weekly-report" / "SKILL.md"
        check("(d) writer: draft file exists at drafts/<name>/SKILL.md",
              draft.is_file())
        if draft.is_file():
            text = draft.read_text(encoding="utf-8")
            meta, _body = scan.parse_frontmatter(text)
            check("(d) writer: draft frontmatter parses with the right name",
                  meta.get("name") == "weekly-report", str(meta))
            check("(d) writer: draft has when_to_use",
                  bool(meta.get("when_to_use")))
            check("(d) writer: draft has a Steps section with >= 2 steps",
                  "## Steps" in text and text.count("1. ") + text.count("2. ") >= 1
                  and len([ln for ln in text.splitlines()
                           if ln.strip().startswith(("1.", "2.", "3."))]) >= 2)
            check("(d) writer: draft has a Checks section",
                  "## Checks" in text)
            check("(d) writer: draft has a when-to-ask-first section",
                  "ask first" in text.lower())
            drep = scan.scan_skill(draft.parent)
            check("(d) writer: draft passes the scanner "
                  "(frontmatter_ok, no scope-violation)",
                  getattr(drep, "frontmatter_ok", False) is True
                  and not any(f.rule == "scope-violation" for f in drep.findings),
                  str([(f.severity, f.rule, f.excerpt) for f in drep.findings]))
        else:
            for n in ("draft frontmatter parses with the right name",
                      "draft has when_to_use",
                      "draft has a Steps section with >= 2 steps",
                      "draft has a Checks section",
                      "draft has a when-to-ask-first section",
                      "draft passes the scanner "
                      "(frontmatter_ok, no scope-violation)"):
                check("(d) writer: " + n, False, "no draft file")

        # --- (d2) guidance-only: no tool is bounded, not unbounded
        guide_t = root / "guidance-transcript.txt"
        guide_t.write_text(GUIDANCE_TRANSCRIPT, encoding="utf-8")
        res = run_writer(guide_t, "standup-notes", out_dir)
        check("(d2) writer: guidance-only transcript is accepted (exit 0)",
              res.returncode == 0, (res.stdout + res.stderr)[-300:])
        gd = out_dir / "drafts" / "standup-notes" / "SKILL.md"
        check("(d2) writer: guidance-only draft file exists", gd.is_file())
        if gd.is_file():
            gmeta, _ = scan.parse_frontmatter(
                gd.read_text(encoding="utf-8"))
            check("(d2) writer: guidance-only draft has allowed_tools: []",
                  gmeta.get("allowed_tools") == [], str(gmeta))
            grep = scan.scan_skill(gd.parent)
            check("(d2) writer: guidance-only draft passes the scanner",
                  getattr(grep, "frontmatter_ok", False) is True
                  and grep.worst() == "clean",
                  str([(f.severity, f.rule) for f in grep.findings]))
        else:
            check("(d2) writer: guidance-only draft has allowed_tools: []",
                  False, "no draft file")
            check("(d2) writer: guidance-only draft passes the scanner",
                  False, "no draft file")

        # --- (e) writer REFUSES secret / China / unbounded drafts
        secret_t = root / "secret-transcript.txt"
        secret_t.write_text(SECRET_TRANSCRIPT, encoding="utf-8")
        res = run_writer(secret_t, "secret-skill", out_dir)
        check("(e) writer: secret draft refused (nonzero exit)",
              res.returncode != 0, f"exit={res.returncode}")
        check("(e) writer: refusal reason names the secret",
              "secret" in (res.stdout + res.stderr).lower())
        check("(e) writer: refused draft writes no file",
              not (out_dir / "drafts" / "secret-skill" / "SKILL.md").exists())
        china_t = root / "china-transcript.txt"
        china_t.write_text(CHINA_TRANSCRIPT, encoding="utf-8")
        res = run_writer(china_t, "china-skill", out_dir)
        check("(e) writer: China-endpoint draft refused (nonzero exit)",
              res.returncode != 0, f"exit={res.returncode}")
        check("(e) writer: refusal reason names the endpoint",
              "china" in (res.stdout + res.stderr).lower()
              or "endpoint" in (res.stdout + res.stderr).lower())
        check("(e) writer: refused China draft writes no file",
              not (out_dir / "drafts" / "china-skill" / "SKILL.md").exists())
        wild_t = root / "wildcard-transcript.txt"
        wild_t.write_text(WILDCARD_TRANSCRIPT, encoding="utf-8")
        res = run_writer(wild_t, "wild-skill", out_dir)
        check("(e) writer: unbounded-scope (all tools) draft refused",
              res.returncode != 0, f"exit={res.returncode}")

        # --- (f) the index builder loads only the index, not full bodies
        index_path = root / "index.json"
        built = index_mod.build_index(pool, index_path)
        raw = index_path.read_text(encoding="utf-8")
        check("(f) index: index.json contains no body text (sentinel absent)",
              BODY_SENTINEL not in raw)
        loaded = index_mod.load_index(index_path)
        check("(f) index: load_index returns entries with no body key",
              all("body" not in e for e in loaded))
        bodies = sum((d / "SKILL.md").stat().st_size
                     for d in (valid, nofm, scope, scope_ok))
        check("(f) index: index file is smaller than the bodies it indexes",
              index_path.stat().st_size < bodies,
              f"index={index_path.stat().st_size} bodies={bodies}")
        check("(f) index: only valid-frontmatter skills are indexed",
              {e["name"] for e in loaded} == {"demo-search", "scope-demo", "scope-ok"},
              str([e["name"] for e in loaded]))

        # --- (g) mechanical conversion: header only, body untouched
        # A legacy skill has the OLD frontmatter (name + description only,
        # like the real memory / tinyfish / vault skills) and is missing
        # the two new fields. Conversion adds them; the body is untouched.
        legacy = write_skill_dir(root, "legacy-copy", LEGACY_SKILL)
        _before_meta, before_body = scan.parse_frontmatter(
            (legacy / "SKILL.md").read_text(encoding="utf-8"))
        changed = convert_mod.convert_skill(legacy, write=True)
        after = (legacy / "SKILL.md").read_text(encoding="utf-8")
        _meta, after_body = scan.parse_frontmatter(after)
        check("(g) convert: adds when_to_use + allowed_tools to the header",
              bool(_meta.get("when_to_use")) and bool(_meta.get("allowed_tools")),
              str(changed))
        check("(g) convert: body bytes are unchanged",
              after_body.strip() == before_body.strip())
        changed2 = convert_mod.convert_skill(legacy, write=True)
        check("(g) convert: second run changes nothing (idempotent)",
              changed2 == {} or changed2.get("changed") in (False, [], {}),
              str(changed2))

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        print("failed: " + ", ".join(n for n, ok, _ in CHECKS if not ok))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
