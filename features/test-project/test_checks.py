#!/usr/bin/env python3
"""Machine-free tests for the mechanical checks in scripts/checks/ (T121).

Each check is an executable that exits 0 (pass) or 1 (fail). This test
proves, for each check, that it PASSES on the current repo and FAILS on a
file that violates the rule (fail-first), using a temporary directory as
the check's ROOT so the real repo is never touched.

Run: python3 features/test-project/test_checks.py
Exit 0 = all pass. Prints "N passed, M failed" as the last line.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CHECKS = REPO / "scripts" / "checks"

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


def run(cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout + p.stderr


def run_check(name: str, root: Path, *args) -> tuple[int, str]:
    return run(["bash", str(CHECKS / name), str(root), *args])


def main() -> int:
    # --- All four checks pass on the real repo -------------------------
    rc, out = run(["bash", str(CHECKS / "run-checks.sh"), str(REPO)])
    check("run-checks.sh passes on the real repo", rc == 0, out.strip().splitlines()[-1] if out.strip() else "")
    check("run-checks.sh reports all four PASS",
          out.count("PASS check-") == 4, f"PASS count {out.count('PASS check-')}")

    # --- check-no-china-endpoints: fails on an endpoint, passes on a bare name
    # The violating URLs are built from parts at runtime so this test file
    # itself contains no China endpoint literal (the check scans the repo,
    # including this file).
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        bad = root / "x.js"
        url = "https://" + "api." + "modelscope" + ".cn" + "/v1/chat"
        bad.write_text(f'const u = "{url}";\n', encoding="utf-8")
        rc, out = run_check("check-no-china-endpoints.sh", root)
        check("china-endpoints fails on a ModelScope endpoint URL", rc != 0, out.strip().splitlines()[-1] if out.strip() else "")
        check("china-endpoints names the violating file", "x.js" in out, out[:200])
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        ok = root / "x.js"
        # A bare provider name in a comment or a hide-list is NOT an endpoint.
        ok.write_text('// Hide the "Aliyun" and "DashScope" provider cards.\n', encoding="utf-8")
        rc, out = run_check("check-no-china-endpoints.sh", root)
        check("china-endpoints passes on bare provider names", rc == 0, out.strip())
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        bad = root / "x.js"
        url = "https://" + "qwenpawelemetry-sukzkbfzhc.ap-southeast-1" + ".fcapp" + ".run"
        bad.write_text(f'const u = "{url}";\n', encoding="utf-8")
        rc, out = run_check("check-no-china-endpoints.sh", root)
        check("china-endpoints fails on a Function Compute host", rc != 0, out.strip().splitlines()[-1] if out.strip() else "")

    # --- check-no-secrets: fails on a real-shaped key, passes on a short one
    fake_key = "ghp_" + "a1b2c3d4e5f6" * 6  # 36 chars, repeating pattern — clearly synthetic, never real
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        bad = root / "x.py"
        bad.write_text(f'KEY = "{fake_key}"\n', encoding="utf-8")
        rc, out = run_check("check-no-secrets.sh", root)
        check("no-secrets fails on a ghp_ + 36-char key", rc != 0, out.strip().splitlines()[-1] if out.strip() else "")
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        ok = root / "x.py"
        ok.write_text('KEY = "ghp_short"\n', encoding="utf-8")
        rc, out = run_check("check-no-secrets.sh", root)
        check("no-secrets passes on a short ghp_ fragment", rc == 0, out.strip())
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        bad = root / "x.py"
        # AWS's documented example key, built from parts so this test file
        # itself contains no secret-shaped literal.
        bad.write_text('KEY = "' + "AKIA" + "IOSFODNN" + "7EXAMPLE" + '"\n', encoding="utf-8")
        rc, out = run_check("check-no-secrets.sh", root)
        check("no-secrets fails on an AKIA + 16-char key", rc != 0, out.strip().splitlines()[-1] if out.strip() else "")

    # --- check-agents-budget: fails on a small cap, passes on the real cap
    rc, out = run_check("check-agents-budget.sh", REPO, "100")
    check("agents-budget fails when the cap is 100 chars", rc != 0, out.strip().splitlines()[0] if out.strip() else "")
    rc, out = run_check("check-agents-budget.sh", REPO, "20000")
    check("agents-budget passes at the 20000 cap", rc == 0, out.strip())
    size = (REPO / "AGENTS.md").stat().st_size
    check("AGENTS.md is under 20000 chars", size < 20000, f"{size} chars")

    # --- check-no-polling: fails on a setInterval in server code, passes on the allowlist
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        worker = root / "pages" / "public"
        worker.mkdir(parents=True)
        bad = worker / "_worker.js"
        bad.write_text("setInterval(() => void refresh(), 10000);\n", encoding="utf-8")
        rc, out = run_check("check-no-polling.sh", root)
        check("no-polling fails on a setInterval in _worker.js", rc != 0, out.strip().splitlines()[-1] if out.strip() else "")
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        worker = root / "pages" / "public"
        worker.mkdir(parents=True)
        ok = worker / "_worker.js"
        # The waking-page elapsed timer is the documented allowlist entry.
        ok.write_text("setInterval(function(){var el=document.getElementById('elapsed');el.textContent='1s';},1000);\n", encoding="utf-8")
        rc, out = run_check("check-no-polling.sh", root)
        check("no-polling passes on the waking-page elapsed timer", rc == 0, out.strip())

    print(f"\n{PASS} passed, {len(FAIL)} failed")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
