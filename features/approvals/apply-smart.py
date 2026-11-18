#!/usr/bin/env python3
"""Apply the SMART approval patch on the machine (apply-script, T124).

Sets ``approval_level`` to ``SMART`` in the agent profile(s) under the
working directory — the patch proposed in ``config-patch.md`` (2026-11-15,
file only, never applied). This script IS the patch now: the parent runs
it on the machine; it never runs here, and it never touches the repo.

    python3 apply-smart.py --working-dir /data/home/qwenpaw/working --agent all

Targets: ``working/workspaces/default/agent.json`` (always) and
``working/workspaces/QwenPaw_QA_Agent_0.2/agent.json`` (only if the file
exists AND already has an ``approval_level`` field — the QA agent is
left alone if it does not carry the field). The destructive-command
auto-deny (``SAFETY_CHECKS_DESTRUCTIVE_COMMAND`` in
``working/config.json``) is verified read-only and never modified.

Behaviour:
- Idempotent: a second run changes nothing and says so.
- Atomic write: temp file in the same directory + ``os.replace``; a
  backup of the pre-change file is kept at ``agent.json.bak-before-smart``.
- Verifies afterwards by reading the value back; exits 1 if the
  read-back is not SMART.
- ``--dry-run`` prints what would change and writes nothing.
- ``--check`` verifies only (exit 0 = SMART everywhere + destructive
  auto-deny present, else 1) and writes nothing.
- Prints exactly what changed, one line per file.

WARNING (from config-patch.md): do NOT hand-edit ``agent.json`` while
the container is running without going through the API — the running
process may overwrite the file. This script writes the file directly,
so after running it, confirm the live value with
``GET /api/agents/running-config`` (it must read ``approval_level:
"SMART"``). If the container overwrote it, set the same field in the
console (Settings -> approval level) or ``PUT`` the running config with
``{"approval_level": "SMART"}`` while logged in — all three write the
same field. No restart is needed for this field: it is read per tool
call from the agent profile.

Exit codes: 0 ok / already SMART, 1 read-back verification failed or
--check failed, 2 missing default agent.json / invalid JSON / missing
working directory. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

TARGET_LEVEL = "SMART"
DESTRUCTIVE_RULE = "SAFETY_CHECKS_DESTRUCTIVE_COMMAND"
DEFAULT_WORKING = Path("/data/home/qwenpaw/working")
DEFAULT_AGENT = "working/workspaces/default/agent.json"
QA_AGENT = "working/workspaces/QwenPaw_QA_Agent_0.2/agent.json"


def agent_paths(working_dir: Path, which: str) -> list[Path]:
    """Agent profile paths to consider, in order."""
    paths: list[Path] = []
    if which in ("default", "all"):
        paths.append(working_dir / "workspaces" / "default" / "agent.json")
    if which in ("qa", "all"):
        paths.append(working_dir / "workspaces" / "QwenPaw_QA_Agent_0.2" / "agent.json")
    return paths


def check_destructive_deny(working_dir: Path) -> tuple[bool, str]:
    """Read-only check: is the destructive-command auto-deny still on?"""
    config_path = working_dir / "config.json"
    if not config_path.exists():
        return False, f"{config_path} not found (cannot verify auto-deny)"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        return False, f"{config_path} unreadable: {exc}"
    rules = (config.get("security", {}) or {}).get("tool_guard", {}).get("auto_denied_rules")
    if rules is None:
        return True, "auto_denied_rules absent (default applies: destructive auto-deny on)"
    if DESTRUCTIVE_RULE in rules:
        return True, f"auto_denied_rules contains {DESTRUCTIVE_RULE}"
    return False, f"auto_denied_rules is {rules!r} — {DESTRUCTIVE_RULE} MISSING"


def apply_to_file(path: Path, dry_run: bool = False) -> tuple[str, str | None, str | None]:
    """Set approval_level to SMART in one agent.json.

    Returns (status, old_value, new_value); status is one of
    "changed", "already", "skipped" (QA file without the field),
    "missing" (file does not exist). Raises FileNotFoundError for a
    missing DEFAULT agent file only when called via main(); here a
    missing file just reports "missing" and the caller decides.
    Writes atomically (temp file + os.replace) with a backup at
    agent.json.bak-before-smart. Never writes on dry-run.
    """
    if not path.exists():
        return "missing", None, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ValueError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    old = data.get("approval_level")
    if old == TARGET_LEVEL:
        return "already", old, old
    if old is None and "QwenPaw_QA_Agent_0.2" in str(path):
        # QA agent without the field: leave it alone (task rule).
        return "skipped", None, None
    if dry_run:
        return "would-change", old, TARGET_LEVEL
    data["approval_level"] = TARGET_LEVEL
    backup = path.with_name(path.name + ".bak-before-smart")
    shutil.copy2(path, backup)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    # Verify by reading back.
    read_back = json.loads(path.read_text(encoding="utf-8")).get("approval_level")
    if read_back != TARGET_LEVEL:
        raise RuntimeError(f"{path} read-back is {read_back!r}, not {TARGET_LEVEL!r}")
    return "changed", old, TARGET_LEVEL


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--working-dir", default=str(DEFAULT_WORKING),
                        help="QwenPaw working dir (default %(default)s)")
    parser.add_argument("--agent", choices=("default", "qa", "all"), default="all",
                        help="which agent profile(s) to patch (default all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print what would change, write nothing")
    parser.add_argument("--check", action="store_true",
                        help="verify only: exit 0 if SMART everywhere + auto-deny on")
    args = parser.parse_args(argv)
    working_dir = Path(args.working_dir)
    if not working_dir.is_dir():
        print(f"ERROR: working directory not found: {working_dir}", file=sys.stderr)
        return 2

    deny_ok, deny_msg = check_destructive_deny(working_dir)
    print(f"auto-deny check: {deny_msg}")

    paths = agent_paths(working_dir, args.agent)
    failed = False
    any_change = False
    for path in paths:
        is_default = "QwenPaw_QA_Agent_0.2" not in str(path)
        try:
            status, old, new = apply_to_file(path, dry_run=args.dry_run or args.check)
        except (ValueError, RuntimeError, OSError) as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        if status == "missing":
            if is_default:
                print(f"ERROR: default agent profile not found: {path}", file=sys.stderr)
                return 2
            print(f"{path}: skipped (file does not exist)")
            continue
        if status == "already":
            print(f"{path}: approval_level already SMART (no change)")
        elif status == "skipped":
            print(f"{path}: skipped (no approval_level field; QA agent left alone)")
        elif status == "would-change":
            print(f"{path}: approval_level {old!r} -> SMART (dry-run, not written)")
            if args.check:
                failed = True
        elif status == "changed":
            print(f"{path}: approval_level {old!r} -> SMART (changed, backup at "
                  f"{path.name}.bak-before-smart, read-back verified)")
            any_change = True
        else:  # pragma: no cover - defensive
            print(f"{path}: unexpected status {status}", file=sys.stderr)
            return 1

    if args.check:
        if failed or not deny_ok:
            print("CHECK FAILED: not all agent profiles are SMART, or auto-deny is off")
            return 1
        print("CHECK OK: approval_level SMART everywhere targeted; destructive auto-deny on")
        return 0

    if any_change:
        print("WARNING: if the container is running it may overwrite agent.json — "
              "confirm the live value with GET /api/agents/running-config "
              "(approval_level must read SMART); if it does not, set it in the "
              "console Settings or PUT the running config while logged in. "
              "No restart is needed for this field.")
    if not deny_ok:
        print(f"WARNING: {deny_msg} — the destructive-command auto-deny may be "
              "off; this script does not change config.json. Fix it in "
              "working/config.json (security.tool_guard.auto_denied_rules) "
              "before relying on SMART.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
