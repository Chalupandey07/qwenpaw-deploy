#!/usr/bin/env python3
"""MCP client with per-server allowlist + namespaced tools (gap #8).

What this is: a full MCP client (stdio + streamable HTTP, JSON-RPC 2.0,
protocol 2025-03-26 with 2024-11-05 accepted) that lets QwenPaw use any
existing MCP server — GitHub, browser, files, calendars — without
building each integration as a bespoke skill. Stdlib only; no new
dependency, no paid service, no download of anything.

What already existed (NOT duplicated here): features/codemode/vm/mcp.py
is a minimal SSE client for the machine's computer-use proxy (GET /sse,
endpoint event, responses on the stream). This client does NOT re-implement
that legacy SSE transport; it adds stdio and streamable HTTP, plus the
policy layer the codemode client never had (allowlist, namespacing,
egress). If a server only speaks legacy SSE, it stays on the codemode
client.

Policy (the point of this file — enforced in McpRegistry, not in the
transports, so a raw client can never be reached around the policy by
accident from agent code; agent code goes through the registry):

  * DISABLED BY DEFAULT. A server runs only when the user explicitly
    enables it (enabled: false in the declaration, enable(name) to turn
    it on). Connecting a disabled server raises McpDisabled and spawns
    nothing.
  * PER-SERVER ALLOWLIST. allowed_tools defaults to [] (none). A tool
    not on the list is refused with McpDenied naming the server AND the
    tool, and the refusal happens before anything is sent to the server.
    "*" is rejected at config load — it can never match. The allowlist
    is re-checked on every call: if it changed since connect, the call
    is refused until reconnect.
  * NAMESPACED TOOLS. The agent only ever sees mcp.<server>.<tool>.
    A server tool named "read" can never shadow a built-in "read": bare
    names are rejected, "MCP." (uppercase) is rejected, and a server may
    not be named "mcp". Tool names are compared exactly, verbatim
    (a tool may itself contain dots — "a.b" parses as tool "a.b").
  * EGRESS. An HTTP server gets no network except its declared hosts:
    the target host is checked against allowed_hosts (exact hostname
    match, http/https only, userinfo ignored — the real host is what is
    checked) BEFORE connecting, redirects are never followed, proxies
    from the environment are ignored, and a resolved private /
    link-local / reserved address is refused unless it is loopback that
    was explicitly declared. DNS is checked at connect time; that is a
    point-in-time check, not IP pinning (stated honestly — pinning would
    need overriding connect() and redoing TLS, out of scope).
  * NO AUTO-INSTALL. There is no install/download function in this
    file. A stdio server's command is spawned exactly as declared
    (shell=False, no appended arguments, only the declared env vars —
    never the parent's environment, so no proxy vars and no secrets
    leak into the child). An unknown command raises McpError; nothing
    is fetched as a fallback.
  * STDIO HONESTY. A stdio server is a local subprocess: the client
    grants it no network credentials, but it cannot revoke the
    subprocess's network either (no sandbox on this box). Full network
    sandboxing of a subprocess is gap #6, not this file. The README
    says so in plain language.

Protocol notes (from the design review, verified against the mock):
  * initialize -> notifications/initialized -> tools/list, in that
    order; tools/list follows nextCursor pagination.
  * A message with a "method" is a server->client REQUEST, never a
    response — even when its id collides with a pending client id.
    "ping" is answered with an empty result; anything else gets
    -32601. Ignoring a server request can block the server.
  * A request timeout poisons the connection: all pending requests
    fail and the transport is torn down, so a late response can never
    be correlated with a recycled id.
  * A tool error (isError: true) is DATA — call_tool returns ok=False.
    A JSON-RPC error object raises McpError. They are different, and
    the test asserts both.
  * Streamable HTTP: Mcp-Session-Id is echoed when the server returns
    one; a 404 on a request with a live session re-initializes once
    and retries once. A 202 with an empty body is an error here (this
    client does not hold a GET SSE stream, so a deferred response has
    nowhere to arrive).
  * stderr of a stdio server is drained into a bounded ring buffer;
    a chatty server cannot deadlock its own child by filling the pipe.

Usage:
    reg = McpRegistry.from_dict(json.load(open("servers.example.json")))
    reg.enable("echo")
    reg.connect("echo")
    reg.call("mcp.echo.echo", {"text": "hello"})
    reg.list_tools()   # ['mcp.echo.echo', 'mcp.echo.read']
"""

