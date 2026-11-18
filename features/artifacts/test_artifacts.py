#!/usr/bin/env python3
"""Machine-free tests for the artifacts library (provisional T138).

Exercises features/artifacts/artifacts.py on TEMPORARY scratch
directories only — never the real workspace, never the repo itself, and
never the live history.db. The fixture history.db uses the EXACT schema
QwenPaw v2.3.0 creates (see features/memory/test_recall.py).

Usage:
    python3 test_artifacts.py [--code PATH]
    python3 test_artifacts.py --code /tmp/empty-artifacts-stub.py
        # fail-first: must FAIL (no indexer exists)

Checks (T138 brief):
  (a) walking a fixture workspace indexes every file with name/slug/date/
      size/type/source
  (b) a search query finds the right artifact and misses the wrong one
  (c) backfill picks up a file that was sent before the index existed
  (d) re-indexing is idempotent (no duplicate rows)
  (e) history.db is read-only (the indexer never writes to it)
Plus: history backfill from content references, slug-collision dedupe,
hidden files / history.db excluded from the walk, escaping symlinks
skipped, render produces a searchable page, bad inputs rejected.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CODE = HERE / "artifacts.py"

PASS, FAIL = 0, []
CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    CHECKS.append((name, bool(cond), detail))
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


def load_code(path: Path):
    spec = importlib.util.spec_from_file_location("artifacts_under_test", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


HISTORY_SCHEMA = """
CREATE TABLE conversation_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    kind TEXT NOT NULL,
    role TEXT,
    name TEXT,
    content TEXT,
    tool_call_id TEXT,
    tool_input TEXT,
    tool_state TEXT,
    headline TEXT,
    blocks TEXT,
    metadata TEXT,
    created_at TEXT,
    dedup_key TEXT
);
"""


def build_fixture(tmp: Path):
    """Fixture workspace + history.db + sent-file metadata. Returns dict."""
    ws = tmp / "workspace"
    (ws / "docs").mkdir(parents=True)
    (ws / "media").mkdir(parents=True)
    files = {
        "docs/Quarterly Report.pdf": b"%PDF-1.4 fake report\n" * 10,
        "docs/Meeting Notes.md": b"# Notes\nhello world\n",
        "media/chart.png": b"\x89PNG fake image\n" * 5,
        "data.csv": b"a,b\n1,2\n",
        "script.py": b"print('hi')\n",
        "docs/My Report.md": b"# My report\n",
        "docs/my-report.md": b"# other report\n",
    }
    for rel, data in files.items():
        (ws / rel).write_bytes(data)
    (ws / ".hidden.txt").write_text("secret, must not be indexed\n")
    (ws / ".git").mkdir(exist_ok=True)
    (ws / ".git" / "config").write_text("[core]\n")
    # Symlink escaping the workspace root: must be skipped, not followed.
    outside = tmp / "outside.txt"
    outside.write_text("outside the workspace\n")
    (ws / "escape.txt").symlink_to(outside)

    hist = tmp / "history.db"
    conn = sqlite3.connect(hist)
    conn.executescript(HISTORY_SCHEMA)
    conn.execute(
        "INSERT INTO conversation_history "
        "(session_id, agent_id, kind, role, content, created_at) "
        "VALUES (?,?,?,?,?,?)",
        ("sess-1", "default", "context_msg", "user",
         "I sent the file docs/Meeting Notes.md to the user earlier.",
         "2026-11-15T03:10:00Z"),
    )
    conn.execute(
        "INSERT INTO conversation_history "
        "(session_id, agent_id, kind, role, content, created_at) "
        "VALUES (?,?,?,?,?,?)",
        ("sess-2", "default", "model_turn", "assistant",
         "No file paths in this turn at all.",
         "2026-11-15T03:12:00Z"),
    )
    conn.commit()
    conn.close()

    sent = tmp / "sent.json"
    sent.write_text(json.dumps([
        {"path": "media/chart.png", "sent_at": "2026-11-14T10:00:00Z",
         "session_id": "sess-0", "channel": "console"},
        {"path": "docs/missing.png", "sent_at": "2026-11-14T10:01:00Z",
         "session_id": "sess-0", "channel": "console"},
    ]))
    return {"ws": ws, "hist": hist, "sent": sent, "files": files}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", default=str(DEFAULT_CODE))
    args = ap.parse_args()
    try:
        A = load_code(Path(args.code))
    except Exception as exc:  # fail-first: no usable implementation
        print(f"FAIL  cannot load indexer under test: {exc}")
        return 1

    tmp = Path(tempfile.mkdtemp(prefix="artifacts-test-"))
    fx = build_fixture(tmp)
    ws, hist, sent = fx["ws"], fx["hist"], fx["sent"]
    db = tmp / "artifacts.db"

    print("(a) walk indexes every file with full metadata")
    conn = A.init_db(db)
    n = A.index_workspace(conn, ws)
    rows = A.list_all(conn)
    by_path = {r["path"]: r for r in rows}
    check("walk count is 7 visible files", n == 7, f"n={n}")
    check("row count matches walk", len(rows) == 7, f"{len(rows)}")
    pdf = by_path.get("docs/Quarterly Report.pdf", {})
    check("pdf name stored", pdf.get("name") == "Quarterly Report.pdf")
    check("pdf slug", pdf.get("slug") == "quarterly-report", str(pdf.get("slug")))
    check("pdf type document", pdf.get("type") == "document")
    check("pdf size matches bytes",
          pdf.get("size_bytes") == len(fx["files"]["docs/Quarterly Report.pdf"]))
    check("pdf date is ISO", str(pdf.get("date", "")).startswith("2026-"))
    check("pdf source workspace", pdf.get("source") == "workspace")
    check("png type image", by_path.get("media/chart.png", {}).get("type") == "image")
    check("csv type data", by_path.get("data.csv", {}).get("type") == "data")
    check("py type code", by_path.get("script.py", {}).get("type") == "code")
    check("hidden file excluded", ".hidden.txt" not in by_path)
    check("git dir excluded", not any(p.startswith(".git/") for p in by_path))
    check("escaping symlink skipped", "escape.txt" not in by_path)
    check("slug collision deduped",
          by_path.get("docs/My Report.md", {}).get("slug") !=
          by_path.get("docs/my-report.md", {}).get("slug"),
          f"{by_path.get('docs/My Report.md', {}).get('slug')} vs "
          f"{by_path.get('docs/my-report.md', {}).get('slug')}")
    conn.close()

    print("(b) search finds the right artifact, misses the wrong one")
    conn = A.init_db(db)
    hits = A.search(conn, "report")
    check("search 'report' finds both reports",
          len(hits) == 3, f"{[h['path'] for h in hits]}")
    check("search 'report' is the right files",
          {h["path"] for h in hits} == {
              "docs/Quarterly Report.pdf", "docs/My Report.md",
              "docs/my-report.md"})
    check("search 'zzzznothing' finds nothing",
          A.search(conn, "zzzznothing") == [])
    check("search by type 'image' finds the png",
          [h["path"] for h in A.search(conn, "image")] == ["media/chart.png"])
    check("search is AND across tokens",
          A.search(conn, "report pdf") != [] and
          all("report" in (h["name"] + h["path"]).lower() for h in A.search(conn, "report pdf")))
    try:
        A.search(conn, "   ")
        check("empty query rejected", False)
    except A.ArtifactsError:
        check("empty query rejected", True)
    conn.close()

    print("(c) backfill picks up a file sent before the index existed")
    conn = A.init_db(db)
    n_sent = A.backfill_sent(conn, sent, ws)
    rows = A.list_all(conn)
    sent_rows = [r for r in rows if r["source"] == "sent"]
    check("sent backfill counts the existing file only", n_sent == 1, f"n={n_sent}")
    check("sent row exists for chart.png",
          any(r["path"] == "media/chart.png" for r in sent_rows))
    check("sent row keeps sent date",
          any(r["date"] == "2026-11-14T10:00:00Z" for r in sent_rows))
    check("sent row keeps session",
          any(r["session_id"] == "sess-0" for r in sent_rows))
    check("missing sent file not indexed",
          not any(r["path"] == "docs/missing.png" for r in rows))
    n_hist = A.backfill_history(conn, hist, ws)
    hist_rows = [r for r in A.list_all(conn) if r["source"] == "history"]
    check("history backfill finds the referenced file",
          any(r["path"] == "docs/Meeting Notes.md" for r in hist_rows),
          f"n_hist={n_hist}")
    check("history row dated by the history row",
          any(r["date"] == "2026-11-15T03:10:00Z" for r in hist_rows))
    check("history row keeps session",
          any(r["session_id"] == "sess-1" for r in hist_rows))
    check("history turn with no path adds nothing",
          all(r["session_id"] != "sess-2" for r in hist_rows))
    conn.close()

    print("(d) re-indexing is idempotent")
    conn = A.init_db(db)
    before = conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0]
    A.index_workspace(conn, ws)
    A.backfill_sent(conn, sent, ws)
    A.backfill_history(conn, hist, ws)
    after = conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0]
    check("second full pass adds zero rows", after == before, f"{before} -> {after}")
    dupes = conn.execute(
        "SELECT path, source, COUNT(*) c FROM artifacts "
        "GROUP BY path, source HAVING c > 1").fetchall()
    check("no (path, source) duplicates", dupes == [], str(dupes))
    conn.close()

    print("(e) history.db is read-only")
    before_hash, before_mtime = sha(hist), hist.stat().st_mtime_ns
    time.sleep(0.02)
    conn = A.init_db(db)
    A.backfill_history(conn, hist, ws)
    conn.close()
    check("history.db bytes unchanged", sha(hist) == before_hash)
    check("history.db mtime unchanged", hist.stat().st_mtime_ns == before_mtime)
    check("no history.db journal/wal created",
          not list(tmp.glob("history.db-*")))
    try:
        bad = A.open_history_readonly(tmp / "nope.db")
        check("missing history db rejected", False)
    except A.ArtifactsError:
        check("missing history db rejected", True)
    try:
        A.open_history_readonly(db)  # artifacts.db has no history table
        check("non-history db rejected", False)
    except A.ArtifactsError:
        check("non-history db rejected", True)

    print("render + CLI")
    conn = A.init_db(db)
    page = A.render_page(A.list_all(conn))
    conn.close()
    check("page contains an artifact name", "Quarterly Report.pdf" in page)
    check("page has a search box", 'id="q"' in page)
    check("page says snapshot, not live", "Not live" in page)
    check("page links the existing open-work page", "open-work.html" in page)
    out = tmp / "artifacts.html"
    proc = subprocess.run(
        [sys.executable, str(Path(args.code)), "render", "--db", str(db),
         "--out", str(out)], capture_output=True, text=True, timeout=60)
    check("render CLI exits 0", proc.returncode == 0, proc.stderr[:200])
    check("render CLI wrote the page", out.is_file() and "chart.png" in out.read_text())
    proc = subprocess.run(
        [sys.executable, str(Path(args.code)), "search", "--db", str(db),
         "--query", "report"], capture_output=True, text=True, timeout=60)
    check("search CLI exits 0 and returns JSON",
          proc.returncode == 0 and "Quarterly Report.pdf" in proc.stdout,
          proc.stderr[:200])

    print(f"\n{PASS} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILED:", ", ".join(FAIL))
        return 1
    print("ALL ARTIFACTS TESTS PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
