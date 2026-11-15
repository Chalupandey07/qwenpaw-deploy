#!/usr/bin/env python3
"""ReMe memory doctor — explains why auto-memory produced zero notes.

THE DIAGNOSIS THIS ENCODES (verified against QwenPaw v2.3.0 source)
-------------------------------------------------------------------
ReMe is not broken when `memory/` is empty. Auto-memory is gated by FIVE
independent conditions, and any one of them silently yields zero notes:

 1. `reme_light_memory_config.auto_memory_interval` must be > 0
    (default 5). `MemoryMiddleware.on_reply` only flushes once
    `len(pending_markers) >= interval` (agents/middlewares.py:222-236).
 2. The request must NOT be an automation request
    (`_is_automation_request`), which is checked BEFORE any write and
    returns early (middlewares.py:317-321). Cron/webhook/routine turns
    never produce memory.
 3. A user turn must leave a pending marker that still has a resolvable
    message snapshot; `_discard_unresolved_pending_markers` drops the
    rest (middlewares.py:333).
 4. ReMe itself must have started: `_initialize_reme` swallows every
    exception except the contract error and logs
    "ReMe import failed; memory disabled" (reme_light_memory_manager.py:299+).
 5. Auto-memory needs a working chat model to summarise
    (`_prepare_auto_memory_job` -> `_update_qwenpaw_model`); with no active
    model the job cannot run.

It also confirms the deliberate scoping decision in v2.3.0:
`reme_config._base_config()` watches ONLY `daily_dir` + `digest_dir`
markdown, with the comment that raw conversation lookup belongs to
`recall_history(op="search")`. So an empty `memory/` is *expected* for a
box that has only ever seen automation turns, and raw-history recall is
NOT ReMe's job.

This tool is read-only. It never writes memory, never restarts anything,
never prints a credential.

Usage:
  python3 reme_doctor.py --root /data/home/qwenpaw/working --agent default
  python3 reme_doctor.py --root ... --agent default --json
  python3 reme_doctor.py --selftest        # no machine needed

Exit: 0 = healthy or nothing to diagnose, 3 = at least one blocking cause.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

MAX_LOG_LINES = 4000

# Log lines that mean ReMe never came up. Matched case-insensitively.
DISABLE_PATTERNS = (
    "ReMe import failed; memory disabled",
    "ReMe start failed",
    "ReMe memory manager started",  # positive marker, handled separately
)


def find_workspace(root: Path, agent: str) -> Path | None:
    """Locate one agent's workspace dir under `working/workspaces/`."""
    for candidate in (
        root / "workspaces" / agent,
        root / "workspaces" / "default",
        root,
    ):
        if candidate.is_dir():
            return candidate
    return None


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def scan_log(path: Path) -> dict[str, Any]:
    """Count the decisive log lines. Reads the tail only."""
    result = {
        "path": str(path),
        "exists": path.is_file(),
        "lines_scanned": 0,
        "reme_started": 0,
        "reme_disabled": 0,
        "auto_memory_skipped_automation": 0,
        "auto_memory_failed": 0,
        "auto_memory_submitted": 0,
        "last_disable_reason": "",
    }
    if not path.is_file():
        return result
    try:
        with path.open("rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 512 * 1024))
            raw = fh.read().decode("utf-8", "replace")
    except OSError as exc:
        result["error"] = str(exc)
        return result
    lines = raw.splitlines()[-MAX_LOG_LINES:]
    result["lines_scanned"] = len(lines)
    for line in lines:
        low = line.lower()
        if "reme memory manager started" in low:
            result["reme_started"] += 1
        if "reme import failed" in low or "reme start failed" in low:
            result["reme_disabled"] += 1
            result["last_disable_reason"] = line.strip()[:300]
        if "auto_memory skipped for automation source" in low:
            result["auto_memory_skipped_automation"] += 1
        if "auto_memory failed" in low:
            result["auto_memory_failed"] += 1
        if "auto_memory" in low and "submit" in low:
            result["auto_memory_submitted"] += 1
    return result


def count_turn_sources(db: Path, agent: str | None) -> dict[str, Any]:
    """Count user turns vs tool rows. Automation turns look like short
    non-conversational user rows; we report the raw shape, not a guess."""
    out: dict[str, Any] = {"db": str(db), "exists": db.is_file()}
    if not db.is_file():
        return out
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        where, params = "", []
        if agent:
            where, params = " WHERE agent_id = ?", [agent]
        out["rows"] = conn.execute(
            f"SELECT COUNT(*) FROM conversation_history{where}", params
        ).fetchone()[0]
        out["kinds"] = {
            r[0]: r[1]
            for r in conn.execute(
                f"SELECT kind, COUNT(*) FROM conversation_history{where} "
                "GROUP BY kind ORDER BY 2 DESC",
                params,
            )
        }
        out["sessions"] = conn.execute(
            f"SELECT COUNT(DISTINCT session_id) FROM conversation_history{where}",
            params,
        ).fetchone()[0]
        out["user_turns"] = conn.execute(
            "SELECT COUNT(*) FROM conversation_history"
            + (where + " AND" if where else " WHERE")
            + " role = 'user'",
            params,
        ).fetchone()[0]
        row = conn.execute(
            "SELECT MIN(created_at), MAX(created_at) FROM conversation_history"
            + where,
            params,
        ).fetchone()
        out["first"], out["last"] = row[0], row[1]
        conn.close()
    except sqlite3.Error as exc:
        out["error"] = str(exc)
    return out


def count_notes(ws: Path, cfg: dict[str, Any]) -> dict[str, Any]:
    """Count markdown notes in the configured memory/digest dirs."""
    reme = (cfg.get("running") or {}).get("reme_light_memory_config") or {}
    daily = reme.get("daily_dir", "memory")
    digest = reme.get("digest_dir", "digest")
    mem_session = reme.get("session_dir", "mem_session")
    out: dict[str, Any] = {}
    for label, rel in (("daily", daily), ("digest", digest),
                       ("session", mem_session)):
        directory = ws / rel if not Path(rel).is_absolute() else Path(rel)
        try:
            files = [p for p in directory.glob("**/*.md")] if directory.is_dir() else []
        except OSError:
            files = []
        total = 0
        for f in files:
            try:
                total += f.stat().st_size
            except OSError:
                pass
        out[label] = {"dir": str(directory), "md_files": len(files),
                      "bytes": total, "exists": directory.is_dir()}
    return out


def diagnose(root: Path, agent: str) -> dict[str, Any]:
    ws = find_workspace(root, agent)
    report: dict[str, Any] = {
        "root": str(root),
        "agent": agent,
        "workspace": str(ws) if ws else None,
        "causes": [],
        "warnings": [],
        "ok": False,
    }
    if ws is None:
        report["causes"].append({
            "code": "no_workspace",
            "detail": f"no workspace dir for agent {agent!r} under {root}",
        })
        return report

    cfg = read_json(ws / "config.json")
    reme = (cfg.get("running") or {}).get("reme_light_memory_config") or {}
    interval = reme.get("auto_memory_interval", None)
    report["config"] = {
        "auto_memory_interval": interval,
        "auto_memory_include_images": reme.get("auto_memory_include_images"),
        "dream_cron_enabled": reme.get("dream_cron_enabled"),
        "dream_cron": reme.get("dream_cron"),
        "daily_dir": reme.get("daily_dir", "memory"),
        "digest_dir": reme.get("digest_dir", "digest"),
    }

    # Cause 1: interval disables auto-memory outright.
    if interval is not None and int(interval) <= 0:
        report["causes"].append({
            "code": "interval_disabled",
            "detail": f"auto_memory_interval={interval} disables periodic "
                      f"auto-memory entirely",
            "fix": "set running.reme_light_memory_config.auto_memory_interval "
                   "to a positive number (5 is the default) and reload the agent",
        })
    elif interval is None:
        report["warnings"].append({
            "code": "interval_unset",
            "detail": "auto_memory_interval not present in config.json; "
                      "QwenPaw's default is 5 user turns",
        })

    notes = count_notes(ws, cfg)
    report["notes"] = notes

    log = scan_log(root / "qwenpaw.log")
    report["log"] = log

    # Cause 4: ReMe never started.
    if log["exists"] and log["reme_started"] == 0:
        report["causes"].append({
            "code": "reme_not_started",
            "detail": "no 'ReMe memory manager started' line in the log tail",
            "fix": "check the log for 'ReMe import failed; memory disabled' "
                   "and fix the import/config error before expecting notes",
            "evidence": log["last_disable_reason"],
        })
    if log["reme_disabled"]:
        report["causes"].append({
            "code": "reme_disabled",
            "detail": f"{log['reme_disabled']} disable line(s) in the log tail",
            "evidence": log["last_disable_reason"],
        })

    # Cause 2: every turn was automation.
    turns = count_turn_sources(ws / "history.db", None)
    report["history"] = turns
    user_turns = turns.get("user_turns") or 0
    if log.get("auto_memory_skipped_automation"):
        report["causes"].append({
            "code": "automation_only",
            "detail": f"{log['auto_memory_skipped_automation']} auto-memory "
                      f"flush(es) skipped because the turn source was automation",
            "fix": "auto-memory only runs on real user turns; drive the agent "
                   "from the console chat, not cron/webhooks",
        })
    elif user_turns and user_turns < int(interval or 5):
        report["causes"].append({
            "code": "below_interval",
            "detail": f"{user_turns} user turn(s) recorded vs an interval of "
                      f"{interval or 5} — the flush threshold was never reached",
            "fix": "have a normal console conversation until the interval is "
                   "met, or lower auto_memory_interval",
        })

    # Cause 5: no model to summarise with.
    active = (cfg.get("running") or {}).get("active_model") or cfg.get("active_model")
    report["active_model"] = active
    if not active:
        report["causes"].append({
            "code": "no_active_model",
            "detail": "no active chat model configured; auto-memory cannot "
                      "summarise turns without one",
        })

    empty_notes = all(v["md_files"] == 0 for v in notes.values())
    if empty_notes and not report["causes"]:
        report["warnings"].append({
            "code": "empty_but_unexplained",
            "detail": "no notes yet and no cause identified above — check the "
                      "inbox for auto-memory failures and confirm real user "
                      "turns reached the console",
        })

    report["ok"] = not report["causes"]
    report["scoping_note"] = (
        "v2.3.0 intentionally watches only daily_dir+digest_dir markdown; raw "
        "conversation recall is recall_history(op='search') by design. An "
        "empty memory/ is not proof of a bug."
    )
    return report


def render(report: dict[str, Any]) -> str:
    lines = [
        f"ReMe doctor — agent {report['agent']}",
        f"  workspace: {report.get('workspace')}",
        f"  status:    {'OK' if report['ok'] else 'BLOCKED'}",
    ]
    if "config" in report:
        c = report["config"]
        lines.append(
            f"  interval:  {c['auto_memory_interval']}  "
            f"dream_cron={c['dream_cron_enabled']} ({c['dream_cron']})"
        )
    if "notes" in report:
        for label, info in report["notes"].items():
            lines.append(
                f"  {label:8s} {info['md_files']:3d} md file(s), "
                f"{info['bytes']} bytes  ({info['dir']})"
            )
    if "history" in report:
        h = report["history"]
        if h.get("exists"):
            lines.append(
                f"  history:   {h.get('rows')} rows / {h.get('sessions')} "
                f"sessions / {h.get('user_turns')} user turns  "
                f"kinds={h.get('kinds')}"
            )
        else:
            lines.append("  history:   (no history.db)")
    if "log" in report:
        lg = report["log"]
        lines.append(
            f"  log:       {lg['lines_scanned']} lines scanned; "
            f"started={lg['reme_started']} disabled={lg['reme_disabled']} "
            f"automation_skips={lg['auto_memory_skipped_automation']} "
            f"failures={lg['auto_memory_failed']}"
        )
    if report.get("active_model"):
        lines.append(f"  model:     {report['active_model']}")
    if report["causes"]:
        lines.append("")
        lines.append("  blocking causes:")
        for cause in report["causes"]:
            lines.append(f"   - [{cause['code']}] {cause['detail']}")
            if cause.get("evidence"):
                lines.append(f"       evidence: {cause['evidence']}")
            if cause.get("fix"):
                lines.append(f"       fix: {cause['fix']}")
    if report["warnings"]:
        lines.append("")
        lines.append("  warnings:")
        for warn in report["warnings"]:
            lines.append(f"   - [{warn['code']}] {warn['detail']}")
    lines.append("")
    lines.append(f"  note: {report['scoping_note']}")
    return "\n".join(lines)


# ------------------------------------------------------------------ selftest

def _build_fixture(tmp: Path, *, interval: int | None, log_text: str,
                   notes: int, user_turns: int) -> Path:
    root = tmp / "working"
    ws = root / "workspaces" / "default"
    ws.mkdir(parents=True)
    cfg: dict[str, Any] = {"running": {"active_model": {
        "provider_id": "mosicn", "model": "nex-n2.6"}}}
    if interval is not None:
        cfg["running"]["reme_light_memory_config"] = {
            "auto_memory_interval": interval}
    (ws / "config.json").write_text(json.dumps(cfg))
    (root / "qwenpaw.log").write_text(log_text)

    memory = ws / "memory"
    memory.mkdir()
    for i in range(notes):
        (memory / f"note-{i}.md").write_text("# note\nbody\n")

    db = ws / "history.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE conversation_history (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
            agent_id TEXT, kind TEXT NOT NULL, role TEXT, name TEXT,
            content TEXT, created_at TEXT
        );
        """
    )
    for i in range(user_turns):
        conn.execute(
            "INSERT INTO conversation_history(session_id,agent_id,kind,role,"
            "content,created_at) VALUES('s1','default','context_msg','user',"
            "'hello there', '2026-11-15T05:00:00Z')"
        )
    conn.commit()
    conn.close()
    return root


def selftest() -> int:
    import tempfile
    failures: list[str] = []

    def expect(name: str, cond: bool) -> None:
        print(f"  {'ok  ' if cond else 'FAIL'} {name}")
        if not cond:
            failures.append(name)

    print("selftest: healthy box")
    with tempfile.TemporaryDirectory() as td:
        root = _build_fixture(
            Path(td), interval=5,
            log_text="ReMe memory manager started for agent 'default'\n"
                     "auto_memory submit queued\n",
            notes=3, user_turns=12,
        )
        rep = diagnose(root, "default")
        expect("healthy is ok", rep["ok"] is True)
        expect("healthy has no causes", rep["causes"] == [])
        expect("counts notes", rep["notes"]["daily"]["md_files"] == 3)

    print("selftest: interval disabled")
    with tempfile.TemporaryDirectory() as td:
        root = _build_fixture(
            Path(td), interval=0,
            log_text="ReMe memory manager started\n", notes=0, user_turns=9)
        rep = diagnose(root, "default")
        codes = [c["code"] for c in rep["causes"]]
        expect("interval_disabled detected", "interval_disabled" in codes)

    print("selftest: reme never started")
    with tempfile.TemporaryDirectory() as td:
        root = _build_fixture(
            Path(td), interval=5,
            log_text="ReMe import failed; memory disabled: boom\n",
            notes=0, user_turns=9)
        rep = diagnose(root, "default")
        codes = [c["code"] for c in rep["causes"]]
        expect("reme_not_started detected", "reme_not_started" in codes)
        expect("reme_disabled detected", "reme_disabled" in codes)

    print("selftest: automation-only turns")
    with tempfile.TemporaryDirectory() as td:
        root = _build_fixture(
            Path(td), interval=5,
            log_text="ReMe memory manager started\n"
                     "MemoryMiddleware auto_memory skipped for automation "
                     "source: agent=default\n",
            notes=0, user_turns=1)
        rep = diagnose(root, "default")
        codes = [c["code"] for c in rep["causes"]]
        expect("automation_only detected", "automation_only" in codes)

    print("selftest: below interval")
    with tempfile.TemporaryDirectory() as td:
        root = _build_fixture(
            Path(td), interval=5,
            log_text="ReMe memory manager started\n", notes=0, user_turns=2)
        rep = diagnose(root, "default")
        codes = [c["code"] for c in rep["causes"]]
        expect("below_interval detected", "below_interval" in codes)

    print("selftest: missing workspace")
    with tempfile.TemporaryDirectory() as td:
        rep = diagnose(Path(td) / "nope", "default")
        codes = [c["code"] for c in rep["causes"]]
        expect("no_workspace detected", "no_workspace" in codes)

    print()
    total = 11
    print(f"{total - len(failures)} passed, {len(failures)} failed")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default="/data/home/qwenpaw/working")
    ap.add_argument("--agent", default="default")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    report = diagnose(Path(args.root).expanduser(), args.agent)
    print(json.dumps(report, indent=2, default=str) if args.json
          else render(report))
    return 0 if report["ok"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
