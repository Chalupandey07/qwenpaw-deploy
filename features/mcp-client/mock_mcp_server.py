#!/usr/bin/env python3
"""Mock MCP server over stdio (newline-delimited JSON-RPC) — test fixture.

Usage:
    python3 mock_mcp_server.py <marker_path> <log_path> [mode]

Writes a "started" marker (line 1) plus its environment keys as JSON
(line 2) to <marker_path> at startup — that file existing proves the
process was actually spawned. Appends one line per received JSON-RPC
message to <log_path> so the test can assert ordering and that a
refused tool was NEVER sent to the server.

Modes (default "normal"):
  normal       echo/read/boom/softfail behave; secret_tool would answer
               "SECRET-NEVER" if ever called (it must never be).
  ping         before answering tools/list, sends a server->client
               request {"method": "ping"} whose id collides with the
               pending tools/list id; the client must answer it with an
               empty result and still get the list.
  out-of-order buffers two tools/call requests and answers the second
               one first, to prove id correlation.
  slow         never answers tools/call (tests the client timeout).
  crash        exits(1) on the first tools/call (pending calls must fail
               fast, not hang).
  stderr-flood writes ~1 MB to stderr at startup, then behaves normally
               (a client that does not drain stderr deadlocks the child).

Tools advertised: echo, read, secret_tool, boom, softfail.
  echo     -> "echo:<text>"
  read     -> "read-ok:<path>"
  boom     -> JSON-RPC error {"code": -32000, "message": "boom failed"}
  softfail -> result {"isError": true, "content": [{"type": "text",
              "text": "soft failure"}]} (a tool error is DATA, not an
              exception — the client must return ok=False, not raise)
  secret_tool -> "SECRET-NEVER" (allowlist tests assert it is never sent)

Stdlib only. Not a real server; it exists so the T128 harness speaks
the real wire format to a real subprocess instead of mocking the layer
below the client.
"""

from __future__ import annotations

import json
import os
import sys

TOOLS = [
    {"name": "echo", "description": "Echo text back"},
    {"name": "read", "description": "Read a path (mocked)"},
    {"name": "secret_tool", "description": "Must never be called"},
    {"name": "boom", "description": "Returns a JSON-RPC error"},
    {"name": "softfail", "description": "Returns an isError result"},
]


def main() -> int:
    marker_path, log_path = sys.argv[1], sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "normal"

    with open(marker_path, "w", encoding="utf-8") as fh:
        fh.write("started\n")
        fh.write(json.dumps(sorted(os.environ.keys())) + "\n")
    if mode == "stderr-flood":
        sys.stderr.write("x" * (1024 * 1024))
        sys.stderr.flush()

    def log(line: str) -> None:
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    def send(obj: dict) -> None:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    def result(mid, payload):
        send({"jsonrpc": "2.0", "id": mid, "result": payload})

    def error(mid, code, message):
        send({"jsonrpc": "2.0", "id": mid,
              "error": {"code": code, "message": message}})

    def handle_tools_call(mid, params):
        name = (params or {}).get("name")
        args = (params or {}).get("arguments") or {}
        log("tools/call:%s" % name)
        if mode == "crash":
            os._exit(1)
        if mode == "slow":
            return  # never answer: the client must time out
        if name == "echo":
            result(mid, {"isError": False, "content": [
                {"type": "text", "text": "echo:%s" % args.get("text", "")}]})
        elif name == "read":
            result(mid, {"isError": False, "content": [
                {"type": "text", "text": "read-ok:%s" % args.get("path", "")}]})
        elif name == "secret_tool":
            result(mid, {"isError": False, "content": [
                {"type": "text", "text": "SECRET-NEVER"}]})
        elif name == "boom":
            error(mid, -32000, "boom failed")
        elif name == "softfail":
            result(mid, {"isError": True, "content": [
                {"type": "text", "text": "soft failure"}]})
        else:
            error(mid, -32602, "unknown tool: %s" % name)

    pending_calls: list[tuple] = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        method = msg.get("method")
        mid = msg.get("id")
        if method == "initialize":
            log("initialize")
            result(mid, {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "serverInfo": {"name": "mock-echo", "version": "1.0"},
            })
        elif method == "notifications/initialized":
            log("notifications/initialized")
        elif method == "tools/list":
            log("tools/list")
            if mode == "ping":
                # A server->client request whose id collides with the
                # pending tools/list id. The client must answer it as a
                # request (empty result) and NOT mistake it for the list.
                send({"jsonrpc": "2.0", "id": mid, "method": "ping"})
            result(mid, {"tools": TOOLS})
        elif method == "tools/call":
            if mode == "out-of-order":
                pending_calls.append((mid, msg.get("params") or {}))
                if len(pending_calls) >= 2:
                    for saved_mid, saved_params in reversed(pending_calls):
                        handle_tools_call(saved_mid, saved_params)
                    pending_calls.clear()
            else:
                handle_tools_call(mid, msg.get("params") or {})
        elif "id" in msg and "method" not in msg:
            # A response to a server->client request we sent (e.g. our
            # ping answer coming back is actually a *request* from the
            # client side — log it so the test can assert it arrived).
            log("response-to-server-request:%s" % json.dumps(msg))
        else:
            log("unknown:%s" % method)
    return 0


if __name__ == "__main__":
    sys.exit(main())