from __future__ import annotations

import ipaddress
import json
import queue
import re
import socket
import ssl
import subprocess
import threading
import urllib.error
import urllib.request
from collections import deque
from urllib.parse import urlsplit

SUPPORTED_PROTOCOL_VERSIONS = ("2025-03-26", "2024-11-05")
DEFAULT_PROTOCOL_VERSION = "2025-03-26"
DEFAULT_TIMEOUT_S = 15.0
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_HOST_RE = re.compile(r"^[a-z0-9._-]+$")
_REDIRECT_CODES = (301, 302, 303, 307, 308)


class McpError(Exception):
    """Any failure talking to an MCP server, with the cause preserved."""


class McpDenied(McpError):
    """A tool call refused by the per-server allowlist."""


class McpDisabled(McpError):
    """A server that is disabled (the default) was asked to connect."""


class McpEgressError(McpError):
    """An HTTP target outside the server's declared hosts."""


# ---------------------------------------------------------------------------
# Namespacing
# ---------------------------------------------------------------------------

def namespaced_name(server: str, tool: str) -> str:
    """The only name the agent ever sees for an MCP tool."""
    return "mcp.%s.%s" % (server, tool)


def parse_namespaced(name: str) -> tuple[str, str]:
    """Split "mcp.<server>.<tool>" — the tool is everything after the
    second dot, verbatim, so a tool named "a.b" survives intact.

    Raises McpError on anything that is not exactly that shape: a bare
    name ("read"), an uppercase prefix ("MCP.echo.read"), a missing
    tool, or a server name outside [a-z0-9_-].
    """
    if not isinstance(name, str) or not name.startswith("mcp."):
        raise McpError("not a namespaced MCP tool name: %r (expected mcp.<server>.<tool>)"
                       % (name,))
    rest = name[len("mcp."):]
    server, dot, tool = rest.partition(".")
    if not dot or not tool or not _NAME_RE.match(server):
        raise McpError("not a namespaced MCP tool name: %r (expected mcp.<server>.<tool>)"
                       % (name,))
    return server, tool


# ---------------------------------------------------------------------------
# Egress
# ---------------------------------------------------------------------------

def _validate_allowed_hosts(hosts) -> list[str]:
    """Bare hostnames only: no scheme, port, path, userinfo, or wildcard.
    Lowercased (DNS is case-insensitive); anything else fails at load
    so a malformed entry can never silently fail closed at call time.
    """
    if not isinstance(hosts, list) or not hosts:
        raise ValueError("allowed_hosts must be a non-empty list of bare hostnames")
    out = []
    for host in hosts:
        if (not isinstance(host, str) or not host or host == "*"
                or "://" in host or ":" in host or "/" in host or "@" in host
                or not _HOST_RE.match(host.lower())):
            raise ValueError("allowed_hosts entry is not a bare hostname: %r" % (host,))
        out.append(host.lower())
    return out


