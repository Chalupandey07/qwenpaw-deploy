#!/usr/bin/env python3
"""Plan mode for QwenPaw (AgentX) — tool-layer enforcement, not a prompt.

Modelled on OpenCode's Plan agent (read-only) vs Build, Claude Code's
``EnterPlanMode`` / ``--permission-mode plan``, and Gemini CLI's
``EnterPlanMode`` + ``WriteTodos``: the agent enters plan mode, explores
read-only, writes a numbered plan to ``plans/<timestamp>.md``, and does
NOT mutate anything until the user approves. Execution then starts FROM
the approved plan, and only the plan's steps run — no silent extras.

The enforcement lives in :class:`ToolGate`, a stdlib-only class the
agent loop must call before dispatching any tool. A prompt that says
"don't edit yet" is NOT a plan mode; the refusal comes from this code:

* mode ``off``       — gate inactive, every tool allowed (normal work).
* mode ``planning``  — only the read-only allowlist runs. Any mutating
  or unknown tool is REFUSED with a denial naming the blocked tool.
* mode ``approved``  — read-only tools still run; a mutating tool runs
  only when it carries the ``step_id`` of a step in the approved plan
  AND its tool (and, for bash steps, its exact command) matches that
  step. Approval is bound to the plan file itself — its path, its
  SHA-256, and its ordered steps — so editing or reordering the plan
  after approval voids the approval, and approving plan A never
  authorises plan B. A plan executes at most once: executed steps are
  recorded after every step.

The ``bash``/``shell`` tool is classified by its command text, because
a shell is one tool that can read or write. The classifier is
deliberately conservative: any segment that writes (redirection,
``rm``/``mv``/``cp``/``mkdir``, ``git commit``/``push``, ``docker``,
``curl -X POST`` …) makes the whole command mutating. A read-only
command that merely *contains* a ``>`` inside a quoted string is
refused too — rephrase it instead of working around the gate.

State is held in :class:`PlanMode` and persisted to
``plans/.plan-mode-state.json`` so the CLI (one process per call) and
the agent loop share one mode. The plan file is the record: draft
until approved, then ``Status: approved``.

Usage (CLI, from the repo root or this directory):

    python3 plan_mode.py enter --task "Add a /status page" [--plans-dir plans]
    python3 plan_mode.py status
    python3 plan_mode.py check --tool write_file
    python3 plan_mode.py check --tool bash --command "git status"
    python3 plan_mode.py approve plans/20261118T143000Z.md
    python3 plan_mode.py exit

Approval is exactly one mechanism: the user says ``approve`` in chat
(or runs ``plan_mode.py approve <plan-file>``). There is no auto-approve,
no timeout-approve, and no approval by silence.

This module never touches the network, never reads a secret, and never
writes outside the plans directory it is given. It is stdlib-only so
it loads standalone on this VM and on the machine.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE_FILENAME = ".plan-mode-state.json"

# ---------------------------------------------------------------------------
# Tool allowlist — the read-only set. Everything else is denied in plan mode.
# Tool names follow the names QwenPaw's agent loop dispatches; a name not
# on either list is denied by default (deny-by-default, not allow-by-default).
# ---------------------------------------------------------------------------

READ_ONLY_TOOLS = frozenset({
    # file / workspace reads
    "read_file", "list_dir", "glob", "grep", "search",
    # web reads (fetch is read-only: GET only, no POST body)
    "web_search", "web_fetch",
    # memory reads (never history.db writes)
    "memory_search", "memory_read",
    # git reads
    "git_status", "git_log", "git_diff",
    # plan-mode bookkeeping (reading the plan / mode is always safe)
    "show_plan", "plan_status",
})

# Known mutating tools, named explicitly so the denial can say which one
# was blocked and why. Unknown tools are denied too (see ToolGate.check).
MUTATING_TOOLS = frozenset({
    "write_file", "edit_file", "delete_file", "move_file", "create_dir",
    "bash", "shell",
    "git_commit", "git_push", "git_checkout", "git_add", "git_reset",
    "deploy", "docker_restart", "docker_exec",
    "vault_write", "send_message", "run_tests_write",
})

# The shell is one tool that can read or write, so it is classified by
# command text. Each entry is (regex, human reason). Checked per segment
# (split on && and ;) — one mutating segment makes the command mutating.
# A denylist is never complete — a command whose program writes files
# despite looking read-only (a build, a test run, `make`) is the residual
# risk, documented in README.md. The list below covers every mutating
# shape found by the DeepSeek design review (2026-11-18) plus the
# obvious ones; when in doubt it errs toward refusing.
_SHELL_MUTATING_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r">"), "shell redirection (>) writes a file"),
    (re.compile(r"\btee\b"), "tee writes a file"),
    (re.compile(r"\brm\b"), "rm deletes"),
    (re.compile(r"\bmv\b"), "mv moves/renames"),
    (re.compile(r"\bcp\b"), "cp writes a copy"),
    (re.compile(r"\bmkdir\b"), "mkdir creates a directory"),
    (re.compile(r"\btouch\b"), "touch creates/modifies a file"),
    (re.compile(r"\bln\b"), "ln creates a link"),
    (re.compile(r"\bunlink\b"), "unlink deletes"),
    (re.compile(r"\bdd\b"), "dd writes raw bytes"),
    (re.compile(r"\btar\b\s+[a-z]*x"), "tar extracts"),
    (re.compile(r"\bunzip\b"), "unzip extracts"),
    (re.compile(r"\bpatch\b"), "patch edits files"),
    (re.compile(r"\bmake\b"), "make builds/writes"),
    (re.compile(r"\bfind\b.*-delete\b"), "find -delete deletes"),
    (re.compile(r"\bsed\b[^|;]*(-i|--in-place|-[A-Za-z]*i\b)"),
     "sed -i edits a file in place"),
    (re.compile(r"\bperl\b[^|;]*-pi\b"), "perl -pi edits files in place"),
    # git: global options (-C <dir>, --git-dir=<dir>) may sit between
    # `git` and the subcommand, so they are skipped before matching it.
    (re.compile(r"\bgit\s+(?:(?:-[A-Za-z](?:\s+\S+)?|--[A-Za-z-]+(?:=\S+)?)\s+)*"
                r"(clone|init|commit|push|add|checkout|reset|merge|rebase|stash|rm|mv|"
                r"apply|restore|clean|cherry-pick|switch|pull|fetch|am|config)\b"),
     "git subcommand mutates the repo or working tree"),
    (re.compile(r"\bdocker\b"), "docker changes container/machine state"),
    (re.compile(r"\bcurl\b.*(-X\s*(POST|PUT|DELETE|PATCH)|-X(POST|PUT|DELETE|PATCH)|"
                r"--data\b|--data-raw\b|--data-binary\b|--request\b|-d\b|-o\b|-O\b|-T\b|"
                r"--upload-file\b|--output\b)"),
     "curl with a write method, a request body, or an output file"),
    (re.compile(r"\bwget\b.*(--post-(data|file)\b|-O\b)"), "wget with a POST body or -O output"),
    (re.compile(r"\bchmod\b"), "chmod changes permissions"),
    (re.compile(r"\bchown\b"), "chown changes ownership"),
    (re.compile(r"\bkill\b"), "kill stops a process"),
    (re.compile(r"\btruncate\b"), "truncate rewrites a file"),
    (re.compile(r"\bsystemctl\b"), "systemctl changes service state"),
    # Interpreters: -c / -m / -e run arbitrary code, which can write.
    (re.compile(r"\bpython3?\b\s+(-c|-m)\b"), "python -c/-m runs arbitrary code"),
    (re.compile(r"\b(node|ruby|perl)\b\s+-e\b"), "interpreter -e runs arbitrary code"),
    (re.compile(r"\bpython3?\b.*\bopen\s*\([^)]*['\"][wa]"),
     "python open(..., 'w'/'a') writes"),
    (re.compile(r"\bpython3?\b.*\b(os\.remove|shutil\.|subprocess\b)"),
     "python os.remove/shutil/subprocess mutates"),
    (re.compile(r"\bpip3?\b.*\binstall\b"), "pip install writes packages"),
    (re.compile(r"\bnpm\b.*\b(install|i|add)\b"), "npm install writes packages"),
    (re.compile(r"\bapt(-get)?\b.*\binstall\b"), "apt install writes packages"),
]

REQUIRED_PLAN_SECTIONS = (
    "## Steps",
    "## Files to touch",
    "## Commands to run",
    "## Expected diff",
    "## Risks",
)

_STEP_RE = re.compile(
    r"^\s*\d+\.\s*\[(?P<id>[A-Za-z0-9_-]+)\]\s*"
    r"\(tool:\s*(?P<tool>[A-Za-z0-9_-]+)\)\s*(?P<desc>.*)$")


# ---------------------------------------------------------------------------
# Decisions, errors
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Decision:
    """One gate verdict. ``allowed`` is the whole answer; ``reason`` is
    the sentence the agent (and the user) sees when a call is refused."""
    allowed: bool
    tool: str
    reason: str


class PlanModeDenied(Exception):
    """Raised by PlanMode.enforce / execute when the gate refuses a call.
    The message always names the blocked tool."""

    def __init__(self, decision: Decision):
        self.decision = decision
        super().__init__(f"PLAN MODE DENIED: tool '{decision.tool}' — {decision.reason}")


class PlanNotApproved(Exception):
    """Raised when execution is attempted before the plan is approved."""


class PlanInvalid(Exception):
    """Raised when a plan file is missing a required section or steps."""


# "Read-only" tools can still write through their arguments
# (git_diff --output=<file> writes a file; web_fetch with a POST body
# is a write). Flags/args outside this safe set are refused.
SAFE_GIT_FLAGS = frozenset({
    "--stat", "--name-only", "--name-status", "--oneline", "--short",
    "--branch", "--porcelain", "--graph", "--decorate", "--all",
    "--since", "--until", "--author", "--grep", "--max-count",
    "--cached", "--staged", "--no-index",
})


def _validate_read_only_args(tool: str, args: dict) -> tuple[bool, str]:
    """Refuse a nominally read-only tool whose arguments would write.
    Returns (ok, reason)."""
    if tool in ("git_status", "git_log", "git_diff"):
        for value in args.values():
            text = str(value)
            if "--output" in text or ">" in text:
                return False, f"read-only tool '{tool}' given a writing argument: {text[:80]!r}"
            for token in text.split():
                if token.startswith("--") and token.split("=")[0] not in SAFE_GIT_FLAGS:
                    return False, f"read-only tool '{tool}' given an unlisted flag: {token}"
        return True, ""
    if tool == "web_fetch":
        method = str(args.get("method", "GET")).upper()
        if method != "GET":
            return False, f"web_fetch with method {method} is a write, not a read"
        if any(k in args for k in ("body", "data", "json")):
            return False, "web_fetch with a request body is a write, not a read"
        return True, ""
    return True, ""


# ---------------------------------------------------------------------------
# The gate — pure function of (tool, args, mode, approved steps)
# ---------------------------------------------------------------------------

class ToolGate:
    """Tool-layer enforcement. No state of its own: the caller passes the
    current mode and, in approved mode, the approved steps.

    ``approved_steps`` is a mapping ``step_id -> {"tool": ..., "command":
    ...}``. Approval binds a mutating call to a step *and* to that
    step's tool (and, for bash steps, its exact command) — a caller
    cannot reuse an approved step id to run a different tool, and cannot
    smuggle a different shell command through an approved bash step.
    A plain set of ids is also accepted (id-only check) for callers
    that do not carry the binding."""

    def classify_shell(self, command: str) -> tuple[bool, str]:
        """Classify a shell command. Returns (is_read_only, reason)."""
        if not command or not command.strip():
            return False, "empty shell command"
        segments = re.split(r"&&|;", command)
        for seg in segments:
            seg = seg.strip()
            if not seg:
                continue
            for pattern, reason in _SHELL_MUTATING_PATTERNS:
                if pattern.search(seg):
                    return False, f"mutating shell command: {reason} in '{seg[:80]}'"
        return True, "read-only shell command"

    @staticmethod
    def _approved_entry(approved_steps, step_id: str) -> dict | None:
        if approved_steps is None:
            return None
        if isinstance(approved_steps, (set, frozenset)):
            return {} if step_id in approved_steps else None
        entry = approved_steps.get(step_id)
        return dict(entry) if isinstance(entry, dict) else (
            {} if entry is not None else None)

    def check(self, tool: str, args: dict | None = None, *,
              mode: str = "planning",
              step_id: str | None = None,
              approved_steps=None) -> Decision:
        """Decide whether ``tool`` may run right now.

        mode "off"       — gate inactive, everything allowed.
        mode "planning"  — read-only allowlist only.
        mode "approved"  — read-only always; mutating only for a step
                           that is in the approved plan, with the step's
                           tool (and, for bash, its exact command).
        Any other mode string is treated as "planning" (fail closed).
        """
        args = args or {}

        if mode == "off":
            return Decision(True, tool, "plan mode off — gate inactive")

        if mode not in ("planning", "approved"):
            mode = "planning"  # fail closed on an unknown mode

        if tool in READ_ONLY_TOOLS:
            ok, reason = _validate_read_only_args(tool, args)
            if not ok:
                return Decision(False, tool, f"blocked in {mode} mode: {reason}")
            return Decision(True, tool, f"read-only tool '{tool}' allowed in {mode} mode")

        if tool in ("bash", "shell"):
            command = str(args.get("command", args.get("cmd", "")))
            read_only, reason = self.classify_shell(command)
            if not read_only:
                return Decision(False, tool,
                                f"blocked in {mode} mode: {reason}")
            if mode == "approved" and step_id is not None:
                entry = self._approved_entry(approved_steps, step_id)
                if entry is None:
                    return Decision(
                        False, tool,
                        f"tool '{tool}' with step '{step_id}' is not in the "
                        "approved plan — only the plan's steps may execute, "
                        "no silent extra steps")
                if entry.get("tool") and entry["tool"] not in ("bash", "shell"):
                    return Decision(
                        False, tool,
                        f"tool '{tool}' does not match approved step '{step_id}', "
                        f"whose tool is '{entry['tool']}' — an approved step id "
                        "cannot be reused for a different tool")
                expected = entry.get("command", "")
                if expected and command != expected:
                    return Decision(
                        False, tool,
                        f"tool '{tool}' command does not match approved step "
                        f"'{step_id}' — the approved command is "
                        f"{expected!r}, the call asked for {command!r}")
            return Decision(True, tool, reason)

        if tool in MUTATING_TOOLS:
            if mode == "planning":
                return Decision(
                    False, tool,
                    f"tool '{tool}' mutates state and plan mode is active — "
                    "write the plan first, then get it approved; "
                    "no file, repo, deploy or container change is allowed "
                    "until approval")
            # approved mode: the call must belong to a step of the plan,
            # AND the tool must be the step's tool (no id reuse).
            if step_id is None:
                return Decision(
                    False, tool,
                    f"tool '{tool}' is mutating and no plan step was given — "
                    "after approval, every mutating call must name the "
                    "approved plan step it executes")
            entry = self._approved_entry(approved_steps, step_id)
            if entry is None:
                return Decision(
                    False, tool,
                    f"tool '{tool}' with step '{step_id}' is not in the "
                    "approved plan — only the plan's steps may execute, "
                    "no silent extra steps")
            if entry.get("tool") and entry["tool"] != tool:
                return Decision(
                    False, tool,
                    f"tool '{tool}' does not match approved step '{step_id}', "
                    f"whose tool is '{entry['tool']}' — an approved step id "
                    "cannot be reused for a different tool")
            return Decision(True, tool,
                            f"tool '{tool}' allowed for approved plan step '{step_id}'")

        # Unknown tool: deny by default. An allowlist that silently passes
        # a tool it has never seen is not an allowlist.
        return Decision(False, tool,
                        f"tool '{tool}' is not on the read-only allowlist — "
                        "unknown tools are denied in plan mode")


# ---------------------------------------------------------------------------
# Plan files
# ---------------------------------------------------------------------------

def plan_filename(when: datetime | None = None) -> str:
    """plans/<timestamp>.md — UTC, e.g. plans/20261118T143000Z.md."""
    when = when or datetime.now(timezone.utc)
    return when.strftime("%Y%m%dT%H%M%SZ") + ".md"


@dataclass
class PlanStep:
    id: str
    tool: str
    description: str
    # For bash/shell steps: the exact command, rendered in backticks in
    # the plan file. execute() passes it to the gate so the shell
    # classifier judges the real command, not an empty string.
    command: str = ""


@dataclass
class Plan:
    task: str
    steps: list[PlanStep] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    diff: str = ""
    risks: list[str] = field(default_factory=list)
    status: str = "draft"
    created: str = ""
    path: Path | None = None

    def render(self) -> str:
        lines = [
            f"# Plan: {self.task}",
            "",
            f"- Created: {self.created or datetime.now(timezone.utc).isoformat() + 'Z'}",
            f"- Status: {self.status}",
            "",
            "## Goal",
            "",
            self.task,
            "",
            "## Steps",
            "",
        ]
        for i, step in enumerate(self.steps, 1):
            line = f"{i}. [{step.id}] (tool: {step.tool}) {step.description}"
            if step.command:
                line += f" — `{step.command}`"
            lines.append(line)
        lines += [
            "",
            "## Files to touch",
            "",
        ]
        lines += [f"- {f}" for f in self.files] or ["- (none — read-only plan, no files change)"]
        lines += [
            "",
            "## Commands to run",
            "",
        ]
        lines += [f"- `{c}`" for c in self.commands] or ["- (none)"]
        lines += [
            "",
            "## Expected diff",
            "",
            self.diff or "(no diff — read-only plan)",
            "",
            "## Risks",
            "",
        ]
        lines += [f"- {r}" for r in self.risks] or ["- (none listed)"]
        lines += [
            "",
            "## Approval",
            "",
            "Not yet approved." if self.status == "draft"
            else f"Approved — execution may run only the steps above, in order.",
            "",
        ]
        return "\n".join(lines)


def parse_plan_steps(text: str) -> list[PlanStep]:
    """Parse the numbered steps out of a plan file. A step line is
    ``N. [step-id] (tool: name) description``."""
    steps: list[PlanStep] = []
    in_steps = False
    for line in text.splitlines():
        if line.startswith("## "):
            in_steps = line.strip() == "## Steps"
            continue
        if in_steps:
            m = _STEP_RE.match(line)
            if m:
                desc = m.group("desc").strip()
                # A bash step carries its command in backticks at the end.
                command = ""
                cm = re.search(r"`([^`]+)`\s*$", desc)
                if m.group("tool") in ("bash", "shell") and cm:
                    command = cm.group(1)
                    desc = desc[:cm.start()].rstrip(" —-").strip()
                steps.append(PlanStep(id=m.group("id"), tool=m.group("tool"),
                                      description=desc, command=command))
    return steps


def _steps_section_lines(text: str) -> list[str]:
    """The raw lines of the ## Steps section (up to the next ## header)."""
    lines: list[str] = []
    in_steps = False
    for line in text.splitlines():
        if line.startswith("## "):
            in_steps = line.strip() == "## Steps"
            continue
        if in_steps:
            lines.append(line)
    return lines


