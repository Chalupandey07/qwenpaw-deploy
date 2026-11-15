#!/usr/bin/env python3
"""QwenPaw LOG-CHECK collector.

Pulls the last N lines (default 500) of every QwenPaw log source, plus the
remote Worker/Pages statuses, and writes one JSON snapshot.

Machine logs are read through the InstaBox API (ib.py exec) — READ-ONLY.
Nothing on the machine is written, restarted, or changed. All state
(snapshot + seen.json) lives in this directory, in the repo.

Log sources (every path verified live on machine
m_agq5wqqo2fvypym7rjlpvngc2m, 2026-11-15 ~01:30 UTC):
  - /data/home/qwenpaw/working/qwenpaw.log      (QwenPaw app log file)
  - docker logs qwenpaw                         (container stdout/stderr)
  - journalctl -u camoufox-bridge.service       (bridge; NOTE: there is NO
                                                 /data/home/camoufox/logs/
                                                 directory — the bridge logs
                                                 only to journald)
  - journalctl -u mcp-computer-use.service      (computer-use MCP, :1)
  - journalctl -u mcp-computer-use-qa.service   (computer-use MCP, :2/QA)
  - journalctl -u desktop-lease-watcher.service (lease -> control file)
  - journalctl -u desktop-window-watch.service  (re-map unmapped Chromium)
  - journalctl -u desktop-terminal.service      (PTY server for terminal tab)
  - systemctl is-active for the desktop stack + docker health (services)
Remote (plain HTTPS GET, no tokens):
  - keep-alive Worker /status, Pages main + /status, Pages backup,
    routines /api/status, groupchat /, board /, bot Pages /

Grouping: error/warning records are normalized (timestamps, PIDs, numbers,
UUIDs stripped) and identical normalized records are grouped with a count
and first/last seen. Python tracebacks are joined into one record.
NEW detection: an issue whose normalized key is absent from seen.json
(previous runs) is flagged "new": true, then seen.json is updated.

Secrets: lines that look like tokens/keys/passwords are redacted
([REDACTED]) or dropped before they reach the snapshot. No token or key
is ever needed — every read here is public/status or via the machine API.

Usage:
    python3 collect.py [--lines N] [--out latest.json] [--no-update-seen]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone

MACHINE_ID = "m_agq5wqqo2fvypym7rjlpvngc2m"
IB_PY = os.path.expanduser(
    "~/workspace/custom-connectors/custom.instabox/bin/ib.py")
HERE = os.path.dirname(os.path.abspath(__file__))
SEEN_PATH = os.path.join(HERE, "seen.json")

# ---------------------------------------------------------------- sources

# Each machine source: id, label, kind, path shown in the report, shell
# command template ({n} = lines). Commands run inside ONE ib exec call,
# separated by <<<LOGCHECK:<id>>>> markers, so the whole pull is 1 API call.
MACHINE_SOURCES = [
    {
        "id": "qwenpaw-log",
        "label": "QwenPaw app log",
        "kind": "file",
        "path": "/data/home/qwenpaw/working/qwenpaw.log",
        "cmd": ("if [ -f /data/home/qwenpaw/working/qwenpaw.log ]; then "
                "tail -n {n} /data/home/qwenpaw/working/qwenpaw.log; "
                "else echo 'LOGCHECK_MISSING /data/home/qwenpaw/working/qwenpaw.log'; fi"),
    },
    {
        "id": "container-log",
        "label": "QwenPaw container log (docker logs qwenpaw)",
        "kind": "docker",
        "path": "docker logs qwenpaw",
        "cmd": "docker logs --tail {n} qwenpaw 2>&1",
    },
    {
        "id": "bridge",
        "label": "Camoufox bridge log",
        "kind": "journal",
        "path": "journalctl -u camoufox-bridge.service",
        "cmd": ("journalctl -u camoufox-bridge.service --no-pager "
                "-n {n} --output=short-iso 2>/dev/null"),
    },
    {
        "id": "mcp",
        "label": "Computer-use MCP proxy log (:1)",
        "kind": "journal",
        "path": "journalctl -u mcp-computer-use.service",
        "cmd": ("journalctl -u mcp-computer-use.service --no-pager "
                "-n {n} --output=short-iso 2>/dev/null"),
    },
    {
        "id": "mcp-qa",
        "label": "Computer-use MCP proxy log (:2 / QA)",
        "kind": "journal",
        "path": "journalctl -u mcp-computer-use-qa.service",
        "cmd": ("journalctl -u mcp-computer-use-qa.service --no-pager "
                "-n {n} --output=short-iso 2>/dev/null"),
    },
    {
        "id": "lease-watcher",
        "label": "Desktop lease watcher log",
        "kind": "journal",
        "path": "journalctl -u desktop-lease-watcher.service",
        "cmd": ("journalctl -u desktop-lease-watcher.service --no-pager "
                "-n {n} --output=short-iso 2>/dev/null"),
    },
    {
        "id": "window-watch",
        "label": "Desktop window watch log",
        "kind": "journal",
        "path": "journalctl -u desktop-window-watch.service",
        "cmd": ("journalctl -u desktop-window-watch.service --no-pager "
                "-n {n} --output=short-iso 2>/dev/null"),
    },
    {
        "id": "terminal",
        "label": "Terminal PTY server log",
        "kind": "journal",
        "path": "journalctl -u desktop-terminal.service",
        "cmd": ("journalctl -u desktop-terminal.service --no-pager "
                "-n {n} --output=short-iso 2>/dev/null"),
    },
]

# Units whose active/inactive state is checked (same exec call).
SERVICE_UNITS = [
    "camoufox-bridge.service",
    "mcp-computer-use.service",
    "mcp-computer-use-qa.service",
    "desktop-lease-watcher.service",
    "desktop-window-watch.service",
    "desktop-terminal.service",
    "desktop-terminal-ws.service",
    "desktop-chromium.service",
    "desktop-novnc.service",
    "desktop-novnc-view.service",
    "desktop-novnc-qa.service",
    "desktop-novnc-qa-view.service",
    "desktop-xvfb-qa.service",
    "desktop-vnc-qa.service",
    "desktop-vnc-qa-view.service",
]

# Remote endpoints: id, label, url, body kind (json|html).
REMOTE_SOURCES = [
    ("keepalive", "Keep-alive Worker /status",
     "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev/status", "json"),
    ("pages-main", "Pages main console (qwenpawx) /",
     "https://qwenpawx.pages.dev/", "html"),
    ("pages-main-status", "Pages main /status",
     "https://qwenpawx.pages.dev/status", "html"),
    ("pages-backup", "Pages backup console (qwenpaw-frontend) /",
     "https://qwenpaw-frontend.pages.dev/", "html"),
    ("routines", "Routines Worker /api/status",
     "https://qwenpaw-routines.qwenpaw-rohan.workers.dev/api/status", "json"),
    ("groupchat", "Group chat Worker /",
     "https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev/", "html"),
    ("board", "Ticket board Worker /",
     "https://qwenpaw-board.qwenpaw-rohan.workers.dev/", "html"),
    ("botpages", "Bot Pages (qwenpaw-pages) /",
     "https://qwenpaw-pages.pages.dev/", "html"),
]

# ---------------------------------------------------------------- patterns

ERROR_RE = re.compile(
    r"(traceback|exception|\berror\b|failed|failure"
    r"|refused(?![\"']?\s*:\s*false)|critical|fatal"
    r"|crash|denied|unable to|invalid|panic|segfault"
    r"|not allowed|DriverCardError|ERR_)",
    re.IGNORECASE)
WARN_RE = re.compile(
    r"(\bwarn\w*|deprecated|retry|timed?\s?out|timeout|slow|fallback"
    r"|skipped|missing|not found|\b404\b|\b502\b|\b503\b|unmapped|stale)",
    re.IGNORECASE)

# Log level, when the line carries one (qwenpaw.log uses
# "YYYY-MM-DD HH:MM:SS | LEVEL | file:line | message"). The level beats
# keyword matching: a WARNING that says "Cannot read ..." is a warning,
# not an error.
LEVEL_RE = re.compile(
    r"\|\s*(ERROR|CRITICAL|WARNING|WARN|INFO|DEBUG)\s*\|")
LEVEL_SEV = {"ERROR": "error", "CRITICAL": "error",
             "WARNING": "warning", "WARN": "warning"}

# Lines that are journalctl/exec noise, not log content.
NOISE_RES = [
    re.compile(r"^Hint: You are currently not seeing messages"),
    re.compile(r"^\s+Users in groups 'adm'"),
    re.compile(r"^\s+Pass -q to turn off this notice"),
    re.compile(r"^-- (Logs begin|No entries|Reboot)"),
    re.compile(r"^LOGCHECK_RC:\d+$"),
]

# Secret-looking content: redact the value, keep the line. A value that is
# just a number or a True/False/None literal is a metric, not a secret
# (e.g. "total_tokens=1234" must NOT be redacted).
SECRET_RES = [
    (re.compile(r"([?&]_token=)[^&\s'\"]+"), r"\1[REDACTED]"),
    (re.compile(r"(Authorization:\s*Bearer\s+)\S+", re.IGNORECASE),
     r"\1[REDACTED]"),
    (re.compile(r"(__Host-instabox_port_auth=)[^;\s]+"), r"\1[REDACTED]"),
    (re.compile(r"([?&](?:token|key|secret|password)=)[^&\s'\"]+",
                re.IGNORECASE), r"\1[REDACTED]"),
]
SECRET_KV_RE = re.compile(
    r"\b([A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|"
    r"apikey|bearer)[A-Za-z0-9_-]*\s*[:=]\s*)(['\"]?)([^\s'\",}]+)",
    re.IGNORECASE)
NON_SECRET_VALUES = re.compile(
    r"^(?:[\d.,]+(?:ms|s|kb|mb|gb|%)?|true|false|none|null|yes|no)$",
    re.IGNORECASE)

# Leading timestamp/host/process prefixes, so grouping sees the message.
PREFIX_RES = [
    # qwenpaw.log: 2026-11-15 05:02:08 | WARNING | file.py:120 | message
    re.compile(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*\|\s*"
               r"(?:ERROR|CRITICAL|WARNING|WARN|INFO|DEBUG)\s*\|\s*[^|]+\|\s*"),
    # journal short-iso: 2026-11-15T01:24:45+00:00 host proc[pid]: msg
    re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\S*\s+\S+\s+\S+?:\s"),
    # syslog: Nov 14 23:42:04 host proc[pid]: msg
    re.compile(r"^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+\S+?:\s"),
    # python logging: 2026-11-15 04:19:40,850 INFO msg
    re.compile(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2},\d+\s+\w+\s+"),
    # ISO date + time at line start
    re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*\s+"),
]

TS_RES = [
    re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"),
    re.compile(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})"),
    re.compile(r"([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})"),
]

MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}

# Naive "YYYY-MM-DD HH:MM:SS" timestamps in qwenpaw.log / docker logs are in
# the container's local time (Asia/Kolkata, UTC+5:30) — verified live: the
# container clock read 04:19 while the machine (UTC) read 22:49 the day
# before. Syslog-style "Nov 14 23:42:04" journal lines are UTC.
IST = timezone(timedelta(hours=5, minutes=30))


def parse_ts(line, now):
    """Best-effort timestamp from a log line -> ISO UTC string or None."""
    for rx in TS_RES:
        m = rx.search(line)
        if not m:
            continue
        s = m.group(1)
        try:
            if s[0].isdigit() and len(s) >= 10 and s[4] == "-":
                if "T" in s:
                    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
                else:
                    # Naive date-time: container local time (IST).
                    dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
                    dt = dt.replace(tzinfo=IST)
                return dt.astimezone(timezone.utc).isoformat()
            parts = s.split()
            mon = MONTHS.get(parts[0])
            if mon:
                dt = datetime(now.year, mon, int(parts[1]),
                              *map(int, parts[2].split(":")),
                              tzinfo=timezone.utc)
                return dt.isoformat()
        except (ValueError, IndexError):
            continue
    return None


def strip_prefix(line):
    for rx in PREFIX_RES:
        line = rx.sub("", line, count=1)
    return line


def scrub_line(line):
    """Redact secret-looking values. Returns (line, was_redacted, drop)."""
    if len(line) > 160 and " " not in line.strip():
        # One long spaceless blob (base64/hex) — almost certainly a token.
        if re.fullmatch(r"[A-Za-z0-9+/=_.\-]{160,}", line.strip()):
            return "", True, True
    out = line
    redacted = False
    for rx, repl in SECRET_RES:
        out, n = rx.subn(repl, out)
        redacted = redacted or n > 0

    def _redact_kv(m):
        nonlocal redacted
        value = m.group(3)
        if NON_SECRET_VALUES.match(value):
            return m.group(0)
        redacted = True
        return m.group(1) + "[REDACTED]"

    out = SECRET_KV_RE.sub(_redact_kv, out)
    return out, redacted, False


def normalize(text):
    """Normalize an issue's text so repeats group together."""
    t = strip_prefix(text)
    t = re.sub(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?",
               " ", t)
    t = re.sub(r"\b[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b", " ", t)
    t = re.sub(r"\b\d{2}:\d{2}:\d{2}\b", " ", t)
    t = re.sub(r"\[\d+\]", " ", t)                       # [pid]
    t = re.sub(r"\bpid[= ]\d+\b", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"\b0x[0-9a-f]+\b", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
               " UUID ", t, flags=re.IGNORECASE)
    t = re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", " IP ", t)  # IPv4
    t = re.sub(r"\b\d+\b", "#", t)                        # any bare number
    t = re.sub(r"\s+", " ", t).strip()
    return t[:400]