def check_http_egress(url: str, allowed_hosts: list[str]) -> str:
    """Check an HTTP target against a server's declared hosts, BEFORE
    any connection is opened. Returns the hostname. Raises
    McpEgressError naming the host on: wrong scheme, empty host, host
    not declared, unresolvable host, or a resolved address that is
    private / link-local / reserved / multicast / unspecified — unless
    the host is loopback (127.0.0.0/8, ::1, localhost) that was
    explicitly declared, which is how local test/dev servers are used.

    The check is point-in-time (DNS can resolve again later); it is not
    IP pinning. A declared host that resolves to a public address is
    allowed on any port and either scheme — the allowlist is host-only,
    and the README says so.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise McpEgressError("MCP HTTP target scheme must be http or https: %r" % (url,))
    host = (parts.hostname or "").lower()
    if not host:
        raise McpEgressError("MCP HTTP target has no host: %r" % (url,))
    allowed = [h.lower() for h in allowed_hosts]
    if host not in allowed:
        raise McpEgressError(
            "MCP HTTP host %r is not in this server's declared hosts %s"
            % (host, sorted(allowed)))
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise McpEgressError("MCP HTTP host %r cannot be resolved: %s" % (host, exc))
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            raise McpEgressError("MCP HTTP host %r resolved to an unparsable address" % host)
        if ip.is_loopback:
            continue
        if (ip.is_private or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            raise McpEgressError(
                "MCP HTTP host %r resolves to non-public address %s; refusing"
                % (host, ip))
    return host


# ---------------------------------------------------------------------------
# Transports (no policy here — the registry enforces it)
# ---------------------------------------------------------------------------

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """A redirect is never followed: a 302 to another host would sail
    past the pre-connect host check. Returning None makes urllib raise
    HTTPError, which the transport turns into a refusal, not a retry.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _build_opener() -> urllib.request.OpenerDirector:
    """No environment proxies (urllib honours http_proxy/https_proxy by
    default — a request through a proxy never touches the allowlisted
    host), no redirects, default TLS verification only."""
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _NoRedirectHandler(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )


class _StdioTransport:
    """One stdio MCP server: a subprocess speaking newline-delimited
    JSON-RPC. Thread-safe: concurrent requests are correlated by id
    through a pending map; one writer lock keeps lines from
    interleaving. stderr is drained into a bounded ring so a chatty
    server cannot deadlock its own child.
    """

    def __init__(self, command: list[str], env: dict, timeout_s: float):
        self.command = list(command)
        self.timeout_s = timeout_s
        self.proc: subprocess.Popen | None = None
        self._next_id = 0
        self._id_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending: dict[int, tuple[threading.Event, dict]] = {}
        self._pending_lock = threading.Lock()
        self._stderr_ring: deque[str] = deque(maxlen=50)
        self._closed = False
        try:
            self.proc = subprocess.Popen(
                self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, shell=False, env=dict(env))
        except FileNotFoundError as exc:
            raise McpError("MCP stdio command not found (nothing was "
                           "downloaded as a fallback): %s" % (self.command[0],)) from exc
        except OSError as exc:
            raise McpError("MCP stdio command failed to start %r: %s"
                           % (self.command, exc)) from exc
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._err_reader = threading.Thread(target=self._drain_stderr, daemon=True)
        self._err_reader.start()

    # ------------------------------------------------------------------ io
    def _read_loop(self) -> None:
        try:
            assert self.proc is not None and self.proc.stdout is not None
            for raw in self.proc.stdout:
                try:
                    msg = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                self._dispatch(msg)
        except Exception:  # noqa: BLE001 - EOF / closed stdout ends the loop
            pass
        finally:
            self._fail_all(McpError("MCP stdio server closed stdout"))

    def _drain_stderr(self) -> None:
        try:
            assert self.proc is not None and self.proc.stderr is not None
            while True:
                chunk = self.proc.stderr.read(8192)
                if not chunk:
                    break
                self._stderr_ring.append(chunk.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 - draining is best-effort
            pass

    def _dispatch(self, msg: dict) -> None:
        # A message with a method is a SERVER->client request, even when
        # its id collides with a pending client id. Check method first.
        if "method" in msg:
            mid = msg.get("id")
            if mid is not None:
                if msg["method"] == "ping":
                    self._send({"jsonrpc": "2.0", "id": mid, "result": {}})
                else:
                    self._send({"jsonrpc": "2.0", "id": mid, "error": {
                        "code": -32601, "message": "Method not found: %s"
                        % msg["method"]}})
            return
        mid = msg.get("id")
        if mid is None:
            return
        with self._pending_lock:
            slot = self._pending.pop(mid, None)
        if slot is not None:
            event, holder = slot
            holder["msg"] = msg
            event.set()

    def _send(self, obj: dict) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise McpError("MCP stdio server is not running")
        line = (json.dumps(obj) + "\n").encode()
        with self._write_lock:
            try:
                self.proc.stdin.write(line)
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise McpError("MCP stdio write failed: %s" % exc) from exc

    def _fail_all(self, err: Exception) -> None:
        with self._pending_lock:
            slots = list(self._pending.values())
            self._pending.clear()
        for event, holder in slots:
            holder["error"] = err
            event.set()

    # ------------------------------------------------------------------ rpc
    def request(self, method: str, params: dict, timeout: float | None = None) -> dict:
        with self._id_lock:
            self._next_id += 1
            mid = self._next_id
        event = threading.Event()
        holder: dict = {}
        with self._pending_lock:
            self._pending[mid] = (event, holder)
        self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        if not event.wait(timeout if timeout is not None else self.timeout_s):
            # A timeout poisons the connection: fail everything pending
            # and tear the transport down, so a late response can never
            # be correlated with a recycled id.
            self._fail_all(McpError("MCP request %r timed out" % method))
            self.close()
            raise McpError("MCP request %r timed out after %ss"
                           % (method, timeout if timeout is not None else self.timeout_s))
        if "error" in holder:
            raise holder["error"]
        msg = holder.get("msg") or {}
        if "error" in msg:
            err = msg["error"]
            raise McpError("%s: %s (code %s)" % (method, err.get("message", err),
                                                 err.get("code", "?")))
        return msg

    def notify(self, method: str, params: dict | None = None) -> None:
        payload: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            proc.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2.0)