def validate_plan(path: Path) -> tuple[bool, list[str]]:
    """Check a plan file has every required section, at least one step,
    unique step ids, a known tool per step, and no malformed numbered
    step line (a line like ``1. Do stuff`` with no ``[id] (tool:)`` is
    silently dropped by the parser, so it is an error here, not a
    silent omission). Returns (ok, missing) — missing names the problems."""
    text = Path(path).read_text(encoding="utf-8")
    missing = [s for s in REQUIRED_PLAN_SECTIONS if s not in text]
    steps = parse_plan_steps(text)
    if not steps:
        missing.append("## Steps (at least one numbered step)")
    seen: set[str] = set()
    for step in steps:
        if step.id in seen:
            missing.append(f"duplicate step id: {step.id}")
        seen.add(step.id)
        if step.tool not in READ_ONLY_TOOLS and step.tool not in MUTATING_TOOLS:
            missing.append(f"unknown tool in step {step.id}: {step.tool}")
    for line in _steps_section_lines(text):
        if re.match(r"^\s*\d+\.", line) and not _STEP_RE.match(line):
            missing.append(f"malformed step line: {line.strip()[:80]}")
    return (not missing, missing)


# ---------------------------------------------------------------------------
# PlanMode — state machine over the gate + plan files
# ---------------------------------------------------------------------------

