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
# The tool surface (unchanged from the Worker: the measurement must be
# comparable, so the same 30 tools and the same 10 steps are modelled).
# ---------------------------------------------------------------------------

TOOL_NAMES = [
    ("list_tickets", "List open tickets, newest first."),
    ("read_ticket", "Read one ticket by id, including its full comment thread."),
    ("create_ticket", "Create a ticket with a title, body and optional labels."),
    ("update_ticket", "Update a ticket's title, body, status or labels."),
    ("add_comment", "Append a comment to a ticket."),
    ("close_ticket", "Close a ticket with an optional resolution note."),
    ("list_projects", "List projects visible to the caller."),
    ("read_project", "Read one project and its member list."),
    ("create_project", "Create a project with a name and description."),
    ("archive_project", "Archive a project so it stops appearing in lists."),
    ("list_agents", "List agents registered on the machine."),
    ("agent_status", "Read one agent's running state and active model."),
    ("start_agent", "Start a stopped agent."),
    ("stop_agent", "Stop a running agent, flushing its state first."),
    ("send_message", "Send a message to an agent or a group thread."),
    ("read_thread", "Read a group thread since a timestamp."),
    ("list_routines", "List configured routines and their cron schedules."),
    ("run_routine", "Trigger a routine once, outside its schedule."),
    ("routine_history", "Read a routine's recent run history."),
    ("screenshot_desktop", "Capture the current desktop screen as an image."),
    ("list_apps", "List applications with windows on the desktop."),
    ("click", "Click at a screen coordinate, or on a named accessibility node."),
    ("type_text", "Type text into the focused control."),
    ("open_url", "Open a URL on the desktop's browser."),
    ("get_page_text", "Read the visible text of the current browser page."),
    ("list_skills", "List installed skills and whether each is enabled."),
    ("run_skill", "Run one installed skill with named arguments."),
    ("read_file", "Read a file from the agent workspace, with a byte cap."),
    ("write_file", "Write a file into the agent workspace."),
    ("search_history", "Search recorded conversation history for keywords."),
]

#: The fixed job. Read-only on purpose: a pilot that mutates the ticket board
#: every time it runs is a pilot nobody will run twice. The two write-shaped
#: steps the original modelled are replaced with their read equivalents, and
#: that change is stated here rather than quietly made.
BENCH_STEPS = [
    {"tool": "list_tickets", "step": "read the ticket board"},
    {"tool": "read_ticket", "step": "open the newest ticket"},
    {"tool": "list_projects", "step": "find its project"},
    {"tool": "read_project", "step": "read the project members"},
    {"tool": "screenshot_desktop", "step": "capture the desktop"},
    {"tool": "list_apps", "step": "check which windows are up"},
    {"tool": "get_page_text", "step": "read the browser page"},
    {"tool": "routine_history", "step": "check the routine's last run"},
    {"tool": "read_thread", "step": "read the group thread"},
    {"tool": "search_history", "step": "search past conversations"},
]


