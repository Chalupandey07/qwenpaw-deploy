#!/usr/bin/env python3
"""Bounded recall over QwenPaw's history.db (read-only, token-capped).

WHY THIS EXISTS (read this before adding another memory layer)
--------------------------------------------------------------
QwenPaw v2.3.0 ALREADY ships full-text recall: `recall_history` with
`op="search"` is wired into the scroll context strategy
(`src/qwenpaw/agents/context/scroll/memoryspace.py`), backed by the
external-content FTS5 table `conversation_history_fts`
(tokenize='porter unicode61') over `conversation_history`.
Verified against upstream v2.3.0 source on 2026-11-15.

So this is NOT a second search index and NOT a replacement. What
upstream's tool budgets by ROWS and BYTES (row_cap 1000,
search_turn_max_bytes 4 MB, search_max_seconds 5 s) this CLI budgets
by TOKENS, which is the constraint that actually matters for a context
window. It also:

  * caps results hard (default 3 excerpts) and never returns a whole
    session,
  * redacts credentials at read time, so a pasted token in an old turn
    can never be replayed into a prompt,
  * runs OUTSIDE the agent loop (host CLI / cron / log-check), which
    upstream's in-process tool cannot do,
  * is deterministic and unit-testable without a live machine.

Use upstream `recall_history` for in-conversation recall. Use this CLI
when something outside the conversation needs a bounded, sanitised
look at history.

Design constraints (PLAN.md Phase 4):
  * <= 3 results, <= 2,000 tokens of memory content per call (0 when
    nothing is relevant),
  * never return the raw DB or a full session,
  * allowlist only: history.db / session JSON / memory+digest markdown,
  * tool-result rows excluded by default (they are ~65% of rows),
  * read-only: `mode=ro`, no writes, no DDL, no ATTACH of other files.

Usage:
  python3 recall.py --db /path/history.db --query "desktop lease"
  python3 recall.py --db ... --query ... --json --limit 3
  python3 recall.py --db ... --query ... --since 2026-11-01 --agent default
  python3 recall.py --db ... --check          # schema + FTS5 probe only

Exit codes: 0 ok (hits or clean zero), 1 usage/DB error, 2 no such DB.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# --------------------------------------------------------------- constants

DEFAULT_LIMIT = 3
DEFAULT_BUDGET_TOKENS = 2000
MAX_LIMIT = 10
# Hard ceiling no flag may exceed: the plan's per-turn memory budget.
ABSOLUTE_BUDGET_TOKENS = 2000
# Characters of an excerpt kept per hit (~1,096-token median in the plan
# came from ~4,000-char pages; one excerpt is deliberately far smaller).
DEFAULT_EXCERPT_CHARS = 600
# Fixed per-hit framing cost (session id, role, timestamp, separators).
PER_HIT_OVERHEAD_TOKENS = 12
# Rough token estimate. Deliberately conservative (chars/3.6, not /4) so
# the budget errs on the side of returning less.
CHARS_PER_TOKEN = 3.6

# Rows that are the agent *reading* memory, not memory content. Upstream
# keeps these out of FTS for the same reason (self-pollution feedback
# loop); duplicate the rule here so the CLI cannot surface them.
RECALL_TOOL_NAMES = ("recall_history_python", "recall_history")

TOOL_RESULT_KINDS = ("tool_result",)

# ---------------------------------------------------------------- redaction

# Every pattern is (name, compiled regex, replacement). Order matters:
# specific token shapes before generic long-secret heuristics.
_REDACTIONS: list[tuple[str, re.Pattern[str], str]] = [
    ("github_pat", re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "github_pat_[REDACTED]"),
    ("github_classic", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "gh*_[REDACTED]"),
    ("openai_sk", re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"), "sk-[REDACTED]"),
    ("anthropic", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}"), "sk-ant-[REDACTED]"),
    ("aws_akid", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AKIA[REDACTED]"),
    ("slack", re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"), "xox-[REDACTED]"),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
     "[REDACTED_JWT]"),
    ("bearer", re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{12,}"), r"\1 [REDACTED]"),
    # key=value / key: value credential assignments
    ("assignment", re.compile(
        r"(?i)\b([a-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|"
        r"private[_-]?key|access[_-]?key)[a-z0-9_]*)\s*[:=]\s*"
        r"[\"']?([^\s\"',;]{8,})"), r"\1=[REDACTED]"),
    ("long_hex", re.compile(r"\b[0-9a-fA-F]{32,}\b"), "[REDACTED_HEX]"),
]


def redact(text: str) -> tuple[str, list[str]]:
    """Strip credential-shaped substrings. Returns (text, rule names hit)."""
    hit: list[str] = []
    for name, pattern, repl in _REDACTIONS:
        new, n = pattern.subn(repl, text)
        if n:
            hit.append(name)
            text = new
    return text, hit


# -------------------------------------------------------------- db helpers

class RecallError(RuntimeError):
    """A caller-facing problem (bad schema, missing DB, budget refusal)."""


def estimate_tokens(text: str) -> int:
    """Conservative token estimate (no tokenizer dependency)."""
    if not text:
        return 0
    return max(1, math.ceil(len(text) / CHARS_PER_TOKEN))


def open_readonly(db_path: Path) -> sqlite3.Connection:
    """Open history.db strictly read-only.

    immutable=0 keeps SQLite honest about the -wal file: the DB is live and
    another process (QwenPaw) holds the writer. mode=ro guarantees this
    process can never write, which is the whole point of the allowlist.
    """
    if not db_path.is_file():
        raise RecallError(f"history db not found: {db_path}")
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    # Read-only authorizer: defence in depth if a query string is ever
    # built from untrusted input.
    conn.set_authorizer(_readonly_authorizer)
    return conn


# Statements that would change the database. Everything else is a read.
_MUTATING_ACTIONS = frozenset({
    sqlite3.SQLITE_INSERT,
    sqlite3.SQLITE_UPDATE,
    sqlite3.SQLITE_DELETE,
    sqlite3.SQLITE_DROP_TABLE,
    sqlite3.SQLITE_DROP_INDEX,
    sqlite3.SQLITE_DROP_VIEW,
    sqlite3.SQLITE_DROP_TRIGGER,
    sqlite3.SQLITE_DROP_TEMP_TABLE,
    sqlite3.SQLITE_ALTER_TABLE,
    sqlite3.SQLITE_CREATE_TABLE,
    sqlite3.SQLITE_CREATE_INDEX,
    sqlite3.SQLITE_CREATE_VIEW,
    sqlite3.SQLITE_CREATE_TRIGGER,
    sqlite3.SQLITE_CREATE_VTABLE,
    sqlite3.SQLITE_DROP_VTABLE,
    sqlite3.SQLITE_ATTACH,
    sqlite3.SQLITE_DETACH,
    sqlite3.SQLITE_REINDEX,
    sqlite3.SQLITE_ANALYZE,
})


def _readonly_authorizer(action, arg1, arg2, dbname, trigger):  # noqa: ANN001
    """Deny every real mutation; allow reads, PRAGMA and FTS5's setup.

    Subtlety worth keeping: an external-content FTS5 table reads ITS OWN
    configuration out of `sqlite_master` through a SQLITE_UPDATE code path
    when the vtab is first connected. A blanket "deny all UPDATE" blocks
    that probe, and every FTS query then fails with
    `vtable constructor failed`. So the mutation codes are denied only for
    objects other than `sqlite_master`; the connection is also opened with
    mode=ro, which is the real guarantee that nothing can be written.
    """
    del arg2, dbname, trigger
    if action in _MUTATING_ACTIONS and arg1 != "sqlite_master":
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def probe_schema(conn: sqlite3.Connection) -> dict[str, Any]:
    """Report what recall can rely on. Never mutates."""
    info: dict[str, Any] = {"fts5": False, "columns": [], "rows": None}
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        )
    }
    if "conversation_history" not in tables:
        raise RecallError(
            "conversation_history missing — not a QwenPaw scroll history db"
        )
    info["columns"] = [r[1] for r in conn.execute("PRAGMA table_info(conversation_history)")]
    for required in ("seq", "session_id", "kind", "content"):
        if required not in info["columns"]:
            raise RecallError(f"conversation_history missing column: {required}")
    info["rows"] = conn.execute("SELECT COUNT(*) FROM conversation_history").fetchone()[0]
    info["fts5"] = "conversation_history_fts" in tables
    if info["fts5"]:
        try:
            conn.execute(
                "SELECT 1 FROM conversation_history_fts LIMIT 1"
            ).fetchone()
        except sqlite3.Error:
            info["fts5"] = False
    return info


def fts_match_query(raw: str) -> str:
    """Turn a plain query into a safe FTS5 MATCH expression.

    Mirrors upstream's approach: quote each word as a phrase so punctuation
    such as `C++` or `foo-bar` cannot raise a syntax error; keep bare
    uppercase AND/OR/NOT as boolean operators.
    """
    tokens = re.findall(r"[0-9A-Za-z_]+", raw)
    rendered = [
        t if t in ("AND", "OR", "NOT") else '"' + t.replace('"', '""') + '"'
        for t in tokens
    ]
    return " ".join(rendered)


def like_terms(raw: str) -> list[str]:
    return re.findall(r"[0-9A-Za-z_]+", raw) or [raw]


# ----------------------------------------------------------------- excerpt

def excerpt(content: str, query: str, max_chars: int) -> str:
    """Take a window of `content` around the first matching term.

    Always a window, never the whole row: the plan forbids returning a full
    session, and a single tool result can be megabytes.
    """
    text = re.sub(r"\s+", " ", content or "").strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    low = text.lower()
    pos = -1
    for term in like_terms(query):
        found = low.find(term.lower())
        if found != -1 and (pos == -1 or found < pos):
            pos = found
    if pos == -1:
        return text[:max_chars].rstrip() + " …"
    half = max_chars // 2
    start = max(0, pos - half)
    end = min(len(text), start + max_chars)
    start = max(0, end - max_chars)
    lead = "… " if start > 0 else ""
    tail = " …" if end < len(text) else ""
    return f"{lead}{text[start:end].strip()}{tail}"


# ------------------------------------------------------------------- query

def recall(
    db_path: Path,
    query: str,
    *,
    limit: int = DEFAULT_LIMIT,
    budget_tokens: int = DEFAULT_BUDGET_TOKENS,
    agent: str | None = None,
    session_id: str | None = None,
    since: str | None = None,
    include_tool_results: bool = False,
    kind: str | None = None,
    excerpt_chars: int = DEFAULT_EXCERPT_CHARS,
    redact_output: bool = True,
) -> dict[str, Any]:
    """Run one bounded recall. Returns a JSON-serialisable report."""
    if limit < 1:
        raise RecallError("limit must be >= 1")
    if limit > MAX_LIMIT:
        raise RecallError(f"limit {limit} exceeds max {MAX_LIMIT}")
    if budget_tokens > ABSOLUTE_BUDGET_TOKENS:
        raise RecallError(
            f"budget_tokens {budget_tokens} exceeds the hard cap "
            f"{ABSOLUTE_BUDGET_TOKENS} (PLAN.md Phase 4)"
        )
    if not query or not query.strip():
        raise RecallError("query is required (empty query is not allowed)")

    conn = open_readonly(db_path)
    try:
        schema = probe_schema(conn)
        where: list[str] = []
        params: list[Any] = []

        if kind:
            where.append("h.kind = ?")
            params.append(kind)
        elif not include_tool_results:
            where.append(
                "h.kind NOT IN (" + ",".join("?" * len(TOOL_RESULT_KINDS)) + ")"
            )
            params.extend(TOOL_RESULT_KINDS)
        if agent:
            where.append("h.agent_id = ?")
            params.append(agent)
        if session_id:
            where.append("h.session_id = ?")
            params.append(session_id)
        if since:
            where.append("COALESCE(h.created_at, '') >= ?")
            params.append(since)

        # Exclude the agent's own recall chatter (upstream does the same).
        for name in RECALL_TOOL_NAMES:
            where.append("COALESCE(h.name, '') != ?")
            params.append(name)

        if schema["fts5"]:
            match = fts_match_query(query)
            if not match:
                raise RecallError("query has no searchable terms")
            sql = (
                "SELECT h.seq, h.session_id, h.agent_id, h.role, h.name, "
                "h.kind, h.created_at, h.content, bm25(conversation_history_fts) AS rank "
                "FROM conversation_history_fts f "
                "JOIN conversation_history h ON h.seq = f.rowid "
                "WHERE conversation_history_fts MATCH ? "
                + "".join(f"AND {w} " for w in where)
                + "ORDER BY rank LIMIT ?"
            )
            args = [match, *params, limit * 4]  # over-fetch, then trim to budget
        else:
            terms = like_terms(query)
            like_sql = " AND ".join("h.content LIKE ?" for _ in terms)
            sql = (
                "SELECT h.seq, h.session_id, h.agent_id, h.role, h.name, "
                "h.kind, h.created_at, h.content, 0.0 AS rank "
                "FROM conversation_history h "
                f"WHERE {like_sql} " + "".join(f"AND {w} " for w in where)
                + "ORDER BY h.seq DESC LIMIT ?"
            )
            args = [f"%{t}%" for t in terms] + params + [limit * 4]

        try:
            rows = conn.execute(sql, args).fetchall()
        except sqlite3.OperationalError as exc:
            # FTS grammar or a missing module: degrade to LIKE, never crash.
            if not schema["fts5"]:
                raise RecallError(f"query failed: {exc}") from exc
            terms = like_terms(query)
            like_sql = " AND ".join("h.content LIKE ?" for _ in terms)
            sql = (
                "SELECT h.seq, h.session_id, h.agent_id, h.role, h.name, "
                "h.kind, h.created_at, h.content, 0.0 AS rank "
                "FROM conversation_history h "
                f"WHERE {like_sql} " + "".join(f"AND {w} " for w in where)
                + "ORDER BY h.seq DESC LIMIT ?"
            )
            args = [f"%{t}%" for t in terms] + params + [limit * 4]
            rows = conn.execute(sql, args).fetchall()
            schema["fts5_fallback_used"] = True

        hits: list[dict[str, Any]] = []
        used = 0
        redaction_hits: set[str] = set()
        truncated_by_budget = False

        for row in rows:
            if len(hits) >= limit:
                break
            raw = row["content"] or ""
            if redact_output:
                safe, rules = redact(raw)
                redaction_hits.update(rules)
            else:
                safe = raw
            ext = excerpt(safe, query, excerpt_chars)
            if not ext:
                continue
            cost = estimate_tokens(ext) + PER_HIT_OVERHEAD_TOKENS
            if used + cost > budget_tokens:
                # First hit that does not fit ends the run: a partial
                # excerpt is worse than an honest smaller answer.
                truncated_by_budget = True
                break
            used += cost
            hits.append({
                "seq": row["seq"],
                "session_id": row["session_id"],
                "session_short": (row["session_id"] or "")[:8],
                "agent_id": row["agent_id"],
                "role": row["role"],
                "kind": row["kind"],
                "created_at": row["created_at"],
                "tokens": cost,
                "excerpt": ext,
            })

        return {
            "query": query,
            "db": str(db_path),
            "schema": schema,
            "hits": hits,
            "count": len(hits),
            "total_tokens": used,
            "budget_tokens": budget_tokens,
            "limit": limit,
            "truncated_by_budget": truncated_by_budget,
            "candidate_rows": len(rows),
            "redactions_applied": sorted(redaction_hits),
            "tool_results_included": include_tool_results or bool(kind),
        }
    finally:
        conn.close()


# -------------------------------------------------------------------- main

def render_text(report: dict[str, Any]) -> str:
    lines = [
        f"recall: {report['query']!r}  "
        f"({report['count']} hit(s), {report['total_tokens']}/"
        f"{report['budget_tokens']} tokens)"
    ]
    if not report["hits"]:
        lines.append("  (no relevant history — returning nothing is correct)")
    for i, hit in enumerate(report["hits"], 1):
        when = (hit["created_at"] or "?")[:19]
        lines.append(
            f"  [{i}] {when}  {hit['kind']}/{hit['role'] or '-'}  "
            f"session {hit['session_short']}  ~{hit['tokens']} tok"
        )
        for chunk in _wrap(hit["excerpt"], 96):
            lines.append(f"      {chunk}")
    if report["redactions_applied"]:
        lines.append(
            "  redacted: " + ", ".join(report["redactions_applied"])
        )
    if report["truncated_by_budget"]:
        lines.append("  (stopped at the token budget — narrow the query)")
    return "\n".join(lines)


def _wrap(text: str, width: int) -> list[str]:
    words, out, line = text.split(" "), [], ""
    for word in words:
        if len(line) + len(word) + 1 > width and line:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        out.append(line)
    return out or [""]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", required=True, help="path to history.db (read-only)")
    ap.add_argument("--query", default="", help="keywords; OR supported")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    ap.add_argument("--budget-tokens", type=int, default=DEFAULT_BUDGET_TOKENS)
    ap.add_argument("--excerpt-chars", type=int, default=DEFAULT_EXCERPT_CHARS)
    ap.add_argument("--agent", default=None)
    ap.add_argument("--session", default=None)
    ap.add_argument("--since", default=None, help="ISO date/time lower bound")
    ap.add_argument("--kind", default=None, help="exact kind filter")
    ap.add_argument("--include-tool-results", action="store_true")
    ap.add_argument("--no-redact", action="store_true", help="only for tests")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true", help="schema probe only")
    args = ap.parse_args(argv)

    db_path = Path(os.path.expanduser(args.db))
    try:
        if args.check:
            conn = open_readonly(db_path)
            try:
                info = probe_schema(conn)
            finally:
                conn.close()
            print(json.dumps(info, indent=2))
            return 0
        if not args.query:
            print("error: --query is required (or pass --check)", file=sys.stderr)
            return 1
        report = recall(
            db_path,
            args.query,
            limit=args.limit,
            budget_tokens=args.budget_tokens,
            agent=args.agent,
            session_id=args.session,
            since=args.since,
            include_tool_results=args.include_tool_results,
            kind=args.kind,
            excerpt_chars=args.excerpt_chars,
            redact_output=not args.no_redact,
        )
    except RecallError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2 if "not found" in str(exc) else 1
    except sqlite3.Error as exc:
        print(f"sqlite error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(report, indent=2, default=str) if args.json else render_text(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
