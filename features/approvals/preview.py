#!/usr/bin/env python3
"""Per-tool preview builder for QwenPaw (AgentX) approvals.

Builds the preview an approval card shows BEFORE a tool runs: the exact
shell command, or the exact diff for a file edit, plus a risk level and
the list of things the call will touch.

PREVIEW ONLY. This module never executes the tool: no subprocess, no
``os.system``, no file reads or writes, no network. It renders from the
tool call's arguments alone. If the old content of a file was not
supplied in the arguments, the diff is rendered against empty input and
says so plainly — the builder does NOT read the file from disk to fill
the gap (reading the live file would be a side effect the caller did
not ask for, and the file may change between preview and approval).

Usage (stdlib only, loads standalone):

    from preview import build_preview, preview_for_approval_card
    p = build_preview("execute_shell_command", {"command": "ls -la"})
    p["command"]   # "ls -la" — the exact string that would run
    p["risk"]      # "MEDIUM"
    p = build_preview("edit_file",
    ...               {"path": "notes.txt",
    ...                "old_text": "hello\n", "new_text": "hello world\n"})
    p["diff"]      # unified diff, "-hello" / "+hello world"

Risk levels mirror the severity model in
``/app/src/qwenpaw/security/tool_guard/execution_level.py`` (SMART:
INFO/LOW auto-allow, MEDIUM/HIGH/CRITICAL ask) and the existing
destructive-command auto-deny rule
(``SAFETY_CHECKS_DESTRUCTIVE_COMMAND``: catastrophic wipes / mkfs /
dd). A CRITICAL preview is a refusal, not an approval question — see
``policy.py``.

NOT wired live: QwenPaw's approval card path (``runtime/tool_guard.py``,
``app/routers/approval.py``) does not call this module yet. Wiring it
into the card payload needs a derived-image change and a live browser
check; that is follow-up work, not claimed here. What this module is:
the preview object, tested machine-free in ``test_approvals.py`` (T124).
"""

from __future__ import annotations

import difflib
import re
import shlex

# ---------------------------------------------------------------------------
# Destructive shell patterns: the commands the existing auto-deny rule
# covers (catastrophic wipes / mkfs / dd), plus the adjacent
# unrecoverable cases (shutdown/reboot, piping a download straight into
# a shell, writing to a raw device). Any match makes the preview
# CRITICAL. The list is deliberately narrow: a broad pattern here would
# turn ordinary shell use into refusals. ``rm -rf`` inside the workspace
# is NOT in this list — it is HIGH (ask), because it is destructive but
# bounded; only ``rm -rf`` aimed at /, ~, $HOME or a bare ``*`` is
# CRITICAL.
# ---------------------------------------------------------------------------
_DESTRUCTIVE_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\bmkfs\b", "mkfs (filesystem format)"),
    (r"\bdd\b.*\bof=/dev/", "dd writing to a device"),
    (r"\bdd\b.*\bof=/dev/[a-z]", "dd writing to a device"),
    (r"\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|--recursive\s+--force|--force\s+--recursive)\s+(?:/|\$HOME|~|\*)(?:\s|$)",
     "rm -rf aimed at / or $HOME"),
    (r"\brm\s+--no-preserve-root\b", "rm --no-preserve-root"),
    (r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*;\s*\}\s*;", "fork bomb"),
    (r"\b(shutdown|poweroff|reboot|halt)\b", "system power command"),
    (r"\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b", "piping a download into a shell"),
    (r">\s*/dev/(?:sd|nvme|vd|hd)[a-z0-9]*\b", "redirect onto a raw device"),
    (r"\bchmod\s+-R\s+777\s+/\b", "chmod -R 777 /"),
    (r"\bchown\s+-R\b[^;]*\s+/\s*(?:;|$)", "chown -R /"),
)

# Shell commands that are read-only by construction (no write, no
# delete, no network, no execution of anything else). Anything else is
# MEDIUM by default: a shell call can do anything, so it is never
# auto-allowed on its word alone.
_READONLY_SHELL: tuple[str, ...] = (
    "ls", "pwd", "whoami", "date", "echo", "cat", "head", "tail",
    "wc", "grep", "find", "stat", "df", "du", "ps", "env", "printenv",
    "uname", "uptime", "which", "type", "id", "hostname",
)

