#!/usr/bin/env python3
"""End-to-end harness: the runner driving the fixed job against a REAL MCP
server, over real HTTP, plus the HTTP surface of the runner itself.

This is the file that would have caught the retired Cloudflare pilot's dead
MCP call. Three separate mocks agreed with each other there; here nothing
below the runner is mocked — the MCP server is a real HTTP server speaking
the real SSE + JSON-RPC transport, and the job runs through `run_job()` exactly
as it does on the machine.

Run: python3 features/codemode/vm/test_e2e.py
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from test_mcp import MockMcpServer  # noqa: E402 - import only; its suite is guarded by __main__
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "runner", os.path.join(HERE, "codemode-runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

passed = 0
failed: list[str] = []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print("  ok   %s" % name)
    else:
        failed.append(name)
        print("  FAIL %s  %s" % (name, detail))


# ---------------------------------------------------------------------------
# End to end: runner -> real MCP -> per-step results
# ---------------------------------------------------------------------------

print("e2e: the fixed job against a real MCP server")
with MockMcpServer(tools=[{"name": n, "description": d}
                          for n, d in runner.TOOL_NAMES]) as server:
    result = runner.run_job({"mcp_url": server.url}, "e2e")
    check("status ok", result["status"] == "ok",
          "%s / %s" % (result["status"], result.get("note")))
    check("all 10 steps ran", len(result["steps"]) == 10, str(len(result["steps"])))
    check("all 10 succeeded", result["summary"]["ok"] == 10, json.dumps(result["summary"]))
    check("each step names its tool",
          [s["tool"] for s in result["steps"]] == [s["tool"] for s in runner.BENCH_STEPS],
          json.dumps([s["tool"] for s in result["steps"]]))
    check("each step carries a purpose (readable in a report)",
          all(s.get("purpose") for s in result["steps"]))
    check("each step carries a duration", all(isinstance(s.get("ms"), int)
                                              for s in result["steps"]))
    check("the MCP server name is recorded",
          result["server"]["name"] == "open-computer-use", str(result.get("server")))
    check("the note states no generated code ran",
          "no model-generated code" in result["note"], result.get("note"))
    # The wire really carried 10 tool calls plus the handshake.
    methods = [r.get("method") for r in server.requests]
    check("10 tools/call requests went over the wire",
          methods.count("tools/call") == 10, str(methods.count("tools/call")))
    check("the handshake happened exactly once",
          methods.count("initialize") == 1, str(methods.count("initialize")))

print("e2e: a tool that errors mid-job")
with MockMcpServer(tools=[{"name": n, "description": d} for n, d in runner.TOOL_NAMES],
                   fail_tools={"screenshot_desktop"}) as server:
    result = runner.run_job({"mcp_url": server.url}, "e2e-fail")
    check("status is partial", result["status"] == "partial", result["status"])
    bad = [s for s in result["steps"] if not s.get("ok")]
    check("exactly one step failed", len(bad) == 1, json.dumps(bad)[:200])
    check("the failed step is the one that errored",
          bad[0]["tool"] == "screenshot_desktop", bad[0]["tool"])
    check("the other nine still succeeded", result["summary"]["ok"] == 9,
          json.dumps(result["summary"]))
    check("the job continued past a tool-level error",
          len(result["steps"]) == 10, str(len(result["steps"])))

print("e2e: a transport failure mid-job stops it and says so")
with MockMcpServer(tools=[{"name": n, "description": d} for n, d in runner.TOOL_NAMES],
                   http_error_tools={"list_projects"}) as server:
    result = runner.run_job({"mcp_url": server.url}, "e2e-transport")
    check("status is not ok", result["status"] != "ok", result["status"])
    check("it stopped at the failing step", len(result["steps"]) == 3,
          str(len(result["steps"])))
    check("the note says the rest were not attempted",
          "not attempted" in (result.get("note") or ""), result.get("note"))
    # The critical property: it must NOT report the unattempted steps as
    # failures. A report of "10 failed" would be a lie in the other direction.
    check("unattempted steps are absent, not failed",
          len(result["steps"]) < 10, str(len(result["steps"])))

print("e2e: no MCP configured")
result = runner.run_job({}, "e2e-blocked")
check("status blocked", result["status"] == "blocked", result["status"])
check("nothing was executed", result["steps"] == [])
check("the blocker is named", any("MCP_SSE_URL" in b for b in result["blockers"]),
      json.dumps(result["blockers"]))

print("e2e: a real HTTP surface over the runner")
# Start the runner itself on a loopback port and talk to it like a client.
config = {"mcp_url": "", "mcp_token": "", "token": "e2e-token-value"}
from http.server import ThreadingHTTPServer  # noqa: E402

handler = runner.make_handler(config)
srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
srv.daemon_threads = True
port = srv.server_address[1]
thread = threading.Thread(target=srv.serve_forever, daemon=True)
thread.start()
base = "http://127.0.0.1:%d" % port


def get(path, headers=None):
    req = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def post(path, body=None, headers=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(base + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


status, body = get("/health")
health = json.loads(body)
check("/health is 200", status == 200, str(status))
check("health reports the vm runtime", health["runtime"] == "vm", health.get("runtime"))
check("health reports the runner available", health["runner"] == "available")
check("health is honest that it is not ready without MCP",
      health["ready"] is False, str(health.get("ready")))
check("health reports mcp unconfigured", health["mcp"] == "unconfigured")

status, body = get("/api/bench")
bench = json.loads(body)
check("/api/bench is 200", status == 200, str(status))
check("bench numbers are present", bench["multi_step_job"]["classic"]["turns"] == 10)

status, body = post("/api/run")
check("run without a token header is 401", status == 401, str(status))
status, body = post("/api/run", headers={"X-Codemode-Token": "wrong"})
check("run with a wrong token is 401", status == 401, str(status))
status, body = post("/api/run?token=e2e-token-value")
check("a correct token in the QUERY is still 401", status == 401,
      "%s — the header is the only accepted place (B-18)" % status)

status, body = post("/api/run", headers={"X-Codemode-Token": "e2e-token-value"})
check("with the right header but no MCP, it is 503", status == 503, str(status))
blocked = json.loads(body)
check("and it says nothing was executed",
      "Nothing was executed" in blocked.get("note", ""), blocked.get("note"))

status, body = get("/api/runs")
runs = json.loads(body)
check("/api/runs lists the attempt", runs["count"] >= 1, str(runs.get("count")))
check("the audit entry carries blockers",
      all(isinstance(r.get("blockers"), list) for r in runs["runs"]))

status, body = get("/")
check("the status page is 200", status == 200, str(status))
check("the page names the VM runtime", "InstaBox VM" in body)
check("the page states the Cloudflare path is dead", "10195" in body)
check("the page does not leak the token", "e2e-token-value" not in body)

status, body = get("/nope")
check("an unknown path is 404", status == 404, str(status))

srv.shutdown()
srv.server_close()

print("e2e: a fully configured runner actually executes over HTTP")
with MockMcpServer(tools=[{"name": n, "description": d}
                          for n, d in runner.TOOL_NAMES]) as mcp:
    cfg = {"mcp_url": mcp.url, "mcp_token": "", "token": "e2e-token-value"}
    h = runner.make_handler(cfg)
    s2 = ThreadingHTTPServer(("127.0.0.1", 0), h)
    s2.daemon_threads = True
    p2 = s2.server_address[1]
    t2 = threading.Thread(target=s2.serve_forever, daemon=True)
    t2.start()
    base2 = "http://127.0.0.1:%d" % p2
    req = urllib.request.Request(base2 + "/api/run", data=b"{}", method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Codemode-Token": "e2e-token-value"})
    with urllib.request.urlopen(req, timeout=60) as r:
        code = r.status
        payload = json.loads(r.read().decode())
    check("a configured runner answers 200", code == 200, str(code))
    check("the real job ran through real HTTP", payload["summary"]["ok"] == 10,
          json.dumps(payload.get("summary")))
    check("the response is the same shape as the blocked path",
          set(payload.keys()) >= {"id", "job", "status", "steps", "summary"},
          json.dumps(sorted(payload.keys())))
    s2.shutdown()
    s2.server_close()

print()
total = passed + len(failed)
print("%d passed, %d failed  (%d checks)" % (passed, len(failed), total))
if failed:
    print("failed: " + ", ".join(failed))
    sys.exit(1)