CHAIN_RE = re.compile(
    r"^(The above exception was the direct cause of the following exception"
    r"|During handling of the above exception, another exception occurred):")


def join_tracebacks(lines):
    """Join Python tracebacks (multi-line) into single records.

    Returns a list of records: {"text": str, "lines": [raw lines],
    "start": index of the first line in `lines`, "tb": bool}. A traceback
    inherits the timestamp of the log line that precedes it (its own lines
    carry none). PyYAML-style detail lines that follow the exception line
    (indented `in "<string>", line N:` / `... context ...` / `^` pointer)
    stay part of the traceback, and a chained-exception line
    ("The above exception was the direct cause ...") attaches to the
    traceback before it instead of becoming its own issue.
    """
    records = []
    buf = []
    buf_start = 0
    exc_line = None
    in_tb = False
    after_exc = False

    def flush():
        nonlocal buf, exc_line, in_tb, after_exc
        if buf:
            records.append({"text": "\n".join(buf), "lines": list(buf),
                            "start": buf_start, "tb": True,
                            "exc": exc_line})
        buf = []
        exc_line = None
        in_tb = False
        after_exc = False

    for i, line in enumerate(lines):
        if "Traceback (most recent call last)" in line:
            if buf:
                flush()
            buf = [line]
            buf_start = i
            exc_line = None
            in_tb = True
            after_exc = False
            continue
        if in_tb:
            if after_exc:
                if not line.strip() or line[0].isspace():
                    buf.append(line)
                    continue
                flush()  # a real new line: traceback is over
            else:
                buf.append(line)
                if line and not line[0].isspace() and re.search(
                        r"(Error|Exception|Warning|KeyboardInterrupt)\s*:",
                        line):
                    exc_line = line
                    after_exc = True
                continue
        if CHAIN_RE.match(line) and records and records[-1].get("tb"):
            records[-1]["text"] += "\n" + line
            records[-1]["lines"].append(line)
            continue
        records.append({"text": line, "lines": [line], "start": i,
                        "tb": False, "exc": None})
    if buf:
        flush()
    return records


