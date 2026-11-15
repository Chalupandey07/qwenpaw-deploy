#!/usr/bin/env python3
"""Tests for the bounded recall CLI (features/memory/recall.py).

Builds a throwaway history.db with the EXACT schema QwenPaw v2.3.0 creates
(src/qwenpaw/agents/context/scroll/history.py: conversation_history +
external-content FTS5 `conversation_history_fts`, porter unicode61) and
asserts the Phase 4 guarantees: token cap, result cap, redaction,
tool-result exclusion, read-only, no full-session dumps.

Run: python3 features/memory/test_recall.py
Exit 0 = all pass.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECALL = HERE / "recall.py"

sys.path.insert(0, str(HERE))
import recall as R  # noqa: E402

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


# ------------------------------------------------------------ fixture

SCHEMA = """
CREATE TABLE conversation_history (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    agent_id     TEXT,
    kind         TEXT NOT NULL,
    role         TEXT,
    name         TEXT,
    content      TEXT,
    tool_call_id TEXT,
    tool_input   TEXT,
    tool_state   TEXT,
    headline     TEXT,
    blocks       TEXT,
    metadata     TEXT,
    created_at   TEXT,
    dedup_key    TEXT
);
CREATE INDEX ch_session ON conversation_history(session_id);
CREATE VIRTUAL TABLE conversation_history_fts USING fts5(
    content, content='conversation_history', content_rowid='seq',
    tokenize='porter unicode61'
);
"""

ROWS = [
    # session, agent, kind, role, name, content, created_at
    ("sess-alpha-1111", "default", "context_msg", "user", None,
     "The desktop lease kept expiring because the watcher uploaded a preview "
     "every fifteen seconds and burned the KV write quota.", "2026-11-15T03:10:00Z"),
    ("sess-alpha-1111", "default", "model_turn", "assistant", None,
     "I fixed the lease by making preview uploads change-only with a 120 "
     "second floor so a static desktop costs zero writes.", "2026-11-15T03:12:00Z"),
    ("sess-beta-2222", "default", "context_msg", "user", None,
     "Here is my token github_pat_11ABCDEFG0123456789_abcdefghij and my "
     "password=hunter2supersecret please remember them.", "2026-11-15T04:00:00Z"),
    ("sess-beta-2222", "default", "tool_result", "tool", "list_apps",
     "desktop lease tool output listing chromium pid 104998 window wordsolverx "
     "and much more tool noise that should never be recalled by default", "2026-11-15T04:01:00Z"),
    ("sess-gamma-3333", "QwenPaw_QA_Agent_0.2", "context_msg", "user", None,
     "The QA agent has its own private display two on Xvfb lease lease lease.",
     "2026-11-14T22:00:00Z"),
    (
        "sess-delta-4444",
        "default",
        "context_msg",
        "user",
        "recall_history",
        "recall_history lease self pollution row that must be skipped entirely.",
        "2026-11-15T05:00:00Z",
    ),
]

# A single very long row to prove the excerpt window never dumps a whole turn.
LONG = ("lease " + ("filler words here " * 4000))


def build_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    for i, (sid, agent, kind, role, name, content, created) in enumerate(ROWS):
        conn.execute(
            "INSERT INTO conversation_history "
            "(session_id, agent_id, kind, role, name, content, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (sid, agent, kind, role, name, content, created),
        )
        if name == "recall_history":
            # Upstream keeps recall churn out of FTS; do the same here.
            # Deliberately still indexed below so the CLI's own name filter
            # is what is under test, not the fixture's omission.
            pass
    conn.execute(
        "INSERT INTO conversation_history "
        "(session_id, agent_id, kind, role, content, created_at) "
        "VALUES (?,?,?,?,?,?)",
        ("sess-long-9999", "default", "context_msg", "user", LONG,
         "2026-11-15T06:00:00Z"),
    )
    conn.commit()
    # External-content FTS5 needs an explicit rebuild on pre-existing rows.
    conn.execute(
        "INSERT INTO conversation_history_fts(conversation_history_fts) VALUES('rebuild')"
    )
    conn.commit()
    conn.close()


# --------------------------------------------------------------- tests

def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="recall-test-"))
    db = tmp / "history.db"
    build_db(db)

    print("schema probe")
    info = R.probe_schema(R.open_readonly(db))
    check("detects FTS5", info["fts5"] is True, str(info))
    check("row count matches", info["rows"] == len(ROWS) + 1, str(info["rows"]))
    check("has required columns",
          {"seq", "session_id", "kind", "content"} <= set(info["columns"]))

    print("basic recall")
    rep = R.recall(db, "lease")
    check("returns hits", rep["count"] > 0, str(rep["count"]))
    check("respects default limit 3", rep["count"] <= 3, str(rep["count"]))
    check("stays under token budget",
          rep["total_tokens"] <= rep["budget_tokens"],
          f"{rep['total_tokens']}/{rep['budget_tokens']}")
    check("never returns a full session",
          all(len(h["excerpt"]) <= R.DEFAULT_EXCERPT_CHARS + 8 for h in rep["hits"]),
          str([len(h["excerpt"]) for h in rep["hits"]]))

    print("tool-result exclusion")
    check("tool_result rows excluded by default",
          all(h["kind"] != "tool_result" for h in rep["hits"]),
          str([h["kind"] for h in rep["hits"]]))
    rep_tool = R.recall(db, "chromium", include_tool_results=True)
    check("--include-tool-results can surface them",
          any(h["kind"] == "tool_result" for h in rep_tool["hits"]),
          str([h["kind"] for h in rep_tool["hits"]]))

    print("self-pollution guard")
    rep_self = R.recall(db, "pollution")
    check("recall_history rows are skipped",
          rep_self["count"] == 0,
          json.dumps([h["excerpt"][:40] for h in rep_self["hits"]]))

    print("redaction")
    rep_secret = R.recall(db, "token")
    blob = json.dumps(rep_secret["hits"])
    check("github_pat redacted", "github_pat_11ABCDEFG" not in blob, blob[:200])
    check("password value redacted", "hunter2supersecret" not in blob, blob[:200])
    check("redaction reported", "github_pat" in rep_secret["redactions_applied"],
          str(rep_secret["redactions_applied"]))
    raw_rep = R.recall(db, "token", redact_output=False)
    check("--no-redact still finds the raw row for tests",
          "hunter2supersecret" in json.dumps(raw_rep["hits"]))

    print("budgets and caps")
    for bad in (0, -1, R.MAX_LIMIT + 1):
        try:
            R.recall(db, "lease", limit=bad)
            check(f"limit {bad} rejected", False)
        except R.RecallError:
            check(f"limit {bad} rejected", True)
    try:
        R.recall(db, "lease", budget_tokens=R.ABSOLUTE_BUDGET_TOKENS + 1)
        check("budget above hard cap rejected", False)
    except R.RecallError:
        check("budget above hard cap rejected", True)
    try:
        R.recall(db, "   ")
        check("empty query rejected", False)
    except R.RecallError:
        check("empty query rejected", True)

    tiny = R.recall(db, "lease", budget_tokens=1)
    check("tiny budget yields no hits", tiny["count"] == 0, str(tiny["count"]))
    check("tiny budget reports truncation", tiny["truncated_by_budget"] is True)

    print("filters")
    rep_agent = R.recall(db, "lease", agent="QwenPaw_QA_Agent_0.2")
    check("agent filter applies",
          all(h["agent_id"] == "QwenPaw_QA_Agent_0.2" for h in rep_agent["hits"])
          and rep_agent["count"] >= 1,
          json.dumps(rep_agent["hits"])[:200])
    rep_since = R.recall(db, "lease", since="2026-11-15T00:00:00Z")
    check("since filter applies",
          all((h["created_at"] or "") >= "2026-11-15" for h in rep_since["hits"]),
          json.dumps([h["created_at"] for h in rep_since["hits"]]))
    rep_kind = R.recall(db, "lease", kind="model_turn")
    check("kind filter applies",
          all(h["kind"] == "model_turn" for h in rep_kind["hits"]),
          json.dumps([h["kind"] for h in rep_kind["hits"]]))

    print("fts robustness")
    check("punctuation query does not raise",
          isinstance(R.recall(db, "C++ foo-bar"), dict))
    check("no-match query is a clean zero",
          R.recall(db, "zzzznotpresent")["count"] == 0)

    print("read-only guarantees")
    before = db.stat().st_mtime_ns
    size_before = db.stat().st_size
    R.recall(db, "lease")
    check("db file untouched", db.stat().st_mtime_ns == before
          and db.stat().st_size == size_before)
    conn = R.open_readonly(db)
    try:
        conn.execute("DELETE FROM conversation_history WHERE seq=1")
        check("writes denied by authorizer", False)
    except sqlite3.Error:
        check("writes denied by authorizer", True)
    finally:
        conn.close()
    check("db still intact after denied write",
          R.probe_schema(R.open_readonly(db))["rows"] == len(ROWS) + 1)

    print("cli")
    env = dict(os.environ)
    p = subprocess.run(
        [sys.executable, str(RECALL), "--db", str(db), "--query", "lease", "--json"],
        capture_output=True, text=True, env=env, timeout=60,
    )
    check("cli exit 0", p.returncode == 0, p.stderr[:300])
    try:
        cli = json.loads(p.stdout)
        check("cli json has hits", cli["count"] > 0, str(cli.get("count")))
    except Exception as exc:  # noqa: BLE001
        check("cli json parses", False, f"{exc}: {p.stdout[:200]}")

    p = subprocess.run(
        [sys.executable, str(RECALL), "--db", str(db), "--query", "x",
         "--budget-tokens", "99999"],
        capture_output=True, text=True, timeout=60,
    )
    check("cli rejects over-cap budget", p.returncode == 1, str(p.returncode))

    p = subprocess.run(
        [sys.executable, str(RECALL), "--db", str(tmp / "nope.db"), "--query", "x"],
        capture_output=True, text=True, timeout=60,
    )
    check("cli missing db exit 2", p.returncode == 2, str(p.returncode))

    p = subprocess.run(
        [sys.executable, str(RECALL), "--db", str(db), "--check"],
        capture_output=True, text=True, timeout=60,
    )
    check("cli --check exit 0", p.returncode == 0, p.stderr[:200])

    print("redaction unit")
    cases = [
        ("g hp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", None),
        ("token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "assignment"),
        ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "bearer"),
        ("AKIAIOSFODNN7EXAMPLE", "aws_akid"),
        ("sk-abcdefghijklmnopqrstuvwxyz123456", "openai_sk"),
        ("nothing sensitive here", None),
    ]
    for text, expect in cases:
        out, hits = R.redact(text)
        if expect is None:
            check(f"redact leaves {text[:18]!r}", "REDACTED" not in out, out)
        else:
            check(f"redact catches {expect}", expect in hits, str(hits))
            check(f"redact removes value ({expect})",
                  "abcdefghijk" not in out and "IOSFODNN" not in out, out)

    print()
    total = PASS + len(FAIL)
    print(f"{PASS} passed, {len(FAIL)} failed  ({total} checks)")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
