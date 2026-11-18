# MCP client — stdio + streamable HTTP, per-server allowlist, namespaced tools

**Status: code complete + machine-free harness green (T128, 61/61).
NOT verified live — no machine deploy, no real MCP server, no browser
check. That half is the parent's job (Muse after sync).**

## What this is

A full MCP client for QwenPaw (gap #8 in the 2026-11-18 agent research:
MCP is the canonical extension surface in Goose, Claude Code and Codex;
skills are progressive disclosure). One real client buys hundreds of
integrations (GitHub, browser, files, calendars) without building each
one as a bespoke skill, and MCP servers are just subprocesses — it fits
a Free box.

## What already existed (not duplicated)

`features/codemode/vm/mcp.py` is a minimal **legacy SSE** client for the
machine's computer-use proxy (GET `/sse`, endpoint event, responses on
the stream). It has no allowlist, no namespacing, no stdio transport,
no streamable-HTTP transport, no egress check. This client does **not**
re-implement that SSE transport. A server that only speaks legacy SSE
stays on the codemode client. The JSON-RPC wire shape
(`initialize` → `notifications/initialized` → `tools/list` →
`tools/call`, `isError` as data, transport failures as exceptions) is
the same one the codemode client proved against the live proxy.

## Transports

| Transport | How it works | Notes |
|---|---|---|
| stdio | Spawns the declared command (`shell=False`, exact argv), newline-delimited JSON-RPC on stdin/stdout, reader thread + id correlation, stderr drained into a bounded ring | A timeout poisons the connection: all pending requests fail and the transport is torn down, so a late response can never match a recycled id. Concurrent calls are correlated by id (proven by the out-of-order test). |
| streamable HTTP | POST JSON-RPC, `Accept: application/json, text/event-stream`; response parsed as plain JSON or as an SSE stream (multi-line `data:` joined per event) | `Mcp-Session-Id` is echoed when the server returns one; a 404 with a live session re-initializes once and retries once. A 202 with an empty body is an error — this client holds no GET SSE stream, so a deferred response has nowhere to arrive. |

Protocol versions: requests `2025-03-26`, accepts `2024-11-05` too,
records the negotiated version, rejects anything else. `tools/list`
follows `nextCursor` pagination. A server→client request (a message
with a `method`, even one whose id collides with a pending client id)
is answered as a request: `ping` gets an empty result, anything else
gets `-32601`. A JSON-RPC error object raises `McpError`; a tool
`isError: true` result is data (`ok: false`), not an exception.

## Declaring / enabling a server

Servers live in a JSON config (`servers.example.json` in this directory
is the example). **Servers are DISABLED BY DEFAULT** — a server runs
only when the user explicitly enables it.

```json
{"servers": [{
  "name": "echo",
  "enabled": false,
  "transport": "stdio",
  "command": ["python3", "mock_mcp_server.py",
              "/tmp/mcp-echo-marker.txt", "/tmp/mcp-echo-log.txt", "normal"],
  "env": {},
  "allowed_tools": ["echo", "read"],
  "timeout_s": 15.0
}]}
```

```python
from mcp_client import McpRegistry
reg = McpRegistry.from_dict(json.load(open("servers.example.json")))
reg.enable("echo")          # explicit: nothing runs before this
reg.connect("echo")         # spawns / dials; raises McpDisabled if disabled
reg.call("mcp.echo.echo", {"text": "hello"})
reg.list_tools()            # ['mcp.echo.echo', 'mcp.echo.read']
reg.close_all()
```

An HTTP server declaration instead:

```json
{"name": "web", "enabled": false, "transport": "http",
 "url": "http://127.0.0.1:8080/mcp",
 "allowed_hosts": ["127.0.0.1"],
 "allowed_tools": ["echo"], "timeout_s": 15.0}
```

Rules enforced at config load (a bad declaration fails before any
process is spawned): name must match `[a-z0-9_-]+` and may not be
`mcp`; transport is `stdio` or `http`; duplicate server names are
rejected; unknown keys are rejected; `allowed_tools` entries must be
non-empty strings; `allowed_hosts` entries must be bare hostnames
(no scheme, port, path, userinfo, or `*`).

## Allowlist format

`allowed_tools` is a per-server list of exact tool names. Default is
`[]` — **no tools**. `"*"` is rejected at load; it can never match.
A tool not on the list is refused with `McpDenied` naming the server
AND the tool, before anything is sent to the server (the mock's own
call log proves the refused call never arrived). The allowlist is
re-checked on every call: if it changed since connect, the call is
refused until reconnect. `list_tools()` only ever returns allowlisted
tools — an advertised but unlisted tool is invisible to the agent.

## Namespacing rule

The agent only ever sees `mcp.<server>.<tool>`. The tool part is
everything after the second dot, verbatim — a server tool named `a.b`
parses as tool `a.b`, never split. Bare names (`read`), an uppercase
prefix (`MCP.echo.read`), and a missing tool are all rejected, so a
server tool named `read` can never shadow a built-in `read`, and two
servers with the same tool name are distinguished by the server part
(one allowlisted, one not — proven in the test).

## Egress rule

