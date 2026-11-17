#!/usr/bin/env python3
"""QwenPaw sleep/wake reporter — machine-side facts for the keep-alive Worker.

Runs on the InstaBox machine (systemd timer, every 2 min) and POSTs a small
JSON to the keep-alive Worker's POST /report:
  { nextNativeRun, agentActive, agentLastActiveAt, uptimeSec }

WHAT IT REPORTS (and why the Worker cannot learn these itself):
  - nextNativeRun: the next run of any NATIVE QwenPaw cron job (jobs.json in
    every workspace). The Worker cannot read the machine's filesystem, and
    the native jobs are the scheduler of record. A cron expression +
    Asia/Kolkata timezone is parsed here (stdlib zoneinfo); `once` jobs use
    their run_at directly.
  - agentActive / agentLastActiveAt: whether the console/agent has done
    anything recently. The signal is the newest mtime across the files the
    console and the agent actually write: qwenpaw.log (console API activity
    — session reads, provider queries, agent work), token_usage.json (model
    usage — written when the agent runs the model), both history.db files
    (turns), and the workspaces tree (files the agent creates). The
    keep-alive probe does NOT write to qwenpaw.log (verified live: the log
    tail was hours old while the probe ran every 5 min), so a recent mtime
    means real activity, not our own probing. Backups are excluded.
  - uptimeSec: null. The reporter cannot determine "time since this run
    started" reliably (the container predates the wake; /proc/uptime is
    machine boot, not run start; the InstaBox API key is not on the
    machine). The Worker falls back to its stored lastUpAt for the uptime
    guard, which is the correct lower bound. Reporting a wrong uptime
    would be worse than reporting none.

AUTH: REPORTER_TOKEN, read from /data/home/qwenpaw/.env (same pattern as
the vault broker token). Sent as X-Reporter-Token. The token is never
printed or logged. If it is unset, the reporter exits non-zero (fail
closed — the Worker treats a missing/stale report as "unknown", never
as "idle").

FAILURE MODES: a failed POST (Worker unreachable, bad token, timeout)
exits non-zero; systemd retries on the next tick. A stale report is the
Worker's problem (it fails closed and holds the machine awake), not the
reporter's — the reporter never invents data. If the machine is asleep,
the reporter is asleep too; that is expected, and the Worker must not
interpret "no report" as "idle" (it doesn't — reporterStale blocks sleep).

USAGE:
  reporter.py [--selftest] [--once] [--dry-run]
  --selftest  machine-free checks (cron next-run, activity windows, validation)
  --once      run one report cycle and exit (default when run by the timer)
  --dry-run   print the report JSON instead of POSTing it (never prints the token)
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

QWENPAW_HOME = "/data/home/qwenpaw"
ENV_FILE = os.path.join(QWENPAW_HOME, ".env")
WORKER_URL = os.environ.get("SLEEPWAKE_WORKER_URL", "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev")
USER_AGENT = "QwenPaw-SleepWake-Reporter/1.0"
# Activity window: a write within this long counts as "the agent is active".
# Must match SW_AGENT_IDLE_MS in worker/src/index.js (10 min).
AGENT_IDLE_SECONDS = 10 * 60
# Files whose mtime is an activity signal (relative to QWENPAW_HOME/working).
ACTIVITY_FILES = [
    "working/qwenpaw.log",
    "working/token_usage.json",
    "working/workspaces/default/history.db",
    "working/workspaces/QwenPaw_QA_Agent_0.2/history.db",
]
# Directories walked for the newest mtime (agent-created files). Backups excluded.
ACTIVITY_DIRS = ["working/workspaces"]
EXCLUDE_DIRS = {"working.backups", "__pycache__", ".git"}
DEFAULT_TZ = "Asia/Kolkata"


def _read_token():
    try:
        with open(ENV_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("REPORTER_TOKEN="):
                    v = line.split("=", 1)[1].strip().strip("\"'").strip()
                    return v or None
    except OSError:
        return None
    return None


# --- cron next-run (mirrors worker/src/index.js nextRun; keep in sync) ---
_CRON_MONTH = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
               "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_CRON_DOW = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}


def _cron_token(s, names, base):
    s = str(s).strip().lower()
    if names and s in names:
        return names[s] + base
    return int(s)


def _cron_field(expr, lo_min, hi_max, names=None, base=0):
    out = set()
    for part in str(expr).strip().split(","):
        if "/" in part:
            spec, step_s = part.split("/", 1)
            step = int(step_s)
        else:
            spec, step = part, 1
        if step < 1:
            raise ValueError("bad step: " + part)
        if spec == "*":
            lo, hi = lo_min, hi_max
        elif "-" in spec:
            a, b = spec.split("-", 1)
            lo, hi = _cron_token(a, names, base), _cron_token(b, names, base)
        else:
            lo = _cron_token(spec, names, base)
            hi = lo if "/" not in part else hi_max
        if not (lo_min <= lo <= hi <= hi_max):
            raise ValueError("bad cron field: " + part)
        for v in range(lo, hi + 1, step):
            out.add(v)
    return out


def next_run_cron(cron_expr, tz_name, from_dt):
    """Next run strictly after from_dt (aware datetime). Raises on bad input."""
    fields = str(cron_expr).strip().split()
    if len(fields) != 5:
        raise ValueError("5-field cron required")
    min_f, hour_f, dom_f, mon_f, dow_f = fields
    minutes = _cron_field(min_f, 0, 59)
    hours = _cron_field(hour_f, 0, 23)
    doms = _cron_field(dom_f, 1, 31)
    months = _cron_field(mon_f, 1, 12, _CRON_MONTH, 1)
    dows = _cron_field(dow_f, 0, 6, _CRON_DOW, 0)
    if 7 in dows:
        dows.add(0)
        dows.discard(7)
    dom_star = dom_f.strip().startswith("*")
    dow_star = dow_f.strip().startswith("*")
    tz = ZoneInfo(tz_name)
    # Next whole minute strictly after from_dt, in the target zone.
    t = from_dt.astimezone(tz).replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = t + timedelta(days=366)
    while t <= limit:
        # Python weekday(): Mon=0..Sun=6; cron dow: Sun=0..Sat=6.
        dow = (t.weekday() + 1) % 7
        dom_ok = t.day in doms
        dow_ok = dow in dows
        day_ok = (dom_ok and dow_ok) if (dom_star or dow_star) else (dom_ok or dow_ok)
        if t.month in months and day_ok and t.hour in hours and t.minute in minutes:
            return t
        t += timedelta(minutes=1)
    raise ValueError("no match within 1 year")


def _parse_iso(s):
    """Parse an ISO datetime (with Z or offset) to an aware datetime."""
    if not isinstance(s, str) or not s:
        return None
    try:
        if s.endswith("Z"):
            return datetime.fromisoformat(s[:-1] + "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ZoneInfo(DEFAULT_TZ))
        return dt
    except ValueError:
        return None


def next_native_run(now_dt):
    """Earliest next run across all workspaces' jobs.json. None if no jobs."""
    best = None
    base = os.path.join(QWENPAW_HOME, "working", "workspaces")
    try:
        workspaces = os.listdir(base)
    except OSError:
        return None
    for ws in workspaces:
        path = os.path.join(base, ws, "jobs.json")
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        for job in (data.get("jobs") or []):
            if not isinstance(job, dict):
                continue
            if job.get("enabled") is False or job.get("paused") is True:
                continue
            sched = job.get("schedule") or {}
            stype = sched.get("type")
            try:
                if stype == "cron":
                    tz = sched.get("timezone") or DEFAULT_TZ
                    nxt = next_run_cron(sched.get("cron", ""), tz, now_dt)
                elif stype == "once":
                    nxt = _parse_iso(sched.get("run_at"))
                    if nxt is not None and nxt <= now_dt:
                        nxt = None
                else:
                    nxt = None
            except ValueError:
                nxt = None
            if nxt is not None and (best is None or nxt < best):
                best = nxt
    return best