# QwenPaw tool names and the risk of a normal (non-destructive) call.
# The guarded default set is from
# /app/src/qwenpaw/security/tool_guard/utils.py:19. Severity here is
# the preview's own judgement, not QwenPaw's internal finding severity
# (which the live guard computes per call); the two agree on the
# direction that matters — reads are LOW, writes ask, destruction
# refuses.
_TOOL_RISK: dict[str, str] = {
    "read_file": "LOW",
    "view_text_file": "LOW",
    "get_token_usage": "LOW",
    "list_files": "LOW",
    "list_directory": "LOW",
    "search_files": "LOW",
    "execute_shell_command": "MEDIUM",
    "write_file": "MEDIUM",
    "write_text_file": "MEDIUM",
    "edit_file": "MEDIUM",
    "append_file": "MEDIUM",
    "send_file_to_user": "MEDIUM",
    "delete_file": "HIGH",
    "run_tool_batch": "MEDIUM",
}

# Argument aliases, because callers spell the same field different
# ways. First hit wins.
_COMMAND_KEYS = ("command", "commands", "script", "cmd", "shell_command")
_PATH_KEYS = ("path", "file_path", "filepath", "file", "target")
_OLD_KEYS = ("old_text", "old_content", "content_before", "before", "original")
_NEW_KEYS = ("new_text", "new_content", "content_after", "after", "content", "text")


def _first(args: dict, keys: tuple[str, ...]):
    for key in keys:
        if key in args and args[key] is not None:
            return args[key]
    return None


def _destructive_reason(command: str) -> str | None:
    """Reason string if the shell command matches a destructive pattern."""
    for pattern, reason in _DESTRUCTIVE_PATTERNS:
        if re.search(pattern, command):
            return reason
    return None


def _shell_touches(command: str) -> list[str]:
    """Best-effort list of paths a shell command will touch.

    Only what is visible in the command string itself: redirect targets
    (``>`` / ``>>``) and the path arguments of ``rm`` / ``cp`` / ``mv`` /
    ``touch`` / ``mkdir``. It is a preview aid, not a sandbox — a
    command can touch paths this cannot see (variables, globs, pipes),
    and the preview says so in its summary when the command is not
    plainly read-only.
    """
    touches: list[str] = []
    for match in re.finditer(r">>?\s*([^\s;&|]+)", command):
        touches.append(match.group(1))
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    for i, token in enumerate(tokens):
        if token in ("rm", "cp", "mv", "touch", "mkdir", "rmdir"):
            for arg in tokens[i + 1:]:
                if arg.startswith("-"):
                    continue
                if "/" in arg or "." in arg:
                    touches.append(arg)
                break
    seen: set[str] = set()
    out: list[str] = []
    for item in touches:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _shell_preview(tool: str, command: str) -> dict:
    reason = _destructive_reason(command)
    if reason is not None:
        risk = "CRITICAL"
        summary = f"REFUSE: destructive shell command — {reason}."
    else:
        try:
            first = shlex.split(command)[0] if command.strip() else ""
        except ValueError:
            first = command.strip().split(" ")[0] if command.strip() else ""
        if first in _READONLY_SHELL and ">" not in command and "|" not in command:
            risk = "LOW"
            summary = "Read-only shell command; nothing is written or deleted."
        else:
            risk = "MEDIUM"
            summary = ("Shell command; it can write, delete, or reach the "
                       "network, so it needs approval before it runs.")
    return {
        "tool": tool,
        "kind": "shell",
        "command": command,
        "diff": None,
        "risk": risk,
        "touches": _shell_touches(command),
        "summary": summary,
        "will_execute": False,
    }


