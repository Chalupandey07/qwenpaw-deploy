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
# The live tree from run_1a1e8f3fd71 (2026-11-17), copied by hand from the
# recorded output — the mock's fixture, not the runner's constant. The mock
# IS the live proxy: one frame, no settable element, so the honest e2e
# outcome is 8 passed / 1 skipped (`set_value`).
LIVE_TREE = (
    "App=Chromium (pid 104998)\n"
    "Window: \"Today's Puzzle Answers (November 16, 2026) - Chromium\", App: Chromium.\n"
    "\t0 frame Today's Puzzle Answers (November 16, 2026) - Chromium "
    "Secondary Actions: doDefault, showContextMenu "
    "Frame: {x: 0, y: 0, width: 1920, height: 1004}"
)

# Roles that accept a value through the accessibility API (B-43). A frame
# has no AX value, so it is NOT settable.
_SETTABLE_ROLES = frozenset({
    "text field", "text box", "edit", "combo box", "spin button",
    "slider", "check box", "radio button",
})


def _parse_tree(tree_text):
    """Minimal tree parser for the mock — independent of the runner's.

    Returns {index: {"role": str, "actions": [str], "frame": {x,y,w,h}|None}}.
    Parses right-to-left (Frame, then Secondary Actions) so names may
    contain commas and the word "Frame:".
    """
    import re as _re
    frame_re = _re.compile(r"Frame:\s*\{\s*x:\s*(-?\d+),\s*y:\s*(-?\d+),"
                           r"\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}")
    sa_re = _re.compile(r"Secondary Actions:\s*(.*)$")
    out = {}
    for raw in str(tree_text or "").splitlines():
        body = raw.strip()
        m = _re.match(r"^(\d+)\s+(.*)$", body)
        if not m:
            continue
        idx, rest = int(m.group(1)), m.group(2)
        frame = None
        fm = frame_re.search(rest)
        if fm:
            frame = {"x": int(fm.group(1)), "y": int(fm.group(2)),
                     "w": int(fm.group(3)), "h": int(fm.group(4))}
            rest = rest[:fm.start()].rstrip()
        actions = []
        am = sa_re.search(rest)
        if am:
            actions = [a.strip() for a in am.group(1).split(",") if a.strip()]
            rest = rest[:am.start()].rstrip()
        # Role is the first word(s) before the name; the mock only needs the
        # role for the settable check, so a longest-first match over the
        # settable roles plus a "frame" fallback is enough.
        low = rest.lower()
        role = "frame" if low.startswith("frame") else None
        if role is None:
            for r in sorted(_SETTABLE_ROLES, key=len, reverse=True):
                if low == r or low.startswith(r + " "):
                    role = r
                    break
        out[idx] = {"role": role or low.split(" ", 1)[0],
                    "actions": actions, "frame": frame}
    return out


# A REAL MCP server: SSE discovery + JSON-RPC over POST, responses on the
# stream. Deliberately faithful, including the parts that are awkward.
# ---------------------------------------------------------------------------