class PlanMode:
    """One plan-mode session. Holds the mode, the approved plan and its
    steps; every mutating decision goes through the ToolGate.

    Approval binds the plan by content, not just by ids: ``approve()``
    records the plan file's SHA-256 and the ordered list of
    (id, tool, command) per step. ``execute()`` refuses unless the file
    on disk is byte-identical to the approved one and its steps match
    in order — editing or reordering the plan after approval voids the
    approval. Approval is also bound to one plan path: approving plan A
    never authorises executing plan B. And a plan executes at most
    once: executed step ids are recorded after every step (and saved),
    so a second execute() or a replayed step is refused."""

    def __init__(self, plans_dir: Path | str = HERE / "plans",
                 gate: ToolGate | None = None):
        self.plans_dir = Path(plans_dir)
        self.gate = gate or ToolGate()
        self.mode: str = "off"
        self.task: str = ""
        self.session_id: str = ""
        self.plan_path: Path | None = None
        # step id -> {"tool": ..., "command": ...} for approved steps
        self.approved_steps: dict[str, dict] = {}
        self.approved_order: list[str] = []
        self.plan_sha256: str = ""
        self.executed_steps: list[str] = []

    # -- state file ------------------------------------------------------
    @property
    def state_path(self) -> Path:
        return self.plans_dir / STATE_FILENAME

    def save_state(self) -> None:
        self.plans_dir.mkdir(parents=True, exist_ok=True)
        state = {
            "mode": self.mode,
            "task": self.task,
            "session_id": self.session_id,
            "plan_path": str(self.plan_path) if self.plan_path else None,
            "plan_sha256": self.plan_sha256,
            "approved_steps": [
                {"id": sid, "tool": self.approved_steps[sid].get("tool", ""),
                 "command": self.approved_steps[sid].get("command", "")}
                for sid in self.approved_order],
            "executed_steps": list(self.executed_steps),
        }
        self.state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")

    @classmethod
    def load_state(cls, plans_dir: Path | str = HERE / "plans") -> "PlanMode":
        pm = cls(plans_dir)
        try:
            state = json.loads(pm.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return pm
        except json.JSONDecodeError:
            # A corrupt state file fails CLOSED: read-only planning mode
            # with nothing approved. Mutations stay refused until the
            # user runs `plan_mode.py exit` to reset. Silently returning
            # mode "off" would fail open — the gate would be inactive.
            pm.mode = "planning"
            pm.task = "(state file corrupt — run plan_mode.py exit to reset)"
            return pm
        pm.mode = state.get("mode", "off")
        pm.task = state.get("task", "")
        pm.session_id = state.get("session_id", "")
        plan_path = state.get("plan_path")
        pm.plan_path = Path(plan_path) if plan_path else None
        pm.plan_sha256 = state.get("plan_sha256", "")
        pm.approved_order = []
        pm.approved_steps = {}
        for entry in state.get("approved_steps", []):
            if isinstance(entry, dict) and entry.get("id"):
                pm.approved_order.append(entry["id"])
                pm.approved_steps[entry["id"]] = {
                    "tool": entry.get("tool", ""),
                    "command": entry.get("command", "")}
            elif isinstance(entry, str):  # old format: bare step id
                pm.approved_order.append(entry)
                pm.approved_steps[entry] = {"tool": "", "command": ""}
        pm.executed_steps = list(state.get("executed_steps", []))
        return pm

    # -- the mode --------------------------------------------------------
    def enter(self, task: str) -> "PlanMode":
        """Enter plan mode (`/plan`). Read-only from here until approval.
        Clears any previous approval — a new session never inherits
        approved steps from an old plan."""
        self.mode = "planning"
        self.task = task
        self.session_id = "plan-" + plan_filename().removesuffix(".md").lower()
        self.plan_path = None
        self.approved_steps = {}
        self.approved_order = []
        self.plan_sha256 = ""
        self.executed_steps = []
        self.save_state()
        return self

    def exit(self) -> "PlanMode":
        """Exit plan mode (`/exit-plan`). A draft plan file stays on disk
        as a record; it is never executed after an exit."""
        self.mode = "off"
        self.approved_steps = {}
        self.approved_order = []
        self.plan_sha256 = ""
        self.save_state()
        return self

    # -- the gate, as the agent loop calls it ----------------------------
    def check(self, tool: str, args: dict | None = None, *,
              step_id: str | None = None) -> Decision:
        return self.gate.check(tool, args, mode=self.mode,
                               step_id=step_id,
                               approved_steps=self.approved_steps)

    def enforce(self, tool: str, args: dict | None = None, *,
                step_id: str | None = None) -> Decision:
        """Like check(), but raises PlanModeDenied on refusal. The agent
        loop calls this before dispatching any tool."""
        decision = self.check(tool, args, step_id=step_id)
        if not decision.allowed:
            raise PlanModeDenied(decision)
        return decision

    # -- the plan --------------------------------------------------------
    def write_plan(self, plan: Plan) -> Path:
        """Write the plan file. Only callable in planning mode — writing
        the plan is the one write plan mode itself performs, and it goes
        to plans/ only, never to the working tree. Two plans written in
        the same second get distinct names (``-2``, ``-3`` …) so a new
        draft can never overwrite the plan that was just reviewed."""
        if self.mode != "planning":
            raise PlanModeDenied(Decision(
                False, "write_file",
                "a plan can only be written while in planning mode"))
        self.plans_dir.mkdir(parents=True, exist_ok=True)
        plan.status = "draft"
        plan.created = datetime.now(timezone.utc).isoformat() + "Z"
        path = self.plans_dir / plan_filename()
        n = 2
        while path.exists():
            path = self.plans_dir / (plan_filename().removesuffix(".md") + f"-{n}.md")
            n += 1
        path.write_text(plan.render(), encoding="utf-8")
        plan.path = path
        self.plan_path = path
        self.save_state()
        return path

    def approve(self, plan_path: Path | str) -> list[PlanStep]:
        """The approval step. The user says ``approve`` (or runs
        ``plan_mode.py approve <plan-file>``). Only from planning mode,
        and only for a plan file inside the plans directory. Validates
        the plan, then binds the approval to that exact file: its path,
        its SHA-256, and its ordered steps (id, tool, command). Nothing
        executes here — approval only unlocks the plan's steps."""
        if self.mode != "planning":
            raise PlanInvalid(
                "cannot approve: not in planning mode — enter plan mode "
                "(/plan) first, then approve the plan")
        path = Path(plan_path).resolve()
        plans_dir = self.plans_dir.resolve()
        try:
            path.relative_to(plans_dir)
        except ValueError:
            raise PlanInvalid(
                f"cannot approve: {path} is not inside the plans directory "
                f"{plans_dir} — only plans written by write_plan() can be approved")
        ok, missing = validate_plan(path)
        if not ok:
            raise PlanInvalid(
                f"plan {path} is missing or invalid: {', '.join(missing)} — "
                "fix the plan before approval")
        raw = path.read_bytes()
        steps = parse_plan_steps(raw.decode("utf-8"))
        self.mode = "approved"
        self.plan_path = path
        self.plan_sha256 = hashlib.sha256(raw).hexdigest()
        self.approved_order = [s.id for s in steps]
        self.approved_steps = {
            s.id: {"tool": s.tool, "command": s.command} for s in steps}
        self.executed_steps = []
        text = raw.decode("utf-8")
        text = text.replace("- Status: draft", "- Status: approved", 1)
        text = text.replace("Not yet approved.",
                            "Approved — execution may run only the steps above, in order.", 1)
        path.write_text(text, encoding="utf-8")
        # The Status rewrite changes the bytes: re-hash the approved file
        # so execute() compares against what approval actually wrote.
        self.plan_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        self.save_state()
        return steps

    # -- execution, from the approved plan only --------------------------
    def _approved_snapshot(self, steps: list[PlanStep]) -> list[tuple[str, str, str]]:
        return [(s.id, s.tool, s.command) for s in steps]

    def execute(self, plan_path: Path | str, runner) -> list[str]:
        """Execute the approved plan. ``runner`` is a callable taking one
        PlanStep and performing it (in production: the agent loop's tool
        dispatcher; in tests: a recording fake). Refuses unless this is
        the approved plan, byte-identical to the approved file, with
        the same steps in the same order — editing or reordering the
        plan after approval voids the approval. Each step is re-checked
        through the gate first, and is recorded (and the state saved)
        as soon as it runs, so a plan executes at most once and a
        mid-run failure leaves the executed prefix on record. Raises
        PlanNotApproved before approval, and PlanModeDenied for any
        step that is not in the plan — so the executed steps are
        exactly the plan's steps, in order, no extras, no replays."""
        if self.mode != "approved":
            raise PlanNotApproved(
                "execution cannot start: the plan has not been approved — "
                "say 'approve' (or run plan_mode.py approve <plan>) first")
        path = Path(plan_path).resolve()
        if self.plan_path is None or path != self.plan_path.resolve():
            raise PlanInvalid(
                "this is not the approved plan — approval is bound to "
                f"{self.plan_path}; approving plan A never authorises plan B")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != self.plan_sha256:
            raise PlanInvalid(
                "plan file changed since approval — re-approve it")
        steps = parse_plan_steps(raw.decode("utf-8"))
        if self._approved_snapshot(steps) != [
                (sid, self.approved_steps[sid]["tool"],
                 self.approved_steps[sid]["command"])
                for sid in self.approved_order]:
            raise PlanInvalid(
                "plan steps changed since approval — re-approve it")
        executed: list[str] = []
        for step in steps:
            if step.id in self.executed_steps:
                raise PlanInvalid(
                    f"step '{step.id}' already executed — a plan runs at most once")
            args = {"command": step.command} if step.command else {}
            self.enforce(step.tool, args, step_id=step.id)
            runner(step)
            executed.append(step.id)
            self.executed_steps.append(step.id)
            self.save_state()
        return executed

    def execute_extra(self, step: PlanStep, runner) -> None:
        """Attempt to execute a step that is NOT in the approved plan.
        Always refused — this is the check that proves no silent extras.
        Replaying an already-executed step is refused too."""
        if step.id in self.executed_steps:
            raise PlanInvalid(
                f"step '{step.id}' already executed — a plan runs at most once")
        args = {"command": step.command} if step.command else {}
        self.enforce(step.tool, args, step_id=step.id)
        runner(step)


# ---------------------------------------------------------------------------
# CLI — one process per call, state shared via plans/.plan-mode-state.json
# ---------------------------------------------------------------------------

def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Plan mode: read-only planning until the user approves.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_enter = sub.add_parser("enter", help="enter plan mode (/plan)")
    p_enter.add_argument("--task", required=True)
    p_enter.add_argument("--plans-dir", default=str(HERE / "plans"))

    p_status = sub.add_parser("status", help="show the current mode")
    p_status.add_argument("--plans-dir", default=str(HERE / "plans"))

    p_check = sub.add_parser("check", help="ask the gate about one tool call")
    p_check.add_argument("--tool", required=True)
    p_check.add_argument("--command", default="")
    p_check.add_argument("--step-id", default=None)
    p_check.add_argument("--plans-dir", default=str(HERE / "plans"))

    p_approve = sub.add_parser("approve", help="approve a plan file")
    p_approve.add_argument("plan")
    p_approve.add_argument("--plans-dir", default=str(HERE / "plans"))

    p_exit = sub.add_parser("exit", help="exit plan mode (/exit-plan)")
    p_exit.add_argument("--plans-dir", default=str(HERE / "plans"))

    args = parser.parse_args()
    pm = PlanMode.load_state(args.plans_dir)

    if args.cmd == "enter":
        pm.enter(args.task)
        print(f"plan mode ON — session {pm.session_id}")
        print("Read-only until approval. Write the plan, then ask the user to approve it.")
        return 0
    if args.cmd == "status":
        print(f"mode: {pm.mode}")
        print(f"task: {pm.task or '(none)'}")
        print(f"plan: {pm.plan_path or '(none)'}")
        print(f"approved steps: {sorted(pm.approved_steps) or '(none)'}")
        return 0
    if args.cmd == "check":
        tool_args = {"command": args.command} if args.command else {}
        try:
            decision = pm.enforce(args.tool, tool_args, step_id=args.step_id)
        except PlanModeDenied as exc:
            print(str(exc))
            return 1
        print(f"ALLOWED: {decision.reason}")
        return 0
    if args.cmd == "approve":
        try:
            steps = pm.approve(args.plan)
        except (PlanInvalid, FileNotFoundError) as exc:
            print(f"cannot approve: {exc}")
            return 1
        print(f"approved {args.plan} — {len(steps)} step(s) may now execute, in order:")
        for step in steps:
            print(f"  {step.id} (tool: {step.tool}) {step.description}")
        return 0
    if args.cmd == "exit":
        pm.exit()
        print("plan mode OFF — draft plans stay on disk, unexecuted.")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
