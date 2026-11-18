#!/usr/bin/env python3
"""Wiring test for Approval TTL (gap #18, T132) — the derived-image half.

The module-level rule is covered by test_approval_ttl.py (T132, 41/41).
This test covers the WIRING that makes it live: the patch that gates
QwenPaw's approve/deny handlers on ttl.answer() and annotates
GET /api/approval/list via ttl.read(), plus the issue() calls in the
approval service's two creation paths.

Checks:
  W1-W8  patch integrity: the patch file exists, applies cleanly with
         -p1 (from /app, the src copy) and -p2 (site-packages copy),
         reproduces the stored patched files byte-for-byte, the
         patched files compile, and the pristine files match the
         container sha256 pins (so the patch is against the real
         live files, not a stale copy).
  G1-G9  gate presence in the patched files (and absence in the
         pristine files — the fail-first anchor: without the patch
         there is no TTL gate at all).
  F1-F9  functional: the TTL helpers extracted from the patched
         service.py, run against the real ttl.py and a temp store —
         the loader, issue, answer (ok / expired / unknown /
         answered), and read (pending, pending-past-TTL denial,
         terminal-expired normalization).

Fail-first: run this test with the patch file emptied (or against
the pristine files) and the G checks fail — the pristine handlers
call resolve_request directly with no TTL gate. The F checks use the
real ttl.py, so they pass only when the helpers are the ones in the
patched service.py.

Usage:
  python3 test_wiring.py            # 28 checks, all must pass
Exit code 0 when every test passes, 1 otherwise.
"""

from __future__ import annotations

import hashlib
import importlib.util
import logging
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH = HERE / "qwenpaw-approval-ttl.patch"
PRISTINE = HERE / "src" / "pristine"
PATCHED = HERE / "src" / "patched"
TTL_PY = HERE / "ttl.py"

# sha256 pins of the pristine files as they exist in the LIVE container
# (qwenpaw-agentx:2.3.0-gatefix6, both /app/src and site-packages copies
# are byte-identical). If the image is re-based, re-pin these first.
PINS = {
    "approval.py": "5837d1b8ba6e51d06ea61c153449f6572aef966f2ad051b1830f771f76cd61dc",
    "service.py": "552efceb5b99617447d2b8444f6d8f51344aafe98342bd0a656826d4d97c4a44",
    "__init__.py": "c02550fa23c997804e0402ad7a01b25654c661fce53ffe9823f02004d88ff68f",
}

# The three files, as (patch-relative path, repo filename).
FILES = [
    ("src/qwenpaw/app/routers/approval.py", "approval.py"),
    ("src/qwenpaw/app/approvals/service.py", "service.py"),
    ("src/qwenpaw/app/approvals/__init__.py", "__init__.py"),
]

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_patch(args: list[str], cwd: Path, patch_file: Path) -> subprocess.CompletedProcess:
    with open(patch_file, "rb") as fh:
        return subprocess.run(
            ["patch", *args], cwd=str(cwd), stdin=fh,
            capture_output=True, text=True, timeout=60)


def extract_ttl_section(service_py: Path) -> str:
    """The TTL helper section of the patched service.py, standalone.

    From the `# Approval TTL (gap #18, T132)` header to just before
    the `# Data model` section. It only needs `importlib`, `Path`
    and `logger` from the enclosing module, which the caller provides.
    """
    text = service_py.read_text(encoding="utf-8")
    start = text.index("# Approval TTL (gap #18, T132)")
    # The section ends at the first class definition after it (the
    # TTL helpers contain no classes); the `# Data model` header sits
    # after the identity-policy classes, so it is the wrong end.
    end = text.index("\nclass ", start)
    section = text[start:end]
    # The section ends with the ttl_read function; strip trailing
    # blank lines and the section-closing comment block.
    return section.rstrip() + "\n"