class MockMcpServer:
    """Threaded HTTP server implementing the MCP SSE transport."""

    def __init__(self, *, tools=None, fail_tools=(), http_error_tools=(),
                 authorize=None, sse_headers=None, required_args=None,
                 tree=None, tool_params=None, direction_enum=None):
        self.tools = tools if tools is not None else [
            {"name": "list_apps", "description": "List windows"},
            {"name": "read_file", "description": "Read a file"},
        ]
        self.fail_tools = set(fail_tools)          # isError: true
        # The live proxy's required-argument contract (B-42). Empty by default
        # so transport tests are unaffected; the runner's e2e sets it.
        self.required_args = required_args or {}
        # The live proxy's declared props (B-43). Empty by default; the e2e
        # passes the runner's TOOL_PARAMS so unknown args are rejected.
        self.tool_params = tool_params or {}
        # The tree `get_app_state` returns (B-43). Default is the LIVE
        # frame-only tree — the mock IS the live proxy, so the e2e full run
        # honestly reports 8 passed / 1 skipped (`set_value`).
        self.tree = tree if tree is not None else LIVE_TREE
        self.elements = _parse_tree(self.tree)
        self.direction_enum = tuple(direction_enum or ("up", "down", "left", "right"))
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
                    # The success path, shared by every branch that passed
                    # enforcement: fail_tools refuse, list_apps returns the
                    # real listing, get_app_state returns the tree fixture,
                    # everything else returns a generic ok.
                    def _ok_or_fail():
                        if name in outer.fail_tools:
                            q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                                "isError": True,
                                "content": [{"type": "text", "text": "refused"}],
                            }}))
                        elif name == "list_apps":
                            q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                                "isError": False,
                                "content": [{"type": "text", "text":
                                    "Chromium -- Chromium [running, pid=104998, window=W]\n"
                                    "xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled]\n"
                                    "xfce4-terminal -- xfce4-terminal [running, pid=51245, window=T]\n"
                                    "xfdesktop -- xfdesktop [running, pid=50676, window=untitled]\n"
                                    "xfwm4 -- xfwm4 [running, pid=50671, window=untitled]"}],
                            }}))
                        elif name == "get_app_state":
                            q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                                "isError": False,
                                "content": [{"type": "text", "text": outer.tree}],
                            }}))
                        else:
                            q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                                "isError": False,
                                "content": [{"type": "text", "text": "ok:%s(%s)" % (
                                    name, ",".join(sorted(call_args))) }],
                            }}))

                    # ENFORCE the proxy's required-argument contract (B-42).
                    #
                    # The live proxy answers "Missing required argument: app"
                    # for every tool except list_apps. A mock that accepts any
                    # argument shape cannot reproduce that, which is exactly why
                    # B-41's suites were green while the live run scored 1/9.
                    #
                    # B-43: the mock also enforces the FULL schema — unknown
                    # arguments are rejected, and the semantic checks the
                    # live proxy applies (element in the tree, direction in
                    # the enum, settable role, valid action, coords in
                    # bounds) run against the mock's own tree fixture.
                    def _err(text):
                        q.put(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
                            "isError": True,
                            "content": [{"type": "text", "text": text}],
                        }}))

                    unknown = [k for k in sorted(call_args)
                               if outer.tool_params.get(name) is not None
                               and k not in outer.tool_params.get(name, {})]
                    if unknown:
                        _err("Unexpected argument: %s" % unknown[0])
                    else:
                        missing = [r for r in outer.required_args.get(name, ())
                                   if call_args.get(r) in (None, "")]
                        if missing:
                            _err("Missing required argument: %s" % missing[0])
                        elif name in ("scroll", "set_value",
                                      "perform_secondary_action", "click"):
                            ei = call_args.get("element_index")
                            el = outer.elements.get(int(ei)) if (
                                ei is not None and str(ei).lstrip("-").isdigit()
                            ) else None
                            if ei is not None and el is None:
                                _err("Invalid element_index: %s" % ei)
                            elif (name == "set_value" and el is not None
                                  and el["role"] not in _SETTABLE_ROLES):
                                _err("Element %s (%s) is not settable"
                                     % (ei, el["role"]))
                            elif (name == "perform_secondary_action"
                                  and el is not None
                                  and call_args.get("action") not in el["actions"]):
                                _err("Unknown action: %s for element %s"
                                     % (call_args.get("action"), ei))
                            elif (name == "scroll"
                                  and call_args.get("direction")
                                  not in outer.direction_enum):
                                _err("Invalid direction: %s. Must be one of: %s"
                                     % (call_args.get("direction"),
                                        ", ".join(outer.direction_enum)))
                            else:
                                _ok_or_fail()
                        elif name == "drag":
                            root = outer.elements.get(0)
                            frame = root.get("frame") if root else None
                            ok_coords = (
                                frame is not None
                                and all(isinstance(call_args.get(k), (int, float))
                                        for k in ("from_x", "from_y", "to_x", "to_y"))
                                and frame["x"] <= call_args["from_x"] <= frame["x"] + frame["w"]
                                and frame["x"] <= call_args["to_x"] <= frame["x"] + frame["w"]
                                and frame["y"] <= call_args["from_y"] <= frame["y"] + frame["h"]
                                and frame["y"] <= call_args["to_y"] <= frame["y"] + frame["h"])
                            if not ok_coords:
                                _err("Coordinates out of bounds")
                            else:
                                _ok_or_fail()
                        else:
                            _ok_or_fail()
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
