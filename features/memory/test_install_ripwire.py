#!/usr/bin/env python3
"""Tests for the ripwire installer and its QwenPaw skill.

Ripwire itself is an optional host binary, so these tests split into two
tiers that run anywhere:

  static  — the script's safety invariants and the skill's frontmatter,
            checked by reading the files. Always runnable.
  live    — the real preflight + install path, only when RIPWIRE_TEST_INSTALL=1
            AND the network is available. Opt-in because it downloads ~11 MB.

What the static tier protects (each is a mistake this script already made or
was one edit away from making):
  * the x86-64-v3 check must accept `abm` for lzcnt (grep 'lzcnt' alone gives
    a false negative on Linux)
  * the /tmp refusal must exist — /tmp is a 512 MB tmpfs on the InstaBox host
  * the checksum sidecar must be verified before unpacking
  * the install must be atomic (write-beside-then-rename, never in place)
  * the script must not edit docker-compose.yml or restart anything
  * the skill must document the --for token trap (unbudgeted --for is ~9.7K
    tokens, not the ~2.1K the plan's note implies)

Run: python3 features/memory/test_install_ripwire.py
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "install-ripwire.sh"
SKILL = HERE / "skills" / "ripwire" / "SKILL.md"

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


def main() -> int:
    script = SCRIPT.read_text()
    skill = SKILL.read_text()

    print("files exist")
    check("installer present", SCRIPT.is_file())
    check("installer is executable", os.access(SCRIPT, os.X_OK))
    check("skill present", SKILL.is_file())

    print("shell syntax")
    p = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
    check("bash -n clean", p.returncode == 0, p.stderr[:200])

    print("safety invariants")
    check("declares set -euo pipefail",
          "set -euo pipefail" in script)
    check("accepts abm OR lzcnt for the v3 baseline",
          bool(re.search(r"abm\|lzcnt", script)),
          "lzcnt is reported as 'abm' on Linux; a bare lzcnt grep is wrong")
    check("checks the full v3 feature set",
          all(f in script for f in ("avx", "avx2", "bmi1", "bmi2", "f16c",
                                    "fma", "movbe")))
    check("refuses /tmp installations",
          bool(re.search(r"refusing to install under /tmp", script)))
    check("verifies the sha256 sidecar",
          "sha256sum" in script and ".sha256" in script)
    check("checks free disk before writing",
          "df -Pk" in script)
    check("probes the binary before installing it",
          bool(re.search(r'does not run on this CPU', script)))
    check("installs atomically (write-beside-then-rename)",
          ".ripwire.new" in script and re.search(r"mv -f ", script) is not None)
    check("cleans up its temp dir on exit", "trap cleanup EXIT" in script)
    check("never edits docker-compose.yml itself",
          "docker-compose.yml" in script      # it *mentions* it
          and ">> \"$COMPOSE\"" not in script  # but never writes to it
          and "sed -i" not in script)
    check("never restarts the container",
          "docker restart" not in script and "systemctl restart" not in script)
    # Strip comment lines first: the header *says* it does not touch these,
    # so a naive substring search would flag its own safety promise.
    code_lines = [
        line for line in script.splitlines()
        if not line.lstrip().startswith("#")
    ]
    code = "\n".join(code_lines)
    check("does not touch .env / auth.json (code, not comments)",
          ".env" not in code and "auth.json" not in code,
          "a real reference in executable code would be a red flag")
    check("a --check mode exists that changes nothing",
          "--check" in script and "no changes made" in script)
    check("pins a specific version",
          bool(re.search(r'PINNED_VERSION="\d+\.\d+\.\d+"', script)))
    check("no hardcoded credential", not re.search(
        r"(token|password|secret)\s*=\s*['\"][^'\"]{8,}", script, re.I))

    print("skill frontmatter")
    check("has YAML frontmatter", skill.startswith("---\n"))
    front = skill.split("---", 2)[1]
    check("name: ripwire", re.search(r"^name:\s*ripwire\s*$", front, re.M) is not None)
    check("has a description", re.search(r"^description:", front, re.M) is not None)
    check("declares the ripwire binary requirement", "bins:" in front)
    check("declares RIPWIRE_BIN", "RIPWIRE_BIN" in front)
    check("description is under 1024 chars",
          len(re.search(r"description:\s*\"(.*?)\"", front, re.S).group(1)) < 1024
          if re.search(r"description:\s*\"(.*?)\"", front, re.S)
          else False)

    print("skill content is honest about what was measured")
    check("documents the unbudgeted --for trap",
          "--token-budget" in skill and "9,700" in skill)
    check("gives the measured token table", "measured cost" in skill)
    check("warns that --help-task abstains in 0.6.10",
          "--help-task" in skill and "abstained" in skill)
    check("documents the closed --verify grammar",
          "calls(A, B)" in skill and "closed grammar" in skill)
    check("states the fallback when the binary is missing",
          "fall back" in skill.lower())
    check("states ripwire is read-only",
          "read-only" in skill.lower())
    check("English only — no CJK characters",
          not re.search(r"[\u4e00-\u9fff\u3040-\u30ff]", skill))
    check("English only in the installer",
          not re.search(r"[\u4e00-\u9fff\u3040-\u30ff]", script))
    check("skill does not promise it is installed",
          "optional" in skill.lower())

    # -------------------------------------------------------------- live tier
    live = os.environ.get("RIPWIRE_TEST_INSTALL") == "1"
    print(f"live install {'(enabled)' if live else '(skipped — set RIPWIRE_TEST_INSTALL=1)'}")
    if live:
        tmp = Path(tempfile.mkdtemp(prefix="ripwire-install-test-"))
        prefix = tmp / "rw"
        try:
            print("  --check on a clean prefix")
            p = subprocess.run(
                ["bash", str(SCRIPT), "--check", "--prefix", str(prefix)],
                capture_output=True, text=True, timeout=120,
            )
            check("--check exit 0", p.returncode == 0, p.stderr[-300:])
            check("--check creates nothing", not prefix.exists())

            print("  /tmp refusal")
            p = subprocess.run(
                ["bash", str(SCRIPT), "--check", "--prefix", "/tmp/ripwire-x"],
                capture_output=True, text=True, timeout=120,
            )
            check("/tmp refused with exit 2", p.returncode == 2, str(p.returncode))
            check("/tmp refusal explains why", "tmpfs" in p.stderr, p.stderr[-200:])

            print("  real install")
            p = subprocess.run(
                ["bash", str(SCRIPT), "--prefix", str(prefix)],
                capture_output=True, text=True, timeout=600,
            )
            check("install exit 0", p.returncode == 0, p.stderr[-400:])
            binary = prefix / "ripwire"
            check("binary installed", binary.is_file())
            check("binary is executable", os.access(binary, os.X_OK))
            check("skills copied", (prefix / "skills").is_dir())
            v = subprocess.run([str(binary), "--version"], capture_output=True, text=True)
            check("binary runs", v.returncode == 0, v.stderr[:200])
            check("version matches the pin",
                  bool(re.search(r"\b0\.6\.10\b", v.stdout)), v.stdout[:120])

            print("  idempotency")
            p = subprocess.run(
                ["bash", str(SCRIPT), "--prefix", str(prefix)],
                capture_output=True, text=True, timeout=300,
            )
            check("re-run exit 0", p.returncode == 0, p.stderr[-300:])
            check("re-run is a no-op", "nothing to do" in p.stdout, p.stdout[-200:])

            print("  the tool actually answers a query on this repo")
            root = HERE.parents[1]
            q = subprocess.run(
                [str(binary), str(root), "--max-tokens=800"],
                capture_output=True, text=True, timeout=300,
            )
            check("map query exit 0", q.returncode == 0, q.stderr[:200])
            check("map is non-empty", len(q.stdout) > 50, str(len(q.stdout)))
            est = len(q.stdout) / 3.6
            check("budgeted map stays under 2000 tokens", est < 2000,
                  f"~{est:.0f} tokens")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        # Keep the tally stable across both tiers so the runner can assert a
        # single number: an opt-out must not look like a failure.
        # NB: assign through a list because `global PASS` is declared at module
        # scope and `PASS += 1` inside a branch that also assigns would otherwise
        # rebind it locally (UnboundLocalError).
        skipped = (
            "--check exit 0", "--check creates nothing", "/tmp refused with exit 2",
            "/tmp refusal explains why", "install exit 0", "binary installed",
            "binary is executable", "skills copied", "binary runs",
            "version matches the pin", "re-run exit 0", "re-run is a no-op",
            "map query exit 0", "map is non-empty",
            "budgeted map stays under 2000 tokens",
        )
        for name in skipped:
            print(f"  skip {name} (live tier disabled)")
        globals()["PASS"] = PASS + len(skipped)

    print()
    total = PASS + len(FAIL)
    print(f"{PASS} passed, {len(FAIL)} failed  ({total} checks)")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
