#!/usr/bin/env python3
"""durable_write.py — ask-before-durable-write for memory v2 fact writes.

Gap #20 from the 2026-11-18 all-20 evaluation (provisional T133).
The consent gate already exists for the lessons ledger
(features/memory/lessons.py: the agent may only `propose` unattended;
a durable write needs explicit `accept --id --why "user confirmed"`).
It did NOT exist for memory v2 fact writes — facts.py auto-adds, no
gate. This module applies the same gate to fact writes, HIGH-STAKES
FACTS ONLY. Routine facts write silently with provenance. It does NOT
ask every time.

WHAT IS GATED (rule-based, stdlib only — see classify_high_stakes):
  * kind == "preference" (a durable preference, by kind);
  * preference phrasing ("I prefer ...", "User likes ...", "Respond in
    metric units", "Use X at maximum ...") even when kind is "fact";
  * identity ("My name is ...", "Call me ...", "I work at ...",
    "My timezone is ...", contact handles, email addresses, PII such
    as salary / social security number / a drug dose);
  * credentials-adjacent mentions WITHOUT a secret value ("My API key
    is stored in the vault", "We rotate tokens monthly") — a real
    secret value is still REJECTED outright, never held, never written;
  * durable-preference language ("from now on", "going forward",
    "default to", "Always use ...", "I always use ...");
  * identity-field contradictions with existing memory ("My name is
    Sam" when memory says "My name is Rohan").

WHAT IS NOT GATED (deliberately — DeepSeek review 2026-11-18):
  * measurements and plain observations ("The gate is 30", "The build
    takes 5 minutes", "The loop gate stopped at 100 calls");
  * ordinary updates of the same subject ("The gate is 30" -> "The gate
    is 20", "The loop gate is broken") — a general contradiction
    detector false-positives on exactly these, which are the textbook
    routine fact. General contradiction detection stays with the agent
    (and supersede_fact is the explicit correction path); the gate
    holds only identity-field contradictions, where a change is
    unambiguous and worth confirming;
  * lookalikes: "I am running the migration" (I am + verb-ing),
    "The linter says never use var" (a quoted rule), "Tests always
    use a temp dir" (third-party subject), "Alice prefers dark mode"
    (third-party preference), "The API key rotation job runs nightly"
    ("rotation" as a noun), "The token bucket is 100" (token as a
    metric noun).

REUSED FROM lessons.py (no new consent mechanism):
  * propose / accept --id --why / reject --id --why / list / check;
  * MAX_PENDING = 3 (== lessons MAX_CANDIDATES); MAX_FIELD_CHARS = 400
    (== lessons MAX_FIELD_CHARS); ids PF-001, allocated from an
    AUTOINCREMENT sequence and never reused; --why is required and
    non-empty for accept/reject; secrets are rejected, not scrubbed.
  * NOT reused (they do not transfer): MAX_ACCEPTED = 10 (facts are
    unbounded add-only), MAX_BLOCK_WORDS = 800 (a fact is one line),
    Evidence / Revisit / Scope fields (facts carry kind, importance,
    source — provenance is the evidence analogue).

STORE: a `pending_facts` table inside the SAME memory.db (created by
ensure_schema, never by facts.py). Same-DB placement makes accept
crash-safe: the fact is written first, then the pending row is marked
accepted; a crash between the two is reconciled by retry, because
add_fact's content-hash dedup returns the same fact id. The table is
invisible to facts.py (its queries read FROM facts; the v1->v2
migration only touches facts/handoffs/meta) and pending text is never
indexed into facts_fts, so a held or rejected fact is never
searchable. facts.py is UNTOUCHED — this module wraps facts.add_fact;
the agent calls `durable_write.py add-gated` instead of `facts.py add`
for gated writes. The pending table lives in the DB on the machine, so
this file must travel with facts.py + recall.py when synced (see
README.md machine-sync table).

Usage:
  durable_write.py --db memory.db add-gated --text "..." --kind fact
  durable_write.py --db memory.db propose --text "..." --kind preference
  durable_write.py --db memory.db list
  durable_write.py --db memory.db accept --id PF-001 --why "user confirmed"
  durable_write.py --db memory.db reject --id PF-002 --why "not confirmed"
  durable_write.py --db memory.db check
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
try:
    import facts as _facts
except ImportError:  # repo layout: facts.py lives in the parent dir
    sys.path.insert(0, str(HERE.parent))
    import facts as _facts

# Reused from lessons.py (see module docstring for what does NOT transfer).
MAX_PENDING = 3
MAX_FIELD_CHARS = 400
PENDING_STATES = ("pending", "accepted", "rejected")

_PENDING_SCHEMA = """
CREATE TABLE IF NOT EXISTS pending_facts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    entities TEXT NOT NULL DEFAULT '[]',
    session_id TEXT,
    source TEXT,
    importance INTEGER NOT NULL DEFAULT 2,
    reasons TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'pending',
    proposed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    reviewed_why TEXT,
    fact_id INTEGER
);
"""

# ------------------------------------------------------- high-stakes classifier
# A data-driven table: (reason label, pattern). classify_high_stakes
# returns every matching label. The patterns are deliberately anchored
# so routine lookalikes stay routine — see the golden table in
# test_durable_write.py, which locks each of these in both directions.

# Identity: the user naming themself, where they are, how to reach them.
_IDENTITY_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("identity: my name is",
     re.compile(r"\b(my name is|call me|i go by|my (first|last|full) name"
                r"|middle name|birthday is|my birthday)\b", re.I)),
    ("identity: whereabouts / work",
     re.compile(r"\b(i live in|i'?m based in|i am based in|i work at"
                r"|my (timezone|email|phone|address|username))\b", re.I)),
    ("identity: contact",
     re.compile(r"\b(contact me at|reach me on|github\s*:\s*@)\b", re.I)),
    ("identity: email address",
     re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("identity: personal data",
     re.compile(r"\bmy (salary|ssn|social security number)\b"
                r"|\b(i am|i'?m) allergic to\b"
                r"|\bi take \d+\s*mg\b", re.I)),
]

# Credentials-adjacent: a credential noun tied to a location / ownership
# verb — WITHOUT a secret value (a value trips contains_secret and the
# whole write is rejected, never held). Bare singular "key" is NOT a
# noun here: "the key insight is in the report" must stay routine.
_CRED_NOUNS = (r"api keys?|ssh keys?|private keys?|keys|tokens?|passwords?"
               r"|secrets?|credentials?")
_CRED_LOCATION = r"stored in|kept in|lives? in|is in|manager is|rotat(e|es|ed)"
_CREDENTIAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("credentials-adjacent: credential location",
     re.compile(r"\b(" + _CRED_NOUNS + r")\b[^.;]{0,60}\b(" + _CRED_LOCATION + r")\b",
                re.I)),
    ("credentials-adjacent: credential action",
     re.compile(r"\b(rotat(e|es|ed)|stored|kept)\b[^.;]{0,40}\b("
                + _CRED_NOUNS + r")\b", re.I)),
    ("credentials-adjacent: password manager",
     re.compile(r"\b(1password|bitwarden|lastpass|keepass|password manager)\b",
                re.I)),
]

# Preference phrasing: the words that mark a durable preference even
# when kind is "fact". Anchored on a first-person/user subject or on
# sentence-initial position, so third-party and quoted rules stay
# routine ("Alice prefers dark mode", "The linter says never use var").
_PREFERENCE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("preference phrasing: prefer / like / want",
     re.compile(r"(?:^|[.!?]\s+)(prefer|prefers|like|likes|want|wants"
                r"|don't use|do not use)\b"
                r"|\b(i|my|we|user)\b[^.;]{0,40}\b(prefer|prefers|like|likes"
                r"|want|wants)\b", re.I)),
    ("preference phrasing: how to answer",
     re.compile(r"(?:^|[.!?]\s+)(respond|reply|answer|output)\b", re.I)),
    ("preference phrasing: use at maximum",
     re.compile(r"\buse\b[^.;]{0,40}\bat\s+(max|maximum)\b", re.I)),
]

# Durable-preference language: words that mark an instruction as
# standing, not one-off. E2/E3 need the always/never/only qualifier so
# "Tests always use a temp dir" (third-party subject) stays routine.
_DURABLE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("durable language: standing instruction",
     re.compile(r"\b(from now on|going forward|default to|my default is)\b",
                re.I)),
    ("durable language: always / never / only",
     re.compile(r"(?:^|[.!?]\s+)(always|never|only)\s+"
                r"(use|respond|mention|output|reply|write)\b"
                r"|\b(i|my|we|user)\b[^.;]{0,50}\b(always|never|only)\b",
                re.I)),
]

# Identity subjects whose value changing is unambiguous and worth
# confirming. Anything else ("the gate is 30" -> "the gate is 20") is
# a routine update, not a contradiction worth asking about.
_IDENTITY_SUBJECT_RE = re.compile(
    r"^\s*my\s+(name|email|username|timezone|address|phone)\s+(is|are)\s+(.+)$",
    re.I)


class GateError(RuntimeError):
    """A gated write was refused (held, capped, bad input, bad state)."""


def _pending_id(seq: int) -> str:
    return f"PF-{seq:03d}"


def parse_pending_id(pending_id: str) -> int:
    """PF-001 -> 1. Raises GateError on a malformed id."""
    match = re.fullmatch(r"PF-(\d+)", (pending_id or "").strip())
    if not match:
        raise GateError(
            f"malformed pending id {pending_id!r} — expected PF-001 style")
    return int(match.group(1))


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the pending_facts table if missing. Never touches meta."""
    conn.execute(_PENDING_SCHEMA)
    conn.commit()


