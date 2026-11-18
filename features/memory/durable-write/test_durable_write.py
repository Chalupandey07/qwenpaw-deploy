#!/usr/bin/env python3
"""Tests for ask-before-durable-write (provisional T133).

Gap #20 from the 2026-11-18 all-20 evaluation: the consent gate that
already exists for the lessons ledger (features/memory/lessons.py:
propose unattended, durable write only via explicit accept --id --why)
did NOT exist for memory v2 fact writes (facts.py auto-adds, no gate).
This feature applies the same gate to fact writes, HIGH-STAKES FACTS
ONLY: identity, credentials-adjacent, durable preferences, and
identity-field contradictions with existing memory. Routine facts
write silently with provenance. Do NOT ask every time.

Run: python3 features/memory/durable-write/test_durable_write.py
Exit 0 = all pass. Prints "N passed, M failed" as the last line.

Fail-first: on the pristine code (no durable_write.py) this file fails
at import. The gate is a wrapper around facts.add_fact; facts.py itself
is untouched, so T117/T118 keep passing unchanged.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MEMORY_DIR = HERE.parent

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(MEMORY_DIR))
import durable_write as D  # noqa: E402
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


def fresh_db() -> tuple[sqlite3.Connection, Path]:
    tmp = Path(tempfile.mkdtemp())
    path = tmp / "memory.db"
    conn = F.open_db(path)
    return conn, path


def fact_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]


def pending_count(conn: sqlite3.Connection, state: str = "pending") -> int:
    D.ensure_schema(conn)
    return conn.execute(
        "SELECT COUNT(*) FROM pending_facts WHERE state=?", (state,)
    ).fetchone()[0]


def search_texts(conn: sqlite3.Connection, query: str) -> list[str]:
    return [r["text"] for r in F.search_facts(conn, query, limit=10)["results"]]


# ------------------------------------------------------- classifier golden table
# (text, kind, expected_held, why) — DeepSeek-reviewed 2026-11-18.
# Bias: HOLD on identity / credentials-adjacent / durable language;
# ROUTINE on measurements and "the <noun> is <number>".

GOLDEN: list[tuple[str, str, bool, str]] = [
    # --- hold: kind itself (durable preference) ---
    ("DeepSeek is the coding model.", "preference", True, "kind=preference"),
    # --- hold: preference phrasing (kind=fact must not save it) ---
    ("I prefer DeepSeek for coding work.", "fact", True, "first-person prefer"),
    ("Prefers dark mode.", "fact", True, "sentence-initial prefer"),
    ("User likes terse answers.", "fact", True, "user + likes"),
    ("Respond in metric units.", "fact", True, "imperative respond"),
    ("Don't use emojis.", "fact", True, "sentence-initial don't use"),
    ("Use DeepSeek at maximum context.", "fact", True, "use ... at maximum"),
    # --- hold: identity ---
    ("Call me Sam.", "fact", True, "call me"),
    ("I go by Sam.", "fact", True, "go by"),
    ("I'm based in Berlin.", "fact", True, "based in"),
    ("I work at Acme.", "fact", True, "work at"),
    ("My timezone is CET.", "fact", True, "my timezone"),
    ("My birthday is March 3.", "fact", True, "my birthday"),
    ("Birthday is March 3.", "fact", True, "birthday is"),
    ("I'm allergic to peanuts.", "fact", True, "allergic to"),
    ("My name is Rohan.", "fact", True, "my name is"),
    ("I don't have a middle name.", "fact", True, "middle name"),
    ("GitHub: @sam.", "fact", True, "contact handle"),
    ("Contact me at sam@example.com.", "fact", True, "contact + email"),
    ("My salary is on file with HR.", "fact", True, "PII salary"),
    ("My social security number is on file with HR.", "fact", True, "PII SSN"),
    ("I take 10mg of allergy medicine daily.", "fact", True, "health dose"),
    # --- hold: credentials-adjacent (no secret VALUE present) ---
    ("My API key is stored in the vault.", "fact", True, "key stored in vault"),
    ("Staging DB password is in Vault under team/staging.", "fact", True, "password is in"),
    ("We rotate tokens monthly.", "fact", True, "rotate tokens"),
    ("I use 1Password.", "fact", True, "password manager named"),
    ("My keys live in ~/.ssh.", "fact", True, "keys live in"),
    # --- hold: durable-preference language ---
    ("From now on, use DeepSeek.", "fact", True, "from now on"),
    ("Going forward, respond in English.", "fact", True, "going forward"),
    ("Default to metric units.", "fact", True, "default to"),
    ("Always use DeepSeek.", "fact", True, "sentence-initial always use"),
    ("Never mention the old project.", "fact", True, "sentence-initial never"),
    ("I always use DeepSeek for coding.", "fact", True, "I always use"),
    # --- routine: measurements and plain observations ---
    ("The loop gate stopped at 100 calls in the live test.", "fact", False, "measurement"),
    ("The gate is 30.", "fact", False, "the noun is number"),
    ("The build takes 5 minutes.", "fact", False, "measurement"),
    ("The version is 1.2.", "fact", False, "version number"),
    ("The loop gate fix is the priority.", "decision", False, "plain decision"),
    ("I will build the derived image from the pinned digest.", "task", False, "plain task"),
    # --- routine: lookalikes that must NOT be held ---
    ("I am running the migration.", "fact", False, "I am + verb-ing, not identity"),
    ("I am seeing a flaky test.", "fact", False, "I am + verb-ing"),
    ("The linter says never use var.", "fact", False, "quoted rule, not user pref"),
    ("Tests always use a temp dir.", "fact", False, "third-party subject + always"),
    ("The API key rotation job runs nightly.", "fact", False, "rotation noun, not verb"),
    ("Alice prefers dark mode.", "fact", False, "third-party preference"),
    ("The token bucket is 100.", "fact", False, "token as metric noun"),
    ("The TinyFish key has to be entered by the user in the vault.", "fact", False,
     "ops fact about key entry, not ownership/location of a credential"),
    ("DeepSeek is the coding model.", "fact", False,
     "bare 'X is the Y' with kind=fact is routine; kind=preference is the signal"),
]


def test_classifier_golden() -> None:
    print("classifier golden table")
    for text, kind, expected, why in GOLDEN:
        held, reasons = D.classify_high_stakes(text, kind)
        check(f"classify [{'HOLD' if expected else 'routine'}] {why}: {text[:44]!r}",
              held is expected,
              f"got held={held} reasons={reasons}")


# ------------------------------------------------------------ gated add / accept

def test_gated_add_holds_high_stakes() -> None:
    print("gated_add holds high-stakes facts")
    conn, _ = fresh_db()
    res = D.gated_add(conn, "My name is Rohan.", kind="fact", session_id="sess-a")
    check("high-stakes gated_add reports held=True", res["held"] is True, str(res))
    check("high-stakes gated_add returns a PF id",
          str(res.get("pending_id", "")).startswith("PF-"), str(res))
    check("high-stakes gated_add names a reason", bool(res.get("reasons")), str(res))
    check("held fact writes NO row to facts", fact_count(conn) == 0,
          f"facts={fact_count(conn)}")
    check("held fact is NOT searchable",
          "My name is Rohan." not in search_texts(conn, "Rohan"), "")
    check("held fact sits in the pending store", pending_count(conn) == 1, "")


def test_accept_flushes() -> None:
    print("accept flushes into memory v2")
    conn, _ = fresh_db()
    res = D.gated_add(conn, "I prefer DeepSeek for coding.", kind="fact",
                      session_id="sess-a")
    pid = res["pending_id"]
    fid = D.accept(conn, pid, "user confirmed")
    check("accept returns a fact id", isinstance(fid, int) and fid > 0, str(fid))
    check("accepted fact is searchable",
          any("DeepSeek" in t for t in search_texts(conn, "DeepSeek")), "")
    row = conn.execute("SELECT source FROM facts WHERE id=?", (fid,)).fetchone()
    check("accepted fact carries provenance (pending id + why)",
          row is not None and pid in row["source"] and "user confirmed" in row["source"],
          str(dict(row)) if row else "")
    prow = conn.execute(
        "SELECT state, fact_id, reviewed_why FROM pending_facts WHERE seq=?",
        (D.parse_pending_id(pid),)).fetchone()
    check("pending row flips to accepted with fact_id",
          prow is not None and prow["state"] == "accepted"
          and prow["fact_id"] == fid and prow["reviewed_why"] == "user confirmed",
          str(dict(prow)) if prow else "")


def test_routine_writes_silently() -> None:
    print("routine facts write silently with provenance")
    conn, _ = fresh_db()
    res = D.gated_add(conn, "The loop gate stopped at 100 calls in the live test.",
                      kind="fact", session_id="sess-a", source="chat:sess-a")
    check("routine gated_add reports held=False", res["held"] is False, str(res))
    check("routine gated_add returns a fact id",
          isinstance(res.get("fact_id"), int), str(res))
    check("routine gated_add creates no pending row", pending_count(conn) == 0, "")
    row = conn.execute("SELECT source FROM facts WHERE id=?",
                       (res["fact_id"],)).fetchone()
    check("routine fact source carries gated:routine + caller source",
          row is not None and "gated:routine" in row["source"]
          and "chat:sess-a" in row["source"],
          str(dict(row)) if row else "")
    check("routine fact is searchable",
          any("100 calls" in t for t in search_texts(conn, "loop gate")), "")


def test_direct_add_unaffected() -> None:
    print("direct facts.add_fact is unaffected (backwards compat)")
    conn, _ = fresh_db()
    fid = F.add_fact(conn, "My name is Rohan.", kind="fact", session_id="sess-a")
    check("direct add still writes immediately", fact_count(conn) == 1, "")
    check("direct add creates no pending row", pending_count(conn) == 0, "")
    check("direct add is searchable",
          any("Rohan" in t for t in search_texts(conn, "Rohan")), "")
    check("direct add returns the same id on duplicate",
          F.add_fact(conn, "My name is Rohan.", kind="fact") == fid, "")
    res = D.gated_add(conn, "My name is Rohan.", kind="fact")
    check("gated_add of an already-stored fact does not hold it",
          res["held"] is False and res.get("fact_id") == fid
          and res.get("duplicate") is True, str(res))


def test_reject_never_lands() -> None:
    print("rejected pending facts never land")
    conn, _ = fresh_db()
    res = D.gated_add(conn, "My timezone is CET.", kind="fact")
    pid = res["pending_id"]
    D.reject(conn, pid, "not confirmed by the user")
    check("rejected fact writes NO row to facts", fact_count(conn) == 0, "")
    check("rejected fact is NOT searchable",
          "CET" not in " ".join(search_texts(conn, "timezone")), "")
    check("rejected pending row stays as an audit row, state=rejected",
          pending_count(conn, "rejected") == 1, "")
    try:
        D.accept(conn, pid, "changed my mind")
        check("accept of a rejected row is refused", False, "no error raised")
    except D.GateError:
        check("accept of a rejected row is refused", True, "")


def test_cap() -> None:
    print("pending cap (3, reused from lessons MAX_CANDIDATES)")
    conn, _ = fresh_db()
    ids = []
    for text in ("My name is Rohan.", "My timezone is CET.", "Call me Sam."):
        ids.append(D.gated_add(conn, text, kind="fact")["pending_id"])
    check("three pending facts are accepted", len(ids) == 3 and pending_count(conn) == 3, str(ids))
    try:
        D.gated_add(conn, "I go by Sam.", kind="fact")
        check("4th high-stakes fact is refused loudly", False, "no error raised")
    except D.GateError as exc:
        check("4th high-stakes fact is refused loudly",
              "pending full" in str(exc).lower(), str(exc))
    check("refused 4th fact did NOT fall back to a routine write",
          fact_count(conn) == 0, f"facts={fact_count(conn)}")
    D.accept(conn, ids[0], "user confirmed")
    res = D.gated_add(conn, "I go by Sam.", kind="fact")
    check("accepting one frees a slot for the next propose",
          res["held"] is True and pending_count(conn) == 3, str(res))


def test_why_required() -> None:
    print("--why is required for accept / reject (mirrors lessons.py)")
    conn, _ = fresh_db()
    pid = D.gated_add(conn, "My name is Rohan.", kind="fact")["pending_id"]
    for bad_why in ("", "   "):
        try:
            D.accept(conn, pid, bad_why)
            check(f"accept with why={bad_why!r} is refused", False, "no error")
        except D.GateError:
            check(f"accept with why={bad_why!r} is refused", True, "")
    pid2 = D.gated_add(conn, "Call me Sam.", kind="fact")["pending_id"]
    try:
        D.reject(conn, pid2, "")
        check("reject with empty why is refused", False, "no error")
    except D.GateError:
        check("reject with empty why is refused", True, "")
    check("refused transitions leave the rows pending", pending_count(conn) == 2, "")


def test_secret_rejected() -> None:
    print("secrets are rejected, not held and not written")
    conn, _ = fresh_db()
    fake = "sk-" + "B" * 30  # constructed, never a literal key in source
    try:
        D.propose(conn, "The key is " + fake + " for testing.", kind="fact")
        check("propose with a secret is refused", False, "no error raised")
    except D.GateError:
        check("propose with a secret is refused", True, "")
    check("refused secret leaves no pending row", pending_count(conn) == 0, "")
    rows = conn.execute("SELECT text FROM pending_facts").fetchall()
    check("no secret bytes persist in the pending store",
          all(fake not in (r["text"] or "") for r in rows), "")
    try:
        D.gated_add(conn, "The key is " + fake + " for testing.", kind="fact")
        check("gated_add with a secret is refused", False, "no error raised")
    except D.GateError:
        check("gated_add with a secret is refused", True, "")
    check("refused secret writes no fact", fact_count(conn) == 0, "")


def test_accept_idempotent() -> None:
    print("accept is idempotent: one fact, one accepted row")
    conn, _ = fresh_db()
    pid = D.gated_add(conn, "My name is Rohan.", kind="fact")["pending_id"]
    fid1 = D.accept(conn, pid, "user confirmed")
    try:
        D.accept(conn, pid, "user confirmed again")
        check("second accept is refused", False, "no error raised")
    except D.GateError:
        check("second accept is refused", True, "")
    check("exactly one fact row exists after two accepts",
          fact_count(conn) == 1, f"facts={fact_count(conn)}")
    prow = conn.execute(
        "SELECT fact_id FROM pending_facts WHERE seq=?",
        (D.parse_pending_id(pid),)).fetchone()
    check("pending row still points at the same fact id",
          prow is not None and prow["fact_id"] == fid1, str(dict(prow)) if prow else "")


def test_field_caps() -> None:
    print("field caps (400 chars, reused from lessons MAX_FIELD_CHARS)")
    conn, _ = fresh_db()
    ok_text = "x" * 400
    res = D.gated_add(conn, ok_text, kind="fact")
    check("400-char fact is accepted (routine)", res["held"] is False, str(res))
    try:
        D.propose(conn, "y" * 401, kind="fact")
        check("401-char fact is refused", False, "no error raised")
    except D.GateError:
        check("401-char fact is refused", True, "")
    try:
        D.propose(conn, "   ", kind="fact")
        check("empty-after-strip fact is refused", False, "no error raised")
    except D.GateError:
        check("empty-after-strip fact is refused", True, "")


def test_search_isolation() -> None:
    print("pending / rejected text is never searchable; accepted text is")
    conn, _ = fresh_db()
    D.gated_add(conn, "My timezone is CET.", kind="fact")
    D.gated_add(conn, "Call me Sam.", kind="fact")
    pid = D.gated_add(conn, "My name is Rohan.", kind="fact")["pending_id"]
    D.accept(conn, pid, "user confirmed")
    check("pending text returns 0 search hits",
          search_texts(conn, "CET") == [], "")
    check("accepted text returns its fact",
          any("Rohan" in t for t in search_texts(conn, "Rohan")), "")
    conn2, _ = fresh_db()
    pid2 = D.gated_add(conn2, "My timezone is CET.", kind="fact")["pending_id"]
    D.reject(conn2, pid2, "no")
    check("rejected text returns 0 search hits",
          search_texts(conn2, "CET") == [], "")


def test_contradiction_identity() -> None:
    print("identity-field contradiction is held; ordinary updates are routine")
    conn, _ = fresh_db()
    F.add_fact(conn, "My name is Rohan.", kind="fact", importance=3)
    held, reasons = D.classify_high_stakes("My name is Sam.", "fact", conn=conn)
    check("identity contradiction is held", held is True, str(reasons))
    check("contradiction reason names the existing fact",
          any("contradict" in r for r in reasons), str(reasons))
    conn2, _ = fresh_db()
    F.add_fact(conn2, "The loop gate is 30.", kind="fact", importance=3)
    held2, _ = D.classify_high_stakes("The loop gate is 20.", "fact", conn=conn2)
    check("numeric update of the same subject stays routine", held2 is False, "")
    held3, _ = D.classify_high_stakes("The loop gate is broken.", "fact", conn=conn2)
    check("status change of the same subject stays routine", held3 is False, "")


def test_schema_safety() -> None:
    print("pending table does not disturb facts.py schema or migration")
    conn, path = fresh_db()
    D.propose(conn, "My name is Rohan.", kind="fact")
    ver = conn.execute(
        "SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
    check("gate does not touch meta.schema_version", ver == "2", str(ver))
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    check("pending_facts table exists alongside facts",
          "pending_facts" in tables and "facts" in tables, str(sorted(tables)))
    # v1 database (hand-built, no valid_from/valid_to) + gate propose,
    # then the facts.py v1->v2 migration must still run cleanly.
    tmp = Path(tempfile.mkdtemp())
    v1path = tmp / "memory.db"
    raw = sqlite3.connect(str(v1path))
    raw.executescript("""
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
    raw.commit()
    D.propose(raw, "My name is Rohan.", kind="fact")
    raw.close()
    conn2 = F.open_db(v1path)
    ver2 = conn2.execute(
        "SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
    check("v1->v2 migration still runs after a gate propose", ver2 == "2", str(ver2))
    check("v1 fact survives the migration",
          conn2.execute("SELECT COUNT(*) FROM facts WHERE hash='deadbeef-mig-1'"
                        ).fetchone()[0] == 1, "")
    check("pending row survives the migration", pending_count(conn2) == 1, "")


def test_no_auto_supersede() -> None:
    print("the gate never supersedes; supersede never creates pending rows")
    conn, _ = fresh_db()
    fid = F.add_fact(conn, "The loop gate is 30.", kind="fact", importance=3)
    F.supersede_fact(conn, fid, "The loop gate is 20.")
    check("supersede creates no pending row", pending_count(conn) == 0, "")
    res = D.gated_add(conn, "My name is Sam.", kind="fact")
    check("gated_add of a new identity fact holds it, never supersedes",
          res["held"] is True and fact_count(conn) == 2, str(res))


def test_cli() -> None:
    print("CLI mirrors lessons.py (propose / accept / reject / list / check)")
    _, db = fresh_db()

    def run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(HERE / "durable_write.py"), "--db", str(db), *args],
            capture_output=True, text=True)

    r = run("add-gated", "--text", "My name is Rohan.", "--kind", "fact")
    out = json.loads(r.stdout)
    check("CLI add-gated holds a high-stakes fact",
          r.returncode == 0 and out["held"] is True and out["pending_id"].startswith("PF-"),
          r.stdout[:200] + r.stderr[:200])
    r = run("add-gated", "--text", "The build takes 5 minutes.", "--kind", "fact")
    out = json.loads(r.stdout)
    check("CLI add-gated writes a routine fact",
          r.returncode == 0 and out["held"] is False and isinstance(out["fact_id"], int),
          r.stdout[:200] + r.stderr[:200])
    r = run("list")
    check("CLI list exits 0 and shows the pending fact",
          r.returncode == 0 and "PF-001" in r.stdout, r.stdout[:200] + r.stderr[:200])
    r = run("check")
    check("CLI check exits 0 on a valid store", r.returncode == 0,
          r.stdout[:200] + r.stderr[:200])
    r = run("accept", "--id", "PF-001", "--why", "user confirmed")
    check("CLI accept exits 0", r.returncode == 0,
          r.stdout[:200] + r.stderr[:200])
    r = run("accept", "--id", "PF-999", "--why", "user confirmed")
    check("CLI accept of an unknown id exits non-zero", r.returncode != 0,
          r.stdout[:200] + r.stderr[:200])
    r = run("reject", "--id", "PF-001", "--why", "too late")
    check("CLI reject of an accepted row exits non-zero", r.returncode != 0,
          r.stdout[:200] + r.stderr[:200])


