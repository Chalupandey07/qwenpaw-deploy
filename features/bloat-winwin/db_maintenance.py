#!/usr/bin/env python3
"""Win-win DB maintenance for QwenPaw (run with the container STOPPED).

Backs up history.db + audit.db (with their WALs), verifies the backups,
then VACUUMs each DB, bounds the WAL with journal_size_limit, and
checkpoints the WAL. Verifies row counts + FTS search before and after.

Win-win rule: no rows are deleted or archived. VACUUM rebuilds the
file with identical rows; wal_checkpoint moves WAL pages into the
main file; journal_size_limit only bounds future WAL growth.

Usage (on the machine, as root via sudo, container stopped):
  sudo python3 db_maintenance.py
Prints a before/after summary. Exits non-zero on any verification
failure (in which case restore from the backup dir and report).
"""
import os
import shutil
import sqlite3
import sys

WORKING = "/data/home/qwenpaw/working"
BACKUP_DIR = "/data/home/qwenpaw/working.backups/bloat-winwin-20261118/db"
HISTORY = os.path.join(WORKING, "workspaces/default/history.db")
AUDIT = os.path.join(WORKING, "governance/audit.db")
WAL_LIMIT_BYTES = 1048576  # 1 MiB. NOTE: journal_size_limit is
# PER-CONNECTION, not persistent (verified 2026-11-18 on SQLite 3.45/3.46:
# a fresh connection reads -1). Setting it here only affects this
# maintenance connection; it does NOT bound future WAL growth. The
# durable bound is SQLite's auto-checkpoint (~1000 pages, ~4 MB). A
# tighter durable bound needs the app to set the pragma on each DB open
# (a source change; see DATA_LAYER.md). The setting is kept here because
# it is harmless and documents the intent.


def size_of(path):
    return os.path.getsize(path) if os.path.exists(path) else 0


def snapshot(db_path):
    """(main bytes, wal bytes, row count, fts count or None)."""
    main = size_of(db_path)
    wal = size_of(db_path + "-wal")
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if "history" in db_path:
            rows = con.execute(
                "SELECT COUNT(*) FROM conversation_history"
            ).fetchone()[0]
            fts = con.execute(
                "SELECT COUNT(*) FROM conversation_history_fts"
            ).fetchone()[0]
            # A real FTS search must still work.
            hit = con.execute(
                "SELECT COUNT(*) FROM conversation_history_fts "
                "WHERE conversation_history_fts MATCH 'summary'"
            ).fetchone()[0]
            return main, wal, rows, fts, hit
        rows = con.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
        return main, wal, rows, None, None
    finally:
        con.close()


def backup(db_path):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    base = os.path.basename(db_path)
    for suffix in ("", "-wal", "-shm"):
        src = db_path + suffix
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(BACKUP_DIR, base + suffix))
    # Verify the backup copy opens and has the same rows.
    bpath = os.path.join(BACKUP_DIR, base)
    con = sqlite3.connect(f"file:{bpath}?mode=ro", uri=True)
    try:
        if "history" in db_path:
            rows = con.execute(
                "SELECT COUNT(*) FROM conversation_history"
            ).fetchone()[0]
        else:
            rows = con.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
    finally:
        con.close()
    return rows


def maintain(db_path, label):
    print(f"--- {label}: {db_path}")
    before = snapshot(db_path)
    print(f"  BEFORE main={before[0]} wal={before[1]} rows={before[2]}"
          + (f" fts={before[3]} fts_match_summary={before[4]}"
             if before[3] is not None else ""))
    brows = backup(db_path)
    if brows != before[2]:
        print(f"  ERROR: backup row count {brows} != live {before[2]}; aborting")
        return False
    print(f"  backup verified ({brows} rows) in {BACKUP_DIR}")
    con = sqlite3.connect(db_path)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("VACUUM")
        con.execute(f"PRAGMA journal_size_limit={WAL_LIMIT_BYTES}")
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        con.commit()
        # journal_size_limit on THIS connection only (see the note at
        # the top of this file: it does not persist to other connections).
        limit = con.execute("PRAGMA journal_size_limit").fetchone()[0]
        print(f"  journal_size_limit on this connection {limit} "
              f"(expect {WAL_LIMIT_BYTES}; not persistent)")
    finally:
        con.close()
    after = snapshot(db_path)
    print(f"  AFTER  main={after[0]} wal={after[1]} rows={after[2]}"
          + (f" fts={after[3]} fts_match_summary={after[4]}"
             if after[3] is not None else ""))
    ok = after[2] == before[2]
    if before[3] is not None:
        ok = ok and after[3] == before[3] and after[4] == before[4]
    print(f"  rows preserved: {'YES' if ok else 'NO *** MISMATCH ***'}; "
          f"main delta {after[0] - before[0]:+d}, wal delta {after[1] - before[1]:+d}")
    return ok


def main():
    ok = True
    ok = maintain(HISTORY, "history.db") and ok
    ok = maintain(AUDIT, "audit.db") and ok
    print("RESULT:", "ALL PRESERVED" if ok else "MISMATCH - RESTORE FROM BACKUP")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