def _norm(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower()).strip(" .")


def _identity_subject_value(text: str) -> tuple[str, str] | None:
    """(subject, value) for 'My <field> is <value>' — else None.

    Only the first sentence is read: a fact is one line, and a later
    sentence ("... and the gate is 30") is a different claim.
    """
    first = re.split(r"[.!?]\s+", (text or "").strip(), maxsplit=1)[0]
    match = _IDENTITY_SUBJECT_RE.match(first)
    if not match:
        return None
    return (match.group(1).lower(), _norm(match.group(3)))


def _contradiction_reason(conn: sqlite3.Connection, text: str) -> str | None:
    """A reason string if text contradicts an existing identity fact.

    Same identity subject, different value, in a live (non-superseded)
    fact. Returns None when there is no such fact — including when no
    connection is available (classify without a store cannot check).
    """
    parsed = _identity_subject_value(text)
    if parsed is None:
        return None
    subject, value = parsed
    if not value:
        return None
    rows = conn.execute(
        "SELECT id, text FROM facts WHERE superseded_by IS NULL").fetchall()
    for row in rows:
        # Index access, not row["text"]: callers may pass a raw connection
        # with no row_factory (e.g. a hand-built v1 DB in the tests).
        other = _identity_subject_value(row[1])
        if other is None:
            continue
        if other[0] == subject and other[1] and other[1] != value:
            return (f"contradicts existing fact #{row[0]} "
                    f"(my {subject} was {other[1]!r})")
    return None