# Startup/info lines that keyword matching would wrongly flag
# (e.g. the window watcher announces it watches for "unmapped" windows).
SKIP_RES = [
    re.compile(r"desktop-window-watch: watching :\d+ \+ :\d+ for unmapped"),
]


def analyze_lines(raw_lines, now):
    """Classify lines, group error/warning records. Returns (stats, issues)."""
    scrubbed = 0
    clean = []
    for line in raw_lines:
        if any(rx.search(line) for rx in NOISE_RES):
            continue
        line = line.rstrip("\n")
        if not line.strip():
            continue
        line, _red, drop = scrub_line(line)
        if drop:
            scrubbed += 1
            continue
        if _red:
            scrubbed += 1
        clean.append(line)

    # Per-line timestamps + running "last timestamp seen" (for records
    # whose own lines carry none, e.g. tracebacks).
    line_ts = [parse_ts(ln, now) for ln in clean]
    running_ts = []
    last = None
    for ts in line_ts:
        if ts:
            last = ts
        running_ts.append(last)

    groups = {}
    order = []
    n_err = n_warn = 0
    for rec in join_tracebacks(clean):
        text = rec["text"]
        if any(rx.search(text) for rx in SKIP_RES):
            continue
        is_tb = "Traceback (most recent call last)" in text
        msg = strip_prefix(text)
        level = LEVEL_RE.search(text)
        level_sev = LEVEL_SEV.get(level.group(1)) if level else None
        if is_tb or level_sev == "error":
            sev = "error"
        elif level_sev == "warning":
            sev = "warning"
        elif level:
            continue  # INFO/DEBUG line with no traceback: not an issue.
        elif ERROR_RE.search(msg):
            sev = "error"
        elif WARN_RE.search(msg):
            sev = "warning"
        else:
            continue
        if sev == "error":
            n_err += 1
        else:
            n_warn += 1
        # Grouping key: for a traceback use the exception line; otherwise
        # the normalized message.
        key_text = rec.get("exc") if is_tb else None
        if not key_text:
            key_text = text.splitlines()[-1] if is_tb else text
        key = normalize(key_text)
        if not key:
            continue
        ts = None
        for ln in rec["lines"]:
            ts = parse_ts(ln, now)
            if ts:
                break
        if not ts:
            ts = running_ts[rec["start"]]
        if key not in groups:
            groups[key] = {
                "key": key,
                "severity": sev,
                "count": 0,
                "first_seen": ts,
                "last_seen": ts,
                "samples": [],
            }
            order.append(key)
        g = groups[key]
        g["count"] += 1
        if ts:
            if not g["first_seen"] or ts < g["first_seen"]:
                g["first_seen"] = ts
            if not g["last_seen"] or ts > g["last_seen"]:
                g["last_seen"] = ts
        if len(g["samples"]) < 3:
            g["samples"].append(text[:2000])
    issues = [groups[k] for k in order]
    issues.sort(key=lambda i: (i["severity"] != "error", -i["count"]))
    return {"lines": len(clean), "errors": n_err, "warnings": n_warn,
            "scrubbed": scrubbed}, issues


