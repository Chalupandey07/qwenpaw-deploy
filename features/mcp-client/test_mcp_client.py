#!/usr/bin/env python3
"""Machine-free tests for the MCP client (T128).

Proves, against a LOCAL stdio mock MCP server (mock_mcp_server.py in
this directory, stdlib only) and a LOCAL streamable-HTTP mock server
(in-process, below), that features/mcp-client/mcp_client.py:

  (a) connects over stdio, lists tools, calls an allowlisted tool;
  (b) refuses a tool NOT on the allowlist, naming server + tool, and
      the server never receives that call (asserted from the mock's own
      call log, not just from the exception);
  (c) a server disabled by default is not connected until explicitly
      enabled (asserted from the mock's startup marker: no process was
      ever spawned);
  (d) tool names are namespaced mcp.<server>.<tool> — a server tool
      named "read" never shadows a built-in "read"; two servers with
      the same tool name are distinguished, and only the allowlisted
      one answers;
  (e) the HTTP transport refuses a target host not in the server's
      declared hosts before connecting (zero requests reach the
      listener), refuses redirects and userinfo tricks, and ignores
      HTTP_PROXY;
  (f) no auto-install happens: the client has no install entry point,
      spawns exactly the configured argv (monkeypatched Popen), and an
      unknown command raises instead of downloading anything.

Fail-first: run this before mcp_client.py exists and it reports
0 passed, 1 failed (ImportError). It also fails against a client
without the allowlist (b), without namespacing (d), or without the
egress check (e) — each section is independent.

Usage:
    python3 features/mcp-client/test_mcp_client.py
Prints "<N> passed, <M> failed" and exits 0 only when all pass.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    from mcp_client import (  # noqa: E402
        McpClient,
        McpDenied,
        McpDisabled,
        McpEgressError,
        McpError,
        McpRegistry,
        namespaced_name,
        parse_namespaced,
    )
    _IMPORT_ERROR = None
except Exception as exc:  # noqa: BLE001 - the failure IS check 1
    _IMPORT_ERROR = "%s: %s" % (type(exc).__name__, exc)

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def mock_config(tmp: Path, mode: str = "normal", name: str = "echo",
                allowed_tools=("echo", "read", "boom", "softfail"),
                enabled: bool = True, timeout_s: float = 10.0,
                env: dict | None = None) -> dict:
    """One stdio server declaration pointing at the local mock script."""
    marker = tmp / ("marker-%s-%s.txt" % (name, mode))
    log = tmp / ("log-%s-%s.txt" % (name, mode))
    return {
        "name": name,
        "enabled": enabled,
        "transport": "stdio",
        "command": [sys.executable, str(HERE / "mock_mcp_server.py"),
                    str(marker), str(log), mode],
        "allowed_tools": list(allowed_tools),
        "timeout_s": timeout_s,
        "env": env or {},
        "_marker": str(marker),
        "_log": str(log),
    }


def mock_paths(cfg: dict) -> tuple[Path, Path]:
    return Path(cfg["_marker"]), Path(cfg["_log"])


def log_lines(cfg: dict) -> list[str]:
    _, log = mock_paths(cfg)
    if not log.exists():
        return []
    return log.read_text(encoding="utf-8").splitlines()


# ---------------------------------------------------------------------------
# Streamable-HTTP mock server (in-process). POST /mcp takes JSON-RPC and
# answers either as plain JSON or as an SSE stream, per mode. Modes:
#   json     plain application/json response
#   sse      text/event-stream response, multi-line data join
#   session  returns Mcp-Session-Id on initialize, 404s any later request
#            without it (client must re-initialize and retry once)
#   redirect 302s to a second listener (which counts accepts)
# ---------------------------------------------------------------------------

class _HttpMock:
    def __init__(self, mode: str = "json", redirect_target: str | None = None):
        self.mode = mode
        self.redirect_target = redirect_target
        self.requests: list[dict] = []
        self.session_seen: list[str | None] = []
        self.accepts = 0
        self.expired_once = False
        self._server = None
        self._thread = None
        self.port = None

    def __enter__(self):
        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_POST(self):  # noqa: N802
                outer.accepts += 1
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append(body)
                outer.session_seen.append(self.headers.get("Mcp-Session-Id"))
                if outer.mode == "redirect":
                    self.send_response(302)
                    self.send_header("Location", outer.redirect_target)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                method = body.get("method")
                mid = body.get("id")
                if method == "initialize":
                    payload = {"jsonrpc": "2.0", "id": mid, "result": {
                        "protocolVersion": "2025-03-26", "capabilities": {},
                        "serverInfo": {"name": "mock-http", "version": "1.0"}}}
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    if outer.mode == "session":
                        self.send_header("Mcp-Session-Id", "sess-1")
                    raw = json.dumps(payload).encode()
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                if "id" not in body:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if outer.mode == "session":
                    # First id-bearing request after initialize is answered
                    # 404 (expired session) so the client must re-initialize
                    # and retry once; later requests need the session id.
                    if not getattr(outer, "expired_once", False):
                        outer.expired_once = True
                        raw = json.dumps({"jsonrpc": "2.0", "id": mid, "error": {
                            "code": -32000, "message": "session expired"}}).encode()
                        self.send_response(404)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(raw)))
                        self.end_headers()
                        self.wfile.write(raw)
                        return
                    if self.headers.get("Mcp-Session-Id") != "sess-1":
                        raw = json.dumps({"jsonrpc": "2.0", "id": mid, "error": {
                            "code": -32000, "message": "session expired"}}).encode()
                        self.send_response(404)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(raw)))
                        self.end_headers()
                        self.wfile.write(raw)
                        return
                if method == "tools/list":
                    payload = {"jsonrpc": "2.0", "id": mid, "result": {"tools": [
                        {"name": "echo", "description": "Echo text back"},
                        {"name": "read", "description": "Read a path"},
                    ]}}
                elif method == "tools/call":
                    name = (body.get("params") or {}).get("name")
                    args = (body.get("params") or {}).get("arguments") or {}
                    text = ("http-echo:%s" % args.get("text", "")
                            if name == "echo" else "http-read-ok:%s" % args.get("path", ""))
                    payload = {"jsonrpc": "2.0", "id": mid, "result": {
                        "isError": False,
                        "content": [{"type": "text", "text": text}]}}
                else:
                    payload = {"jsonrpc": "2.0", "id": mid, "error": {
                        "code": -32601, "message": "Method not found"}}
                raw = json.dumps(payload).encode()
                if outer.mode == "sse":
                    # Multi-line data: the client must join data: lines
                    # within one event, not split on blank lines naively.
                    half = len(raw) // 2
                    sse = ("event: message\ndata: %s\ndata: %s\n\n" % (
                        raw[:half].decode(), raw[half:].decode())).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(sse)))
                    self.end_headers()
                    self.wfile.write(sse)
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()

    @property
    def url(self):
        return "http://127.0.0.1:%d/mcp" % self.port


def main() -> int:
    if _IMPORT_ERROR is not None:
        print("  FAIL  mcp_client module loads (%s)" % _IMPORT_ERROR)
        print("\n0 passed, 1 failed")
        return 1
    check("mcp_client module loads", True)

    with tempfile.TemporaryDirectory() as tmpd:
        tmp = Path(tmpd)

        # --- (a) stdio: connect, list, call an allowlisted tool ---------
        print("stdio: connect / list / call")
        cfg = mock_config(tmp)
        reg = McpRegistry.from_dict({"servers": [cfg]})
        client = reg.connect("echo")
        check("stdio connect: server info name is mock-echo",
              client.server_info.get("name") == "mock-echo", str(client.server_info))
        check("stdio connect: protocol version recorded",
              client.protocol_version == "2025-03-26", str(client.protocol_version))
        tools = client.list_tools()
        check("stdio list: all advertised tools listed",
              [t["name"] for t in tools] == ["echo", "read", "secret_tool", "boom", "softfail"],
              str([t["name"] for t in tools]))
        r = reg.call("mcp.echo.echo", {"text": "hello"})
        check("stdio call: allowlisted echo returns its result",
              r["ok"] is True and r["content"][0]["text"] == "echo:hello", json.dumps(r))
        r = reg.call("mcp.echo.read", {"path": "/tmp/x"})
        check("stdio call: allowlisted read returns its result",
              r["ok"] is True and r["content"][0]["text"] == "read-ok:/tmp/x", json.dumps(r))
        lines = log_lines(cfg)
        check("protocol order: initialize, then notifications/initialized, then tools/list",
              lines.index("initialize") < lines.index("notifications/initialized")
              < lines.index("tools/list"), str(lines))
        # JSON-RPC error vs isError result must surface differently.
        raised = None
        try:
            reg.call("mcp.echo.boom", {})
        except McpError as exc:
            raised = exc
        check("JSON-RPC error raises McpError naming the failure",
              raised is not None and "boom failed" in str(raised), str(raised))
        r = reg.call("mcp.echo.softfail", {})
        check("isError result is data, not an exception (ok False)",
              r["ok"] is False and r["isError"] is True, json.dumps(r))
        reg.close_all()

        # --- (b) allowlist refusal --------------------------------------
        print("allowlist: refusal names server + tool, never sent")
        cfg_deny = mock_config(tmp, name="echo")
        reg = McpRegistry.from_dict({"servers": [cfg_deny]})
        reg.connect("echo")
        denied = None
        try:
            reg.call("mcp.echo.secret_tool", {})
        except McpDenied as exc:
            denied = exc
        check("non-allowlisted tool is refused",
              denied is not None, "no McpDenied raised")
        check("denial names the server and the tool",
              denied is not None and "echo" in str(denied) and "secret_tool" in str(denied),
              str(denied))
        # The mock's own log is the positive proof: the call never arrived.
        check("refused tool never reached the server (mock call log)",
              not any("secret_tool" in ln for ln in log_lines(cfg_deny)),
              "secret_tool in mock log")
        reg.close_all()

        # --- (c) disabled by default ------------------------------------
        print("disabled by default: no process spawned until enabled")
        cfg_off = mock_config(tmp, name="off", enabled=False)
        reg = McpRegistry.from_dict({"servers": [cfg_off]})
        check("server is disabled by default in the declaration",
              reg.servers["off"].enabled is False)
        raised = None
        try:
            reg.connect("off")
        except McpDisabled as exc:
            raised = exc
        check("connecting a disabled server raises McpDisabled",
              raised is not None and "off" in str(raised), str(raised))
        marker, _ = mock_paths(cfg_off)
        check("disabled server spawned no process (no marker file)",
              not marker.exists())
        reg.enable("off")
        client = reg.connect("off")
        check("after explicit enable, the server connects",
              client.server_info.get("name") == "mock-echo")
        reg.close_all()

        # --- (d) namespacing --------------------------------------------
        print("namespacing: mcp.<server>.<tool>, no shadowing")
        cfg_a = mock_config(tmp, name="echo")
        cfg_b = mock_config(tmp, name="echo2", allowed_tools=())
        reg = McpRegistry.from_dict({"servers": [cfg_a, cfg_b]})
        reg.connect("echo")
        reg.connect("echo2")
        check("namespaced name format is mcp.<server>.<tool>",
              namespaced_name("echo", "read") == "mcp.echo.read")
        check("parse keeps a dotted tool name verbatim",
              parse_namespaced("mcp.echo.a.b") == ("echo", "a.b"))
        names = reg.list_tools()
        check("registry list returns only allowlisted namespaced tools",
              names == ["mcp.echo.boom", "mcp.echo.echo", "mcp.echo.read",
                        "mcp.echo.softfail"], str(names))
        check("non-allowlisted secret_tool is hidden from the list",
              "mcp.echo.secret_tool" not in names)
        r = reg.call("mcp.echo.read", {"path": "/tmp/y"})
        check("same tool name on the allowlisted server answers",
              r["ok"] is True and r["content"][0]["text"] == "read-ok:/tmp/y", json.dumps(r))
        denied = None
        try:
            reg.call("mcp.echo2.read", {"path": "/tmp/y"})
        except McpDenied as exc:
            denied = exc
        check("same tool name on the other server is denied",
              denied is not None and "echo2" in str(denied) and "read" in str(denied),
              str(denied))
        for bad in ("read", "MCP.echo.read", "mcp.echo", "mcp..read", ""):
            raised = None
            try:
                reg.call(bad, {})
            except (McpDenied, McpError) as exc:
                raised = exc
            check("bare/malformed name %r is rejected" % bad, raised is not None, str(raised))
        reg.close_all()

        # --- config validation ------------------------------------------
        print("config validation: rejects bad declarations at load")
        for bad_cfg, why in [
            ({"servers": [{"name": "mcp", "enabled": True, "transport": "stdio",
                           "command": ["true"], "allowed_tools": []}]},
             "server named mcp"),
            ({"servers": [mock_config(tmp, name="dup"),
                          mock_config(tmp, name="dup")]}, "duplicate server names"),
            ({"servers": [dict(mock_config(tmp), allowed_tools=["*"])]},
             "wildcard allowlist"),
            ({"servers": [dict(mock_config(tmp), allowed_tools=[""])]},
             "empty allowlist entry"),
            ({"servers": [{"name": "web", "enabled": True, "transport": "http",
                           "url": "http://127.0.0.1:9/mcp",
                           "allowed_hosts": ["https://127.0.0.1"]}]},
             "allowed_hosts entry with a scheme"),
        ]:
            raised = None
            try:
                McpRegistry.from_dict(bad_cfg)
            except (ValueError, McpError) as exc:
                raised = exc
            check("config load rejects %s" % why, raised is not None, str(raised))

        # --- (f) no auto-install ----------------------------------------
        print("no auto-install: exact argv, unknown command raises")
        check("registry has no install entry point",
              not hasattr(McpRegistry, "install")
              and not hasattr(McpRegistry, "download")
              and not hasattr(McpRegistry, "auto_install"))
        seen_argv: list = []
        real_popen = subprocess.Popen

        class SpyPopen(real_popen):
            def __init__(self, args, **kw):
                seen_argv.append(list(args))
                super().__init__(args, **kw)

        subprocess.Popen = SpyPopen  # noqa: SIM118 - test-only monkeypatch
        try:
            cfg_spy = mock_config(tmp, name="spy")
            reg = McpRegistry.from_dict({"servers": [cfg_spy]})
            reg.connect("spy")
            reg.close_all()
        finally:
            subprocess.Popen = real_popen
        check("spawned argv is exactly the configured command (no shell, no extras)",
              seen_argv and seen_argv[0] == cfg_spy["command"], str(seen_argv))
        cfg_bad = mock_config(tmp, name="gone")
        cfg_bad["command"] = ["definitely-not-a-real-binary-xyz"]
        reg = McpRegistry.from_dict({"servers": [cfg_bad]})
        raised = None
        try:
            reg.connect("gone")
        except McpError as exc:
            raised = exc
        check("unknown command raises McpError (no download attempt)",
              raised is not None and "definitely-not-a-real-binary-xyz" in str(raised),
              str(raised))
        reg.close_all()

        # --- env isolation (stdio child gets only declared env) --------
        print("stdio env: only declared variables reach the child")
        sentinel = "MCP_PARENT_SENTINEL_VALUE"
        os.environ["MCP_PARENT_SENTINEL"] = sentinel
        try:
            cfg_env = mock_config(tmp, name="env", env={"MCP_MOCK_ONLY": "yes"})
            reg = McpRegistry.from_dict({"servers": [cfg_env]})
            reg.connect("env")
            reg.close_all()
            marker, _ = mock_paths(cfg_env)
            child_keys = json.loads(marker.read_text(encoding="utf-8").splitlines()[1])
            # CPython injects LC_CTYPE into a bare child env (PEP 538 locale
            # coercion); that is the interpreter, not a leak from the parent.
            check("child env holds only the declared variables (+ interpreter LC_CTYPE)",
                  set(child_keys) <= {"MCP_MOCK_ONLY", "LC_CTYPE"}
                  and "MCP_MOCK_ONLY" in child_keys, str(child_keys))
            check("parent-only sentinel never reaches the child",
                  "MCP_PARENT_SENTINEL" not in child_keys)
        finally:
            del os.environ["MCP_PARENT_SENTINEL"]

        # --- allowlist change requires reconnect -------------------------
        print("allowlist change: live connection does not silently widen")
        cfg_ch = mock_config(tmp, name="chg")
        reg = McpRegistry.from_dict({"servers": [cfg_ch]})
        reg.connect("chg")
        reg.servers["chg"].allowed_tools = ["echo"]  # narrowed after connect
        raised = None
        try:
            # "echo" IS on the new allowlist — but the live connection was
            # made under the old one, so the call must still refuse until
            # reconnect (a narrowing that denies outright is the other, also
            # correct, refusal path).
            reg.call("mcp.chg.echo", {"text": "x"})
        except McpError as exc:
            raised = exc
        check("a changed allowlist refuses the call until reconnect",
              raised is not None and "reconnect" in str(raised).lower(), str(raised))
        reg.close_all()

        # --- transport edge cases ---------------------------------------
        print("stdio edge cases: timeout, crash, stderr flood, ping, out-of-order")
        cfg_slow = mock_config(tmp, mode="slow", name="slow", timeout_s=2.0)
        reg = McpRegistry.from_dict({"servers": [cfg_slow]})
        client = reg.connect("slow")
        raised = None
        try:
            client.call_tool("echo", {"text": "x"})
        except McpError as exc:
            raised = exc
        check("a server that never replies times out",
              raised is not None and "timed out" in str(raised).lower(), str(raised))
        check("a timed-out connection is torn down (process gone)",
              client.transport.proc is None or client.transport.proc.poll() is not None)
        reg.close_all()

        cfg_crash = mock_config(tmp, mode="crash", name="crash", timeout_s=5.0)
        reg = McpRegistry.from_dict({"servers": [cfg_crash]})
        client = reg.connect("crash")
        raised = None
        try:
            client.call_tool("echo", {"text": "x"})
        except McpError as exc:
            raised = exc
        check("a server that crashes mid-call fails fast, no hang",
              raised is not None, str(raised))
        reg.close_all()

        cfg_flood = mock_config(tmp, mode="stderr-flood", name="flood")
        reg = McpRegistry.from_dict({"servers": [cfg_flood]})
        client = reg.connect("flood")
        r = client.call_tool("echo", {"text": "still-alive"})
        check("1 MB on stderr does not deadlock the child",
              r["ok"] is True and r["content"][0]["text"] == "echo:still-alive", json.dumps(r))
        reg.close_all()

        cfg_ping = mock_config(tmp, mode="ping", name="ping")
        reg = McpRegistry.from_dict({"servers": [cfg_ping]})
        client = reg.connect("ping")
        tools = client.list_tools()
        check("a colliding server ping is answered, list still returns",
              [t["name"] for t in tools][:2] == ["echo", "read"], str(tools))
        check("the ping answer reached the server (mock log)",
              any("response-to-server-request" in ln for ln in log_lines(cfg_ping)),
              str(log_lines(cfg_ping)))
        reg.close_all()

        cfg_ooo = mock_config(tmp, mode="out-of-order", name="ooo")
        reg = McpRegistry.from_dict({"servers": [cfg_ooo]})
        client = reg.connect("ooo")
        results: dict[str, dict] = {}

        def _call(key, text):
            results[key] = client.call_tool("echo", {"text": text})

        t1 = threading.Thread(target=_call, args=("a", "first"))
        t2 = threading.Thread(target=_call, args=("b", "second"))
        t1.start()
        time.sleep(0.3)
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)
        check("out-of-order replies are correlated by id, not arrival",
              results.get("a", {}).get("content", [{}])[0].get("text") == "echo:first"
              and results.get("b", {}).get("content", [{}])[0].get("text") == "echo:second",
              json.dumps(results))
        reg.close_all()

        # --- (e) streamable HTTP + egress -------------------------------
        print("streamable HTTP: connect / list / call, session, egress")
        with _HttpMock(mode="json") as http:
            reg = McpRegistry.from_dict({"servers": [{
                "name": "web", "enabled": True, "transport": "http",
                "url": http.url, "allowed_hosts": ["127.0.0.1"],
                "allowed_tools": ["echo", "read"], "timeout_s": 10.0}]})
            client = reg.connect("web")
            check("HTTP connect: server info name is mock-http",
                  client.server_info.get("name") == "mock-http", str(client.server_info))
            r = reg.call("mcp.web.echo", {"text": "hi"})
            check("HTTP call: allowlisted echo returns its result",
                  r["ok"] is True and r["content"][0]["text"] == "http-echo:hi", json.dumps(r))
            reg.close_all()

        with _HttpMock(mode="sse") as http:
            reg = McpRegistry.from_dict({"servers": [{
                "name": "web", "enabled": True, "transport": "http",
                "url": http.url, "allowed_hosts": ["127.0.0.1"],
                "allowed_tools": ["echo"], "timeout_s": 10.0}]})
            reg.connect("web")
            r = reg.call("mcp.web.echo", {"text": "sse"})
            check("HTTP SSE response (multi-line data) parses",
                  r["ok"] is True and r["content"][0]["text"] == "http-echo:sse", json.dumps(r))
            reg.close_all()

        with _HttpMock(mode="session") as http:
            reg = McpRegistry.from_dict({"servers": [{
                "name": "web", "enabled": True, "transport": "http",
                "url": http.url, "allowed_hosts": ["127.0.0.1"],
                "allowed_tools": ["echo"], "timeout_s": 10.0}]})
            reg.connect("web")
            r = reg.call("mcp.web.echo", {"text": "sess"})
            check("HTTP session id is echoed; a 404 re-initializes and retries",
                  r["ok"] is True and r["content"][0]["text"] == "http-echo:sess",
                  json.dumps(r))
            check("later HTTP requests carried the session id",
                  "sess-1" in http.session_seen, str(http.session_seen))
            reg.close_all()

        with _HttpMock(mode="json") as http:
            # (e) host not in allowed_hosts: refused BEFORE connecting.
            reg = McpRegistry.from_dict({"servers": [{
                "name": "web", "enabled": True, "transport": "http",
                "url": "http://localhost:%d/mcp" % http.port,
                "allowed_hosts": ["127.0.0.1"],
                "allowed_tools": ["echo"], "timeout_s": 10.0}]})
            raised = None
            try:
                reg.connect("web")
            except McpEgressError as exc:
                raised = exc
            check("undeclared host is refused before connecting",
                  raised is not None and "localhost" in str(raised), str(raised))
            check("zero requests reached the listener for the refused host",
                  http.accepts == 0, "accepts=%d" % http.accepts)
            # Userinfo trick: the real host is localhost, not 127.0.0.1.
            reg = McpRegistry.from_dict({"servers": [{
                "name": "web", "enabled": True, "transport": "http",
                "url": "http://127.0.0.1@localhost:%d/mcp" % http.port,
                "allowed_hosts": ["127.0.0.1"],
                "allowed_tools": ["echo"], "timeout_s": 10.0}]})
            raised = None
            try:
                reg.connect("web")
            except McpEgressError as exc:
                raised = exc
            check("userinfo-trick URL is refused on its real host",
                  raised is not None, str(raised))
            check("zero requests reached the listener for the trick URL",
                  http.accepts == 0, "accepts=%d" % http.accepts)
            # Private address, even declared, is refused unless loopback.
            reg = McpRegistry.from_dict({"servers": [{
                "name": "web", "enabled": True, "transport": "http",
                "url": "http://10.0.0.1:9/mcp",
                "allowed_hosts": ["10.0.0.1"],
                "allowed_tools": ["echo"], "timeout_s": 10.0}]})
            raised = None
            try:
                reg.connect("web")
            except McpEgressError as exc:
                raised = exc
            check("declared non-loopback private address is refused",
                  raised is not None and "10.0.0.1" in str(raised), str(raised))
            reg.close_all()

        with _HttpMock(mode="json") as second:
            with _HttpMock(mode="redirect",
                           redirect_target=second.url) as first:
                reg = McpRegistry.from_dict({"servers": [{
                    "name": "web", "enabled": True, "transport": "http",
                    "url": first.url, "allowed_hosts": ["127.0.0.1"],
                    "allowed_tools": ["echo"], "timeout_s": 10.0}]})
                raised = None
                try:
                    reg.connect("web")
                except McpError as exc:
                    raised = exc
                check("a redirect is refused, not followed",
                      raised is not None and "redirect" in str(raised).lower(), str(raised))
                check("zero requests reached the redirect target",
                      second.accepts == 0, "accepts=%d" % second.accepts)
                reg.close_all()

        with _HttpMock(mode="json") as http:
            os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
            os.environ["http_proxy"] = "http://127.0.0.1:9"
            try:
                reg = McpRegistry.from_dict({"servers": [{
                    "name": "web", "enabled": True, "transport": "http",
                    "url": http.url, "allowed_hosts": ["127.0.0.1"],
                    "allowed_tools": ["echo"], "timeout_s": 10.0}]})
                reg.connect("web")
                r = reg.call("mcp.web.echo", {"text": "noproxy"})
                check("HTTP_PROXY is ignored; the direct call still works",
                      r["ok"] is True and r["content"][0]["text"] == "http-echo:noproxy",
                      json.dumps(r))
                reg.close_all()
            finally:
                del os.environ["HTTP_PROXY"]
                del os.environ["http_proxy"]

        # --- example declaration loads, disabled by default ------------
        print("example declaration")
        example = json.loads((HERE / "servers.example.json").read_text(encoding="utf-8"))
        reg = McpRegistry.from_dict(example)
        check("servers.example.json loads",
              "echo" in reg.servers, str(list(reg.servers)))
        check("example server is disabled by default",
              reg.servers["echo"].enabled is False)
        check("example server declares a local stdio command only",
              reg.servers["echo"].transport == "stdio"
              and reg.servers["echo"].command[0] in ("python3", sys.executable)
              and "mock_mcp_server.py" in reg.servers["echo"].command[1])

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        print("failed: " + ", ".join(n for n, ok, _ in CHECKS if not ok))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
