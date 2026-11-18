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
- Retrieve: multi-signal, token-budgeted (default 500, hard cap 1000).
  Three signals fused by reciprocal rank fusion (RRF, k=60) — the same
  shape Mem0 uses (semantic + BM25 + entity), minus the vector signal
  (no embedding model is configured, so the lexical path is the only
  honest one): BM25 over the FTS5 index, entity overlap (facts sharing
  an entity with the query rank up), and importance. A turn retrieves a
  few hundred tokens of relevant facts, not the whole history — that is
  the token win. `search --as-of DATE` is Zep/Graphiti-style time
  travel: the facts that were valid at that moment (valid_from /
  valid_to windows; superseding a fact closes its window, it never
  deletes the row).
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

SCHEMA_VERSION = 2
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
    valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    valid_to TEXT,
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


# ------------------------------------------------------------ entities
# Mem0-style entity extraction, rule-based and stdlib-only (no model, no
# embeddings). Entities are used as a SECOND retrieval signal: a fact
# sharing an entity with the query gets a rank boost (see search_facts).
# They are a heuristic, not ground truth — a noisy entity only matters
# if the query shares it, which means the query names the same topic.
# The FTS index already contains the entities column, so entity terms
# also match lexically; the explicit boost weights entity overlap more
# heavily than body-text overlap.

# Project / product / service names this deployment actually uses.
# Matched case-insensitively on word boundaries; stored in canonical form.
_ENTITY_LEXICON = {
    "qwenpaw": "QwenPaw", "agentx": "AgentX", "deepseek": "DeepSeek",
    "tinyfish": "TinyFish", "kilo": "Kilo", "instabox": "InstaBox",
    "cloudflare": "Cloudflare", "github": "GitHub", "rakazo": "Rakazo",
    "mem0": "Mem0", "zep": "Zep", "graphiti": "Graphiti",
    "letta": "Letta", "supermemory": "Supermemory",
    "docker": "Docker", "pages": "Pages", "workers": "Workers",
    "d1": "D1", "vault": "Vault", "telegram": "Telegram",
    "slack": "Slack", "discord": "Discord", "openai": "OpenAI",
    "anthropic": "Anthropic", "gemini": "Gemini", "groq": "Groq",
    "mistral": "Mistral", "openrouter": "OpenRouter", "xai": "xAI",
    "gogibeta": "gogibeta", "ratulbaba7": "Ratulbaba7",
    "satwik": "satwik", "qwen": "Qwen", "agentscope": "AgentScope",
    "camoufox": "Camoufox", "novnc": "noVNC", "systemd": "systemd",
    "sqlite": "SQLite", "fts5": "FTS5", "bm25": "BM25",
    "hugging face": "Hugging Face", "google gemini": "Google Gemini",
    "loop gate": "loop gate", "derived image": "derived image",
    "daily summary": "daily summary", "guarded": "Guarded",
}

_ENTITY_STOP = {
    "the", "a", "an", "this", "that", "it", "its", "in", "on", "at",
    "to", "for", "of", "and", "or", "but", "we", "i", "you", "he",
    "she", "they", "is", "are", "was", "were", "has", "have", "had",
    "will", "would", "can", "could", "should", "do", "does", "did",
    "not", "no", "yes", "if", "when", "where", "why", "how", "what",
    "who", "which", "with", "without", "from", "by", "as", "be",
    "been", "being", "all", "any", "each", "every", "some", "none",
    "one", "two", "first", "second", "new", "old", "more", "most",
    "other", "same", "such", "only", "own", "too", "very", "just",
    "also", "now", "then", "here", "there", "today", "tomorrow",
    "yesterday",
}

_MAX_ENTITIES = 8


