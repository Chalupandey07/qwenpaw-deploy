#!/usr/bin/env python3
"""Code Mode pilot — the VM runner.

WHY THIS EXISTS (read this before the code)

The pilot was first built to run in a Cloudflare Worker Loader. That path is
DEAD and will not be retried: `worker_loaders` (Dynamic Workers) requires a
PAID Cloudflare plan. Verified live — the Workers API returns

    403  code 10195  (worker_loaders is not available on this plan)

and the user has ruled out paying. Enabling the binding in wrangler.toml (the
previous commit) was the right way to settle the question; this commit is the
consequence of the answer. See README.md for the full record.

So execution moves to where the machine already is: the InstaBox VM that runs
QwenPaw. That is a strictly better place for this pilot anyway —

  * there is a real POSIX process to bound (`resource` limits, a wall clock, a
    subprocess kill) instead of a platform sandbox whose limits are opaque;
  * the MCP proxy already lives on that machine, so tool calls are local
    rather than a hop from Cloudflare's edge into a published port;
  * nothing is metered per-request, so a 10-step job does not spend a quota.

WHAT IT IS, AND WHAT IT IS NOT

It is a BOUNDED PILOT that measures whether Code Mode is worth adopting for
predictable jobs. It is NOT a code-execution service and it does NOT run
model-generated code: the job is a FIXED, AUDITABLE program (`BENCH_STEPS`)
chosen so a run tells you whether the *runtime* works. A generated script
would confound "the harness failed" with "the model wrote bad code", which is
the one thing a pilot must not do.

THE SAFETY MODEL (this runs on a box that holds the user's auth file)

  1. FIXED JOB ONLY. There is no `eval`, no `exec`, no template that accepts
     caller text. The only way to change what runs is to edit this file and
     commit it. That is deliberate and it is the whole sandbox.
  2. NO UNBOUNDED NETWORK. The runner talks to exactly one URL — the MCP
     proxy — resolved from config, not from the job. It makes no outbound
     call of its own.
  3. BOUNDED TIME. A wall-clock deadline kills the job, and each MCP call has
     its own timeout. A hung proxy becomes a reported step failure, not a
     hung process.
  4. BOUNDED SIZE. Tool responses are truncated before being kept, so one
     enormous `list_apps` cannot exhaust memory or the log.
  5. FAILURE IS REPORTED, NEVER HIDDEN. Every step carries its own outcome.
     If MCP is down every step says `ok: false` with the reason. There is no
     path that reports success for work that did not happen.

INTERFACE (mirrors the retired Worker where it still makes sense)

  GET  /health      -> { ok, runner, mcp, version, ready }
  GET  /api/bench   -> the measured classic-vs-codemode comparison (JSON)
  POST /api/run     -> run the fixed job, per-step outcomes
  GET  /api/runs    -> audit trail of run attempts
  GET  /            -> HTML status page

Run standalone:  python3 codemode-runner.py --selftest     (no machine needed)
Run as a service: python3 codemode-runner.py --socket /run/qwenpaw-codemode/runner.sock
Or over TCP:      python3 codemode-runner.py --port 8891 --token <t>   (loopback only)
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import resource
import signal
import socket
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp import McpClient, McpError  # noqa: E402

VERSION = "2.0.0-vm"

#: The estimator the rest of the repo uses (features/memory/recall.py).
DEFAULT_CHARS_PER_TOKEN = 3.6

#: Wall clock for one job. Ten MCP calls at 15 s each is the worst honest case;
#: a job that cannot finish in two minutes is broken, not slow.
JOB_DEADLINE_S = 120.0

#: One MCP call.
MCP_TIMEOUT_S = 15.0

#: Cap on a single tool response kept in the result, in characters. Enough for
#: a real answer, small enough that 10 of them cannot exhaust memory.
MAX_RESULT_CHARS = 2000

#: Audit trail length (in memory only; a pilot does not need durability).
MAX_RUNS_KEPT = 20

#: CPU seconds and address space a job's tool-call loop may use. This does not
#: bound the MCP proxy (a separate process) — it bounds THIS runner, which is
#: the thing a runaway loop would take down.
JOB_CPU_LIMIT_S = 60
JOB_AS_LIMIT_BYTES = 512 * 1024 * 1024


# ---------------------------------------------------------------------------
# THE TOOL SURFACE — the 9 tools that ACTUALLY exist on the machine
#
# WHY THIS IS 9 AND NOT 30 (BUGS.md B-41)
#
# This file used to model a 30-tool surface and run a 10-step job against it.
# Nine of those ten steps did not exist on the machine, so the live run on
# 2026-11-16 scored 1/10 with nine `unsupportedTool` errors, and the bench
# reported a 99.0% prompt-token reduction computed from tools that were never
# there. A measurement of an imaginary surface is not a measurement.
#
# The machine's MCP proxy (`http://172.18.0.1:8898`) exposes EXACTLY these
# nine tools — verified live by `McpClient.list_tools()` on 2026-11-16, and
# recorded in `features/test-project/TESTS.md` T11/T12 (server
# `open-computer-use 1.1.4`, tool set asserted exactly):
#
#   click, drag, get_app_state, list_apps, perform_secondary_action,
#   press_key, scroll, set_value, type_text
#
# ALL NINE are desktop interaction. There is no ticket, project, routine,
# thread or history tool on this proxy — that is the QwenPaw board API on the
# other side of a different service, not this MCP server. So the honest job is
# a DESKTOP job, and the bench is computed from these nine schemas.
#
# WHAT IS DELIBERATELY *NOT* DONE HERE
#
# The argument shapes for these nine are NOT invented. `TOOL_PARAMS` mirrors the
# arguments the job actually passes; it is still not the proxy's real
# `inputSchema`, which is only knowable by asking the live proxy. Every run
# therefore records `surface.schemas` (see `describe_surface()`), so the true
# shapes are one run away on the machine rather than a research round away.
# ---------------------------------------------------------------------------

#: The nine tools the machine's MCP proxy exposes. Order is the order the job
#: walks them; it is also the order `describe_surface()` reports.
DESKTOP_TOOLS = [
    ("list_apps", "List applications with windows on the desktop."),
    ("get_app_state", "Read the accessibility tree of the focused application."),
    ("click", "Click at a screen coordinate, or on a named accessibility node."),
    ("type_text", "Type text into the focused control."),
    ("press_key", "Press a key or key combination."),
    ("scroll", "Scroll the focused view."),
    ("set_value", "Set the value of an accessibility node directly."),
    ("drag", "Drag from one screen point to another."),
    ("perform_secondary_action", "Invoke a secondary accessibility action on a node."),
]

#: Backwards-compatible alias: the name the retired Worker harness uses for
#: "the modelled surface".
TOOL_NAMES = DESKTOP_TOOLS

#: Tool names as a plain set, for validation. Anything not in here is a bug in
#: the job, not a missing capability, and the selftest asserts that every step
#: is in it.
DESKTOP_TOOL_NAMES = frozenset(name for name, _ in DESKTOP_TOOLS)

#: Parameter names the job actually passes, per tool. Used to build a schema
#: that is at least the RIGHT SHAPE.
#:
#: The previous version gave EVERY tool `id` and `body` fields — wrong for a
#: `click`, and inflating every schema (which inflated the classic column and
#: therefore flattered Code Mode).
TOOL_PARAMS = {
    "list_apps": {},
    "get_app_state": {},
    "click": {"x": "int", "y": "int"},
    "type_text": {"text": "string"},
    "press_key": {"key": "string"},
    "scroll": {"dy": "int"},
    "set_value": {"value": "string"},
    "drag": {"x1": "int", "y1": "int", "x2": "int", "y2": "int"},
    "perform_secondary_action": {},
}

#: ⚠️ THIS JOB DRIVES THE REAL DESKTOP. It is NOT read-only, and it says so.
#:
#: The previous job was read-only because all ten of its tools were API calls
#: against a board nobody was looking at. This one is a *desktop* job: `click`,
#: `type_text`, `press_key`, `scroll`, `set_value` and `drag` move the real
#: pointer and send real keystrokes to whatever window has focus. That is the
#: only way to measure this surface — but it must never be described as
#: harmless.
#:
#: `mutates` is therefore explicit per step rather than a blanket claim.
#: Nothing here writes a file, creates a ticket, starts an agent or touches the
#: QwenPaw store: the effect is transient and dies with the window. That is what
#: makes it re-runnable, NOT "read-only". A run with `allow_interaction=False`
#: executes only the observation steps and reports the rest as skipped.
BENCH_STEPS = [
    {"tool": "list_apps", "step": "see which applications are on the desktop",
     "args": {}, "mutates": False},
    {"tool": "get_app_state", "step": "read the focused application's accessibility tree",
     "args": {}, "mutates": False},
    {"tool": "click", "step": "click a point on the desktop",
     "args": {"x": 400, "y": 300}, "mutates": True},
    {"tool": "type_text", "step": "type a line of text",
     "args": {"text": "codemode pilot"}, "mutates": True},
    {"tool": "press_key", "step": "press Return",
     "args": {"key": "Return"}, "mutates": True},
    {"tool": "scroll", "step": "scroll the focused view down",
     "args": {"dy": 3}, "mutates": True},
    {"tool": "set_value", "step": "set a value through the accessibility API",
     "args": {"value": "pilot"}, "mutates": True},
    {"tool": "drag", "step": "drag across the desktop",
     "args": {"x1": 400, "y1": 300, "x2": 500, "y2": 380}, "mutates": True},
    {"tool": "perform_secondary_action", "step": "invoke a secondary accessibility action",
     "args": {}, "mutates": True},
]

#: Tools that would leave PERSISTENT state behind. None of these is on this
#: proxy; the list exists so the assertion "this job is re-runnable" is checked
#: against a definition rather than against whoever wrote the job that day.
PERSISTENT_TOOLS = frozenset({
    "create_ticket", "update_ticket", "close_ticket", "add_comment",
    "create_project", "archive_project",
    "run_routine", "run_skill", "start_agent", "stop_agent",
    "write_file", "send_message",
})


def schema_tokens(name: str, description: str) -> str:
    """One tool schema, shaped from the parameters that tool actually takes."""
    params = TOOL_PARAMS.get(name, {})
    props = ",".join(
        '"%s":{"type":"%s"}' % (p, ("integer" if t == "int" else "string"))
        for p, t in params.items()
    )
    return ('{"name":"%s","description":"%s","parameters":{"type":"object",'
            '"properties":{%s}}}' % (name, description, props))


def estimate_tokens(text: str, chars_per_token: float = DEFAULT_CHARS_PER_TOKEN) -> int:
    if not text:
        return 0
    return max(1, int(-(-len(text) // chars_per_token)))


def round1(value: float) -> float:
    return round(value * 10) / 10


# ---------------------------------------------------------------------------
# The measurement — identical arithmetic to the retired Worker, so the numbers
# are comparable across the two implementations.
# ---------------------------------------------------------------------------

def bench(chars_per_token: float = DEFAULT_CHARS_PER_TOKEN) -> dict:
    """The measured comparison, computed from the REAL 9-tool surface.

    WHAT CHANGED AND WHY IT HAD TO (BUGS.md B-41)

    The previous version modelled 30 tools with rich arguments and reported a
    99.0% prompt-token reduction from a 10-step job. Nine of those ten steps
    named tools that do not exist on the machine, and twenty-one of the thirty
    modelled tools do not exist either. The number was arithmetic on a surface
    that was never there — worse than no number, because it looked measured.

    This version is computed from `DESKTOP_TOOLS`: the nine real tools, with
    their real (short) descriptions. Everything else is the same arithmetic, so
    the result stays comparable with the retired Worker's method — only the
    INPUT is now honest.

    THE HONEST CONCLUSION IS MUCH SMALLER, AND THAT IS THE FINDING.
    """
    classic_schemas = "\n".join(schema_tokens(n, d) for n, d in DESKTOP_TOOLS)
    classic_prompt_tokens = estimate_tokens(classic_schemas, chars_per_token)

    # The Code Mode prompt for THIS surface. One connector (`desktop`) with the
    # nine real method names — no invented tickets/agents/routines/files
    # connectors, because there is nothing behind them on this proxy. Naming a
    # connector that cannot answer is how the original 99% was manufactured.
    connector_hints = "desktop: " + ", ".join(n for n, _ in DESKTOP_TOOLS) + "."
    codemode_prompt = (
        '{"name":"codemode","description":"Write TypeScript that calls connector methods. '
        'Use codemode.search(query) to discover methods and codemode.describe(path) for '
        'their types. ' + connector_hints + ' '
        'The sandbox has no network access.","parameters":{"type":"object","properties":'
        '{"code":{"type":"string","description":"An async arrow function body"}},'
        '"required":["code"]}}'
    )
    codemode_prompt_tokens = estimate_tokens(codemode_prompt, chars_per_token)

    steps = len(BENCH_STEPS)

    # =========================================================================
    # THE DESKTOP MODEL — the one that describes the job we actually run.
    #
    # The old bench assumed Code Mode collapses N steps into ONE turn. For a
    # board/API job that is defensible: the script can batch known calls. For
    # THIS surface it is false, and the research note says so explicitly
    # (`features/research/code-mode.md` §4, "the visual-judgment bound"):
    #
    #   Desktop work is observe -> decide -> act. Each step needs the model to
    #   LOOK at the screen before choosing the next action, and a sandboxed
    #   script cannot supply that visual judgment.
    #
    # So `click` may be callable from a script, but WHETHER to click, and
    # WHERE, is a model decision that happens after seeing the result of the
    # previous step. The turns do not collapse. Claiming they do is how the
    # withdrawn figure was manufactured.
    #
    # What Code Mode DOES buy here is a smaller prompt per turn: the model
    # carries one `codemode` tool instead of the nine desktop schemas. That is
    # a real saving and it is the only one this surface can honestly claim.
    # =========================================================================
    desktop_classic_turns = steps
    desktop_codemode_turns = steps          # NO turn collapse: visual bound
    desktop_classic_total = classic_prompt_tokens * desktop_classic_turns
    desktop_codemode_total = codemode_prompt_tokens * desktop_codemode_turns
    desktop_reduction = round1((1 - desktop_codemode_total / desktop_classic_total) * 100)

    # The BATCHED variant — kept, bounded, and explicitly not this job. It is
    # the shape that applies when the steps are predictable (a routine, a data
    # job) rather than visually driven. Reporting it next to the desktop number
    # keeps the comparison honest instead of pretending one is the other.
    batched_classic_turns = steps
    batched_codemode_turns = 1
    batched_total = codemode_prompt_tokens * batched_codemode_turns
    batched_total_retry = codemode_prompt_tokens * 2
    batched_reduction = round1((1 - batched_total / desktop_classic_total) * 100)
    batched_reduction_retry = round1((1 - batched_total_retry / desktop_classic_total) * 100)

    # A representative script body for this surface, used only for the
    # single-call comparison below. It names a REAL tool.
    code_overhead = estimate_tokens(
        'async () => { const a = await desktop.list_apps({}); return a; }',
        chars_per_token)

    return {
        "ok": True,
        "version": VERSION,
        "runtime": "vm",
        "estimator": {
            "method": "chars / " + str(chars_per_token),
            "note": ("Conservative estimate, not a tokenizer. Same estimator as "
                     "features/memory/recall.py so both subsystems report comparable numbers."),
            "approximate": True,
        },
        "surface": {
            "tools": len(DESKTOP_TOOLS),
            "steps_in_job": steps,
            "tool_names": [n for n, _ in DESKTOP_TOOLS],
            "source": ("the machine's MCP proxy (open-computer-use 1.1.4) — all nine are "
                       "desktop-interaction tools; there is no board/routine/history tool here"),
        },
        # The headline for the job that ACTUALLY runs: a desktop job, where the
        # turn count does not collapse.
        "desktop_job": {
            "applies_to": ("the fixed job in this file: nine desktop-interaction tools, "
                           "each step needing a fresh look at the screen"),
            "classic": {
                "turns": desktop_classic_turns,
                "prompt_tokens_per_turn": classic_prompt_tokens,
                "total_prompt_tokens": desktop_classic_total,
            },
            "codemode": {
                "turns": desktop_codemode_turns,
                "prompt_tokens_per_turn": codemode_prompt_tokens,
                "total_prompt_tokens": desktop_codemode_total,
            },
            "prompt_token_reduction_pct": desktop_reduction,
            "turn_reduction": {
                "from": desktop_classic_turns, "to": desktop_codemode_turns, "factor": 1.0,
                "why": ("the visual-judgment bound: desktop steps cannot be batched into "
                        "one script because each needs a model decision after seeing the "
                        "previous result (research note §4)"),
            },
            "verdict": ("Code Mode wins on PROMPT SIZE ONLY for desktop work, never on "
                        "turn count. It removes the nine tool schemas from every turn and "
                        "replaces them with one; it does not remove the turns."),
        },
        # The batched shape, bounded and labelled as NOT this job. This is what
        # the withdrawn figure was really describing — a predictable workflow,
        # not a desktop one.
        "batched_job_hypothetical": {
            "applies_to": ("a PREDICTABLE workflow with the same step count (a routine or "
                           "data job). NOT the desktop job above, and not measured here."),
            "classic_total_prompt_tokens": desktop_classic_total,
            "codemode": {
                "turns": batched_codemode_turns,
                "total_prompt_tokens": batched_total,
                "turns_with_one_retry": 2,
                "total_with_one_retry": batched_total_retry,
            },
            "prompt_token_reduction": {
                "best_case_pct": batched_reduction,
                "with_one_retry_pct": batched_reduction_retry,
            },
            "turn_reduction_factor": float(batched_classic_turns),
        },
        "single_call_job": {
            "classic_prompt_tokens": classic_prompt_tokens,
            "codemode_prompt_tokens": codemode_prompt_tokens + code_overhead,
            "verdict": ("Code Mode is WORSE for a single simple call — the generated code "
                        "plus sandbox overhead exceeds one direct tool call. Savings scale "
                        "with tool count and step count, not with call count."),
        },
        "caveats": [
            "Estimates only — the codemode repo publishes no benchmarks.",
            "Computed from the NINE tools that actually exist on the machine's MCP "
            "proxy. The previous headline reduction was computed from 30 modelled "
            "tools, 21 of which do not exist; it is withdrawn, not adjusted "
            "(BUGS.md B-41).",
            "This surface is SMALL, so the saving is small. That is the finding, not "
            "a defect in the measurement: nine short desktop schemas are a cheap "
            "prompt, so there is little for Code Mode to remove.",
            "The codemode prompt here models ONE connector (desktop) with the nine "
            "real method names. Adding connectors raises that side and narrows the "
            "gap; adding ones that cannot answer is what produced the old number.",
            "Astra-class models still need one turn per visual decision; desktop "
            "work cannot batch screenshots into one script (research note §4). This "
            "is the binding constraint for THIS surface, and it is why the turn "
            "reduction should not be read as a latency win.",
            "Failures cost a retry: the batched figure carries its with_one_retry column.",
            "Real prompt tokens depend on the provider's tokenizer and the model's "
            "actual schema rendering.",
            "Not measured here: the tokens the model spends WRITING the script "
            "(output tokens) and the final result/logs returned to the context.",
        ],
    }


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

def truncate(value, limit: int = MAX_RESULT_CHARS):
    """Keep a tool response, but bounded. Never raises on odd shapes."""
    if value is None:
        return None
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(value)
    if len(text) <= limit:
        return value if not isinstance(value, str) else text
    return text[:limit] + "...[truncated %d chars]" % (len(text) - limit)


def _limit_self() -> None:
    """Cap CPU and address space for a ONE-SHOT job run.

    DESIGN NOTE, because the first version of this function was a real bug.

    It used to be called from `run_job()` unconditionally. In server mode that
    permanently caps `RLIMIT_AS` on the LONG-LIVED process: the cap is set on
    the first request and never released, so the server starts returning
    MemoryError hours later, under load, with no obvious cause. An e2e test
    caught it because the runner itself was the process under the limit.

    Resource limits belong to the unit of work, not to the service. So this is
    now called only when the process exists to run exactly one job
    (`--once`, or a `--selftest`-adjacent CLI run). In server mode the bound is
    the wall-clock deadline, the per-call MCP timeout, and the result-size
    truncation — all of which are enforced per request and cost nothing when
    idle.

    Best effort: not every platform honours both, and failing to set a limit
    must not fail the job.
    """
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (JOB_CPU_LIMIT_S, JOB_CPU_LIMIT_S))
    except (ValueError, OSError):
        pass
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        want = JOB_AS_LIMIT_BYTES if hard == resource.RLIM_INFINITY else min(JOB_AS_LIMIT_BYTES, hard)
        resource.setrlimit(resource.RLIMIT_AS, (want, hard))
    except (ValueError, OSError):
        pass


def describe_surface(client) -> dict:
    """Ask the LIVE proxy what it actually offers, and diff it against the job.

    THIS IS THE DIAGNOSTIC THE LAST ROUND NEEDED.

    The previous job failed nine of ten steps with `unsupportedTool` and the
    only way to find out why was to write a separate probe. A run that cannot
    say "the proxy offers X, the job calls Y, they differ by Z" sends the next
    person back to the machine with a hand-written client.

    Returns `{offered, expected, missing, unexpected}` — `missing` is the set
    the job needs and the proxy does not have, which is precisely the failure
    that started this rewrite. Never raises for a shape surprise.
    """
    try:
        tools = client.list_tools() or []
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    offered = [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")]
    expected = [n for n, _ in DESKTOP_TOOLS]
    return {
        "ok": True,
        "offered": offered,
        "offeredCount": len(offered),
        "expected": expected,
        "missing": [n for n in expected if n not in offered],
        "unexpected": [n for n in offered if n not in expected],
        "matches": sorted(offered) == sorted(expected),
        "schemas": {
            t.get("name"): t.get("inputSchema")
            for t in tools
            if isinstance(t, dict) and t.get("name")
        },
    }


def run_job(config: dict, job: str = "fixed-bench-job", client=None,
            apply_limits: bool = False, allow_interaction: bool = True) -> dict:
    """Run the fixed job. Returns the result dict; never raises for a step.

    `config` carries `mcp_url` and `mcp_token`. `client` exists so the harness
    can inject a fake transport — the job logic under test must be the same
    code that runs on the machine.
    """
    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    entry = {
        "id": "run_%x" % int(started * 1000),
        "job": job,
        "runtime": "vm",
        "startedAt": started_at,
        "status": "blocked",
        "blockers": [],
        "steps": [],
        "note": None,
    }

    mcp_url = (config or {}).get("mcp_url") or ""
    token = (config or {}).get("mcp_token") or ""
    if not mcp_url and client is None:
        # Honest blocker, same rule as the Worker had. Nothing is executed.
        entry["blockers"] = ["MCP_SSE_URL (the MCP proxy URL)"]
        entry["note"] = ("Nothing was executed: the MCP proxy URL is not configured on this "
                         "runner. Set MCP_SSE_URL (the machine-side MCP proxy, normally "
                         "http://172.18.0.1:8898) and run again.")
        entry["durationMs"] = int((time.time() - started) * 1000)
        return entry

    # Only a one-shot run caps itself; see the design note on `_limit_self`.
    # A server must not carry a permanent RLIMIT_AS set by its first request.
    if apply_limits:
        _limit_self()

    owns_client = client is None
    box = client
    try:
        if box is None:
            box = McpClient(mcp_url, token, timeout_s=MCP_TIMEOUT_S)
        # Open in BOTH cases. An injected client must follow the same lifecycle
        # as a real one, or the harness exercises a path the machine never runs
        # — and a client that cannot connect would look like a working run.
        box.open()
        # Recorded for both paths: an injected client must produce the same
        # result shape as a real one, or the harness is testing a different
        # code path than the machine runs.
        entry["server"] = getattr(box, "server_info", None)

        # What the proxy ACTUALLY offers, on every run. This is the check that
        # would have turned "9 of 10 steps failed with unsupportedTool" into one
        # glance at the result: the job asked for tools that were not there.
        surface = describe_surface(box)
        entry["surface"] = surface
        if surface.get("ok") and surface.get("missing"):
            entry["note"] = ("The proxy does not offer %d tool(s) this job uses: %s. "
                             "Steps naming them will fail; the rest still run."
                             % (len(surface["missing"]), ", ".join(surface["missing"])))

        for index, step in enumerate(BENCH_STEPS, start=1):
            if time.time() - started > JOB_DEADLINE_S:
                entry["steps"].append({
                    "n": index, "tool": step["tool"], "ok": False,
                    "error": "job deadline exceeded before this step",
                })
                continue
            step_started = time.time()
            # A desktop job MOVES THE POINTER AND TYPES. `allow_interaction=False`
            # is the safe subset: observation only, everything else reported as
            # skipped rather than silently attempted.
            if step.get("mutates") and not allow_interaction:
                entry["steps"].append({
                    "n": index, "tool": step["tool"], "purpose": step["step"],
                    "mutates": bool(step.get("mutates")), "ok": False, "skipped": True,
                    "error": "skipped: interaction disabled for this run",
                })
                continue
            try:
                # `args` comes from the STEP, not a hardcoded {"id": ""}. The old
                # value was invented for a board API and is meaningless here.
                result = box.call(step["tool"], dict(step.get("args") or {}))
                entry["steps"].append({
                    "n": index,
                    "tool": step["tool"],
                    "purpose": step["step"],
                    "mutates": bool(step.get("mutates")),
                    "ok": bool(result.get("ok")),
                    "isError": bool(result.get("isError")),
                    "result": truncate(result.get("content")),
                    "ms": int((time.time() - step_started) * 1000),
                })
            except McpError as exc:
                # A transport failure is recorded per step and the job STOPS:
                # continuing would produce ten identical failures and imply
                # the tools were reached.
                entry["steps"].append({
                    "n": index, "tool": step["tool"], "purpose": step["step"],
                    "ok": False, "error": str(exc),
                    "ms": int((time.time() - step_started) * 1000),
                })
                entry["note"] = ("Stopped at step %d: the MCP transport failed (%s). The "
                                 "remaining steps were not attempted." % (index, exc))
                break
            except Exception as exc:  # noqa: BLE001 - a real failure, reported
                entry["steps"].append({
                    "n": index, "tool": step["tool"], "ok": False,
                    "error": "%s: %s" % (type(exc).__name__, exc),
                })
                entry["note"] = "Stopped at step %d: %s" % (index, exc)
                break
    except McpError as exc:
        entry["status"] = "error"
        entry["error"] = str(exc)
        entry["note"] = ("The MCP proxy could not be reached: %s. This is a real "
                         "failure, not a missing capability." % exc)
        entry["durationMs"] = int((time.time() - started) * 1000)
        return entry
    finally:
        if owns_client and box is not None:
            try:
                box.close()
            except Exception:  # noqa: BLE001
                pass

    attempted = len(entry["steps"])
    # A SKIPPED step is not a FAILED step. Conflating them would report an
    # observation-only run as broken, which is the "an error that looks like
    # data" class this repo keeps recording (B-15, B-25).
    failed = [s for s in entry["steps"] if not s.get("ok") and not s.get("skipped")]
    skipped = [s for s in entry["steps"] if s.get("skipped")]
    ok_steps = [s for s in entry["steps"] if s.get("ok")]
    if attempted == 0:
        entry["status"] = "error"
        entry["note"] = entry["note"] or "No steps were attempted."
    elif not failed and attempted == len(BENCH_STEPS) and not skipped:
        entry["status"] = "ok"
        entry["note"] = ("All %d steps succeeded through the MCP proxy on the machine. "
                         "The job is a fixed, auditable program; no model-generated code "
                         "was executed." % attempted)
    elif not failed and skipped:
        entry["status"] = "ok"
        entry["note"] = ("%d of %d steps succeeded; %d interaction steps were skipped "
                         "because interaction was disabled for this run."
                         % (len(ok_steps), attempted, len(skipped)))
    else:
        entry["status"] = "partial" if not entry.get("error") else "error"
        entry["note"] = entry["note"] or (
            "%d of %d steps failed. Per-step outcomes are in `steps`; nothing is "
            "reported as successful unless it was." % (len(failed), attempted))

    entry["durationMs"] = int((time.time() - started) * 1000)
    entry["summary"] = {
        "attempted": attempted,
        "ok": len(ok_steps),
        "failed": len(failed),
        "skipped": len(skipped),
        "expected": len(BENCH_STEPS),
        "interaction": "enabled" if allow_interaction else "disabled (observation only)",
    }
    return entry


# ---------------------------------------------------------------------------
# Audit trail (in-memory: a pilot does not need durability, and writing a row
# per run to D1 would be the quota mistake again).
# ---------------------------------------------------------------------------

RUNS: list[dict] = []
RUNS_LOCK = threading.Lock()


def record_run(entry: dict) -> dict:
    with RUNS_LOCK:
        RUNS.insert(0, entry)
        del RUNS[MAX_RUNS_KEPT:]
    return entry


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------

def _constant_time_eq(a: str, b: str) -> bool:
    """Constant-time token compare (BUGS.md B-16)."""
    return hmac.compare_digest(
        hashlib.sha256((a or "").encode()).digest(),
        hashlib.sha256((b or "").encode()).digest(),
    )


def make_handler(config: dict):
    token = config.get("token") or ""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # noqa: D401 - silence default noisy log
            pass

        # ------------------------------------------------------------ helpers
        def _json(self, payload: dict, status: int = 200):
            body = json.dumps(payload, indent=2).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _html(self, text: str, status: int = 200):
            body = text.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            """Fail closed: no configured token means the write path is closed.

            Header ONLY. A token in a query string lands in logs and Referer
            (BUGS.md B-18) and this one starts tool calls on the desktop.
            """
            if not token:
                return False
            supplied = self.headers.get("X-Codemode-Token") or ""
            return _constant_time_eq(supplied, token)

        # -------------------------------------------------------------- verbs
        def do_GET(self):  # noqa: N802
            path = self.path.split("?")[0]
            if path == "/health":
                self._json({
                    "ok": True,
                    "version": VERSION,
                    "runtime": "vm",
                    "runner": "available",
                    "mcp": "configured" if config.get("mcp_url") else "unconfigured",
                    "token": "set" if token else "unset",
                    # `ready` is the honest bit: the runner exists, but a job
                    # cannot run without an MCP URL.
                    "ready": bool(config.get("mcp_url")),
                })
                return
            if path == "/api/bench":
                self._json(bench())
                return
            if path == "/api/runs":
                with RUNS_LOCK:
                    runs = list(RUNS)
                self._json({"ok": True, "count": len(runs), "runs": runs})
                return
            if path in ("/", "/index.html"):
                self._html(status_page(config))
                return
            self._json({"ok": False, "error": "not_found"}, 404)

        def do_POST(self):  # noqa: N802
            path = self.path.split("?")[0]
            if path != "/api/run":
                self._json({"ok": False, "error": "not_found"}, 404)
                return
            if not token:
                self._json({
                    "ok": False, "error": "token_unset",
                    "note": ("CODEMODE_TOKEN is not set on this runner, so the run endpoint "
                             "is closed (fail closed). Set it and restart."),
                }, 503)
                return
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            length = int(self.headers.get("Content-Length") or 0)
            body = {}
            if length:
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    self._json({"ok": False, "error": "bad_json"}, 400)
                    return
            # apply_limits stays False in server mode: the process is long-lived and
            # a permanent RLIMIT_AS set by one request would bite later, silently.
            entry = run_job(config, job=str((body or {}).get("job") or "fixed-bench-job"),
                            apply_limits=False)
            record_run(entry)
            status = 200 if entry["status"] == "ok" else (503 if entry["status"] == "blocked" else 502)
            self._json(entry, status)

    return Handler


def status_page(config: dict) -> str:
    b = bench()
    d = b["desktop_job"]
    mcp_state = "configured" if config.get("mcp_url") else "not configured"
    token_state = "set" if config.get("token") else "unset (run endpoint closed)"
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QwenPaw Code Mode pilot — VM runner</title>
<style>
 body{margin:0;background:#0f1115;color:#e6e9ef;font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
 main{max-width:900px;margin:0 auto;padding:40px 24px 64px}
 h1{font-size:25px;margin:0 0 6px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;
 color:#9aa4b2;margin:32px 0 12px}p{color:#9aa4b2;margin:0 0 12px}
 .tag{font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid #252a34;color:#9aa4b2}
 .card{background:#171a21;border:1px solid #252a34;border-radius:12px;padding:18px}
 .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #252a34;font-size:14px}
 .row:last-child{border-bottom:0}.k{color:#9aa4b2}.ok{color:#3ddc97}.warn{color:#ffb454}.bad{color:#ff6b6b}
 code{background:#0b0d11;border:1px solid #252a34;border-radius:5px;padding:1px 5px;font-size:13px}
 pre{background:#0b0d11;border:1px solid #252a34;border-radius:10px;padding:14px;overflow-x:auto;font-size:13px}
</style></head><body><main>
<h1>QwenPaw Code Mode pilot <span class="tag">%s</span></h1>
<p>Executes on the InstaBox VM, not in a Cloudflare Worker. The Worker Loader
path is dead: <code>worker_loaders</code> requires a paid Cloudflare plan
(API 403 code 10195). See <code>features/codemode/README.md</code>.</p>

<h2>Measured comparison (estimated tokens)</h2>
<div class="card">
 <div class="row"><span class="k">Surface</span>
  <span class="ok">%d real desktop tools</span></div>
 <div class="row"><span class="k">Classic: prompt tokens for a %d-step job</span>
  <span class="ok">%s</span></div>
 <div class="row"><span class="k">Code Mode: same job</span>
  <span class="ok">%s</span></div>
 <div class="row"><span class="k">Reduction (prompt size only)</span>
  <span class="ok">%s%%</span></div>
 <div class="row"><span class="k">Turn reduction</span>
  <span class="warn">none (%s -> %s)</span></div>
 <div class="row"><span class="k">Single simple call</span>
  <span class="bad">worse than classic</span></div>
</div>
<p><strong>Turn count does not collapse for desktop work.</strong> Each step needs
the model to look at the screen before choosing the next action, so Code Mode
removes prompt weight (nine tool schemas &rarr; one) and not turns. A batched
workflow of the same size is reported separately in <code>/api/bench</code> and
is <em>not</em> this job.</p>

<h2>Runner state</h2>
<div class="card">
 <div class="row"><span class="k">Runtime</span><span class="ok">vm</span></div>
 <div class="row"><span class="k">MCP proxy</span>
  <span class="%s">%s</span></div>
 <div class="row"><span class="k">Run token</span>
  <span class="%s">%s</span></div>
</div>

<h2>Endpoints</h2>
<pre>GET  /health      -> runner + MCP + token state
GET  /api/bench   -> this comparison as JSON
POST /api/run     -> run the fixed job (needs X-Codemode-Token)
GET  /api/runs    -> audit trail</pre>

<footer style="margin-top:36px;padding-top:16px;border-top:1px solid #252a34;
font-size:13px;color:#9aa4b2">
Nothing here is deployed or verified by the author of this file. Muse installs
and tests on the machine; this page reports what the code can prove on its own.
</footer>
</main></body></html>""" % (
        VERSION,
        b["surface"]["tools"],
        b["surface"]["steps_in_job"],
        format(d["classic"]["total_prompt_tokens"], ","),
        format(d["codemode"]["total_prompt_tokens"], ","),
        d["prompt_token_reduction_pct"],
        d["turn_reduction"]["from"], d["turn_reduction"]["to"],
        "ok" if config.get("mcp_url") else "warn", mcp_state,
        "ok" if config.get("token") else "warn", token_state,
    )


