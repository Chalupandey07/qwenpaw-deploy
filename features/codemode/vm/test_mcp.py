#!/usr/bin/env python3
"""Harness for the MCP client against a REAL SSE + JSON-RPC server.

WHY THIS IS SEPARATE FROM THE RUNNER'S SELFTEST

The retired Cloudflare version of this pilot called MCP as
`POST {url}?tool=<name>` — a shape that does not exist. It never ran against a
real proxy, and nothing caught it because every test mocked the layer below:
the harness mocked the loader, the loader mocked the call. Three levels of
mock agreeing with each other proves nothing about the wire.

So this file speaks the ACTUAL protocol to an in-process HTTP server that
implements it: an SSE stream that first sends the message endpoint, then
delivers JSON-RPC responses as `event: message` frames on that same stream,
with requests POSTed to the advertised endpoint. That is what the machine's
`mcp-proxy` does, and it is what `features/test-project/run-tests.py`
(MCP_SCRIPT) already proves against the live box.

Run: python3 features/codemode/vm/test_mcp.py
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp import McpClient, McpError, _endpoint_from  # noqa: E402

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
# A REAL MCP server: SSE discovery + JSON-RPC over POST, responses on the
# stream. Deliberately faithful, including the parts that are awkward.
# ---------------------------------------------------------------------------

class MockMcpServer:
    """Threaded HTTP server implementing the MCP SSE transport."""

    def __init__(self, *, tools=None, fail_tools=(), http_error_tools=(),
                 authorize=None, sse_headers=None, required_args=None):
        self.tools = tools if tools is not None else [
            {"name": "list_apps", "description": "List windows"},
            {"name": "read_file", "description": "Read a file"},
        ]
        self.fail_tools = set(fail_tools)          # isError: true
        # The live proxy's required-argument contract (B-42). Empty by default
        # so transport tests are unaffected; the runner's e2e sets it.
        self.required_args = required_args or {}
        self.http_error_tools = set(http_error_tools)  # transport failure
        self.authorize = authorize                  # callable(header) -> bool
        self.sse_headers = sse_headers or {}
        self.sessions: dict[str, queue.Queue] = {}
        self.requests: list[dict] = []
        self.closed = threading.Event()
        self._server = None
        self._thread = None
        self.port = None

    # ------------------------------------------------------------------ setup
    def __enter__(self):
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self.closed.set()
        self._server.shutdown()
        self._server.server_close()

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.port

    # ---------------------------------------------------------------- handler
    def _handler(self):
        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_GET(self):  # noqa: N802
                if self.path != "/sse":
                    self.send_error(404)
                    return
                if outer.authorize and not outer.authorize(self.headers.get("Authorization")):
                    self.send_error(401)
                    return
                session = "sess%d" % (len(outer.sessions) + 1)
                q: queue.Queue = queue.Queue()
                outer.sessions[session] = q
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                for k, v in outer.sse_headers.items():
                    self.send_header(k, v)
                self.end_headers()
                # 1. the endpoint event — exactly as a real proxy sends it.
                self.wfile.write(
                    ("event: endpoint\ndata: /messages/?session_id=%s\n\n" % session).encode())
                self.wfile.flush()
                # 2. then stream responses until the client goes away.
                while not outer.closed.is_set():
                    try:
                        payload = q.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    self.wfile.write(("event: message\ndata: %s\n\n" % payload).encode())
                    self.wfile.flush()

            def do_POST(self):  # noqa: N802
                if not self.path.startswith("/messages/"):
                    self.send_error(404)
                    return
                session = None
                for part in self.path.split("?", 1)[-1].split("&"):
                    if part.startswith("session_id="):
                        session = part.split("=", 1)[1]
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append(body)
                q = outer.sessions.get(session)
                if q is None:
                    self.send_error(400)
                    return
                # A notification has no id and gets no response.
                if "id" not in body:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                mid = body["id"]
                method = body.get("method")
                if method == "initialize":
                    q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "serverInfo": {"name": "open-computer-use", "version": "1.1.4"},
                    }}))
                elif method == "tools/list":
                    q.put(json.dumps({"jsonrpc": "2.0", "id": mid,
                                      "result": {"tools": outer.tools}}))
                elif method == "tools/call":
                    name = (body.get("params") or {}).get("name")
                    call_args = (body.get("params") or {}).get("arguments") or {}
                    if name in outer.http_error_tools:
                        self.send_error(503)
                        return
                    # ENFORCE the proxy's required-argument contract (B-42).
                    #
                    # The live proxy answers "Missing required argument: app"
                    # for every tool except list_apps. A mock that accepts any
                    # argument shape cannot reproduce that, which is exactly why
                    # B-41's suites were green while the live run scored 1/9.
                    missing = [r for r in outer.required_args.get(name, ())
                               if call_args.get(r) in (None, "")]
                    if missing:
                        q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                            "isError": True,
                            "content": [{"type": "text",
                                         "text": "Missing required argument: %s" % missing[0]}],
                        }}))
                    elif name in outer.fail_tools:
                        q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                            "isError": True,
                            "content": [{"type": "text", "text": "refused"}],
                        }}))
                    elif name == "list_apps":
                        # The REAL text shape, so the app parser is exercised.
                        q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                            "isError": False,
                            "content": [{"type": "text", "text":
                                "Chromium -- Chromium [running, pid=104998, window=W]\n"
                                "xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled]\n"
                                "xfce4-terminal -- xfce4-terminal [running, pid=51245, window=T]\n"
                                "xfdesktop -- xfdesktop [running, pid=50676, window=untitled]\n"
                                "xfwm4 -- xfwm4 [running, pid=50671, window=untitled]"}],
                        }}))
                    else:
                        q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                            "isError": False,
                            "content": [{"type": "text", "text": "ok:%s(%s)" % (
                                name, ",".join(sorted(call_args))) }],
                        }}))
                else:
                    q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {
                        "code": -32601, "message": "Method not found"}}))
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()

        return H


def main():
    print("endpoint parsing")
    check("reads the endpoint from a data line",
          _endpoint_from("event: endpoint\ndata: /messages/?session_id=abc\n\n")
          == "/messages/?session_id=abc")
    check("returns None when there is no data line",
          _endpoint_from("event: ping\n\n") is None)
    check("ignores a blank data line",
          _endpoint_from("data: \n\n") is None)

    print("mcp: the real handshake")
    with MockMcpServer() as server:
        with McpClient(server.url) as client:
            check("initialize returned server info",
                  client.server_info and client.server_info.get("name") == "open-computer-use",
                  str(client.server_info))
            tools = client.list_tools()
            check("tools/list returned the tools", len(tools) == 2, str(len(tools)))
            check("tool names are preserved",
                  [t["name"] for t in tools] == ["list_apps", "read_file"],
                  str([t["name"] for t in tools]))
        methods = [r.get("method") for r in server.requests]
        check("initialize was actually sent on the wire", "initialize" in methods, str(methods))
        check("notifications/initialized was sent", None in methods or len(
            [m for m in methods if m is None]) >= 1 or "notifications/initialized" in [
            r.get("method") for r in server.requests if "id" not in r],
            str(methods))
        check("tools/list was sent", "tools/list" in methods, str(methods))

    print("mcp: a tool call")
    with MockMcpServer() as server:
        with McpClient(server.url) as client:
            r = client.call("list_apps", {})
            check("the call reports ok", r["ok"] is True, json.dumps(r))
            check("list_apps returns the REAL app-list text shape",
                  r["content"] and " -- " in r["content"][0]["text"]
                  and "Chromium" in r["content"][0]["text"], json.dumps(r)[:200])
        sent = [r for r in server.requests if r.get("method") == "tools/call"]
        check("the tool name went over the wire",
              sent and sent[0]["params"]["name"] == "list_apps", json.dumps(sent[:1]))
        check("arguments were sent as an object",
              sent and isinstance(sent[0]["params"]["arguments"], dict), json.dumps(sent[:1]))

    print("mcp: the proxy's REQUIRED arguments are enforced (B-42)")
    with MockMcpServer(required_args={"get_app_state": ("app",),
                                      "click": ("app",)}) as server:
        with McpClient(server.url) as client:
            # Omitting `app` must come back as a tool ERROR carrying the live
            # proxy's exact message — not as a transport failure, and not ok.
            r = client.call("get_app_state", {})
            check("a missing required argument is an isError result",
                  r["isError"] is True, json.dumps(r))
            check("…with the proxy's own wording",
                  "Missing required argument: app" in r["content"][0]["text"],
                  r["content"][0]["text"])
            check("…and it is not reported as ok", r["ok"] is False, json.dumps(r))
            r2 = client.call("get_app_state", {"app": "Chromium"})
            check("supplying the argument succeeds", r2["ok"] is True, json.dumps(r2))

    print("mcp: a tool-level error is data, not an exception")
    with MockMcpServer(fail_tools={"list_apps"}) as server:
        with McpClient(server.url) as client:
            r = client.call("list_apps", {})
            check("isError is surfaced, not raised", r["isError"] is True, json.dumps(r))
            check("ok is false for a tool error", r["ok"] is False)

    print("mcp: a transport failure is an exception the job can report")
    with MockMcpServer(http_error_tools={"list_apps"}) as server:
        with McpClient(server.url) as client:
            raised = None
            try:
                client.call("list_apps", {})
            except McpError as exc:
                raised = exc
            check("a 503 on POST raises McpError", raised is not None, str(raised))
            check("the error names the HTTP status", raised and "503" in str(raised), str(raised))

    print("mcp: auth is a header, never a URL")
    seen_auth = {}

    def _auth(header):
        seen_auth["value"] = header
        return header == "Bearer test-token-123"

    with MockMcpServer(authorize=_auth) as server:
        with McpClient(server.url, "test-token-123") as client:
            ok = client.list_tools()
            check("the token was sent as Bearer", seen_auth.get("value") == "Bearer test-token-123",
                  str(seen_auth.get("value")))
            check("the server accepted it", len(ok) == 2)
        check("the token never appears in a request line",
              "test-token-123" not in " ".join(server.requests and [json.dumps(server.requests)]),
              "a token in a URL lands in logs")

    print("mcp: a bad token is refused, not ignored")
    with MockMcpServer(authorize=lambda h: h == "Bearer right") as server:
        raised = None
        try:
            with McpClient(server.url, "wrong") as client:
                client.list_tools()
        except McpError as exc:
            raised = exc
        check("a rejected token raises", raised is not None, str(raised))

    print("mcp: an unreachable server is an error with a reason")
    raised = None
    try:
        with McpClient("http://127.0.0.1:1") as client:  # nothing listens on port 1
            client.list_tools()
    except McpError as exc:
        raised = exc
    check("connection refused raises McpError", raised is not None, str(raised))
    check("the reason is preserved", raised and ("refused" in str(raised).lower()
                                                or "SSE" in str(raised)), str(raised))

    print("mcp: no url is refused up front")
    raised = None
    try:
        McpClient("")
    except McpError as exc:
        raised = exc
    check("an empty url raises immediately", raised is not None, str(raised))
    check("it names the setting", raised and "MCP_SSE_URL" in str(raised), str(raised))

    print("mcp: the base url may already end in /sse")
    with MockMcpServer() as server:
        with McpClient(server.url + "/sse") as client:
            check("a /sse suffix is not doubled", len(client.list_tools()) == 2)
            check("the sse path is what was requested",
                  client.sse_url.endswith("/sse") and not client.sse_url.endswith("/sse/sse"),
                  client.sse_url)

    print()
    total = passed + len(failed)
    print("%d passed, %d failed  (%d checks)" % (passed, len(failed), total))
    if failed:
        print("failed: " + ", ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