An MCP server gets **no network egress except its declared hosts**,
enforced for the HTTP transport by checking the target host against
`allowed_hosts` **before connecting**:

- exact hostname match (lowercased), `http`/`https` only; the real
  host is checked, so a userinfo trick (`http://127.0.0.1@localhost/`)
  is refused on `localhost`, not on the decoy;
- redirects are never followed (a 302 is a refusal, not a retry);
- environment proxies are ignored (`ProxyHandler({})` — a request
  through a proxy would never touch the allowlisted host);
- a resolved private / link-local / reserved / multicast address is
  refused, unless it is loopback (`127.0.0.0/8`, `::1`, `localhost`)
  that was explicitly declared — that is how local servers are used;
- TLS uses the default verified context only.

Two honest limits, stated plainly: the DNS check is point-in-time,
not IP pinning (pinning would need overriding `connect()` and redoing
TLS — out of scope); and a **stdio server is a local subprocess, so
the client cannot revoke its network** — the client grants it no
network credentials and no secrets (the child gets only the declared
`env` vars, never the parent's environment), but full network
sandboxing of a subprocess is gap #6, not this file.

## No auto-install

There is no install, download, or auto-install entry point anywhere
in this code. A stdio command is spawned exactly as declared (proven
by a monkeypatched `Popen` asserting argv equality); an unknown
command raises `McpError` and nothing is fetched as a fallback. The
user installs and declares servers; the client never downloads and
runs one on its own.

## Example server (no paid or remote server needed)

`mock_mcp_server.py` is the example: a local stdio echo/file server
(stdlib only) advertising `echo`, `read`, `secret_tool`, `boom`,
`softfail`. `servers.example.json` declares it with only `echo` and
`read` allowlisted and `enabled: false`. Run the harness to see it
work end to end:

```bash
python3 features/mcp-client/test_mcp_client.py   # 61 passed, 0 failed
```

## Test (T128)

`test_mcp_client.py` is the machine-free harness (registered as T128;
see `features/test-project/TESTS.md` and `run-tests.py`). It proves,
with the local stdio mock and an in-process streamable-HTTP mock:

- (a) stdio connect / list / call of an allowlisted tool, in protocol
  order (`initialize` → `notifications/initialized` → `tools/list`);
  JSON-RPC errors raise, `isError` results return `ok: false`;
- (b) a non-allowlisted tool is refused naming server + tool, and the
  mock's call log proves it never reached the server;
- (c) a disabled-by-default server spawns no process (no startup
  marker file) until explicitly enabled;
- (d) namespacing `mcp.<server>.<tool>`, bare/malformed names
  rejected, two servers with the same tool name distinguished;
- (e) HTTP refuses an undeclared host, a userinfo trick, and a
  declared non-loopback private address (zero requests reach the
  listener in each case), refuses redirects, ignores `HTTP_PROXY`,
  handles `Mcp-Session-Id` + 404 re-initialize, and parses SSE
  responses;
- (f) no auto-install: no install entry point, spawned argv is
  exactly the configured command, unknown command raises;
- plus transport edge cases the mock was built to catch: timeout
  tears the connection down, crash fails fast, 1 MB on stderr does
  not deadlock, a colliding server `ping` is answered, out-of-order
  replies correlate by id, config validation rejects `mcp` as a name,
  duplicates, `*`, and schemed `allowed_hosts` entries.

Fail-first proven: before `mcp_client.py` existed the harness
reported `0 passed, 1 failed` (`ModuleNotFoundError`); with it,
`61 passed, 0 failed`. Two failures found during development were
fixed in the test's expectations after checking the cause, not in the
client: CPython injects `LC_CTYPE` into a bare child env (PEP 538),
and narrowing an allowlist correctly denies the removed tool before
the reconnect check is reached (the reconnect check is now probed
with a tool that is still allowlisted).

## Design review

One DeepSeek call (`deepseek-v4.1-flash-free`, 1,111 prompt /
6,821 completion tokens) reviewed the design brief before
implementation. Adopted: parse-once/canonical-string allowlist
comparison, reject `*` and server name `mcp` at load, re-check
allowlist at call time, answer server `ping` requests, timeout
poisons the connection, drain stderr, `Mcp-Session-Id` + 404
re-initialize, no redirects, no env proxies, `urlsplit` hostname
check, bare-hostname validation at load, explicit-only child env,
mock-side positive proofs (call log, startup marker, TCP accepts),
two servers sharing a tool name, redirect and `HTTP_PROXY` cases,
out-of-order / crash / stderr-flood cases. Not adopted as out of
scope (recorded in the code): IP pinning / TOCTOU-proof DNS, and
network sandboxing of stdio subprocesses (gap #6).

## What is NOT verified live

- No real MCP server has been connected (only the local mocks).
- No machine deploy: nothing in this directory has been synced to
  the InstaBox box, and the client is not wired into QwenPaw's agent
  loop, skill pool, or console — that wiring is a separate step, and
  it must go through the registry (never a raw `McpClient`), or the
  allowlist is advisory only.
- No browser check: no console UI exists for enabling servers or
  viewing the allowlist yet.
- The legacy SSE computer-use proxy is untouched and stays on
  `features/codemode/vm/mcp.py`.