def test_flat_layout() -> None:
    print("flat machine layout (facts.py + recall.py + durable_write.py side by side)")
    tmp = Path(tempfile.mkdtemp())
    for name in ("facts.py", "recall.py"):
        shutil.copy(MEMORY_DIR / name, tmp / name)
    shutil.copy(HERE / "durable_write.py", tmp / "durable_write.py")
    db = tmp / "memory.db"
    r = subprocess.run(
        [sys.executable, str(tmp / "durable_write.py"), "--db", str(db),
         "add-gated", "--text", "My name is Rohan.", "--kind", "fact"],
        capture_output=True, text=True, cwd=str(tmp))
    out = json.loads(r.stdout) if r.returncode == 0 else {}
    check("flat layout: add-gated holds a high-stakes fact",
          r.returncode == 0 and out.get("held") is True,
          r.stdout[:200] + r.stderr[:200])
    r = subprocess.run(
        [sys.executable, str(tmp / "durable_write.py"), "--db", str(db),
         "add-gated", "--text", "The build takes 5 minutes.", "--kind", "fact"],
        capture_output=True, text=True, cwd=str(tmp))
    out = json.loads(r.stdout) if r.returncode == 0 else {}
    check("flat layout: add-gated writes a routine fact",
          r.returncode == 0 and out.get("held") is False,
          r.stdout[:200] + r.stderr[:200])


def main() -> int:
    print("durable_write.py — ask-before-durable-write (provisional T133)")
    test_classifier_golden()
    test_gated_add_holds_high_stakes()
    test_accept_flushes()
    test_routine_writes_silently()
    test_direct_add_unaffected()
    test_reject_never_lands()
    test_cap()
    test_why_required()
    test_secret_rejected()
    test_accept_idempotent()
    test_field_caps()
    test_search_isolation()
    test_contradiction_identity()
    test_schema_safety()
    test_no_auto_supersede()
    test_cli()
    test_flat_layout()
    print(f"{PASS} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