def classify_high_stakes(text: str, kind: str = "fact",
                         conn: sqlite3.Connection | None = None
                         ) -> tuple[bool, list[str]]:
    """Is this fact high-stakes (must be held for confirmation)?

    Returns (held, reasons). kind == "preference" always holds: a
    durable preference is high-stakes by kind. Everything else is
    decided by phrasing (see the pattern tables above) plus, when a
    connection is given, identity-field contradiction with existing
    memory. A fact matching nothing is routine.
    """
    text = text or ""
    reasons: list[str] = []
    if kind == "preference":
        reasons.append("kind=preference (durable preference)")
    for label, pattern in (
            _IDENTITY_PATTERNS + _CREDENTIAL_PATTERNS
            + _PREFERENCE_PATTERNS + _DURABLE_PATTERNS):
        if pattern.search(text):
            reasons.append(label)
    if conn is not None:
        contra = _contradiction_reason(conn, text)
        if contra is not None:
            reasons.append(contra)
    return (len(reasons) > 0, reasons)


def _validate(text: str, kind: str, importance: int) -> str:
    text = (text or "").strip()
    if not text:
        raise GateError("fact text is required (empty fact is not allowed)")
    if len(text) > MAX_FIELD_CHARS:
        raise GateError(
            f"fact text is {len(text)} chars (cap {MAX_FIELD_CHARS}, "
            "reused from lessons MAX_FIELD_CHARS)")
    if kind not in _facts.KINDS:
        raise GateError(f"kind must be one of {', '.join(_facts.KINDS)}")
    if importance not in (1, 2, 3):
        raise GateError("importance must be 1, 2, or 3")
    return text


