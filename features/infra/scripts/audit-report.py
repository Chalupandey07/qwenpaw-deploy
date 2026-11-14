#!/usr/bin/env python3
"""Audit report for QwenPaw on InstaBox Free (READ-ONLY).

Sources (all read, never written):
  1. working/governance/audit.db — QwenPaw's own governance audit table
     `audit_events` (ts, workspace_dir, agent_id, session_id, tool_name,
     target, decision, reason, extra). Verified 2026-11-15: 1 table, 5 rows,
     all tool-guard decisions (e.g. Read … allow). It does NOT record
     logins, chat content, or sent messages.
  2. working/qwenpaw.log — tail + ERROR/WARNING counts (timestamps parsed).
  3. working/governance/manual-audit.jsonl — human/operator-appended
     actions (see 18-audit-log.md for the append convention). Optional.

Usage (on the machine, needs sudo for root-owned files):
  sudo python3 audit-report.py [--lines 200] [--out report.txt]
  sudo python3 audit-report.py --events 20

Limits, stated plainly:
  - No row-level security, no encryption at rest beyond the disk: the
    audit trail is a SQLite file on the machine, root-owned. Anyone with
    machine root can read or rewrite it. That is the honest limit of
    "audit" on this setup; a tamper-evident log needs an external store,
    which does not exist on InstaBox Free.
  - QwenPaw only logs what its tool guard decides. There is no hook for
    "user did X in the console". Gaps are filled by the manual-append
    convention, not by pretending the DB covers them.
"""
import argparse
import datetime
import json
import os
import re
import sqlite3
import sys

DEFAULT_ROOT = "/data/home/qwenpaw"
TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \| (\w+) \|")


def fmt_ts(ms):
    try:
        return datetime.datetime.fromtimestamp(
            ms / 1000, tz=datetime.timezone.utc
        ).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    except Exception:  # noqa: BLE001
        return str(ms)


def read_audit_db(path, limit):
    if not os.path.isfile(path):
        return {"exists": False, "rows": 0, "events": [], "by_tool": {}, "by_decision": {}}
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        total = con.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
        rows = con.execute(
            "SELECT ts, workspace_dir, agent_id, session_id, tool_name, target,"
            " decision, reason FROM audit_events ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
        by_tool = dict(con.execute(
            "SELECT tool_name, COUNT(*) FROM audit_events GROUP BY tool_name"
        ).fetchall())
        by_decision = dict(con.execute(
            "SELECT decision, COUNT(*) FROM audit_events GROUP BY decision"
        ).fetchall())
    finally:
        con.close()
    events = [{
        "ts": fmt_ts(r[0]), "workspace": os.path.basename(r[1] or ""),
        "agent": r[2], "session": r[3], "tool": r[4], "target": r[5],
        "decision": r[6], "reason": r[7],
    } for r in rows]
    return {"exists": True, "rows": total, "events": events,
            "by_tool": by_tool, "by_decision": by_decision}


def read_log_tail(path, lines):
    if not os.path.isfile(path):
        return {"exists": False}
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        block = 65536
        data = b""
        while len(data) < lines * 200 and size > 0:
            step = min(block, size)
            size -= step
            f.seek(size)
            data = f.read(step) + data
            if data.count(b"\n") > lines:
                break
    text = data.decode("utf-8", "replace").splitlines()[-lines:]
    errors = warnings = 0
    last_error = None
    for line in text:
        m = TS_RE.match(line)
        if m:
            if m.group(2) == "ERROR":
                errors += 1
                last_error = line[:300]
            elif m.group(2) == "WARNING":
                warnings += 1
    return {"exists": True, "path": path, "tail_lines": len(text),
            "errors_in_tail": errors, "warnings_in_tail": warnings,
            "last_error": last_error, "tail": text[-15:]}


def read_manual_log(path):
    if not os.path.isfile(path):
        return {"exists": False, "entries": []}
    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    entries.append({"_unparsed": line[:200]})
    return {"exists": True, "entries": entries[-50:]}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", default=DEFAULT_ROOT)
    p.add_argument("--lines", type=int, default=200)
    p.add_argument("--events", type=int, default=20)
    p.add_argument("--out", default=None)
    args = p.parse_args()

    db = read_audit_db(
        os.path.join(args.root, "working", "governance", "audit.db"), args.events)
    log = read_log_tail(
        os.path.join(args.root, "working", "qwenpaw.log"), args.lines)
    manual = read_manual_log(
        os.path.join(args.root, "working", "governance", "manual-audit.jsonl"))

    out = []
    out.append("QwenPaw audit report — generated "
               + datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z"))
    out.append("")
    out.append("== 1. Governance audit DB (working/governance/audit.db) ==")
    if not db["exists"]:
        out.append("MISSING — no audit.db found.")
    else:
        out.append(f"rows: {db['rows']}  by decision: {db['by_decision']}  "
                   f"by tool: {db['by_tool']}")
        out.append("NOTE: this table records tool-guard decisions only "
                   "(file reads, tool calls). No logins, no chat content.")
        for e in db["events"]:
            out.append(f"  {e['ts']}  {e['agent']}  {e['tool']}  {e['target']}  "
                       f"-> {e['decision']}  ({e['reason']})")
    out.append("")
    out.append("== 2. Application log tail (working/qwenpaw.log) ==")
    if not log["exists"]:
        out.append("MISSING — no qwenpaw.log found.")
    else:
        out.append(f"tail lines scanned: {log['tail_lines']}  "
                   f"ERROR: {log['errors_in_tail']}  "
                   f"WARNING: {log['warnings_in_tail']}")
        if log["last_error"]:
            out.append(f"last ERROR in tail: {log['last_error']}")
        out.append("--- last 15 log lines ---")
        out.extend("  " + ln[:300] for ln in log["tail"])
    out.append("")
    out.append("== 3. Manual audit log (governance/manual-audit.jsonl) ==")
    if not manual["exists"]:
        out.append("not present — see 18-audit-log.md for the append convention.")
    else:
        for e in manual["entries"]:
            out.append("  " + json.dumps(e, ensure_ascii=False)[:300])
    out.append("")
    out.append("== Limits ==")
    out.append("SQLite file on disk, root-owned. No RLS, no encryption at rest,")
    out.append("no tamper evidence. Anyone with machine root can rewrite it.")

    text = "\n".join(out) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {args.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