def _file_preview(tool: str, args: dict) -> dict:
    path = _first(args, _PATH_KEYS)
    old = _first(args, _OLD_KEYS)
    new = _first(args, _NEW_KEYS)
    if tool in ("write_file", "write_text_file") and old is None:
        # A fresh write: the diff is the whole content as additions.
        old_text, new_text = "", new if isinstance(new, str) else ""
        note = "New file (or old content not supplied): whole content shown as additions."
    elif tool == "append_file":
        old_text, new_text = "", new if isinstance(new, str) else ""
        note = "Append: content shown as additions to the end of the file."
    elif old is None and new is None:
        old_text, new_text = "", ""
        note = "No content supplied in the call arguments; nothing to show."
    else:
        old_text = old if isinstance(old, str) else ""
        new_text = new if isinstance(new, str) else ""
        note = "Diff of the exact old and new text from the call arguments."
    diff_lines = list(difflib.unified_diff(
        old_text.splitlines(keepends=True),
        new_text.splitlines(keepends=True),
        fromfile=f"a/{path}" if path else "a/<unknown>",
        tofile=f"b/{path}" if path else "b/<unknown>",
    ))
    risk = _TOOL_RISK.get(tool, "MEDIUM")
    if tool == "delete_file":
        summary = f"Deletes {path or '<unknown path>'}; the file cannot be recovered from here."
    else:
        summary = f"{note} Target: {path or '<unknown path>'}."
    return {
        "tool": tool,
        "kind": "file_edit",
        "command": None,
        "diff": "".join(diff_lines) if diff_lines else "(no changes)",
        "risk": risk,
        "touches": [path] if path else [],
        "summary": summary,
        "will_execute": False,
    }


def _read_preview(tool: str, args: dict) -> dict:
    path = _first(args, _PATH_KEYS)
    return {
        "tool": tool,
        "kind": "file_read",
        "command": None,
        "diff": None,
        "risk": _TOOL_RISK.get(tool, "LOW"),
        "touches": [path] if path else [],
        "summary": f"Reads {path or 'the requested item'}; nothing is changed.",
        "will_execute": False,
    }


def build_preview(tool_name: str, arguments: dict | None = None) -> dict:
    """Render the pre-execution preview for one tool call.

    Never executes the tool. Returns a plain dict (JSON-serialisable)
    with: tool, kind (shell / file_edit / file_read / network / other),
    command (exact shell string, or None), diff (unified diff for file
    edits, or None), risk (INFO / LOW / MEDIUM / HIGH / CRITICAL),
    touches (paths/URLs it will touch), summary (one plain sentence),
    will_execute (always False).
    """
    args = dict(arguments or {})
    tool = tool_name or "<unknown>"

    command = _first(args, _COMMAND_KEYS)
    if command is not None:
        if isinstance(command, (list, tuple)):
            command = "\n".join(str(c) for c in command)
        return _shell_preview(tool, str(command))

    if tool in ("write_file", "write_text_file", "edit_file",
                "append_file", "delete_file"):
        return _file_preview(tool, args)

    if tool in ("read_file", "view_text_file", "get_token_usage",
                "list_files", "list_directory", "search_files"):
        return _read_preview(tool, args)

    if tool in ("web_search", "web_fetch", "send_message", "send_file_to_user"):
        target = _first(args, ("url", "to", "recipient", "path", "file_path"))
        return {
            "tool": tool,
            "kind": "network",
            "command": None,
            "diff": None,
            "risk": _TOOL_RISK.get(tool, "MEDIUM"),
            "touches": [target] if target else [],
            "summary": (f"{tool} reaches outside this machine"
                        + (f" ({target})" if target else "")
                        + "; it needs approval before it runs."),
            "will_execute": False,
        }

    # Unknown tool: fail closed on the risk, say so, show the arguments
    # verbatim so the approver can see exactly what was asked.
    return {
        "tool": tool,
        "kind": "other",
        "command": None,
        "diff": None,
        "risk": "MEDIUM",
        "touches": [],
        "summary": (f"Unknown tool '{tool}'; no preview rule exists for it, "
                    "so it is treated as needing approval. Arguments: "
                    f"{args!r}"),
        "will_execute": False,
    }


def preview_for_approval_card(tool_name: str, arguments: dict | None = None) -> dict:
    """The preview object as an approval card would show it.

    Same data as :func:`build_preview`, plus the card fields: a title,
    the one-line ``what`` shown at the top of the card, and the exact
    ``exact`` text (command or diff) the user reads before answering.
    """
    preview = build_preview(tool_name, arguments)
    exact = preview["command"] if preview["command"] is not None else preview["diff"]
    return {
        "title": f"Approve {preview['tool']}?",
        "tool": preview["tool"],
        "kind": preview["kind"],
        "risk": preview["risk"],
        "what": preview["summary"],
        "exact": exact,
        "touches": preview["touches"],
        "will_execute": False,
    }
