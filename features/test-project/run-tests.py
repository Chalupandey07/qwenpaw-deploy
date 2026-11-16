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
    markers = sorted(set(re.findall(r"qwenpawComputer(?:Btn|Panel)", body)))
    ok = code == 200 and "<title>QwenPaw Console</title>" in body \
        and "qwenpawComputerBtn" in markers and "qwenpawComputerPanel" in markers
    return ("PASS" if ok else "FAIL",
            f"HTTP {code} size={len(body)} markers={markers}")


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
    code, body = http_get(PAGES + "/desktop", timeout=60)
    ok = code == 200 and "Opening the desktop" in body \
        and "Checking your QwenPaw login" in body
    return ("PASS" if ok else "FAIL",
            f"HTTP {code} size={len(body)} gate={'Opening the desktop' in body}")


def t05():
    _, d_body = http_get(PAGES + "/desktop/__lease", timeout=30)
    _, q_body = http_get(PAGES + "/desktop/__lease?computer=qa", timeout=30)
    try:
        d, q = json.loads(d_body), json.loads(q_body)
    except Exception:
        return "FAIL", f"unparsable lease JSON: default={one_line(d_body, 100)} qa={one_line(q_body, 100)}"
    ok = d.get("holder") == "agent" and d.get("leaseId") is None \
        and q.get("holder") == "agent" and q.get("leaseId") is None \
        and isinstance(d.get("generation"), int) \
        and isinstance(q.get("generation"), int)
    return ("PASS" if ok else "FAIL",
            f"default={one_line(d_body, 120)} qa={one_line(q_body, 120)}")


def t06():
    code, body = http_get(PAGES + "/desktop/vendor/xterm.js", timeout=60)
    ok = code == 200 and len(body) > 100000 and "xterm" in body.lower()
    return ("PASS" if ok else "FAIL",
            f"HTTP {code} size={len(body)}")


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
    good = code1 == 200 and "QwenPaw Routines" in body1 \
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
    good = total == 19 and of == 19 and enabled == 19 and disabled == 0 \
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
    paid plan (API 403 code 10195) — but its benchmark arithmetic is the
    measurement of record and the VM runner reuses it verbatim, so this test
    guards the numbers both implementations report.
    """
    return _harness("features/codemode/harness-codemode.mjs", 68)


def t94():
    """Code Mode VM runner: fixed job, bounds, honest per-step reporting (64)."""
    return _py_script_harness(["features/codemode/vm/codemode-runner.py", "--selftest"], 64)


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
    return _harness("features/computer/harness-terminal-proxy.mjs", 54)


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
    return _py_harness("features/codemode/vm/test_mcp.py", 27)


def t96():
    """Code Mode end to end: runner -> real MCP -> real HTTP (44 checks)."""
    return _py_harness("features/codemode/vm/test_e2e.py", 44)

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
    """The Pages Worker LOADS and RUNS (40 checks).

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
    """
    return _harness("features/computer/harness-worker-load.mjs", 40)


def t85():
    """Skill scanner: credential/RCE/injection patterns on third-party skills.

    41 checks. Offline and deterministic, so it can gate every commit; the
    LLM-backed SkillSpector stays the deep review for high-trust skills.
    """
    rc, out, err = run_local(
        [sys.executable, str(REPO / "features/skills/scan.py"), "--selftest"],
        timeout=180)
    m = re.search(r"(\d+) passed, (\d+) failed", out)
    ok = rc == 0 and m and int(m.group(2)) == 0 and int(m.group(1)) == 41
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
    ("T31", "skills list: 19 enabled, 0 disabled", "skills", "protocol", t31),
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
    ("T88", "Pages Worker loads and runs (proxy + /computer wired)", "computer", "protocol", t88),
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
