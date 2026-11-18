#!/usr/bin/env python3
"""Tests for the compact fact store + session handoff (features/memory/facts.py).

Mem0-style extract-and-retrieve, self-contained: a NEW SQLite database
(memory.db) holding compact fact records and session handoffs. history.db
is never written or modified — facts are ADDITIVE, and the universal-search
path reads history.db read-only through recall.py.

Run: python3 features/memory/test_facts.py [--selftest]
Exit 0 = all pass. Prints "N passed, M failed" as the last line.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import time
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


# ------------------------------------------------------------ fixtures

SAMPLE_TRANSCRIPT = """\
user: We need to fix the loop gate so it actually enforces 30 calls.
assistant: The gate exists but it is not wired into the default chain, so ordinary chats are unprotected.
user: We decided to fix the gate and then build the derived image.
assistant: I will build the derived image from the pinned upstream digest.
user: I prefer DeepSeek for coding work, use it at maximum context.
assistant: Noted. DeepSeek is the coding model, Astra is down.
user: The gate stopped at 100 calls in the live test, not 30.
assistant: The model emits about 50 calls per batch, so a gate that only checks between replies cannot enforce 30.
user: echo hello
assistant: hello
user: The TinyFish key has to be entered by the user in the vault.
assistant: Right, and if no key is entered the agent uses normal search as now.
"""

# A fake history.db (same schema as QwenPaw v2.3.0) for the token-savings
# and universal-search measurements.
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
CREATE VIRTUAL TABLE conversation_history_fts USING fts5(
    content, content='conversation_history', content_rowid='seq',
    tokenize='porter unicode61');
CREATE TRIGGER conversation_history_ai AFTER INSERT ON conversation_history BEGIN
  INSERT INTO conversation_history_fts(rowid, content) VALUES (new.seq, new.content);
END;
"""

LONG_HISTORY_TEXT = (
    "The loop gate fix is the priority. The gate exists in the source but "
    "it is not wired into the default chain, so ordinary chats run without "
    "a tool-call budget. The derived image will carry the patch. "
    "DeepSeek is the coding model now, Astra is down. "
    "The TinyFish skill is installed and enabled. "
    "The vault holds the GitHub key. "
    "The machine is on InstaBox Free. "
) * 40  # ~14 KB of history text, the "full context" the facts replace


def fresh_db() -> tuple[sqlite3.Connection, Path]:
    tmp = Path(tempfile.mkdtemp())
    path = tmp / "memory.db"
    conn = F.open_db(path)
    return conn, path


def seed_facts(conn: sqlite3.Connection) -> dict[str, int]:
    ids = {}
    ids["gate"] = F.add_fact(
        conn,
        text="The loop gate must be fixed so it enforces 30 tool calls, then shipped as a derived image.",
        kind="decision",
        entities=["loop gate", "derived image"],
        session_id="sess-a",
        source="chat:sess-a",
        importance=3,
    )
    ids["deepseek"] = F.add_fact(
        conn,
        text="DeepSeek is the coding model; use it at maximum context and maximum output. Astra is down.",
        kind="preference",
        entities=["DeepSeek", "Astra"],
        session_id="sess-a",
        source="chat:sess-a",
        importance=3,
    )
    ids["tinyfish"] = F.add_fact(
        conn,
        text="The TinyFish key is entered by the user in the vault; if no key is entered the agent uses normal search as now.",
        kind="fact",
        entities=["TinyFish", "vault"],
        session_id="sess-a",
        source="chat:sess-a",
        importance=2,
    )
    ids["cooking"] = F.add_fact(
        conn,
        text="The user likes their coffee black with no sugar in the morning.",
        kind="preference",
        entities=["coffee"],
        session_id="sess-a",
        source="chat:sess-a",
        importance=1,
    )
    return ids


# ------------------------------------------------------------ extraction

def test_extraction() -> None:
    cands = F.extract_candidates(SAMPLE_TRANSCRIPT, session_id="sess-a")
    texts = [c["text"] for c in cands]
    joined = " ".join(texts)
    check("extract finds the decision (fix gate + derived image)",
          any("derived image" in t for t in texts), joined[:200])
    check("extract finds the preference (DeepSeek)",
          any("DeepSeek" in t for t in texts), joined[:200])
    check("extract finds the commitment (build the derived image)",
          any("derived image" in t and c["kind"] in ("task", "decision")
              for t, c in zip(texts, cands)), joined[:200])
    check("extract finds the measurement (100 calls, not 30)",
          any("100 calls" in t for t in texts), joined[:200])
    check("extract finds the TinyFish key rule",
          any("TinyFish" in t for t in texts), joined[:200])
    check("extract skips trivia and tool noise (echo hello)",
          not any("echo hello" in t for t in texts), joined[:200])
    check("extract returns kinds for every candidate",
          all(c.get("kind") in ("fact", "decision", "preference", "task", "lesson")
              for c in cands), str([c.get("kind") for c in cands]))
    check("extract dedups identical sentences",
          len(texts) == len(set(t.strip().lower() for t in texts)),
          f"{len(texts)} candidates")