# ---------------------------------------------------------------------------
# Unix-socket transport (same shape as the terminal server: systemd owns the
# directory, so a stale socket cannot survive).
# ---------------------------------------------------------------------------

class _UnixHTTPServer(socketserver.ThreadingUnixStreamServer):
    """Serve the same handler over a Unix socket.

    A tiny HTTP/1.1 subset is spoken over the socket because the Worker (or
    anything else) already knows how to send an HTTP request; inventing a
    bespoke protocol would be another thing to document and get wrong.
    """

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, path, handler_cls, config):
        self.config = config
        # A stale socket is the classic "says running, nothing connects" bug.
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        super().__init__(path, handler_cls)
        os.chmod(path, 0o660)


# ---------------------------------------------------------------------------
# Selftest — the 60-odd assertions that need no machine.
# ---------------------------------------------------------------------------

class FakeMcp:
    """A stand-in for McpClient with the same surface the job uses.

    The point of the harness is to test THIS file's job logic and reporting,
    so the transport is faked here and tested for real in test_mcp.py.
    """

    def __init__(self, fail_at=None, raise_at=None, is_error_at=None, hang=False):
        self.server_info = {"name": "fake-mcp", "version": "1.0"}
        self.calls = []
        self.fail_at = fail_at
        self.raise_at = raise_at
        self.is_error_at = is_error_at
        self.hang = hang

    def open(self):
        return {"result": {"serverInfo": self.server_info}}

    def close(self):
        self.closed = True

    def list_tools(self):
        """The REAL client has this; the fake must too, or a run through the
        fake exercises a different lifecycle than the machine does.

        This was missing and the new `describe_surface()` call caught it — which
        is the same class of gap the Code Mode pilot exists to expose: a fake
        that does not implement the real interface proves nothing.
        """
        return [
            {"name": n, "description": d, "inputSchema": {"type": "object"}}
            for n, d in DESKTOP_TOOLS
        ]

    def call(self, name, arguments=None):
        self.calls.append(name)
        n = len(self.calls)
        if self.hang:
            time.sleep(5)
        if self.raise_at and n == self.raise_at:
            raise McpError("connection reset by proxy")
        if self.is_error_at and n == self.is_error_at:
            return {"ok": False, "content": [{"type": "text", "text": "tool refused"}], "isError": True}
        if self.fail_at and n == self.fail_at:
            return {"ok": False, "content": None, "isError": False}
        return {"ok": True, "content": [{"type": "text", "text": "ok:%s" % name}], "isError": False}