def main() -> int:
    # --- W: patch integrity ------------------------------------------
    check("W1 patch file exists and is non-empty",
          PATCH.is_file() and PATCH.stat().st_size > 0)
    pins_ok = True
    for name, pinned in PINS.items():
        actual = sha256(PRISTINE / name) if (PRISTINE / name).is_file() else "missing"
        if actual != pinned:
            pins_ok = False
    check("W8 pristine files match the live-container sha256 pins", pins_ok)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # /app layout: src/qwenpaw/... (patch -p1 from /app)
        app_dir = tmp / "app"
        for rel, name in FILES:
            dest = app_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PRISTINE / name, dest)
        dry1 = run_patch(["-p1", "--dry-run"], app_dir, PATCH)
        check("W2 patch applies cleanly with -p1 (src copy, from /app)",
              dry1.returncode == 0, dry1.stderr.strip()[:200])
        # site-packages layout: qwenpaw/... (patch -p2)
        sp_dir = tmp / "site-packages"
        for rel, name in FILES:
            dest = sp_dir / Path(rel).relative_to("src")
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PRISTINE / name, dest)
        dry2 = run_patch(["-p2", "--dry-run"], sp_dir, PATCH)
        check("W3 patch applies cleanly with -p2 (site-packages copy)",
              dry2.returncode == 0, dry2.stderr.strip()[:200])
        # Real apply, then byte-compare with the stored patched files.
        applied = run_patch(["-p1"], app_dir, PATCH)
        reproduced = True
        if applied.returncode != 0:
            reproduced = False
        else:
            for rel, name in FILES:
                got = app_dir / rel
                want = PATCHED / name
                if not got.is_file() or got.read_bytes() != want.read_bytes():
                    reproduced = False
        check("W4 applying -p1 reproduces patched approval.py byte-for-byte",
              reproduced and (app_dir / "src/qwenpaw/app/routers/approval.py").read_bytes()
              == (PATCHED / "approval.py").read_bytes())
        check("W5 applying -p1 reproduces patched service.py byte-for-byte",
              reproduced and (app_dir / "src/qwenpaw/app/approvals/service.py").read_bytes()
              == (PATCHED / "service.py").read_bytes())
        check("W6 applying -p1 reproduces patched __init__.py byte-for-byte",
              reproduced and (app_dir / "src/qwenpaw/app/approvals/__init__.py").read_bytes()
              == (PATCHED / "__init__.py").read_bytes())

    # Patched files compile.
    compiled = True
    for name in ("approval.py", "service.py", "__init__.py"):
        proc = subprocess.run(
            [sys.executable, "-m", "py_compile", str(PATCHED / name)],
            capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            compiled = False
    check("W7 patched files compile (py_compile)", compiled)

    # --- G: gate presence --------------------------------------------
    appr = (PATCHED / "approval.py").read_text(encoding="utf-8")
    svc = (PATCHED / "service.py").read_text(encoding="utf-8")
    init = (PATCHED / "__init__.py").read_text(encoding="utf-8")
    appr_p = (PRISTINE / "approval.py").read_text(encoding="utf-8")
    svc_p = (PRISTINE / "service.py").read_text(encoding="utf-8")

    def _handler_body(text: str, start_marker: str, end_marker: str) -> str:
        start = text.index(start_marker)
        end = text.index(end_marker, start)
        return text[start:end]

    approve_body = _handler_body(
        appr, "async def post_approval_approve", "async def post_approval_deny")
    deny_body = _handler_body(
        appr, "async def post_approval_deny", "async def get_approval_list")
    list_body = appr[appr.index("async def get_approval_list"):]
    check("G1 approve handler calls ttl_answer before resolve_request",
          "ttl_answer" in approve_body
          and approve_body.index("ttl_answer")
          < approve_body.index("resolve_request"))
    check("G2 deny handler calls ttl_answer before resolve_request",
          "ttl_answer" in deny_body
          and deny_body.index("ttl_answer")
          < deny_body.index("resolve_request"))
    check("G3 both handlers refuse an expired card with 409 approval_expired",
          approve_body.count("approval_expired") >= 1
          and deny_body.count("approval_expired") >= 1
          and "status_code=409" in approve_body
          and "status_code=409" in deny_body)
    check("G4 list handler calls ttl_read and annotates expired cards",
          "ttl_read" in list_body and '"expired"' in list_body
          and "expires_at_ms" in list_body)
    check("G5 create_pending stamps the TTL expiry (ttl_issue)",
          "to_thread(ttl_issue, request_id, tool_name" in svc)
    check("G6 create_pending_summary stamps the TTL expiry (ttl_issue)",
          "to_thread(ttl_issue, request_id, summary.name" in svc)
    check("G7 __init__.py exports ttl_answer / ttl_issue / ttl_read",
          "ttl_answer" in init and "ttl_issue" in init and "ttl_read" in init)
    check("G8 pristine approval.py has no TTL gate (fail-first anchor)",
          "ttl_answer" not in appr_p and "ttl_read" not in appr_p)
    check("G9 pristine service.py has no ttl_issue call (fail-first anchor)",
          "ttl_issue" not in svc_p)

    # --- F: functional, helpers extracted from the patched service ---
    section = extract_ttl_section(PATCHED / "service.py")
    ns: dict = {
        "importlib": importlib,
        "Path": Path,
        "logger": logging.getLogger("test_wiring"),
    }
    try:
        exec(compile(section, "ttl_section", "exec"), ns)
        load_err = None
    except Exception as exc:  # noqa: BLE001 - the failure IS the check
        load_err = f"{type(exc).__name__}: {exc}"
    check("F0 TTL helper section extracts and execs standalone", load_err is None, load_err or "")
    if load_err is None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            store_path = tmp / "pending.json"
            ns["_TTL_STORE_PATH"] = str(store_path)
            # F1: loader returns None when the module file is absent.
            ns["_TTL_MODULE_PATH"] = str(tmp / "no-such-ttl.py")
            ns["_ttl_module"] = None
            check("F1 loader returns None when the module file is absent",
                  ns["_load_ttl_module"]() is None)
            # F2: loader loads the real ttl.py when present.
            ns["_TTL_MODULE_PATH"] = str(TTL_PY)
            ns["_ttl_module"] = None
            mod = ns["_load_ttl_module"]()
            check("F2 loader loads the real ttl.py when present",
                  mod is not None and hasattr(mod, "issue")
                  and hasattr(mod, "answer") and hasattr(mod, "read"))
            # F3: issue + read (pending with expiry).
            item = ns["ttl_issue"]("req-w1", "execute_shell_command", "sess-1")
            state = ns["ttl_read"]("req-w1")
            check("F3 ttl_issue stamps; ttl_read returns pending + expires_at_ms",
                  item is not None and item.get("status") == "pending"
                  and state is not None and state.get("status") == "pending"
                  and isinstance(state.get("expires_at_ms"), int))
            # F4: answer a live item.
            outcome, denial = ns["ttl_answer"]("req-w1", True)
            check("F4 ttl_answer on a live item returns (ok, None)",
                  outcome == "ok" and denial is None)
            # F5: answer an expired item.
            ns["ttl_issue"]("req-w2", "read_file", "sess-1")
            # Force expiry by rewriting the stored expiry into the past.
            import json as _json
            data = _json.loads(store_path.read_text(encoding="utf-8"))
            for it in data["items"]:
                if it["request_id"] == "req-w2":
                    it["expires_at_ms"] = 1
            store_path.write_text(_json.dumps(data), encoding="utf-8")
            state = ns["ttl_read"]("req-w2")
            check("F5a ttl_read on a pending-past-TTL item returns the denial",
                  state is not None and state.get("status") == "denied"
                  and state.get("expired") is True
                  and state.get("reason") == "timed out")
            outcome, denial = ns["ttl_answer"]("req-w2", True)
            check("F5 ttl_answer on an expired item returns (expired, denial)",
                  outcome == "expired" and denial is not None
                  and denial.get("reason") == "timed out"
                  and denial.get("card") == "This approval expired")
            # F6: answer an unknown id.
            outcome, _ = ns["ttl_answer"]("req-nope", True)
            check("F6 ttl_answer on an unknown id returns (unknown, None)",
                  outcome == "unknown")
            # F7: double answer.
            outcome, _ = ns["ttl_answer"]("req-w1", False)
            check("F7 ttl_answer twice returns (answered, None) the 2nd time",
                  outcome == "answered")
            # F8: read an expired item.
            state = ns["ttl_read"]("req-w2")
            check("F8 ttl_read on an expired item returns the denial",
                  state is not None and state.get("status") == "denied"
                  and state.get("expired") is True)
            # F9: read an unknown id.
            check("F9 ttl_read on an unknown id returns None",
                  ns["ttl_read"]("req-nope") is None)

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
