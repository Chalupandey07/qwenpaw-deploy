#!/usr/bin/env python3
"""Tests for facts.py v2 — multi-signal retrieval (Mem0-style entity
boost + RRF), temporal validity windows (Zep/Graphiti-style), and the
v1 -> v2 migration. See features/memory/README.md.

Run: python3 features/memory/test_facts_v2.py
Exit 0 = all pass. Prints "N passed, M failed" as the last line.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

sys.path.insert(0, str(HERE))
import facts as F  # noqa: E402

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


def _raises(fn) -> bool:
    try:
        fn()
    except Exception:
        return True
    return False


def fresh_db() -> tuple[sqlite3.Connection, Path]:
    tmp = Path(tempfile.mkdtemp())
    path = tmp / "memory.db"
    conn = F.open_db(path)
    return conn, path


# ------------------------------------------------------------ entities

def test_extract_entities() -> None:
    ents = F.extract_entities(
        'DeepSeek wrote the loop gate patch for QwenPaw.')
    check("extract finds lexicon names (DeepSeek, QwenPaw)",
          "DeepSeek" in ents and "QwenPaw" in ents, str(ents))
    check("extract finds the loop-gate phrase",
          any(e.lower() == "loop gate" for e in ents), str(ents))
    ents2 = F.extract_entities('The user said "Purple Lantern" is the test.')
    check("extract finds quoted strings",
          "Purple Lantern" in ents2, str(ents2))
    ents3 = F.extract_entities("The TinyFish key goes in the vault.")
    check("extract finds CamelCase (TinyFish)",
          "TinyFish" in ents3, str(ents3))
    ents4 = F.extract_entities("The quick brown fox jumps.")
    check("extract does not invent entities from plain prose",
          ents4 == [], str(ents4))
    ents5 = F.extract_entities("DeepSeek DeepSeek deepseek is the model.")
    check("extract dedups case-insensitively",
          [e.lower() for e in ents5].count("deepseek") == 1, str(ents5))
    check("extract caps at 8 entities",
          len(F.extract_entities(
              "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa "
              "Lambda Mu Nu Xi Omnicron Pi Rho Sigma Tau")) <= 8, "")
    check("extract skips stopwords as entities",
          not any(e.lower() in ("the", "this", "it") for e in
                  F.extract_entities("The thing is important.")), "")


def test_auto_entities_on_add() -> None:
    conn, _ = fresh_db()
    fid = F.add_fact(
        conn,
        text="DeepSeek is the coding model; use it at maximum context.",
        kind="preference", session_id="sess-a")
    row = conn.execute(
        "SELECT entities FROM facts WHERE id=?", (fid,)).fetchone()
    ents = json.loads(row["entities"])
    check("add auto-extracts entities when none are supplied",
          "DeepSeek" in ents, str(ents))
    conn.close()


def test_backfill_entities() -> None:
    conn, _ = fresh_db()
    # A fact inserted before entities existed (empty list).
    conn.execute(
        "INSERT INTO facts (text, kind, entities, session_id, importance, hash)"
        " VALUES (?,?,?,?,?,?)",
        ("DeepSeek is the coding model.", "preference", "[]",
         "sess-a", 2, "deadbeef-backfill-1"))
    conn.commit()
    before = conn.execute(
        "SELECT text FROM facts WHERE hash='deadbeef-backfill-1'").fetchone()[0]
    rep = F.backfill_entities(conn)
    row = conn.execute(
        "SELECT entities, text FROM facts WHERE hash='deadbeef-backfill-1'"
    ).fetchone()
    ents = json.loads(row["entities"])
    check("backfill populates entities for an empty-entity fact",
          "DeepSeek" in ents, str(ents))
    check("backfill does not change the fact text",
          row["text"] == before, row["text"])
    check("backfill reports examined/updated counts",
          rep.get("examined", 0) >= 1 and rep.get("updated", 0) >= 1,
          str(rep))
    # A second backfill finds nothing left to do (idempotent).
    rep2 = F.backfill_entities(conn)
    check("backfill is idempotent (second run updates nothing)",
          rep2.get("updated", 99) == 0, str(rep2))
    conn.close()


# ------------------------------------------------------------ retrieval

def test_entity_boost() -> None:
    conn, _ = fresh_db()
    ids = {}
    ids["gate"] = F.add_fact(
        conn,
        text="DeepSeek wrote the loop gate patch for the derived image.",
        kind="decision", session_id="sess-a", importance=2)
    ids["deepseek"] = F.add_fact(
        conn,
        text="DeepSeek is the coding model; use it at maximum context.",
        kind="preference", session_id="sess-a", importance=2)
    ids["tinyfish"] = F.add_fact(
        conn,
        text="The TinyFish key is entered by the user in the vault.",
        kind="fact", session_id="sess-a", importance=2)
    ids["coffee"] = F.add_fact(
        conn,
        text="The user likes their coffee black with no sugar.",
        kind="preference", session_id="sess-a", importance=1)
    res = F.search_facts(conn, "DeepSeek loop gate", limit=5)
    texts = [r["text"] for r in res["results"]]
    check("entity-boost search ranks the DeepSeek+loop-gate fact first",
          texts and "loop gate patch" in texts[0], str(texts[:2]))
    first = res["results"][0] if res["results"] else {}
    check("result carries the entity overlap count",
          isinstance(first.get("entity_overlap"), int)
          and first.get("entity_overlap", 0) >= 1,
          str(first))
    check("result carries a fused score",
          isinstance(first.get("fused_score"), float), str(first))
    check("query entities are reported",
          "DeepSeek" in res.get("query_entities", []),
          str(res.get("query_entities")))
    # A query with no known entity degrades gracefully (no crash, BM25 order).
    res2 = F.search_facts(conn, "coffee black sugar", limit=5)
    check("a query with no lexicon entity still returns the coffee fact",
          any("coffee" in r["text"] for r in res2["results"]),
          str([r["text"] for r in res2["results"]]))
    # Importance still matters: same text, higher importance ranks first.
    conn2, _ = fresh_db()
    F.add_fact(conn2, text="The widget is blue.", kind="fact",
               session_id="s", importance=1)
    F.add_fact(conn2, text="The widget is blue and important.",
               kind="fact", session_id="s", importance=3)
    res3 = F.search_facts(conn2, "widget blue", limit=5)
    check("higher importance ranks first on a near-tied query",
          res3["results"] and res3["results"][0]["importance"] == 3,
          str([(r["text"], r["importance"]) for r in res3["results"]]))
    conn.close()
    conn2.close()


def test_rrf_math() -> None:
    # Rank 1 in every signal beats rank 2 in every signal.
    s1 = F._rrf_fuse([(1, 1.0), (1, 2.0), (1, 1.0)])
    s2 = F._rrf_fuse([(2, 1.0), (2, 2.0), (2, 1.0)])
    check("RRF: rank 1 everywhere beats rank 2 everywhere",
          s1 > s2, f"{s1} vs {s2}")
    # The entity signal (weight 2) outweighs a one-position BM25 gap:
    # A is BM25-2 / entity-1, B is BM25-1 / entity-2, importance tied.
    a = F._rrf_fuse([(2, 1.0), (1, 2.0), (1, 2.0)])
    b = F._rrf_fuse([(1, 1.0), (2, 2.0), (1, 2.0)])
    check("RRF: entity weight 2 beats a one-position BM25 gap",
          a > b, f"{a} vs {b}")
    # The importance signal (weight 2) does the same.
    c = F._rrf_fuse([(2, 1.0), (1, 2.0), (1, 2.0)])
    d = F._rrf_fuse([(1, 1.0), (1, 2.0), (2, 2.0)])
    check("RRF: importance weight 2 beats a one-position BM25 gap",
          c > d, f"{c} vs {d}")
    # Dense ranks: ties share a rank.
    items = [{"v": 3}, {"v": 3}, {"v": 1}]
    ranks = F._dense_ranks(items, lambda c: c["v"])
    check("dense ranks share a rank on ties",
          ranks[id(items[0])] == ranks[id(items[1])] == 1
          and ranks[id(items[2])] == 2, str(ranks))


# ------------------------------------------------------------ temporal

def test_temporal_validity() -> None:
    conn, _ = fresh_db()
    old_id = F.add_fact(
        conn, text="The user takes their coffee black with no sugar.",
        kind="preference", session_id="sess-a", importance=2)
    row = conn.execute(
        "SELECT valid_from, valid_to FROM facts WHERE id=?",
        (old_id,)).fetchone()
    check("a new fact is valid from its creation (valid_to NULL)",
          row["valid_from"] is not None and row["valid_to"] is None,
          str(dict(row)))
    # Backdate the fact so it existed before "yesterday": the as-of test
    # needs a fact that was valid in the past, not one created today.
    conn.execute(
        "UPDATE facts SET created_at='2026-11-10T00:00:00Z',"
        " valid_from='2026-11-10T00:00:00Z' WHERE id=?", (old_id,))
    conn.commit()
    new_id = F.supersede_fact(
        conn, old_id, "The user now takes their coffee with milk.",
        session_id="sess-b")
    old = conn.execute(
        "SELECT valid_to, superseded_by FROM facts WHERE id=?",
        (old_id,)).fetchone()
    check("superseding closes the old fact's validity window",
          old["valid_to"] is not None
          and old["superseded_by"] == new_id, str(dict(old)))
    # Default search returns the new fact, not the old.
    res = F.search_facts(conn, "coffee", limit=5)
    texts = [r["text"] for r in res["results"]]
    check("default search returns the replacement, not the superseded fact",
          any("milk" in t for t in texts)
          and not any("no sugar" in t for t in texts), str(texts))
    # Time travel: as-of a date after the fact was created but before
    # the supersession returns the old fact (it was valid then).
    res_old = F.search_facts(conn, "coffee", limit=5, as_of="2026-11-15")
    texts_old = [r["text"] for r in res_old["results"]]
    check("as-of 2026-11-15 returns the fact that was valid then",
          any("no sugar" in t for t in texts_old), str(texts_old))
    # as-of today (after the supersession) returns the new fact.
    import datetime
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    res_new = F.search_facts(conn, "coffee", limit=5, as_of=today)
    texts_new = [r["text"] for r in res_new["results"]]
    check("as-of today returns the current fact",
          any("milk" in t for t in texts_new), str(texts_new))
    # as-of before the fact existed returns neither.
    res_none = F.search_facts(conn, "coffee", limit=5, as_of="2026-11-01")
    check("as-of before the fact existed returns no coffee fact",
          not any("coffee" in r["text"] for r in res_none["results"]),
          str([r["text"] for r in res_none["results"]]))
    check("a malformed as-of is an error, not a silent wrong answer",
          _raises(lambda: F.search_facts(conn, "coffee", as_of="not-a-date")),
          "")
    conn.close()


def test_migration_v1_to_v2() -> None:
    # Build a v1 database by hand (no valid_from / valid_to columns,
    # schema_version 1), then open it with the v2 code.
    tmp = Path(tempfile.mkdtemp())
    path = tmp / "memory.db"
    conn = sqlite3.connect(str(path))
    conn.executescript("""
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    entities TEXT NOT NULL DEFAULT '[]',
    session_id TEXT,
    source TEXT,
    importance INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    superseded_by INTEGER,
    hash TEXT NOT NULL UNIQUE
);
CREATE VIRTUAL TABLE facts_fts USING fts5(
    text, kind, entities,
    content='facts', content_rowid='id',
    tokenize='porter unicode61');
CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text, kind, entities)
  VALUES (new.id, new.text, new.kind, new.entities);
END;
CREATE TABLE handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    previous_session_id TEXT,
    summary TEXT NOT NULL,
    open_tasks TEXT NOT NULL DEFAULT '[]',
    left_off TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
INSERT INTO facts (text, kind, entities, session_id, importance, hash,
                   created_at)
VALUES ('DeepSeek is the coding model.', 'preference', '[]', 'sess-a',
        3, 'deadbeef-mig-1', '2026-11-18T00:00:00Z');
""")
    conn.commit()
    conn.close()
    # Open with the v2 code: it must migrate, not fail, and keep the fact.
    conn2 = F.open_db(path)
    cols = {r[1] for r in conn2.execute("PRAGMA table_info(facts)")}
    check("migration adds valid_from / valid_to columns",
          "valid_from" in cols and "valid_to" in cols, str(sorted(cols)))
    row = conn2.execute(
        "SELECT text, valid_from FROM facts WHERE hash='deadbeef-mig-1'"
    ).fetchone()
    check("migration preserves the existing fact",
          row is not None and "DeepSeek" in row["text"], str(row))
    check("migration backfills valid_from from created_at",
          row is not None and row["valid_from"] == "2026-11-18T00:00:00Z",
          str(dict(row)) if row else "")
    ver = conn2.execute(
        "SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
    check("migration bumps the schema version to 2",
          ver == "2", str(ver))
    res = F.search_facts(conn2, "DeepSeek", limit=5)
    check("a migrated database still searches",
          any("DeepSeek" in r["text"] for r in res["results"]),
          str(res["results"]))
    conn2.close()


# ------------------------------------------------------------ CLI

def test_cli_v2() -> None:
    tmp = Path(tempfile.mkdtemp())
    db = tmp / "memory.db"
    r = subprocess.run(
        [sys.executable, str(HERE / "facts.py"), "--db", str(db),
         "add", "--text", "DeepSeek is the coding model.",
         "--kind", "preference", "--session", "sess-cli"],
        capture_output=True, text=True)
    check("CLI add exits 0", r.returncode == 0, r.stderr[:200])
    r = subprocess.run(
        [sys.executable, str(HERE / "facts.py"), "--db", str(db),
         "search", "--query", "DeepSeek", "--limit", "3"],
        capture_output=True, text=True)
    check("CLI search returns the fact with a fused score",
          r.returncode == 0 and "fused_score" in r.stdout
          and "entity_overlap" in r.stdout, r.stderr[:200])
    r = subprocess.run(
        [sys.executable, str(HERE / "facts.py"), "--db", str(db),
         "search", "--query", "DeepSeek", "--as-of", "2026-11-18"],
        capture_output=True, text=True)
    check("CLI search --as-of exits 0 and returns the fact",
          r.returncode == 0 and "DeepSeek" in r.stdout, r.stderr[:200])
    r = subprocess.run(
        [sys.executable, str(HERE / "facts.py"), "--db", str(db),
         "backfill-entities"],
        capture_output=True, text=True)
    check("CLI backfill-entities exits 0 with a count report",
          r.returncode == 0 and "updated" in r.stdout, r.stderr[:200])
    r = subprocess.run(
        [sys.executable, str(HERE / "facts.py"), "--db", str(db),
         "check"],
        capture_output=True, text=True)
    check("CLI check reports schema_version 2",
          r.returncode == 0 and '"schema_version": 2' in r.stdout,
          r.stdout[:300])


def main() -> int:
    print("facts.py v2 — entity boost + RRF + temporal validity")
    test_extract_entities()
    test_auto_entities_on_add()
    test_backfill_entities()
    test_entity_boost()
    test_rrf_math()
    test_temporal_validity()
    test_migration_v1_to_v2()
    test_cli_v2()
    print(f"{PASS} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
