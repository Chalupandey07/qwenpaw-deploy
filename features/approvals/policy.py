#!/usr/bin/env python3
"""Per-tool Allow/Block enforcement for QwenPaw (AgentX) approvals.

Takes a tool name, the preview built by ``preview.build_preview`` and
a policy (``policy.json`` by default), and returns ``allow`` / ``ask`` /
``deny`` with a reason. Stdlib only, loads standalone.

Precedence (highest first) — deny beats everything, mirroring Claude
Code's rule engine (deny > ask > allow):

1. **Deny wins, at every approval level including OFF.** The tool is on
   the policy deny list, or the preview is CRITICAL (a destructive
   shell command, or a delete of a path the preview flags). This is a
   deliberate divergence from upstream QwenPaw, where ``OFF`` disables
   the guard entirely including the destructive auto-deny path: a tool
   the user put on the Block list must stay impossible, not become
   possible because the level changed. If that is ever wrong, the fix
   is to remove the tool from the deny list, not to flip the level.
2. **STRICT**: ask for everything (even INFO-level findings, per
   ``execution_level.py``). The level governs; the list cannot
   auto-allow past STRICT.
3. **OFF**: allow. Upstream semantics — the guard is off. Do not use
   outside a fully trusted test.
4. **AUTO**: ask only for tools in the guarded default set (the 8
   tools from ``security/tool_guard/utils.py:19``); everything else
   allows — but only with a preview to prove the risk, or an explicit
   auto-list entry (see rule 6).
5. **SMART / JEV — the list refines the level.** An explicit per-tool
   policy (auto / ask) wins; an unlisted tool falls back to severity
   (INFO/LOW auto-allow, MEDIUM/HIGH/CRITICAL ask; CRITICAL already
   denied above). JEV behaves as the SMART baseline here — the
   decision-model pre-execution check is NOT wired in this module
   (another builder owns Drex wiring); saying otherwise would be
   false. Unknown tools fail closed: ask.
6. **No preview, no auto-allow (except an explicit auto-list entry).**
   The destructive check lives in the preview: without one, a
   destructive command is invisible to this function. So a call with
   ``preview=None`` never returns ``allow`` unless the tool is on the
   explicit auto list (SMART/JEV) or the level is OFF. This is the
   DeepSeek review fix (2026-11-18): the first version let a missing
   preview silently downgrade deny to ask/allow.
7. **Normalization, fail closed.** Tool names are stripped, and the
   deny list and guarded set also match a namespaced suffix
   (``mcp__fs__execute_shell_command`` still matches
   ``execute_shell_command``) — a decorated name must not defeat the
   block. The auto/ask lists match exactly only: a decorated name
   must not auto-allow. Risk strings are upper-cased and stripped; an
   unrecognized risk asks, never allows. An unrecognized non-empty
   approval level asks (upstream ``from_config`` falls back to AUTO;
   this module fails closed instead — a typo in the strictest setting
   must not silently downgrade to the most permissive). A malformed
   policy (missing auto/ask/deny key, or a non-list value) raises
   ``ValueError`` instead of defaulting the deny list to empty.

NOT wired live: nothing in QwenPaw's ``runtime/tool_guard.py`` calls
this module yet. The live guard still decides by ``approval_level``
and ``denied_tools`` alone. Wiring this in needs a derived-image
change and a live check; that is follow-up work, not claimed here.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_POLICY_PATH = HERE / "policy.json"

# The built-in guarded default set (security/tool_guard/utils.py:19).
# In AUTO mode only these tools ask; the rest auto-allow.
GUARDED_DEFAULT = frozenset({
    "execute_shell_command",
    "read_file",
    "write_file",
    "edit_file",
    "append_file",
    "send_file_to_user",
    "view_text_file",
    "write_text_file",
})

# Severity order, for the SMART fallback.
_SEVERITY = {"INFO": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}


def _normalize_tool(tool_name: str) -> str:
    """Strip whitespace; empty/None becomes the placeholder."""
    return (tool_name or "").strip() or "<unknown>"


def _deny_or_guarded_match(tool: str, names) -> bool:
    """Match for deny / guarded checks: exact, or namespaced suffix.

    ``mcp__fs__execute_shell_command`` matches ``execute_shell_command``
    (the last ``__``-separated segment). This direction is fail-closed:
    a decorated name must not defeat a block.
    """
    if tool in names:
        return True
    last = tool.rsplit("__", 1)[-1]
    return last != tool and last in names


def _normalize_risk(risk) -> str | None:
    """Upper-case + strip; None stays None (no preview)."""
    if risk is None:
        return None
    return str(risk).strip().upper()


def _validate_policy(raw) -> dict:
    """Fail closed on a malformed policy: all three keys must be present
    and lists of strings. A missing deny key must never silently mean
    'nothing is denied'."""
    if not isinstance(raw, dict):
        raise ValueError(f"policy must be a JSON object, got {type(raw).__name__}")
    out: dict = {"version": raw.get("version", 1)}
    for key in ("auto", "ask", "deny"):
        if key not in raw:
            raise ValueError(f"policy is missing the {key!r} list (refusing to default it)")
        value = raw[key]
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ValueError(f"policy {key!r} must be a list of tool-name strings")
        out[key] = list(value)
    return out


def load_policy(path: str | Path | None = None) -> dict:
    """Load a policy file. Missing sections default to empty lists."""
    raw = json.loads(Path(path or DEFAULT_POLICY_PATH).read_text(encoding="utf-8"))
    return _validate_policy(raw)


def decide(tool_name: str, preview: dict | None = None,
           policy: dict | None = None,
           approval_level: str = "SMART") -> tuple[str, str]:
    """Decide allow / ask / deny for one tool call.

    ``preview`` is the dict from ``preview.build_preview`` (may be
    None, in which case the tool's listed policy / level alone decides
    and an unlisted tool asks). Returns ``(decision, reason)`` where
    decision is one of ``"allow"``, ``"ask"``, ``"deny"``.
    """
    tool = _normalize_tool(tool_name)
    pol = _validate_policy(policy if policy is not None else load_policy())
    level = (approval_level or "").strip().upper() or "AUTO"
    risk = _normalize_risk((preview or {}).get("risk"))

    # 1. Deny wins at every level, including OFF.
    if _deny_or_guarded_match(tool, pol["deny"]):
        return "deny", f"{tool} is on the Block (deny) list"
    if risk == "CRITICAL":
        return "deny", f"preview is CRITICAL: {(preview or {}).get('summary', 'destructive call')}"

    # 2. STRICT asks for everything; the list cannot auto-allow past it.
    if level == "STRICT":
        return "ask", "approval_level STRICT asks for every tool"

    # 3. OFF: guard disabled (upstream semantics), deny already handled.
    if level == "OFF":
        return "allow", "approval_level OFF disables the guard"

    # 4. AUTO: the guarded default set decides — but a call with no
    # preview never auto-allows (rule 6): without a preview the risk
    # is unknown, so an unguarded tool asks instead of allowing.
    if level == "AUTO":
        if _deny_or_guarded_match(tool, GUARDED_DEFAULT):
            return "ask", f"{tool} is in the guarded default set (AUTO)"
        if preview is None:
            return "ask", "no preview supplied; failing closed under AUTO"
        return "allow", f"{tool} is not guarded under AUTO"

    # Unknown level: fail closed (a typo must not downgrade to AUTO).
    if level not in ("SMART", "JEV"):
        return "ask", f"unknown approval_level {level!r}; failing closed"

    # 5. SMART / JEV: explicit per-tool policy first, then severity.
    if tool in pol["auto"]:
        return "allow", f"{tool} is on the Allow (auto) list"
    if tool in pol["ask"]:
        return "ask", f"{tool} is on the Ask list"

    if risk is None:
        return "ask", f"{tool} is unlisted and has no preview; failing closed"
    if risk not in _SEVERITY:
        return "ask", f"unrecognized preview risk {risk!r}; failing closed"
    if _SEVERITY[risk] <= _SEVERITY["LOW"]:
        return "allow", f"SMART: {risk} severity auto-allows"
    return "ask", f"SMART: {risk} severity needs approval"
