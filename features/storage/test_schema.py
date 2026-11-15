#!/usr/bin/env python3
"""Validate the D1 schema without a Cloudflare account.

Two things this proves locally:
  1. the SQL is valid and applies cleanly to an EMPTY database (SQLite is
     D1's engine, so DDL compatibility is a real check, not a proxy);
  2. every hot query is INDEXED. On D1 an unindexed query is a row-read
     charge, so a missing index is a billing bug, not just a slow one.

`EXPLAIN QUERY PLAN` output must never contain a full-table SCAN on these
queries. That is exactly the assertion T69-style harnesses exist for.

Run: python3 features/storage/test_schema.py
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = HERE / "schema.sql"

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


# The queries the Workers will actually run. (label, sql, params)
HOT_QUERIES = [
    ("open needs-you for a computer",
     "SELECT id, text, run_id, created_at FROM needs_you "
     "WHERE computer = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
     ("default",)),
    ("live lease for a computer",
     "SELECT lease_id, holder, expires_at, fence FROM lease "
     "WHERE computer = ? AND expires_at > ?",
     ("default", 0)),
    ("recent routine runs",
     "SELECT id, kind, at, status FROM routine_run ORDER BY at DESC LIMIT 50", ()),
    ("pending taught skills",
     "SELECT id, name FROM taught_skill "
     "WHERE delivered_at IS NULL AND expires_at > ?", ("2026-01-01",)),
    ("board column",
     "SELECT id, title, status, updated_at FROM ticket "
     "WHERE status = ? ORDER BY updated_at DESC LIMIT 50", ("todo",)),
    ("ticket comments",
     "SELECT id, body FROM ticket_comment "
     "WHERE ticket_id = ? ORDER BY created_at", ("t1",)),
    ("expired pending routines",
     "SELECT id FROM routine_pending WHERE expires_at < ?", ("2026-01-01",)),
]


def main() -> int:
    if not SCHEMA.is_file():
        print(f"missing {SCHEMA}")
        return 1

    print("schema applies to a fresh database")
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.executescript(SCHEMA.read_text(encoding="utf-8"))
        check("schema.sql executes without error", True)
    except sqlite3.Error as exc:
        check("schema.sql executes without error", False, str(exc))
        print("\nstopping: cannot test queries against a broken schema")
        return 1

    print("idempotency")
    try:
        conn.executescript(SCHEMA.read_text(encoding="utf-8"))
        check("re-applying the schema is a no-op (IF NOT EXISTS)", True)
    except sqlite3.Error as exc:
        check("re-applying the schema is a no-op (IF NOT EXISTS)", False, str(exc))

    print("structure")
    tables = {
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")
        if not r[0].startswith("sqlite_")
    }
    expected = {
        "computer", "lease", "needs_you", "preview", "agent_mode",
        "taught_skill", "routine_run", "routine_pending", "keepalive",
        "ticket", "ticket_comment",
    }
    check("all expected tables exist", expected <= tables,
          f"missing: {sorted(expected - tables)}")

    # Seed both computers so foreign keys resolve.
    gens = dict(conn.execute("SELECT name, generation FROM computer").fetchall())
    check("both computers seeded at generation 0",
          gens == {"default": 0, "qa": 0}, str(gens))

    print("one-lease-per-computer is an engine guarantee")
    conn.execute(
        "INSERT INTO lease (computer, lease_id, holder, granted_at, expires_at, fence) "
        "VALUES ('default','l1','user',0,9999999999999,1)")
    try:
        conn.execute(
            "INSERT INTO lease (computer, lease_id, holder, granted_at, expires_at, fence) "
            "VALUES ('default','l2','user',0,9999999999999,2)")
        check("a second lease row for the same computer is rejected", False,
              "the INSERT succeeded — the PRIMARY KEY is not doing its job")
    except sqlite3.IntegrityError:
        check("a second lease row for the same computer is rejected", True)

    print("strict boolean on follow_up")
    conn.execute(
        "INSERT INTO ticket (id,title,status,priority,follow_up,created_at,updated_at) "
        "VALUES ('t1','x','todo','normal',0,'a','a')")
    try:
        conn.execute(
            "INSERT INTO ticket (id,title,status,priority,follow_up,created_at,updated_at) "
            "VALUES ('t2','y','todo','normal','false','a','a')")
        check("follow_up rejects a non-0/1 value", False,
              "the string 'false' was accepted — CHECK is missing")
    except sqlite3.IntegrityError:
        check("follow_up rejects a non-0/1 value", True)

    print("hot queries are indexed (no full scan)")
    for label, sql, params in HOT_QUERIES:
        plan = conn.execute("EXPLAIN QUERY PLAN " + sql, params).fetchall()
        text = " | ".join(str(r[-1]) for r in plan)
        # "SCAN <table>" without an index name is a full table scan.
        bad = "SCAN " in text and "USING INDEX" not in text and "USING COVERING INDEX" not in text
        check(f"{label}: no full-table scan", not bad, text)

    print("keepalive is a single row")
    conn.execute(
        "INSERT INTO keepalive (id,status,checked_at) VALUES (1,'up','a')")
    try:
        conn.execute(
            "INSERT INTO keepalive (id,status,checked_at) VALUES (2,'up','a')")
        check("a second keepalive row is rejected", False)
    except sqlite3.IntegrityError:
        check("a second keepalive row is rejected", True)

    print("no image bytes column anywhere")
    # A BLOB/text column for previews would be a design regression.
    cols = set()
    for t in tables:
        for row in conn.execute(f"PRAGMA table_info({t})"):
            cols.add((t, row[1]))
    preview_cols = {c for t, c in cols if t == "preview"}
    check("preview stores metadata only (r2_key/sha256/bytes)",
          preview_cols == {"computer", "r2_key", "sha256", "bytes", "captured_at"},
          str(sorted(preview_cols)))

    conn.close()

    print()
    total = PASS + len(FAIL)
    print(f"{PASS} passed, {len(FAIL)} failed  ({total} checks)")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