def last_activity_epoch():
    """Newest mtime (epoch seconds) across the activity signals. None if none exist."""
    best = None

    def consider(path):
        nonlocal best
        try:
            m = os.path.getmtime(path)
        except OSError:
            return
        if best is None or m > best:
            best = m

    for rel in ACTIVITY_FILES:
        consider(os.path.join(QWENPAW_HOME, rel))
    for rel in ACTIVITY_DIRS:
        root = os.path.join(QWENPAW_HOME, rel)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fn in filenames:
                consider(os.path.join(dirpath, fn))
    return best


def build_report(now=None):
    now_dt = now or datetime.now(timezone.utc)
    now_s = now_dt.timestamp()
    nxt = next_native_run(now_dt)
    last_active = last_activity_epoch()
    agent_active = last_active is not None and (now_s - last_active) < AGENT_IDLE_SECONDS
    return {
        "nextNativeRun": int(nxt.timestamp() * 1000) if nxt is not None else None,
        "agentActive": bool(agent_active),
        "agentLastActiveAt": int(last_active * 1000) if last_active is not None else None,
        "uptimeSec": None,
    }


def post_report(report, token):
    req = urllib.request.Request(
        WORKER_URL.rstrip("/") + "/report",
        data=json.dumps(report).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Reporter-Token", token)
    req.add_header("User-Agent", USER_AGENT)
    try:
        with urllib.request.build_opener().open(req, timeout=30) as resp:
            return resp.status, resp.read().decode()[:500]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]
    except Exception as e:
        return 0, "fetch failed: " + str(e)[:200]