# ---------------------------------------------------------------- machine pull

def build_machine_script(n):
    parts = ["set -u"]
    for src in MACHINE_SOURCES:
        parts.append("echo '<<<LOGCHECK:%s>>>'" % src["id"])
        parts.append(src["cmd"].format(n=n))
        parts.append("echo \"LOGCHECK_RC:$?\"")
    parts.append("echo '<<<LOGCHECK:services>>>'")
    for unit in SERVICE_UNITS:
        parts.append(
            "printf '%%s %%s\\n' '%s' \"$(systemctl is-active %s "
            "2>/dev/null || echo unknown)\"" % (unit, unit))
    parts.append(
        "docker inspect qwenpaw --format 'container qwenpaw "
        "{{.State.Status}} health={{.State.Health.Status}}' "
        "2>/dev/null || echo 'container qwenpaw MISSING'")
    parts.append("echo \"LOGCHECK_RC:$?\"")
    return "\n".join(parts)


def run_ib_exec(script, timeout_seconds=120):
    """Run one command on the machine via ib.py exec. Returns stdout str."""
    payload = {"cmd": script, "timeoutSeconds": timeout_seconds}
    with tempfile.NamedTemporaryFile("w", suffix=".json",
                                    delete=False) as f:
        json.dump(payload, f)
        path = f.name
    try:
        out = subprocess.run(
            [sys.executable, IB_PY, "exec", MACHINE_ID, path],
            capture_output=True, text=True, timeout=timeout_seconds + 120)
    finally:
        os.unlink(path)
    if out.returncode != 0:
        raise RuntimeError("ib.py exec failed: %s" % out.stderr.strip()[:500])
    data = json.loads(out.stdout)
    if data.get("truncated"):
        raise RuntimeError("machine exec output was truncated by the API")
    return data.get("stdout", ""), data.get("exitCode")