def extract_entities(text: str) -> list[str]:
    """Rule-based entity extraction from a fact or query (stdlib only).

    Returns a deduped list (first-seen casing), capped at 8. Sources,
    in order: quoted strings, the known-name lexicon, CamelCase/acronym
    tokens, and 2-4 word capitalised phrases (leading stopwords stripped).
    """
    text = text or ""
    found: list[str] = []
    seen: set[str] = set()

    def _add(value: str) -> None:
        value = re.sub(r"\s+", " ", value.strip())
        if not value or len(value) > 40 or len(value) < 2:
            return
        key = value.lower()
        if key in seen or key in _ENTITY_STOP:
            return
        seen.add(key)
        found.append(value)

    # Quoted strings are deliberate names.
    for m in re.finditer(r'"([^"]{2,40})"|\'([^\']{2,40})\'', text):
        _add(m.group(1) or m.group(2) or "")
    # Known project / product names (case-insensitive word boundary).
    # Hyphens are word separators here: "loop-gate" must match the
    # "loop gate" term (T137, 2026-11-19: the hyphenated target missed
    # the entity signal and ranked below its space-spelled distractor,
    # hit@1 0.833; normalising hyphens to spaces before matching makes
    # it 1.0). Scoring weights are unchanged — only the match text.
    lowered = re.sub(r"-", " ", text.lower())
    for term, canonical in _ENTITY_LEXICON.items():
        if re.search(r"\b" + re.escape(term) + r"\b", lowered):
            _add(canonical)
    # CamelCase tokens (QwenPaw, TinyFish) and acronyms (API, CLI, D1).
    for m in re.finditer(r"\b[A-Za-z]*[A-Z][a-z]+[A-Z][A-Za-z]*\b", text):
        _add(m.group(0))
    for m in re.finditer(r"\b[A-Z]{2,}\d*\b", text):
        if m.group(0).lower() not in _ENTITY_STOP:
            _add(m.group(0))
    # 2-4 word capitalised phrases ("Loop Gate Fix", "Daily Summary").
    for m in re.finditer(r"\b(?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+){1,3}\b", text):
        words = m.group(0).split()
        while words and words[0].lower() in _ENTITY_STOP:
            words.pop(0)
        if len(words) >= 2:
            _add(" ".join(words))
    return found[:_MAX_ENTITIES]


def _entity_overlap(a: list[str], b: list[str]) -> int:
    """Count of shared entities (case-insensitive)."""
    return len({x.lower() for x in a} & {y.lower() for y in b})


def _rrf_fuse(weighted_ranks: list[tuple[int, float]], k: int = 10) -> float:
    """Weighted reciprocal rank fusion: sum weight / (k + rank) over signals.

    k=10 (not the standard 60) because our candidate lists are short
    (<= 30); a smaller k gives the rank differences real weight. The
    entity signal is weighted 2x and importance 2x: sharing an entity
    with the query, or being marked important, is a stronger relevance
    cue than a one-position BM25 difference, but neither alone
    overrides a large BM25 gap.
    """
    return sum(w / (k + r) for r, w in weighted_ranks)


def _dense_ranks(items: list[dict], key) -> dict[int, int]:
    """Dense rank (1-based, ties share a rank) for a list of dicts.

    Returns {id(item): rank}. `key` extracts the sort value (higher is
    better). Ties get the same rank; the next distinct value is +1.
    """
    ordered = sorted(items, key=key, reverse=True)
    ranks: dict[int, int] = {}
    rank = 0
    prev = None
    for it in ordered:
        val = key(it)
        if prev is None or val != prev:
            rank += 1
            prev = val
        ranks[id(it)] = rank
    return ranks


def open_db(path: str | Path) -> sqlite3.Connection:
    """Open (creating if needed) the fact store and ensure the schema.

    Migrates v1 -> v2 on open: adds valid_from / valid_to (temporal
    validity windows, Zep/Graphiti-style) and backfills valid_from from
    created_at. Existing rows are never deleted or rewritten — the
    migration only ADDS columns and fills the new ones.
    """
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    row = conn.execute(
        "SELECT value FROM meta WHERE key='schema_version'").fetchone()
    version = int(row[0]) if row is not None else 0
    if version < 2:
        _migrate_v1_to_v2(conn)
    if row is None:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),))
    else:
        # Write the current version (covers the migration case: the
        # stored value is stale until this update runs).
        conn.execute(
            "UPDATE meta SET value=? WHERE key='schema_version'",
            (str(SCHEMA_VERSION),))
    conn.commit()
    return conn