def _check_secret(text: str) -> None:
    """Secrets are rejected, not scrubbed — and never held either."""
    hits = _facts.contains_secret(text)
    if hits:
        raise GateError(
            f"fact rejected: it contains a credential pattern "
            f"({', '.join(hits)}). Secrets are rejected, not scrubbed — "
            f"remove the value and retry.")


# ------------------------------------------------------------ pending store

def propose(conn: sqlite3.Connection, text: str, kind: str = "fact",
            entities: list[str] | None = None,
            session_id: str | None = None, source: str | None = None,
            importance: int = 2,
            reasons: list[str] | None = None) -> str:
    """Hold a fact in the pending store (mirrors lessons propose).

    The ONLY thing the agent may do unattended with a high-stakes fact.
    Refuses loudly when 3 facts are already pending (cap reused from
    lessons MAX_CANDIDATES), when the text trips the secret check, or
    when the input is invalid. Never writes to facts. Returns the PF id.
    """
    text = _validate(text, kind, importance)
    _check_secret(text)  # before any insert: no secret bytes at rest
    ensure_schema(conn)
    pending = conn.execute(
        "SELECT COUNT(*) FROM pending_facts WHERE state='pending'"
    ).fetchone()[0]
    if pending >= MAX_PENDING:
        rows = conn.execute(
            "SELECT seq FROM pending_facts WHERE state='pending' ORDER BY seq"
        ).fetchall()
        held_ids = ", ".join(_pending_id(r["seq"]) for r in rows)
        raise GateError(
            f"pending full: {pending} facts already pending "
            f"(cap {MAX_PENDING}: {held_ids}) — accept or reject one first. "
            f"The new fact was NOT stored anywhere and was NOT auto-committed.")
    if reasons is None:
        _, reasons = classify_high_stakes(text, kind, conn=conn)
    if not reasons:
        reasons = ["explicit propose"]
    if not entities:
        entities = _facts.extract_entities(text)
    cur = conn.execute(
        "INSERT INTO pending_facts (text, kind, entities, session_id,"
        " source, importance, reasons) VALUES (?,?,?,?,?,?,?)",
        (text, kind, json.dumps(entities or []), session_id, source,
         importance, json.dumps(reasons)))
    conn.commit()
    return _pending_id(int(cur.lastrowid))


def _routine_source(source: str | None) -> str:
    base = "gated:routine"
    return f"{base};{source}" if source else base


def gated_add(conn: sqlite3.Connection, text: str, kind: str = "fact",
              entities: list[str] | None = None,
              session_id: str | None = None, source: str | None = None,
              importance: int = 2) -> dict:
    """The single gated entry point (replaces facts.py add for the agent).

    High-stakes -> held in the pending store, NO row in facts.
    Routine -> facts.add_fact with provenance "gated:routine[;<source>]".
    A fact already stored (content-hash dedup) is returned as a
    duplicate, never held: asking about something already durable is
    noise. A secret is rejected, never held, never written. When the
    pending store is full a high-stakes fact is refused loudly — it
    NEVER falls back to a routine write, which would defeat the gate.
    """
    text = _validate(text, kind, importance)
    _check_secret(text)
    ensure_schema(conn)
    digest = _facts._fact_hash(text)
    row = conn.execute(
        "SELECT id FROM facts WHERE hash=?", (digest,)).fetchone()
    if row is not None:
        return {"held": False, "fact_id": int(row["id"]), "duplicate": True,
                "source": _routine_source(source)}
    held, reasons = classify_high_stakes(text, kind, conn=conn)
    if held:
        pid = propose(conn, text, kind=kind, entities=entities,
                      session_id=session_id, source=source,
                      importance=importance, reasons=reasons)
        return {"held": True, "pending_id": pid, "reasons": reasons}
    fid = _facts.add_fact(conn, text, kind=kind, entities=entities,
                          session_id=session_id,
                          source=_routine_source(source),
                          importance=importance)
    return {"held": False, "fact_id": fid, "source": _routine_source(source)}


def _load_pending(conn: sqlite3.Connection, seq: int) -> sqlite3.Row:
    ensure_schema(conn)
    row = conn.execute(
        "SELECT * FROM pending_facts WHERE seq=?", (seq,)).fetchone()
    if row is None:
        raise GateError(f"no such pending fact: {_pending_id(seq)}")
    return row


