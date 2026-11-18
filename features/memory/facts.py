#!/usr/bin/env python3
"""facts.py — compact fact store + session handoff for QwenPaw memory.

Mem0-style extract-and-retrieve, self-contained on the Free machine.
No new database, no managed service, no embeddings, no new provider.
Stdlib only (sqlite3, argparse, json, re, hashlib).

DESIGN (why this shape)
-----------------------
The agent's full history already lives in history.db (19 MB, SQLite + FTS5)
and the user forbids deleting or archiving it — it is the source for
universal search, memory, and lesson learning. But re-sending the whole
history costs tens of thousands of tokens every turn, and a new session
starts cold.

So this tool keeps the full history UNTOUCHED and adds a SECOND, compact
store (memory.db) holding only distilled fact records:

- Extract: after a session/turn, salient facts, decisions, preferences,
  commitments, and measurements are distilled into one-line fact records.
  The extraction is rule-based candidate selection (the same shapes
  consolidate.py uses: correction, decision, preference, commitment,
  measurement, root cause) — the agent's own LLM reviews the candidates
  and adds the salient ones. Selection, not generation: no model call
  inside this tool, no new key, and the step is deterministic and testable.
- Store: one SQLite file with an external-content FTS5 index (the same
  pattern history.db uses). Facts are ADD-ONLY: adding the same fact twice
  returns the same id (content-hash dedup); a fact that changes is
  SUPERSEDED, never deleted — the old row stays, marked, so "what was
  true then" stays answerable (Graphiti-style validity, without a graph DB).
- Retrieve: FTS5 + BM25, token-budgeted (default 500, hard cap 1000).
  A turn retrieves a few hundred tokens of relevant facts, not the whole
  history — that is the token win.
- Handoff: at the end of a session the agent writes one handoff row
  (summary + open tasks + where it left off). A NEW session reads the
  latest handoff first, so it continues from where the previous session
  left off instead of starting cold. That is the cross-session recall.
- Universal search: `universal_search` returns facts AND reaches back
  into history.db (read-only, through recall.py) — the memory can see
  everything, not just the extracted facts.

GUARANTEES
----------
- history.db is never written. Facts live in a separate file (memory.db).
- Secrets are REJECTED, not scrubbed (like lessons.py): a fact containing
  a credential pattern is refused and no row is written.
- Read-only for history.db (recall.py enforces mode=ro + authorizer).
- Token estimates use chars / 3.6 (AGENTS.md section 7).

LIVE PATHS (machine)
--------------------
- CLI:  /data/home/qwenpaw/working/memory-tools/facts.py
- Store: /data/home/qwenpaw/working/workspaces/default/memory.db
- Skill: /data/home/qwenpaw/working/workspaces/default/skills/memory/SKILL.md

Usage:
  facts.py --db memory.db add --text "..." --kind decision --session sess-a
  facts.py --db memory.db search --query "loop gate" --limit 5
  facts.py --db memory.db extract --transcript turns.txt --session sess-a
  facts.py --db memory.db handoff-write --session sess-a --summary "..." \
      --open-tasks '["Build the image"]' --left-off "Waiting on the build."
  facts.py --db memory.db handoff-read            # latest
  facts.py --db memory.db search-history --history history.db --query "gate"
  facts.py --db memory.db check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# recall.py is the established redactor / history reader and lives in the
# same directory. facts.py refuses to run without it rather than risk
# writing a secret or reading history without the read-only guard.
try:
    import recall as _recall
except ImportError as exc:  # pragma: no cover - missing sibling is fatal
    raise SystemExit(
        "facts.py requires recall.py in the same directory (redactor + "
        "read-only history reader)."
    ) from exc

SCHEMA_VERSION = 1
TOKEN_CHARS = 3.6  # chars per token (AGENTS.md section 7)

# Facts are compact; the whole point is a few hundred tokens. The hard cap
# is deliberately lower than recall.py's 2000 (history windows are longer).
ABSOLUTE_BUDGET_TOKENS = 1000
DEFAULT_BUDGET_TOKENS = 500
DEFAULT_LIMIT = 5
MAX_LIMIT = 10

KINDS = ("fact", "decision", "preference", "task", "lesson")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
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
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    text, kind, entities,
    content='facts', content_rowid='id',
    tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text, kind, entities)
  VALUES (new.id, new.text, new.kind, new.entities);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, kind, entities)
  VALUES ('delete', old.id, old.text, old.kind, old.entities);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, kind, entities)
  VALUES ('delete', old.id, old.text, old.kind, old.entities);
  INSERT INTO facts_fts(rowid, text, kind, entities)
  VALUES (new.id, new.text, new.kind, new.entities);
END;
CREATE TABLE IF NOT EXISTS handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    previous_session_id TEXT,
    summary TEXT NOT NULL,
    open_tasks TEXT NOT NULL DEFAULT '[]',
    left_off TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id);
"""

