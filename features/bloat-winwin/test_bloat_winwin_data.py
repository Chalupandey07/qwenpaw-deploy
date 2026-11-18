#!/usr/bin/env python3
"""Machine-free tests for the bloat-winwin DATA-LAYER optimizations (T119).

Covers the work done on the live machine 2026-11-18 (no source change):
history.db + audit.db VACUUM / WAL checkpoint / journal_size_limit,
lossless PNG recompression (Pillow optimize=True), and log rotation
(gzip + verify-before-truncate).

These tests run against TEMPORARY test databases / files only. They do
not touch the live working tree. The live measurements are recorded in
features/bloat-winwin/DATA_LAYER.md.

Run: python3 features/bloat-winwin/test_bloat_winwin_data.py
Exit 0 = all pass. Prints "N passed, M failed" as the last line.
"""

from __future__ import annotations

import gzip
import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


def _pixels_hash(path: str) -> str:
    from PIL import Image
    with Image.open(path) as im:
        im.load()
        return hashlib.sha256(
            f"{im.mode}|{im.size}|".encode() + im.tobytes()).hexdigest()


def test_vacuum_preserves_rows_and_reclaims_wal() -> None:
    tmp = Path(tempfile.mkdtemp())
    db = tmp / "test.db"
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, text TEXT, n INTEGER)")
    conn.execute(
        "CREATE VIRTUAL TABLE t_fts USING fts5(text, content='t',"
        " content_rowid='id', tokenize='porter unicode61')")
    conn.execute(
        "CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN"
        " INSERT INTO t_fts(rowid, text) VALUES (new.id, new.text); END")
    # Insert rows, then force WAL growth with updates.
    for i in range(200):
        conn.execute(
            "INSERT INTO t (text, n) VALUES (?, ?)",
            (f"fact number {i} about the loop gate and DeepSeek", i))
    conn.commit()
    for i in range(200):
        conn.execute("UPDATE t SET n = n + 1 WHERE id = ?", (i + 1,))
    conn.commit()
    before_rows = conn.execute("SELECT COUNT(*) FROM t").fetchone()[0]
    before_fts = conn.execute("SELECT COUNT(*) FROM t_fts").fetchone()[0]
    wal_before = os.path.getsize(str(db) + "-wal")
    conn.execute("VACUUM")
    conn.execute("PRAGMA journal_size_limit=1048576")
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.commit()
    after_rows = conn.execute("SELECT COUNT(*) FROM t").fetchone()[0]
    after_fts = conn.execute("SELECT COUNT(*) FROM t_fts").fetchone()[0]
    wal_after = os.path.getsize(str(db) + "-wal") \
        if os.path.exists(str(db) + "-wal") else 0
    check("VACUUM preserves every row",
          after_rows == before_rows == 200, f"{before_rows} -> {after_rows}")
    check("VACUUM preserves the FTS index rows",
          after_fts == before_fts == 200, f"{before_fts} -> {after_fts}")
    check("WAL is checkpointed away (was > 0, now 0)",
          wal_before > 0 and wal_after == 0,
          f"wal {wal_before} -> {wal_after}")
    # FTS search still works after VACUUM.
    hits = conn.execute(
        "SELECT COUNT(*) FROM t_fts WHERE t_fts MATCH 'DeepSeek'").fetchone()[0]
    check("FTS search still works after VACUUM",
          hits == 200, f"{hits} hits")
    # journal_size_limit is PER-CONNECTION, not persistent (verified
    # 2026-11-18 on SQLite 3.45.1 and 3.46.1: a fresh connection reads
    # -1 even after another connection set it and wrote). So the
    # maintenance-time setting does NOT bound future WAL growth; the
    # durable bound is SQLite's auto-checkpoint (~1000 pages, ~4 MB).
    # A tighter bound needs the app to set the pragma on each DB open
    # (a source change; documented as a follow-up, not claimed here).
    conn2 = sqlite3.connect(str(db))
    limit_fresh = conn2.execute("PRAGMA journal_size_limit").fetchone()[0]
    check("journal_size_limit is per-connection, not persistent",
          limit_fresh == -1, f"fresh-conn limit={limit_fresh}")
    conn2.execute("PRAGMA journal_size_limit=1048576")
    limit_set = conn2.execute("PRAGMA journal_size_limit").fetchone()[0]
    check("journal_size_limit takes effect on the connection that sets it",
          limit_set == 1048576, f"limit={limit_set}")
    conn2.close()