def _require_why(why: str | None) -> str:
    why = (why or "").strip()
    if not why:
        raise GateError("--why is required for a durable state change")
    if len(why) > MAX_FIELD_CHARS:
        raise GateError(
            f"--why is {len(why)} chars (cap {MAX_FIELD_CHARS})")
    return why


def accept(conn: sqlite3.Connection, pending_id: str, why: str) -> int:
    """Flush a held fact into memory v2 (mirrors lessons accept).

    Requires non-empty --why. Writes the fact FIRST (via add_fact, so
    content-hash dedup makes a retry safe), then marks the pending row
    accepted with the fact id and the reason. A crash between the two
    leaves an unmarked fact that a re-accept reconciles to the same id
    — no fact is ever lost, and no fact is ever written twice. The
    stored text is secret-checked again before the flush (defense in
    depth). Accept of a non-pending row is refused.
    """
    why = _require_why(why)
    seq = parse_pending_id(pending_id)
    row = _load_pending(conn, seq)
    if row["state"] != "pending":
        raise GateError(
            f"{_pending_id(seq)} is {row['state']}, not pending")
    _check_secret(row["text"])
    fid = _facts.add_fact(
        conn, row["text"], kind=row["kind"],
        entities=json.loads(row["entities"] or "[]"),
        session_id=row["session_id"],
        source=f"pending:{_pending_id(seq)}; accepted: {why}",
        importance=int(row["importance"]))
    conn.execute(
        "UPDATE pending_facts SET state='accepted', reviewed_why=?,"
        " fact_id=? WHERE seq=?",
        (why, fid, seq))
    conn.commit()
    return fid


def reject(conn: sqlite3.Connection, pending_id: str, why: str) -> None:
    """Refuse a held fact (mirrors lessons reject). It NEVER lands.

    Requires non-empty --why. The row stays as an audit record
    (add-only: rejected text is kept, but never indexed into facts_fts
    and never searchable). Reject of a non-pending row is refused.
    """
    why = _require_why(why)
    seq = parse_pending_id(pending_id)
    row = _load_pending(conn, seq)
    if row["state"] != "pending":
        raise GateError(
            f"{_pending_id(seq)} is {row['state']}, not pending")
    conn.execute(
        "UPDATE pending_facts SET state='rejected', reviewed_why=?"
        " WHERE seq=?",
        (why, seq))
    conn.commit()


def list_pending(conn: sqlite3.Connection,
                 state: str | None = None) -> list[dict]:
    """All pending-fact rows (or one state), oldest first."""
    ensure_schema(conn)
    if state is not None:
        if state not in PENDING_STATES:
            raise GateError(
                f"state must be one of {', '.join(PENDING_STATES)}")
        rows = conn.execute(
            "SELECT * FROM pending_facts WHERE state=? ORDER BY seq",
            (state,)).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM pending_facts ORDER BY seq").fetchall()
    out: list[dict] = []
    for r in rows:
        out.append({
            "id": _pending_id(int(r["seq"])),
            "text": r["text"],
            "kind": r["kind"],
            "entities": json.loads(r["entities"] or "[]"),
            "session_id": r["session_id"],
            "source": r["source"],
            "importance": int(r["importance"]),
            "reasons": json.loads(r["reasons"] or "[]"),
            "state": r["state"],
            "proposed_at": r["proposed_at"],
            "reviewed_why": r["reviewed_why"],
            "fact_id": r["fact_id"],
        })
    return out


def check(conn: sqlite3.Connection) -> list[str]:
    """Validate the pending store. Empty list means it is valid."""
    ensure_schema(conn)
    problems: list[str] = []
    rows = list_pending(conn)
    pending = [r for r in rows if r["state"] == "pending"]
    if len(pending) > MAX_PENDING:
        problems.append(
            f"{len(pending)} pending facts exceeds the cap of {MAX_PENDING}")
    for r in rows:
        if not r["text"]:
            problems.append(f"{r['id']}: empty text")
        elif len(r["text"]) > MAX_FIELD_CHARS:
            problems.append(
                f"{r['id']}: text is {len(r['text'])} chars "
                f"(cap {MAX_FIELD_CHARS})")
        if r["kind"] not in _facts.KINDS:
            problems.append(f"{r['id']}: bad kind {r['kind']!r}")
        if r["state"] not in PENDING_STATES:
            problems.append(f"{r['id']}: bad state {r['state']!r}")
        hits = _facts.contains_secret(r["text"])
        if hits:
            problems.append(
                f"{r['id']}: text looks like it contains a secret "
                f"({', '.join(hits)}) — rejected, not scrubbed")
        if r["state"] == "accepted":
            if r["fact_id"] is None:
                problems.append(f"{r['id']}: accepted but has no fact_id")
            elif conn.execute(
                    "SELECT COUNT(*) FROM facts WHERE id=?",
                    (r["fact_id"],)).fetchone()[0] == 0:
                problems.append(
                    f"{r['id']}: accepted but fact #{r['fact_id']} is missing")
    return problems


