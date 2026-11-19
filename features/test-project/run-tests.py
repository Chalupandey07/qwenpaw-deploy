#!/usr/bin/env python3
"""QwenPaw test-project runner — runs the PROTOCOL tests in TESTS.md.

Usage:
  python3 run-tests.py                  run all protocol tests, record Round N
  python3 run-tests.py --only T01,T02   run only those tests
  python3 run-tests.py --area desktop   run only tests in an area (repeatable)
  python3 run-tests.py --list           print the catalogue, run nothing
  python3 run-tests.py --no-record      run without appending to RESULTS.md

Methods: protocol tests run here. browser / needs-token tests are reported
as NEEDS-BROWSER / NEEDS-TOKEN and never attempted. Results per test:
PASS / FAIL / KNOWN-GAP / NEEDS-VERIFICATION / NEEDS-BROWSER / NEEDS-TOKEN.

Access (all read-only except the tests that say so in TESTS.md):
  - public checks: urllib (stdlib) from this VM.
  - machine checks: ib.py exec (InstaBox machine m_agq5wqqo2fvypym7rjlpvngc2m).
    Never instabox2. Never touch auth.json or user chats. Never restart
    the container. Machine commands are read-only except T19/T20 (bridge
    navigates/opens — the test itself), T41/T42 (scratch export/import,
    cleaned up) and T49 (KV lease write, deleted in a finally).
  - Cloudflare reads: cf.py get (schedules). T49 also uses cf.py put-raw
    + delete for the KV lease write — see TESTS.md, it is NEEDS-VERIFICATION.
  - local checks: repo files + node harnesses. Stdlib only, plus curl where
    an HTTP upgrade is needed (urllib cannot do WebSocket handshakes).

No token or key is ever written to a file, a log, or RESULTS.md. The bridge
token (T19/T20) is read from the machine file inside the shell command and
never printed; only the JSON response (ok/title/url) is recorded.
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
RESULTS = TEST_DIR / "RESULTS.md"

MACHINE = "m_agq5wqqo2fvypym7rjlpvngc2m"
IB = Path.home() / "workspace/custom-connectors/custom.instabox/bin/ib.py"
CF = Path.home() / "workspace/custom-connectors/custom.cloudflare/bin/cf.py"
CF_ACCOUNT = "ca85fe3692c3f378200950999df9a35e"
D1_DB = "5f58a2f8-e4bb-45e5-8a94-4fc283b90871"  # qwenpaw-state (D1 is the lease store since 2026-11-15; KV is the fallback only)
DESKTOP_KV = "3eb38e6ebdce41f0a7ed744a99afee46"

PAGES = "https://qwenpawx.pages.dev"
PAGES_B = "https://qwenpaw-frontend.pages.dev"
KEEPALIVE = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev"
ROUTINES = "https://qwenpaw-routines.qwenpaw-rohan.workers.dev"
GROUPCHAT = "https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev"
BOARD = "https://qwenpaw-board.qwenpaw-rohan.workers.dev"
BOT = "https://qwenpaw-pages.pages.dev"

# ---------------------------------------------------------------- helpers

def one_line(s, limit=300):
    s = re.sub(r"\s+", " ", str(s)).strip()
    return s[:limit]


def http_get(url, timeout=30):
    """(status, body_text). curl-based, NOT urllib.

    Python urllib hits IncompleteRead / RemoteDisconnected on these
    Cloudflare responses in this environment (proven in Round 2: 9/9
    urllib fetches failed while curl got the full body every time on the
    same URLs). The edge sometimes sends Content-Length and closes early,
    sometimes sends a close-delimited body with no length at all; curl
    tolerates both, urllib raises. One retry on transport failure only;
    HTTP error codes are returned as-is, never retried.
    """
    for attempt in (1, 2, 3):
        rc, out, err = run_local(
            ["curl", "-s", "-S", "--max-time", str(timeout),
             "-w", "\n__HTTP_CODE__:%{http_code}", url],
            timeout=timeout + 30)
        if rc == 0 and "\n__HTTP_CODE__:" in out:
            body, _, code = out.rpartition("\n__HTTP_CODE__:")
            try:
                return int(code.strip()), body
            except ValueError:
                pass
        if attempt < 3:
            time.sleep(5)
    return 0, f"fetch error: curl rc={rc} err={one_line(err, 120)}"


def http_get_meta(url, timeout=30):
    """(status, body_text, headers). curl-based, same reason as http_get.

    Needed because some defects here are not visible in the status or the body:
    B-35 was `/vendor/xterm.js` answering **200 text/html** with the console
    SPA. A 200 is a 200, so only the Content-Type distinguishes "the module"
    from "46 KB of the wrong page".
    """
    for attempt in (1, 2, 3):
        rc, out, err = run_local(
            ["curl", "-s", "-S", "-D", "-", "--max-time", str(timeout),
             "-w", "\n__HTTP_CODE__:%{http_code}", url],
            timeout=timeout + 30)
        if rc == 0 and "\n__HTTP_CODE__:" in out:
            head_and_body, _, code = out.rpartition("\n__HTTP_CODE__:")
            # Split the header block from the body at the first blank line.
            # This VM's curl goes through a proxy, so -D - emits the proxy's
            # own "HTTP/1.1 200 Connection Established" block BEFORE the real
            # headers. Splitting at the first blank line would take the proxy
            # block as `head` (no Content-Type) and leave the real headers
            # prepended to `body` — which is exactly how T06 failed on
            # 2026-11-17 while the live file was fine (reported size 283,836
            # = 283,404 real bytes + 432 bytes of real header text).
            # Strip CONNECT blocks first; a real response is never one.
            rest = head_and_body
            while True:
                if "\r\n\r\n" in rest:
                    head, _, body = rest.partition("\r\n\r\n")
                elif "\n\n" in rest:
                    head, _, body = rest.partition("\n\n")
                else:
                    head, body = rest, ""
                    break
                first_line = head.split("\n", 1)[0]
                if "connection established" in first_line.lower():
                    rest = body
                    continue
                break
            headers = {}
            for line in head.replace("\r\n", "\n").split("\n"):
                if ":" in line:
                    k, _, v = line.partition(":")
                    headers[k.strip().lower()] = v.strip()
            try:
                return int(code.strip()), body, headers
            except ValueError:
                pass
        if attempt < 3:
            time.sleep(5)
    return 0, f"fetch error: curl rc={rc} err={one_line(err, 120)}", {}


def http_post_json(url, payload, timeout=30):
    """(status, body_text). curl-based, same reason as http_get."""
    data = json.dumps(payload)
    for attempt in (1, 2, 3):
        rc, out, err = run_local(
            ["curl", "-s", "-S", "--max-time", str(timeout),
             "-H", "Content-Type: application/json",
             "-H", "User-Agent: qwenpaw-test-runner/1.0",
             "-d", data, "-w", "\n__HTTP_CODE__:%{http_code}", url],
            timeout=timeout + 30)
        if rc == 0 and "\n__HTTP_CODE__:" in out:
            body, _, code = out.rpartition("\n__HTTP_CODE__:")
            try:
                return int(code.strip()), body
            except ValueError:
                pass
        if attempt < 3:
            time.sleep(5)
    return 0, f"fetch error: curl rc={rc} err={one_line(err, 120)}"


def run_local(argv, timeout=120):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "local command timed out"
    except Exception as e:
        return 1, "", str(e)


def ib_exec(cmd, timeout_s=90):
    """Run a shell command on the InstaBox machine via ib.py exec.

    Returns the parsed reply dict {stdout, stderr, exitCode, timedOut, ...}
    or {"_error": ...} if ib.py itself failed. The cmd string is sent as
    {"cmd": ..., "timeoutSeconds": ...} in a temp JSON file.
    """
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                     dir="/tmp") as f:
        json.dump({"cmd": cmd, "timeoutSeconds": timeout_s}, f)
        tmp = f.name
    try:
        rc, out, err = run_local(
            ["python3", str(IB), "exec", MACHINE, tmp],
            timeout=timeout_s + 120)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if rc != 0:
        return {"_error": f"ib.py exit {rc}: {one_line(err or out)}"}
    try:
        return json.loads(out)
    except Exception:
        return {"_error": f"ib.py output was not JSON: {one_line(out)}"}


def ib_stdout(cmd, timeout_s=90):
    """ib_exec wrapper returning (ok, stdout, stderr/exit info)."""
    r = ib_exec(cmd, timeout_s)
    if "_error" in r:
        return False, "", r["_error"]
    return True, r.get("stdout", ""), (
        f"exit={r.get('exitCode')} timedOut={r.get('timedOut')} "
        f"stderr={one_line(r.get('stderr', ''), 200)}")


def cf_get(path, timeout=60):
    rc, out, err = run_local(["python3", str(CF), "get", path], timeout=timeout)
    if rc != 0:
        return None, f"cf.py exit {rc}: {one_line(err or out)}"
    try:
        return json.loads(out), ""
    except Exception:
        return None, f"cf.py output was not JSON: {one_line(out)}"


def cf_cmd(argv, timeout=60):
    rc, out, err = run_local(["python3", str(CF)] + argv, timeout=timeout)
    if rc != 0:
        return None, f"cf.py exit {rc}: {one_line(err or out)}"
    try:
        return json.loads(out), ""
    except Exception:
        return None, f"cf.py output was not JSON: {one_line(out)}"


def repo_grep(pattern, relpath):
    rc, out, err = run_local(
        ["grep", "-n", pattern, str(REPO / relpath)], timeout=30)
    return rc, out, err


# ------------------------------------------------- embedded machine scripts
# (stdlib only; sent to the machine via heredoc. Raw strings so \n stays
# literal in the transmitted script.)

MCP_SCRIPT = r"""import json, queue, sys, threading, urllib.request