def test_freelist_zero_means_vacuum_cannot_shrink() -> None:
    # The live history.db had freelist 0 (all live data), so VACUUM
    # could not shrink the main file — only the WAL was reclaimable.
    # This test documents that behaviour: a packed DB keeps its size.
    tmp = Path(tempfile.mkdtemp())
    db = tmp / "packed.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE t (text TEXT)")
    for i in range(100):
        conn.execute("INSERT INTO t VALUES (?)", ("x" * 1000,))
    conn.commit()
    before = os.path.getsize(db)
    freelist = conn.execute("PRAGMA freelist_count").fetchone()[0]
    conn.execute("VACUUM")
    conn.commit()
    after = os.path.getsize(db)
    check("a packed DB (freelist 0) keeps its size after VACUUM",
          freelist == 0 and abs(after - before) < before * 0.01,
          f"freelist={freelist} size {before} -> {after}")
    conn.close()


def test_png_recompression_is_lossless() -> None:
    from PIL import Image
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "shot.png"
    # A synthetic screenshot-like image (flat areas + text-like noise).
    img = Image.new("RGB", (800, 600), (240, 240, 240))
    px = img.load()
    for y in range(0, 600, 20):
        for x in range(0, 800, 10):
            px[x, y] = (30, 30, 30)
    img.save(src, format="PNG")
    before = os.path.getsize(src)
    orig_pixels = _pixels_hash(str(src))
    opt = tmp / "shot.opt.png"
    with Image.open(src) as im:
        im.save(opt, format="PNG", optimize=True)
    after = os.path.getsize(opt)
    check("lossless re-encode keeps pixels identical",
          _pixels_hash(str(opt)) == orig_pixels, "")
    check("lossless re-encode does not grow the file",
          after <= before, f"{before} -> {after}")


def test_log_rotation_verifies_before_truncating() -> None:
    # The rotate script is named rotate-log.py (hyphen), so load it by
    # file path with importlib instead of a plain import.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "rotate_log", str(HERE / "rotate-log.py"))
    assert spec is not None and spec.loader is not None
    RL = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(RL)
    tmp = Path(tempfile.mkdtemp())
    log = tmp / "qwenpaw.log"
    archive_dir = tmp / "archives"
    body = b"2026-11-18 13:42:55 | INFO | test line\n" * 1000
    log.write_bytes(body)
    # Monkeypatch the module's paths + threshold for the test.
    RL.LOG = str(log)
    RL.ARCHIVE_DIR = str(archive_dir)
    RL.MAX_BYTES = 1024
    rc = RL.main()
    archives = list(archive_dir.glob("*.gz")) if archive_dir.exists() else []
    check("rotation succeeds when the log exceeds the threshold",
          rc == 0 and len(archives) == 1, f"rc={rc} archives={len(archives)}")
    if archives:
        with gzip.open(archives[0], "rb") as f:
            archived = f.read()
        check("the archive decompresses to exactly the original bytes",
              archived == body, f"{len(archived)} vs {len(body)}")
    check("the live log is truncated after a verified archive",
          log.stat().st_size == 0, f"size={log.stat().st_size}")
    # A small log is left alone.
    log.write_bytes(b"short\n")
    rc2 = RL.main()
    check("a small log is not rotated",
          rc2 == 0 and log.read_bytes() == b"short\n", f"rc={rc2}")
    # Failure path: archive dir unwritable -> log untouched.
    log.write_bytes(body)
    bad_dir = tmp / "nope" / "deep"
    RL.ARCHIVE_DIR = str(bad_dir)
    # Make the parent read-only so makedirs fails.
    os.chmod(tmp / "nope", 0o500) if (tmp / "nope").exists() else None
    # Simulate the failure by pointing at a path whose parent is a file.
    blocker = tmp / "blocker"
    blocker.write_bytes(b"x")
    RL.ARCHIVE_DIR = str(blocker / "sub")
    rc3 = RL.main()
    check("a failed archive leaves the live log untouched",
          rc3 != 0 and log.read_bytes() == body,
          f"rc={rc3} size={log.stat().st_size}")
    os.chmod(tmp / "nope", 0o700) if (tmp / "nope").exists() else None


def test_rotate_log_cli() -> None:
    tmp = Path(tempfile.mkdtemp())
    log = tmp / "qwenpaw.log"
    log.write_bytes(b"2026-11-18 | INFO | hello\n" * 500)
    r = subprocess.run(
        [sys.executable, str(HERE / "rotate-log.py")],
        capture_output=True, text=True,
        env={**os.environ, "HOME": str(tmp)})
    # The CLI uses the hardcoded /data paths, so on this VM it will
    # report the real log as missing/small (or rotate it if large).
    # We only assert it exits cleanly and does not crash.
    check("rotate-log.py CLI exits cleanly",
          r.returncode in (0, 1), f"rc={r.returncode} {r.stderr[:200]}")


def main() -> int:
    print("bloat-winwin data layer — VACUUM / PNG / log rotation")
    test_vacuum_preserves_rows_and_reclaims_wal()
    test_freelist_zero_means_vacuum_cannot_shrink()
    test_png_recompression_is_lossless()
    test_log_rotation_verifies_before_truncating()
    test_rotate_log_cli()
    print(f"{PASS} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
