#!/usr/bin/env python3
"""Machine-free tests for the SMART approval patch (T124).

Covers the three pieces in this directory:
  (a) apply-smart.py produces the exact agent.json change (SMART) on a
      COPY of an agent.json (never the real one) and is idempotent;
  (b) preview.py renders the exact shell command for a shell call and
      the exact diff for a file edit, and never executes anything;
  (c) policy.py enforcement returns auto for a low-risk tool, ask for
      a medium tool, deny for a destructive tool;
  (d) a tool on the deny list is refused even when approval_level is
      SMART (and even under OFF — deny beats every level).
  (e) DeepSeek review regressions (2026-11-18): no preview means no
      auto-allow, tool/risk/level strings are normalized, namespaced
      tool names still match the deny list, unknown levels and risks
      fail closed, malformed policies raise instead of defaulting the
      deny list to empty.

Usage:
    python3 test_approvals.py                      # must PASS (40 checks)
    python3 test_approvals.py --approvals-dir DIR  # run against another
                                                   # copy of the modules
Fail-first:
    mkdir /tmp/approvals-before   # empty dir: no preview.py, no
                                  # policy.py, no apply-smart.py
    python3 test_approvals.py --approvals-dir /tmp/approvals-before
                                  # must FAIL (the modules do not exist yet)
Everything runs on temporary copies; the live working tree is never
touched. Stdlib only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def load_module(path: Path, mod_name: str):
    """Load a .py file standalone; returns (module, error-or-None)."""
    if not path.exists():
        return None, f"missing {path}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        return None, f"no spec for {path}"
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 - the failure IS the check
        return None, f"{type(exc).__name__}: {exc}"
    return mod, None


def run_apply(script: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True, text=True, timeout=60,
    )


def make_working(tmp: Path, default_level: str = "AUTO",
                 qa_level: str | None = "AUTO",
                 config_rules: list[str] | None = None) -> Path:
    """A throwaway working/ tree shaped like the machine's."""
    working = tmp / "working"
    default_dir = working / "workspaces" / "default"
    default_dir.mkdir(parents=True)
    agent = {"approval_level": default_level, "decision_model": None,
             "model": "kilo-auto/free", "custom_key": "keep-me"}
    (default_dir / "agent.json").write_text(
        json.dumps(agent, indent=2) + "\n", encoding="utf-8")
    if qa_level is not None:
        qa_dir = working / "workspaces" / "QwenPaw_QA_Agent_0.2"
        qa_dir.mkdir(parents=True)
        qa = {"approval_level": qa_level, "decision_model": None}
        (qa_dir / "agent.json").write_text(
            json.dumps(qa, indent=2) + "\n", encoding="utf-8")
    config = {"security": {"tool_guard": {
        "enabled": True,
        "auto_denied_rules": config_rules if config_rules is not None
        else ["SAFETY_CHECKS_DESTRUCTIVE_COMMAND"]}}}
    (working / "config.json").write_text(
        json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return working


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--approvals-dir", default=str(HERE))
    args = parser.parse_args()
    adir = Path(args.approvals_dir)
    script = adir / "apply-smart.py"
    preview_mod, preview_err = load_module(adir / "preview.py", "ap_preview")
    policy_mod, policy_err = load_module(adir / "policy.py", "ap_policy")

    # --- (a) apply-smart.py on copies ----------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        working = make_working(Path(tmp))
        default_json = working / "workspaces" / "default" / "agent.json"
        qa_json = working / "workspaces" / "QwenPaw_QA_Agent_0.2" / "agent.json"
        config_json = working / "config.json"
        config_before = config_json.read_bytes()
        before = default_json.read_bytes()
        result = run_apply(script, "--working-dir", str(working), "--agent", "all")
        after = json.loads(default_json.read_text(encoding="utf-8"))
        check("A1 default agent.json AUTO -> SMART",
              result.returncode == 0 and after.get("approval_level") == "SMART",
              f"rc={result.returncode} out={result.stdout!r} err={result.stderr!r}")
        check("A2 other keys preserved (decision_model null, custom key kept)",
              after.get("decision_model") is None and after.get("custom_key") == "keep-me"
              and after.get("model") == "kilo-auto/free")
        check("A3 destructive auto-deny verified, config.json untouched",
              "SAFETY_CHECKS_DESTRUCTIVE_COMMAND" in result.stdout
              and config_json.read_bytes() == config_before)
        qa_after = json.loads(qa_json.read_text(encoding="utf-8"))
        check("A4 QA agent.json also SMART",
              qa_after.get("approval_level") == "SMART")
        second_before = default_json.read_bytes()
        second = run_apply(script, "--working-dir", str(working), "--agent", "all")
        check("A5 second run is a no-op (bytes unchanged, says already SMART)",
              second.returncode == 0
              and default_json.read_bytes() == second_before
              and "already SMART" in second.stdout
              and json.loads(default_json.read_text(encoding="utf-8"))["approval_level"] == "SMART")
        check("A6 --check passes once SMART",
              run_apply(script, "--working-dir", str(working),
                        "--agent", "all", "--check").returncode == 0)
        check("A7 output prints exactly what changed",
              "AUTO" in result.stdout and "-> SMART" in result.stdout
              and str(default_json) in result.stdout)
        check("A8 --check fails before apply, --dry-run writes nothing",
              _check_before_apply(script, Path(tmp)))

    with tempfile.TemporaryDirectory() as tmp:
        working = make_working(Path(tmp), qa_level=None)
        (working / "workspaces" / "QwenPaw_QA_Agent_0.2").mkdir(parents=True)
        qa_no_field = working / "workspaces" / "QwenPaw_QA_Agent_0.2" / "agent.json"
        qa_no_field.write_text(json.dumps({"model": "kilo-auto/free"},
                                         indent=2) + "\n", encoding="utf-8")
        qa_bytes = qa_no_field.read_bytes()
        result = run_apply(script, "--working-dir", str(working), "--agent", "all")
        check("A9 QA agent.json without the field is left untouched",
              result.returncode == 0 and qa_no_field.read_bytes() == qa_bytes)

    with tempfile.TemporaryDirectory() as tmp:
        missing = run_apply(script, "--working-dir", str(Path(tmp) / "nope"))
        check("A10 missing working dir exits 2",
              missing.returncode == 2)

    # --- (b) preview builder --------------------------------------------
    if preview_mod is None:
        for name in ("P1 shell preview renders the exact command",
                     "P2 shell preview never executes (marker absent)",
                     "P3 shell redirect target is in touches",
                     "P4 file-edit preview renders the exact diff",
                     "P5 file-edit preview never executes (target not created)",
                     "P6 read preview is LOW risk",
                     "P7 destructive shell is CRITICAL",
                     "P8 write preview is MEDIUM",
                     "P9 preview source contains no execution call"):
            check(name, False, preview_err or "")
    else:
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "pwned.txt"
            shell = preview_mod.build_preview(
                "execute_shell_command", {"command": f"echo pwned > {marker}"})
            check("P1 shell preview renders the exact command",
                  shell["command"] == f"echo pwned > {marker}"
                  and shell["kind"] == "shell" and shell["will_execute"] is False)
            check("P2 shell preview never executes (marker absent)",
                  not marker.exists())
            check("P3 shell redirect target is in touches",
                  str(marker) in shell["touches"])
            target = Path(tmp) / "notes.txt"
            edit = preview_mod.build_preview("edit_file", {
                "path": str(target),
                "old_text": "hello\n", "new_text": "hello world\n"})
            check("P4 file-edit preview renders the exact diff",
                  edit["kind"] == "file_edit" and edit["will_execute"] is False
                  and "-hello" in edit["diff"] and "+hello world" in edit["diff"]
                  and str(target) in edit["touches"])
            check("P5 file-edit preview never executes (target not created)",
                  not target.exists())
            read = preview_mod.build_preview("read_file", {"path": "notes.txt"})
            check("P6 read preview is LOW risk",
                  read["risk"] == "LOW" and read["kind"] == "file_read")
            boom = preview_mod.build_preview(
                "execute_shell_command", {"command": "rm -rf /"})
            check("P7 destructive shell is CRITICAL",
                  boom["risk"] == "CRITICAL")
            write = preview_mod.build_preview(
                "write_file", {"path": "x.txt", "content": "hi\n"})
            check("P8 write preview is MEDIUM",
                  write["risk"] == "MEDIUM" and "+hi" in write["diff"])
            card = preview_mod.preview_for_approval_card(
                "execute_shell_command", {"command": "ls -la"})
            check("P9 approval card carries the exact command + risk",
                  card["exact"] == "ls -la" and card["risk"] in ("LOW", "MEDIUM")
                  and card["title"].startswith("Approve"))
        src = (adir / "preview.py").read_text(encoding="utf-8") if (adir / "preview.py").exists() else ""
        check("P10 preview source contains no execution call",
              "import subprocess" not in src and "os.system(" not in src
              and "Popen(" not in src and "eval(" not in src and "exec(" not in src,
              "preview.py missing" if not src else "")

    # --- (c)+(d) Allow/Block enforcement ---------------------------------
    if policy_mod is None or preview_mod is None:
        for name in ("E1 low-risk read auto-allows under SMART",
                     "E2 medium write asks under SMART",
                     "E3 shell echo asks under SMART (Ask list)",
                     "E4 destructive shell is denied under SMART",
                     "E5 deny-listed tool refused under SMART",
                     "E6 deny-listed tool refused even under OFF",
                     "E7 STRICT asks even for a read",
                     "E8 AUTO asks guarded tools, allows the rest",
                     "E9 default policy.json loads with all three lists",
                     "E10 user edit: adding a tool to deny refuses it",
                     "E11 unknown tool fails closed (ask) under SMART",
                     "E12 JEV behaves as the SMART baseline",
                     "F1 no preview means no auto-allow under AUTO",
                     "F2 trailing-space tool name still matches the lists",
                     "F3 namespaced tool name still matches the deny list",
                     "F4 lowercase risk 'critical' still denies",
                     "F5 unrecognized risk fails closed (ask)",
                     "F6 unknown approval level fails closed (ask)",
                     "F7 policy missing the deny key raises ValueError",
                     "F8 policy with a non-list deny raises ValueError"):
            check(name, False, (policy_err or preview_err or ""))
    else:
        policy = policy_mod.load_policy(adir / "policy.json")
        decide = policy_mod.decide
        build = preview_mod.build_preview
        check("E1 low-risk read auto-allows under SMART",
              decide("read_file", build("read_file", {"path": "a.txt"}),
                     policy, "SMART")[0] == "allow")
        check("E2 medium write asks under SMART",
              decide("write_file", build("write_file", {"path": "a.txt", "content": "x"}),
                     policy, "SMART")[0] == "ask")
        check("E3 shell echo asks under SMART (Ask list)",
              decide("execute_shell_command", build("execute_shell_command", {"command": "echo hi"}),
                     policy, "SMART")[0] == "ask")
        check("E4 destructive shell is denied under SMART",
              decide("execute_shell_command", build("execute_shell_command", {"command": "rm -rf /"}),
                     policy, "SMART")[0] == "deny")
        denied = dict(policy, deny=[*policy["deny"], "execute_shell_command"])
        check("E5 deny-listed tool refused under SMART",
              decide("execute_shell_command", build("execute_shell_command", {"command": "echo hi"}),
                     denied, "SMART")[0] == "deny")
        check("E6 deny-listed tool refused even under OFF",
              decide("execute_shell_command", build("execute_shell_command", {"command": "echo hi"}),
                     denied, "OFF")[0] == "deny")
        check("E7 STRICT asks even for a read",
              decide("read_file", build("read_file", {"path": "a.txt"}),
                     policy, "STRICT")[0] == "ask")
        check("E8 AUTO asks guarded tools, allows the rest",
              decide("read_file", build("read_file", {"path": "a.txt"}),
                     policy, "AUTO")[0] == "ask"
              and decide("get_token_usage", build("get_token_usage", {}),
                         {**policy, "auto": [], "ask": []}, "AUTO")[0] == "allow")
        check("E9 default policy.json loads with all three lists",
              "read_file" in policy["auto"] and "write_file" in policy["ask"]
              and isinstance(policy["deny"], list))
        user_policy = dict(policy, deny=[*policy["deny"], "send_file_to_user"])
        check("E10 user edit: adding a tool to deny refuses it",
              decide("send_file_to_user",
                     build("send_file_to_user", {"path": "a.txt"}),
                     user_policy, "SMART")[0] == "deny")
        check("E11 unknown tool fails closed (ask) under SMART",
              decide("mystery_tool", build("mystery_tool", {"x": 1}),
                     policy, "SMART")[0] == "ask")
        check("E12 JEV behaves as the SMART baseline",
              decide("some_tool", {"risk": "LOW"}, policy, "JEV")[0] == "allow"
              and decide("some_tool", {"risk": "HIGH"}, policy, "JEV")[0] == "ask")
        # --- (e) DeepSeek review regressions (2026-11-18) --------------
        check("F1 no preview means no auto-allow under AUTO",
              decide("get_token_usage", None, policy, "AUTO")[0] == "ask")
        check("F2 trailing-space tool name still matches the lists",
              decide("read_file ", build("read_file", {"path": "a.txt"}),
                     policy, "SMART")[0] == "allow"
              and decide("execute_shell_command ",
                         build("execute_shell_command", {"command": "echo hi"}),
                         denied, "SMART")[0] == "deny")
        check("F3 namespaced tool name still matches the deny list",
              decide("mcp__fs__execute_shell_command",
                     build("execute_shell_command", {"command": "echo hi"}),
                     denied, "SMART")[0] == "deny")
        check("F4 lowercase risk 'critical' still denies",
              decide("execute_shell_command", {"risk": "critical"},
                     policy, "SMART")[0] == "deny")
        check("F5 unrecognized risk fails closed (ask)",
              decide("some_tool", {"risk": "banana"}, policy, "SMART")[0] == "ask")
        check("F6 unknown approval level fails closed (ask)",
              decide("get_token_usage", {"risk": "LOW"}, policy, "STRCT")[0] == "ask")
        with tempfile.TemporaryDirectory() as tmp:
            bad_missing = Path(tmp) / "no-deny.json"
            bad_missing.write_text(json.dumps({"auto": [], "ask": []}),
                                   encoding="utf-8")
            try:
                policy_mod.load_policy(bad_missing)
                missing_raises = False
            except ValueError:
                missing_raises = True
            check("F7 policy missing the deny key raises ValueError",
                  missing_raises)
            bad_type = Path(tmp) / "bad-deny.json"
            bad_type.write_text(json.dumps(
                {"auto": [], "ask": [], "deny": "execute_shell_command"}),
                encoding="utf-8")
            try:
                policy_mod.load_policy(bad_type)
                type_raises = False
            except ValueError:
                type_raises = True
            check("F8 policy with a non-list deny raises ValueError",
                  type_raises)

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    return 0 if passed == len(CHECKS) else 1


def _check_before_apply(script: Path, tmp: Path) -> bool:
    """--check exits 1 before apply; --dry-run writes nothing."""
    working = make_working(tmp / "pre")
    default_json = working / "workspaces" / "default" / "agent.json"
    before = default_json.read_bytes()
    chk = run_apply(script, "--working-dir", str(working), "--agent", "all", "--check")
    dry = run_apply(script, "--working-dir", str(working), "--agent", "all", "--dry-run")
    return (chk.returncode == 1 and dry.returncode == 0
            and "dry-run, not written" in dry.stdout
            and default_json.read_bytes() == before)


if __name__ == "__main__":
    sys.exit(main())