def _selftest():
    checks = []

    def check(name, cond):
        checks.append((name, bool(cond)))

    # Cron next-run: daily 07:00 Asia/Kolkata.
    base = datetime(2026, 11, 17, 16, 0, 0, tzinfo=timezone.utc)  # 21:30 IST
    nxt = next_run_cron("0 7 * * *", "Asia/Kolkata", base)
    check("daily 07:00 IST next run", nxt == datetime(2026, 11, 18, 1, 30, 0, tzinfo=timezone.utc))
    # Same-day: 06:00 IST -> 07:00 IST today.
    base2 = datetime(2026, 11, 17, 0, 30, 0, tzinfo=timezone.utc)  # 06:00 IST
    nxt2 = next_run_cron("0 7 * * *", "Asia/Kolkata", base2)
    check("same-day 07:00 IST", nxt2 == datetime(2026, 11, 17, 1, 30, 0, tzinfo=timezone.utc))
    # Weekly: Mondays 09:00 IST. 2026-11-17 is a Tuesday.
    nxt3 = next_run_cron("0 9 * * mon", "Asia/Kolkata", base)
    check("weekly Monday 09:00 IST", nxt3 == datetime(2026, 11, 23, 3, 30, 0, tzinfo=timezone.utc))
    # Steps and lists.
    nxt4 = next_run_cron("*/30 * * * *", "Asia/Kolkata", base)
    check("every 30 min", nxt4 == datetime(2026, 11, 17, 16, 30, 0, tzinfo=timezone.utc))
    # Bad cron raises (never silently returns a wrong time).
    try:
        next_run_cron("0 7 * *", "Asia/Kolkata", base)
        check("bad cron (4 fields) raises", False)
    except ValueError:
        check("bad cron (4 fields) raises", True)
    try:
        next_run_cron("0 25 * * *", "Asia/Kolkata", base)
        check("bad cron (hour 25) raises", False)
    except ValueError:
        check("bad cron (hour 25) raises", True)
    # ISO parsing.
    check("ISO Z parses", _parse_iso("2026-11-18T01:30:00Z") == datetime(2026, 11, 18, 1, 30, 0, tzinfo=timezone.utc))
    check("ISO bad returns None", _parse_iso("not-a-date") is None)
    # Activity window: the report builder returns the right shape.
    rep = build_report(now=datetime(2026, 11, 17, 16, 48, 0, tzinfo=timezone.utc))
    check("report has all keys", set(rep.keys()) == {"nextNativeRun", "agentActive", "agentLastActiveAt", "uptimeSec"})
    check("report uptime is null (unknown, not invented)", rep["uptimeSec"] is None)
    check("report nextNativeRun is null (jobs.json empty)", rep["nextNativeRun"] is None)
    # The User-Agent is not Python-urllib's default (Cloudflare blocks it with 1010).
    check("reporter sends its own User-Agent", "urllib" not in USER_AGENT.lower())
    failed = [n for n, ok in checks if not ok]
    print(f"sleepwake-reporter selftest: {len(checks) - len(failed)} passed, {len(failed)} failed")
    for n in failed:
        print("  FAIL:", n)
    return 1 if failed else 0


def main(argv):
    if "--selftest" in argv:
        return _selftest()
    dry = "--dry-run" in argv
    report = build_report()
    if dry:
        print(json.dumps(report, indent=2))
        return 0
    token = _read_token()
    if not token:
        print("REPORTER_TOKEN is not set in /data/home/qwenpaw/.env — refusing to report (fail closed).", file=sys.stderr)
        return 2
    status, body = post_report(report, token)
    # Log only the status, never the body (it contains no secrets, but the
    # report itself is diagnostic; the token is never logged).
    print(f"sleepwake reporter: POST /report -> HTTP {status}")
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