def mcp_check(port):
    base = "http://172.18.0.1:%d" % port
    events = queue.Queue(); stop = threading.Event()
    def read_sse():
        try:
            req = urllib.request.Request(base + "/sse", headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(req, timeout=20) as r:
                buf = b""
                while not stop.is_set():
                    chunk = r.read(1)
                    if not chunk:
                        break
                    buf += chunk
                    if buf.endswith(b"\n\n") or buf.endswith(b"\r\n\r\n"):
                        events.put(buf.decode("utf-8", "replace")); buf = b""
        except Exception as e:
            events.put("__ERR__ " + str(e))
    threading.Thread(target=read_sse, daemon=True).start()
    try:
        ev = events.get(timeout=10)
    except Exception:
        return {"port": port, "error": "no endpoint event"}
    endpoint = None
    for line in ev.splitlines():
        if line.startswith("data:"):
            endpoint = line[5:].strip()
    if not endpoint:
        return {"port": port, "error": "empty endpoint", "first_event": ev[:200]}
    def rpc(mid, method, params):
        body = json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}).encode()
        req = urllib.request.Request(base + endpoint, data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
            method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
        while True:
            ev = events.get(timeout=15)
            if ev.startswith("__ERR__"):
                raise RuntimeError(ev)
            for line in ev.splitlines():
                if line.startswith("data:"):
                    d = json.loads(line[5:].strip())
                    if d.get("id") == mid:
                        return d
    def notify(method):
        body = json.dumps({"jsonrpc": "2.0", "method": method}).encode()
        req = urllib.request.Request(base + endpoint, data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
            method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
    try:
        init = rpc(1, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                      "clientInfo": {"name": "test-runner", "version": "1.0"}})
        notify("notifications/initialized")
        tools = rpc(2, "tools/list", {})
        names = [x.get("name") for x in tools.get("result", {}).get("tools", [])]
        call = rpc(3, "tools/call", {"name": "list_apps", "arguments": {}})
        stop.set()
        return {"port": port, "server": init.get("result", {}).get("serverInfo"),
                "tools": names, "list_apps": call.get("result", call.get("error"))}
    except Exception as e:
        stop.set()
        return {"port": port, "error": str(e)}

print(json.dumps(mcp_check(int(sys.argv[1]))))
"""

WS_ECHO_SCRIPT = r"""import base64, json, os, socket, struct

def ws_echo():
    key = base64.b64encode(os.urandom(16)).decode()
    s = socket.create_connection(("127.0.0.1", 6083), timeout=10)
    s.sendall(("GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:6083\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += s.recv(4096)
    status = resp.split(b"\r\n", 1)[0].decode(errors="replace")
    payload = b"\x00" + struct.pack(">I", len(b"echo hello-terminal\n")) + b"echo hello-terminal\n"
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    frame = bytes([0x82, 0x80 | len(payload)]) + mask + masked
    s.settimeout(10)
    s.sendall(frame)
    out = b""
    try:
        while b"hello-terminal" not in out:
            chunk = s.recv(4096)
            if not chunk:
                break
            out += chunk
            if len(out) > 200000:
                break
    except socket.timeout:
        pass
    s.close()
    return {"ws_status": status, "echo_found": b"hello-terminal" in out, "bytes_read": len(out)}

print(json.dumps(ws_echo()))
"""

PNG_MEAN_SCRIPT = r"""import json, struct, sys, zlib

def png_mean(p):
    d = open(p, "rb").read()
    pos = 8; w = h = bd = ct = None; idat = b""
    while pos < len(d):
        ln = struct.unpack(">I", d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]; dat = d[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", dat[:10])
        if typ == b"IDAT":
            idat += dat
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = {2: 3, 6: 4, 0: 1}[ct]; stride = w * ch
    prev = bytearray(stride); tot = 0; n = 0; off = 0
    for _y in range(h):
        f = raw[off]; line = bytearray(raw[off + 1:off + 1 + stride]); off += 1 + stride
        for i in range(len(line)):
            a = line[i - ch] if i >= ch else 0
            b = prev[i]; c = prev[i - ch] if i >= ch else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                pp = a + b - c; pa = abs(pp - a); pb = abs(pp - b); pc = abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        prev = line; tot += sum(line); n += len(line)
    return {"size": [w, h], "mean_luminance": round(tot / n, 2)}

print(json.dumps({sys.argv[1]: png_mean(sys.argv[1]), sys.argv[2]: png_mean(sys.argv[2])}))
"""


def machine_python(script, args, timeout_s=90):
    """Send a Python script to the machine via heredoc, run it, parse its
    one-line JSON output. Returns (ok, dict_or_error_string)."""
    cmd = ("cat > /tmp/tp-probe.py <<'PYEOF'\n" + script + "\nPYEOF\n"
           "python3 /tmp/tp-probe.py " + " ".join(args))
    ok, out, info = ib_stdout(cmd, timeout_s)
    if not ok:
        return False, info
    for line in reversed(out.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return True, json.loads(line)
            except Exception:
                continue
    return False, f"no JSON output; stdout tail: {one_line(out, 200)} info={info}"


def mcp_list_apps(port):
    """Full MCP client run against one proxy port. Returns (ok, result)."""
    return machine_python(MCP_SCRIPT, [str(port)], timeout_s=90)


def approval_pending_count():
    ok, out, info = ib_stdout(
        'grep -c "Generic approval pending created" '
        "/data/home/qwenpaw/working/qwenpaw.log", 60)
    if not ok:
        return None, info
    try:
        return int(out.strip().splitlines()[-1]), ""
    except Exception:
        return None, f"unparsable count output: {one_line(out)}"


def skills_list():
    """(ok, rows_text, showing_line). One docker exec, reused by T31/T32."""
    ok, out, info = ib_stdout(
        "docker exec qwenpaw qwenpaw skills list 2>&1", 120)
    if not ok:
        return False, "", info
    showing = ""
    for line in out.splitlines():
        if "Showing:" in line:
            showing = line.strip()
    return True, out, showing

# ------------------------------------------------------------------- tests
# Each test returns (status, evidence). Status: PASS / FAIL / KNOWN-GAP /
# NEEDS-VERIFICATION. browser / needs-token tests are not functions here —
# they are listed in the registry with their method and skipped at runtime.

def t01():
    code, body = http_get(PAGES + "/", timeout=120)
    markers = sorted(set(re.findall(r"qwenpaw(?:Computer(?:Btn|Panel)|VaultBtn)", body)))
    vcode, vbody = http_get(PAGES + "/vault", timeout=120)
    ok = code == 200 and "<title>QwenPaw Console</title>" in body \
        and "qwenpawComputerBtn" in markers and "qwenpawComputerPanel" in markers \
        and "qwenpawVaultBtn" in markers \
        and "data-qwenpaw-vault-menu" in body \
        and "data-qwenpaw-vault-popup" in body \
        and "qwenpawVaultPopupProvider" in body \
        and vcode == 200 and "fProvider" in vbody
    return ("PASS" if ok else "FAIL",
            f"HTTP {code} size={len(body)} markers={markers} vaultmenu={'data-qwenpaw-vault-menu' in body} vaultpopup={'data-qwenpaw-vault-popup' in body} vaultprovider={'qwenpawVaultPopupProvider' in body} vaultpage={vcode} vaultpageprovider={'fProvider' in vbody}")


def t02():
    code, body = http_get(PAGES + "/status", timeout=120)
    ok = code == 200 and "QwenPaw — Status" in body
    return ("PASS" if ok else "FAIL",
            f"HTTP {code} size={len(body)} title={'QwenPaw — Status' in body}")


def t03():
    code, body = http_get(PAGES + "/api/auth/status", timeout=120)
    try:
        data = json.loads(body)
    except Exception:
        data = None
    ok = code == 200 and data == {"enabled": True, "has_users": True}
    return ("PASS" if ok else "FAIL", f"HTTP {code} body={one_line(body, 120)}")


def t04():
    """The /computer surface refuses an anonymous caller (P0, 2026-11-16).

    This test used to assert the OLD `/desktop` gate page's copy ("Opening the
    desktop" / "Checking your QwenPaw login"). That surface was deleted in the
    2026-11-15 rebuild, so the test had been failing against a page that no
    longer exists — a red row nobody could act on, which is its own hazard.

    It now asserts the thing that actually matters on the replacement surface,
    live, from outside: `/computer/state` must NOT hand a visitor the desktop's
    state. Before 2026-11-16 it answered 200 with the live mode, generation,
    lease holder and preview hash to anyone on the internet.
    """
    code, body = http_get(PAGES + "/computer/state?computer=default", timeout=60)
    if code == 503:
        # No session secret configured on the project: a deploy error, and the
        # Worker says so explicitly rather than looping the user through a
        # sign-in that cannot succeed.
        return ("FAIL", f"HTTP 503 — COMPUTER_SESSION_SECRET/CAPABILITY_SECRET unset: {one_line(body, 120)}")
    has_auth = "auth_required" in body
    ok = code == 401 and has_auth
    leaked = any(k in body for k in ('"leaseId"', '"generation"', '"preview"'))
    return ("PASS" if ok and not leaked else "FAIL",
            f"HTTP {code} auth_required={has_auth} leaked_state={leaked}")


def t05():
    """Two things a visitor must never be able to do: mint, or take control.

    Was `/desktop/__lease` (deleted surface). The live equivalents are the two
    endpoints that hand out authority, and both are checked anonymously here:

      * `POST /computer/takeover` — a 200 would be a stranger seizing the
        desktop. Verified live before the 2026-11-16 fix: it returned a real
        leaseId to curl.
      * `GET  /computer/session`  — a 200 would be a screen capability. The
        same probe returned `{"ok":true,"policy":"control"}`.

    The store is NOT touched by either assertion when the gate works, so this
    is safe to run on a live deployment.
    """
    code, body = http_post_json(PAGES + "/computer/takeover",
                                {"computer": "default"}, timeout=30)
    t_ok = code in (401, 405) and "leaseId" not in body
    code2, body2 = http_get(PAGES + "/computer/session?computer=default", timeout=30)
    s_ok = code2 in (401, 405) and '"policy"' not in body2
    ok = t_ok and s_ok
    return ("PASS" if ok else "FAIL",
            f"takeover HTTP {code} lease={'leaseId' in body}; "
            f"session HTTP {code2} policy={'policy' in body2}")


def t06():
    """xterm.js is served as JAVASCRIPT, not as the console SPA (B-35).

    Was `/desktop/vendor/xterm.js` (deleted surface). The live path is
    `/vendor/xterm.js`, and the defect this guards is specific and silent: an
    unrouted path fell through to the console proxy, which answered 200
    `text/html` with 45,989 bytes of the SPA. A `<script src>` answered with
    HTML parses as nothing — no onerror, no console line — so `window.Terminal`
    stayed undefined and the terminal pane was black while the session showed
    "connected". HTTP 200 is 200.

    So this asserts the CONTENT TYPE and the byte count, not just the status.
    """
    code, body, meta = http_get_meta(PAGES + "/vendor/xterm.js", timeout=60)
    ctype = (meta.get("content-type") or "").lower()
    ok = (code == 200 and "javascript" in ctype and len(body) > 100000
          and "xterm" in body.lower() and "<!doctype html>" not in body[:200].lower())
    return ("PASS" if ok else "FAIL",
            f"HTTP {code} type={ctype or '?'} size={len(body)}")


def t07():
    lines = []
    for p in (6081, 6082, 6083, 6084, 6085):
        lines.append(
            f'for p in {p}; do printf "%s GET " $p; '
            f'curl -s -o /dev/null -w "%{{http_code}}" --max-time 5 http://127.0.0.1:$p/; '
            f'printf " WS "; curl -s -i -N --max-time 2 -H "Connection: Upgrade" '
            f'-H "Upgrade: websocket" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" '
            f'-H "Sec-WebSocket-Version: 13" http://127.0.0.1:$p/websockify '
            f'2>/dev/null | head -n 1; echo; done')
    # The loop above is written per-port (no shell loop var reuse issues).
    # Join with "; " — a bare space after `done` is a shell syntax error
    # (`done for p in ...`); proven in Round 2 (T07 FAIL, empty output).
    cmd = "; ".join(lines)
    ok, out, info = ib_stdout(cmd, 90)
    if not ok:
        return "FAIL", info
    good = out.count("GET 200") == 5 and out.count("101 Switching Protocols") == 5
    return ("PASS" if good else "FAIL", one_line(out, 300))


def t08():
    services = ("desktop-xvfb-qa desktop-dbus-qa desktop-wm-qa desktop-vnc-view "
                "desktop-novnc-view desktop-vnc-qa-view desktop-novnc-qa-view "
                "desktop-novnc-qa desktop-vnc-qa mcp-computer-use "
                "mcp-computer-use-qa desktop-terminal desktop-terminal-ws "
                "desktop-lease-watcher desktop-window-watch desktop-chromium "
                "camoufox-bridge")
    ok, out, info = ib_stdout(f"systemctl is-active {services}", 60)
    if not ok:
        return "FAIL", info
    states = [s.strip() for s in out.strip().splitlines() if s.strip()]
    good = len(states) == 17 and all(s == "active" for s in states)
    bad = [f"{n}={s}" for n, s in zip(services.split(), states) if s != "active"]
    return ("PASS" if good else "FAIL",
            f"{sum(1 for s in states if s == 'active')}/17 active"
            + (f" bad: {bad}" if bad else ""))


def t09():
    ok, res = machine_python(WS_ECHO_SCRIPT, [], timeout_s=60)
    if not ok:
        return "FAIL", str(res)
    good = res.get("ws_status", "").startswith("HTTP/1.1 101") \
        and res.get("echo_found") is True
    return ("PASS" if good else "FAIL",
            f"ws_status={res.get('ws_status')} echo_found={res.get('echo_found')} "
            f"bytes_read={res.get('bytes_read')}")


def _mcp_expect(port, must_contain, must_not_contain):
    ok, res = mcp_list_apps(port)
    if not ok:
        return "FAIL", str(res)
    if res.get("error"):
        return "FAIL", f"port {port}: {one_line(res['error'])}"
    server = res.get("server") or {}
    tools = res.get("tools") or []
    call = res.get("list_apps") or {}
    text = ""
    try:
        content = call.get("content", [])
        text = content[0].get("text", "") if content else ""
    except Exception:
        text = str(call)[:400]
    good_server = server.get("name") == "open-computer-use" \
        and server.get("version") == "1.1.4"
    good_tools = set(tools) == {"click", "drag", "get_app_state", "list_apps",
                                "perform_secondary_action", "press_key",
                                "scroll", "set_value", "type_text"}
    good_apps = all(x in text for x in must_contain) \
        and not any(x in text for x in must_not_contain) \
        and call.get("isError") is False
    good = good_server and good_tools and good_apps
    return ("PASS" if good else "FAIL",
            f"server={server} tools={len(tools)} "
            f"list_apps={one_line(text, 220)}")


def t10():
    ok, out, info = ib_stdout(
        "curl -s -o /dev/null -w \"8898 %{http_code}\\n\" --max-time 4 "
        "http://172.18.0.1:8898/sse; "
        "curl -s -o /dev/null -w \"8897 %{http_code}\\n\" --max-time 4 "
        "http://172.18.0.1:8897/sse", 60)
    if not ok:
        return "FAIL", info
    good = "8898 200" in out and "8897 200" in out
    return ("PASS" if good else "FAIL", one_line(out, 120))


def t11():
    return _mcp_expect(8898, ["Chromium", "xfce4-panel", "xfdesktop", "xfwm4"],
                       ["pid=111374"])


def t12():
    return _mcp_expect(8897, ["Chromium", "xfwm4"],
                       ["xfce4-panel", "xfdesktop", "pid=104998"])


def t13():
    code1, body1 = http_post_json(PAGES + "/desktop/__teach", {}, timeout=30)
    code2, body2 = http_get(PAGES + "/desktop/__pending-skills", timeout=30)
    ok = code1 == 200 and "Opening the desktop" in body1 \
        and code2 == 401 and "unauthorized" in body2
    return ("PASS" if ok else "FAIL",
            f"__teach HTTP {code1} gate={'Opening the desktop' in body1}; "
            f"__pending-skills HTTP {code2} body={one_line(body2, 100)}")


def t14():
    code1, body1 = http_post_json(PAGES + "/desktop/__needs-you", {}, timeout=30)
    code2, body2 = http_get(PAGES + "/desktop/__needs-you", timeout=30)
    ok = code1 == 401 and "unauthorized" in body1 \
        and code2 == 200 and "Opening the desktop" in body2
    return ("PASS" if ok else "FAIL",
            f"POST __needs-you HTTP {code1} body={one_line(body1, 100)}; "
            f"GET __needs-you HTTP {code2} gate={'Opening the desktop' in body2}")


def t15():
    _, body = http_get(PAGES + "/", timeout=120)
    markers = sorted(set(re.findall(r"qwenpawComputer(?:Btn|Panel)", body)))
    rc, out, _ = repo_grep("consolePanelScript", "pages/public/_worker.js")
    rc2, out2, _ = repo_grep("316px", "pages/public/_worker.js")
    ok = "qwenpawComputerBtn" in markers \
        and "qwenpawComputerPanel" in markers \
        and rc == 0 and rc2 == 0
    return ("PASS" if ok else "FAIL",
            f"live markers={markers}; _worker.js consolePanelScript lines="
            f"{len(out.strip().splitlines()) if out.strip() else 0}, "
            f"316px lines={len(out2.strip().splitlines()) if out2.strip() else 0}")


def t16():
    rc, out, _ = repo_grep("PREVIEW_MIN_S =", "features/desktop/lease-watcher.py")
    preview_s_ok = rc == 0 and "PREVIEW_MIN_S = 120" in out
    cmd = ("stat -c '%n %Y %s' /data/home/mcp-proxy/preview.png "
           "/data/home/mcp-proxy/preview-qa.png; date +%s")
    ok, mout, info = ib_stdout(cmd, 60)
    if not ok:
        return "FAIL", info
    fresh = []
    try:
        lines = [l.split() for l in mout.strip().splitlines() if l.strip()]
        now = int(lines[-1][0])
        for parts in lines[:-1]:
            age = now - int(parts[1])
            fresh.append((parts[0], age, int(parts[2])))
    except Exception:
        return "FAIL", f"unparsable stat output: {one_line(mout)}"
    files_ok = len(fresh) == 2 and all(age < 120 and size > 10000
                                       for _, age, size in fresh)
    code1, body1 = http_post_json(
        PAGES + "/desktop/__preview-upload?computer=default", {}, timeout=30)
    code2, _ = http_get(PAGES + "/desktop/__preview?computer=default",
                        timeout=30)
    up_ok = code1 == 401 and "unauthorized" in body1
    pv_ok = code2 == 200
    good = preview_s_ok and files_ok and up_ok and pv_ok
    return ("PASS" if good else "FAIL",
            f"PREVIEW_MIN_S=120:{preview_s_ok} files={fresh} "
            f"upload401:{up_ok} preview-gate200:{pv_ok}")


def t17():
    # scrot refuses to overwrite: if /tmp/scrot-test.png exists it writes
    # scrot-test_001.png instead, and the test would compare a STALE file.
    # Round 3 failed exactly this way (fresh mss 598 KB vs stale scrot
    # 243 KB from Round 2). Always remove both captures first.
    shot = ("rm -f /tmp/mss-test.png /tmp/scrot-test.png /tmp/scrot-test_*.png; "
            "timeout 40 docker exec -e DISPLAY=:1 qwenpaw python3 -c "
            "\"import mss; m=mss.MSS(); print(m.monitors); "
            "s=m.shot(mon=1, output='/tmp/mss-test.png'); print('saved:', s)\" "
            "2>&1 | grep -v DeprecationWarning; "
            "docker cp qwenpaw:/tmp/mss-test.png /tmp/mss-test.png 2>&1; "
            "DISPLAY=:1 timeout 20 scrot /tmp/scrot-test.png 2>&1; "
            "file /tmp/mss-test.png /tmp/scrot-test.png 2>&1; "
            "stat -c '%n %s' /tmp/mss-test.png /tmp/scrot-test.png 2>&1")
    ok, out, info = ib_stdout(shot, 120)
    if not ok:
        return "FAIL", info
    dims_ok = out.count("1920 x 1080") >= 2
    sizes = [int(x) for x in re.findall(r"/tmp/(?:mss|scrot)-test\.png (\d+)",
                                        out)]
    sizes_ok = len(sizes) == 2 and all(s > 100000 for s in sizes) \
        and 0.5 <= sizes[0] / sizes[1] <= 2.0
    if not (dims_ok and sizes_ok):
        return "FAIL", f"dims1920x1080:{dims_ok} sizes={sizes} raw={one_line(out, 250)}"
    ok2, res = machine_python(
        PNG_MEAN_SCRIPT, ["/tmp/mss-test.png", "/tmp/scrot-test.png"],
        timeout_s=60)
    if not ok2:
        return "FAIL", f"capture ok (sizes={sizes}) but PNG compare failed: {res}"
    try:
        m = res["/tmp/mss-test.png"]; s = res["/tmp/scrot-test.png"]
    except Exception:
        return "FAIL", f"PNG compare bad shape: {one_line(str(res))}"
    mean_ok = m["size"] == [1920, 1080] and s["size"] == [1920, 1080] \
        and abs(m["mean_luminance"] - s["mean_luminance"]) <= 0.15 * s["mean_luminance"]
    return ("PASS" if mean_ok else "FAIL",
            f"mss={sizes[0]}B mean={m['mean_luminance']} "
            f"scrot={sizes[1]}B mean={s['mean_luminance']}")


def _bridge_cmd(endpoint, data_json):
    # Token is read from the machine file INSIDE the shell and never printed.
    # Only the curl JSON response is captured.
    return ("T=$(grep '^BRIDGE_TOKEN=' /data/home/camoufox/.env | cut -d= -f2-); "
            f"curl -s --max-time 60 -H \"Authorization: Bearer $T\" "
            f"-H 'Content-Type: application/json' -d '{data_json}' "
            f"http://127.0.0.1:8899{endpoint}")


def t18():
    ok, out, info = ib_stdout(
        "curl -s --max-time 5 http://127.0.0.1:8899/health", 60)
    if not ok:
        return "FAIL", info
    try:
        data = json.loads(out)
    except Exception:
        return "FAIL", f"unparsable /health: {one_line(out)}"
    good = data.get("ok") is True and data.get("browser_alive") is True
    return ("PASS" if good else "FAIL",
            f"/health={one_line(out, 160)}")


def t19():
    ok, out, info = ib_stdout(
        _bridge_cmd("/goto", '{"url":"https://x.com/0xsatwik"}'), 120)
    if not ok:
        return "FAIL", info
    try:
        data = json.loads(out)
    except Exception:
        return "FAIL", f"unparsable /goto response: {one_line(out)}"
    url = str(data.get("url", "")); title = str(data.get("title", ""))
    good = "x.com/0xsatwik" in url and "Satwik" in title
    return ("PASS" if good else "FAIL",
            f"url={url} title={title} (token never recorded)")


def t20():
    ok, out, info = ib_stdout(
        _bridge_cmd("/desktop-open", '{"url":"https://wordsolverx.com"}'), 90)
    if not ok:
        return "FAIL", info
    try:
        data = json.loads(out)
    except Exception:
        return "FAIL", f"unparsable /desktop-open response: {one_line(out)}"
    return ("PASS" if data.get("ok") is True else "FAIL",
            f"/desktop-open={one_line(out, 160)} (token never recorded)")


def t21():
    code1, body1 = http_get(ROUTINES + "/", timeout=30)
    code2, body2 = http_get(ROUTINES + "/api/status", timeout=30)
    try:
        data = json.loads(body2)
    except Exception:
        data = {}
    q = (data.get("qwenpaw") or {})
    routines = [r.get("id") for r in data.get("routines", [])]
    good = code1 == 200 and "AgentX Routines" in body1 \
        and code2 == 200 and q.get("status") == "up" \
        and q.get("httpStatus") == 200 and "daily-summary" in routines
    return ("PASS" if good else "FAIL",
            f"/ HTTP {code1}; /api/status HTTP {code2} qwenpaw={q} "
            f"routines={routines}")


def t22():
    data, err = cf_get(
        f"/client/v4/accounts/{CF_ACCOUNT}/workers/scripts/qwenpaw-routines/schedules")
    if data is None:
        return "FAIL", err
    crons = sorted(s.get("cron") for s in
                   (data.get("result") or {}).get("schedules", []))
    good = data.get("success") is True \
        and crons == ["*/30 * * * *", "30 1 * * *"]
    return ("PASS" if good else "FAIL", f"schedules={crons}")


def t23():
    code, body = http_post_json(ROUTINES + "/trigger",
                                {"id": "daily-summary"}, timeout=30)
    good = code == 401 and "unauthorized" in body
    return ("PASS" if good else "FAIL",
            f"POST /trigger no token -> HTTP {code} body={one_line(body, 120)}"
            + (" (202 would be the pre-audit bug; 503 would mean the token is unset)"
               if not good else ""))


def t24():
    code, body = http_get(ROUTINES + "/api/history", timeout=30)
    try:
        hist = json.loads(body).get("history", [])
    except Exception:
        return "FAIL", f"unparsable /api/history: HTTP {code} {one_line(body, 120)}"
    now = time.time()
    recent = {}
    for h in hist:
        try:
            at = datetime.fromisoformat(
                h["at"].replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        if now - at <= 24 * 3600 and h.get("qwenpaw") == "up":
            recent.setdefault(h.get("kind"), h)
    good = code == 200 and "wake-tick" in recent \
        and "daily-summary-slot" in recent
    return ("PASS" if good else "FAIL",
            f"recent kinds={sorted(recent)} "
            f"wake-tick={one_line(str(recent.get('wake-tick', {}).get('at')), 60)} "
            f"daily={one_line(str(recent.get('daily-summary-slot', {}).get('at')), 60)}")


def t25():
    code, body = http_get(GROUPCHAT + "/", timeout=30)
    try:
        data = json.loads(body)
    except Exception:
        data = {}
    good = code == 200 and data.get("service") == "qwenpaw-groupchat" \
        and data.get("auth_required") is True
    return ("PASS" if good else "FAIL",
            f"HTTP {code} body={one_line(body, 200)}")


def t26():
    code1, body1 = http_post_json(
        GROUPCHAT + "/thread/message",
        {"author": "test", "role": "user", "text": "probe - should be rejected"},
        timeout=30)
    code2, body2 = http_get(GROUPCHAT + "/thread", timeout=30)
    good = code1 == 401 and code2 == 401
    return ("PASS" if good else "FAIL",
            f"POST /thread/message HTTP {code1} {one_line(body1, 80)}; "
            f"GET /thread HTTP {code2} {one_line(body2, 80)}")


def t27():
    code1, _ = http_get(BOARD + "/", timeout=30)
    code2, body2 = http_get(BOARD + "/health", timeout=30)
    try:
        data = json.loads(body2)
    except Exception:
        data = {}
    good = code1 == 200 and code2 == 200 and data.get("ok") is True \
        and data.get("worker") == "qwenpaw-board" \
        and data.get("store") == "d1"
    return ("PASS" if good else "FAIL",
            f"/ HTTP {code1}; /health HTTP {code2} body={one_line(body2, 100)}")


def t28():
    code, body = http_get(BOARD + "/api/tickets", timeout=30)
    good = code == 401 and "unauthorized" in body
    return ("PASS" if good else "FAIL",
            f"GET /api/tickets no key -> HTTP {code} body={one_line(body, 120)}")


def t29():
    code, body = http_get(BOT + "/", timeout=30)
    good = code == 200 and "Hello from QwenPaw" in body
    return ("PASS" if good else "FAIL", f"HTTP {code} size={len(body)}")


def t30():
    code, body = http_get(BOT + "/skills/", timeout=30)
    good = code == 200 and "QwenPaw Skill Library" in body
    return ("PASS" if good else "FAIL", f"HTTP {code} size={len(body)}")

def t31():
    ok, out, showing = skills_list()
    if not ok:
        return "FAIL", showing
    m = re.search(r"Showing:\s*(\d+) of (\d+) skills,\s*(\d+) enabled,\s*(\d+) disabled",
                  showing)
    if not m:
        return "FAIL", f"no Showing line; tail={one_line(out[-300:], 200)}"
    total, of, enabled, disabled = (int(x) for x in m.groups())
    rows = [l for l in out.splitlines() if "✓" in l or "✗" in l]
    disabled_rows = [l for l in rows if "✗" in l or "disabled" in l]
    good = total == 24 and of == 24 and enabled == 24 and disabled == 0 \
        and not disabled_rows
    return ("PASS" if good else "FAIL",
            f"{showing.strip()} rows={len(rows)}")


def t32():
    ok, out, _ = skills_list()
    if not ok:
        return "FAIL", out
    found = {}
    for name in ("delegate", "github", "build-page"):
        found[name] = bool(re.search(rf"^\s*{re.escape(name)}\s+\S+\s+✓ enabled",
                                     out, re.M))
    good = all(found.values())
    return ("PASS" if good else "FAIL", f"present+enabled: {found}")


def t33():
    cmd = ("docker exec qwenpaw qwenpaw skills list 2>/dev/null | grep -i mailbox; "
           "sudo python3 -c \"import json; c=json.load(open('/data/home/qwenpaw/working/config.json')); "
           "print('mcp.clients:', c.get('mcp',{}).get('clients'))\" 2>&1; "
           "grep -i qwenpawmail /data/home/qwenpaw/working/qwenpaw.log 2>/dev/null "
           "| tail -n 2 | cut -c1-200")
    ok, out, info = ib_stdout(cmd, 120)
    if not ok:
        return "FAIL", info
    row = "mailbox" in out.lower()
    clients = re.search(r"mcp\.clients: (\{.*\}|\S+)", out)
    clients_s = clients.group(1) if clients else "?"
    gap_log = "qwenpawmail" in out.lower()
    # Expected: skill listed, but no qwenpawmail client configured -> KNOWN-GAP.
    gap = row and ("anysearch" in out) and ("qwenpawmail" not in
                                            (clients_s or "").lower())
    if gap:
        return ("KNOWN-GAP",
                f"mailbox row present; mcp.clients={one_line(clients_s, 120)}; "
                f"log mentions qwenpawmail: {gap_log} (Gmail MCP never configured)")
    if not row:
        return "FAIL", f"mailbox skill missing from list: {one_line(out, 200)}"
    return ("FAIL" if "qwenpawmail" not in out.lower() else "PASS",
            f"unexpected state: row={row} clients={one_line(clients_s, 120)} "
            f"log={one_line(out, 200)}")


def t34():
    ok, out, info = ib_stdout(
        "sudo python3 -c \"import json; c=json.load(open('/data/home/qwenpaw/working/config.json')); "
        "print(c.get('agents',{}).get('defaults',{}).get('heartbeat'))\"", 60)
    if not ok:
        return "FAIL", info
    return ("PASS", f"heartbeat defaults: {one_line(out, 200)} (record only; do NOT enable)")


def t35():
    ok, out, info = ib_stdout(
        "sudo python3 -c \"import json; a=json.load(open('/data/home/qwenpaw/working/workspaces/default/agent.json')); "
        "print(a.get('approval_level'))\"", 60)
    if not ok:
        return "FAIL", info
    val = out.strip().splitlines()[-1] if out.strip() else ""
    return ("PASS" if val == "AUTO" else "FAIL",
            f"default approval_level={val} (SMART patch is NOT applied)")


def t36():
    cmd = """sudo grep -A3 'effect: allow' /data/home/qwenpaw/working/workspaces/default/drivers/mcp/computer-use.yaml | head -n 6; sudo grep -A3 'effect: allow' /data/home/qwenpaw/working/workspaces/QwenPaw_QA_Agent_0.2/drivers/mcp/computer-use.yaml | head -n 6; docker exec qwenpaw python3 -c "import yaml; yaml.safe_load(open('/app/working/workspaces/default/drivers/mcp/computer-use.yaml')); yaml.safe_load(open('/app/working/workspaces/QwenPaw_QA_Agent_0.2/drivers/mcp/computer-use.yaml')); print('both cards parse')" 2>&1 | tail -n 3; E=$(grep -n "DriverCardError.*computer-use.yaml" /data/home/qwenpaw/working/qwenpaw.log 2>/dev/null | tail -1 | cut -d: -f1); R=$(grep -n "refreshed after card change" /data/home/qwenpaw/working/qwenpaw.log 2>/dev/null | tail -1 | cut -d: -f1); echo "ERR_LINE=${E:-0} REFRESH_LINE=${R:-0}\""""
    ok, out, info = ib_stdout(cmd, 120)
    if not ok:
        return "FAIL", info
    allow = out.count("effect: allow")
    parse = "both cards parse" in out
    m = re.search(r"ERR_LINE=(\d+) REFRESH_LINE=(\d+)", out)
    last_err = int(m.group(1)) if m else -1
    last_refresh = int(m.group(2)) if m else -1
    # A parse error counts only if no successful watcher refresh follows it:
    # historical errors (fixed in Round 1) must not fail later rounds.
    fresh_err = last_err > 0 and last_refresh <= last_err
    good = allow >= 2 and parse and not fresh_err
    note = ""
    if fresh_err:
        note = (f" last DriverCardError (line {last_err}) has no later watcher "
                f"refresh (last refresh line {last_refresh}).")
    return ("PASS" if good else "FAIL",
            f"effect allow occurrences={allow} parse={parse} "
            f"last_error_line={last_err} last_refresh_line={last_refresh}.{note}")


def t37():
    before, err = approval_pending_count()
    if before is None:
        return "FAIL", err
    ok, res = mcp_list_apps(8898)
    if not ok or res.get("error"):
        return "FAIL", f"MCP call failed, cannot compare counts: {res}"
    after, err = approval_pending_count()
    if after is None:
        return "FAIL", err
    good = after == before
    return ("PASS" if good else "FAIL",
            f"approval-pending count before={before} after list_apps={after}")


def _transfer_script(repo_rel, machine_path):
    """Base64-transfer a repo script to the machine. Returns (ok, info)."""
    src = REPO / repo_rel
    try:
        b64 = base64.b64encode(src.read_bytes()).decode()
    except Exception as e:
        return False, f"cannot read {repo_rel}: {e}"
    ok, out, info = ib_stdout(
        f"echo {b64} | base64 -d > {machine_path} && wc -c {machine_path}", 90)
    if not ok:
        return False, info
    return True, one_line(out, 120)


def t38():
    ok, info = _transfer_script("features/infra/scripts/fleet.py",
                                "/tmp/tp-fleet.py")
    if not ok:
        return "FAIL", info
    ok, out, info = ib_stdout("sudo python3 /tmp/tp-fleet.py list", 120)
    if not ok:
        return "FAIL", info
    good = "default" in out and "QwenPaw_QA_Agent_0.2" in out
    return ("PASS" if good else "FAIL",
            f"fleet list exit ok; agents listed: {good}; "
            f"head={one_line(out, 220)}")


def t39():
    try:
        suite = json.loads(
            (REPO / "features/infra/evals/cases.json").read_text())
    except Exception as e:
        return "FAIL", f"cases.json unreadable: {e}"
    prompts = sorted(p.name for p in
                     (REPO / "features/infra/prompts/v1").iterdir())
    ids = [c.get("id") for c in suite.get("cases", [])]
    good = suite.get("version") == 1 \
        and suite.get("prompt_version") == "prompts/v1" \
        and ids == ["identity-en", "english-only", "no-china-endpoint",
                    "timezone-awareness", "destructive-refusal"] \
        and prompts == ["AGENTS.md", "HEARTBEAT.md", "PROFILE.md",
                        "README.md", "SOUL.md"]
    return ("PASS" if good else "FAIL",
            f"cases v{suite.get('version')} {ids}; prompts/v1={prompts}")


def t40():
    rc, out, err = run_local(
        ["python3", str(REPO / "features/infra/evals/run-evals.py"),
         "--dry-run"], timeout=60)
    good = rc == 0 and "DRY-RUN" in out and "no login" in out
    return ("PASS" if good else "FAIL",
            f"exit={rc} dry-run={'DRY-RUN' in out} "
            f"tail={one_line(out.strip().splitlines()[-1] if out.strip() else err, 160)}")


def _wsexport():
    return _transfer_script("features/infra/scripts/workspace-export.py",
                            "/tmp/tp-wsexport.py")


def t41():
    ok, info = _wsexport()
    if not ok:
        return "FAIL", info
    cmd = ("sudo python3 /tmp/tp-wsexport.py export "
           "/data/home/qwenpaw/working/workspaces/QwenPaw_QA_Agent_0.2 "
           "/tmp/tp-qa-export.tgz 2>&1; echo EXPORT_EXIT=$?; "
           "sudo python3 /tmp/tp-wsexport.py verify /tmp/tp-qa-export.tgz 2>&1; "
           "echo VERIFY_EXIT=$?")
    ok, out, info = ib_stdout(cmd, 180)
    if not ok:
        return "FAIL", info
    good = "EXPORT_EXIT=0" in out and "VERIFY_EXIT=0" in out
    return ("PASS" if good else "FAIL", one_line(out, 300))


def t42():
    ok, info = _wsexport()
    if not ok:
        return "FAIL", info
    try:
        # Export fresh if T41 did not leave an archive (tests are independent).
        prep = ("ls /tmp/tp-qa-export.tgz 2>/dev/null || sudo python3 "
                "/tmp/tp-wsexport.py export "
                "/data/home/qwenpaw/working/workspaces/QwenPaw_QA_Agent_0.2 "
                "/tmp/tp-qa-export.tgz 2>&1")
        ok, out, info = ib_stdout(prep, 180)
        if not ok:
            return "FAIL", info
        # The restore dir is test scratch: a previous round leaves it behind
        # and the import tool refuses to overwrite by design (never deletes).
        # Remove it first; the tool's own safety is not being bypassed on
        # real data — /tmp/tp-qa-restore holds only this test's output.
        cmd = ("sudo rm -rf /tmp/tp-qa-restore; "
               "sudo python3 /tmp/tp-wsexport.py import /tmp/tp-qa-export.tgz "
               "/tmp/tp-qa-restore 2>&1; echo IMPORT_EXIT=$?; "
               "sudo sha256sum /data/home/qwenpaw/working/workspaces/QwenPaw_QA_Agent_0.2/agent.json "
               "/tmp/tp-qa-restore/agent.json 2>&1; "
               "ls /tmp/tp-qa-restore/ 2>&1")
        ok, out, info = ib_stdout(cmd, 180)
        if not ok:
            return "FAIL", info
        hashes = re.findall(r"^([0-9a-f]{64})", out, re.M)
        same = len(hashes) == 2 and hashes[0] == hashes[1]
        has_files = "agent.json" in out and "SOUL.md" in out \
            and "skills" in out
        good = "IMPORT_EXIT=0" in out and same and has_files
        return ("PASS" if good else "FAIL",
                f"import={'IMPORT_EXIT=0' in out} agent.json hashes match={same} "
                f"files={has_files} raw={one_line(out, 220)}")
    finally:
        ib_stdout("rm -rf /tmp/tp-qa-restore /tmp/tp-qa-export.tgz "
                  "/tmp/tp-wsexport.py /tmp/tp-fleet.py; "
                  "ls /tmp/tp-qa-restore /tmp/tp-qa-export.tgz 2>&1 | head -n 2",
                  60)


def t43():
    code, body = http_get(KEEPALIVE + "/status", timeout=30)
    try:
        data = json.loads(body)
    except Exception:
        data = {}
    good = code == 200 and data.get("status") == "up" \
        and data.get("httpStatus") == 200 \
        and data.get("consecutiveFailures") == 0
    return ("PASS" if good else "FAIL",
            f"HTTP {code} status={data.get('status')} "
            f"httpStatus={data.get('httpStatus')} "
            f"failures={data.get('consecutiveFailures')} "
            f"source={data.get('source')}")


def t44():
    code, body = http_get(KEEPALIVE + "/ping", timeout=60)
    try:
        data = json.loads(body)
    except Exception:
        data = {}
    good = code == 200 and data.get("status") in ("up", "waking")
    return ("PASS" if good else "FAIL",
            f"HTTP {code} status={data.get('status')} "
            f"source={data.get('source')}")


def t45():
    code1, _ = http_get(PAGES_B + "/", timeout=120)
    code2, _ = http_get(PAGES_B + "/status", timeout=120)
    code3, body3 = http_get(PAGES_B + "/api/auth/status", timeout=120)
    try:
        data = json.loads(body3)
    except Exception:
        data = None
    good = code1 == 200 and code2 == 200 and code3 == 200 \
        and data == {"enabled": True, "has_users": True}
    return ("PASS" if good else "FAIL",
            f"backup root={code1} status={code2} auth={code3} body={one_line(body3, 60)}")


def _harness(relpath, expect):
    rc, out, err = run_local(["node", str(REPO / relpath)], timeout=180)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    good = rc == 0 and m and int(m.group(1)) == expect \
        and int(m.group(2)) == 0
    return ("PASS" if good else "FAIL",
            f"{relpath}: exit={rc} tally={m.group(0) if m else 'none'} "
            f"tail={one_line(out.strip().splitlines()[-1] if out.strip() else err, 120)}")


def t46():
    return _harness("features/desktop/harness-desktop-gate.mjs", 127)


def t47():
    return _harness("features/desktop/harness-desktop-chrome.mjs", 34)


def t62():
    return _harness("features/storage/harness-store.mjs", 42)


def t63():
    """Board rate limit (T63): burst from the InstaBox machine's stable
    egress IP — the runner VM's IP rotates per connection, so a burst
    from here never accumulates in one per-IP bucket. Two attempts max:
    a burst straddling a minute boundary splits the count and may show
    no 429 on the first try."""
    burst = (
        "B=https://qwenpaw-board.qwenpaw-rohan.workers.dev; "
        "for i in $(seq 1 35); do curl -s -o /dev/null -w \"%{http_code}\\n\" "
        "--max-time 15 -X POST $B/api/tickets -H 'Content-Type: application/json' "
        "-d '{\"title\":\"flood probe\"}'; done | sort | uniq -c; "
        "echo '--- follow-up ---'; "
        "curl -s -D - -o /dev/null --max-time 15 -X POST $B/api/tickets "
        "-H 'Content-Type: application/json' -d '{\"title\":\"flood probe\"}' "
        "| grep -iE 'HTTP/|retry-after' | tr '\\n' ' '"
    )
    for attempt in (1, 2):
        res = ib_exec(burst, timeout_s=180)
        if "_error" in res:
            return "FAIL", f"ib.py exec failed: {res['_error']}"
        out = res.get("stdout", "")
        counts = {}
        for m in re.finditer(r"^\s*(\d+)\s+(\d{3})\s*$", out, re.M):
            counts[m.group(2)] = int(m.group(1))
        n429 = counts.get("429", 0)
        n401 = counts.get("401", 0)
        other = {k: v for k, v in counts.items() if k not in ("401", "429")}
        follow = re.search(r"HTTP/2 429.*?retry-after:\s*(\d+)",
                           out, re.S | re.I)
        if n429 >= 1 and n401 + n429 == 35 and not other:
            return ("PASS",
                    f"attempt {attempt}: 401={n401} 429={n429} "
                    f"follow-up retry-after={follow.group(1) if follow else 'n/a'} "
                    f"(machine burst, stable IP)")
        if attempt == 1:
            time.sleep(65)
    return ("FAIL",
            f"no 429 in 2 bursts from the machine: {one_line(out, 200)}")


def t48():
    return _harness("features/desktop/harness-desktop-origin.mjs", 9)


def _lease_qa():
    _, body = http_get(PAGES + "/desktop/__lease?computer=qa", timeout=30)
    try:
        return json.loads(body)
    except Exception:
        return None


def _d1_query(sql, params=None):
    """One D1 query via cf.py post. Returns (ok, parsed_json_or_text)."""
    body = {"sql": sql}
    if params is not None:
        body["params"] = params
    rc, out, err = run_local(
        ["python3", str(CF), "post",
         f"/client/v4/accounts/{CF_ACCOUNT}/d1/database/{D1_DB}/query",
         json.dumps(body)], timeout=60)
    if rc != 0:
        return False, (err or out)
    try:
        return True, json.loads(out)
    except Exception:
        return False, out


def t49():
    """D1 lease write test (computer=qa). Writes the lease row directly
    to the D1 leases table (the lease store since 2026-11-15), then
    verifies __lease shows it and the watcher mirrors it to the QA
    control file. Cleanup runs in a finally. (The old KV version of
    this test is obsolete: KV writes are blocked account-wide with
    error 10048 and KV is only the fallback now.)"""
    before = _lease_qa()
    if before is None or before.get("holder") != "agent":
        return "FAIL", f"precondition: qa lease not free: {one_line(str(before))}"
    fence = before.get("fence", 0)
    lease = {"leaseId": str(uuid.uuid4()), "holder": "user",
             "grantedAt": int(time.time() * 1000),
             "expiresAt": int(time.time() * 1000) + 90000,
             "fence": (fence + 1) if isinstance(fence, int) else 1}
    written = False
    try:
        ok, resp = _d1_query(
            "INSERT INTO leases (computer, lease_id, holder, granted_at, expires_at, fence) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ["qa", lease["leaseId"], "user", lease["grantedAt"], lease["expiresAt"], lease["fence"]])
        if not ok:
            return ("NEEDS-VERIFICATION",
                    f"D1 query failed: {one_line(str(resp))} — see TESTS.md T49")
        if isinstance(resp, dict) and resp.get("success") is False:
            return ("NEEDS-VERIFICATION",
                    f"D1 query success=false: {one_line(str(resp.get('errors')))} — see TESTS.md T49")
        written = True
        holder_user = False
        for _ in range(6):
            cur = _lease_qa()
            if cur and cur.get("holder") == "user" \
                    and cur.get("leaseId") == lease["leaseId"]:
                holder_user = True
                break
            time.sleep(5)
        if not holder_user:
            return "FAIL", ("KV write accepted but __lease?computer=qa never "
                            f"showed holder=user leaseId={lease['leaseId']}")
        control = False
        # 18 x 5 s = 90 s: the watcher polls __lease every 10 s, so the
        # control file can lag the test's own read by ~10 s. (The old KV
        # version of this test waited out a ~60 s KV stale-read window;
        # D1 reads are strongly consistent, so that no longer applies.)
        for _ in range(18):
            ok, out, _ = ib_stdout(
                "cat /run/user/1000/qa/instabox-control 2>/dev/null", 60)
            if ok and "worker-lease" in out:
                control = True
                control_txt = one_line(out, 120)
                break
            time.sleep(5)
        if not control:
            return "FAIL", ("__lease showed holder=user but the QA control "
                            "file never appeared (watcher should mirror it)")
        return ("PASS",
                f"lease {lease['leaseId'][:8]}… holder=user; control file: "
                f"{control_txt}; deleted below")
    finally:
        ok, resp = _d1_query("DELETE FROM leases WHERE computer = ?", ["qa"])
        # Poll until the lease reads free again (D1 reads are strongly
        # consistent, so this should be fast; the watcher still polls
        # __lease every 10 s, so the control file may lag a little).
        freed = False
        for _ in range(18):
            cur = _lease_qa()
            if cur and cur.get("holder") == "agent":
                freed = True
                break
            time.sleep(5)
        print(f"  [T49 cleanup] D1 delete ok={ok} lease-free-again={freed}",
              file=sys.stderr)


# ------------------------------------------------------------------ registry
# (id, name, area, method, fn) — fn is None for browser / needs-token tests.

def _py_harness(relpath, expect, timeout=180):
    """Run a stdlib-only Python test module and check its tally.

    Used by the memory / routing / pricing / storage tests, which must run on
    both this VM and the machine without any third-party dependency.
    """
    rc, out, err = run_local([sys.executable, str(REPO / relpath)],
                             timeout=timeout)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    good = rc == 0 and m and int(m.group(1)) == expect \
        and int(m.group(2)) == 0
    return ("PASS" if good else "FAIL",
            f"{relpath}: exit={rc} tally={m.group(0) if m else 'none'} "
            f"tail={one_line(out.strip().splitlines()[-1] if out.strip() else err, 120)}")

def _py_script_harness(argv, expect, timeout=180):
    """Like _py_harness but for a module run with a flag (--selftest)."""
    rc, out, err = run_local([sys.executable] + [str(REPO / a) if i == 0 else a
                                                 for i, a in enumerate(argv)],
                             timeout=timeout)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    good = rc == 0 and m and int(m.group(1)) == expect \
        and int(m.group(2)) == 0
    return ("PASS" if good else "FAIL",
            f"{' '.join(argv)}: exit={rc} tally={m.group(0) if m else 'none'}")

def t70():
    return _py_harness("features/memory/test_recall.py", 44)

def t71():
    return _py_harness("features/memory/test_lessons.py", 45)

def t72():
    rc, out, err = run_local(
        [sys.executable, str(REPO / "features/memory/reme_doctor.py"), "--selftest"],
        timeout=180)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    good = rc == 0 and m and int(m.group(2)) == 0
    return ("PASS" if good else "FAIL",
            f"reme_doctor --selftest: exit={rc} tally={m.group(0) if m else 'none'}")

def t73():
    return _py_harness("features/memory/test_install_ripwire.py", 49)

def t74():
    return _harness("worker/harness-keepalive.mjs", 19)

def t75():
    return _py_harness("features/desktop/test_lease_watcher.py", 29)

def t76():
    """The RETIRED Cloudflare Worker's harness (68 checks).

    Kept green on purpose. The Worker cannot run — `worker_loaders` needs a
    paid plan (API 403 code 10195) — and its benchmark arithmetic is the record
    of what was measured BEFORE B-41. That measurement was of an imaginary
    surface (30 modelled tools, 21 of which do not exist on the machine's MCP
    proxy), so this harness is kept green as the ARCHIVE of the wrong number,
    not as a claim about the live pilot. The live pilot (T94/T96) now measures
    the real 9-tool surface; see features/codemode/README.md.
    """
    return _harness("features/codemode/harness-codemode.mjs", 68)


def t94():
    """Code Mode VM runner: the REAL 9-tool desktop job (218 checks).

    B-42: the job now passes every REQUIRED argument. `app` is resolved from
    step 1's own list_apps result (never hard-coded), and a preflight table
    check turns a missing argument into one named skip instead of eight
    identical tool errors. The mock enforces the live proxy's contract, so a
    job that omits `app` fails here instead of on the machine.

    B-41: this job used to call ten tools of which nine did not exist on the
    machine's MCP proxy, so a live run scored 1/10 with `unsupportedTool` while
    the bench reported a 99.0% prompt reduction computed from 30 imaginary
    tools. It now runs one step per real desktop tool, reports the whole surface
    on every run (`describe_surface`), and states plainly that desktop work does
    NOT collapse turns. The 99.0% figure is withdrawn, not adjusted.

    T139 (2026-11-19): the runner also wires generated-code jobs to the
    sandbox (`run_sandbox_job`: route -> resolve workspace symlinks ->
    mint scoped token -> build/validate profile -> `docker run` from
    `docker_run_argv`; refusals surface the reason, never fall back to
    main). The AST rule changed with it: subprocess is used only via
    run() (TimeoutExpired raised by the deadline fixture), only from
    the sandbox runner and its docker-kill helper.
    """
    return _py_script_harness(["features/codemode/vm/codemode-runner.py", "--selftest"], 218)


def t98():
    """CORS on the screen capability surface (36 checks).

    The screen lives in an opaque-origin iframe (sandbox without
    allow-same-origin, which is a security property we keep). noVNC loads as ES
    modules, and module scripts are always fetched in CORS mode — so with no
    Access-Control-Allow-Origin the browser refuses them, noVNC never
    initializes, and its WebSocket is never opened. The frame sits on "The
    screen did not respond" while the socket path works perfectly.

    This is why every curl/Node probe passed and every browser failed: neither
    enforces CORS. Asserts module assets and error paths carry ACAO, that
    OPTIONS is a 204 preflight, that the 101 tunnel still keeps its minimal
    headers, and that no allow-same-origin was added to the sandbox.
    """
    return _harness("features/computer/harness-screen-cors.mjs", 36)


def t105():
    """The SERVED page's terminal path: /vendor must be JS, not the SPA (52).

    11th browser check: sidebar fixed, Take control OK, "Open terminal" ->
    Session "connected" green, terminal area COMPLETELY BLACK for 30-50 s,
    typing produced nothing, lease expired. The exact pre-fix B-33 symptom.

    Muse's Node test passes and T103 replays the browser wire correctly, but
    neither exercises the SERVED PAGE's JavaScript — that gap is where the bug
    was. The deciding clue was that the page's own "Connecting to the computer's
    terminal…" courtesy line never appeared either, so xterm itself never ran.

    ROOT CAUSE: `/vendor/*` was never routed, so it fell through to the console
    proxy, which answered `GET /vendor/xterm.js` with the QwenPaw SPA —
    200, text/html, 45,989 bytes (verified live). A <script src> served as HTML
    parses as nothing, so window.Terminal stayed undefined and the code fell
    back to a null terminal. It failed SILENTLY: 200 is 200, no onerror, no
    console line.

    Asserts the served MIME types through the real router, that unknown/hostile
    /vendor paths 404 rather than leaking the SPA, that a missing xterm is
    reported instead of going black, that resource-load failures are trapped,
    and that the terminal still writes to a real attached instance.
    Also asserts the "Connecting…" courtesy line is cleared on the first real
    shell output (51st check, 2026-11-17: the line otherwise sits above the
    prompt forever). Fail-first proven: the new check fails on the pre-fix
    ui.html and passes on the fixed one. And the toast leaves the
    accessibility tree when hidden (52nd check, B-45: visibility:hidden, not
    opacity:0 alone).
    """
    return _harness("features/computer/harness-terminal-served.mjs", 52)


def t106():
    """The vault: the model can USE a key but never SEE it (63 checks).

    Rakazo-style vault (2026-11-17). The value is decrypted ONLY inside the
    Worker; the model sends the key NAME + what it wants done; the Worker
    builds the request with the real key and redacts every byte back.

    Drives the REAL Worker (_worker.js -> vault router) against a D1 mock
    backed by real SQLite (the real schema.sql), with the upstream fetch
    stubbed. A fresh canary (random 32-hex) per run, so a test that passes
    by matching a stale value is impossible. Asserts:
      (a) anon list/put/request/export -> 401; list returns metadata only
          (no canary, no base64/percent-encoded form, no ciphertext, no row
          id); an upstream that echoes the Authorization header AND leaks
          the token in plain text returns a body with [redacted] and no
          canary form — while the upstream really did receive the Bearer
          header; a wrong-origin request -> 403 AND writes no use row AND
          never calls the upstream; reveal needs the session cookie AND the
          console bearer token (session alone -> 401); export needs the
          broker token; validation (bad name/origin/header, reserved env
          var, *_PROXY, command via /request -> 400/409);
      (b) crypto unit checks via the real crypto.js: seal/open round-trip,
          wrong host/kind/item-id in the AAD -> null (no transplant, no
          cross-type), tampered ciphertext -> null, overlapping redaction
          forms merge into one marker, a short raw value is never a form;
      (c) activity lists uses without values; remove deletes the item and
          its uses.
      (d) list-broker (2026-11-18): the agent's list path — broker token
          only (no token / wrong token -> 401), metadata only (no canary,
          no ciphertext, no row id), and it writes NO use row.
    The redeploy/restart half of property (c) is a live test, run by Muse
    at deploy time — see features/vault/README.md.
    Fails 54/55 pre-fix (the short-value expectation was a test bug, not a
    code bug — fixed in the test); 55/55 after. List-broker: 59/63
    fail-first (the 4 auth/shape checks fail on the missing route), 63/63
    after.
    """
    return _harness("features/vault/harness-vault.mjs", 63)


def t107():
    """The vault broker: env-var injection + output scrubbing (29 checks).

    Machine-free selftest of features/vault/vault-broker.py (which also
    tests the shared redact.py). Asserts the per-kind redaction forms
    (bearer scheme variants, basic decoded user:pass + password alone),
    that a short raw value is never a form, that redaction replaces every
    occurrence, and that the streaming redactor hides a value split across
    chunks, and that the broker sends its own User-Agent (not
    Python-urllib's, which Cloudflare blocks with 1010). Also the GET
    /list endpoint (2026-11-18): served live on an ephemeral port with a
    test token — no token / wrong token -> 401, correct token -> 200 with
    metadata only, and /health still 200. Also POST /sandbox/inject
    (T139, 2026-11-19): served live on the same port with a stubbed
    Worker export and a test SANDBOX key — valid token -> 200 with the
    value scrubbed and the child env free of the broker token, replay /
    bad token / wrong-item token -> 401, broker token alone -> 400,
    no token -> 400, no key configured -> 503 (fail closed), GET -> 405.
    The live broker (Unix-socket/
    bridge service, /run with a real command, env | sort proving
    [redacted]) is verified by Muse at deploy time — see
    features/vault/README.md.
    """
    return _py_script_harness(["features/vault/vault-broker.py", "--selftest"], 29)


def t108():
    """Intelligent sleep/wake: decide before probing; sleep only when idle (50 checks).

    The keep-alive cron used to probe the public console URL every 5 min,
    which WAKES a paused machine — so the machine never idle-paused, ran
    its full 8-hour max run, then took a ~2-hour cooldown. The fix (2026-11-17):
    the tick DECIDES before it probes, using D1 state; it sleeps only when
    every guard passes and wakes 5 min before a schedule.

    Drives the REAL keep-alive Worker (worker/src/index.js) with a mock D1
    + mock fetch. Asserts:
      (a) nextRun: daily 07:00 IST (same-day + next-day), weekly Monday,
          every-30-min steps; bad cron / bad timezone THROW (never a silent
          wrong time);
      (b) decideSleepWake (pure): idle -> sleep; unknown nextRoutineAt /
          stale reporter / recent visit / recent agent work / short uptime /
          manual rest / machine down / in-flight transition / woken <20 min
          ago -> hold; routine due in 8 min + machine down -> wake; routine
          due in 8 min + machine up -> hold; routine due in 30 min -> sleep
          (it will wake in time); overdue routine -> wake (never sleep past
          a routine);
      (c) POST /report: valid token -> 200 + stored in D1 meta; wrong/no
          token -> 401; bad JSON -> 400; REPORTER_TOKEN unset -> 503;
      (d) GET /sleepwake/state: next routine is the 07:00 daily summary
          (source d1), reporter fresh, no secret leaks; no routines + no
          report -> nextRoutineAt null (unknown, not Infinity);
      (e) the cron tick: idle -> calls Pages /api/machine/sleep exactly
          once and does NOT probe the console, sleep state 'sleeping';
          routine due -> probes (wake) and does NOT suspend, state
          'running'; sleeping + nothing due (STALE reporter — a truly
          sleeping machine's reporter is asleep too) -> no probe, no
          suspend; sleeping + FRESH reporter (the stuck state) ->
          reporter_up recovery flips the state to running and probes,
          no suspend; stale reporter -> no suspend, probe (stay awake).
    The 2026-11-19 reporter_up change: the "sleeping + nothing due"
    case used to carry a 1-min-old report and still expect no probe —
    that expectation encoded the stuck-state bug (a fresh report +
    "sleeping" is contradictory), so the case now uses a 30-min-old
    report and the fresh-reporter variant is asserted separately.
    The live half (idle -> the machine actually suspends; wake 5 min
    before the 07:00 daily summary; wake-on-visit shows progress) is
    verified by Muse at deploy time — see features/sleepwake/README.md.
    """
    return _harness("features/sleepwake/harness-sleepwake.mjs", 50)


def t109():
    """The sleep/wake reporter: next native run + agent activity (12 checks).

    Machine-free selftest of features/sleepwake/reporter.py. Asserts the
    cron next-run (daily 07:00 IST same-day + next-day, weekly Monday,
    every-30-min steps), that a bad cron raises (never a silent wrong
    time), ISO parsing, the report shape (all four keys, uptimeSec is null
    — unknown, not invented), that the report is null for nextNativeRun
    when jobs.json is empty, and that the reporter sends its own
    User-Agent (Cloudflare blocks Python-urllib's default with 1010).
    The live reporter (systemd timer, POST /report, the machine actually
    reporting agent activity) is verified by Muse at deploy time — see
    features/sleepwake/README.md.
    """
    return _py_script_harness(["features/sleepwake/reporter.py", "--selftest"], 12)


def t110():
    """Settings Reset: the broker's HTTP surface (43 checks).

    Machine-free harness (features/reset/harness-reset.mjs) that starts the
    REAL reset broker (stdlib Python) on 127.0.0.1 with RESET_ROOT=<tmpdir>
    over a fake tree (fake chats.json, a REAL sqlite history.db,
    screenshots, auth.json, .env, kilo.json, an escaping symlink to /etc).
    Groups: (a) auth — anon/wrong token -> 401 on preview and execute,
    unknown category -> 400; (b) preview — 200, per-category bytes/files,
    plan_id stable across identical previews, changes after touching a
    file, zero categories -> 200 with zero bytes, models excludes the
    active provider; (c) confirmation — execute without confirm/ack/
    plan_id -> 400 and nothing deleted, stale plan_id -> 409 plan_changed
    and nothing deleted, lowercase confirm -> 400; (d) idempotency — same
    X-Request-Id returns the cached report and deletes nothing new, a
    re-run is ok with 0 bytes; (e) partial failure — a history.db that is
    a directory makes its db_clear fail, the category reports partial,
    the run is 207, and the other targets in the same category still run;
    (f) concurrency — two simultaneous executes, one succeeds, one gets
    409 busy; (g) happy path — execute all safe categories, bytes_freed
    equals the preview exactly, and auth.json, .env, kilo.json,
    active_model.json, audit.db, reset.log and the escaping symlink all
    survive. Three real bugs found by this harness, all fixed in the same
    commit: a keep-alive desync (a 401 returned without reading the body
    corrupted the next request on the connection, answered 501), a
    threading.Lock that serialized the flock so the second execute waited
    instead of getting 409, and a preview double-count of MEMORY.md when
    both memories and lessons were selected. The live half (preview with
    zero categories against the real machine, a rehearsal execute on a
    copy of the real tree, one real category live) is run by Muse at
    deploy time — see features/reset/README.md.
    """
    return _harness("features/reset/harness-reset.mjs", 43)


def t111():
    """Settings Reset broker: allowlist guard + category table (20 checks).

    Machine-free selftest of features/reset/reset-broker.py (which also
    tests reset_guard.py and reset_categories.py). Asserts the guard
    rejects auth.json, .env, kilo.json, active_model.json and audit.db,
    rejects /etc/passwd and ../../etc/passwd escapes, rejects an escaping
    symlink and a path through it, allows a normal deletable path, and
    that the tree is byte-identical after all the rejections; and that
    the category table excludes the active provider from models, never
    lists active_model.json, excludes MEMORY.md and skill.json from
    workspaces, maps lessons to a section rewrite (not a delete), raises
    on an unknown category, and that lessons is superseded by memories.
    The live half (the broker running under systemd with ProtectSystem=
    strict, the Pages /reset route, the UI confirmation flow) is run by
    Muse at deploy time — see features/reset/README.md.
    """
    return _py_script_harness(["features/reset/reset-broker.py", "--selftest"], 20)


def t112():
    """Screen retry on failure (B-47, 17 checks).

    Machine-free harness (features/computer/harness-screen-retry.mjs) for
    the fix that makes the `failed` branch of the /computer message handler
    retry through the bounded scheduleReconnect() instead of only showing
    the error. The capability URL is minted once and lives 10 minutes; after
    that a WebSocket drop makes noVNC reconnect with the expired URL, the
    Worker answers 403, and the shim posts failed. loadScreen() re-mints,
    so the retry gets a fresh URL. Static checks on the real ui.html: the
    failed branch calls scheduleReconnect() and still records the specific
    error first; scheduleReconnect() is single-flight (reconnectTimer) so
    the three iframes posting one failure cannot burn three budget units;
    the budget is enforced; the exhausted branch preserves a specific error
    instead of overwriting it with the generic "closed repeatedly" wording;
    the connected branch clears the pending timer. Dynamic checks: the real
    scheduleReconnect is extracted and run in a VM with mocks — three
    simultaneous calls schedule exactly one retry, firing it calls
    loadScreen once and frees the slot, a later failure schedules fresh,
    and at the budget no further retry is scheduled. Fail-first proven:
    against the unfixed ui.html it fails 9/17. The live half (leave the
    page open past 10 minutes, trigger a reconnect, confirm the error is
    gone) is run by Muse in a real browser — see BUGS.md B-47.
    """
    return _harness("features/computer/harness-screen-retry.mjs", 17)


def t113():
    """Routines daily-summary slot always probes (B-47 follow-up, 9 checks).

    Machine-free harness (features/routines/harness-routines-slot.mjs) that
    replays the exact live instant from 2026-11-18 07:00:27 IST against the
    real routines worker module. The daily-summary slot (cron "30 1 * * *")
    fires AT the routine time, but by then rtNextRoutine has already rolled
    to tomorrow, so the 15-min skip rule recorded both 07:00 slots as
    "skipped" live — a silent miss if the keep-alive wake ever failed. The
    fix makes the slot always probe (bypassing only that one skip branch).
    Asserts: the slot at 07:00:27 probes (machine up, HTTP 200, one fetch),
    its kind is daily-summary-slot; the wake-tick at the same instant still
    skips (zero fetches); a wake-tick 15 min before the routine still
    probes; a slot with no routines still skips (zero fetches). Fail-first
    proven: with the fix stashed it fails 3/9 and reproduces the exact live
    "skipped" entry. The live half (tomorrow's 07:00 slot must show the
    daily-summary slot probing, not "skipped") is verified by Muse from
    /api/history after deploy.
    """
    return _harness("features/routines/harness-routines-slot.mjs", 9)


def t114():
    """AgentX rebrand (DOM injection, 205 checks).

    Machine-free harness (features/rebrand/harness-rebrand.mjs) for the
    AgentX rebrand (features/rebrand/README.md). Static checks on the real
    pages/public/_worker.js: the fetch patch targets exactly the PyPI
    update-check URL (and only it) and returns the pinned version 2.3.0;
    the window.open patch swallows exactly the two upstream hosts
    (qwenpaw.agentscope.io, github.com/agentscope-ai/QwenPaw); the kill
    switch exists at both layers (worker env AGENTX_REBRAND=0 and
    ?rebrand=0 at runtime); the rule table has 44 rules and each runs in
    its own try/catch with a console.debug naming the rule; the menu/China
    rules hide by accessible name (aria-label/title/alt) and climb to the
    whole button/card container; the China climb is structural and never
    returns the list container (agentxClimbToChinaCard: the card is the
    direct child of the provider list / channel grid, or the first
    ancestor whose lowercased class names the card itself) and the
    hide-china rule uses it; the hide-by-name matching is case-insensitive
    (the console renders "XiaoYi" and the channel icon img alt is the
    lowercase id "xiaoyi"); the About click is a delegated capture
    listener with a prefix match that opens /status; the title is watched
    by its own MutationObserver on the <title> element; the logo rule
    replaces the QwenPaw img with an AgentX text label; the CSP-Report-Only
    + Referrer-Policy headers are set on the console HTML and the <title>
    is rewritten; the shim is injected before the panel script and the
    observer calls the rebrand pass; the keep-alive and activity-feed
    Workers report the note "AgentX console answered". Dynamic checks in a
    VM with mocks: the real shim (extracted from the file, run with the
    file's own constants) stubs the PyPI fetch while other fetches pass
    through, swallows upstream window.open while other opens pass
    through, and stays unpatched under ?rebrand=0; the real rebrand
    rules (extracted between the AGENTX-REBRAND markers, run against a
    mock DOM) rename the title and a visible text node, hide a Tutorial
    and a GitHub menu item (but not Settings), hide icon-only buttons
    matched by accessible name as whole buttons, leave a load-bearing
    instruction alone, rename an aria-label, hide the China cards on the
    REAL card DOM (hashed CSS-module classes from the live bundle: a
    DashScope / SiliconFlow / ModelScope / Aliyun provider card as a whole
    card, an Alibaba Cloud card matched only by its settings-button
    aria-label and a SiliconFlow card matched only by its icon img alt,
    a WeCom / DingTalk configured channel card and a Feishu / QQ / WeChat
    available-channel button, a XiaoYi / Yuanbao channel as an available
    button and as a configured card, and a XiaoYi channel matched only
    by its icon img alt "xiaoyi"), do NOT hide a non-China provider
    (OpenAI, DeepSeek, Anthropic) or a non-China channel (Telegram,
    Slack, iMessage), do NOT hide the provider list container or the
    channel grid, and hide the China cards when the provider list mounts
    after the initial pass (async mount), rename the About item
    ("About QwenPaw v2.3.0" → "About AgentX v2.3.0") and make clicking it
    open /status, replace the sidebar logo img with an "AgentX" text
    label, rename a title change immediately via the title observer, and
    block an upstream link click while letting a same-origin link through.
    Fail-first proven: against the unmodified _worker.js it fails 49/51
    (the 2 that pass check for the absence of a rebrand section,
    vacuously true on the original file); after the 2026-11-18
    browser-verification fixes, the extended harness fails 22/69 against
    the pre-fix code and passes 69/69 after; after the 2026-11-18
    China-card fix, the extended harness fails 13/86 against the pre-fix
    code (the 2 static China-climb checks, the 6 provider-card hides, the
    list over-hide, the 3 available-channel buttons, the async mount) and
    passes 86/86 after; after the 2026-11-18 XiaoYi/Yuanbao channel fix,
    the extended harness fails 7/93 against the pre-fix code (the 2
    static checks — the China-hide list and the case-insensitive match —
    and the 5 XiaoYi/Yuanbao hides) and passes 93/93 after; after the
    2026-11-19 smart-sleep rebrand gaps (22 net new rules: footer,
    block-links-v2, hide-powered-by, hide-feedback, settings-about,
    settings-language, settings-providers, settings-integrations,
    hide-upgrade, account-card, workspace-switcher, sidebar-help,
    model-labels, title-observer, head-rebrand, export-rebrand,
    hide-run-in, auth-rebrand, error-rebrand, hide-onboarding,
    hide-update-banner, hide-shortcuts-dialog; plus the merges
    thinking-text into thinking-selector, toast-text into rename-text,
    rename-attrs broadened to alt + data-tooltip, rename-logo broadened
    to title/aria-label elements), the extended harness fails 54/174
    against the pre-Part-3 code and passes 174/174 after. The
    settings-white-area rule (2026-11-19: the outer settings <main>
    renders ~819px tall in a 998px viewport on Pages, so a ~179px white
    body strip shows below its cream; round 1 stretched the
    nav-anchored shell to 100dvh and painted <html> + <body> with the
    shell's own computed background — browser-verified PARTIAL:
    cream ends ~894, ~104px strip left in light mode, dark filled.
    Diagnosis from the SERVED console bundle (index-tgCT4NPx.css):
    the shell is a .page-content whose background is var(--app-surface),
    white in light mode, so round 1 copied white onto the body; and
    the shell alone cannot beat the .ant-layout max-height:100vh +
    overflow:hidden clip. Round 2 paints from the console's --app-bg
    theme variable (#f9f8f4 light / #141414 dark, class fallback when
    the variable is missing), never from the shell or any ancestor,
    with !important, stretches the shell AND its ancestors to 100dvh,
    and records a diagnostic probe (window.__agentxSettingsDiag +
    body[data-agentx-settings-diag]) for the browser check; 12 checks:
    fail-first 190/198 against the round-1 rule, 198/198 after the
    rewrite. Round 3 (2026-11-19 ~09:0x IST): the round-2 browser
    check showed ZERO change — the strip stayed ~104px even though
    the new code shipped; diagnosis from the SERVED console bundle
    (index-tgCT4NPx.css): the shell (.page-content) is transparent
    inside a WHITE full-height .index-module__mainContentLayout
    wrapper (background:var(--app-surface)) that covers the
    <html>/<body> paint, so the rule now paints the shell AND every
    ancestor with the theme paint and writes a TEMPORARY visible
    diagnostic line (elementFromPoint strip probes) readable as page
    text; 7 new checks (2 static + 5 dynamic: the realistic-DOM
    light/dark paint, the diag line, its no-duplicate re-run, and
    the ancestor-paint cleanup; T114 198 → 205, T144 12 → 19):
    fail-first 198/205 against the round-2 rule, 205/205 after the
    rewrite). Round 4 (2026-11-19 ~09:0x IST): the round-3 browser
    check read the diagnostic line (rule=ran, shell h=998, body/html
    bg rgb(249,248,244)) and confirmed the fix — light mode cream to
    y=998, 0px strip, top and max scroll; dark filled. The AX-DIAG
    line and its probe are removed here; the paint + stretch are
    untouched (T114 205, T144 19 — the 7 diag checks become
    no-diagnostic checks; fail-first 198/205 against the round-3
    rule, 205/205 after the removal). The rule
    table grew 42 -> 44 with queue-takeover (multi-tab takeover
    affordance, post-reset cron Step 10; its own tests live under
    features/queue-takeover, only its presence is asserted here). The
    live half (a real browser on the deployed console) is verified by
    Muse after deploy.
    """
    return _harness("features/rebrand/harness-rebrand.mjs", 205)


def t115():
    """Loop-gate fix: tool-call budget counts once, applies by default.

    Machine-free unit test (features/loop-gate-fix/test_gate.py, 47
    checks) for ToolCallBudgetGate. It builds a minimal fake qwenpaw
    package and drives the gate with fake agents whose context mimics
    the parent's merged-message behaviour. The old gate added the
    latest (cumulative) message to its total once per round, so the
    reported total inflated 50 -> 150 -> 300 and it fired with a wrong
    count; a stale last_iteration could skip a count entirely. The fix
    recomputes the turn total from the reply-scoped blocks on every
    check. Round 2: the gate also expands a run_tool_batch call into
    its sub-calls (from its arguments, inline actions or the JSON batch
    file) and counts a completed batch from its result JSON when its
    call could not be expanded, so the batch runner cannot bypass the
    budget. Round 3: the budget is enforced at execution time
    (try_reserve_execution, called from ReactAgent._execute_tool_call
    before the first await), so a single response carrying 200 direct
    parallel calls executes only the first 20 (per-tool shell cap) or
    30 (total cap) and refuses the rest -- the gate alone cannot stop
    a single-response burst because its TERMINATE is deferred. Fail-
    first proven: against src/pristine/limits.py it fails 29/47;
    against src/gatefix1/limits.py it fails 25/47 (H + I); against
    src/gatefix2/limits.py it fails 11/47 (only I -- the live
    single-response burst, 200 executed); against
    src/patched/limits.py it passes 47/47. The default-chain wiring
    (mode.py + config.py) and the react_agent.py funnel change are
    verified inside the derived image before deploy, not here. The
    live half (a real browser, fresh ordinary chat, no /guarded: echo
    1-200 stops after ~20 executed calls, the per-tool shell cap, not
    200) is verified by Muse after deploy.
    """
    return _py_harness("features/loop-gate-fix/test_gate.py", 47)


def t116():
    """TinyFish free search + fetch: Settings-based key, request-building,
    fallback, feature flags, and the Settings "Your Keys" section (147 checks:
    108 skill selftest + 39 UI harness).

    Machine-free selftest (features/tinyfish/test_tinyfish.py) for the
    tinyfish skill's rules. The key is an env var (TINYFISH_API_KEY) set
    by the user in Console -> Settings -> Environments — NOT a vault
    item (the vault holds only connectors). The skill reads it from
    os.environ at runtime with python3 (stdlib urllib), so the key never
    appears in a command string, argv, or log, and it is deliberately NOT
    declared in require_envs (a skill whose declared env vars are unmet
    is skipped for the turn, which would break the fallback). It builds
    the TinyFish search URL (root path on api.search.tinyfish.ai, the
    path the official SDK uses) and the fetch body (1-10 urls,
    markdown/html/json), the DuckDuckGo Instant Answer url (the only DDG
    surface that works from this box — the HTML and lite endpoints are
    anomaly-blocked), the env-based fallback decision (key present ->
    TinyFish, absent -> built-in web_search/web_fetch exactly as now),
    the feature flags (TINYFISH_SEARCH / TINYFISH_FETCH / TINYFISH_DDG_IA,
    absent means on, the built-in is never a flag), and the error mapping
    (401/402/429/404/5xx). No network: it only builds requests and
    decides. The live half (a real TinyFish call) needs a real key in
    Settings and is NOT verified here.

    Node harness (features/tinyfish/test_search_settings_ui.mjs) for the
    Settings "Your Keys" section (pages/public/search-settings-ui.js): the
    section saves via PATCH /api/envs (never PUT), removes each key via
    DELETE /api/envs/<KEY>, each key field is a password input with
    autocomplete="new-password", the key values are never rendered into
    the DOM or logged, the section mounts once after the Environments
    heading (and is a safe no-op without a Settings anchor, and a safe
    no-op on the chat page — the old <main> fallback put it at the
    bottom of the chat view), it self-mounts on SPA navigation with a
    throttled MutationObserver, it injects its own scoped styles, and
    pages/public/_worker.js routes /search-settings-ui.js to the Pages
    assets and injects the module script into the console HTML (an
    unrouted <script src> would fall through to the console proxy and
    parse as nothing, B-35). The section holds both keys the user
    enters in Settings — TinyFish (Monid) TINYFISH_API_KEY and Drex
    (NACE) NACE_API_KEY — each with what it is for, plus the search
    feature flags.
    Fail-first proven: the skill selftest fails 7/108 against the old
    vault-based SKILL.md, and the UI harness fails 2/27 before the
    _worker.js wiring lands (and 3/22 against a PUT instead of PATCH,
    2/22 against a buildSaveBody that always sends the key).
    """
    s1, m1 = _py_script_harness(
        ["features/tinyfish/test_tinyfish.py", "--selftest"], 108)
    s2, m2 = _harness("features/tinyfish/test_search_settings_ui.mjs", 39)
    good = s1 == "PASS" and s2 == "PASS"
    return ("PASS" if good else "FAIL",
            f"skill selftest: {m1} | search UI: {m2}")


def t117():
    """Memory facts: compact fact store + session handoff (41 checks).

    Machine-free selftest (features/memory/test_facts.py) for the
    Mem0-style extract-and-retrieve store (features/memory/facts.py).
    It builds a throwaway memory.db and asserts: extraction proposes the
    salient facts from a sample conversation (decision, preference, task,
    measurement, the TinyFish key rule) and skips trivia/tool noise;
    retrieval ranks the relevant fact first, runs in < 100 ms, and costs
    <= 500 tokens for 5 facts (and < 10% of the full history text);
    a handoff written by session A is read by session B with the open
    tasks + where A left off, in <= 300 tokens; adding the same fact
    twice returns the same id (add-only dedup); superseding marks the
    old row and never deletes it, and search excludes it by default;
    a fact containing a credential is rejected with no row written;
    universal search returns facts AND reaches back into history.db
    read-only. Fail-first proven: the test fails with ModuleNotFoundError
    before facts.py exists. The live half (store created on the machine,
    a fact written and retrieved, a handoff written by one session and
    read by the next) is verified by Muse from the machine after sync.
    """
    return _py_script_harness(
        ["features/memory/test_facts.py", "--selftest"], 41)


def t118():
    """Bloat win-win: Alibaba telemetry phone-home removed (26 checks).

    Machine-free test (features/bloat-winwin/test_bloat_winwin.py) for
    the telemetry removal. The patch replaces qwenpaw/utils/telemetry.py
    and qwenpaw/utils/daily_telemetry.py with stubs that keep every
    public name the rest of the codebase imports, as safe no-ops, with
    no endpoint constant, no network code, no sender thread, and no disk
    writes. Asserts the stubs load standalone (stdlib-only), expose the
    same public names, never reference the telemetry endpoint or httpx,
    and never start a thread or write a file. Fail-first proven: the
    pristine upstream files import ..__version__ / ..constant / httpx
    relatively and cannot even load standalone, which the test records
    as failed checks. The live half (the derived image
    qwenpaw-agentx:2.3.0-bloatwinwin1 built from gatefix3, telemetry
    endpoint hits 0, no telemetry thread, console 200) is verified by
    Muse after deploy.
    """
    return _py_script_harness(
        ["features/bloat-winwin/test_bloat_winwin.py"], 26)


def t119():
    """Bloat win-win data layer: VACUUM, WAL checkpoint, PNG, log rotate (15).

    Machine-free test (features/bloat-winwin/test_bloat_winwin_data.py)
    for the data-layer work done on the live machine 2026-11-18 with no
    source change. Runs against temporary test databases / files only;
    it never touches the live working tree. Asserts VACUUM preserves
    every row and the FTS index (and that a freelist-0 database barely
    shrinks, so the history file IS the history), WAL checkpointing
    reclaims the WAL, PRAGMA journal_size_limit is per-connection (a
    fresh connection reads -1, so it does not bound future WAL growth),
    PNG recompression is lossless (pixel-identical), and log rotation
    verifies the archive before truncating (a failed archive leaves the
    live log untouched). The live measurements (history.db 980 rows
    preserved, ~8.9 MB reclaimed, the log-loss incident) are recorded
    in features/bloat-winwin/DATA_LAYER.md.
    """
    return _py_script_harness(
        ["features/bloat-winwin/test_bloat_winwin_data.py"], 15)


def t120():
    """Memory facts v2: multi-signal retrieval, entities, time travel (40).

    Machine-free test (features/memory/test_facts_v2.py) for the v2
    memory store (features/memory/facts.py). Multi-signal retrieval
    (BM25 + entity overlap + importance, weighted reciprocal rank
    fusion) so a fact about the same project or person ranks up even
    when the keywords are thin; rule-based entity extraction (stdlib
    only, auto-populated on add, backfill-entities for older facts);
    temporal validity windows (valid_from / valid_to, search --as-of
    DATE). Asserts the entity boost, the RRF fusion, the temporal
    queries, and the v1 -> v2 migration (schema 2, valid_from
    backfilled, no fact or handoff lost). Fail-first proven: against
    the v1 facts.py it fails with AttributeError (no extract_entities).
    Deliberately NOT added: semantic/vector search (needs an embedding
    model/key — a user decision), sleep-time consolidation, a graph DB.
    The live half (live memory.db migrated v1 -> v2, search returns
    fused_score + entity_overlap in 0.22 ms) is verified by Muse after
    sync.
    """
    return _py_script_harness(
        ["features/memory/test_facts_v2.py"], 40)


def t121():
    """Mechanical checks: no China endpoints, no secrets, AGENTS.md budget, no polling (14).

    Machine-free test (features/test-project/test_checks.py) for the
    mechanical checks in scripts/checks/ (run-checks.sh). Proves, for
    each check, that it PASSES on the current repo and FAILS on a file
    that violates the rule (fail-first, using a temporary directory as
    the check's ROOT so the real repo is never touched): a ModelScope
    endpoint URL and a Function Compute host fail the China-endpoints check
    while bare provider names pass; a ghp_ + 36-char key and an AKIA +
    16-char key fail the secrets check while a short ghp_ fragment
    passes; the AGENTS.md budget check fails at a 100-char cap and
    passes at 20000; a setInterval in _worker.js fails the polling
    check while the waking-page elapsed timer (the documented
    allowlist entry) passes. The checks enforce AGENTS.md §3
    mechanically: a convention that lives only in prose gets violated
    within a week; a rule + a check survives. The live half (the
    checks run on PR + before a push) is a repo discipline, not a
    machine state — nothing to verify live.
    """
    return _py_script_harness(
        ["features/test-project/test_checks.py"], 14)


def t122():
    """Plan mode: read-only plan before any mutation (43).

    Machine-free test (features/plan-mode/test_plan_mode.py --selftest)
    for the plan-mode enforcer (features/plan-mode/plan_mode.py):
    ToolGate refuses mutating calls naming the tool, the plan file
    carries the five required sections, nothing executes before
    approval, and after approval only the plan's steps run, in order
    and at most once, with each approved step id bound to its tool and
    (for bash) its exact command. Fail-first proven: --gate permissive
    (prompt-only, no enforcer) fails 20/43. DeepSeek design review
    2026-11-18 (10,469 tokens) found 12 findings; 9 fixed. The live
    half (agent loop calling PlanMode.enforce() before dispatch,
    plan-mode skill enabled) is verified by Muse after deploy.
    """
    return _py_script_harness(
        ["features/plan-mode/test_plan_mode.py", "--selftest"], 43)


def t123():
    """Egress guard: untrusted-content wrapping + allowlist (35).

    Machine-free test (features/egress-guard/test_egress_guard.py)
    for the egress guard (features/egress-guard/egress_guard.py):
    the wrapper marks fetched content as untrusted in a nonce-fenced
    block and strips forged chat-template tokens; the allowlist guard
    denies non-allowlisted hosts, denies secret-shaped strings even
    to allowlisted hosts, and denies China hosts even if allowlisted,
    while allowing legitimate requests to allowlisted hosts; the
    redactor scrubs fake ghp_ / github_pat_ / sk- / AKIA strings
    while a commit SHA and a UUID survive. Fail-first proven:
    --impl none fails 26/35. The live half (wiring into the TinyFish
    skill, web_fetch, and the broker /run, then a browser check
    against a poisoned page) is verified by Muse after sync.
    """
    return _py_script_harness(
        ["features/egress-guard/test_egress_guard.py"], 35)


def t124():
    """SMART approval patch + per-tool preview + Allow/Block list (40).

    Machine-free test (features/approvals/test_approvals.py) for the
    SMART apply-script (agent.json AUTO -> SMART, idempotent,
    destructive auto-deny verified read-only), the preview builder
    (exact shell command / unified diff, never executes), and the
    Allow/Block enforcement (low-risk auto, medium ask, destructive
    deny, deny-listed tool refused under SMART and under OFF).
    Fail-first proven: against an empty approvals dir it fails 37/40.
    DeepSeek review 2026-11-18: 5 findings, all fixed, 8 regression
    checks (F1-F8). The live half (script run on the machine,
    approval_level SMART confirmed via running-config; preview/policy
    wired into the approval-card path in a derived image and checked
    in a real browser) is verified by Muse after sync/deploy.
    """
    return _py_script_harness(
        ["features/approvals/test_approvals.py"], 40)


def t125():
    """Cost ledger with hard kill switch: per-run + cumulative tokens/cost (55).

    Machine-free test (features/cost-ledger/test_cost_ledger.py) for the
    token/cost ledger: ledger math on a hand-computed sample (350,000 prompt
    / 110,000 completion / 460,000 total / 23 calls / $0.57), 80% alert at
    exactly 80,000/100,000 tokens and not at 79,999, 100% hard stop refuses
    a simulated model call with pre-call reservations, budget raise unblocks,
    derived-image patch applies cleanly and reproduces the patched files
    byte-for-byte. Fail-first proven: --no-cap fails 6/34 (the alert/denial
    checks). The live half (image build, machine deploy, live /api/cost,
    real deny at 100%) is verified by Muse after deploy.
    """
    return _py_script_harness(
        ["features/cost-ledger/test_cost_ledger.py"], 55)


def t126():
    """Per-task cap + structured stop audit + rebuild persistence (117).

    Machine-free test (features/loop-gate-fix/test_task_cap.py) for the
    round-4 per-task cap, the round-5 (gatefix5, T140) persistence, and
    the round-6 (gatefix6, T141) realistic resume messages: task budget
    60 total / 40 shell across turns, finalise flag, structured stop
    audit. J — the live cross-turn shape (turn 1 spends 20 shell, turn
    2 "hello" gets 20 more to task shell 40 = cap and finalises, turn
    3 "hello" executes 0, a new instruction gets a fresh budget); K —
    sub-cap creep; L — the stop audit (all four kinds); M — explicit
    task id, re-issued capped instruction inherits the spent budget;
    N — unreadable batch charged from the result JSON; O — a batch that
    would jump the task cap is refused whole; P (T140) — the per-turn
    agent rebuild: the runtime builds a fresh agent per turn, so the
    task budget must persist through the state_dict round-trip (turn 2
    gets 20 more to 40 and finalises, turns 3 and 4 execute 0); Q
    (T141) — realistic resume messages: "hello, are you working?" and
    "Yes, continue from 21" resume the current task (prefix match at a
    word boundary), "continue" executes 0 after finalisation, a new
    instruction after finalisation mints a fresh task. Fail-first
    proven: against gatefix3 limits.py it fails 63 checks (45 passed;
    9 Q2 checks do not run — _is_continuation does not exist on
    gatefix3); against gatefix4 limits.py it fails 25/117 (P+Q);
    against gatefix5 limits.py it fails 11/117 (Q only). T115 still
    47/47. The live half (single-turn echo test, cross-turn "hello"
    test, new-instruction test) is verified by Muse after deploy.
    """
    return _py_script_harness(
        ["features/loop-gate-fix/test_task_cap.py"], 117)


def t127():
    """Checkpoints + rollback: per-run workspace snapshot + safe restore (48).

    Machine-free test (features/checkpoints/test_checkpoints.py) for the
    per-run snapshot tool (features/checkpoints/checkpoints.py): tarball +
    JSON manifest (per-file sha256/size/mode, tarball sha256) tagged with
    the run ID, taken before the first mutation; a second snapshot with the
    same run ID is a first-wins no-op. Restore returns the exact original
    bytes, REFUSES on drift without --force and leaves the workspace
    untouched, proceeds with --force and prints what will be lost; every
    restore takes an automatic pre-restore safety snapshot so a restore is
    reversible. Excludes history.db*, sessions/, media/, logs, caches,
    node_modules, .git, and the store itself. Fail-first proven: against
    a stub with no implementation it fails 29/37 checks that run.
    The live half (snapshot + restore on the real workspace, list on the
    real store) is verified by Muse after sync.
    """
    return _py_script_harness(
        ["features/checkpoints/test_checkpoints.py"], 48)


def t128():
    """MCP client: stdio + streamable HTTP, allowlist, namespacing (61).

    Machine-free test (features/mcp-client/test_mcp_client.py) for the
    MCP client (features/mcp-client/mcp_client.py): stdio + streamable
    HTTP transports (JSON-RPC 2.0, protocol 2025-03-26), servers disabled
    by default, per-server tool allowlist (default none, `*` rejected at
    load), namespaced tools `mcp.<server>.<tool>`, HTTP egress limited to
    declared hosts (redirects refused, env proxies ignored, private
    addresses refused unless declared loopback), no auto-install. Proves
    stdio connect/list/call, allowlist refusal naming server + tool with
    the mock's call log proving the call never arrived, disabled-by-default
    spawning no process, namespacing with two servers sharing a tool name,
    HTTP egress refusals with zero requests reaching the listener, and
    transport edge cases (timeout tears down, crash fails fast, 1 MB
    stderr no deadlock, colliding server ping answered, out-of-order
    replies correlated by id). Fail-first proven: 0 passed, 1 failed
    (ModuleNotFoundError) before `mcp_client.py` existed. The live half
    (a real MCP server connected, client wired into the agent loop through
    the registry) is verified by Muse after sync.
    """
    return _py_script_harness(
        ["features/mcp-client/test_mcp_client.py"], 61)


def t129():
    """Skills as progressive-disclosure packages + self-written skills (46).

    Machine-free test (features/skills/test_skills_packages.py) for gap
    #10: (a) a skill with valid frontmatter passes the scanner and appears
    in the index with only name/description/when-to-use/allowed-tools;
    (b) a skill missing frontmatter FAILS the scanner; (c) a skill
    invoking a tool outside its declared allowed-tools list is flagged by
    scope enforcement; (d) the self-written writer drafts a valid skill
    from a demonstrated task transcript (steps + checks + when-to-use
    present) and it passes the scanner, including a guidance-only draft
    (allowed_tools: []); (e) the writer REFUSES a draft that needs a
    secret or a China endpoint, or has unbounded scope; (f) the index
    builder loads only the index (no body text). Fail-first proven: 13
    of the 46 checks fail against the pre-change scanner. DeepSeek design
    review 2026-11-18 (17,647 prompt + 5,361 completion tokens) caught
    six issues, all fixed: body-only scope (helper scripts now covered),
    backslash-continuation hole, unknown binaries in shell blocks,
    guidance-only refused, over-broad secret refusal, narrow vault
    mediation — plus three narrowed false positives. The live half
    (converting the 20 pool-only skills, wiring the agent to load the
    index, first draft installed from the writer) is verified by Muse
    after deploy.
    """
    return _py_script_harness(
        ["features/skills/test_skills_packages.py"], 46)


def t130():
    """Drex decision model: NACE endpoint configurable, slot fragment (21).

    Machine-free test (features/decisions/test_drex.py) for the Drex
    wiring: decide.py reads NACE_BASE_URL (arg > env > default,
    https-or-loopback only), per-provider scoping (a stray NACE_BASE_URL
    can never retarget Jev), decision_model_drex.json fragment
    {provider_id: nace, model: drex-max-v1.1}, apply script dry-run
    default + key-gated, live-test script fails closed without a key
    (exit 2). Fail-first proven: 8 passed / 12 failed (env override +
    fragment/scripts missing). T84 still 33/33. NOT verified live: no
    real NACE call (no key yet); 'nace' provider registration in the
    deployed image unverified; calibration unverified.
    """
    return _py_script_harness(
        ["features/decisions/test_drex.py"], 21)


def t131():
    """Telegram full-feature bot: token-only setup, menus, chats (66).

    Machine-free test (features/telegram-full/test_telegram_full.py)
    for the Telegram integration: token-only setup-check (safe flags
    enforced, no numeric id), owner = first whitelist entry with
    guests read-only and strangers refused, new chat clears the
    pinned session, list + preview + continue an existing console
    chat (task API, 409 busy, last-10 preview only), a settings
    change via a button callback (model PATCH validated against the
    Settings provider catalog, approval PUT), the menu grammar
    (<=64 bytes, tga:/tgd: reserved, dots/slashes allowed for model
    names), the per-chat token cache (15-min TTL, 200 cap), outbound
    redaction (bot-token shape + known keys + vault reveal refused)
    and inbound untrusted wrapping (forged END marker broken), and
    the driver patch applying cleanly to the pristine v2.3.0
    platform.py (sha256-pinned) and reproducing the patched file
    byte-for-byte. Fail-first proven: the first run failed with
    ModuleNotFoundError (no modules yet); the pristine file has no
    menu routing. The live half (image build on the machine, skill
    enable, token in Settings, pending flow, real DM + model tap +
    chat continue + guest refusal in a browser) is verified by Muse
    after deploy.
    """
    return _py_script_harness(
        ["features/telegram-full/test_telegram_full.py"], 66)


def t132():
    """Approval TTL: pending approvals + secret requests expire (41 + 28).

    Machine-free tests (features/approval-ttl/test_approval_ttl.py,
    41 checks, and features/approval-ttl/test_wiring.py, 28 checks)
    for the port of gogibeta/rakazo PR #50 (F6): issue stamps
    expires_at (approval 24h, secret 1h, question never), env
    overrides with the fork's fallback rule (bad values fall back to
    the default, never expire instantly), read is pure and fails
    closed (an expired card reads as denied with reason "timed out",
    boundary now == expires_at counts as expired, legacy items never
    auto-deny), answer refuses a late answer with ExpiredError after
    persisting the expired state (terminal state is sticky, a clock
    rollback cannot resurrect a card, a double answer never flips),
    the sweep expires stale cards idempotently (never legacy, a
    post-migration card with no expiry fails closed, fork-shaped
    audit rows, a secret settles like a dismissal), the store
    survives a reload (restart cannot resurrect a stale card), a
    corrupt store raises (never a silent empty store), the file is
    mode 0600, flock serialises every read-modify-write, and the CLI
    sweep/check/issue exit codes. Fail-first proven: 0/41 against an
    empty dir. DeepSeek review 2026-11-18: 6 findings, all fixed
    (endpoint as the single gate, flock + re-read, sticky terminal
    state, pure read, legacy keyed on the missing ttl_version, env
    validated at issue time). The wiring half (test_wiring.py) proves
    the derived-image patch applies cleanly with -p1 and -p2,
    reproduces the patched files byte-for-byte, the patched files
    compile, the approve/deny handlers call ttl_answer() first and
    refuse an expired card with 409 approval_expired, GET /list
    annotates expired cards via ttl_read(), both creation paths stamp
    the expiry via ttl_issue(), and the TTL helpers behave against
    the real ttl.py (loader, issue, answer ok/expired/unknown/
    answered, read incl. terminal-expired normalization). The live
    half (image built + deployed, module synced to the machine,
    sweep timer installed, browser check of an expired card and a
    refused late approve) is verified by Muse after deploy.
    """
    results = []
    for script, expect in (
            ("features/approval-ttl/test_approval_ttl.py", 41),
            ("features/approval-ttl/test_wiring.py", 28)):
        results.append(_py_script_harness([script], expect))
    good = all(status == "PASS" for status, _ in results)
    return ("PASS" if good else "FAIL",
            "; ".join(detail for _, detail in results))


def t133():
    """Ask-before-durable-write: high-stakes memory v2 facts need explicit accept (114).

    Machine-free test (features/memory/durable-write/test_durable_write.py)
    for the all-20 gap #20: gated_add() is the single entry point. A
    rule-based classifier holds high-stakes facts in a pending_facts
    table inside the same memory.db (no row in facts, not searchable);
    routine facts write silently via facts.add_fact with provenance
    gated:routine. propose / accept --id --why / reject --id --why /
    list / check mirror the lessons.py API exactly, with its caps
    reused: max 3 pending, 400 chars per field, --why required,
    PF-001 ids from AUTOINCREMENT (never reused). Accept flushes into
    memory v2 with provenance pending:PF-001; accepted: <why>; reject
    never lands. Secrets are rejected, not scrubbed — and never held
    (checked before any pending insert, re-checked at accept). A full
    pending store refuses the 4th fact loudly and never falls back to
    a routine write. High-stakes = kind preference, preference
    phrasing, identity (name, timezone, contact handles, email, PII),
    credentials-adjacent mentions without a secret value, durable
    language ("from now on", "Always use..."), and identity-field
    contradictions. Routine = measurements, plain observations,
    ordinary updates. Fail-first proven: fails at import on pristine
    code. DeepSeek design review changed the design in 4 places
    (classify on phrasing not just kind; narrow contradiction
    detection to identity fields only; leave facts.py untouched with
    a wrapper CLI; pending table inside memory.db with
    accept-writes-fact-first ordering). No regression: T117 41/41,
    T118 40/40, lessons 45/45 still green. The live half (sync
    durable_write.py to the machine's memory-tools, add the SKILL.md
    routing line, live held-fact -> accept -> searchable round-trip)
    is verified by Muse after deploy.
    """
    return _py_script_harness(
        ["features/memory/durable-write/test_durable_write.py"], 114)


def t134():
    """Serving-model identity note: per-attempt note + switch log (48).

    Machine-free test (features/model-identity/test_model_identity.py)
    for the all-20 gap #17, a port of fork PR #37/#44. Part 1
    (discrepancy verdict, derived from the repo files, not hardcoded):
    the correct source of truth as of the last repo evidence
    (2026-11-15) is mosicn/nex-n2.6; the xingchiapi/gpt-6-astra value
    in features/board/config-patch.md §2 is a stale same-day snapshot
    (true ~01:34 IST, superseded ~02:22 IST when the user switched to
    mosicn after two Astra stream stalls; corroborated by
    cost-data.json 02:46 IST, the audit retest 02:50 IST, the handoff,
    and repeated T38 fleet runs). The per-agent rule still holds (both
    agents' active_model: null, so the global file governs). The phrase
    "no active chat model configured" does exist in the repo
    (features/memory/reme_doctor.py:289) but is a conditional
    diagnostic string, not a live-state claim. Part 2: the identity
    note is stamped per attempt at the dispatch boundary,
    TokenRecordingModelWrapper.__call__, onto a copy of the messages
    (never mutates the live transcript, exactly one note, never
    stacks); wording follows #44 (plain when serving == configured,
    "unavailable (reason_kind)" only with the fallback engine's
    recorded reason, neutral otherwise, same-model-another-key stays
    plain). PATCH /api/agents/{agentId}/model-settings gains an
    optional reason field (popped before applying, never stored on the
    config) and appends {from, to, reason} to
    <workspace>/model-switch-log.jsonl — effective from/to (per-agent
    else global file), no-change switches log nothing, log failures
    can never fail an applied switch. Fail-first proven:
    ModuleNotFoundError before the module existed. The patch applies
    cleanly -p1 and -p2 and reproduces the patched files byte-for-byte,
    and also applies onto cost-ledger's already-patched
    model_wrapper.py (both features coexist, stamp runs first so the
    budget check measures the stamped messages). The live half (live
    re-read of working.secret/providers/active_model.json, image build,
    browser check that the note never leaks into stored messages and
    the agent answers "which model are you?" with mosicn/nex-n2.6,
    live PATCH switch with/without reason, first real fallback) is
    verified by Muse after deploy.
    """
    return _py_script_harness(
        ["features/model-identity/test_model_identity.py"], 48)


def t135():
    """Bot-built Pages 2nd gen: routine refresh loop + publish allowlist (25).

    Machine-free test (features/botpages/routine-loop/test_routine_loop.py)
    for the all-20 gap #15, on top of the shipped bot-built Pages
    (build-page skill, qwenpaw-pages, deploy-page.py). The loop: routine
    fires -> re-read <state-dir>/<slug>.json -> validate -> pure-render
    <pages>/<slug>/index.html -> redeploy the whole pages dir via
    deploy-page.py. Pure render / no drift: render_page() is a pure
    function of allowlisted state (no wall clock, no filesystem reads,
    sorted keys, all values HTML-escaped); a hand edit is overwritten
    on the next run. Idempotent: unchanged state -> a byte-identical
    file, and the deploy is skipped too (a full-snapshot deploy per
    tick would waste Cloudflare API calls); the freshness line uses the
    state's own updated_at, not run wall-clock — a run-time stamp
    would break idempotency. The page says: "Last updated: ... This
    page is a snapshot refreshed by a routine run, not a live view."
    Deploy failure: atomic write (dot-prefixed temp in the same dir,
    byte-verified, os.replace() — never truncate-in-place), then deploy
    with the exit code checked; failure = no new deployment
    (deploy-page.py creates one only as its final step), so the live
    page stays the last good one; failure recorded in
    <state-dir>/<slug>.failures.jsonl with slug + exit code; a
    deploy_failed status makes the next run retry the deploy instead of
    concluding "unchanged". Publish allowlist (fail-closed): unknown
    slug, unlisted state key, missing title/updated_at, non-scalar
    value, secret-shaped value (ghp_/github_pat_/sk-/AKIA...), or a
    value naming working.secret/history.db/auth.json -> nonzero exit,
    page untouched, failure recorded. State, failure log, status, and
    lock live OUTSIDE the pages tree — a state.json under pages/ would
    itself be published (.json is an allowed ext in collect()); check
    21 proves it with the real deploy-page.py collect() over the pages
    dir. A lock serialises render->deploy so two slugs can't race a
    snapshot deploy. No sharing/private-link model (Pages URLs are
    already public; that needs an auth layer, out of scope). Fail-first
    proven: the same test against an empty stub -> 0 passed, 25 failed,
    exit 1. DeepSeek design review (988 prompt / 5,337 completion
    tokens): its two substantive findings were verified against the
    real source and built in (state-outside-pages-tree;
    freshness-vs-idempotency trade-off). The live half (a real routine
    firing the loop, a real deploy-page.py run from the loop, the
    refreshed page served at qwenpaw-pages.pages.dev/<slug>/, the
    allowlist against real workspace state) is verified by Muse after
    deploy.
    """
    return _py_script_harness(
        ["features/botpages/routine-loop/test_routine_loop.py"], 25)


def t136():
    """Eval harness, LLM judge: judge.py + versioned rubric + calibration set (68).

    Machine-free test (features/infra/evals/test_judge.py) for the
    all-20 gap #13. judge_reply(reply, rubric, task, *, transport=None,
    case_id=None) -> verdict dict {pass, reason, evidence, qualified,
    error_kind, rubric_version, rubric_sha256, judge_prompt_version,
    model, reply_truncated}. The judge runs over the same console
    chat-task API as run-evals.py (login once — or a supplied
    QWENPAW_TOKEN, which skips login; an eval-judge-<case-id> session
    so judging never contaminates the case chat, 423 aborts, 429
    backoff, 401 one re-login when the token came from a login, a
    supplied token rejected with 401 is an infra failure), on the
    existing model (deepseek-v4.1-flash-free, verified 2026-11-19 —
    NOT mosicn/nex-n2.6 as this file said before), no new key,
    per-transport cap of 50 calls. The versioned rubric
    (evals/rubrics/v1.md, criteria R1-R6) is immutable — a change
    means a new v2.md file, never an edit. Fail-closed: non-JSON /
    missing field / pass not a bool / empty reason / pass with no
    quoted evidence / judge error / timeout / empty reply ->
    unqualified, never pass; in grade_case that surfaces as verdict
    "unqualified", not "fail", so an outage never looks like a quality
    regression; task is mandatory.
    Injection-resistant: the reply is fenced as data, never
    instructions; the parser takes only the judge's own (last)
    <verdict> block, else whole-output JSON — no substring search for
    a JSON object. No substring grading, at all: grade_case raises
    ValueError on legacy expect_contains/must_not_contain; observable
    effects are real probes only (file_exists, endpoint_called); a
    failed effect fails the case without calling the judge (quota
    saved). audit_cases(cases.json) flags 9 violations across 8 cases
    — all 5 T61 cases, plus 3 recall cases the sibling #6 agent added
    (recall-loop-gate, recall-keepalive, recall-daily-summary). The
    calibration set (12 human-reviewed examples with expected verdicts)
    is graded by the judge, not by a stub — the machine-free test does
    NOT claim live-model agreement (a stub returning recorded verdicts
    would only prove the parser); it proves parser/plumbing, set
    well-formedness, and that the old substring grader disagrees with
    the humans on 5/12 examples (--old-grader exits non-zero by
    design; the injection case fools the substring grader too, since
    the smuggled block itself contains "Paris"). Token path (F5/F6,
    added 2026-11-19): a supplied token skips the login call and is
    sent as the Bearer token; a 401 on a supplied token fails as infra
    without a re-login. Poll window (G1-G3, added 2026-11-19):
    MAX_POLLS 72 to 180 (15-min window) in judge.py and run-evals.py
    - the window is a safety net only, NOT the fix for the run-1
    timeouts (those were misdiagnosed as "turns take ~6 min"). Poll
    terminal status + task-shape extraction (H1-H8, added 2026-11-19):
    live calibration run 4 (2026-11-19 ~08:38 IST) finished 0/12 NOT
    TRUSTED on transport — 11 cases hit "judge poll timed out after
    900s" even though the grading turns had completed in seconds.
    Root cause, proven from the console source
    (app/routers/console.py: get_console_chat_task returns bg.status;
    _BackgroundTask.status is only "running" in flight and "finished"
    on every completion path) and by a live probe
    (task-320a0aa106b8: running -> finished in 12.4s): the poll
    waited for done/completed/success/..., a set that never contains
    "finished". Second bug from the same probe body: the generic
    extractor returned the FIRST text found — the "reasoning" item,
    the model's deliberation, not its reply. Fix: _poll returns on
    "finished" (TERMINAL_TASK_STATUSES, kept in sync between judge.py
    and run-evals.py) and _extract_text takes the last "message" item
    of result.output, never reasoning; a task-shaped body with no
    final message yields no reply text. Fail-first proven for H:
    50/57 against the pre-fix code (H1/H2/H4/H5/H6/H7/H8 fail, H3
    passes), 57/57 after the fix. Calibration agreement (I1-I11,
    2026-11-19): live re-run 5 finished 11/12 — cal-01..cal-11 all
    agree, cal-12 (empty-reply-fail, reply empty by construction)
    counted DISAGREE only because the rule required qualified=True,
    though its pass=False matches the human fail. Fix: _calibration_agrees
    counts a case when the human verdict is fail AND the judge returns
    pass=False with error_kind "empty_reply" (fail-closed is the correct
    verdict there); an empty reply on a pass-case, and every other
    unqualified verdict, still count as disagreement. test_judge.py
    --live grades with the same function, so the two cannot drift.
    Fail-first proven for I: 59/68 against the pre-fix code (I1-I8 + I9
    fail, I10/I11 pass as the negative control / drift guard), 68/68
    after the fix. The re-run (run 6) with this rule must report 12/12
    TRUSTED. Fail-first proven: the test failed
    with ModuleNotFoundError before judge.py existed. The live half
    (live-model agreement with the calibration set:
    QWENPAW_TOKEN=<token minted in the container>
    python3 judge.py --calibrate --live, requiring 12/12 agreement
    before the judge is called trusted, and confirming the serving
    model is actually deepseek-v4.1-flash-free) is verified by Muse
    after deploy.
    """
    return _py_script_harness(
        ["features/infra/evals/test_judge.py"], 68)


def t137():
    """Memory-recall eval: Layer-1 baseline measured, integrity half staged (64).

    Machine-free test (features/memory/recall-eval/test_recall_eval.py)
    for the all-20 gap #19. Recall half — DONE, measured baseline
    (the first ever for memory v2): deterministic, no judge, no model
    call, scratch DBs only. recall_eval.py seeds 12 fixture facts (6
    targets, 5 keyword-identical near-miss distractors, 1 superseded
    pair) and runs 6 recall queries through the real facts.py search:
    hit@1 0.833 (5/6), hit@3 1.0, hit@5 1.0, MRR 0.917, mean rank 1.17,
    candidate-pool hit rate 1.0, false-top 1/6, max latency 1.17 ms,
    max tokens 38/query. Staleness: the superseded fact is absent by
    default, the current fact ranks 1; as-of 2026-11-05 returns old,
    2026-11-15 returns new, 2026-10-01 returns neither. Abstention: a
    nonsense query returns 0 results; the paraphrase canary returns 0
    results; an empty query raises FactError. The eval is proven
    sensitive: removing a target fact flips its verdict to FAIL. Real
    finding (measured, NOT fixed): the loop-gate query ranks the
    distractor #1 (fused 0.439 vs 0.432) because the hyphenated target
    loop-gate misses the lexicon entity regex \\bloop gate\\b
    (entity_overlap 0 vs 1); the answer is still rank 2 and hit@3 is
    unaffected. Not fixed here — facts.py is owned by the parallel gap
    #20 build, and the eval's job is to measure. Integrity half —
    STAGED, NOT graded: 4 fixtures (2 contradiction, 2 tool-failure,
    fork PR #57 style), all grading: "judge", rubric pinned to
    rubrics/v1.md. judge_wiring.py calls the judge's real API —
    verified against the landed T136 module, not just a stub: it
    resolves grade_case, and with no transport/creds the judge returns
    unqualified, which the wiring maps to skip / pending-judge (CLI
    exit 3). The unqualified trap is handled explicitly: the judge
    returns pass: False for unqualified verdicts, so the wiring checks
    qualified first — otherwise a harness failure would misreport as a
    case failure. No substring fallback anywhere (a reply a substring
    check would pass still skips with no judge). To finish: set
    QWENPAW_USER/QWENPAW_PASS when the machine is back and run
    --grade-integrity per case; no fixture change needed. Fail-first
    proven: first run failed with ModuleNotFoundError (no module yet).
    DeepSeek design review applied (1,160 prompt + 3,442 completion
    tokens): pool-hit metric, false-top rate, determinism, as-of
    boundaries, and the paraphrase canary as an expected-zero check all
    came from it. The live half (the 3 live cases.json cases are smoke
    checks only; the offline harness is authoritative; seeding live
    memory needs approval; the eval refuses to open the live memory.db
    without --allow-live-path) is verified by Muse after deploy.
    """
    return _py_script_harness(
        ["features/memory/recall-eval/test_recall_eval.py"], 64)


def t138():
    """Artifacts library: SQLite index over workspace + sent files + history.db (44).

    Machine-free test (features/artifacts/test_artifacts.py) for the
    all-20 gap #14. artifacts.py is a stdlib-only CLI with subcommands
    index / backfill / search / render. It walks a workspace (skips
    hidden files, .git, caches, venvs, history.db*, the index DB
    itself, and symlinks escaping the root), stores name / slug / date
    / size / type / source in SQLite (artifacts table, UNIQUE (path,
    source) + indexes on slug/type/date/name), and renders one
    searchable static HTML page (rows embedded as JSON, client-side AND
    token filter, header states "Not live"). Backfill has two inputs:
    sent-file metadata JSON ({path, sent_at, session_id, channel}) and
    history.db — opened strictly read-only (mode=ro URI +
    mutation-denying authorizer, mirroring features/memory/recall.py),
    matching real workspace files by path/name in conversation content;
    only metadata enters the index, no message content. History
    matching checks real files rather than regex-extracting paths —
    that was a real bug found by the test (paths with spaces like
    "Meeting Notes.md" were missed), fixed before green. Fail-first
    proven (stub --code fails: no init_db). Covers: (a) walk indexes
    all 7 fixture files with full metadata, (b) search finds the right
    artifact / misses the wrong one, (c) sent backfill picks up a
    pre-index file, (d) re-index adds zero rows, (e) history.db hash +
    mtime unchanged and no journal/WAL files; plus history backfill,
    slug-collision dedupe, hidden/symlink exclusions, render + both
    CLIs, bad inputs. DeepSeek design help failed — one seek.py call
    returned malformed JSON ("provider response was not valid JSON");
    not retried, the design was verified against repo patterns instead.
    The live half (run index + render against the real
    workspace/history.db on the machine and check the page in a
    browser) is verified by Muse after deploy.
    """
    return _py_script_harness(
        ["features/artifacts/test_artifacts.py"], 44)


def t139():
    """Real sandbox profile for generated code (51).

    Machine-free test (features/sandbox/test_sandbox.py) for the
    all-20 gap #6 — wired up 2026-11-19 (T139 deploy pass): the
    broker-side POST /sandbox/inject endpoint exists (token-gated,
    single-use jti, value scrubbed; T107 covers it live on an
    ephemeral port, 29 checks), the gateway firewall rule and the
    runner wiring are implemented and machine-free tested (the runner
    wires dispatch: route -> resolve workspace symlinks -> mint scoped
    token -> build/validate profile -> docker run; T94 covers it, 218
    checks), and the token is delivered on a host-tmpfs bind at
    /run/sandbox-token (second bind, pinned to /run/sandbox-tokens).
    The profile, token API, proxy, and dispatcher are built, tested,
    and pushed. What remains is the machine deploy (key provisioning,
    bridge + rule, service restarts, proxy start, live probes) and the
    sandbox image itself (qwenpaw-sandbox:2.3.0 — NOT built: the
    machine is at the 5-image cap and a T132 build is in flight) and
    the live proof with that image: gateway-unreachable probe,
    proxy allow/deny from inside a container, workspace write-back,
    browser check. sandbox.py is the profile builder + validator +
    renderers: one workspace bind mount (job workspace -> /workspace)
    plus the token-dir bind above, isolated
    bridge qwenpaw-sandbox-net, read-only rootfs, non-root user 10001,
    caps dropped ALL, no-new-privileges, no docker.sock / privileged /
    host network / host PID / IPC / devices, no credential in env.
    Caps sized for the Free VM: 1 GiB memory (swap = memory), 1 CPU,
    128 pids, 120 s default / 300 s hard-max lifetime. Rendering
    refuses an invalid profile outright. vault_tokens.py is the broker
    token API: v1.<payload>.<HMAC-SHA256> tokens, 90 s default / 300 s
    max TTL, single-use jti, exact-match scope (vault item names +
    hosts, no wildcards/prefixes), fail-closed key loading from
    SANDBOX_BROKER_KEY, plus a mint/verify CLI. egress_proxy.py is a
    stdlib forward proxy for the sandbox bridge; it forwards only to
    hosts on the T123 allowlist — no new allowlist; proxy-allowlist.txt
    is a generated snapshot of it, and the test asserts exact equality
    so drift fails loudly. dispatch.py routes generated-code jobs ->
    sandbox; desktop/unknown-kind/non-allowlisted-host/vault-out-of-
    scope/over-deadline/out-of-root jobs -> refuse, never silently to
    main. One legacy exception: the B-41 fixed pilot job (exact id)
    stays on main. The profile/Dockerfile + docker-compose.sandbox.yml
    are a minimal image (python:3.12-slim, uid 10001, no curl/wget/git/
    docker client) and sandbox + proxy on the isolated bridge. The
    README states the precise trust boundary (what the sandbox can and
    cannot reach, with enforcement per row) plus 8 residual holes that
    cannot be closed on this VM (shared kernel,
    gateway-is-one-iptables-rule-away, opaque TLS, no DNS pinning,
    in-memory-only token revocation, side channels, workspace symlink
    escape, supply chain). Fail-first proven: --impl none (the
    pre-sandbox stub: main-container mounts, host network, unsigned
    never-expiring tokens, allow-everything proxy,
    route-everything-to-main) -> 7 passed, 44 failed. Two real bugs
    caught by the test before shipping: the forbidden-mount check
    flagged the legitimate workspace path, and compose_service dropped
    the token tmpfs mount. A third bug was caught LIVE, not by the test:
    the profile wrote tmpfs sizes as bare values ("16m") and the daemon
    refused the first end-to-end runner job (exit 125, `invalid tmpfs
    option "16m"`); the fix (size= form + a validator rule + test A15)
    is why the count is 51, not 50. T123 still 35/35. The live half is
    done 2026-11-19 (post-reset verify): image qwenpaw-sandbox:2.3.0
    built (digest sha256:e64c643b…), gateway unreachable from the bridge
    (both broker ports TimeoutError), no auth.json / no qwenpaw mounts,
    uid 10001, runner routing proof (refuse + sandbox-branch + 401),
    and the end-to-end runner job `t139-live-e2e` → status ok, exit 0,
    `probe.txt` landed on the host; broker inject value-in-env + scrub
    proven the same morning. What remains is the browser check.
    """
    return _py_script_harness(
        ["features/sandbox/test_sandbox.py"], 51)


def t140():
    """Per-task cap survives the per-turn agent rebuild (26).

    Machine-free test (features/loop-gate-fix/test_task_cap.py, section
    P) for gatefix5: the runtime builds a FRESH agent object for every
    user turn (runtime/runtime.py: ctx.agent = builder.build(ctx) per
    request) and restores the session via load_state_dict, which
    restores only self.state -- NOT plain attributes on the agent.
    Gatefix4 stored the task budget as such an attribute, so every turn
    started with a fresh task (total=0) and the per-task cap never bound
    (live failure b6180034: 20 shell calls per turn for 4 turns,
    cumulative 80, past the 40-shell cap). Gatefix5 persists the task
    budget through the state_dict round-trip (task_budget_state_dict /
    load_task_budget_state_dict in limits.py, wired into
    ReactAgent.state_dict / load_state_dict). P replays the live shape
    WITH a fresh agent object per turn: turn 2 gets 20 more to task
    shell 40 = cap and finalises, turns 3 and 4 execute 0. P2 checks
    the snapshot round-trip; P3 checks the loader fails open on bad
    data. Fail-first proven: against gatefix4 limits.py the P section
    fails 14/26 (the J-O sections still pass, 61/61). The live half
    (the 1-200 echo cross-turn browser test) is verified by Muse after
    deploy.
    """
    return _py_script_harness(
        ["features/loop-gate-fix/test_task_cap.py", "--section", "P"], 26)


def t141():
    """Realistic resume messages resume the current task (30).

    Machine-free test (features/loop-gate-fix/test_task_cap.py, section
    Q) for gatefix6: gatefix5 persisted the task budget correctly
    (proven by the live session file), but its _is_continuation
    required an EXACT match against a fixed set of bare words, so
    realistic resume messages each minted a FRESH task budget and
    abandoned the previous task -- the per-task cap never accumulated
    (live failure d0f77cb7, chat 0b220b4f: "hello, are you working?"
    abandoned the echo task at 20 shell; "Yes, continue from 21"
    minted a fresh task that ran 40 shell, 21-60, for 60 shell across
    the chat, past the 40-shell cap). Gatefix6 matches a continuation
    phrase at the START of the message at a word boundary. Q1 replays
    the live shape WITH fresh agent objects per turn and the realistic
    messages: "hello, are you working?" resumes the same task (0
    calls), "Yes, continue from 21" resumes and spends 20 more to 40
    and finalises, "continue" executes 0. Q2 unit-checks the matcher
    (prefix + word boundary: "yesterday" / "history" / "surely" /
    "thanksgiving" are NOT continuations). Q3 checks a genuinely new
    instruction after finalisation still mints a fresh task. Fail-first
    proven: against gatefix5 limits.py the Q section fails 11/30
    (Q1f/Q1g/Q1h/Q1l/Q1m/Q1o/Q1p/Q2a/Q2b/Q2c/Q2e) with byte-identical
    task ids to the live session file. The live half (the 1-200 echo
    cross-turn browser test) is verified by Muse after deploy.
    """
    return _py_script_harness(
        ["features/loop-gate-fix/test_task_cap.py", "--section", "Q"], 30)


def t142():
    """Per-chat thinking selector: Default/Off/Low/Medium/High/XHigh (32).

    Node harness (features/thinking-selector/test_thinking_selector.mjs)
    for the "thinking-selector" rule in pages/public/_worker.js. The
    backend already supports per-chat thinking end to end (GET/PUT
    /api/chats/{id}/thinking, ThinkingPreference {level}); the rule only
    surfaces it as a selector in the chat composer toolbar itself — in
    the Smart Mode row next to Smart Mode (user screenshot 2026-11-19),
    appended (never moved) into that row so React reconciliation is
    untouched; the "Context usage" button's parent and the chat input's
    grandparent are fallbacks. Static: the rule exists and is wired into
    the MutationObserver; it GETs and PUTs /api/chats/{id}/thinking with
    a Bearer token from localStorage qwenpaw_auth_token; it offers
    Default/Off/Low/Medium/High/XHigh and sends the model_key on PUT
    (the 409 guard); it never polls and never removes React nodes.
    Dynamic, with a DOM mock + fetch mock: on /chat/<id> it creates one
    select in the Smart Mode row, GETs the stored level and shows it;
    changing it PUTs {level} with Bearer + model_key; a second run
    re-GETs nothing and creates no second select; on a brand-new chat a
    pick is stored as pending in localStorage with no fetch and PUT once
    the chat gets an id; a PUT 422 reverts and re-syncs; a server level
    outside the offered set (max) gains an option and is shown, never
    forced to Default; a GET 401 is a safe no-op; off chat pages it
    creates nothing. Fail-first proven: against the pre-feature
    _worker.js the harness fails 21/23 (the two passes are the vacuous
    no-polling and off-chat no-op checks on an empty rule). The live half
    (a real browser sets XHigh on one chat and Low on another, GET
    reflects each, a reply still works) is verified by Muse after the
    Pages deploy — blocked by the 2026-11-18 Workers 1027 outage until
    the 00:00 UTC reset.
    """
    return _harness("features/thinking-selector/test_thinking_selector.mjs", 32)


def t143():
    """Smart sleep/wake: keep-alive toggle + max-run guard + Hallmark pages (105 + 105 checks).

    Two node harnesses under features/smart-sleep/ (README there):
    harness-smart-sleep.mjs (105) runs the real keep-alive Worker module
    with a mock D1 + a mock fetch that counts every call. Toggle: OFF ->
    the cron tick returns skip with ZERO fetches and ZERO D1 mutations;
    ON -> the decision is identical to today (golden compare vs
    decideSleepWake); a read that throws or an invalid value -> HOLD with
    zero fetches; absent -> ON. POST /keepalive: no bearer -> 401 and the
    stored value unchanged; correct Bearer <redacted> -> 200 with exactly
    2 D1 writes; bad body -> 400; WAKE_TOKEN unset -> 503; ?token= in
    the query -> 401 (header only); GET -> 405 with Allow: POST. Toggle
    OFF + a due routine -> the tick still skips (the routines Worker's
    own scheduled wake is a separate worker and is unaffected). Max-run
    guard: uptime 420 min + recent visit/agent activity -> sleep with
    reason max_run_guard (via the pure function and via the tick: one
    Pages sleep call, no console probe); 419 min -> hold; 420 min + a
    routine due in 5 min -> hold (WAKE wins); unknown uptime -> hold;
    toggle OFF + 420 min -> skip. Stuck-state recovery (reporter_up):
    a state stranded on "sleeping" while the machine is up flips to
    "running" (reason reporter_up, state carries the computed uptimeSec)
    when the reporter reported within the last 5 min — no probe needed,
    and the guard can then fire in the same tick (420 min + recent
    activity -> Pages sleep once, zero console probes); a 6-min-old or
    11-min-old report, or no report at all, never flips (zero fetches);
    a stale report claiming 420 min does not fire the guard; 419 min
    flips but does not fire the guard; the live reporter shape
    (uptimeSec null) still flips, with the state carrying the lastUpAt
    lower bound; a finite reporter uptimeSec wins over lastUpAt; an
    already-running state is never overwritten and the tick writes
    nothing to D1 meta; GET /sleepwake/state exposes the recorded
    uptimeSec (null when no recovery has happened). GET /status and /sleepwake/state expose
    keepAlive ("on"/"off"/"unknown") + keepAliveUpdatedAt, and /status
    exposes sleepwake.nextRoutineAt (finite ms epoch when a routine
    exists, null otherwise; omitted with no D1). Fail-first proven:
    against the pre-change Worker the harness fails 48/72 (24 pass);
    the reporter_up recovery section fails 16/105 against the
    pre-recovery Worker (89 pass — the 17 negative controls pass on
    both, by design).
    harness-smart-sleep-pages.mjs (105) extracts and runs the real
    wakingPage/cooldownPage from pages/public/_worker.js in a VM and
    reads pages/public/status-page.html: no backtick / no ${} in any of
    the three rendered outputs; no external URL (outside WORKER_URL), no
    <link, no src=, no @import, no <img>; cooldown remaining-time
    table-driven cases; waking polls every 5 s and reloads only on
    id="root"; cooldown reload-storm guard (max 1 auto-reload per 30 s
    per tab via sessionStorage); status page has NO setInterval polling
    (one GET on load; exactly one setTimeout refresh when waking);
    size budgets (waking <=9 KB, cooldown <=8 KB, status <=12 KB);
    keep-alive switch (role="switch"), password token field and the
    "Scheduled runs still wake the machine." consequence text present.
    Fail-first proven: 44/105 fail against the pre-change pages. Hallmark
    sloplint on the three rendered pages: 0 FAIL, 1 WARN (F16, status
    page browser surfaces unthemed — documented, accepted: theming them
    costs ~155 B against a 12 KB budget). The live half (a real flip +
    skipping tick, a real 7h guard sleep, the pages in a real browser)
    is verified by Muse after the Pages/Workers deploy — blocked by the
    2026-11-18 Workers 1027 outage until the 00:00 UTC reset.
    """
    a = _harness("features/smart-sleep/harness-smart-sleep.mjs", 105)
    b = _harness("features/smart-sleep/harness-smart-sleep-pages.mjs", 105)
    ok = a[0] == "PASS" and b[0] == "PASS"
    return ("PASS" if ok else "FAIL", a[1] + " | " + b[1])


def t144():
    """Settings white-area fix round 3: the settings-white-area rule only (19 checks).

    Subset of the T114 rebrand harness (features/rebrand/
    harness-rebrand.mjs): re-runs it and requires exactly the 19 lines
    naming the settings-white-area rule to be "ok" (4 static + 15
    dynamic). The rule (2026-11-19, browser-verified PARTIAL on
    qwenpawx.pages.dev/settings/general at 1919x998): round 1
    stretched the nav-anchored shell to 100dvh and painted <html> +
    <body> with the shell's own computed background — cream ends
    ~894 (was 819), ~104px white strip left in light mode, dark
    filled. Diagnosis from the SERVED console bundle
    (index-tgCT4NPx.css): the shell is a .page-content whose
    background is var(--app-surface), white in light mode, so round
    1 copied white onto the body; and the shell alone cannot beat
    the .ant-layout max-height:100vh + overflow:hidden clip. Round 2
    paints from the console's --app-bg theme variable (:root #f9f8f4
    light, html.dark-mode #141414 dark, class fallback when the
    variable is missing), never from the shell or any ancestor, with
    !important, stretches the shell + its ancestors to 100dvh, and
    records a diagnostic probe (window.__agentxSettingsDiag +
    body[data-agentx-settings-diag]) for the parent's browser check;
    no-op off /settings and before the nav mounts, and removes the
    paint + stretch + probe on leaving Settings. Fail-first proven:
    190/198 against the round-1 rule (all 8 new round-2 checks
    failed — the white-shell regression, the ancestor stretch, the
    dark/light fallbacks, the paint-source check, the probe, and the
    theme-variable static check), 198/198 after the rewrite. Round 3
    (2026-11-19 ~09:0x IST): the round-2 browser check showed ZERO
    change — the strip stayed ~104px in light mode even though curl
    showed the new code in the served HTML. Diagnosis from the SERVED
    console bundle (index-tgCT4NPx.css): the shell (.page-content) is
    transparent inside a WHITE full-height
    .index-module__mainContentLayout wrapper
    (background:var(--app-surface), height:100%) that covers the
    <html>/<body> paint, so the rule now paints the shell AND every
    ancestor with the theme paint, and writes a TEMPORARY visible
    diagnostic line (AX-DIAG, elementFromPoint strip probes) readable
    as page text — the cloud browser has no DevTools, so the probe
    must be readable as text; the line is removed in the follow-up
    round once the values are read. The mock now models the realistic
    DOM (transparent shell inside the white wrapper, offsetHeight
    894 in a 998 viewport, elementFromPoint) — the round-2 mock had
    no covering wrapper, so it passed while live failed. Fail-first
    proven: 198/205 against the round-2 rule (all 7 new round-3
    checks failed — the ancestor paint, the diag line, its
    no-duplicate re-run, the dark realistic paint, the
    ancestor-paint cleanup, and the 2 static checks), 205/205 after
    the rewrite. Round 4 (2026-11-19 ~09:0x IST): the live check
    read the line (rule=ran, shell h=998, body/html bg
    rgb(249,248,244)) and confirmed the fix — 0px strip in light
    mode at top and max scroll, dark filled. The AX-DIAG line and
    its probe are removed here; the paint + stretch are untouched.
    The 7 diag checks become no-diagnostic checks (same 19-check
    subset: T144 19/19); fail-first 198/205 against the round-3
    rule, 205/205 after the removal. The live half (a real browser
    on the deployed console, light + dark, top scroll and max
    scroll, confirming the line is gone AND the cream still fills)
    is verified by Muse after deploy.
    """
    rc, out, err = run_local(["node", str(REPO / "features/rebrand/harness-rebrand.mjs")], timeout=180)
    lines = [l for l in out.splitlines() if "settings-white-area" in l]
    ok = [l for l in lines if l.strip().startswith("ok")]
    good = rc == 0 and len(lines) == 19 and len(ok) == 19
    return ("PASS" if good else "FAIL",
            f"settings-white-area subset: {len(ok)}/19 ok "
            f"(tally={one_line(out.strip().splitlines()[-1] if out.strip() else err, 80)})")


def t145():
    """Multi-tab takeover (Step 10, 2026-11-19): the non-owner tab can take over sending (60 checks).

    Node harness (features/queue-takeover/test_queue_takeover.mjs) in
    four parts. (a) The bundle patch (features/queue-takeover/
    apply-queue-takeover.py) is run FOR REAL against the verbatim live
    excerpts captured from the machine (image
    qwenpaw-agentx:2.3.0-approvalttl1, both asset copies byte-identical):
    the shared-chunk channel listener gains a "release-ownership"
    branch that aborts the owner's AbortController from
    window.__agentxOwnerControllers, and the chat-chunk hold effect
    registers its controller there (cleanup deletes it). The patched
    output parses (node --check); a second run on patched output FAILS
    (fail-closed, no double-patch). (b) Static checks on the
    "queue-takeover" rule in pages/public/_worker.js: it posts
    {type:"release-ownership", sessionId} on BroadcastChannel
    ("qwenpaw:queue"), creates exactly one "Take over sending" button
    (document-wide guard, moved onto the current banner instead of
    recreated, placed on the banner root with white-space:nowrap,
    stranded button removed when the banner is gone, one-shot 15s
    retry re-enable in the click handler, no setInterval), hides the
    dead "Interrupt & send" while the banner is up, never removes React
    nodes. (c) Dynamic, with a DOM mock (live textContent, isConnected,
    fake setTimeout) + BroadcastChannel mock: one button on the banner
    root, no duplicate on re-run, click posts release-ownership with
    the chat id from the URL and disables itself, re-enables after 15s
    if still queued, Interrupt hidden while the banner is up and
    restored when it goes, nothing off-chat; the takeover1 live failure
    is replayed (React re-renders replace the text div on every run —
    still exactly one button, the same node, on the banner root) and a
    stranded button on an ancestor is removed when the banner is gone.
    (d) The cache bust (features/queue-takeover/rename-chunks-tk2.py)
    is run FOR REAL on fixture console dirs: the entry script gains
    ?v=takeover2, the chat chunk is renamed, its references updated,
    the old name occurs zero times, all three touched files parse, a
    second run FAILS. Fail-first proven: the apply-script checks fail
    against a stub patch with the wrong anchors, and the banner-restore
    check fails against a mock whose div list is static (a removed
    banner keeps being found). Takeover2 fail-first proven: 42/60
    against the takeover1 rule (18 failed — the 8 new static checks
    and all 10 new dynamic checks, including the mock replaying the
    live 3x triplication on the second run).
    The live half (two tabs on the same chat, send from the non-owner
    tab, confirm takeover works and the queue drains) runs in a real
    browser after the container redeploy — NOT here, and NOT while the
    T136 judge is running (a restart drops its in-flight turns).
    """
    return _harness("features/queue-takeover/test_queue_takeover.mjs", 60)



def t104():
    """The rail must stay reachable after the screen connects (25 checks).

    The 10th browser check spent 74 minutes trying to get the sidebar back: the
    rail showed for 1-2 s during "Opening the computer…", then hid, and no
    reload-race, pixel click, element reference ("covered"), Tab, edge drag, or
    top-bar control would reveal it. The Terminal tab could never be selected,
    which is why the B-33 terminal fix could not even be verified.

    TWO STRUCTURAL FAULTS, not a timer:
      1. #overlay was `position:fixed; inset:0; z-index:30` — a full-viewport
         layer — and boot opened it automatically on any window wider than
         1100px. On every desktop that covered the rail, and the screen iframe
         inside swallowed clicks aimed at it. Hence "covered".
      2. #stage had NO iframe, only a veil, so the overlay was the ONLY place a
         screen could appear — which is why making it mandatory looked harmless.
    There was also no persistent control to reopen it: the only exit was the
    overlay's own ✕.

    Asserts geometry (the overlay starts at 316px, never inset:0), that the
    width-based auto-open is gone, that a persistent Open button exists inside
    the rail, that #stage has a real sandboxed frame obeying the control gate,
    that nothing z-indexed spans the rail, and that the Terminal tab is inside
    the rail and wired. Fails 7/25 pre-fix; 25/25 after.
    """
    return _harness("features/computer/harness-rail-reachable.mjs", 25)


def t103():
    """The BROWSER's terminal path: preamble, framing, and xterm rendering (17).

    The Node protocol test passed (101, prompt, echo) while the real browser's
    Terminal tab stayed black and closed on its own. The difference is that the
    Node test sends RAW text; the browser sends a signed PREAMBLE then FRAMED
    input, and needs xterm's stylesheet to render.

    Three bugs, each sufficient alone:
      1. ORDERING — `new WebSocket()`, then `await <load xterm>`, then the `open`
         listener. `open` can fire during that await, so the preamble was never
         sent; the PTY server waits 5 s for its first line and closes. Hence
         "connected then closed, prompt never renders".
      2. NO xterm.css — xterm renders into absolutely positioned canvases whose
         geometry comes from its stylesheet. Unlinked, the pane is black even
         when bytes arrive.
      3. THE PREAMBLE WAS TYPED INTO THE SHELL by any direct serve_pty caller,
         because the parse lived in main() while serve_pty assumed it was gone.
         It produced `/bin/sh: 2: Syntax error: word unexpected`.

    Replays the browser's exact wire behaviour against the real PTY server
    (preamble, RESIZE, framed stdin) and statically asserts the ordering and CSS
    properties. Fails on all three pre-fix states; 17/17 after.
    """
    return _harness("features/computer/harness-terminal-browser.mjs", 17)


def t102():
    """The first complete input line must not kill the terminal shell (25 checks).

    THE LIVE FAILURE (13:25 IST, twice): prompt "# " arrived, then a full line
    (`echo hello-terminal`) closed the socket in ~0.1 s with no output, while a
    bare "x" or newline was tolerated for 12 s+.

    ROOT CAUSE: terminal-server.py spoke ONLY the framed protocol
    [kind:u8][len:u32be][payload]. Plain text has its first five bytes read as a
    header — `e c h o <space>` declares 1,667,788,576 bytes — which exceeded the
    1 MiB cap, raised FrameError, and CLOSED the session. A 1-2 byte message is
    shorter than a header, so it survived; that is exactly why single characters
    were tolerated and the first complete line was fatal.

    THE REAL DEFECT was not the missing input format but the response to it: a
    parse anomaly terminated a working shell. Now the first bytes decide the mode
    once per session (framed vs raw keystrokes), and text is written to the PTY
    instead of killing it. B-17 stays intact — the length bound means a hostile
    4 GB declared length is treated as text, never allocated.

    Fails 3/25 on the pre-fix tree with reason=oversize-frame and empty output;
    25/25 after.
    """
    return _py_harness("features/computer/test_terminal_input.py", 25)


def t101():
    """Manual rest + auto-wake, and the keep-alive respecting it (66 checks).

    Rohan's feature: rest the machine when it is not needed, and the site wakes
    it on the next visit. The reason is the Free-plan maximum run length —
    holding the box awake for 8 hours ends in a 2-hour cooldown, so resting it
    on purpose beats being forced into one at a bad moment.

    Asserts the five cases the brief named (unauth never suspends; unset key is
    a clear error with no API call; a visit attempts the public URL once and
    serves the waking page; a 409 shows the end time and does not retry early;
    the keep-alive skips the wake during a rest) PLUS the two that decide
    whether it is safe: an unreadable marker must NOT wake (fail-safe in the
    direction that respects the user), and the marker is written BEFORE the
    suspend so a failed suspend cannot be undone by the next cron tick.
    """
    return _harness("features/machine/harness-machine-rest.mjs", 66)


def t100():
    """The Asleep overlay is hidden when the preview is live (21 checks).

    B-30: the sidebar preview sat on "Asleep" with a Wake button while
    /computer reported running and the large screen showed the real desktop.
    The JS was right (`el.previewAsleep.hidden = live`); the CSS was not —
    `.preview .asleep{display:grid}` (0,2,0) outranks the UA stylesheet's
    `[hidden]{display:none}` (0,1,0), so the attribute was set and ignored.

    Evaluates the CASCADE rather than grepping for the rule: computes selector
    specificity and asserts the winning `display` is `none` when the attribute
    is present. A string check would pass on a rule that is later overridden,
    inside a non-matching @media, or reversed by !important.
    """
    return _harness("features/computer/harness-preview-asleep.mjs", 21)


def t99():
    """The terminal route proxies and TUNNELS the upgrade (54 checks).

    B-29: `/computer/terminal/<cap>/websockify` authorised correctly and then
    answered `{ok:true, ...}` — JSON where a WebSocket upgrade belonged. The
    browser's socket received JSON, closed, and the UI said "The shell closed.
    Take control again to reopen it." while the lease was still held. The ~10 s
    was the client giving up, never a server deadline.

    Asserts the 101 is tunnelled with the SAME socket, that the lease is
    re-checked so a release kills new sockets, that the signed preamble exists
    and cannot be moved to a later deadline / another lease / another computer,
    that CORS is present on terminal refusals, and that B-17's clamp and the
    lease-clamped expiry are unchanged.
    """
    return _harness("features/computer/harness-terminal-proxy.mjs", 68)


def t97():
    """The screen WebSocket upgrade is TUNNELLED (22 checks).

    This is the black-screen bug: the /computer page loaded, minted a
    capability, fetched the noVNC HTML (200), and then never connected. The
    router proxied the HTTP request but dropped the 101 upgrade that follows —
    the RFB banner only travels over that socket, so noVNC waited forever and
    the UI timed out with "The screen did not respond."

    The existing harness could not catch it: `harness-computer.mjs` asserts on
    the TEXT of router.js, and a missing branch is the absence of code. This
    one imports the real router and drives it with a fetch stub returning a
    101, then asserts the SAME socket object comes back out.
    """
    return _harness("features/computer/harness-screen-upgrade.mjs", 22)


def t95():
    """MCP client against a REAL SSE + JSON-RPC server (27 checks).

    The retired Worker called MCP as `POST {url}?tool=<name>`, a shape that
    does not exist. It never ran against a real proxy and three layers of mocks
    agreed with each other. This test speaks the actual transport.
    """
    return _py_harness("features/codemode/vm/test_mcp.py", 31)


def t96():
    """Code Mode end to end: runner -> real MCP -> real HTTP (48 checks).

    Drives the REAL 9-tool desktop job over the actual SSE + JSON-RPC transport
    (B-41). The failing step for the error-path cases is now `press_key` and
    `scroll` — real tools — instead of imaginary board ones.
    """
    return _py_harness("features/codemode/vm/test_e2e.py", 53)

def t77():
    return _py_script_harness(["features/board/pricing.py", "--selftest"], 20)

def t78():
    return _py_script_harness(["features/routing/policy.py", "--selftest"], 27)

def t79():
    rc, out, err = run_local(
        [sys.executable, str(REPO / "scripts/check-links.py")], timeout=120)
    ok = rc == 0 and "all links and paths resolve" in out
    return ("PASS" if ok else "FAIL",
            f"check-links.py exit={rc} "
            f"tail={one_line(out.strip().splitlines()[-1] if out.strip() else err, 160)}")

def t80():
    return _py_harness("features/storage/test_schema.py", 15)

def t81():
    return _harness("features/infra/workers/email-router/harness-email-router.mjs", 24)

def t87():
    """Preview uploader: change-only writes, floor, backoff, control guard.

    12 checks. This is the component that burned the KV quota; its write
    accounting is now a test rather than a claim.
    """
    rc, out, err = run_local(
        [sys.executable, str(REPO / "features/computer/preview-uploader.py"), "--selftest"],
        timeout=120)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    ok = rc == 0 and m and int(m.group(2)) == 0 and int(m.group(1)) == 12
    return ("PASS" if ok else "FAIL",
            f"preview-uploader --selftest: exit={rc} tally={m.group(0) if m else 'none'}")


def t86():
    """REBUILT computer: capability seal, lease atomicity, enforcement order.

    63 checks, no machine. Covers the assertions that would have caught the
    previous implementation's failures: a capability that cannot be replayed
    as control, a control link requiring the LIVE lease, a takeover that fails
    when the generation cannot be bumped, needs-you per computer, and previews
    that only write when the hash changes.
    """
    return _harness("features/computer/harness-computer.mjs", 88)


def t88():
    """The Pages Worker LOADS, RUNS, and REFUSES anonymous callers (88 checks).

    Added because on 2026-11-15 the entire Worker was dead and every check in
    this suite stayed green. Two fatal defects:

      - `computer/router.js` imported `LEASE_CAP_GRACE_MS` from
        `capability.js`, which does not export it -> SyntaxError at import,
        so nothing under /computer existed.
      - `_worker.js` called `sleep`, `rewriteHeaders` and
        `consolePanelScript`, all deleted in the 8,399-line computer removal,
        with the call sites left behind -> ReferenceError on EVERY proxied
        request, i.e. the whole console.

    Neither was catchable by the existing harnesses: they import
    `capability.js` and READ `router.js`/`state.js` as text. Reading a file
    proves it contains a string, not that it parses, links, or runs. So this
    test imports the real module graph and drives its fetch handler with
    stubbed origin and asset bindings — no network, no account, no machine.

    EXTENDED 2026-11-16 for a worse defect than either of those: `/computer/*`
    had NO authentication at all. Verified live against the deployed Worker:
    an anonymous curl read a 1920x1080 screenshot of the user's desktop, took
    a control lease, minted a `policy:"control"` screen capability, and minted
    a TERMINAL capability — a pre-authentication remote root shell, because
    minting one needs only a live lease and a lease needed only a POST.

    The new block asserts every user-facing path is REFUSED without a session,
    that a forged cookie is refused identically to an absent one, and that the
    gate runs BEFORE the store so an anonymous caller can never consume a
    lease, a generation, or an HMAC mint. It fails 28/70 on the pre-fix tree.
    """
    return _harness("features/computer/harness-worker-load.mjs", 88)


def t85():
    """Skill scanner: credential/RCE/injection patterns on third-party skills.

    79 checks. Offline and deterministic, so it can gate every commit; the
    LLM-backed SkillSpector stays the deep review for high-trust skills.
    """
    rc, out, err = run_local(
        [sys.executable, str(REPO / "features/skills/scan.py"), "--selftest"],
        timeout=180)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    ok = rc == 0 and m and int(m.group(2)) == 0 and int(m.group(1)) == 79
    return ("PASS" if ok else "FAIL",
            f"skills/scan --selftest: exit={rc} tally={m.group(0) if m else 'none'}")


def t84():
    """Decision models (Jev/Drex): no key means no call, calibration, safety.

    One stdlib client for both providers because they share /v1/systemone.
    The important property is fail-closed: no key -> None, never a guess.
    33 checks.
    """
    rc, out, err = run_local(
        [sys.executable, str(REPO / "features/decisions/decide.py"), "--selftest"],
        timeout=180)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    ok = rc == 0 and m and int(m.group(2)) == 0 and int(m.group(1)) == 33
    return ("PASS" if ok else "FAIL",
            f"decisions --selftest: exit={rc} tally={m.group(0) if m else 'none'}")


def t83():
    """Memory consolidation: daily logs -> lesson CANDIDATES (never accepted).

    The one thing nothing did: carry experience forward. Rule-based and
    dependency-free; secrets are DROPPED not scrubbed. 27 checks.
    """
    rc, out, err = run_local(
        [sys.executable, str(REPO / "features/memory/consolidate.py"), "--selftest"],
        timeout=180)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    ok = rc == 0 and m and int(m.group(2)) == 0 and int(m.group(1)) == 27
    return ("PASS" if ok else "FAIL",
            f"consolidate --selftest: exit={rc} tally={m.group(0) if m else 'none'}")


def t82():
    """Group-chat CORS allowlist (BUGS.md B-12). 13 checks."""
    return _harness("features/groupchat/harness-groupchat-cors.mjs", 13)


def t89():
    """Rate limiting on every /computer endpoint (BUGS.md B-10). 28 checks.

    B-10 was "no rate limit on any desktop endpoint", and the recorded failure
    it enables is a stuck client loop burning the daily Worker budget. The
    assertions that matter are the cost ones: a healthy client performs ZERO
    store operations (an in-memory bucket), and only a trip writes — once per
    window, so the limiter cannot become the quota burn it prevents.
    """
    return _harness("features/computer/harness-rate-limit.mjs", 28)


def t90():
    """Preview is not re-fetched or re-hashed every poll (BUGS.md B-5).

    29 checks against real SQLite: the UI half (src keyed by hash) and the
    SERVER half, which was still broken — `stateFor` loaded and hashed the full
    243-707 KB PNG twice per 10 s poll. Measured, not claimed: the harness
    counts blob bytes read.
    """
    return _harness("features/computer/harness-preview-refetch.mjs", 29)


def t91():
    """Routines history is append-only, not read-modify-write (B-8). 25 checks.

    20 concurrent appends must all land. The old shape read a 50-entry array,
    unshifted, and wrote it back, so two ticks close together dropped one —
    and this array is the routines audit trail.
    """
    return _harness("features/routines/harness-routines-history.mjs", 25)


def t92():
    """Terminal: lease rules for a root shell (the brief's gate). 39 checks.

    A root shell must not ship without lease tests. Drives the real Worker
    against real SQLite: no lease -> no shell; another holder's lease -> 409;
    expiry clamped to the lease (B-4's 59-minute hole); the SAME link refused
    after release; a takeover invalidating it; a broken store as 503 and never
    "released". Plus the PTY server's own 26 checks against a real PTY — the
    clamp from B-17 and the deadline kill.
    """
    return _harness("features/computer/harness-terminal.mjs", 39)


def t93():
    """Teach recording: the recorder and draft editor that did not exist. 68 checks.

    The UI had start/stop and a false "draft saved" toast. This asserts the
    recorder exists, coalesces a typed run into one step, makes a drag one
    step, bounds its buffer from the front, refuses to save a draft with no
    steps, and — most importantly — redacts secret-shaped text even when the
    user's Sensitive toggle is off, because a password in a skill file is
    permanent.
    """
    return _harness("features/computer/harness-teach.mjs", 68)


# Tests that exercise the REMOVED computer. They are kept because they are the
# acceptance criteria for the Rakazo rebuild, but they must report
# NEEDS-REBUILD rather than FAIL while no computer exists — a red suite for a
# deliberately-deleted feature teaches people to ignore red.
NEEDS_REBUILD_IDS = {
    "T07",
    "T08",
    "T09",
    "T10",
    "T11",
    "T12",
    "T13",
    "T14",
    "T15",
    "T16",
    "T17",
    "T46",
    "T47",
    "T48",
    "T49",
    "T50",
    "T51",
    "T52",
    "T53",
    "T54",
    "T55",
    "T56",
    "T57",
    "T75",
}

TESTS = [
    ("T01", "Pages root serves console SPA + side-panel markers", "console", "protocol", t01),
    ("T02", "/status serves status page", "console", "protocol", t02),
    ("T03", "/api/auth/status exact JSON", "console", "protocol", t03),
    ("T04", "/desktop no-cookie gate page", "console", "protocol", t04),
    ("T05", "/desktop/__lease public read per computer", "console", "protocol", t05),
    ("T06", "/desktop/vendor/xterm.js 200", "console", "protocol", t06),
    ("T07", "websockify GET 200 + WS 101, all 5 ports", "desktop", "protocol", t07),
    ("T08", "17 services active", "desktop", "protocol", t08),
    ("T09", "terminal WS 101 + frame echo on 6083", "desktop", "protocol", t09),
    ("T10", "MCP SSE 200 on 8898 + 8897", "mcp", "protocol", t10),
    ("T11", "list_apps on 8898 shows only :1 apps", "mcp", "protocol", t11),
    ("T12", "list_apps on 8897 shows only :2 apps", "mcp", "protocol", t12),
    ("T13", "teach endpoints exist", "desktop", "protocol", t13),
    ("T14", "needs-you endpoints exist", "desktop", "protocol", t14),
    ("T15", "side-panel injection in live HTML + _worker.js", "desktop", "protocol", t15),
    ("T16", "preview pipeline (watcher 120s floor + fresh PNGs + endpoints)", "desktop", "protocol", t16),
    ("T17", "mss 1920x1080 matches host scrot", "screenshot", "protocol", t17),
    ("T18", "bridge /health ok", "bridge", "protocol", t18),
    ("T19", "Camoufox /goto x.com/0xsatwik", "bridge", "protocol", t19),
    ("T20", "bridge /desktop-open opens URL on :1", "bridge", "protocol", t20),
    ("T21", "routines / + /api/status 200, QwenPaw up", "routines", "protocol", t21),
    ("T22", "routines cron schedules via API", "routines", "protocol", t22),
    ("T23", "POST /trigger no token -> 401 (not 202)", "routines", "protocol", t23),
    ("T24", "routines /api/history recent ticks", "routines", "protocol", t24),
    ("T25", "groupchat / reachable, auth required", "groupchat", "protocol", t25),
    ("T26", "groupchat unauth post -> 401", "groupchat", "protocol", t26),
    ("T27", "board / + /health 200", "board", "protocol", t27),
    ("T28", "board unauth /api/tickets -> 401", "board", "protocol", t28),
    ("T29", "bot Pages root 200", "botpages", "protocol", t29),
    ("T30", "bot Pages /skills/ 200", "botpages", "protocol", t30),
    ("T31", "skills list: 24 enabled, 0 disabled", "skills", "protocol", t31),
    ("T32", "delegate + github + build-page enabled", "skills", "protocol", t32),
    ("T33", "mailbox skill present, qwenpawmail not configured", "mailbox", "protocol", t33),
    ("T34", "heartbeat config state (record only)", "heartbeat", "protocol", t34),
    ("T35", "agent.json approval_level AUTO", "approvals", "protocol", t35),
    ("T36", "DriverCards effect allow + both parse as YAML", "approvals", "protocol", t36),
    ("T37", "approval-pending count stable across MCP call", "approvals", "protocol", t37),
    ("T38", "fleet.py list read-only", "fleet", "protocol", t38),
    ("T39", "evals cases valid + prompts v1 present", "evals", "protocol", t39),
    ("T40", "run-evals.py --dry-run", "evals", "protocol", t40),
    ("T41", "workspace-export export + verify (QA copy)", "import-export", "protocol", t41),
    ("T42", "workspace-export hash-verified restore + cleanup", "import-export", "protocol", t42),
    ("T43", "keep-alive /status up", "keepalive", "protocol", t43),
    ("T44", "keep-alive /ping 200 up", "keepalive", "protocol", t44),
    ("T45", "backup Pages mirrors console", "keepalive", "protocol", t45),
    ("T46", "harness gate 105/105", "harness", "protocol", t46),
    ("T47", "harness chrome 13/13", "harness", "protocol", t47),
    ("T48", "harness origin 9/9", "harness", "protocol", t48),
    ("T49", "lease take/release via KV write (qa)", "lease", "protocol", t49),
    ("T50", "__status per computer, full (cookie)", "desktop", "browser", None),
    ("T51", "side-panel renders beside chat", "desktop", "browser", None),
    ("T52", "/desktop chrome: take/release + terminal shell", "desktop", "browser", None),
    ("T53", "Team -> Private renders :2 live", "desktop", "browser", None),
    ("T54", "maintenance menu -> 503 key-unset (honest)", "desktop", "browser", None),
    ("T55", "teach-by-showing end-to-end", "desktop", "browser", None),
    ("T56", "needs-you banner end-to-end", "desktop", "browser", None),
    ("T57", "agent screenshot in chat shows Chromium", "screenshot", "browser", None),
    ("T58", "console login as satwik", "console", "needs-token", None),
    ("T59", "group-chat full post flow", "groupchat", "needs-token", None),
    ("T60", "board CRUD with board key", "board", "needs-token", None),
    ("T61", "evals live run", "evals", "needs-token", None),
    ("T62", "D1 store harness (38 tests: leases, generations, previews, routines)", "storage", "protocol", t62),
    ("T63", "board rate limit: burst from stable IP -> 429 + Retry-After", "board", "protocol", t63),
    ("T70", "memory recall CLI: caps, redaction, read-only", "memory", "protocol", t70),
    ("T71", "lessons ledger: candidates, caps, no auto-accept", "memory", "protocol", t71),
    ("T72", "ReMe doctor selftest: all five causes detected", "memory", "protocol", t72),
    ("T73", "Ripwire installer: AVX2 preflight + skill honesty", "memory", "protocol", t73),
    ("T74", "keep-alive: KV write-on-change + fail-closed /wake", "keepalive", "protocol", t74),
    ("T75", "lease-watcher: adaptive polling + safety invariants", "desktop", "protocol", t75),
    ("T76", "Code Mode pilot: benchmark maths + fail-closed auth", "codemode", "protocol", t76),
    ("T77", "pricing: honest UNKNOWN, optional catalogue", "cost", "protocol", t77),
    ("T78", "routing: classify, abstain, bounded scan", "routing", "protocol", t78),
    ("T79", "docs: every relative link + repo path resolves", "docs", "protocol", t79),
    ("T80", "D1 schema: engine guarantees + indexed queries", "storage", "protocol", t80),
    ("T81", "email router: fail-closed allowlist + injection envelope", "infra", "protocol", t81),
    ("T82", "group-chat CORS: allowlist, never a wildcard", "groupchat", "protocol", t82),
    ("T83", "memory consolidation: logs -> candidates, never auto-accept", "memory", "protocol", t83),
    ("T84", "decision models: fail-closed, calibration, low-conf safety", "decisions", "protocol", t84),
    ("T85", "skill scanner: credential/RCE/injection patterns", "skills", "protocol", t85),
    ("T86", "rebuilt computer: seal, lease atomicity, enforcement order", "computer", "protocol", t86),
    ("T87", "preview uploader: change-only writes, floor, backoff", "computer", "protocol", t87),
    ("T88", "Pages Worker loads, runs, and REFUSES anonymous /computer callers", "computer", "protocol", t88),
    ("T89", "rate limiting: per-endpoint 429, zero-cost healthy path", "computer", "protocol", t89),
    ("T90", "preview: change-only writes, no blob read per poll", "computer", "protocol", t90),
    ("T91", "routines history: append-only, no lost ticks", "routines", "protocol", t91),
    ("T92", "terminal: lease-bound shell + PTY frame validation", "computer", "protocol", t92),
    ("T93", "teach: real recorder, redaction, draft validation", "computer", "protocol", t93),
    ("T94", "Code Mode VM runner: fixed job, bounds, per-step honesty", "codemode", "protocol", t94),
    ("T95", "MCP client vs a real SSE + JSON-RPC server", "codemode", "protocol", t95),
    ("T96", "Code Mode end to end: runner -> real MCP -> real HTTP", "codemode", "protocol", t96),
    ("T97", "screen upgrade: the 101 WebSocket is tunnelled to the browser", "computer", "protocol", t97),
    ("T98", "screen CORS: module assets + preflight readable from the opaque frame", "computer", "protocol", t98),
    ("T99", "terminal: the WebSocket upgrade is proxied and tunnelled", "computer", "protocol", t99),
    ("T100", "preview: the Asleep overlay is hidden when the computer is live", "computer", "protocol", t100),
    ("T101", "machine rest + auto-wake; keep-alive respects a manual rest", "machine", "protocol", t101),
    ("T102", "terminal: a full input line must not kill the shell", "computer", "protocol", t102),
    ("T103", "terminal: the browser path — preamble, framing, xterm CSS", "computer", "protocol", t103),
    ("T104", "rail: sidebar reachable + Terminal tab clickable after connect", "computer", "protocol", t104),
    ("T105", "terminal: /vendor served as JS, not the console SPA", "computer", "protocol", t105),
    ("T106", "vault: the model can USE a key but never SEE it (canary, gate, AAD, redaction)", "vault", "protocol", t106),
    ("T107", "vault broker: env-var injection + output scrubbing (selftest)", "vault", "protocol", t107),
    ("T108", "sleep/wake: decide before probing; sleep only when idle (harness)", "sleepwake", "protocol", t108),
    ("T109", "sleep/wake reporter: next native run + agent activity (selftest)", "sleepwake", "protocol", t109),
    ("T110", "reset: the broker's HTTP surface — auth, preview, confirmation, idempotency, partial, concurrency, happy path (harness)", "reset", "protocol", t110),
    ("T111", "reset broker: allowlist guard + category table (selftest)", "reset", "protocol", t111),
    ("T112", "screen retry on failure (B-47): failed branch retries through bounded single-flight scheduleReconnect (harness)", "computer", "protocol", t112),
    ("T113", "routines daily-summary slot always probes (B-47 follow-up): slot bypasses the 15-min skip, wake-ticks still skip (harness)", "routines", "protocol", t113),
    ("T114", "AgentX rebrand (DOM injection): shim stubs PyPI + swallows upstream opens, 44-rule observer renames/hides by accessible name, About delegated to /status, logo replaced, title watcher, /status note AgentX (harness)", "rebrand", "protocol", t114),
    ("T115", "loop-gate fix: tool-call budget counts once per turn (reply-scoped recompute, no double-count, no stale-iteration skip) and applies by default (harness)", "loop-gate", "protocol", t115),
    ("T116", "tinyfish: Settings env key (os.environ, python3, no vault), request-building, fallback when no key, feature flags, error mapping (selftest) + Settings Search section: PATCH /api/envs, mount, self-mount, _worker.js wiring (UI harness)", "tinyfish", "protocol", t116),
    ("T117", "memory facts: compact fact store + session handoff — extraction candidates, FTS5 retrieval ranked + token-budgeted, handoff written by session A read by session B, add-only dedup, supersede without deletion, secret rejection, universal search (selftest)", "memory", "protocol", t117),
    ("T118", "bloat win-win: Alibaba telemetry phone-home removed — telemetry.py + daily_telemetry.py are no-op stubs, no endpoint, no httpx, no thread, no disk writes (harness)", "bloat-winwin", "protocol", t118),
    ("T119", "bloat win-win data layer: history/audit DB VACUUM + WAL checkpoint preserve every row, journal_size_limit is per-connection, PNG recompression lossless, log rotation verifies the archive before truncating (harness)", "bloat-winwin", "protocol", t119),
    ("T120", "memory facts v2: multi-signal retrieval (BM25 + entity overlap + importance, weighted RRF), rule-based entity extraction, temporal validity windows + search --as-of, v1 -> v2 migration preserves every fact (selftest)", "memory", "protocol", t120),
    ("T121", "mechanical checks: no China endpoint host/URL in code, no secret-shaped string outside the allowlist, AGENTS.md under its 20000-char cap, no setInterval in server code (selftest)", "checks", "protocol", t121),
    ("T122", "plan mode: read-only plan before any mutation — ToolGate refuses mutating calls naming the tool, plan file with required sections, no execution before approval, after approval only the plan's steps run in order and at most once (selftest)", "plan-mode", "protocol", t122),
    ("T123", "egress guard: untrusted-content wrapping (nonce fence, template-token strip) + allowlist egress (deny non-allowlisted, deny secret to allowlisted host, deny China hosts) + secret redaction in logs (selftest)", "egress-guard", "protocol", t123),
    ("T124", "SMART approval patch as a machine-apply script (agent.json AUTO -> SMART, idempotent, destructive auto-deny verified) + per-tool preview (exact shell command / file diff, never executes) + per-tool Allow/Block list (auto/ask/deny, deny beats every level incl. OFF) (selftest)", "approvals", "protocol", t124),
    ("T125", "cost ledger with hard kill switch: per-run + cumulative tokens/cost from token_usage.json priced by a static table, /cost endpoint, alert at 80% and hard stop at 100% with pre-call reservations, budget raise unblocks (harness)", "cost-ledger", "protocol", t125),
    ("T126", "per-task cap + structured stop audit: task budget 60 total / 40 shell across turns, finalise flag, stop audit (harness)", "loop-gate", "protocol", t126),
    ("T127", "checkpoints + rollback: per-run workspace snapshot (tarball + manifest) tagged with run id, restore refuses on drift without --force, automatic pre-restore safety snapshot, list command (harness)", "checkpoints", "protocol", t127),
    ("T128", "MCP client: stdio + streamable HTTP, servers disabled by default, per-server allowlist, namespaced tools mcp.<server>.<tool>, HTTP egress limited to declared hosts, no auto-install (harness)", "mcp-client", "protocol", t128),
    ("T129", "skills as progressive-disclosure packages: frontmatter schema + tool-scope enforcement, index-only default load, self-written skill writer with secret/China/unbounded refusals, mechanical converter", "skills", "protocol", t129),
    ("T130", "drex decision model: NACE endpoint configurable via env (arg > NACE_BASE_URL > default), decision_model slot fragment for both agents, live-test script fails closed without a key (harness)", "decisions", "protocol", t130),
    ("T131", "telegram full-feature bot: token-only setup (no numeric id), owner = first whitelist entry, guests read-only, strangers refused; new chat, list + preview + continue an existing console chat (task API); settings via button callbacks (model PATCH, approval PUT); menu grammar + token cache; outbound redaction + inbound untrusted wrapping; driver patch applies cleanly to the pinned v2.3.0 platform.py and reproduces the patched file byte-for-byte (selftest)", "telegram", "protocol", t131),
    ("T132", "approval TTL: pending approvals + secret requests expire — issue stamps expires_at (approval 24h, secret 1h, question never), read is pure and fails closed (expired reads as denied, reason 'timed out'), late answers refused with ExpiredError, sweep expires stale cards idempotently (never legacy, post-migration card with no expiry fails closed), fork-shaped audit rows, store survives reload, flock serialises every read-modify-write (selftest) + derived-image wiring test: the patch applies cleanly -p1/-p2, reproduces the patched files byte-for-byte, the approve/deny handlers call ttl_answer() first (409 approval_expired), GET /list annotates via ttl_read(), both creation paths call ttl_issue() (selftest)", "approvals", "protocol", t132),
    ("T133", "ask-before-durable-write: high-stakes memory v2 facts are held in a pending_facts table until explicit accept --id --why; routine facts write silently with provenance; secrets rejected, never held; caps mirror lessons.py (max 3 pending, --why required, PF-001 ids never reused) (selftest)", "memory", "protocol", t133),
    ("T134", "serving-model identity note: per-attempt note stamped at the model-wrapper dispatch boundary (plain when serving == configured) + {from,to,reason} switch log in PATCH model-settings; discrepancy verdict derived from repo evidence (mosicn/nex-n2.6 is the source of truth, xingchiapi/gpt-6-astra is a stale snapshot) (selftest)", "model-identity", "protocol", t134),
    ("T135", "bot-built Pages 2nd gen: routine fires -> re-read state -> pure-render <pages>/<slug>/index.html -> redeploy via deploy-page.py; idempotent (unchanged state = byte-identical file, deploy skipped); fail-closed publish allowlist with state outside the pages tree; deploy failure leaves the last good page + records it (selftest)", "botpages", "protocol", t135),
    ("T136", "eval harness LLM judge: judge.py grades prose via the console chat-task path (mosicn nex-n2.6, no new key); JSON verdict {pass, reason, evidence} in a <verdict> sentinel, non-JSON/missing-field/error/timeout is unqualified never pass; expect_contains refused (ValueError); 12-example calibration set (selftest)", "evals", "protocol", t136),
    ("T137", "memory-recall eval: Layer-1 baseline measured on the real facts.py search (hit@1 0.833, hit@3 1.0, MRR 0.917, staleness + abstention verified); integrity fixtures staged, graded by the T136 judge only, never by substring (selftest)", "memory", "protocol", t137),
    ("T138", "artifacts library: SQLite index over workspace + sent-file metadata + history.db (read-only, mutation-denying authorizer); one searchable static page; backfill for files already sent; re-index is idempotent (selftest)", "artifacts", "protocol", t138),
    ("T139", "real sandbox profile: separate container, workspace-only mount, isolated bridge, read-only rootfs, user 10001, caps dropped ALL, no docker.sock; vault mints short-lived scoped tokens (90s default / 300s max); egress via the T123 allowlist only; dispatcher routes generated-code jobs to sandbox, refuses the rest (selftest)", "sandbox", "protocol", t139),
    ("T140", "per-task cap survives the per-turn agent rebuild (gatefix5): the runtime builds a fresh agent per turn, so the task budget must persist through the state_dict round-trip (task_budget_state_dict / load_task_budget_state_dict, wired into ReactAgent.state_dict / load_state_dict); turn 2 gets 20 more to 40 and finalises, turns 3 and 4 execute 0; snapshot round-trip + loader fails open on bad data (harness, section P of test_task_cap.py)", "loop-gate", "protocol", t140),
    ("T141", "realistic resume messages resume the current task (gatefix6): _is_continuation matches a continuation phrase at the START of the message at a word boundary, not just an exact match -- 'hello, are you working?' and 'Yes, continue from 21' resume the echo task (20 shell, then 20 more to 40 and finalise, then 0); 'yesterday' / 'history' / 'surely' / 'thanksgiving' are NOT continuations; a genuinely new instruction after finalisation still mints a fresh task (harness, section Q of test_task_cap.py)", "loop-gate", "protocol", t141),
    ("T142", "per-chat thinking selector (Default/Off/Low/Medium/High/XHigh): the rule surfaces the backend's GET/PUT /api/chats/{id}/thinking as a selector in the chat composer toolbar itself, in the Smart Mode row next to Smart Mode (user screenshot 2026-11-19), appended into that row (React-safe), Bearer from localStorage, model_key on PUT, pending level applied once a new chat gets an id, 422 revert + re-sync with the server's reason shown next to the selector, lock-hint title when the model takes no thinking level, out-of-set levels shown truthfully, one select per document (moves into the Smart Mode row when it mounts, never a second) (harness)", "thinking", "protocol", t142),
    ("T143", "smart sleep/wake: keep-alive ON/OFF toggle (POST /keepalive, Bearer <redacted>, D1 keepalive:enabled, tick early-return fail-closed, /status + /sleepwake/state keepAlive fields) + max-run guard (sleep at 7h uptime even when busy, WAKE/rest still win) + Hallmark waking/cooldown/status pages (no polling, scaleX bars, keep-alive switch, /status sleepwake.nextRoutineAt) (harness)", "sleepwake", "protocol", t143),
    ("T144", "settings white-area fix round 4 (AX-DIAG removed): settings-white-area rule only — nav-anchored shell + ancestors stretched to 100dvh (!important) and painted with the --app-bg theme variable (#f9f8f4 light / #141414 dark, class fallback), never from the shell's background (the shell is transparent inside a WHITE full-height .index-module__mainContentLayout wrapper that covers the html/body paint), no diagnostic line (AX-DIAG removed in round 4 after the round-3 values were read live), no-op off /settings and before nav mounts, cleanup removes ancestor paint on leaving Settings (harness subset, 19 checks)", "rebrand", "protocol", t144),
    ("T145", "multi-tab takeover (Step 10): the bundle patch registers the owner AbortController and aborts it on BroadcastChannel release-ownership; the Pages queue-takeover rule adds exactly one Take over sending button on the queue-only banner (document-wide guard, moved not recreated, banner-root placement, 15s retry re-enable) and hides the dead Interrupt & send while the banner is up; the takeover2 cache bust renames the chat chunk and versions the entry script (harness, 60 checks)", "queue", "protocol", t145),
]

SKIP_NOTE = {
    "browser": "needs a real logged-in browser (parent agent) — see TESTS.md",
    "needs-token": "needs a user-held secret — never invented; see TESTS.md",
    "needs-rebuild": (
        "the computer was REMOVED 2026-11-15 and is being rebuilt from "
        "Rakazo's design; this test is its acceptance criterion and is "
        "expected to pass again once the rebuild lands (features/computer/)"
    ),
}


def next_round_number():
    if not RESULTS.exists():
        return 1
    nums = [int(n) for n in
            re.findall(r"^## Round (\d+)", RESULTS.read_text(), re.M)]
    return (max(nums) + 1) if nums else 1


def append_round(number, rows, counts):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [f"\n## Round {number} — {now} (UTC), `run-tests.py`",
             "",
             f"Protocol run by the runner; browser / needs-token rows were "
             f"recorded as skipped, not run. "
             f"Summary: " + ", ".join(f"{k}={v}" for k, v in counts.items()
                                      if v) + ".",
             "",
             "| Test | Area | Method | Result | Evidence |",
             "|---|---|---|---|---|"]
    for tid, area, method, result, ev in rows:
        ev = ev.replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {tid} | {area} | {method} | {result} | {ev} |")
    notes = [(tid, result, ev) for tid, _, _, result, ev in rows
             if result not in ("PASS", "NEEDS-BROWSER", "NEEDS-TOKEN")]
    if notes:
        lines += ["", "### Notes (non-pass rows)"]
        for tid, result, ev in notes:
            lines.append(f"- **{tid}** ({result}): {ev}")
    lines.append("")
    with open(RESULTS, "a") as f:
        f.write("\n".join(lines))
    return number


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", default="",
                    help="comma-separated test ids, e.g. T01,T02")
    ap.add_argument("--area", default="", action="append",
                    help="area to run (repeatable), e.g. --area desktop")
    ap.add_argument("--list", action="store_true",
                    help="print the catalogue and exit")
    ap.add_argument("--no-record", action="store_true",
                    help="run without appending a round to RESULTS.md")
    args = ap.parse_args()

    if args.list:
        areas = sorted({t[2] for t in TESTS})
        print(f"{len(TESTS)} tests "
              f"({sum(1 for t in TESTS if t[3] == 'protocol')} protocol, "
              f"{sum(1 for t in TESTS if t[3] == 'browser')} browser, "
              f"{sum(1 for t in TESTS if t[3] == 'needs-token')} needs-token)")
        print("areas: " + ", ".join(areas))
        for tid, name, area, method, _ in TESTS:
            print(f"{tid} [{area}/{method}] {name}")
        return 0

    only = {x.strip() for x in args.only.split(",") if x.strip()}
    areas = {a.strip() for grp in args.area for a in grp.split(",") if a.strip()}
    selected = [t for t in TESTS
                if (not only or t[0] in only)
                and (not areas or t[2] in areas)]
    if not selected:
        print("no tests selected (check --only / --area values)", file=sys.stderr)
        return 2

    rows = []
    counts = {}
    for tid, name, area, method, fn in selected:
        if tid in NEEDS_REBUILD_IDS:
            result = "NEEDS-REBUILD"
            ev = SKIP_NOTE["needs-rebuild"]
            print(f"{tid} [{area}/{method}] {result} — {ev}", flush=True)
        elif method != "protocol" or fn is None:
            result = "NEEDS-BROWSER" if method == "browser" else "NEEDS-TOKEN"
            ev = SKIP_NOTE[method]
            print(f"{tid} [{area}/{method}] {result} — {ev}", flush=True)
        else:
            try:
                result, ev = fn()
            except Exception as e:
                result, ev = "FAIL", f"runner exception: {e}"
            print(f"{tid} [{area}/{method}] {result} — {ev}", flush=True)
        rows.append((tid, area, method, result, ev))
        counts[result] = counts.get(result, 0) + 1

    print(f"\nSummary ({len(rows)} run/selected): "
          + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if not args.no_record:
        n = next_round_number()
        append_round(n, rows, counts)
        print(f"Recorded as Round {n} in {RESULTS}")
    return 0 if counts.get("FAIL", 0) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