# ------------------------------------------------------------ retrieval

def test_retrieval() -> None:
    conn, _ = fresh_db()
    seed_facts(conn)
    t0 = time.perf_counter()
    res = F.search_facts(conn, "loop gate", limit=5)
    dt_ms = (time.perf_counter() - t0) * 1000
    texts = [r["text"] for r in res["results"]]
    check("retrieval ranks the loop-gate fact first for 'loop gate'",
          texts and "loop gate" in texts[0].lower(), str(texts[:2]))
    check("retrieval ranks the gate fact above the coffee fact",
          texts.index(next(t for t in texts if "loop gate" in t.lower()))
          < texts.index(next(t for t in texts if "coffee" in t.lower()))
          if any("coffee" in t.lower() for t in texts) else True,
          str(texts))
    check("retrieval is fast (< 100 ms on the fixture)",
          dt_ms < 100, f"{dt_ms:.1f} ms")
    check("retrieved set is small (<= 500 tokens for 5 facts)",
          res["tokens"] <= 500, f"{res['tokens']} tokens")
    check("retrieval honours the limit",
          len(res["results"]) <= 5, f"{len(res['results'])} results")
    res1 = F.search_facts(conn, "loop gate", limit=1)
    check("limit=1 returns exactly one result",
          len(res1["results"]) == 1, f"{len(res1['results'])}")
    check("empty query is an error, not an empty result",
          _raises(lambda: F.search_facts(conn, "  ")), "")
    conn.close()


def _raises(fn) -> bool:
    try:
        fn()
    except Exception:
        return True
    return False


def test_token_savings() -> None:
    conn, _ = fresh_db()
    seed_facts(conn)
    # Build a fake history.db with the long transcript text.
    tmp = Path(tempfile.mkdtemp())
    hpath = tmp / "history.db"
    hconn = sqlite3.connect(str(hpath))
    hconn.executescript(HISTORY_SCHEMA)
    hconn.execute(
        "INSERT INTO conversation_history (session_id, kind, role, content, created_at)"
        " VALUES (?,?,?,?,?)",
        ("sess-a", "message", "user", LONG_HISTORY_TEXT, "2026-11-18T00:00:00"),
    )
    hconn.commit()
    full_tokens = F.estimate_tokens(LONG_HISTORY_TEXT)
    res = F.search_facts(conn, "loop gate", limit=5)
    check("retrieved facts cost < 10% of the full history text",
          res["tokens"] < full_tokens * 0.10,
          f"retrieved {res['tokens']} vs full {full_tokens}")
    check("full history is large enough for the comparison to mean something",
          full_tokens > 2000, f"{full_tokens} tokens")
    hconn.close()
    conn.close()


# ------------------------------------------------------------ handoff

def test_handoff() -> None:
    conn, _ = fresh_db()
    # No handoff yet: an empty result, not an error.
    empty = F.handoff_read(conn)
    check("handoff-read with no handoff returns found=False",
          empty.get("found") is False, str(empty))
    # Session A writes the handoff.
    F.handoff_write(
        conn,
        session_id="sess-a",
        previous_session_id=None,
        summary="Fixed the loop gate design; derived image build started.",
        open_tasks=["Build the derived image", "Live-test the gate in an ordinary chat"],
        left_off="Waiting on the derived image build; the gate patch is committed.",
    )
    # Session B reads it.
    got = F.handoff_read(conn)
    check("session B reads session A's handoff",
          got.get("found") is True and got.get("session_id") == "sess-a",
          str(got))
    check("handoff carries the open tasks",
          got.get("open_tasks") == ["Build the derived image",
                                    "Live-test the gate in an ordinary chat"],
          str(got.get("open_tasks")))
    check("handoff carries where session A left off",
          "derived image build" in (got.get("left_off") or ""),
          str(got.get("left_off")))
    check("handoff token count is small (<= 300)",
          got.get("tokens", 9999) <= 300, f"{got.get('tokens')} tokens")
    # A second handoff supersedes the first for "latest".
    F.handoff_write(
        conn,
        session_id="sess-b",
        previous_session_id="sess-a",
        summary="Derived image built.",
        open_tasks=["Deploy the image"],
        left_off="Image built; deploy next.",
    )
    latest = F.handoff_read(conn)
    check("latest handoff is the newest session (sess-b)",
          latest.get("session_id") == "sess-b", str(latest.get("session_id")))
    by_id = F.handoff_read(conn, session_id="sess-a")
    check("handoff-read by session id returns that session",
          by_id.get("session_id") == "sess-a", str(by_id.get("session_id")))
    conn.close()