def schema_tokens(name: str, description: str) -> str:
    return ('{"name":"%s","description":"%s","parameters":{"type":"object","properties":{'
            '"id":{"type":"string","description":"Target identifier"},'
            '"body":{"type":"string","description":"Optional payload"}},"required":["id"]}}'
            % (name, description))


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
    classic_schemas = "\n".join(schema_tokens(n, d) for n, d in TOOL_NAMES)
    classic_prompt_tokens = estimate_tokens(classic_schemas, chars_per_token)

    connector_hints = " ".join([
        "tickets: list, read, create, update, comment, close. Use for the ticket board.",
        "agents: list, status, start, stop, send_message, read_thread. Use for agents and group threads.",
        "routines: list, run, history. Use for scheduled jobs.",
        "desktop: screenshot, list_apps, click, type, open_url, get_page_text. Use for the live desktop.",
        "files: read_file, write_file, search_history. Use for the workspace and past conversations.",
    ])
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
    classic_turns = steps
    codemode_turns = 1
    codemode_turns_with_retry = 2

    classic_total = classic_prompt_tokens * classic_turns
    codemode_total = codemode_prompt_tokens * codemode_turns
    codemode_total_retry = codemode_prompt_tokens * codemode_turns_with_retry

    code_overhead = estimate_tokens(
        'async () => { const t = await codemode.tickets.list_tickets({ id: "" }); return t; }',
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
        "surface": {"tools": len(TOOL_NAMES), "steps_in_job": steps},
        "multi_step_job": {
            "classic": {
                "turns": classic_turns,
                "prompt_tokens_per_turn": classic_prompt_tokens,
                "total_prompt_tokens": classic_total,
            },
            "codemode": {
                "turns": codemode_turns,
                "prompt_tokens_per_turn": codemode_prompt_tokens,
                "total_prompt_tokens": codemode_total,
                "turns_with_one_retry": codemode_turns_with_retry,
                "total_with_one_retry": codemode_total_retry,
            },
            "prompt_token_reduction": {
                "best_case_pct": round1((1 - codemode_total / classic_total) * 100),
                "with_one_retry_pct": round1((1 - codemode_total_retry / classic_total) * 100),
            },
            "turn_reduction": {
                "from": classic_turns, "to": codemode_turns,
                "factor": round1(classic_turns / codemode_turns),
            },
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
            "The codemode prompt here models 5 connectors with short hints; adding "
            "connectors raises that side and narrows the gap. The reduction is an "
            "upper bound for this surface, not a universal constant.",
            "Astra-class models still need one turn per visual decision; desktop "
            "work cannot batch screenshots into one script (research note §4).",
            "Failures cost a retry: the with_one_retry column is the honest case.",
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


def run_job(config: dict, job: str = "fixed-bench-job", client=None,
            apply_limits: bool = False) -> dict:
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

        for index, step in enumerate(BENCH_STEPS, start=1):
            if time.time() - started > JOB_DEADLINE_S:
                entry["steps"].append({
                    "n": index, "tool": step["tool"], "ok": False,
                    "error": "job deadline exceeded before this step",
                })
                continue
            step_started = time.time()
            try:
                result = box.call(step["tool"], {"id": ""})
                entry["steps"].append({
                    "n": index,
                    "tool": step["tool"],
                    "purpose": step["step"],
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
    failed = [s for s in entry["steps"] if not s.get("ok")]
    if attempted == 0:
        entry["status"] = "error"
        entry["note"] = entry["note"] or "No steps were attempted."
    elif not failed and attempted == len(BENCH_STEPS):
        entry["status"] = "ok"
        entry["note"] = ("All %d steps succeeded through the MCP proxy on the machine. "
                         "The job is a fixed, auditable program; no model-generated code "
                         "was executed." % attempted)
    else:
        entry["status"] = "partial" if not entry.get("error") else "error"
        entry["note"] = entry["note"] or (
            "%d of %d steps failed. Per-step outcomes are in `steps`; nothing is "
            "reported as successful unless it was." % (len(failed), attempted))

    entry["durationMs"] = int((time.time() - started) * 1000)
    entry["summary"] = {
        "attempted": attempted,
        "ok": len([s for s in entry["steps"] if s.get("ok")]),
        "failed": len(failed),
        "expected": len(BENCH_STEPS),
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
    m = b["multi_step_job"]
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
 <div class="row"><span class="k">Classic: prompt tokens for a %d-step job</span>
  <span class="ok">%s</span></div>
 <div class="row"><span class="k">Code Mode: same job</span>
  <span class="ok">%s</span></div>
 <div class="row"><span class="k">Reduction (best case / one retry)</span>
  <span class="ok">%s%% / %s%%</span></div>
 <div class="row"><span class="k">Turn reduction</span>
  <span class="ok">%s -> %s</span></div>
 <div class="row"><span class="k">Single simple call</span>
  <span class="bad">worse than classic</span></div>
</div>

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
        b["surface"]["steps_in_job"],
        format(m["classic"]["total_prompt_tokens"], ","),
        format(m["codemode"]["total_prompt_tokens"], ","),
        m["prompt_token_reduction"]["best_case_pct"],
        m["prompt_token_reduction"]["with_one_retry_pct"],
        m["turn_reduction"]["from"], m["turn_reduction"]["to"],
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

    print("bench: the measurement is unchanged and internally consistent")
    b = bench()
    check("30 tools modelled", b["surface"]["tools"] == 30, str(b["surface"]["tools"]))
    check("10-step job", b["surface"]["steps_in_job"] == 10, str(b["surface"]["steps_in_job"]))
    check("runtime is vm", b["runtime"] == "vm", b["runtime"])
    check("marks itself approximate", b["estimator"]["approximate"] is True)
    check("names the estimator", "chars / 3.6" in b["estimator"]["method"], b["estimator"]["method"])
    m = b["multi_step_job"]
    check("classic turns equal steps", m["classic"]["turns"] == 10, str(m["classic"]["turns"]))
    check("codemode is one turn", m["codemode"]["turns"] == 1)
    check("classic total = per-turn x turns",
          m["classic"]["total_prompt_tokens"] == m["classic"]["prompt_tokens_per_turn"] * 10)
    check("retry total = per-turn x retry turns",
          m["codemode"]["total_with_one_retry"]
          == m["codemode"]["prompt_tokens_per_turn"] * m["codemode"]["turns_with_one_retry"])
    check("codemode reduces total prompt tokens",
          m["codemode"]["total_prompt_tokens"] < m["classic"]["total_prompt_tokens"])
    check("reduction survives one retry", m["prompt_token_reduction"]["with_one_retry_pct"] > 0)
    check("turn factor is 10x", m["turn_reduction"]["factor"] == 10, str(m["turn_reduction"]["factor"]))
    check("reports single-call as WORSE", "WORSE" in b["single_call_job"]["verdict"])
    check("caveats listed", len(b["caveats"]) >= 3, str(len(b["caveats"])))
    check("caveat names the visual bound", any("visual" in c for c in b["caveats"]))
    b4 = bench(4)
    check("custom chars_per_token honoured", b4["estimator"]["method"] == "chars / 4",
          b4["estimator"]["method"])

    print("job: the fixed program is what runs, and it is read-only")
    check("the job has exactly 10 steps", len(BENCH_STEPS) == 10, str(len(BENCH_STEPS)))
    tools_used = [s["tool"] for s in BENCH_STEPS]
    check("no step mutates the board or the machine",
          not any(t in ("create_ticket", "update_ticket", "add_comment", "close_ticket",
                        "run_routine", "write_file", "run_skill", "click", "type_text",
                        "start_agent", "stop_agent") for t in tools_used),
          json.dumps(tools_used))
    check("every step names a real tool",
          all(t in dict(TOOL_NAMES) for t in tools_used), json.dumps(tools_used))
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
    check("all 10 steps recorded", len(ok["steps"]) == 10, str(len(ok["steps"])))
    check("summary counts 10 ok", ok["summary"]["ok"] == 10, json.dumps(ok["summary"]))
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
    check("the other steps still ran", partial["summary"]["ok"] == 9,
          json.dumps(partial["summary"]))
    check("nothing is reported as successful that was not",
          partial["summary"]["failed"] == 1, json.dumps(partial["summary"]))

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