def _migrate_v1_to_v2(conn: sqlite3.Connection) -> None:
    """Add valid_from / valid_to to facts (v1 -> v2). Add-only migration."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(facts)")}
    if "valid_from" not in cols:
        conn.execute("ALTER TABLE facts ADD COLUMN valid_from TEXT")
    if "valid_to" not in cols:
        conn.execute("ALTER TABLE facts ADD COLUMN valid_to TEXT")
    # Backfill: a fact is valid from when it was created. Superseded rows
    # keep valid_to NULL (their superseded_by marker already excludes
    # them from default search); only NEW supersessions set valid_to.
    conn.execute(
        "UPDATE facts SET valid_from = created_at WHERE valid_from IS NULL")
    conn.commit()


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
    # Entities are auto-extracted when the caller supplies none, so
    # every fact carries the entity signal for retrieval (Mem0-style).
    # Explicitly supplied entities are used as-is.
    if not entities:
        entities = extract_entities(text)
    cur = conn.execute(
        "INSERT INTO facts (text, kind, entities, session_id, source,"
        " importance, hash) VALUES (?,?,?,?,?,?,?)",
        (text, kind, json.dumps(entities or []), session_id, source,
         importance, digest))
    conn.commit()
    return int(cur.lastrowid)


def backfill_entities(conn: sqlite3.Connection) -> dict:
    """Populate entities for facts that have none (migration helper).

    Only touches rows whose entities list is empty; it never changes
    text, kind, or any other field, and never deletes a row. The FTS
    trigger re-indexes the updated rows. Returns a count report.
    """
    rows = conn.execute(
        "SELECT id, text FROM facts WHERE entities IN ('[]', '', 'null')"
    ).fetchall()
    updated = 0
    for r in rows:
        ents = extract_entities(r["text"])
        if ents:
            conn.execute(
                "UPDATE facts SET entities=? WHERE id=?",
                (json.dumps(ents), r["id"]))
            updated += 1
    conn.commit()
    return {"examined": len(rows), "updated": updated}


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
    # Temporal validity (Zep/Graphiti-style): the old fact stops being
    # valid now; the new fact is valid from now (its created_at). The old
    # row stays, so "what was true then" is still answerable with --as-of.
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    conn.execute(
        "UPDATE facts SET superseded_by=?, valid_to=? WHERE id=?",
        (new_id, now, fact_id))
    conn.commit()
    return new_id


def search_facts(conn: sqlite3.Connection, query: str, limit: int = DEFAULT_LIMIT,
                 budget_tokens: int = DEFAULT_BUDGET_TOKENS,
                 include_superseded: bool = False,
                 as_of: str | None = None) -> dict:
    """Multi-signal retrieval over the fact store, token-budgeted.

    Signals, fused by weighted reciprocal rank fusion (RRF, k=10) — the
    same shape Mem0 uses (semantic + BM25 + entity), minus the vector
    signal (no embedding model is configured, so the lexical path is the
    only honest one; see the README):
      1. BM25 over the FTS5 index (text + kind + entities), weight 1.
      2. Entity overlap: facts sharing an entity with the query rank up,
         weight 2 (a shared entity outweighs a one-position BM25 gap,
         not a large one). Ties share a rank, so a signal with no
         spread adds the same constant to every candidate.
      3. Importance: importance-3 facts rank above importance-1, weight 2
         (importance outweighs a one-position BM25 gap, same as entity).
    A query with no entities degrades gracefully: the entity signal ties
    for every candidate and adds the same constant to all scores, so the
    order falls back to BM25 + importance.

    `as_of` (ISO date/datetime, Zep/Graphiti-style time travel) returns
    the facts that were valid at that moment: valid_from <= as_of AND
    (valid_to IS NULL OR valid_to > as_of). It implies include-superseded
    for the validity window — a fact superseded later was still true then.

    Returns a JSON-serialisable report: results (id, text, kind,
    session_id, rank, entity_overlap, fused_score, tokens), tokens
    (total estimate), truncated_by_budget, latency_ms.
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
    if as_of and not re.match(
            r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$", as_of):
        raise FactError("as_of must be an ISO date or datetime (YYYY-MM-DD)")
    match = _recall.fts_match_query(query)
    query_entities = extract_entities(query)
    # Validity filter. Default: current facts only (not superseded).
    # as_of: the facts valid at that moment (superseded later is fine).
    if as_of:
        stamp = as_of if "T" in as_of else as_of + "T23:59:59Z"
        where = ("AND f.valid_from <= ? AND "
                 "(f.valid_to IS NULL OR f.valid_to > ?)")
        where_params: list[str] = [stamp, stamp]
    elif include_superseded:
        where, where_params = "", []
    else:
        where, where_params = "AND f.superseded_by IS NULL", []
    # Fetch 3x the limit so the re-rank has candidates to choose from.
    fetch = min(limit * 3, MAX_LIMIT * 3)
    t0 = time.perf_counter()
    try:
        rows = conn.execute(
            "SELECT f.id, f.text, f.kind, f.session_id, f.created_at,"
            " f.entities, f.importance, f.valid_from, f.valid_to,"
            " bm25(facts_fts) AS rank"
            " FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid"
            " WHERE facts_fts MATCH ? " + where +
            " ORDER BY rank LIMIT ?",
            (match, *where_params, fetch)).fetchall()
    except sqlite3.Error:
        # LIKE fallback (mirrors recall.py): FTS unavailable, not fatal.
        terms = _recall.like_terms(query)
        like = " OR ".join("f.text LIKE ?" for _ in terms)
        rows = conn.execute(
            "SELECT f.id, f.text, f.kind, f.session_id, f.created_at,"
            " f.entities, f.importance, f.valid_from, f.valid_to,"
            " 0.0 AS rank FROM facts f WHERE (" + like + ") "
            + where +
            " LIMIT ?",
            *[f"%{t}%" for t in terms] + where_params + [fetch]).fetchall() \
            if terms else []
    latency_ms = round((time.perf_counter() - t0) * 1000, 2)
    # --- multi-signal re-rank (weighted RRF over BM25 rank, entity
    # overlap, importance). Rank positions are 1-based within each
    # signal; ties share a rank (dense ranking), so a tied signal adds
    # the same constant to every candidate and cannot tip the order.
    cands: list[dict] = []
    for pos, r in enumerate(rows):
        ents = json.loads(r["entities"] or "[]")
        cands.append({
            "id": int(r["id"]),
            "text": r["text"],
            "kind": r["kind"],
            "session_id": r["session_id"],
            "created_at": r["created_at"],
            "valid_from": r["valid_from"],
            "valid_to": r["valid_to"],
            "entities": ents,
            "importance": int(r["importance"]),
            "bm25_rank": round(float(r["rank"]), 3),
            "bm25_pos": pos + 1,
            "entity_overlap": _entity_overlap(query_entities, ents),
        })
    # Entity-overlap rank: more shared entities first (dense, ties share).
    entity_ranks = _dense_ranks(cands, lambda c: c["entity_overlap"])
    # Importance rank: higher importance first (dense, ties share).
    importance_ranks = _dense_ranks(cands, lambda c: c["importance"])
    for c in cands:
        c["entity_pos"] = entity_ranks[id(c)]
        c["importance_pos"] = importance_ranks[id(c)]
        # Weights: BM25 1, entity 2, importance 2. The two quality
        # signals together outweigh a modest BM25 gap; either one alone
        # outweighs a one-position BM25 gap (see test_rrf_math).
        c["fused_score"] = round(_rrf_fuse([
            (c["bm25_pos"], 1.0),
            (c["entity_pos"], 2.0),
            (c["importance_pos"], 2.0),
        ]), 6)
    # Fused order; ties break toward the better BM25 position.
    cands.sort(key=lambda c: (-c["fused_score"], c["bm25_pos"]))
    results: list[dict] = []
    total = 0
    truncated = False
    for c in cands:
        if len(results) >= limit:
            break
        tokens = estimate_tokens(c["text"])
        if results and total + tokens > budget_tokens:
            truncated = True
            break
        total += tokens
        results.append({
            "id": c["id"],
            "text": c["text"],
            "kind": c["kind"],
            "session_id": c["session_id"],
            "created_at": c["created_at"],
            "valid_from": c["valid_from"],
            "valid_to": c["valid_to"],
            "entities": c["entities"],
            "importance": c["importance"],
            "rank": c["bm25_rank"],
            "entity_overlap": c["entity_overlap"],
            "fused_score": c["fused_score"],
            "tokens": tokens,
        })
    return {
        "query": query,
        "query_entities": query_entities,
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
        "schema_version": int(
            (conn.execute("SELECT value FROM meta WHERE key='schema_version'"
                          ).fetchone() or ["?"])[0]),
        "facts_with_entities": conn.execute(
            "SELECT COUNT(*) FROM facts WHERE entities NOT IN ('[]', '', 'null')"
        ).fetchone()[0],
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

    p = sub.add_parser("search", help="multi-signal retrieval over facts")
    p.add_argument("--query", required=True)
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    p.add_argument("--budget", type=int, default=DEFAULT_BUDGET_TOKENS)
    p.add_argument("--include-superseded", action="store_true")
    p.add_argument("--as-of", default=None,
                   help="ISO date/datetime: facts valid at that moment "
                        "(time travel; implies the validity window)")

    p = sub.add_parser("backfill-entities",
                       help="populate entities for facts that have none "
                            "(migration helper; never changes text)")

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
                include_superseded=args.include_superseded,
                as_of=args.as_of), indent=2))
        elif args.cmd == "backfill-entities":
            print(json.dumps(backfill_entities(conn), indent=2))
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