# ------------------------------------------------------------ store

def test_store() -> None:
    conn, _ = fresh_db()
    ids = seed_facts(conn)
    # Dedup: the same fact twice returns the same id and one row.
    again = F.add_fact(
        conn,
        text="The loop gate must be fixed so it enforces 30 tool calls, then shipped as a derived image.",
        kind="decision",
        session_id="sess-a",
        source="chat:sess-a",
    )
    check("adding the same fact twice returns the same id (add-only dedup)",
          again == ids["gate"], f"{again} vs {ids['gate']}")
    n = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    check("dedup leaves exactly one row for the duplicated fact",
          n == 4, f"{n} rows")
    # Supersede: the old row stays, marked; search excludes it by default.
    F.supersede_fact(conn, ids["cooking"],
                     "The user now takes their coffee with milk.",
                     session_id="sess-b")
    old = conn.execute(
        "SELECT superseded_by FROM facts WHERE id=?", (ids["cooking"],)).fetchone()[0]
    check("superseding marks the old row (no deletion)",
          old is not None, f"superseded_by={old}")
    still = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    check("superseding adds a row, it never deletes one",
          still == 5, f"{still} rows")
    res = F.search_facts(conn, "coffee", limit=5)
    texts = [r["text"] for r in res["results"]]
    check("search excludes the superseded fact by default",
          not any("no sugar" in t for t in texts), str(texts))
    check("search returns the replacement fact",
          any("milk" in t for t in texts), str(texts))
    # Secrets are rejected, not scrubbed.
    check("a fact containing a token is rejected, not stored",
          _raises(lambda: F.add_fact(
              conn, text="The key is sk-abcdefghijklmnopqrstuvwx.",
              kind="fact", session_id="sess-a")),
          "")
    n2 = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    check("the rejected fact left no row behind",
          n2 == 5, f"{n2} rows")
    conn.close()


def test_check_and_history_search() -> None:
    conn, path = fresh_db()
    seed_facts(conn)
    info = F.check_db(conn)
    check("check reports the fact count",
          info.get("facts") == 4, str(info))
    check("check reports the FTS table present",
          info.get("fts") is True, str(info))
    # Universal search: facts + history through one call.
    tmp = Path(tempfile.mkdtemp())
    hpath = tmp / "history.db"
    hconn = sqlite3.connect(str(hpath))
    hconn.executescript(HISTORY_SCHEMA)
    hconn.execute(
        "INSERT INTO conversation_history (session_id, kind, role, content, created_at)"
        " VALUES (?,?,?,?,?)",
        ("sess-a", "message", "user",
         "The loop gate fix uses a derived image from the pinned digest.",
         "2026-11-18T00:00:00"),
    )
    hconn.commit()
    hconn.close()
    uni = F.universal_search(conn, hpath, "loop gate", limit=3)
    check("universal search returns facts",
          len(uni.get("facts", [])) >= 1, str(uni))
    check("universal search reaches back into history.db",
          len(uni.get("history", [])) >= 1, str(uni))
    check("universal search total tokens stay small",
          uni.get("tokens", 99999) <= 2000, f"{uni.get('tokens')} tokens")
    conn.close()


def test_cli() -> None:
    # The CLI works end to end on a temp DB (subprocess, no import).
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
    check("CLI search exits 0 and returns the fact",
          r.returncode == 0 and "DeepSeek" in r.stdout, r.stderr[:200])
    out = json.loads(r.stdout)
    check("CLI search output is JSON with a token count",
          isinstance(out.get("tokens"), int), r.stdout[:200])
    r = subprocess.run(
        [sys.executable, str(HERE / "facts.py"), "--db", str(db),
         "check"],
        capture_output=True, text=True)
    check("CLI check exits 0", r.returncode == 0, r.stderr[:200])


def main() -> int:
    print("facts.py — fact store + session handoff")
    test_extraction()
    test_retrieval()
    test_token_savings()
    test_handoff()
    test_store()
    test_check_and_history_search()
    test_cli()
    print(f"{PASS} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
