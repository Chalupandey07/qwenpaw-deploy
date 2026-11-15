"""Minimal MCP client: SSE endpoint discovery + JSON-RPC over POST.

WHY THIS EXISTS AS ITS OWN FILE

The retired Cloudflare version of this pilot called MCP with a made-up shape —
`POST {MCP_SSE_URL}?tool=<name>` — which is not the protocol. It never ran
against a real proxy, so the bug was invisible: the harness mocked a loader,
the loader mocked the call, and nothing ever spoke to an MCP server.

This is the real thing, and it is written against the wire format that the
existing test runner already uses successfully against the machine's proxies
(`features/test-project/run-tests.py`, MCP_SCRIPT):

    1. GET  <base>/sse            -> text/event-stream
                                    first event carries `data: /messages/?session_id=...`
    2. POST <base><endpoint>      -> JSON-RPC request
                                    response arrives as an `event: message` on the
                                    SAME open SSE stream, correlated by `id`
    3. notifications get no response

Deliberately dependency-free (stdlib only): the machine is a 4 vCPU box and a
client library would be another thing to pin. `urllib` is enough for two calls.

Timeouts are explicit everywhere. A hung MCP proxy must become an error this
runner reports, not a hung job — the recorded failure mode in this repo is
"the agent worked around a broken dependency instead of raising it".
"""

from __future__ import annotations

import json
import queue
import threading
import urllib.error
import urllib.request

DEFAULT_TIMEOUT_S = 15.0


class McpError(Exception):
    """Any failure talking to the MCP proxy, with the cause preserved."""


class McpClient:
    """One connection to one MCP SSE endpoint.

    Not thread-safe by design: a fixed job is sequential, and making the client
    concurrent would hide ordering bugs in the steps it is measuring.
    """

    def __init__(self, base_url: str, token: str = "", timeout_s: float = DEFAULT_TIMEOUT_S):
        if not base_url:
            raise McpError("MCP_SSE_URL is not set")
        cleaned = base_url.rstrip("/")
        # `/sse` is the conventional path; accept a base that already ends in it.
        if cleaned.endswith("/sse"):
            self.sse_url = cleaned
            # The endpoint a proxy advertises is relative to the HOST ROOT
            # ("/messages/?session_id=..."), not to /sse. Posting to
            # "<base>/sse/messages/" 404s — which is exactly what the harness
            # caught: a client that works only when the caller omits /sse is a
            # client that fails on the URL people actually configure.
            self.base = cleaned[: -len("/sse")]
        else:
            self.sse_url = cleaned + "/sse"
            self.base = cleaned
        self.token = token or ""
        self.timeout_s = timeout_s
        self._events: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._endpoint: str | None = None
        self._next_id = 0
        self.server_info: dict | None = None

    # ---------------------------------------------------------------- headers
    def _headers(self, accept: str) -> dict:
        h = {"Accept": accept}
        if self.token:
            # Header only. A token in a URL lands in logs and Referer
            # (BUGS.md B-16/B-18), and this token reaches the desktop.
            h["Authorization"] = "Bearer " + self.token
        return h

    # ------------------------------------------------------------------ setup
    def __enter__(self) -> "McpClient":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> dict:
        """Open the SSE stream, learn the message endpoint, and initialize."""
        self._thread = threading.Thread(target=self._read_sse, daemon=True)
        self._thread.start()

        first = self._next_event(timeout=10.0)
        self._endpoint = _endpoint_from(first)
        if not self._endpoint:
            raise McpError("no message endpoint in the first SSE event: %r" % first[:200])

        init = self.rpc("initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "qwenpaw-codemode-vm", "version": "1.0"},
        })
        self.server_info = (init.get("result") or {}).get("serverInfo")
        self.notify("notifications/initialized")
        return init

    def close(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)

    # -------------------------------------------------------------------- sse
    def _read_sse(self) -> None:
        try:
            req = urllib.request.Request(
                self.sse_url, headers=self._headers("text/event-stream"))
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                buf = b""
                while not self._stop.is_set():
                    chunk = resp.read(1)
                    if not chunk:
                        break
                    buf += chunk
                    # Both terminators are real: proxies differ, and the
                    # existing runner accepts both for that reason.
                    if buf.endswith(b"\n\n") or buf.endswith(b"\r\n\r\n"):
                        self._events.put(buf.decode("utf-8", "replace"))
                        buf = b""
        except Exception as exc:  # noqa: BLE001 - reported, never swallowed
            self._events.put("__ERR__ " + str(exc))

    def _next_event(self, timeout: float) -> str:
        try:
            ev = self._events.get(timeout=timeout)
        except queue.Empty:
            raise McpError("timed out waiting for an SSE event")
        if ev.startswith("__ERR__"):
            raise McpError("SSE stream failed: " + ev[8:].strip())
        return ev

    # ------------------------------------------------------------------- rpc
    def _post(self, payload: dict) -> None:
        if self._endpoint is None:
            raise McpError("MCP client is not open")
        url = self.base + self._endpoint if self._endpoint.startswith("/") else self._endpoint
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={**self._headers("application/json, text/event-stream"),
                     "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                resp.read()
        except urllib.error.HTTPError as exc:
            raise McpError("MCP POST failed: HTTP %s" % exc.code)
        except Exception as exc:  # noqa: BLE001
            raise McpError("MCP POST failed: %s" % exc)

    def notify(self, method: str, params: dict | None = None) -> None:
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._post(payload)

    def rpc(self, method: str, params: dict) -> dict:
        self._next_id += 1
        mid = self._next_id
        self._post({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        # The response arrives on the SSE stream; anything else is skipped
        # rather than mistaken for this reply.
        deadline_hits = 0
        while deadline_hits < 100:
            ev = self._next_event(timeout=self.timeout_s)
            for line in ev.splitlines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                try:
                    data = json.loads(raw)
                except ValueError:
                    continue
                if data.get("id") == mid:
                    if "error" in data:
                        err = data["error"]
                        raise McpError("%s: %s" % (method, err.get("message", err)))
                    return data
            deadline_hits += 1
        raise McpError("no response to %s" % method)

    # ------------------------------------------------------------------ tools
    def list_tools(self) -> list:
        res = self.rpc("tools/list", {})
        return (res.get("result") or {}).get("tools") or []

    def call(self, name: str, arguments: dict | None = None) -> dict:
        """Call one tool. Returns the raw JSON-RPC result.

        An MCP tool error is NOT raised: it is a legitimate per-step outcome
        the job must record. Transport failures DO raise, because those mean
        the run cannot be trusted.
        """
        res = self.rpc("tools/call", {"name": name, "arguments": arguments or {}})
        result = res.get("result") or {}
        return {
            "ok": not bool(result.get("isError")),
            "content": result.get("content"),
            "isError": bool(result.get("isError")),
        }


def _endpoint_from(event: str) -> str | None:
    """Pull the message endpoint out of the first SSE event."""
    for line in event.splitlines():
        if line.startswith("data:"):
            value = line[5:].strip()
            if value:
                return value
    return None