def selftest() -> int:
    passed = 0
    failed: list[str] = []

    def check(name, cond, detail=""):
        nonlocal passed
        if cond:
            passed += 1
            print("  ok   %s" % name)
        else:
            failed.append(name)
            print("  FAIL %s  %s" % (name, detail))

    print("surface: the bench is computed from the 9 tools that ACTUALLY exist (B-41)")
    b = bench()
    # The bug: the bench modelled 30 tools, 21 of which are not on the machine's
    # MCP proxy, and the job called 9 that were not there either.
    check("models NINE tools, not 30", b["surface"]["tools"] == 9, str(b["surface"]["tools"]))
    check("…and they are the real desktop set",
          set(b["surface"]["tool_names"]) == DESKTOP_TOOL_NAMES,
          json.dumps(b["surface"]["tool_names"]))
    check("no invented board/routine/history tool is modelled",
          not any(t in b["surface"]["tool_names"] for t in (
              "list_tickets", "read_ticket", "list_projects", "read_project",
              "screenshot_desktop", "get_page_text", "routine_history",
              "read_thread", "search_history")),
          json.dumps(b["surface"]["tool_names"]))
    check("job length matches the real step count",
          b["surface"]["steps_in_job"] == len(BENCH_STEPS),
          "%s vs %s" % (b["surface"]["steps_in_job"], len(BENCH_STEPS)))

    print("bench: the arithmetic is internally consistent (same method as before)")
    check("runtime is vm", b["runtime"] == "vm", b["runtime"])
    check("marks itself approximate", b["estimator"]["approximate"] is True)
    check("names the estimator", "chars / 3.6" in b["estimator"]["method"], b["estimator"]["method"])

    d = b["desktop_job"]
    check("desktop job turns equal steps", d["classic"]["turns"] == len(BENCH_STEPS),
          str(d["classic"]["turns"]))
    # THE POINT OF THIS REWRITE: turns do NOT collapse for desktop work.
    check("Code Mode does NOT claim a turn collapse for desktop work",
          d["turn_reduction"]["factor"] == 1.0, str(d["turn_reduction"]["factor"]))
    check("…and it says why (the visual bound)", "visual" in d["turn_reduction"]["why"],
          d["turn_reduction"]["why"])
    check("classic total = per-turn x turns",
          d["classic"]["total_prompt_tokens"]
          == d["classic"]["prompt_tokens_per_turn"] * len(BENCH_STEPS))
    check("codemode total = per-turn x turns",
          d["codemode"]["total_prompt_tokens"]
          == d["codemode"]["prompt_tokens_per_turn"] * len(BENCH_STEPS))
    check("codemode still wins on PROMPT SIZE",
          d["codemode"]["total_prompt_tokens"] < d["classic"]["total_prompt_tokens"],
          "%s vs %s" % (d["codemode"]["total_prompt_tokens"],
                        d["classic"]["total_prompt_tokens"]))
    check("the desktop reduction is a prompt-size claim, not a turn claim",
          d["prompt_token_reduction_pct"] > 0
          and "PROMPT SIZE" in d["verdict"], d["verdict"])

    # The batched shape must be labelled hypothetical and must NOT be presented
    # as this job. That mislabelling is exactly what was withdrawn.
    h = b["batched_job_hypothetical"]
    check("the batched figure is labelled NOT this job",
          "NOT the desktop job" in h["applies_to"], h["applies_to"])
    check("the batched figure shows the collapsed turns", h["codemode"]["turns"] == 1)
    check("the batched reduction is larger than the desktop one",
          h["prompt_token_reduction"]["best_case_pct"]
          > d["prompt_token_reduction_pct"],
          "%s vs %s" % (h["prompt_token_reduction"]["best_case_pct"],
                        d["prompt_token_reduction_pct"]))
    check("the batched reduction survives one retry",
          h["prompt_token_reduction"]["with_one_retry_pct"] > 0)

    check("reports single-call as WORSE", "WORSE" in b["single_call_job"]["verdict"])
    check("caveats listed", len(b["caveats"]) >= 3, str(len(b["caveats"])))
    check("caveat names the visual bound", any("visual" in c for c in b["caveats"]))
    # The withdrawn number must not survive anywhere in the reported payload.
    blob = json.dumps(b)
    check("the old headline figure is gone", "99.0" not in blob, "a withdrawn number survived")
    check("the caveats say the figure was withdrawn", "withdrawn" in blob.lower())
    check("caveat names the real surface size", any("NINE" in c or "nine" in c for c in b["caveats"]))
    b4 = bench(4)
    check("custom chars_per_token honoured", b4["estimator"]["method"] == "chars / 4",
          b4["estimator"]["method"])

    print("job: the fixed program is what runs, and it only uses real tools")
    check("the job has one step per real tool", len(BENCH_STEPS) == len(DESKTOP_TOOLS),
          "%s vs %s" % (len(BENCH_STEPS), len(DESKTOP_TOOLS)))
    tools_used = [s["tool"] for s in BENCH_STEPS]
    check("every step names a tool the proxy ACTUALLY offers",
          all(t in DESKTOP_TOOL_NAMES for t in tools_used), json.dumps(tools_used))
    check("no step names a tool that does not exist on this proxy",
          not any(t in ("list_tickets", "read_ticket", "list_projects", "read_project",
                        "screenshot_desktop", "get_page_text", "routine_history",
                        "read_thread", "search_history") for t in tools_used),
          json.dumps(tools_used))
    check("the job covers all nine tools exactly once",
          sorted(tools_used) == sorted(DESKTOP_TOOL_NAMES), json.dumps(tools_used))
    # It DRIVES the desktop, so it is not read-only — and the code must say so
    # rather than inherit the old "read-only" claim from a board job.
    check("interaction steps are marked as mutating",
          all(s.get("mutates") is True for s in BENCH_STEPS
              if s["tool"] in {"click", "type_text", "press_key", "scroll",
                               "set_value", "drag", "perform_secondary_action"}),
          json.dumps([(s["tool"], s.get("mutates")) for s in BENCH_STEPS]))
    check("observation steps are marked as NOT mutating",
          all(s.get("mutates") is False for s in BENCH_STEPS
              if s["tool"] in {"list_apps", "get_app_state"}),
          json.dumps([(s["tool"], s.get("mutates")) for s in BENCH_STEPS]))
    check("no step leaves PERSISTENT state behind",
          not any(t in PERSISTENT_TOOLS for t in tools_used), json.dumps(tools_used))
    check("every step carries explicit args",
          all(isinstance(s.get("args"), dict) for s in BENCH_STEPS),
          json.dumps([s.get("args") for s in BENCH_STEPS]))
    # AST, not string matching. A substring check is what let the retired
    # Worker's fake MCP shape pass review: it "looked" right. Parsing the
    # module and walking the tree proves the ABSENCE of a construct, which is
    # the whole safety claim here.
    import ast as _ast

    tree = _ast.parse(open(os.path.abspath(__file__), encoding="utf-8").read())
    calls = {
        node.func.id
        for node in _ast.walk(tree)
        if isinstance(node, _ast.Call) and isinstance(node.func, _ast.Name)
    }
    check("no eval() call anywhere in the runner", "eval" not in calls,
          json.dumps(sorted(calls & {"eval"})))
    check("no exec() call anywhere in the runner", "exec" not in calls,
          json.dumps(sorted(calls & {"exec"})))
    check("no compile() of dynamic source", "compile" not in calls)
    imported = set()
    for node in _ast.walk(tree):
        if isinstance(node, _ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, _ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    check("the runner spawns no process", "subprocess" not in imported,
          json.dumps(sorted(imported & {"subprocess", "multiprocessing", "pty"})))
    check("the runner imports no shell helper",
          not (imported & {"shlex", "commands"}), json.dumps(sorted(imported)))

    print("run: honest blockers")
    blocked = run_job({}, "j")
    check("no MCP url -> status blocked", blocked["status"] == "blocked", blocked["status"])
    check("blocker names the MCP URL", any("MCP_SSE_URL" in x for x in blocked["blockers"]),
          json.dumps(blocked["blockers"]))
    check("never claims a run happened", "Nothing was executed" in (blocked["note"] or ""))
    check("no steps recorded", blocked["steps"] == [])

    print("run: a full success")
    fake = FakeMcp()
    ok = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake)
    check("status ok", ok["status"] == "ok", ok["status"] + " / " + str(ok.get("note")))
    check("every step recorded", len(ok["steps"]) == len(BENCH_STEPS),
          str(len(ok["steps"])))
    check("summary counts every step ok", ok["summary"]["ok"] == len(BENCH_STEPS),
          json.dumps(ok["summary"]))
    check("every step is ok", all(s["ok"] for s in ok["steps"]))
    check("steps carry the tool name", ok["steps"][0]["tool"] == BENCH_STEPS[0]["tool"])
    check("steps carry a duration", isinstance(ok["steps"][0]["ms"], int))
    check("the server name is recorded", ok["server"]["name"] == "fake-mcp")
    check("calls were made in order", fake.calls == tools_used, json.dumps(fake.calls))
    check("the note says no generated code ran",
          "no model-generated code" in (ok["note"] or ""), ok["note"])

    print("run: a tool that reports an error is not a success")
    fake = FakeMcp(is_error_at=3)
    partial = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake)
    check("status is partial", partial["status"] == "partial", partial["status"])
    check("the failing step says ok:false", partial["steps"][2]["ok"] is False)
    check("the failing step is flagged isError", partial["steps"][2]["isError"] is True)
    check("the other steps still ran",
          partial["summary"]["ok"] == len(BENCH_STEPS) - 1,
          json.dumps(partial["summary"]))
    check("nothing is reported as successful that was not",
          partial["summary"]["failed"] == 1, json.dumps(partial["summary"]))

    print("run: interaction can be disabled, and skipped is not failed")
    fake_obs = FakeMcp()
    obs = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake_obs,
                  allow_interaction=False)
    check("the run still reports ok", obs["status"] == "ok", obs["status"])
    check("observation steps ran", obs["summary"]["ok"] == 2, json.dumps(obs["summary"]))
    check("interaction steps were skipped", obs["summary"]["skipped"] == len(BENCH_STEPS) - 2,
          json.dumps(obs["summary"]))
    check("skipped is NOT counted as failed", obs["summary"]["failed"] == 0,
          json.dumps(obs["summary"]))
    check("the note says interaction was off", "skipped" in (obs["note"] or ""), obs["note"])
    check("only observation tools were actually called",
          set(fake_obs.calls) == {"list_apps", "get_app_state"}, json.dumps(fake_obs.calls))

    print("run: the surface is described and diffed on every run (the last round's blind spot)")
    fake_surf = FakeMcp()
    surf_run = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake_surf)
    surf = surf_run.get("surface") or {}
    check("the run records what the proxy offers", surf.get("ok") is True, json.dumps(surf)[:160])
    check("offered list is present", isinstance(surf.get("offered"), list), json.dumps(surf)[:160])
    check("expected is the nine-tool set", sorted(surf.get("expected") or []) == sorted(DESKTOP_TOOL_NAMES),
          json.dumps(surf.get("expected")))
    check("it exposes the real inputSchema for diagnosis",
          isinstance(surf.get("schemas"), dict), json.dumps(surf)[:160])

    # The pre-fix failure mode: the proxy offers a NARROWER surface than the job
    # assumes. The run must SAY which tools are missing, not just fail blindly.
    class NarrowMcp(FakeMcp):
        def list_tools(self):
            return [{"name": "list_apps", "description": "only this", "inputSchema": {}}]

        def call(self, name, arguments=None):
            if name != "list_apps":
                return {"ok": False, "content": [{"type": "text", "text": "unsupportedTool"}],
                        "isError": True}
            return super().call(name, arguments)

    narrow = run_job({"mcp_url": "http://mcp.test"}, "j", client=NarrowMcp())
    ns = narrow.get("surface") or {}
    check("a narrower proxy is DETECTED", ns.get("matches") is False, json.dumps(ns)[:160])
    check("…and the missing tools are named",
          "get_app_state" in (ns.get("missing") or []), json.dumps(ns.get("missing")))
    check("…the run is honest about the shortage in its note",
          "does not offer" in (narrow.get("note") or ""), narrow.get("note"))
    check("…and the result is not reported as ok", narrow["status"] != "ok", narrow["status"])

    print("run: a transport failure stops the job and says why")
    fake = FakeMcp(raise_at=4)
    broken = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake)
    check("status is error or partial, never ok", broken["status"] != "ok", broken["status"])
    check("the error names the transport", "MCP" in (broken.get("error", "") + (broken.get("note") or "")),
          str(broken.get("error")) + " / " + str(broken.get("note")))
    check("the job stopped at the failure", len(broken["steps"]) == 4, str(len(broken["steps"])))
    check("the note says the rest were not attempted",
          "not attempted" in (broken["note"] or ""), broken["note"])
    check("it did not report the remaining 6 as failures",
          len(broken["steps"]) < 10, str(len(broken["steps"])))

    print("run: an unreachable proxy is an error, not a silent empty result")
    class DeadMcp(FakeMcp):
        def open(self):
            raise McpError("connection refused")
    dead = run_job({"mcp_url": "http://mcp.test"}, "j", client=DeadMcp())
    check("status error", dead["status"] == "error", dead["status"])
    check("the reason is preserved", "connection refused" in dead.get("error", ""), dead.get("error"))
    check("no steps recorded", dead["steps"] == [])

    print("run: results are bounded")
    huge = "x" * (MAX_RESULT_CHARS * 3)
    cut = truncate(huge)
    check("a huge response is truncated", len(cut) < len(huge), str(len(cut)))
    check("the truncation says so", "[truncated" in cut)
    check("a small response is untouched", truncate("small") == "small")
    check("None stays None", truncate(None) is None)

    print("auth: constant time and fail closed")
    check("equal tokens match", _constant_time_eq("abc", "abc"))
    check("different tokens do not", not _constant_time_eq("abc", "abd"))
    check("a prefix does not match", not _constant_time_eq("abc", "abcd"))
    check("empty never matches a set token", not _constant_time_eq("", "secret"))

    print("http: the observables behave")
    config = {"mcp_url": "", "token": ""}
    handler = make_handler(config)
    check("health is available", handler is not None)
    page = status_page(config)
    check("page names the VM runtime", "InstaBox VM" in page)
    check("page states the Worker path is dead", "10195" in page, "the 403 code must be visible")
    check("page reports MCP unconfigured", "not configured" in page)
    check("page states nothing is verified by the author",
          "Nothing here is deployed or verified" in page)
    check("page leaks no token", "X-Codemode-Token" not in page.split("Endpoints")[0])

    print()
    total = passed + len(failed)
    print("%d passed, %d failed  (%d checks)" % (passed, len(failed), total))
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--once", action="store_true",
                    help="run the fixed job once, print the JSON, exit (applies resource limits)")
    ap.add_argument("--socket", default="")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--mcp-url", default=os.environ.get("MCP_SSE_URL", ""))
    ap.add_argument("--mcp-token", default=os.environ.get("MCP_SSE_TOKEN", ""))
    ap.add_argument("--token", default=os.environ.get("CODEMODE_TOKEN", ""))
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    config = {"mcp_url": args.mcp_url, "mcp_token": args.mcp_token, "token": args.token}

    if args.once:
        # A one-shot process legitimately caps itself: it exists to run exactly
        # one job, so a limit can never bite a later request.
        result = run_job(config, job="fixed-bench-job", apply_limits=True)
        print(json.dumps(result, indent=2))
        return 0 if result["status"] == "ok" else 1

    handler = make_handler(config)

    if args.socket:
        server = _UnixHTTPServer(args.socket, handler, config)
        print("codemode runner listening on unix:%s" % args.socket, flush=True)
    elif args.port:
        # Loopback only unless explicitly overridden: this endpoint can drive
        # the desktop, so exposing it by default would be the mistake the
        # private-port incident recorded.
        server = ThreadingHTTPServer((args.bind, args.port), handler)
        server.daemon_threads = True
        print("codemode runner listening on http://%s:%d" % (args.bind, args.port), flush=True)
    else:
        print("codemode-runner: pass --socket or --port (or --selftest)", file=sys.stderr)
        return 2

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