class _HttpTransport:
    """One streamable-HTTP MCP server: POST JSON-RPC, response as plain
    JSON or as an SSE stream. Redirects are refused, environment
    proxies are ignored, and the host was already checked against the
    server's declared hosts before this object was built.
    """

    def __init__(self, url: str, allowed_hosts: list[str], timeout_s: float):
        check_http_egress(url, allowed_hosts)
        self.url = url
        self.timeout_s = timeout_s
        self.session_id: str | None = None
        self._opener = _build_opener()
        self._next_id = 0
        self._id_lock = threading.Lock()

    # ------------------------------------------------------------------ io
    def _post(self, payload: dict) -> tuple[int, dict, bytes]:
        headers = {"Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        req = urllib.request.Request(
            self.url, data=json.dumps(payload).encode(), method="POST",
            headers=headers)
        try:
            with self._opener.open(req, timeout=self.timeout_s) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code in _REDIRECT_CODES:
                raise McpError("MCP HTTP redirect refused: HTTP %s (redirects are "
                               "never followed)" % exc.code) from exc
            raise
        except urllib.error.URLError as exc:
            raise McpError("MCP HTTP request failed: %s" % exc) from exc

    @staticmethod
    def _media_type(content_type: str) -> str:
        return (content_type or "").split(";", 1)[0].strip().lower()

    def _parse_response(self, status: int, headers: dict, body: bytes,
                        mid: int) -> dict:
        """Find the JSON-RPC response with our id in a JSON body or an
        SSE stream (multi-line data: fields joined per event)."""
        ctype = self._media_type(headers.get("Content-Type", ""))
        if ctype == "text/event-stream":
            text = body.decode("utf-8", "replace")
            for event in text.split("\n\n"):
                data_parts = [ln[5:].strip() for ln in event.splitlines()
                              if ln.startswith("data:")]
                if not data_parts:
                    continue
                try:
                    msg = json.loads("\n".join(data_parts))
                except ValueError:
                    continue
                if isinstance(msg, dict) and msg.get("id") == mid:
                    return msg
            raise McpError("no SSE response with id %s" % mid)
        if not body:
            if status == 202:
                raise McpError("MCP HTTP server answered 202 with an empty body; "
                               "this client holds no GET SSE stream for a deferred "
                               "response")
            raise McpError("MCP HTTP server answered %s with an empty body" % status)
        try:
            msg = json.loads(body.decode("utf-8", "replace"))
        except ValueError as exc:
            raise McpError("MCP HTTP response is not JSON: %s" % exc) from exc
        if not isinstance(msg, dict) or msg.get("id") != mid:
            raise McpError("MCP HTTP response has no matching id")
        return msg

    def _initialize(self) -> dict:
        with self._id_lock:
            self._next_id += 1
            mid = self._next_id
        status, headers, body = self._post({
            "jsonrpc": "2.0", "id": mid, "method": "initialize",
            "params": {"protocolVersion": DEFAULT_PROTOCOL_VERSION,
                       "capabilities": {},
                       "clientInfo": {"name": "qwenpaw-mcp-client", "version": "1.0"}}})
        if status != 200:
            raise McpError("MCP initialize failed: HTTP %s" % status)
        new_session = headers.get("Mcp-Session-Id")
        if new_session:
            self.session_id = new_session
        msg = self._parse_response(status, headers, body, mid)
        if "error" in msg:
            err = msg["error"]
            raise McpError("initialize: %s" % err.get("message", err))
        return msg

    # ------------------------------------------------------------------ rpc
    def request(self, method: str, params: dict, _retried: bool = False) -> dict:
        with self._id_lock:
            self._next_id += 1
            mid = self._next_id
        try:
            status, headers, body = self._post({
                "jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        except urllib.error.HTTPError as exc:
            # A 404 with a live session means the session expired:
            # re-initialize once and retry the request once.
            if exc.code == 404 and self.session_id is not None and not _retried:
                self._initialize()
                return self.request(method, params, _retried=True)
            raise McpError("MCP HTTP request failed: HTTP %s" % exc.code) from exc
        if status == 404 and self.session_id is not None and not _retried:
            self._initialize()
            return self.request(method, params, _retried=True)
        if status != 200:
            raise McpError("MCP HTTP request failed: HTTP %s" % status)
        msg = self._parse_response(status, headers, body, mid)
        if "error" in msg:
            err = msg["error"]
            raise McpError("%s: %s (code %s)" % (method, err.get("message", err),
                                                 err.get("code", "?")))
        return msg

    def notify(self, method: str, params: dict | None = None) -> None:
        payload: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        try:
            status, _headers, _body = self._post(payload)
        except urllib.error.HTTPError as exc:
            raise McpError("MCP HTTP notification failed: HTTP %s" % exc.code) from exc
        if status not in (200, 202):
            raise McpError("MCP HTTP notification failed: HTTP %s" % status)

    def close(self) -> None:
        self.session_id = None


# ---------------------------------------------------------------------------
# One connection (transport + protocol), no policy
# ---------------------------------------------------------------------------

class McpClient:
    """One open MCP connection. Policy lives in McpRegistry; this class
    only speaks the protocol. Not thread-safe for list/call ordering
    beyond what the transport guarantees (stdio correlates by id, so
    concurrent calls are safe; HTTP is sequential per request).
    """

    def __init__(self, transport):
        self.transport = transport
        self.server_info: dict | None = None
        self.protocol_version: str | None = None

    def __enter__(self) -> "McpClient":
        return self.open()

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> "McpClient":
        """initialize, then notifications/initialized, in that order —
        a real server rejects tools/list sent before the notification."""
        if isinstance(self.transport, _HttpTransport):
            msg = self.transport._initialize()
        else:
            msg = self.transport.request("initialize", {
                "protocolVersion": DEFAULT_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "qwenpaw-mcp-client", "version": "1.0"}})
        result = msg.get("result") or {}
        version = result.get("protocolVersion")
        if version not in SUPPORTED_PROTOCOL_VERSIONS:
            raise McpError("MCP server protocol version %r is not supported "
                           "(supports %s)" % (version, ", ".join(SUPPORTED_PROTOCOL_VERSIONS)))
        self.protocol_version = version
        self.server_info = result.get("serverInfo")
        self.transport.notify("notifications/initialized")
        return self

    def close(self) -> None:
        self.transport.close()

    def list_tools(self) -> list:
        tools: list = []
        cursor = None
        while True:
            params: dict = {}
            if cursor:
                params["cursor"] = cursor
            msg = self.transport.request("tools/list", params)
            result = msg.get("result") or {}
            tools.extend(result.get("tools") or [])
            cursor = result.get("nextCursor")
            if not cursor:
                return tools

    def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        """Call one tool. A tool error is DATA (ok=False), not an
        exception; a transport or JSON-RPC error raises McpError."""
        msg = self.transport.request(
            "tools/call", {"name": name, "arguments": arguments or {}})
        result = msg.get("result") or {}
        return {"ok": not bool(result.get("isError")),
                "content": result.get("content"),
                "isError": bool(result.get("isError"))}


# ---------------------------------------------------------------------------
# Server declarations + the policy layer
# ---------------------------------------------------------------------------

class ServerConfig:
    """One declared MCP server. Validated at load so a bad declaration
    fails before any process is spawned or any connection opened."""

    def __init__(self, raw: dict):
        raw = {k: v for k, v in raw.items() if not k.startswith("_")}
        known = {"name", "enabled", "transport", "command", "env", "url",
                 "allowed_hosts", "allowed_tools", "timeout_s", "token"}
        unknown = sorted(set(raw) - known)
        if unknown:
            raise ValueError("unknown MCP server key(s): %s" % ", ".join(unknown))
        name = raw.get("name")
        if not isinstance(name, str) or not _NAME_RE.match(name):
            raise ValueError("MCP server name must match [a-z0-9_-]+: %r" % (name,))
        if name == "mcp":
            raise ValueError("MCP server may not be named 'mcp' (it would "
                             "collide with the mcp.<server>.<tool> prefix)")
        self.name = name
        self.enabled = bool(raw.get("enabled", False))
        self.transport = raw.get("transport")
        if self.transport not in ("stdio", "http"):
            raise ValueError("MCP server %r: transport must be 'stdio' or 'http'"
                             % name)
        self.timeout_s = float(raw.get("timeout_s", DEFAULT_TIMEOUT_S))
        if self.timeout_s <= 0:
            raise ValueError("MCP server %r: timeout_s must be positive" % name)
        tools = raw.get("allowed_tools", [])
        if (not isinstance(tools, list)
                or any(not isinstance(t, str) or not t for t in tools)
                or "*" in tools):
            raise ValueError("MCP server %r: allowed_tools must be a list of "
                             "non-empty tool names, never '*'" % name)
        self.allowed_tools: list[str] = list(tools)
        if self.transport == "stdio":
            cmd = raw.get("command")
            if (not isinstance(cmd, list) or not cmd
                    or any(not isinstance(c, str) or not c for c in cmd)):
                raise ValueError("MCP server %r: stdio needs a non-empty "
                                 "command list" % name)
            self.command: list[str] = list(cmd)
            env = raw.get("env", {})
            if not isinstance(env, dict) or any(
                    not isinstance(k, str) or not isinstance(v, str)
                    for k, v in env.items()):
                raise ValueError("MCP server %r: env must be a dict of strings"
                                 % name)
            self.env: dict = dict(env)
            self.url = ""
            self.allowed_hosts: list[str] = []
        else:
            url = raw.get("url")
            if not isinstance(url, str) or not url:
                raise ValueError("MCP server %r: http needs a url" % name)
            self.url = url
            self.allowed_hosts = _validate_allowed_hosts(raw.get("allowed_hosts"))
            self.command = []
            self.env = {}
        self.token = raw.get("token", "")

    def config_dict(self) -> dict:
        """The declaration as loaded (for tests / diagnostics)."""
        return {"name": self.name, "enabled": self.enabled,
                "transport": self.transport, "command": list(self.command),
                "url": self.url, "allowed_hosts": list(self.allowed_hosts),
                "allowed_tools": list(self.allowed_tools)}


class McpRegistry:
    """All declared MCP servers and the only way agent code may use
    them. There is deliberately no install/download/auto-install entry
    point anywhere on this class.
    """

    def __init__(self, servers: list[ServerConfig]):
        self.servers: dict[str, ServerConfig] = {}
        for cfg in servers:
            if cfg.name in self.servers:
                raise ValueError("duplicate MCP server name: %r" % cfg.name)
            self.servers[cfg.name] = cfg
        self._clients: dict[str, McpClient] = {}
        self._snapshots: dict[str, frozenset] = {}

    @classmethod
    def from_dict(cls, data: dict) -> "McpRegistry":
        if not isinstance(data, dict) or not isinstance(data.get("servers"), list):
            raise ValueError("MCP config must be an object with a 'servers' list")
        return cls([ServerConfig(raw) for raw in data["servers"]])

    @classmethod
    def from_file(cls, path: str) -> "McpRegistry":
        with open(path, encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))

    # ------------------------------------------------------------------ admin
    def enable(self, name: str) -> None:
        self._server(name).enabled = True

    def disable(self, name: str) -> None:
        cfg = self._server(name)
        cfg.enabled = False
        self._disconnect(name)

    def _server(self, name: str) -> ServerConfig:
        try:
            return self.servers[name]
        except KeyError as exc:
            raise McpError("unknown MCP server: %r" % (name,)) from exc

    # -------------------------------------------------------------- connect
    def connect(self, name: str) -> McpClient:
        """Connect to one server. Refuses a disabled server without
        spawning or dialing anything. Re-checks egress for HTTP."""
        cfg = self._server(name)
        if not cfg.enabled:
            raise McpDisabled(
                "MCP server %r is disabled (servers are disabled by default); "
                "enable it explicitly before connecting" % name)
        if name in self._clients:
            return self._clients[name]
        if cfg.transport == "stdio":
            transport = _StdioTransport(cfg.command, cfg.env, cfg.timeout_s)
        else:
            check_http_egress(cfg.url, cfg.allowed_hosts)
            transport = _HttpTransport(cfg.url, cfg.allowed_hosts, cfg.timeout_s)
        client = McpClient(transport).open()
        self._clients[name] = client
        self._snapshots[name] = frozenset(cfg.allowed_tools)
        return client

    def _disconnect(self, name: str) -> None:
        client = self._clients.pop(name, None)
        self._snapshots.pop(name, None)
        if client is not None:
            client.close()

    def close_all(self) -> None:
        for name in list(self._clients):
            self._disconnect(name)

    # ------------------------------------------------------------- tool use
    def call(self, namespaced: str, arguments: dict | None = None) -> dict:
        """Call mcp.<server>.<tool>. Enforces, in order: the name is
        namespaced, the server exists and is enabled, the tool is on
        that server's allowlist, the server is connected, and the
        allowlist has not changed since connect. A refusal names the
        server and the tool and sends nothing to the server."""
        server, tool = parse_namespaced(namespaced)
        cfg = self._server(server)
        if not cfg.enabled:
            raise McpDisabled("MCP server %r is disabled" % server)
        if tool not in cfg.allowed_tools:
            raise McpDenied(
                "MCP server %r refuses tool %r: it is not on that server's "
                "allowlist (allowed: %s)"
                % (server, tool, sorted(cfg.allowed_tools)))
        client = self._clients.get(server)
        if client is None:
            raise McpError("MCP server %r is not connected; call connect() first"
                           % server)
        if frozenset(cfg.allowed_tools) != self._snapshots.get(server):
            raise McpError(
                "MCP server %r allowlist changed since connect; reconnect "
                "to apply the new allowlist" % server)
        return client.call_tool(tool, arguments)

    def list_tools(self) -> list[str]:
        """Every allowlisted tool on every enabled, connected server,
        namespaced and sorted. A tool that is advertised but not
        allowlisted never appears here."""
        names = []
        for name, cfg in self.servers.items():
            client = self._clients.get(name)
            if client is None or not cfg.enabled:
                continue
            for tool in client.list_tools():
                tool_name = tool.get("name")
                if tool_name in cfg.allowed_tools:
                    names.append(namespaced_name(name, tool_name))
        return sorted(names)