def split_sections(stdout):
    """Split machine output on <<<LOGCHECK:id>>> markers."""
    sections = {}
    current = None
    rcs = {}
    for line in stdout.splitlines():
        m = re.match(r"^<<<LOGCHECK:([a-z0-9-]+)>>>$", line.strip())
        if m:
            current = m.group(1)
            sections[current] = []
            continue
        m = re.match(r"^LOGCHECK_RC:(\d+)$", line.strip())
        if m and current:
            rcs[current] = int(m.group(1))
            continue
        if current is not None:
            sections[current].append(line)
    return sections, rcs


# ---------------------------------------------------------------- remote pull

def fetch_remote(src_id, label, url, kind, timeout=15, attempts=3):
    t0 = time.time()
    body, status, err = "", None, None
    for attempt in range(attempts):
        req = urllib.request.Request(
            url, headers={"User-Agent": "qwenpaw-logcheck/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read(4096).decode("utf-8", "replace")
                status = resp.status
                err = None
            break
        except urllib.error.HTTPError as e:
            try:
                body = e.read(1024).decode("utf-8", "replace")
            except Exception:
                body = ""
            status = e.code
            err = "HTTP %s" % e.code
            break
        except Exception as e:  # DNS, timeout, refused, IncompleteRead, ...
            body, status = "", None
            err = "%s: %s" % (type(e).__name__, e)
            if attempt + 1 < attempts:
                time.sleep(2)
                continue
    elapsed = round((time.time() - t0) * 1000)
    detail = None
    if kind == "json" and body:
        try:
            j = json.loads(body)
            detail = j.get("status") or (j.get("qwenpaw") or {}).get("status")
        except Exception:
            detail = None
    body, _red, _drop = scrub_line(body[:400])
    return {
        "id": src_id,
        "label": label,
        "kind": "remote",
        "path": url,
        "status": "ok" if status and 200 <= status < 300 else "error",
        "http_status": status,
        "elapsed_ms": elapsed,
        "detail": detail,
        "error": err,
        "note": (body[:200] if kind == "json" else None),
    }


# ---------------------------------------------------------------- main

def load_seen():
    try:
        with open(SEEN_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("issues"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"_meta": {"note": "seen issue keys from previous log-check runs"},
            "issues": {}}


def main():
    ap = argparse.ArgumentParser(description="QwenPaw log-check collector")
    ap.add_argument("--lines", type=int, default=500,
                    help="lines per log source (default 500)")
    ap.add_argument("--out", default=os.path.join(HERE, "latest.json"),
                    help="snapshot output path (default latest.json)")
    ap.add_argument("--no-update-seen", action="store_true",
                    help="do not update seen.json (dry-run NEW flags)")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    seen = load_seen()
    seen_issues = seen.get("issues", {})

    sources = []
    total_err = total_warn = total_scrubbed = 0
    new_keys = set()
    missing = []
    machine_ok = True

    # --- machine logs (one exec call) ---
    try:
        stdout, _rc = run_ib_exec(build_machine_script(args.lines))
        sections, rcs = split_sections(stdout)
    except Exception as e:
        machine_ok = False
        sections, rcs = {}, {}
        machine_error = str(e)

    for src in MACHINE_SOURCES:
        sid = src["id"]
        lines = sections.get(sid)
        rc = rcs.get(sid)
        if not machine_ok:
            sources.append({**{k: src[k] for k in ("id", "label", "kind", "path")},
                            "status": "error", "lines": 0, "errors": 0,
                            "warnings": 0, "issues": [],
                            "note": "machine pull failed: %s" % machine_error})
            missing.append(sid)
            continue
        if lines is None:
            sources.append({**{k: src[k] for k in ("id", "label", "kind", "path")},
                            "status": "error", "lines": 0, "errors": 0,
                            "warnings": 0, "issues": [],
                            "note": "no section returned for this source"})
            missing.append(sid)
            continue
        if lines and lines[0].startswith("LOGCHECK_MISSING"):
            sources.append({**{k: src[k] for k in ("id", "label", "kind", "path")},
                            "status": "missing", "lines": 0, "errors": 0,
                            "warnings": 0, "issues": [],
                            "note": lines[0]})
            missing.append(sid)
            continue
        stats, issues = analyze_lines(lines, now)
        total_scrubbed += stats["scrubbed"]
        for iss in issues:
            iss["new"] = iss["key"] not in seen_issues
            if iss["new"]:
                new_keys.add(iss["key"])
            total_err += iss["count"] if iss["severity"] == "error" else 0
            total_warn += iss["count"] if iss["severity"] == "warning" else 0
        sources.append({**{k: src[k] for k in ("id", "label", "kind", "path")},
                        "status": "ok", "lines": stats["lines"],
                        "errors": stats["errors"],
                        "warnings": stats["warnings"],
                        "scrubbed": stats["scrubbed"],
                        "issues": issues})

    # --- services ---
    services = []
    svc_lines = sections.get("services", []) if machine_ok else []
    for line in svc_lines:
        if line.startswith("container "):
            continue  # handled below as the container line, not a unit
        parts = line.split(None, 1)
        if len(parts) == 2:
            services.append({"unit": parts[0], "state": parts[1].strip()})
    container_line = next(
        (l for l in svc_lines if l.startswith("container qwenpaw")), None)
    container_state = container_line or "container qwenpaw unknown"
    if machine_ok and any(s["state"] != "active" for s in services):
        missing.append("services-not-all-active")

    # --- remote statuses ---
    for src_id, label, url, kind in REMOTE_SOURCES:
        r = fetch_remote(src_id, label, url, kind)
        sources.append(r)
        if r["status"] != "ok":
            missing.append(src_id)

    # --- update seen.json with every issue key seen this run ---
    if not args.no_update_seen:
        for src in sources:
            for iss in src.get("issues", []):
                prev = seen_issues.get(iss["key"])
                seen_issues[iss["key"]] = {
                    "first_seen": (prev or {}).get("first_seen")
                                  or iss.get("first_seen") or now_iso,
                    "last_seen": iss.get("last_seen") or now_iso,
                    "count": (prev or {}).get("count", 0) + iss["count"],
                    "source": src["id"],
                }
        seen["_meta"] = {
            "note": "Normalized issue keys seen by log-check. "
                    "An issue is NEW when its key is absent here. "
                    "Do not edit by hand except to clear a key you have "
                    "fixed and want to be re-flagged as NEW if it returns.",
            "updated_at_utc": now_iso,
            "total_keys": len(seen_issues),
        }
        seen["issues"] = seen_issues
        with open(SEEN_PATH, "w") as f:
            json.dump(seen, f, indent=2, sort_keys=True)

    snapshot = {
        "generated_at_utc": now_iso,
        "machine_id": MACHINE_ID,
        "lines_per_source": args.lines,
        "machine_pull_ok": machine_ok,
        "services": services,
        "container": container_state,
        "sources": sources,
        "summary": {
            "total_errors": total_err,
            "total_warnings": total_warn,
            "new_issues": len(new_keys),
            "sources_ok": sum(1 for s in sources if s["status"] == "ok"),
            "sources_total": len(sources),
            "sources_missing_or_error": missing,
            "lines_scrubbed": total_scrubbed,
            "seen_keys_total": len(seen_issues),
        },
    }
    with open(args.out, "w") as f:
        json.dump(snapshot, f, indent=2)

    print("log-check collected at %s" % now_iso)
    print("  sources: %d ok / %d total; missing/error: %s"
          % (snapshot["summary"]["sources_ok"],
             snapshot["summary"]["sources_total"],
             ", ".join(missing) if missing else "none"))
    print("  errors: %d  warnings: %d  NEW issues: %d  lines scrubbed: %d"
          % (total_err, total_warn, len(new_keys), total_scrubbed))
    print("  snapshot: %s" % args.out)
    print("  seen.json keys: %d" % len(seen_issues))
    return 0


if __name__ == "__main__":
    sys.exit(main())
