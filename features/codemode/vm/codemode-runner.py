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
predictable jobs. The FIXED job below (`BENCH_STEPS`) is still the only job
that runs on the MAIN container: it is a fixed, auditable program chosen so
a run tells you whether the *runtime* works. A generated script would
confound "the harness failed" with "the model wrote bad code", which is the
one thing a pilot must not do.

Generated code runs ONLY in the sandbox (gap #6, T139): `run_sandbox_job`
routes a generated-code job through `dispatch.route_job`, builds the
sandbox profile, validates it, mints a short-lived scoped token, and runs
`docker run` from `docker_run_argv`. Anything that cannot run in the
sandbox is REFUSED with a named reason, never silently fallen back to the
main container. The fixed pilot job is the one legacy exception (exact job
id `codemode-fixed-job`): it drives the real desktop through the MCP proxy
and cannot run in the sandbox.

THE SAFETY MODEL (this runs on a box that holds the user's auth file)

  1. FIXED JOB ONLY, on main. There is no `eval`, no `exec`, no template
     that accepts caller text for the main-container job. The only way to
     change what runs there is to edit this file and commit it. That is
     deliberate and it is the whole sandbox for the main path.
  1b. GENERATED CODE ONLY in the sandbox. A generated-code job is routed
     by `route_job`, runs as uid 10001 on the isolated bridge
     `qwenpaw-sandbox-net` with a workspace-only mount, no docker.sock,
     no route to the vault broker, and a 300 s hard deadline. Its only
     credential is a 90 s scoped token on a tmpfs file — never the
     broker token, never in env.
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
import re
import resource
import shutil
import signal
import socket
import socketserver
import subprocess
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

#: Parameter names and types the proxy ACTUALLY declares, per tool. Used to
#: build a schema that is the RIGHT SHAPE.
#:
#: Recorded live from the proxy's own `inputSchema` (run_1a1e8f3fd71,
#: 2026-11-17, surface.schemas) — this table is no longer "the arguments the
#: job passes" but the surface the proxy declares. Two corrections B-43 made
#: here: (1) `scroll` had `dy` and `drag` had `x1/y1/x2/y2` — neither is a
#: proxy argument, so the bench was estimating a schema nobody can call;
#: (2) `element_index` is a STRING in the proxy's schema ("Element
#: identifier"), not an integer — the job passes it as one.
#: Types use the runner's short names: "string", "int", "number", "bool".
#: `text_limit` is anyOf integer | "max" on the proxy; "string" is the
#: representative here (the estimator only needs a type label).
TOOL_PARAMS = {
    "list_apps": {},
    "get_app_state": {"app": "string", "include_ax": "bool",
                      "include_screenshot": "bool", "max_tree_depth": "int",
                      "max_tree_nodes": "int", "text_limit": "string"},
    "click": {"app": "string", "click_count": "int", "click_method": "string",
              "element_index": "string", "mouse_button": "string",
              "x": "number", "y": "number"},
    "type_text": {"app": "string", "key_method": "string", "text": "string"},
    "press_key": {"app": "string", "key": "string", "key_method": "string"},
    "scroll": {"app": "string", "direction": "string",
               "element_index": "string", "pages": "number"},
    "set_value": {"app": "string", "element_index": "string", "value": "string"},
    "drag": {"app": "string", "from_x": "number", "from_y": "number",
             "to_x": "number", "to_y": "number"},
    "perform_secondary_action": {"action": "string", "app": "string",
                                 "element_index": "string"},
}

#: The arguments each tool MARKS AS REQUIRED. This is the live proxy's actual
#: requirement, confirmed 2026-11-17 by run_1a1e8f3fd71 (B-42) and re-read
#: from the recorded `surface.schemas` (B-43).
#:
#: B-41 shipped args without `app` and the live run answered, for all eight
#: non-listing tools:
#:
#:     Missing required argument: app
#:
#: `app` is therefore REQUIRED on every tool except `list_apps`. It is kept in a
#: separate structure from `TOOL_PARAMS` because the two answer different
#: questions: `TOOL_PARAMS` shapes the schema (and the token estimate),
#: `TOOL_REQUIRED` decides whether a call is even attempted. A single dict
#: could not express "present in the schema, required at call time".
#:
#: WHY THIS IS A TABLE RATHER THAN A GUESS AT CALL TIME
#:
#: The whole B-41 lesson was that inventing an argument shape produces a run
#: that fails in a way nobody predicted. So this table is filled from the live
#: `surface.schemas` the proxy itself reported, and `preflight_step()` checks
#: every required name BEFORE the call — a missing one becomes a named,
#: skipped step instead of a tool error eight times in a row.
#: B-43: the table is the FULL live requirement, not just `app`. B-42's
#: run (run_1a1e8f3fd71) got 5/9 and the next layer was four more missing
#: arguments the proxy reports one at a time: scroll/set_value/psa need
#: `element_index`, drag needs all four coordinates, scroll needs
#: `direction`, psa needs `action`, type_text needs `text`, press_key needs
#: `key`. The recorded `surface.schemas` (same run) is the source; the
#: selftest asserts this table equals it.
TOOL_REQUIRED = {
    "list_apps": (),
    "get_app_state": ("app",),
    "click": ("app",),
    "type_text": ("app", "text"),
    "press_key": ("app", "key"),
    "scroll": ("app", "element_index", "direction"),
    "set_value": ("app", "element_index", "value"),
    "drag": ("app", "from_x", "from_y", "to_x", "to_y"),
    "perform_secondary_action": ("app", "element_index", "action"),
}

#: Marker for "this argument is not known until the job has run a step".
#: A step carrying `APP_FROM_LIST` for `app` gets the name resolved from the
#: `list_apps` result — never a hard-coded app that may not be running.
APP_FROM_LIST = "__from_list_apps__"

#: Markers for arguments derived from step 2's `get_app_state` tree (B-43).
#: A step carrying one of these gets the value resolved from the parsed
#: accessibility tree at run time — never a hard-coded index, action, or
#: coordinate that the live surface may not have.
#:   `ELEMENT_FROM_TREE` — `element_index`, resolved by the step's selector
#:     (scroll: largest scrollable; set_value: first settable;
#:     perform_secondary_action: first element with Secondary Actions).
#:   `ACTION_FROM_TREE` — `action`, the first Secondary Action listed on the
#:     chosen element, verbatim as printed.
#:   `DRAG_FROM_TREE` — `from_x`/`from_y`/`to_x`/`to_y`, derived from the
#:     chosen element's Frame bounds (centre +/- offset).
ELEMENT_FROM_TREE = "__from_app_state_tree__"
ACTION_FROM_TREE = "__from_app_state_tree_action__"
DRAG_FROM_TREE = "__from_app_state_tree_drag__"

#: Scroll direction for the fixed job. The proxy's own schema description
#: says "Scroll direction: up, down, left, or right", so "down" is a
#: documented value, not a guess. `pages` is deliberately NOT sent: it is
#: optional, defaults to 1, and its units are unverified.
SCROLL_DIRECTION = "down"

#: The value `set_value` assigns. A bench payload, not surface data: it must
#: not be derived from the element's role or name (inventing a value from the
#: tree is a guess and makes the step untestable).
SET_VALUE_TEXT = "pilot"

#: Coordinate space for drag derivation. `Frame:` values are window-relative;
#: the live root frame is (0,0), so window == screen here. If the proxy ever
#: turns out to want screen coordinates, the fix is one line — add the root
#: frame's x/y to each derived coordinate — carried behind this constant.
DRAG_ORIGIN_OFFSET = "root"

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
    # Steps 2-9 all need `app`, and NONE of them hard-codes a name: the marker
    # is resolved from step 1's real result at run time. Hard-coding "Chromium"
    # would pass today and fail the first time Chromium is not running, which is
    # exactly the class of guess this pilot keeps having to remove.
    {"tool": "get_app_state", "step": "read the focused application's accessibility tree",
     "args": {"app": APP_FROM_LIST}, "mutates": False},
    {"tool": "click", "step": "click a point in the application window",
     "args": {"app": APP_FROM_LIST, "x": 400, "y": 300}, "mutates": True},
    {"tool": "type_text", "step": "type a line of text",
     "args": {"app": APP_FROM_LIST, "text": "codemode pilot"}, "mutates": True},
    {"tool": "press_key", "step": "press Return",
     "args": {"app": APP_FROM_LIST, "key": "Return"}, "mutates": True},
    {"tool": "scroll", "step": "scroll the focused view down",
     "args": {"app": APP_FROM_LIST, "direction": SCROLL_DIRECTION,
              "element_index": ELEMENT_FROM_TREE}, "mutates": True},
    {"tool": "set_value", "step": "set a value through the accessibility API",
     "args": {"app": APP_FROM_LIST, "value": SET_VALUE_TEXT,
              "element_index": ELEMENT_FROM_TREE}, "mutates": True},
    {"tool": "drag", "step": "drag across the application window",
     "args": {"app": APP_FROM_LIST, "from_x": DRAG_FROM_TREE,
              "from_y": DRAG_FROM_TREE, "to_x": DRAG_FROM_TREE,
              "to_y": DRAG_FROM_TREE},
     "mutates": True},
    {"tool": "perform_secondary_action", "step": "invoke a secondary accessibility action",
     "args": {"app": APP_FROM_LIST, "element_index": ELEMENT_FROM_TREE,
              "action": ACTION_FROM_TREE}, "mutates": True},
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
    """One tool schema, shaped from the parameters that tool actually takes.

    `required` is emitted too. A schema that lists `app` as a property but not
    as required understates the proxy's demand, and the token estimate would be
    describing a surface nobody can call.
    """
    params = TOOL_PARAMS.get(name, {})
    props = ",".join(
        '"%s":{"type":"%s"}' % (p, {"int": "integer", "number": "number",
                                    "bool": "boolean"}.get(t, "string"))
        for p, t in params.items()
    )
    required = ",".join('"%s"' % r for r in TOOL_REQUIRED.get(name, ()))
    req_json = (',"required":[%s]' % required) if required else ""
    return ('{"name":"%s","description":"%s","parameters":{"type":"object",'
            '"properties":{%s}%s}}' % (name, description, props, req_json))


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


def _text_of(content) -> str:
    """Flatten an MCP `content` array to plain text. Never raises."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    try:
        for item in content:
            if isinstance(item, dict):
                t = item.get("text")
                if isinstance(t, str):
                    parts.append(t)
            elif isinstance(item, str):
                parts.append(item)
    except TypeError:
        return str(content)
    return "\n".join(parts)


def parse_running_apps(list_apps_text: str) -> list:
    """Extract running application names from a `list_apps` result.

    THE REAL SHAPE, captured live (T11/T12 in features/test-project/RESULTS.md):

        Chromium -- Chromium [running, pid=104998, window=Today's Puzzle ...]
        xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled]
        xfwm4 -- xfwm4 [running, pid=109672, window=untitled]

    Each line begins with the app name followed by ` -- `. The name before the
    separator is what the other tools take as `app`.

    WHY PARSE RATHER THAN HARD-CODE. The name has to come from what is actually
    running. A job that hard-codes "Chromium" reports a fake failure the first
    time the browser is closed, and a pilot that fails for a reason unrelated to
    the thing it measures is worse than useless.

    Returns [] when nothing matches — the caller then reports an honest skip
    rather than inventing a name.
    """
    names = []
    for raw in str(list_apps_text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        # The separator is the contract. A line without it is not an app entry,
        # and treating free text as a name would make the job target a sentence.
        if " -- " not in line:
            continue
        name = line.split(" -- ", 1)[0].strip()
        # Drop any bracket decoration left by a variant format.
        name = name.split("[", 1)[0].strip()
        if not name or len(name) > 80:
            continue
        if name not in names:
            names.append(name)
    return names


def pick_app(names: list) -> str | None:
    """Choose which running app the interaction steps should target.

    A REAL window beats a panel/desktop helper, because `get_app_state` and
    `perform_secondary_action` are only meaningful for an app that owns a
    window. The live list is e.g. Chromium, xfce4-panel, xfce4-terminal,
    xfdesktop, xfwm4 — the panel/desktop/wm entries are infrastructure, so they
    rank last. First real app wins, preserving the proxy's own order otherwise.
    """
    if not names:
        return None
    infra = ("xfce4-panel", "xfdesktop", "xfwm4", "xfce4-notifyd", "xfsettingsd")
    for n in names:
        if n.lower() not in infra:
            return n
    return names[0]          # only infrastructure is running: use what we have


# ---------------------------------------------------------------------------
# The accessibility tree (B-43)
#
# Step 2's `get_app_state` returns the tree as text. Steps 6-9 need values
# that only exist inside that tree — an element index, a secondary action,
# a frame to drag across. Those values are DERIVED here, from the text the
# proxy actually returned, never invented.
#
# THE REAL SHAPE, captured live (run_1a1e8f3fd71, 2026-11-17):
#
#     App=Chromium (pid 104998)
#     Window: "Today's Puzzle Answers (November 16, 2026) - Chromium", App: Chromium.
#     	0 frame Today's Puzzle Answers (November 16, 2026) - Chromium
#     	    Secondary Actions: doDefault, showContextMenu
#     	    Frame: {x: 0, y: 0, width: 1920, height: 1004}
#
# A tree line is: TAB-indented, an index, a role, a name, optionally
# "Secondary Actions: <comma list>", optionally "Frame: {x, y, width,
# height}". Header lines ("App=...", "Window: ...") carry no index and are
# skipped. The parse goes right-to-left — Frame first, then Secondary
# Actions — so a name may contain commas, parentheses, quotes, and even the
# words "Frame:" without corrupting the parse. Only the Secondary Actions
# payload is ever split on commas.
# ---------------------------------------------------------------------------

#: AX roles, longest first. Roles are multi-word ("push button", "text
#: field", "web area"), so the lexicon must match longest-first or "push
#: button" parses as role "push" with name "button ...".
ROLE_LEXICON = (
    "generic container", "push button", "radio button", "text field",
    "combo box", "check box", "scroll bar", "spin button", "list item",
    "tree item", "tab panel", "menu item", "tool bar", "menu bar",
    "list box", "web area", "static text", "document", "heading",
    "paragraph", "window", "dialog", "slider", "button", "image",
    "group", "table", "cell", "row", "link", "list", "tree", "menu",
    "frame", "tab", "generic", "panel", "canvas", "text", "edit",
)

#: Roles a scroll can meaningfully target. The tree carries no focus marker,
#: so "the focused view" is approximated by the LARGEST scrollable
#: container — a deterministic, surface-derived proxy, not a guess.
SCROLLABLE_ROLES = frozenset({
    "frame", "document", "web area", "list", "list box", "table", "tree",
    "group", "scroll bar", "canvas",
})

#: Roles that accept a value through the accessibility API. A frame has no
#: AX value, so it is NOT settable — sending `set_value` at a frame is a
#: guaranteed-futile call, and the job skips it honestly instead.
SETTABLE_ROLES = frozenset({
    "text field", "text box", "edit", "combo box", "spin button",
    "slider", "check box", "radio button",
})

#: Roles a drag can meaningfully cross (must have frame bounds).
DRAGGABLE_ROLES = frozenset({
    "frame", "document", "web area", "list", "table", "canvas", "image",
    "group",
})

_FRAME_RE = re.compile(r"Frame:\s*\{\s*x:\s*(-?\d+),\s*y:\s*(-?\d+),"
                       r"\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}")
_SA_RE = re.compile(r"Secondary Actions:\s*(.*)$")
_INDEX_RE = re.compile(r"^(\d+)\s+(.*)$")
_ENUM_RES = (
    re.compile(r"must be one of\s*[\[\(]\s*([^\]\)]+)[\]\)]", re.IGNORECASE),
    re.compile(r"one of:?\s*(.+)$", re.IGNORECASE),
    re.compile(r"[Aa]llowed values:?\s*(.+)$"),
)


def split_role_name(rest: str) -> tuple:
    """Split a tree-line body into (role, name). Longest-first lexicon."""
    low = rest.lower()
    for role in ROLE_LEXICON:
        if low == role or low.startswith(role + " "):
            return role, rest[len(role):].strip().strip('"')
    # Unknown role: first token is the role, the rest is the name.
    tok, _, tail = rest.partition(" ")
    return tok.lower(), tail.strip().strip('"')


def parse_tree(tree_text) -> list:
    """Parse `get_app_state` tree text into element dicts.

    Each element: {index, role, name, actions, frame, depth}. `frame` is
    {x, y, w, h} or None; `actions` is the Secondary Actions list (possibly
    empty). Header lines and blank lines are skipped. Never raises for a
    shape surprise — an unparsable line is skipped, not fatal.
    """
    out = []
    try:
        lines = str(tree_text or "").splitlines()
    except Exception:  # noqa: BLE001 - a non-string tree is no tree
        return out
    for raw in lines:
        if not raw.strip():
            continue
        # Indentation is depth; normalise 2 spaces to 1 tab first so a
        # space-indented variant parses the same way.
        depth = len(raw) - len(raw.lstrip("\t"))
        if depth == 0 and raw.startswith("  "):
            depth = (len(raw) - len(raw.lstrip(" "))) // 2
        body = raw.strip()
        m = _INDEX_RE.match(body)
        if not m:
            continue  # header line: "App=... (pid N)", "Window: ..."
        idx, rest = int(m.group(1)), m.group(2)

        frame = None
        fm = _FRAME_RE.search(rest)
        if fm:
            frame = {"x": int(fm.group(1)), "y": int(fm.group(2)),
                     "w": int(fm.group(3)), "h": int(fm.group(4))}
            rest = rest[:fm.start()].rstrip()

        actions = []
        am = _SA_RE.search(rest)
        if am:
            actions = [a.strip() for a in am.group(1).split(",") if a.strip()]
            rest = rest[:am.start()].rstrip()

        role, name = split_role_name(rest)
        out.append({"index": idx, "role": role, "name": name,
                    "actions": actions, "frame": frame, "depth": depth})
    return out


def _frame_area(elem: dict) -> int:
    f = elem.get("frame")
    return (f["w"] * f["h"]) if f else 0


def select_scroll(tree: list):
    """The element `scroll` should target: the largest scrollable container.

    Tie-break: lowest index. If two candidates are within 20% of each other
    in area, prefer the deeper one (a nested web area over its frame).
    Returns the element dict or None.
    """
    cands = [e for e in (tree or []) if e.get("role") in SCROLLABLE_ROLES]
    if not cands:
        return None
    best = max(cands, key=lambda e: (_frame_area(e), -e["index"]))
    for e in cands:
        if e is best:
            continue
        area = _frame_area(e)
        if area and _frame_area(best) and abs(area - _frame_area(best)) <= 0.2 * _frame_area(best):
            if e["depth"] > best["depth"]:
                best = e
    return best


def select_settable(tree: list):
    """The element `set_value` should target: the first settable element.

    Lowest index wins. A frame is never settable — see SETTABLE_ROLES.
    Returns the element dict or None.
    """
    for e in sorted(tree or [], key=lambda x: x["index"]):
        if e.get("role") in SETTABLE_ROLES:
            return e
    return None


def select_action(tree: list):
    """The element `perform_secondary_action` should target: the first
    element that lists Secondary Actions. Lowest index wins. Returns the
    element dict or None."""
    for e in sorted(tree or [], key=lambda x: x["index"]):
        if e.get("actions"):
            return e
    return None


def select_drag(tree: list):
    """The element `drag` should cross: the largest draggable element with
    frame bounds. Falls back to the index-0 root frame when it has bounds.
    Returns the element dict or None."""
    cands = [e for e in (tree or [])
             if e.get("role") in DRAGGABLE_ROLES and e.get("frame")]
    if not cands:
        return None
    return max(cands, key=lambda e: (_frame_area(e), -e["index"]))


def derive_drag_coords(elem: dict, root: dict = None):
    """Derive drag coordinates from an element's frame bounds.

    Centre +/- offset: maximally interior (immune to toolbar/decoration
    edges), symmetric, and it re-derives for any window size. `off` is the
    smaller of 80px and an eighth of each dimension, so the drag stays
    inside the frame. Returns (from_x, from_y, to_x, to_y) or None when the
    element is too small to drag across. Never clamps silently — a
    coordinate outside the bounds is a skip, not an invented point.
    """
    if not elem or not elem.get("frame"):
        return None
    f = elem["frame"]
    if root and root.get("frame"):
        rf = root["frame"]
        x0 = max(f["x"], rf["x"])
        y0 = max(f["y"], rf["y"])
        x1 = min(f["x"] + f["w"], rf["x"] + rf["w"])
        y1 = min(f["y"] + f["h"], rf["y"] + rf["h"])
        if x1 <= x0 or y1 <= y0:
            return None
        f = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
    off = min(80, f["w"] // 8, f["h"] // 8)
    if off < 8:
        return None
    cx, cy = f["x"] + f["w"] // 2, f["y"] + f["h"] // 2
    coords = (cx - off, cy - off, cx + off, cy + off)
    if not (f["x"] <= coords[0] and coords[2] <= f["x"] + f["w"]
            and f["y"] <= coords[1] and coords[3] <= f["y"] + f["h"]):
        return None
    return coords


def extract_enum(error_text: str) -> list:
    """Pull a value list out of an error message, if the error names one.

    Matches "must be one of [...]", "one of: ...", "Allowed values: ...".
    Returns the list of bare values, or [] when the error names no enum.
    """
    for rx in _ENUM_RES:
        m = rx.search(str(error_text or ""))
        if m:
            return [v.strip().strip("'\"") for v in
                    re.split(r"[,|]", m.group(1)) if v.strip()]
    return []


def enum_retry_args(tool: str, args: dict, error_text: str):
    """One retry, only when the proxy's error names the enum it wants.

    `scroll` with a rejected `direction`: retry with the enum member that
    case-insensitively maps to "down". `perform_secondary_action` with a
    rejected `action`: retry with the enum member matching the derived
    action. Anything else: None (no retry — the verbatim error is recorded
    so the next run can pin the real value). Returns new args or None.
    """
    values = extract_enum(error_text)
    if not values:
        return None
    if tool == "scroll" and args.get("direction"):
        want = str(args["direction"]).lower()
        for v in values:
            if v.lower() == want:
                return dict(args, direction=v)
        return None
    if tool == "perform_secondary_action" and args.get("action"):
        want = str(args["action"])
        for v in values:
            if v == want or v.lower() == want.lower():
                return dict(args, action=v)
        return None
    return None


#: The live tree from run_1a1e8f3fd71 (2026-11-17) — the surface the job
#: actually runs against. The selftest's FakeMcp returns this text, so the
#: job's honest outcome on the live app is 8 passed / 1 skipped
#: (`set_value`: a frame has no AX value).
TREE_LIVE_FRAME_ONLY = (
    "App=Chromium (pid 104998)\n"
    "Window: \"Today's Puzzle Answers (November 16, 2026) - Chromium\", App: Chromium.\n"
    "\t0 frame Today's Puzzle Answers (November 16, 2026) - Chromium "
    "Secondary Actions: doDefault, showContextMenu "
    "Frame: {x: 0, y: 0, width: 1920, height: 1004}"
)

#: A richer tree fixture (hand-written, same format) for the full-success
#: path: a web area to scroll, a text field to set, a list to drag across,
#: a button with a secondary action. The selftest proves 9/9 against it;
#: the live app does not have these elements, so this is a fixture, not a
#: claim about the machine.
TREE_RICH = (
    "App=Chromium (pid 104998)\n"
    "Window: \"Example - Chromium\", App: Chromium.\n"
    "\t0 frame Example - Chromium Secondary Actions: doDefault, showContextMenu "
    "Frame: {x: 0, y: 0, width: 1920, height: 1004}\n"
    "\t\t1 web area Example Secondary Actions: doDefault "
    "Frame: {x: 0, y: 0, width: 1920, height: 900}\n"
    "\t\t3 text field Search Frame: {x: 100, y: 100, width: 400, height: 30}\n"
    "\t\t5 list Results Frame: {x: 100, y: 200, width: 800, height: 600}\n"
    "\t\t7 push button Go Secondary Actions: press "
    "Frame: {x: 520, y: 100, width: 80, height: 30}"
)


def preflight_step(step: dict, resolved: dict) -> tuple:
    """Check a step's required arguments BEFORE calling it.

    Returns `(args, missing)`. `missing` is a list of reason strings of the
    form `<arg>:<reason>`; empty means the call may proceed. The reasons name
    WHAT is missing and WHY, so a skip is diagnosable without a round trip.
    The proxy reports only the FIRST missing argument; the preflight reports
    ALL of them, so the job does not mirror that weakness.

    WHY THIS EXISTS (B-42). B-41 shipped eight steps with no `app` argument and
    the live proxy rejected every one with the same message. Eight identical
    failures, discovered one round trip at a time, told us nothing we could not
    have known before the first call. Checking the table first turns that into
    a single named reason per step — and, when the surface changes again, into a
    message that says WHICH argument is missing instead of eight tool errors.

    B-43: the same check now also resolves the tree-derived arguments
    (`element_index`, `action`, drag coordinates) from `resolved["tree"]` —
    the parsed `get_app_state` result. A value that cannot be derived is a
    named skip, never an invented argument.
    """
    tool = step["tool"]
    args = {}
    for k, v in (step.get("args") or {}).items():
        args[k] = resolved.get(k, v) if v == APP_FROM_LIST else v
    missing = []
    covered = set()  # argument names already explained by a specific reason

    # Tree-derived arguments (B-43). The tree is the parsed get_app_state
    # result, stored in resolved["tree"] by run_job after step 2.
    tree = resolved.get("tree")
    if tool == "scroll" and args.get("element_index") == ELEMENT_FROM_TREE:
        el = select_scroll(tree) if tree is not None else None
        if tree is None:
            missing.append("element_index:no_app_state_tree")
        elif el is None:
            missing.append("element_index:no_scrollable_element")
        else:
            args["element_index"] = str(el["index"])
        covered.add("element_index")
    elif tool == "set_value" and args.get("element_index") == ELEMENT_FROM_TREE:
        el = select_settable(tree) if tree is not None else None
        if tree is None:
            missing.append("element_index:no_app_state_tree")
        elif el is None:
            missing.append("element_index:no_settable_element")
        else:
            args["element_index"] = str(el["index"])
        covered.add("element_index")
    elif tool == "drag" and args.get("from_x") == DRAG_FROM_TREE:
        el = select_drag(tree) if tree is not None else None
        root = next((e for e in (tree or []) if e["index"] == 0), None)
        coords = derive_drag_coords(el, root) if el else None
        if tree is None:
            missing.append("from_x:no_app_state_tree")
        elif coords is None:
            missing.append("from_x:no_frame_bounds")
        else:
            args["from_x"], args["from_y"], args["to_x"], args["to_y"] = coords
        covered.update(("from_x", "from_y", "to_x", "to_y"))
    elif tool == "perform_secondary_action":
        if args.get("element_index") == ELEMENT_FROM_TREE:
            el = select_action(tree) if tree is not None else None
            if tree is None:
                missing.append("element_index:no_app_state_tree")
            elif el is None:
                missing.append("element_index:no_secondary_actions")
            else:
                args["element_index"] = str(el["index"])
                if args.get("action") == ACTION_FROM_TREE:
                    acts = el.get("actions") or []
                    if not acts:
                        missing.append("action:no_secondary_actions")
                    else:
                        args["action"] = acts[0]
            covered.add("element_index")
            covered.add("action")

    # An argument name outside the tool's declared props is a bug in the
    # job, not a missing capability — the B-42 guard against `dy`/`x1`.
    for k in sorted(args):
        if k not in TOOL_PARAMS.get(tool, {}):
            missing.append("undeclared_arg:%s" % k)

    # Every required argument, all at once. Names already explained by a
    # specific reason above are not repeated as bare "missing".
    for name in TOOL_REQUIRED.get(tool, ()):
        if name in covered:
            continue
        if args.get(name) in (None, "", APP_FROM_LIST, ELEMENT_FROM_TREE,
                              ACTION_FROM_TREE, DRAG_FROM_TREE):
            missing.append("%s:missing" % name)
    return args, missing


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

        # Arguments that are only knowable once an earlier step has run.
        # Today that is `app`, resolved from step 1's real list_apps result.
        resolved: dict = {}
        entry["resolved"] = resolved

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
                    "ms": int((time.time() - step_started) * 1000),
                })
                continue
            # B-42: check the required-argument table BEFORE spending a call.
            # B-41's eight identical `Missing required argument: app` errors each
            # cost a round trip and taught nothing new after the first.
            args, missing = preflight_step(step, resolved)
            if missing:
                entry["steps"].append({
                    "n": index, "tool": step["tool"], "purpose": step["step"],
                    "mutates": bool(step.get("mutates")), "ok": False, "skipped": True,
                    "missing": missing, "args": args,
                    "error": ("skipped: required argument(s) not available: %s"
                              % ", ".join(missing)),
                    "ms": int((time.time() - step_started) * 1000),
                })
                continue
            try:
                # `args` comes from the STEP (with run-time values substituted),
                # never a hardcoded shape.
                result = box.call(step["tool"], args)
                retry = None
                # B-43: ONE retry when the proxy's error names the enum it
                # wants (e.g. direction "down" rejected with "Must be one
                # of: UP, DOWN"). The retry reuses the same element_index
                # and the same derived coordinates; a second rejection is
                # recorded verbatim, not retried — a loop here would be a
                # guess wearing a retry's clothes.
                if not result.get("ok") and result.get("isError"):
                    retry_args = enum_retry_args(
                        step["tool"], args, _text_of(result.get("content")))
                    if retry_args is not None:
                        retry = {"from": dict(args), "to": dict(retry_args)}
                        args = retry_args
                        result = box.call(step["tool"], args)
                content = result.get("content")
                step_record = {
                    "n": index,
                    "tool": step["tool"],
                    "purpose": step["step"],
                    "mutates": bool(step.get("mutates")),
                    "ok": bool(result.get("ok")),
                    "isError": bool(result.get("isError")),
                    "args": args,
                    "result": truncate(content),
                    "ms": int((time.time() - step_started) * 1000),
                }
                if retry is not None:
                    step_record["retry"] = retry
                entry["steps"].append(step_record)
                # Resolve `app` from the listing step. Doing it on success only
                # means a failed listing leaves the rest honestly skipped rather
                # than aimed at a name nothing confirmed.
                if step["tool"] == "list_apps" and result.get("ok"):
                    names = parse_running_apps(_text_of(content))
                    entry["runningApps"] = names
                    chosen = pick_app(names)
                    if chosen:
                        resolved["app"] = chosen
                        entry["resolved"] = dict(resolved)
                # B-43: parse the accessibility tree from step 2, so steps
                # 6-9 derive element_index / action / drag coordinates from
                # the surface instead of inventing them. Only the element
                # COUNT is recorded; the tree itself stays in the runtime
                # `resolved` dict, not in the run record.
                if step["tool"] == "get_app_state" and result.get("ok"):
                    tree = parse_tree(_text_of(content))
                    resolved["tree"] = tree
                    entry["treeElements"] = len(tree)
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
        # A run that skipped most of its steps is NOT "ok" unless the skip was a
        # deliberate mode. `allow_interaction=False` is a deliberate mode;
        # "there was no app to act on" is a real shortfall, and reporting it as
        # ok would be the fake pass this repo keeps having to remove (B-42).
        deliberate = not allow_interaction
        entry["status"] = "partial" if not deliberate else "ok"
        if deliberate:
            entry["note"] = ("%d of %d steps succeeded; %d interaction steps were skipped "
                             "because interaction was disabled for this run."
                             % (len(ok_steps), attempted, len(skipped)))
        else:
            why = sorted({st.get("error", "") for st in skipped if st.get("error")})
            entry["note"] = ("%d of %d steps succeeded; %d were skipped because a required "
                             "argument was unavailable (%s). Nothing was reported as "
                             "successful that did not run."
                             % (len(ok_steps), attempted, len(skipped),
                                "; ".join(why) or "no app was listed"))
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
# The sandbox path (gap #6, T139)
#
# Generated code runs ONLY in the sandbox container. This section is the
# wiring: route the job, resolve the workspace, mint the token, build
# and validate the profile, run `docker run`, and surface refusals.
# It never falls back to main: a refusal is a refusal, with the reason.
# ---------------------------------------------------------------------------

#: Host root a sandbox job workspace must live under (the same constant
#: as features/sandbox/sandbox.py WORKSPACE_ROOT; kept literal here so
#: the runner can refuse a bad path even before the sandbox module
#: loads).
SANDBOX_WORKSPACE_ROOT = "/data/home/qwenpaw/working/workspaces"

#: Host root for per-job token directories (features/sandbox/sandbox.py
#: TOKEN_DIR_ROOT). On the host /run is tmpfs, so the token file lives
#: on tmpfs and dies with the reboot; the runner removes the directory
#: when the job ends, success or failure.
SANDBOX_TOKEN_ROOT = "/run/sandbox-tokens"

#: Job ids that may name a container and a token directory. Anything
#: else (a slash, a space, a shell metacharacter) is refused before it
#: can reach a path or an argv.
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

_SANDBOX_MODULES = None
_SANDBOX_MODULES_TRIED = False


def _load_sandbox_modules():
    """Load the sandbox modules (dispatch, sandbox, vault_tokens).

    Search order: next to this file (the machine layout, where the
    three modules are synced into /data/home/qwenpaw/codemode/
    alongside the runner), then the repo tree (features/sandbox/).
    Returns (dispatch, sandbox, vault_tokens) or (None, None, None)
    when any of them cannot be loaded — the sandbox path is then
    unavailable and every generated-code job is refused, never run
    on main.
    """
    global _SANDBOX_MODULES, _SANDBOX_MODULES_TRIED
    if _SANDBOX_MODULES_TRIED:
        return _SANDBOX_MODULES
    _SANDBOX_MODULES_TRIED = True
    import importlib.util

    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        here,
        os.path.normpath(os.path.join(os.path.dirname(here), "..", "sandbox")),
    ]
    loaded = {}
    for name in ("dispatch", "sandbox", "vault_tokens"):
        module = None
        for base in candidates:
            path = os.path.join(base, name + ".py")
            if not os.path.exists(path):
                continue
            try:
                spec = importlib.util.spec_from_file_location("sandbox_" + name, path)
                if spec is None or spec.loader is None:
                    continue
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                break
            except Exception:
                module = None
                continue
        loaded[name] = module
    if any(v is None for v in loaded.values()):
        _SANDBOX_MODULES = (None, None, None)
    else:
        _SANDBOX_MODULES = (loaded["dispatch"], loaded["sandbox"], loaded["vault_tokens"])
    return _SANDBOX_MODULES


def sandbox_available() -> dict:
    """Is the sandbox path usable? Reports the reason, never raises."""
    dispatch_mod, sandbox_mod, tokens_mod = _load_sandbox_modules()
    if dispatch_mod is None or sandbox_mod is None or tokens_mod is None:
        return {"available": False,
                "reason": "sandbox modules not installed (dispatch/sandbox/vault_tokens)"}
    return {"available": True, "reason": None}


def resolve_job_workspace(workspace: str, root: str = SANDBOX_WORKSPACE_ROOT):
    """Resolve symlinks in a job workspace before mounting (T139
    residual hole 7). Returns (resolved_path, None) or (None, reason).
    Refuses: a path that does not exist, is not a directory, or whose
    realpath escapes the workspace root. The resolved path is what gets
    mounted — never the unresolved one."""
    if not isinstance(workspace, str) or not workspace:
        return None, "workspace is missing"
    resolved = os.path.realpath(workspace)
    root_real = os.path.realpath(root)
    if resolved == root_real or not resolved.startswith(root_real.rstrip("/") + "/"):
        return None, f"workspace escapes the workspace root: {workspace!r}"
    if not os.path.isdir(resolved):
        return None, f"workspace is not a directory: {workspace!r}"
    return resolved, None


def _docker_kill(container_name: str) -> None:
    """Best-effort kill of a sandbox container (timeout path). Never raises."""
    try:
        subprocess.run(["docker", "kill", container_name],
                       capture_output=True, timeout=10)
    except Exception:
        pass


def run_sandbox_job(config: dict, job: dict, client=None,
                    _run=None, token_root: str = SANDBOX_TOKEN_ROOT,
                    workspace_root: str = SANDBOX_WORKSPACE_ROOT) -> dict:
    """Route and run one generated-code job in the sandbox (T139).

    ``job`` keys: job_id, kind ("generated-code" | "code"), workspace
    (host path), script (basename of the .py file in the workspace to
    run as ``python3 /workspace/<script>``), deadline_s (optional),
    hosts (optional), vault_items (optional), tools / needs_desktop
    (optional, for the desktop refusal). Returns an entry dict with at
    least status/target/reason; a refusal surfaces the reason and runs
    nothing. Never raises for a bad job.

    The token scope the runner mints is exactly the job's declared
    needs (vault_items + hosts): route_job is called with token_items
    == vault_items, i.e. "the token I am about to mint scopes exactly
    these" — dispatch then checks the job's needs are inside it, and
    the mint below mints exactly that scope. A job whose needs change
    between routing and minting cannot exist: both read the same job
    dict.
    """
    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    job_id = str((job or {}).get("job_id") or "").strip()
    entry = {
        "id": "run_%x" % int(started * 1000),
        "job": job_id or "<unknown>",
        "runtime": "vm",
        "target": "sandbox",
        "startedAt": started_at,
        "status": "refused",
        "reason": None,
        "route": None,
    }

    def _finish(status, reason):
        entry["status"] = status
        entry["reason"] = reason
        entry["durationMs"] = int((time.time() - started) * 1000)
        return entry

    dispatch_mod, sandbox_mod, tokens_mod = _load_sandbox_modules()
    if dispatch_mod is None or sandbox_mod is None or tokens_mod is None:
        return _finish("refused", "sandbox unavailable: the sandbox modules "
                        "(dispatch/sandbox/vault_tokens) are not installed")
    if not _JOB_ID_RE.match(job_id):
        return _finish("refused", f"job_id {job_id!r} must match "
                        "[A-Za-z0-9][A-Za-z0-9_-]{0,63} (it names a "
                        "container and a token directory)")
    routed = dict(job or {})
    routed["token_items"] = list((job or {}).get("vault_items") or [])
    decision = dispatch_mod.route_job(routed, workspace_root=workspace_root)
    entry["route"] = decision
    target = decision.get("target")
    if target == "main":
        # The one legacy exception: the fixed desktop pilot job. It is
        # not generated code and it cannot run in the sandbox.
        fixed = run_job(config, job="codemode-fixed-job", client=client)
        fixed["target"] = "main"
        fixed["route"] = decision
        return fixed
    if target != "sandbox":
        return _finish("refused", decision.get("reason") or "refused by dispatch")
    script = str((job or {}).get("script") or "").strip()
    if (not script or "/" in script or "\\" in script or ".." in script
            or not script.endswith(".py")):
        return _finish("refused", f"script {script!r} must be a plain .py "
                        "basename inside the job workspace")
    resolved, err = resolve_job_workspace(str((job or {}).get("workspace") or ""),
                                          root=workspace_root)
    if err is not None:
        return _finish("refused", err)
    script_host = os.path.realpath(os.path.join(resolved, script))
    if not script_host.startswith(resolved.rstrip("/") + "/") or not os.path.isfile(script_host):
        return _finish("refused", f"script {script!r} is not a file in the job workspace")
    deadline = int(decision.get("deadline_s") or 120)
    vault_items = [str(i) for i in ((job or {}).get("vault_items") or []) if i]
    hosts = [str(h).lower() for h in ((job or {}).get("hosts") or []) if h]
    token_dir = None
    try:
        profile_job = {"job_id": job_id, "workspace": resolved, "deadline_s": deadline}
        if vault_items:
            # Mint first: a job that needs a vault value without a
            # configured key is blocked, not run without the value.
            try:
                kid, key = tokens_mod.load_key()
            except Exception:
                return _finish("blocked", "SANDBOX_BROKER_KEY is not set on this "
                               "runner, so no scoped token can be minted for a "
                               "job that needs a vault value")
            try:
                token = tokens_mod.mint_token(key, kid, job_id, vault_items, hosts)
            except Exception as exc:
                return _finish("refused", f"cannot mint a scoped token: {exc}")
            token_dir = os.path.join(token_root, job_id)
            try:
                os.makedirs(token_dir, mode=0o700, exist_ok=True)
                os.chmod(token_dir, 0o700)
                token_path = os.path.join(token_dir, "token")
                with open(token_path, "w", encoding="utf-8") as fh:
                    fh.write(token)
                os.chmod(token_path, 0o600)
            except OSError as exc:
                return _finish("error", f"cannot write the token file: {exc}")
            profile_job["token_dir"] = token_dir
        profile = sandbox_mod.build_profile(profile_job)
        violations = sandbox_mod.validate_profile(profile, workspace_root, token_root)
        if violations:
            return _finish("refused", "invalid sandbox profile: " + "; ".join(violations))
        argv = sandbox_mod.docker_run_argv(profile, workspace_root, token_root)
        argv += ["python3", "/workspace/" + script]
        container_name = f"qwenpaw-sandbox-{job_id}"
        run = _run or subprocess.run
        try:
            proc = run(argv, capture_output=True, text=True, timeout=deadline)
        except subprocess.TimeoutExpired:
            _docker_kill(container_name)
            entry["exitCode"] = None
            entry["timedOut"] = True
            return _finish("timeout", f"job deadline ({deadline} s) exceeded; "
                           "container killed")
        except Exception as exc:
            return _finish("error", f"docker run failed: {type(exc).__name__}: {exc}")
        entry["exitCode"] = proc.returncode
        entry["stdout"] = truncate(getattr(proc, "stdout", "") or "")
        entry["stderr"] = truncate(getattr(proc, "stderr", "") or "")
        entry["container"] = container_name
        entry["image"] = sandbox_mod.SANDBOX_IMAGE
        return _finish("ok" if proc.returncode == 0 else "error",
                       None if proc.returncode == 0 else
                       f"sandbox job exited {proc.returncode}")
    finally:
        if token_dir is not None:
            shutil.rmtree(token_dir, ignore_errors=True)


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
                sb = sandbox_available()
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
                    # The sandbox path (T139): usable only when the three
                    # sandbox modules are installed next to the runner.
                    "sandbox": ("available" if sb["available"]
                                else "unavailable: " + (sb["reason"] or "")),
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
            # A job object routes through the sandbox (T139); anything else
            # runs the fixed pilot job, exactly as before.
            requested = (body or {}).get("job")
            if isinstance(requested, dict):
                entry = run_sandbox_job(config, requested)
            else:
                entry = run_job(config, job=str(requested or "fixed-bench-job"),
                                apply_limits=False)
            record_run(entry)
            status = 200 if entry["status"] in ("ok", "refused") else (
                503 if entry["status"] == "blocked" else 502)
            self._json(entry, status)

    return Handler


def status_page(config: dict) -> str:
    b = bench()
    d = b["desktop_job"]
    mcp_state = "configured" if config.get("mcp_url") else "not configured"
    token_state = "set" if config.get("token") else "unset (run endpoint closed)"
    sb = sandbox_available()
    sandbox_state = "available" if sb["available"] else "unavailable: " + (sb["reason"] or "")
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
 <div class="row"><span class="k">Sandbox (T139)</span>
  <span class="%s">%s</span></div>
</div>

<h2>Endpoints</h2>
<pre>GET  /health      -> runner + MCP + token state
GET  /api/bench   -> this comparison as JSON
POST /api/run     -> run the fixed job (needs X-Codemode-Token)
POST /api/run {"job": {...}} -> run a generated-code job in the sandbox
                    (needs X-Codemode-Token; refusals surface the reason)
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
        "ok" if sb["available"] else "warn", sandbox_state,
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

    LIVE-FAITHFUL (B-43). The fake reimplements ONLY the recorded behaviour
    of the real proxy — the nine schemas from run_1a1e8f3fd71, first-missing-
    argument ordering, and the tree text format — and its fixtures are
    hand-written tree strings copied from the live output. It must NOT
    import anything from the job's derivation tables: a fake derived from
    the code under test agrees with the code's wrong assumption (B-42's
    lesson). `tree` is the get_app_state text; `direction_enum` is the set
    of directions the fake accepts (the job does not know it).
    """

    def __init__(self, fail_at=None, raise_at=None, is_error_at=None, hang=False,
                 tree=None, direction_enum=("up", "down", "left", "right")):
        self.server_info = {"name": "fake-mcp", "version": "1.0"}
        self.calls = []
        self.fail_at = fail_at
        self.raise_at = raise_at
        self.is_error_at = is_error_at
        self.hang = hang
        self.tree = TREE_LIVE_FRAME_ONLY if tree is None else tree
        self.direction_enum = tuple(direction_enum)
        self.elements = parse_tree(self.tree)
        self.journal = []  # (tool, args) in call order — lets tests assert absence/count

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
            {
                "name": n,
                "description": d,
                "inputSchema": {
                    "type": "object",
                    "properties": dict(TOOL_PARAMS.get(n, {})),
                    "required": list(TOOL_REQUIRED.get(n, ())),
                },
            }
            for n, d in DESKTOP_TOOLS
        ]

    def _error(self, text):
        return {"ok": False, "content": [{"type": "text", "text": text}],
                "isError": True}

    def call(self, name, arguments=None):
        self.calls.append(name)
        n = len(self.calls)
        args = arguments or {}
        self.journal.append((name, dict(args)))
        # 1. Unknown arguments are rejected first — this is what kills the
        # old `dy` / `x1` shapes (B-43 T10).
        for k in sorted(args):
            if k not in TOOL_PARAMS.get(name, {}):
                return self._error("Unexpected argument: %s" % k)
        # 2. Required arguments, FIRST missing only, exactly as the live
        # proxy reports (B-42: "Missing required argument: app").
        for req in TOOL_REQUIRED.get(name, ()):
            if args.get(req) in (None, ""):
                return self._error("Missing required argument: %s" % req)
        # 3. Semantic checks, from the fake's own fixtures — the job does
        # not know these values, so a wrong derivation fails here.
        if name in ("scroll", "set_value", "perform_secondary_action", "click"):
            ei = args.get("element_index")
            if ei is not None:
                el = next((e for e in self.elements if str(e["index"]) == str(ei)), None)
                if el is None:
                    return self._error("Invalid element_index: %s" % ei)
                if name == "set_value" and el["role"] not in SETTABLE_ROLES:
                    return self._error("Element %s (%s) is not settable"
                                       % (ei, el["role"]))
                if name == "perform_secondary_action":
                    if args.get("action") not in (el.get("actions") or []):
                        return self._error("Unknown action: %s for element %s"
                                           % (args.get("action"), ei))
        if name == "scroll":
            if args.get("direction") not in self.direction_enum:
                return self._error(
                    "Invalid direction: %s. Must be one of: %s"
                    % (args.get("direction"), ", ".join(self.direction_enum)))
        if name == "drag":
            root = next((e for e in self.elements if e["index"] == 0), None)
            frame = root.get("frame") if root else None
            if frame is None:
                return self._error("Coordinates out of bounds")
            for k in ("from_x", "from_y", "to_x", "to_y"):
                v = args.get(k)
                if not isinstance(v, (int, float)):
                    return self._error("Coordinates out of bounds")
            if not (frame["x"] <= args["from_x"] <= frame["x"] + frame["w"]
                    and frame["x"] <= args["to_x"] <= frame["x"] + frame["w"]
                    and frame["y"] <= args["from_y"] <= frame["y"] + frame["h"]
                    and frame["y"] <= args["to_y"] <= frame["y"] + frame["h"]):
                return self._error("Coordinates out of bounds")
        if self.hang:
            time.sleep(5)
        if self.raise_at and n == self.raise_at:
            raise McpError("connection reset by proxy")
        if name == "list_apps":
            return {"ok": True, "isError": False, "content": [{
                "type": "text",
                "text": ("Chromium -- Chromium [running, pid=104998, window=Today's "
                         "Puzzle Answers (November 15, 2026) - Chromium]\n"
                         "xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled]\n"
                         "xfce4-terminal -- xfce4-terminal [running, pid=51245, "
                         "window=Terminal - qwenpaw]\n"
                         "xfdesktop -- xfdesktop [running, pid=50676, window=untitled]\n"
                         "xfwm4 -- xfwm4 [running, pid=50671, window=untitled]"),
            }]}
        if name == "get_app_state":
            return {"ok": True, "isError": False, "content": [{
                "type": "text", "text": self.tree,
            }]}
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
    # The sandbox path (T139) DOES spawn a process — `docker run` — so
    # "spawns nothing" is no longer the rule. The rule is now precise:
    # subprocess is used ONLY via run() (TimeoutExpired is raised, not
    # spawned, by the selftest's deadline fixture), only from the
    # sandbox runner (and its docker-kill helper), never Popen /
    # os.system / os.exec*.
    _subprocess_attrs = {
        node.func.attr
        for node in _ast.walk(tree)
        if isinstance(node, _ast.Call) and isinstance(node.func, _ast.Attribute)
        and isinstance(node.func.value, _ast.Name)
        and node.func.value.id == "subprocess"
    }
    check("subprocess is used only via run() (or raising TimeoutExpired)",
          _subprocess_attrs <= {"run", "TimeoutExpired"},
          json.dumps(sorted(_subprocess_attrs)))
    _run_owners = set()

    def _collect_owners(node, current=None):
        # Innermost enclosing function only: a call inside the nested
        # _fake_run_timeout fixture belongs to the fixture, not to
        # selftest as a whole.
        if isinstance(node, _ast.FunctionDef):
            current = node.name
        if (isinstance(node, _ast.Call) and isinstance(node.func, _ast.Attribute)
                and isinstance(node.func.value, _ast.Name)
                and node.func.value.id == "subprocess"):
            _run_owners.add(current)
        for _child in _ast.iter_child_nodes(node):
            _collect_owners(_child, current)

    _collect_owners(tree)
    check("docker is spawned only from the sandbox runner",
          _run_owners <= {"run_sandbox_job", "_docker_kill", "_fake_run_timeout"},
          json.dumps(sorted(_run_owners)))
    _os_attrs = {
        node.func.attr
        for node in _ast.walk(tree)
        if isinstance(node, _ast.Call) and isinstance(node.func, _ast.Attribute)
        and isinstance(node.func.value, _ast.Name)
        and node.func.value.id == "os"
    }
    check("no os.system / os.exec* / os.spawn* / os.popen anywhere",
          not (_os_attrs & {"system", "execv", "execl", "execve", "execlp",
                            "execvp", "spawnl", "spawnlp", "spawnv",
                            "spawnve", "popen"}),
          json.dumps(sorted(_os_attrs)))
    check("the runner imports no multiprocessing or pty",
          not (imported & {"multiprocessing", "pty"}),
          json.dumps(sorted(imported & {"multiprocessing", "pty"})))
    check("the runner imports no shell helper",
          not (imported & {"shlex", "commands"}), json.dumps(sorted(imported)))

    print("run: honest blockers")
    blocked = run_job({}, "j")
    check("no MCP url -> status blocked", blocked["status"] == "blocked", blocked["status"])
    check("blocker names the MCP URL", any("MCP_SSE_URL" in x for x in blocked["blockers"]),
          json.dumps(blocked["blockers"]))
    check("never claims a run happened", "Nothing was executed" in (blocked["note"] or ""))
    check("no steps recorded", blocked["steps"] == [])

    print("run: a full success — on the LIVE frame-only tree (B-43)")
    # THE LIVE OUTCOME. The fake returns the tree the proxy actually
    # returned (run_1a1e8f3fd71): a single frame, no settable element. So
    # the honest result is 8 passed / 1 skipped / 0 failed — `set_value`
    # skips because a frame has no AX value, and the run is "partial", not
    # "ok". A suite that demands 9/9 against this tree would be demanding
    # a call the surface cannot honour.
    fake = FakeMcp()
    ok = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake)
    check("status partial (one honest skip)", ok["status"] == "partial",
          ok["status"] + " / " + str(ok.get("note")))
    check("every step recorded", len(ok["steps"]) == len(BENCH_STEPS),
          str(len(ok["steps"])))
    check("8 steps ok, 1 skipped", ok["summary"]["ok"] == 8
          and ok["summary"]["skipped"] == 1 and ok["summary"]["failed"] == 0,
          json.dumps(ok["summary"]))
    check("the skipped step is set_value",
          [s["tool"] for s in ok["steps"] if s.get("skipped")] == ["set_value"],
          json.dumps([s["tool"] for s in ok["steps"] if s.get("skipped")]))
    check("…and the reason names the missing settable element",
          "no_settable_element" in (ok["steps"][6].get("error") or ""),
          ok["steps"][6].get("error"))
    check("set_value was never called",
          "set_value" not in [t for t, _ in fake.journal],
          json.dumps([t for t, _ in fake.journal]))
    check("scroll called with the real element and direction",
          dict(fake.journal)["scroll"] == {"app": "Chromium", "element_index": "0",
                                           "direction": "down"},
          json.dumps(dict(fake.journal).get("scroll")))
    check("drag called with frame-derived coordinates",
          dict(fake.journal)["drag"] == {"app": "Chromium", "from_x": 880,
                                         "from_y": 422, "to_x": 1040, "to_y": 582},
          json.dumps(dict(fake.journal).get("drag")))
    check("perform_secondary_action called with the real action",
          dict(fake.journal)["perform_secondary_action"] == {
              "app": "Chromium", "element_index": "0", "action": "doDefault"},
          json.dumps(dict(fake.journal).get("perform_secondary_action")))
    check("steps carry the tool name", ok["steps"][0]["tool"] == BENCH_STEPS[0]["tool"])
    check("steps carry a duration", isinstance(ok["steps"][0]["ms"], int))
    check("the server name is recorded", ok["server"]["name"] == "fake-mcp")
    check("calls were made in order (skipped set_value aside)",
          fake.calls == [t for t in tools_used if t != "set_value"],
          json.dumps(fake.calls))
    check("the note says nothing was reported as successful that did not run",
          "did not run" in (ok["note"] or ""), ok["note"])

    print("run: a full success — on the RICH tree fixture (B-43)")
    # The same job against a tree that HAS a settable element: 9/9. This
    # proves the derivation works when the surface provides one; the live
    # app does not, so this is a fixture result, not a claim about the
    # machine.
    fake_rich = FakeMcp(tree=TREE_RICH)
    rich = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake_rich)
    check("status ok", rich["status"] == "ok",
          rich["status"] + " / " + str(rich.get("note")))
    check("summary counts every step ok", rich["summary"]["ok"] == len(BENCH_STEPS),
          json.dumps(rich["summary"]))
    check("every step is ok", all(s["ok"] for s in rich["steps"]))
    check("calls were made in order", fake_rich.calls == tools_used,
          json.dumps(fake_rich.calls))
    check("the note says no generated code ran",
          "no model-generated code" in (rich["note"] or ""), rich["note"])
    check("set_value targeted the text field",
          dict(fake_rich.journal)["set_value"] == {
              "app": "Chromium", "element_index": "3", "value": "pilot"},
          json.dumps(dict(fake_rich.journal).get("set_value")))
    check("scroll targeted the web area",
          dict(fake_rich.journal)["scroll"]["element_index"] == "1",
          json.dumps(dict(fake_rich.journal).get("scroll")))
    check("perform_secondary_action uses the first element with actions",
          dict(fake_rich.journal)["perform_secondary_action"] == {
              "app": "Chromium", "element_index": "0", "action": "doDefault"},
          json.dumps(dict(fake_rich.journal).get("perform_secondary_action")))

    print("run: a tool that reports an error is not a success")
    fake = FakeMcp(is_error_at=3)
    partial = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake)
    check("status is partial", partial["status"] == "partial", partial["status"])
    check("the failing step says ok:false", partial["steps"][2]["ok"] is False)
    check("the failing step is flagged isError", partial["steps"][2]["isError"] is True)
    # 9 steps: 1 failed (click), 1 skipped (set_value, live frame-only
    # tree), 7 ok. The skip is not a failure.
    check("the other steps still ran",
          partial["summary"]["ok"] == len(BENCH_STEPS) - 2,
          json.dumps(partial["summary"]))
    check("nothing is reported as successful that was not",
          partial["summary"]["failed"] == 1, json.dumps(partial["summary"]))

    print("args: every REQUIRED argument is passed, and `app` comes from the real list (B-42)")
    # THE BUG THIS GUARDS. B-41 shipped steps 2-9 with no `app`. A live run
    # (run_1a1e8e3d9f9, 2026-11-17) answered every one of them with
    # "Missing required argument: app" and scored 1/9.
    #
    # The fake now enforces TOOL_REQUIRED, so these assertions fail on a job
    # that omits `app` — exactly reproducing the live result.
    # B-43: the full live requirement, read from the recorded
    # `surface.schemas` (run_1a1e8f3fd71). B-42's table under-counted
    # scroll by 2, set_value by 1, drag by 4, perform_secondary_action by
    # 2, type_text by 1, press_key by 1.
    check("list_apps requires nothing", TOOL_REQUIRED["list_apps"] == (),
          json.dumps(TOOL_REQUIRED["list_apps"]))
    _expected_required = {
        "get_app_state": ("app",),
        "click": ("app",),
        "type_text": ("app", "text"),
        "press_key": ("app", "key"),
        "scroll": ("app", "element_index", "direction"),
        "set_value": ("app", "element_index", "value"),
        "drag": ("app", "from_x", "from_y", "to_x", "to_y"),
        "perform_secondary_action": ("app", "element_index", "action"),
    }
    for _t, _req in _expected_required.items():
        check("%s requires %s" % (_t, ",".join(_req)),
              TOOL_REQUIRED.get(_t) == _req,
              json.dumps(TOOL_REQUIRED.get(_t)))
    # The schema the bench estimates from must advertise the same requirement,
    # or the token model and the call-time check describe different surfaces.
    for _n, _d in DESKTOP_TOOLS:
        _schema = json.loads(schema_tokens(_n, _d))
        _req = set(_schema["parameters"].get("required") or [])
        check("%s: schema required == call-time required" % _n,
              _req == set(TOOL_REQUIRED.get(_n, ())),
              "%s vs %s" % (sorted(_req), sorted(TOOL_REQUIRED.get(_n, ()))))

    fake_args = FakeMcp()
    args_run = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake_args)
    # Live frame-only tree: 8 pass, set_value honestly skipped.
    check("the job passes with `app` supplied (8/1/0 on the live tree)",
          args_run["status"] == "partial"
          and args_run["summary"]["ok"] == 8
          and args_run["summary"]["skipped"] == 1
          and args_run["summary"]["failed"] == 0,
          "%s / %s" % (args_run["status"], args_run.get("note")))
    check("every attempted step succeeded",
          all(s["ok"] for s in args_run["steps"] if not s.get("skipped")),
          json.dumps(args_run["summary"]))
    check("no step failed on a missing argument",
          not any("Missing required argument" in json.dumps(st.get("result") or "")
                  for st in args_run["steps"]),
          json.dumps([st.get("tool") for st in args_run["steps"]
                      if st.get("ok") is False]))
    # `app` must come from the listing, not from a literal in the job.
    check("the app was resolved from list_apps",
          args_run["resolved"].get("app") == "Chromium",
          json.dumps(args_run.get("resolved")))
    check("the running apps were parsed from the real text shape",
          "xfce4-terminal" in (args_run.get("runningApps") or []),
          json.dumps(args_run.get("runningApps")))
    check("steps 2-9 all carry the resolved app",
          all(st.get("args", {}).get("app") == "Chromium"
              for st in args_run["steps"] if st["tool"] != "list_apps"),
          json.dumps([(st["tool"], (st.get("args") or {}).get("app"))
                      for st in args_run["steps"]]))

    print("args: the parser reads the proxy's real list_apps format")
    sample = ("Chromium -- Chromium [running, pid=104998, window=Today's Puzzle]\n"
              "xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled]\n"
              "xfdesktop -- xfdesktop [running, pid=50676, window=untitled]")
    check("app names are extracted", parse_running_apps(sample) ==
          ["Chromium", "xfce4-panel", "xfdesktop"], json.dumps(parse_running_apps(sample)))
    check("a real window beats panel/desktop infrastructure",
          pick_app(["xfce4-panel", "Chromium", "xfwm4"]) == "Chromium",
          pick_app(["xfce4-panel", "Chromium", "xfwm4"]))
    check("infrastructure-only still yields a name",
          pick_app(["xfce4-panel", "xfdesktop"]) == "xfce4-panel",
          pick_app(["xfce4-panel", "xfdesktop"]))
    check("an empty list yields None, never an invented name",
          pick_app([]) is None, str(pick_app([])))
    check("garbage text yields no names", parse_running_apps("nonsense") == [],
          json.dumps(parse_running_apps("nonsense")))

    print("args: no running app -> an honest skip, never a fake pass")
    class NoAppsMcp(FakeMcp):
        def call(self, name, arguments=None):
            if name == "list_apps":
                self.calls.append(name)
                return {"ok": True, "isError": False,
                        "content": [{"type": "text", "text": ""}]}
            return super().call(name, arguments)

    no_apps = run_job({"mcp_url": "http://mcp.test"}, "j", client=NoAppsMcp())
    check("nothing is reported as ok when there is no app",
          no_apps["status"] != "ok", no_apps["status"])
    check("the interaction steps are SKIPPED, not failed",
          no_apps["summary"]["failed"] == 0 and no_apps["summary"]["skipped"] == 8,
          json.dumps(no_apps["summary"]))
    check("…and the reason names the missing argument",
          all("app" in (st.get("error") or "") for st in no_apps["steps"]
              if st.get("skipped")),
          json.dumps([st.get("error") for st in no_apps["steps"] if st.get("skipped")][:2]))
    check("only list_apps was actually called",
          no_apps["summary"]["ok"] == 1, json.dumps(no_apps["summary"]))

    print("tree: the parser reads the proxy's real get_app_state format (B-43)")
    live = parse_tree(TREE_LIVE_FRAME_ONLY)
    check("the live tree parses to one element", len(live) == 1,
          json.dumps(live))
    check("the element index is 0", live[0]["index"] == 0, json.dumps(live))
    check("the role is frame", live[0]["role"] == "frame", json.dumps(live))
    check("the name keeps its commas and parentheses",
          live[0]["name"] == "Today's Puzzle Answers (November 16, 2026) - Chromium",
          live[0]["name"])
    check("Secondary Actions parse to a list",
          live[0]["actions"] == ["doDefault", "showContextMenu"],
          json.dumps(live[0]["actions"]))
    check("the Frame parses to bounds",
          live[0]["frame"] == {"x": 0, "y": 0, "w": 1920, "h": 1004},
          json.dumps(live[0]["frame"]))
    # Multi-word roles, longest-first: "push button" is one role, not "push".
    rich = parse_tree(TREE_RICH)
    check("the rich tree parses to five elements", len(rich) == 5,
          json.dumps([e["index"] for e in rich]))
    check("a multi-word role parses whole",
          next(e for e in rich if e["index"] == 7)["role"] == "push button",
          json.dumps(next(e for e in rich if e["index"] == 7)))
    check("a name containing 'Frame:' and a comma survives",
          parse_tree('\t4 text field "From: A, to: B Frame: n/a" '
                     'Frame: {x: 10, y: 10, width: 200, height: 20}')[0]["name"]
          == "From: A, to: B Frame: n/a",
          json.dumps(parse_tree('\t4 text field "From: A, to: B Frame: n/a" '
                                'Frame: {x: 10, y: 10, width: 200, height: 20}')[0]))
    check("header lines carry no index and are skipped",
          parse_tree("App=Chromium (pid 1)\nWindow: \"x\", App: Chromium.\n") == [],
          "header lines produced elements")
    check("garbage text yields no elements", parse_tree("nonsense") == [],
          json.dumps(parse_tree("nonsense")))

    print("tree: the selectors derive from the surface, never a guess (B-43)")
    check("scroll picks the frame on the live tree",
          select_scroll(live)["index"] == 0, json.dumps(select_scroll(live)))
    check("scroll prefers the deeper web area when areas are within 20%",
          select_scroll(rich)["index"] == 1, json.dumps(select_scroll(rich)))
    check("set_value finds nothing on the live tree (a frame is not settable)",
          select_settable(live) is None, json.dumps(select_settable(live)))
    check("set_value finds the text field on the rich tree",
          select_settable(rich)["index"] == 3, json.dumps(select_settable(rich)))
    check("perform_secondary_action picks the frame on the live tree",
          select_action(live)["index"] == 0, json.dumps(select_action(live)))
    check("drag picks the largest draggable element",
          select_drag(rich)["index"] == 0, json.dumps(select_drag(rich)))
    check("drag coordinates are centre +/- offset, inside the frame",
          derive_drag_coords(select_drag(live), live[0])
          == (880, 422, 1040, 582),
          json.dumps(derive_drag_coords(select_drag(live), live[0])))
    check("a too-small element yields no drag coordinates",
          derive_drag_coords({"frame": {"x": 0, "y": 0, "w": 10, "h": 10}},
                           live[0]) is None,
          "a 10x10 frame produced coordinates")
    check("the direction is the documented value",
          SCROLL_DIRECTION == "down", SCROLL_DIRECTION)

    print("tree: the preflight reports every missing argument, not just the first (B-43)")
    _args, _miss = preflight_step(
        {"tool": "drag", "args": {"app": APP_FROM_LIST, "from_x": DRAG_FROM_TREE,
                                  "from_y": DRAG_FROM_TREE, "to_x": DRAG_FROM_TREE,
                                  "to_y": DRAG_FROM_TREE}},
        {"app": "Chromium"})
    check("drag without a tree names the coordinate derivation",
          _miss == ["from_x:no_app_state_tree"], json.dumps(_miss))
    _args, _miss = preflight_step(
        {"tool": "set_value",
         "args": {"app": APP_FROM_LIST, "value": "pilot",
                  "element_index": ELEMENT_FROM_TREE}},
        {"app": "Chromium", "tree": live})
    check("set_value on the live tree names the missing settable element",
          _miss == ["element_index:no_settable_element"], json.dumps(_miss))
    _args, _miss = preflight_step(
        {"tool": "scroll",
         "args": {"app": APP_FROM_LIST, "direction": "down",
                  "element_index": ELEMENT_FROM_TREE}},
        {"app": "Chromium", "tree": live})
    check("scroll on the live tree resolves element 0",
          _miss == [] and _args["element_index"] == "0",
          json.dumps((_args, _miss)))
    _args, _miss = preflight_step(
        {"tool": "perform_secondary_action",
         "args": {"app": APP_FROM_LIST, "element_index": ELEMENT_FROM_TREE,
                  "action": ACTION_FROM_TREE}},
        {"app": "Chromium", "tree": live})
    check("perform_secondary_action resolves element 0 + doDefault",
          _miss == [] and _args == {"app": "Chromium", "element_index": "0",
                                    "action": "doDefault"},
          json.dumps((_args, _miss)))
    _args, _miss = preflight_step(
        {"tool": "scroll", "args": {"app": APP_FROM_LIST, "dy": 3,
                                    "element_index": ELEMENT_FROM_TREE}},
        {"app": "Chromium", "tree": live})
    check("an undeclared argument (dy) is named, not silently passed",
          "undeclared_arg:dy" in _miss, json.dumps(_miss))

    print("tree: an empty tree skips steps 6-9 honestly (B-43)")
    fake_empty = FakeMcp(tree="App=Chromium (pid 1)\nWindow: \"x\", App: Chromium.\n")
    empty = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake_empty)
    check("steps 6-9 are skipped, not failed",
          empty["summary"]["failed"] == 0 and empty["summary"]["skipped"] == 4,
          json.dumps(empty["summary"]))
    check("get_app_state ran exactly once",
          fake_empty.calls.count("get_app_state") == 1,
          json.dumps(fake_empty.calls))
    check("no interaction call went out for steps 6-9",
          set(fake_empty.calls) == {"list_apps", "get_app_state", "click",
                                    "type_text", "press_key"},
          json.dumps(fake_empty.calls))

    print("tree: a tree with no Secondary Actions skips only that step (B-43)")
    fake_noact = FakeMcp(tree=(
        "App=Chromium (pid 1)\n"
        "Window: \"x\", App: Chromium.\n"
        "\t0 frame x Frame: {x: 0, y: 0, width: 1920, height: 1004}"))
    noact = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake_noact)
    check("only perform_secondary_action is skipped (plus set_value, frame-only)",
          [s["tool"] for s in noact["steps"] if s.get("skipped")]
          == ["set_value", "perform_secondary_action"],
          json.dumps([s["tool"] for s in noact["steps"] if s.get("skipped")]))
    check("the reason names the missing actions",
          "no_secondary_actions" in (noact["steps"][8].get("error") or ""),
          noact["steps"][8].get("error"))

    print("tree: the fake rejects the OLD argument shapes (B-43 T10)")
    fake_old = FakeMcp()
    check("drag with x1/y1/x2/y2 is rejected",
          "Unexpected argument: x1" in
          fake_old.call("drag", {"app": "Chromium", "x1": 400, "y1": 300,
                                 "x2": 500, "y2": 380})["content"][0]["text"],
          "the old drag shape was accepted")
    check("scroll with dy is rejected",
          "Unexpected argument: dy" in
          fake_old.call("scroll", {"app": "Chromium", "dy": 3})["content"][0]["text"],
          "the old scroll shape was accepted")
    check("the preflight never lets those shapes reach the proxy",
          not any("Unexpected argument" in json.dumps(st.get("result") or "")
                  for st in args_run["steps"]),
          "a step sent an undeclared argument")

    print("tree: the direction enum is recovered once, then stops (B-43)")
    # The fake accepts only UPPERCASE directions and names its enum in the
    # error — the job must retry exactly once with "DOWN".
    fake_enum = FakeMcp(direction_enum=("UP", "DOWN", "LEFT", "RIGHT"))
    enum_run = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake_enum)
    scroll_calls = [a for t, a in fake_enum.journal if t == "scroll"]
    check("scroll was called exactly twice (one retry)",
          len(scroll_calls) == 2, json.dumps(scroll_calls))
    check("the retry used the enum's own spelling",
          scroll_calls[1].get("direction") == "DOWN", json.dumps(scroll_calls))
    check("the step passed after the retry",
          enum_run["steps"][5]["ok"] is True,
          json.dumps(enum_run["steps"][5]))
    check("the retry is recorded on the step",
          enum_run["steps"][5].get("retry", {}).get("from", {}).get("direction")
          == "down", json.dumps(enum_run["steps"][5].get("retry")))
    # The same rejection WITHOUT a named enum: no retry, verbatim failure.
    class NoEnumMcp(FakeMcp):
        def call(self, name, arguments=None):
            if name == "scroll":
                self.calls.append(name)
                self.journal.append((name, dict(arguments or {})))
                return {"ok": False, "content": [{"type": "text",
                                                  "text": "Invalid direction"}],
                        "isError": True}
            return super().call(name, arguments)

    fake_noenum = NoEnumMcp()
    noenum = run_job({"mcp_url": "http://mcp.test"}, "j", client=fake_noenum)
    check("no retry when the error names no enum",
          len([a for t, a in fake_noenum.journal if t == "scroll"]) == 1,
          json.dumps([a for t, a in fake_noenum.journal if t == "scroll"]))
    check("the verbatim error is recorded",
          "Invalid direction" in json.dumps(noenum["steps"][5].get("result") or ""),
          json.dumps(noenum["steps"][5].get("result")))

    print("tree: the tables match the proxy's recorded schema (B-43 drift test)")
    # The recorded `surface.schemas` from run_1a1e8f3fd71 (2026-11-17) — the
    # live truth. If the proxy's schema drifts, this fails loudly instead of
    # silently mis-estimating.
    _recorded_required = {
        "list_apps": (),
        "get_app_state": ("app",),
        "click": ("app",),
        "type_text": ("app", "text"),
        "press_key": ("app", "key"),
        "scroll": ("app", "element_index", "direction"),
        "set_value": ("app", "element_index", "value"),
        "drag": ("app", "from_x", "from_y", "to_x", "to_y"),
        "perform_secondary_action": ("app", "element_index", "action"),
    }
    for _n, _req in _recorded_required.items():
        check("%s: TOOL_REQUIRED == recorded live schema" % _n,
              TOOL_REQUIRED.get(_n) == _req,
              json.dumps(TOOL_REQUIRED.get(_n)))
        _schema = json.loads(schema_tokens(_n, dict(DESKTOP_TOOLS)[_n]))
        check("%s: schema_tokens required == recorded live schema" % _n,
              tuple(_schema["parameters"].get("required") or []) == _req,
              json.dumps(_schema["parameters"].get("required")))
    check("no step emits an argument outside the tool's declared props",
          all(set(s.get("args", {}).keys()) <= set(TOOL_PARAMS.get(s["tool"], {}))
              for s in BENCH_STEPS),
          json.dumps([(s["tool"], sorted(s.get("args", {}).keys()))
                      for s in BENCH_STEPS]))

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

    print("sandbox: generated-code jobs route to the sandbox, refusals surface (T139)")
    import tempfile as _tempfile
    import types as _types
    _sb_root = _tempfile.mkdtemp(prefix="codemode-sandbox-test-")
    _sb_ws_root = os.path.join(_sb_root, "workspaces")
    _sb_ws = os.path.join(_sb_ws_root, "job-001")
    os.makedirs(_sb_ws)
    with open(os.path.join(_sb_ws, "job.py"), "w", encoding="utf-8") as fh:
        fh.write("print('sandbox-ok')\n")
    _sb_token_root = os.path.join(_sb_root, "tokens")
    os.makedirs(_sb_token_root)
    _sb_calls = []

    def _fake_run(argv, capture_output=None, text=None, timeout=None):
        _sb_calls.append(list(argv))
        return _types.SimpleNamespace(returncode=0, stdout="sandbox-ok\n", stderr="")

    _sb_job = {"job_id": "job-001", "kind": "generated-code",
               "workspace": _sb_ws, "script": "job.py", "deadline_s": 120,
               "hosts": [], "vault_items": []}
    _sb_entry = run_sandbox_job({"mcp_url": "http://mcp.test"}, dict(_sb_job),
                                _run=_fake_run, token_root=_sb_token_root,
                                workspace_root=_sb_ws_root)
    check("sandbox job runs and reports ok", _sb_entry["status"] == "ok",
          json.dumps(_sb_entry)[:300])
    _sb_argv = _sb_calls[-1] if _sb_calls else []
    check("sandbox argv uses the sandbox image", "qwenpaw-sandbox:2.3.0" in _sb_argv,
          json.dumps(_sb_argv))
    check("sandbox argv uses the isolated bridge",
          "--network" in _sb_argv and "qwenpaw-sandbox-net" in _sb_argv,
          json.dumps(_sb_argv))
    check("sandbox argv mounts the resolved workspace read-write",
          any(a.startswith("type=bind,source=" + _sb_ws + ",target=/workspace")
              for a in _sb_argv),
          json.dumps(_sb_argv))
    check("sandbox argv runs the job script as uid 10001",
          "--user" in _sb_argv and "10001:10001" in _sb_argv
          and _sb_argv[-2:] == ["python3", "/workspace/job.py"],
          json.dumps(_sb_argv))
    check("sandbox argv carries no credential in env",
          not any("TOKEN" in a or "SECRET" in a for a in _sb_argv),
          json.dumps(_sb_argv))
    check("no token dir is created when the job needs no vault value",
          os.listdir(_sb_token_root) == [], json.dumps(os.listdir(_sb_token_root)))
    # A vault job mints a token, writes it to the tmpfs file, and the
    # runner removes the directory when the job ends.
    _old_key = os.environ.get("SANDBOX_BROKER_KEY")
    os.environ["SANDBOX_BROKER_KEY"] = "44" * 32
    try:
        def _fake_run_token(argv, capture_output=None, text=None, timeout=None):
            _sb_calls.append(list(argv))
            _tok_seen = os.path.join(_sb_token_root, "job-002", "token")
            _seen = os.path.exists(_tok_seen) and open(_tok_seen).read().startswith("v1.")
            return _types.SimpleNamespace(returncode=0,
                                          stdout="token-seen:%s" % _seen, stderr="")

        _sb_job2 = {"job_id": "job-002", "kind": "generated-code",
                    "workspace": _sb_ws, "script": "job.py", "deadline_s": 120,
                    "hosts": ["api.github.com"], "vault_items": ["github-api"]}
        _sb_entry2 = run_sandbox_job({"mcp_url": "http://mcp.test"}, dict(_sb_job2),
                                     _run=_fake_run_token, token_root=_sb_token_root,
                                     workspace_root=_sb_ws_root)
        check("vault job mints a token and writes it to the tmpfs file",
              _sb_entry2["status"] == "ok"
              and "token-seen:True" in (_sb_entry2.get("stdout") or ""),
              json.dumps(_sb_entry2)[:300])
        check("the token directory is removed when the job ends",
              not os.path.exists(os.path.join(_sb_token_root, "job-002")),
              json.dumps(os.listdir(_sb_token_root)))
        check("the token bind mounts the per-job token dir",
              any(a == "type=bind,source=" + os.path.join(_sb_token_root, "job-002")
                  + ",target=/run/sandbox-token" for a in _sb_calls[-1]),
              json.dumps(_sb_calls[-1]))
    finally:
        if _old_key is None:
            os.environ.pop("SANDBOX_BROKER_KEY", None)
        else:
            os.environ["SANDBOX_BROKER_KEY"] = _old_key
    # Missing key + vault need -> blocked, naming the key.
    _sb_entry3 = run_sandbox_job({"mcp_url": "http://mcp.test"},
                                 {"job_id": "job-003", "kind": "generated-code",
                                  "workspace": _sb_ws, "script": "job.py",
                                  "hosts": ["api.github.com"], "vault_items": ["github-api"]},
                                 _run=_fake_run, token_root=_sb_token_root,
                                 workspace_root=_sb_ws_root)
    check("vault job without a key is blocked and names SANDBOX_BROKER_KEY",
          _sb_entry3["status"] == "blocked"
          and "SANDBOX_BROKER_KEY" in (_sb_entry3.get("reason") or ""),
          json.dumps(_sb_entry3)[:300])
    # Refusals surface the reason and run nothing.
    _before = len(_sb_calls)
    _ref = run_sandbox_job({"mcp_url": "http://mcp.test"},
                           {"job_id": "job-004", "kind": "generated-code",
                            "workspace": _sb_ws, "script": "job.py",
                            "tools": ["click"]},
                           _run=_fake_run, token_root=_sb_token_root,
                           workspace_root=_sb_ws_root)
    check("desktop-tool job is refused with the reason surfaced",
          _ref["status"] == "refused" and "desktop" in (_ref.get("reason") or "").lower(),
          json.dumps(_ref)[:300])
    check("a refused job spawns nothing", len(_sb_calls) == _before,
          f"{len(_sb_calls)} vs {_before}")
    _ref2 = run_sandbox_job({"mcp_url": "http://mcp.test"},
                            {"job_id": "job-005", "kind": "generated-code",
                             "workspace": _sb_ws, "script": "job.py",
                             "hosts": ["evil.example.com"]},
                            _run=_fake_run, token_root=_sb_token_root,
                            workspace_root=_sb_ws_root)
    check("non-allowlisted host is refused at the runner",
          _ref2["status"] == "refused" and "egress" in (_ref2.get("reason") or "").lower(),
          json.dumps(_ref2)[:300])
    # Symlink escape: a workspace that resolves outside the root is refused.
    _outside = os.path.join(_sb_root, "outside")
    os.makedirs(_outside)
    _link = os.path.join(_sb_ws, "escape-link")
    try:
        os.symlink(_outside, _link)
    except OSError:
        _link = None
    if _link is not None:
        _ref3 = run_sandbox_job({"mcp_url": "http://mcp.test"},
                                {"job_id": "job-006", "kind": "generated-code",
                                 "workspace": _link, "script": "job.py"},
                                _run=_fake_run, token_root=_sb_token_root,
                                workspace_root=_sb_ws_root)
        check("a workspace symlink escaping the root is refused",
              _ref3["status"] == "refused" and "escapes" in (_ref3.get("reason") or ""),
              json.dumps(_ref3)[:300])
    else:
        check("a workspace symlink escaping the root is refused", False,
              "could not create a symlink in the test dir")
    # A bad job id never reaches a path or an argv.
    _ref4 = run_sandbox_job({"mcp_url": "http://mcp.test"},
                            {"job_id": "job/../007", "kind": "generated-code",
                             "workspace": _sb_ws, "script": "job.py"},
                            _run=_fake_run, token_root=_sb_token_root,
                            workspace_root=_sb_ws_root)
    check("a job id with a slash is refused",
          _ref4["status"] == "refused" and "job_id" in (_ref4.get("reason") or ""),
          json.dumps(_ref4)[:300])
    # A missing script is refused, not run.
    _ref5 = run_sandbox_job({"mcp_url": "http://mcp.test"},
                            {"job_id": "job-008", "kind": "generated-code",
                             "workspace": _sb_ws, "script": "nope.py"},
                            _run=_fake_run, token_root=_sb_token_root,
                            workspace_root=_sb_ws_root)
    check("a missing job script is refused",
          _ref5["status"] == "refused" and "script" in (_ref5.get("reason") or ""),
          json.dumps(_ref5)[:300])
    # Timeout: the fake run raises, the entry says so, nothing leaks.
    def _fake_run_timeout(argv, capture_output=None, text=None, timeout=None):
        raise subprocess.TimeoutExpired(argv, timeout)

    _to = run_sandbox_job({"mcp_url": "http://mcp.test"}, dict(_sb_job),
                          _run=_fake_run_timeout, token_root=_sb_token_root,
                          workspace_root=_sb_ws_root)
    check("a job past its deadline reports timeout",
          _to["status"] == "timeout" and _to.get("timedOut") is True,
          json.dumps(_to)[:300])
    # The legacy exception still routes to main (fixed job via FakeMcp).
    _main_entry = run_sandbox_job({"mcp_url": "http://mcp.test"},
                                  {"job_id": "codemode-fixed-job",
                                   "kind": "codemode-fixed-job"},
                                  client=FakeMcp(), token_root=_sb_token_root,
                                  workspace_root=_sb_ws_root)
    check("the fixed pilot job still routes to main",
          _main_entry.get("target") == "main"
          and _main_entry["status"] in ("ok", "partial"),
          json.dumps(_main_entry.get("status")) + " / " + str(_main_entry.get("target")))
    shutil.rmtree(_sb_root, ignore_errors=True)

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