# ------------------------------------------------------------ CLI (mirrors lessons.py)

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="durable_write.py",
        description="Ask-before-durable-write gate for memory v2 fact writes.")
    ap.add_argument("--db", default="memory.db",
                    help="path to memory.db (default: ./memory.db)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("add-gated",
                       help="gated add: hold high-stakes facts, write routine ones")
    p.add_argument("--text", required=True)
    p.add_argument("--kind", default="fact", choices=list(_facts.KINDS))
    p.add_argument("--entities", default="")
    p.add_argument("--session")
    p.add_argument("--source")
    p.add_argument("--importance", type=int, default=2)

    p = sub.add_parser("propose", help="hold a fact for confirmation (not durable)")
    p.add_argument("--text", required=True)
    p.add_argument("--kind", default="fact", choices=list(_facts.KINDS))
    p.add_argument("--entities", default="")
    p.add_argument("--session")
    p.add_argument("--source")
    p.add_argument("--importance", type=int, default=2)

    p = sub.add_parser("list", help="show pending facts and validation state")
    p.add_argument("--json", action="store_true")
    p.add_argument("--state", default=None, choices=list(PENDING_STATES))

    for name in ("accept", "reject"):
        p = sub.add_parser(name, help=f"move a pending fact to {name}ed")
        p.add_argument("--id", required=True)
        p.add_argument("--why", required=True)

    sub.add_parser("check", help="validate only")

    args = ap.parse_args(argv)
    try:
        conn = _facts.open_db(args.db)
    except sqlite3.Error as exc:
        print(json.dumps({"error": f"cannot open {args.db}: {exc}"}))
        return 2
    try:
        if args.cmd == "add-gated":
            res = gated_add(
                conn, args.text, kind=args.kind,
                entities=[e.strip() for e in args.entities.split(",") if e.strip()],
                session_id=args.session, source=args.source,
                importance=args.importance)
            print(json.dumps(res))
            return 0
        if args.cmd == "propose":
            pid = propose(
                conn, args.text, kind=args.kind,
                entities=[e.strip() for e in args.entities.split(",") if e.strip()],
                session_id=args.session, source=args.source,
                importance=args.importance)
            print(f"proposed {pid} (pending) — accept it with:")
            print(f"  python3 durable_write.py --db {args.db} accept --id {pid} "
                  f"--why \"...\"")
            return 0
        if args.cmd == "list":
            rows = list_pending(conn, state=args.state)
            if args.json:
                print(json.dumps(rows, indent=2))
                return 0
            n_pending = sum(1 for r in rows if r["state"] == "pending")
            print(f"{n_pending} pending / {MAX_PENDING} · {len(rows)} total")
            for r in rows:
                marker = {"pending": "?", "accepted": "✓",
                          "rejected": "✗"}.get(r["state"], " ")
                print(f"  {marker} {r['id']} [{r['kind']}] {r['text'][:70]}")
            problems = check(conn)
            if problems:
                print("\nproblems:")
                for problem in problems:
                    print(f"  - {problem}")
                return 1
            return 0
        if args.cmd in ("accept", "reject"):
            if args.cmd == "accept":
                fid = accept(conn, args.id, args.why)
                print(f"{args.id} -> accepted (fact #{fid})")
            else:
                reject(conn, args.id, args.why)
                print(f"{args.id} -> rejected")
            return 0
        if args.cmd == "check":
            problems = check(conn)
            if not problems:
                print(f"OK: {len(list_pending(conn))} pending-fact rows, store valid")
                return 0
            for problem in problems:
                print(f"  - {problem}")
            return 1
    except GateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except sqlite3.Error as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