# Secret patterns, reused from recall.py's redactor, EXCLUDING long_hex:
# a 32+ hex blob is a legitimate fact (a commit SHA), not a credential.
# Everything else in the list is a credential shape and must reject the add.
_SECRET_PATTERNS = [
    (name, pat) for (name, pat, _repl) in _recall._REDACTIONS
    if name != "long_hex"
]


class FactError(Exception):
    """A fact/handoff operation was refused (secret, bad input, bad query)."""


def estimate_tokens(text: str) -> int:
    """Token estimate: chars / 3.6 (AGENTS.md section 7)."""
    if not text:
        return 0
    return max(1, int(len(text) / TOKEN_CHARS))


def contains_secret(text: str) -> list[str]:
    """Names of the credential patterns present in text (empty = clean)."""
    return [name for name, pat in _SECRET_PATTERNS if pat.search(text or "")]


def _fact_hash(text: str) -> str:
    norm = re.sub(r"\s+", " ", (text or "").strip().lower())
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def open_db(path: str | Path) -> sqlite3.Connection:
    """Open (creating if needed) the fact store and ensure the schema."""
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    row = conn.execute(
        "SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),))
    conn.commit()
    return conn


def _check_secret(text: str, what: str = "fact") -> None:
    hits = contains_secret(text)
    if hits:
        raise FactError(
            f"{what} rejected: it contains a credential pattern "
            f"({', '.join(hits)}). Secrets are rejected, not scrubbed — "
            f"remove the value and retry.")


def add_fact(conn: sqlite3.Connection, text: str, kind: str = "fact",
             entities: list[str] | None = None,
             session_id: str | None = None, source: str | None = None,
             importance: int = 2) -> int:
    """Insert a fact (add-only, deduped by content hash). Returns the id.

    Adding the same fact twice returns the existing id and writes nothing.
    A fact containing a credential pattern is rejected outright.
    """
    text = (text or "").strip()
    if not text:
        raise FactError("fact text is required (empty fact is not allowed)")
    if kind not in KINDS:
        raise FactError(f"kind must be one of {', '.join(KINDS)}")
    if importance not in (1, 2, 3):
        raise FactError("importance must be 1, 2, or 3")
    _check_secret(text, "fact")
    digest = _fact_hash(text)
    row = conn.execute(
        "SELECT id FROM facts WHERE hash=?", (digest,)).fetchone()
    if row is not None:
        return int(row["id"])
    cur = conn.execute(
        "INSERT INTO facts (text, kind, entities, session_id, source,"
        " importance, hash) VALUES (?,?,?,?,?,?,?)",
        (text, kind, json.dumps(entities or []), session_id, source,
         importance, digest))
    conn.commit()
    return int(cur.lastrowid)


def supersede_fact(conn: sqlite3.Connection, fact_id: int, new_text: str,
                   session_id: str | None = None,
                   kind: str | None = None) -> int:
    """Replace a fact with a newer one WITHOUT deleting the old row.

    The old row stays, marked superseded_by=<new id>, so "what was true
    then" stays answerable. Search excludes superseded rows by default.
    Returns the new fact's id.
    """
    row = conn.execute(
        "SELECT text, kind FROM facts WHERE id=?", (fact_id,)).fetchone()
    if row is None:
        raise FactError(f"no fact with id {fact_id}")
    new_id = add_fact(conn, new_text, kind=kind or row["kind"],
                      session_id=session_id,
                      source=f"supersedes:{fact_id}")
    conn.execute(
        "UPDATE facts SET superseded_by=? WHERE id=?", (new_id, fact_id))
    conn.commit()
    return new_id


def search_facts(conn: sqlite3.Connection, query: str, limit: int = DEFAULT_LIMIT,
                 budget_tokens: int = DEFAULT_BUDGET_TOKENS,
                 include_superseded: bool = False) -> dict:
    """FTS5 + BM25 retrieval over the fact store, token-budgeted.

    Returns a JSON-serialisable report: results (id, text, kind,
    session_id, rank, tokens), tokens (total estimate), truncated_by_budget.
    """
    if limit < 1:
        raise FactError("limit must be >= 1")
    if limit > MAX_LIMIT:
        raise FactError(f"limit {limit} exceeds max {MAX_LIMIT}")
    if budget_tokens > ABSOLUTE_BUDGET_TOKENS:
        raise FactError(
            f"budget_tokens {budget_tokens} exceeds the hard cap "
            f"{ABSOLUTE_BUDGET_TOKENS}")
    if not query or not query.strip():
        raise FactError("query is required (empty query is not allowed)")
    match = _recall.fts_match_query(query)
    where_super = "" if include_superseded else "AND f.superseded_by IS NULL"
    t0 = time.perf_counter()
    try:
        rows = conn.execute(
            "SELECT f.id, f.text, f.kind, f.session_id, f.created_at,"
            " bm25(facts_fts) AS rank"
            " FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid"
            " WHERE facts_fts MATCH ? " + where_super +
            " ORDER BY rank LIMIT ?",
            (match, limit)).fetchall()
    except sqlite3.Error:
        # LIKE fallback (mirrors recall.py): FTS unavailable, not fatal.
        terms = _recall.like_terms(query)
        like = " OR ".join("f.text LIKE ?" for _ in terms)
        rows = conn.execute(
            "SELECT f.id, f.text, f.kind, f.session_id, f.created_at,"
            " 0.0 AS rank FROM facts f WHERE (" + like + ") "
            + where_super.replace("AND", "AND", 1) +
            " LIMIT ?",
            *[f"%{t}%" for t in terms] + [limit]).fetchall() \
            if terms else []
    latency_ms = round((time.perf_counter() - t0) * 1000, 2)
    results: list[dict] = []
    total = 0
    truncated = False
    for r in rows:
        tokens = estimate_tokens(r["text"])
        if results and total + tokens > budget_tokens:
            truncated = True
            break
        total += tokens
        results.append({
            "id": int(r["id"]),
            "text": r["text"],
            "kind": r["kind"],
            "session_id": r["session_id"],
            "created_at": r["created_at"],
            "rank": round(float(r["rank"]), 3),
            "tokens": tokens,
        })
    return {
        "query": query,
        "results": results,
        "tokens": total,
        "truncated_by_budget": truncated,
        "latency_ms": latency_ms,
    }


# ------------------------------------------------------------ extraction

# Shapes that precede a durable fact in this project's history. Same
# family as consolidate.py's shapes; extended with the kinds this store
# needs (preference, task). A line matching none of these is trivia.
_EXTRACT_SHAPES: list[tuple[str, re.Pattern[str]]] = [
    ("decision", re.compile(
        r"\b(decided|decision|we chose|chose to|going with|will use|"
        r"we will use|the plan is|agreed to)\b", re.I)),
    ("preference", re.compile(
        r"\b(prefer|I like|always use|never use|only use|use .* at max|"
        r"do not use|don't use)\b", re.I)),
    ("task", re.compile(
        r"\b(I will|we will|will do|need to|must|next step|todo|"
        r"pending|tomorrow|will add|will build|will test)\b", re.I)),
    ("fact", re.compile(
        r"\b(measured|verified|confirmed|the .* is|stopped at|"
        r"\d+\s*(calls|ms|MB|GB|seconds|minutes|hours|days)|"
        r"has to be entered|requires a .* key)\b", re.I)),
    ("lesson", re.compile(
        r"\b(should have|next time|never again|lesson|turns out|"
        r"actually|was wrong|the real cause|root cause)\b", re.I)),
]

_SKIP_LINE = re.compile(
    r"^(echo|ls|cat|pwd|cd|docker|git|python3?|curl|sleep|#)\b|"
    r"^(hello|hi|ok|okay|yes|no|thanks|thank you)\.?$",
    re.I)


def extract_candidates(transcript: str,
                       session_id: str | None = None) -> list[dict]:
    """Rule-based candidate facts from a conversation transcript.

    Input: plain text, one turn per line, optionally prefixed `role:`.
    Output: candidate fact records (text, kind, evidence, session_id).
    This PROPOSES; it never writes. The agent's LLM reviews the
    candidates and adds the salient ones with `add`. A line matching no
    shape is trivia and is skipped, as is tool noise.
    """
    candidates: list[dict] = []
    seen: set[str] = set()
    for raw in (transcript or "").splitlines():
        line = raw.strip()
        if not line or len(line) < 12:
            continue
        # Strip a `role:` prefix for matching, keep the full line as evidence.
        body = re.sub(r"^(user|assistant|tool|system)\s*:\s*", "", line,
                      flags=re.I)
        if _SKIP_LINE.match(body.strip()):
            continue
        # Split into sentences; a turn can hold more than one fact.
        for sent in re.split(r"(?<=[.!?])\s+", body):
            sent = sent.strip()
            if len(sent) < 12 or len(sent) > 400:
                continue
            key = re.sub(r"\s+", " ", sent.lower())
            if key in seen:
                continue
            for kind, pat in _EXTRACT_SHAPES:
                if pat.search(sent):
                    seen.add(key)
                    candidates.append({
                        "text": sent,
                        "kind": kind,
                        "evidence": line,
                        "session_id": session_id,
                    })
                    break
    return candidates


# ------------------------------------------------------------ handoff

def handoff_write(conn: sqlite3.Connection, session_id: str,
                  summary: str, open_tasks: list[str] | None = None,
                  left_off: str = "", previous_session_id: str | None = None
                  ) -> int:
    """Write one session handoff row (summary + open tasks + where it left off)."""
    session_id = (session_id or "").strip()
    summary = (summary or "").strip()
    if not session_id:
        raise FactError("handoff requires a session_id")
    if not summary:
        raise FactError("handoff requires a summary")
    _check_secret(summary, "handoff summary")
    _check_secret(left_off, "handoff left_off")
    for task in (open_tasks or []):
        _check_secret(task, "handoff open task")
    cur = conn.execute(
        "INSERT INTO handoffs (session_id, previous_session_id, summary,"
        " open_tasks, left_off) VALUES (?,?,?,?,?)",
        (session_id, previous_session_id, summary,
         json.dumps(open_tasks or []), left_off))
    conn.commit()
    return int(cur.lastrowid)


def handoff_read(conn: sqlite3.Connection,
                 session_id: str | None = None) -> dict:
    """Read a handoff: the named session's, or the latest if none named.

    Returns found=False (not an error) when no handoff exists yet.
    """
    if session_id:
        row = conn.execute(
            "SELECT * FROM handoffs WHERE session_id=? ORDER BY id DESC"
            " LIMIT 1", (session_id,)).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM handoffs ORDER BY id DESC LIMIT 1").fetchone()
    if row is None:
        return {"found": False}
    tasks = json.loads(row["open_tasks"] or "[]")
    body = (row["summary"] + " " + row["left_off"]
            + " " + " ".join(tasks))
    return {
        "found": True,
        "session_id": row["session_id"],
        "previous_session_id": row["previous_session_id"],
        "summary": row["summary"],
        "open_tasks": tasks,
        "left_off": row["left_off"],
        "created_at": row["created_at"],
        "tokens": estimate_tokens(body),
    }


# ------------------------------------------------------------ universal search

def universal_search(conn: sqlite3.Connection, history_db: str | Path,
                     query: str, limit: int = 3) -> dict:
    """Search facts AND the full history in one call (universal search).

    Facts come from this store; history comes from history.db read-only
    through recall.py (its token cap and redaction apply there). The
    memory can see everything, not just the extracted facts.
    """
    facts = search_facts(conn, query, limit=limit)
    try:
        # recall.recall() returns "hits" (each with excerpt + tokens) and
        # "total_tokens" — not "results"/"tokens".
        hist = _recall.recall(Path(history_db), query, limit=limit)
        hist_hits = [
            {"excerpt": h.get("excerpt", ""), "tokens": h.get("tokens", 0)}
            for h in hist.get("hits", [])
        ]
        hist_tokens = hist.get("total_tokens", 0)
    except Exception as exc:  # history missing/unreadable is not fatal here
        hist_hits = []
        hist_tokens = 0
        facts.setdefault("history_error", str(exc))
    return {
        "query": query,
        "facts": facts["results"],
        "history": hist_hits,
        "tokens": facts["tokens"] + hist_tokens,
    }


def check_db(conn: sqlite3.Connection) -> dict:
    """Schema + counts + latest handoff (no writes)."""
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    fts = "facts_fts" in {
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
    info: dict = {
        "facts": conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0],
        "handoffs": conn.execute(
            "SELECT COUNT(*) FROM handoffs").fetchone()[0],
        "fts": fts,
        "tables": sorted(tables),
    }
    latest = handoff_read(conn)
    if latest.get("found"):
        info["latest_handoff"] = {
            "session_id": latest["session_id"],
            "created_at": latest["created_at"],
            "open_tasks": latest["open_tasks"],
        }
    return info


# ------------------------------------------------------------ CLI

def _parse_tasks(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        val = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FactError(f"--open-tasks must be a JSON list: {exc}") from exc
    if not isinstance(val, list) or not all(isinstance(x, str) for x in val):
        raise FactError("--open-tasks must be a JSON list of strings")
    return val


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="facts.py",
        description="Compact fact store + session handoff (QwenPaw memory).")
    ap.add_argument("--db", default="memory.db",
                    help="path to memory.db (default: ./memory.db)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("add", help="add one fact (add-only, deduped)")
    p.add_argument("--text", required=True)
    p.add_argument("--kind", default="fact", choices=list(KINDS))
    p.add_argument("--entities", default="")
    p.add_argument("--session")
    p.add_argument("--source")
    p.add_argument("--importance", type=int, default=2)

    p = sub.add_parser("search", help="FTS5 retrieval over facts")
    p.add_argument("--query", required=True)
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    p.add_argument("--budget", type=int, default=DEFAULT_BUDGET_TOKENS)
    p.add_argument("--include-superseded", action="store_true")

    p = sub.add_parser("extract",
                       help="propose candidate facts from a transcript (no writes)")
    p.add_argument("--transcript", required=True,
                   help="path to a transcript file (one turn per line)")
    p.add_argument("--session")

    p = sub.add_parser("handoff-write", help="write a session handoff")
    p.add_argument("--session", required=True)
    p.add_argument("--previous")
    p.add_argument("--summary", required=True)
    p.add_argument("--open-tasks", default="[]",
                   help='JSON list, e.g. \'["Build the image"]\'')
    p.add_argument("--left-off", default="")

    p = sub.add_parser("handoff-read", help="read a handoff (latest by default)")
    p.add_argument("--session")

    p = sub.add_parser("search-history",
                       help="universal search: facts + history.db (read-only)")
    p.add_argument("--history", required=True, help="path to history.db")
    p.add_argument("--query", required=True)
    p.add_argument("--limit", type=int, default=3)

    sub.add_parser("check", help="schema + counts + latest handoff")

    args = ap.parse_args(argv)
    try:
        conn = open_db(args.db)
    except sqlite3.Error as exc:
        print(json.dumps({"error": f"cannot open {args.db}: {exc}"}))
        return 2
    try:
        if args.cmd == "add":
            fid = add_fact(
                conn, args.text, kind=args.kind,
                entities=[e.strip() for e in args.entities.split(",") if e.strip()],
                session_id=args.session, source=args.source,
                importance=args.importance)
            print(json.dumps({"id": fid, "duplicate": False}))
        elif args.cmd == "search":
            print(json.dumps(search_facts(
                conn, args.query, limit=args.limit,
                budget_tokens=args.budget,
                include_superseded=args.include_superseded), indent=2))
        elif args.cmd == "extract":
            text = Path(args.transcript).read_text(encoding="utf-8")
            cands = extract_candidates(text, session_id=args.session)
            print(json.dumps(
                {"candidates": cands, "count": len(cands)}, indent=2))
        elif args.cmd == "handoff-write":
            hid = handoff_write(
                conn, args.session, args.summary,
                open_tasks=_parse_tasks(args.open_tasks),
                left_off=args.left_off,
                previous_session_id=args.previous)
            print(json.dumps({"id": hid}))
        elif args.cmd == "handoff-read":
            print(json.dumps(handoff_read(conn, args.session), indent=2))
        elif args.cmd == "search-history":
            print(json.dumps(universal_search(
                conn, args.history, args.query, limit=args.limit), indent=2))
        elif args.cmd == "check":
            print(json.dumps(check_db(conn), indent=2))
    except FactError as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    except (sqlite3.Error, OSError) as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
