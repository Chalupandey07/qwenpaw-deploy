#!/usr/bin/env python3
"""Artifacts library (gap #14, provisional T138) — an index, not new infra.

Walk a workspace directory plus sent-file metadata plus history.db, store
name / slug / date / size / type / source in SQLite, and render one
searchable static page. Backfill covers files that were sent before the
index existed.

Usage:
    python3 artifacts.py index --workspace DIR --db artifacts.db
        [--history DIR/history.db] [--sent-files sent.json]
    python3 artifacts.py search --db artifacts.db --query "report"
    python3 artifacts.py backfill --db artifacts.db --workspace DIR
        [--history DIR/history.db] [--sent-files sent.json]
    python3 artifacts.py render --db artifacts.db --out artifacts.html

Sources (the `source` column):
    workspace  file found by walking the workspace
    sent       file listed in a sent-file metadata JSON file
               ([{"path": "rel/path.png", "sent_at": "...",
                  "session_id": "...", "channel": "console"}])
    history    file path mentioned in history.db conversation content

history.db is opened strictly read-only (mode=ro URI + a mutation-denying
authorizer, mirroring features/memory/recall.py). This indexer NEVER
writes to history.db, never reads message content into the index beyond
matching file-path references, and never touches auth.json or user chats.
Only metadata (name, date, size, type, source, session id) is stored.

The open-work list is NOT rebuilt here: it already exists as a snapshot
page (features/board/open-work.html + refresh-open-work.py). This library
is the artifacts half of gap #14 only. The page is a static snapshot,
not a live feed: on InstaBox Free there is no inbound route and Pages
is static, so snapshot + re-run is the ceiling (see the evaluation,
~/workspace/all-20-gaps-evaluation-2026-11-18.md, gap #14).

English only. Stdlib only. No network, no China endpoints.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Extension -> artifact type. Anything unlisted is "other".
TYPE_MAP: dict[str, str] = {
    ".pdf": "document", ".md": "document", ".txt": "document",
    ".doc": "document", ".docx": "document", ".odt": "document",
    ".rtf": "document", ".epub": "document",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image",
    ".webp": "image", ".svg": "image", ".bmp": "image",
    ".csv": "data", ".json": "data", ".yaml": "data", ".yml": "data",
    ".sqlite": "data", ".db": "data", ".tsv": "data", ".parquet": "data",
    ".xls": "spreadsheet", ".xlsx": "spreadsheet", ".ods": "spreadsheet",
    ".ppt": "presentation", ".pptx": "presentation", ".odp": "presentation",
    ".py": "code", ".js": "code", ".ts": "code", ".mjs": "code",
    ".html": "code", ".css": "code", ".sh": "code", ".sql": "code",
    ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".flac": "audio",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
    ".zip": "archive", ".tar": "archive", ".gz": "archive", ".xz": "archive",
}

# Directories never walked (caches, VCS, venvs, the index itself).
EXCLUDE_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv"}
# File names never indexed as artifacts.
EXCLUDE_NAMES = {"artifacts.db", "artifacts.db-wal", "artifacts.db-shm",
                 "history.db", "history.db-wal", "history.db-shm"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS artifacts (
    slug       TEXT NOT NULL,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL,
    date       TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    type       TEXT NOT NULL,
    source     TEXT NOT NULL,
    session_id TEXT,
    indexed_at TEXT NOT NULL,
    UNIQUE (path, source)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_slug ON artifacts(slug);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
CREATE INDEX IF NOT EXISTS idx_artifacts_date ON artifacts(date);
CREATE INDEX IF NOT EXISTS idx_artifacts_name ON artifacts(name);
"""


class ArtifactsError(RuntimeError):
    """A caller-facing problem (bad path, bad schema, bad input)."""


def slugify(name: str) -> str:
    """Lowercase slug: non-alphanumerics become one hyphen, edges trimmed."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "artifact"


def classify(path: Path) -> str:
    """Artifact type from the file extension; 'other' when unknown."""
    return TYPE_MAP.get(path.suffix.lower(), "other")


def iso_from_mtime(mtime: float) -> str:
    return datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()


def init_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def _unique_slug(conn: sqlite3.Connection, base: str, path: str) -> str:
    """Slug unique across paths: a second path with the same slug gets -2."""
    row = conn.execute(
        "SELECT path FROM artifacts WHERE slug = ?", (base,)
    ).fetchone()
    if row is None or row[0] == path:
        return base
    n = 2
    while True:
        cand = f"{base}-{n}"
        row = conn.execute(
            "SELECT path FROM artifacts WHERE slug = ?", (cand,)
        ).fetchone()
        if row is None or row[0] == path:
            return cand
        n += 1


def upsert(conn: sqlite3.Connection, *, name: str, path: str, date: str,
           size_bytes: int, type_: str, source: str,
           session_id: str | None = None) -> str:
    """Insert or refresh one row. (path, source) is the idempotency key:
    re-indexing the same file from the same source updates the row in
    place and never creates a duplicate."""
    slug = _unique_slug(conn, slugify(Path(name).stem), path)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO artifacts
               (slug, name, path, date, size_bytes, type, source,
                session_id, indexed_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(path, source) DO UPDATE SET
               slug=excluded.slug, name=excluded.name, date=excluded.date,
               size_bytes=excluded.size_bytes, type=excluded.type,
               session_id=excluded.session_id, indexed_at=excluded.indexed_at""",
        (slug, name, path, date, size_bytes, type_, source, session_id, now),
    )
    return slug


def walk_workspace(root: Path) -> list[dict]:
    """List indexable files under root. Skips hidden files/dirs, excluded
    dirs, the index DB itself, history.db*, lock files, and symlinks that
    escape the root (never followed)."""
    if not root.is_dir():
        raise ArtifactsError(f"workspace not a directory: {root}")
    root = root.resolve()
    found: list[dict] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.is_symlink():
            try:
                target = path.resolve()
            except OSError:
                continue
            if not _inside(target, root):
                continue
        rel = path.relative_to(root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if any(part in EXCLUDE_DIRS for part in rel.parts):
            continue
        if path.name in EXCLUDE_NAMES or path.suffix == ".lock":
            continue
        st = path.stat()
        found.append({
            "name": path.name,
            "path": rel.as_posix(),
            "date": iso_from_mtime(st.st_mtime),
            "size_bytes": st.st_size,
            "type": classify(path),
            "source": "workspace",
        })
    return found


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def index_workspace(conn: sqlite3.Connection, root: Path) -> int:
    count = 0
    for f in walk_workspace(root):
        upsert(conn, name=f["name"], path=f["path"], date=f["date"],
               size_bytes=f["size_bytes"], type_=f["type"],
               source=f["source"])
        count += 1
    conn.commit()
    return count


# ---------------------------------------------------------------- history

_MUTATING = frozenset({
    sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE,
    sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_DROP_INDEX,
    sqlite3.SQLITE_DROP_VIEW, sqlite3.SQLITE_DROP_TRIGGER,
    sqlite3.SQLITE_ALTER_TABLE, sqlite3.SQLITE_CREATE_TABLE,
    sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_CREATE_VIEW,
    sqlite3.SQLITE_CREATE_TRIGGER, sqlite3.SQLITE_CREATE_VTABLE,
    sqlite3.SQLITE_DROP_VTABLE, sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH,
    sqlite3.SQLITE_REINDEX, sqlite3.SQLITE_ANALYZE,
})


def _readonly_authorizer(action, arg1, arg2, dbname, trigger):  # noqa: ANN001
    """Deny every mutation; allow reads. mode=ro is the real guarantee."""
    del arg2, dbname, trigger
    if action in _MUTATING and arg1 != "sqlite_master":
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def open_history_readonly(db_path: Path) -> sqlite3.Connection:
    """Open history.db strictly read-only. Raises if missing or if the
    conversation_history table is absent (not a QwenPaw history db)."""
    if not db_path.is_file():
        raise ArtifactsError(f"history db not found: {db_path}")
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    conn.execute("PRAGMA busy_timeout=5000")
    conn.set_authorizer(_readonly_authorizer)
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    if "conversation_history" not in tables:
        conn.close()
        raise ArtifactsError(
            "conversation_history missing — not a QwenPaw history db")
    return conn


def backfill_history(conn: sqlite3.Connection, history_db: Path,
                     workspace: Path) -> int:
    """Backfill from history.db (read-only): any workspace file path
    mentioned in conversation content becomes a `history` row, dated by
    the row's created_at, tagged with its session. Only metadata is
    stored — no message content enters the index. Files that no longer
    exist on disk are skipped (nothing to index)."""
    hist = open_history_readonly(history_db)
    try:
        rows = hist.execute(
            "SELECT session_id, created_at, content FROM conversation_history"
        ).fetchall()
    finally:
        hist.close()
    workspace = workspace.resolve()
    # Match against files that actually exist: a path regex cannot see
    # spaces in names ("Meeting Notes.md"), so check each real workspace
    # file's relative path (and bare name) against the content instead.
    # This also means a mentioned path that no longer exists is skipped.
    known = walk_workspace(workspace)
    count = 0
    for session_id, created_at, content in rows:
        if not content:
            continue
        for f in known:
            if f["path"] in content or f["name"] in content:
                candidate = workspace / f["path"]
                st = candidate.stat()
                upsert(conn, name=candidate.name, path=f["path"],
                       date=created_at or iso_from_mtime(st.st_mtime),
                       size_bytes=st.st_size, type_=f["type"],
                       source="history", session_id=session_id)
                count += 1
    conn.commit()
    return count


def backfill_sent(conn: sqlite3.Connection, sent_file: Path,
                  workspace: Path) -> int:
    """Backfill from sent-file metadata JSON: a list of
    {"path", "sent_at", "session_id", "channel"} records for files the
    agent already sent before the index existed. Only files that exist
    under the workspace are indexed."""
    try:
        records = json.loads(sent_file.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactsError(f"cannot read sent-file metadata: {exc}") from exc
    if not isinstance(records, list):
        raise ArtifactsError("sent-file metadata must be a JSON list")
    workspace = workspace.resolve()
    count = 0
    for rec in records:
        if not isinstance(rec, dict) or "path" not in rec:
            continue
        candidate = (workspace / rec["path"]).resolve()
        if not _inside(candidate, workspace) or not candidate.is_file():
            continue
        st = candidate.stat()
        upsert(conn, name=candidate.name,
               path=candidate.relative_to(workspace).as_posix(),
               date=rec.get("sent_at") or iso_from_mtime(st.st_mtime),
               size_bytes=st.st_size, type_=classify(candidate),
               source="sent", session_id=rec.get("session_id"))
        count += 1
    conn.commit()
    return count


# ---------------------------------------------------------------- search

def search(conn: sqlite3.Connection, query: str, limit: int = 50) -> list[dict]:
    """Case-insensitive token search over name, path, type and source.
    Every token must match somewhere (AND). LIKE wildcards in the query
    are escaped so they match literally."""
    tokens = [t for t in re.findall(r"[0-9A-Za-z_.\-]+", query.lower())]
    if not tokens:
        raise ArtifactsError("empty search query")
    if limit < 1 or limit > 500:
        raise ArtifactsError("limit must be 1..500")
    where, params = [], []
    for tok in tokens:
        lit = "%" + tok.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append(
            "(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(path) LIKE ? ESCAPE '\\'"
            " OR LOWER(type) LIKE ? ESCAPE '\\' OR LOWER(source) LIKE ? ESCAPE '\\')")
        params.extend([lit, lit, lit, lit])
    sql = ("SELECT slug, name, path, date, size_bytes, type, source, session_id "
           "FROM artifacts WHERE " + " AND ".join(where) +
           " ORDER BY date DESC LIMIT ?")
    params.append(limit)
    cols = ("slug", "name", "path", "date", "size_bytes", "type", "source",
            "session_id")
    return [dict(zip(cols, row)) for row in conn.execute(sql, params)]


def list_all(conn: sqlite3.Connection) -> list[dict]:
    cols = ("slug", "name", "path", "date", "size_bytes", "type", "source",
            "session_id")
    return [dict(zip(cols, row)) for row in conn.execute(
        "SELECT slug, name, path, date, size_bytes, type, source, session_id "
        "FROM artifacts ORDER BY date DESC")]


# ---------------------------------------------------------------- render

def render_page(rows: list[dict], generated_at: str | None = None) -> str:
    """One searchable static page: the rows are embedded as JSON and a
    client-side box filters them. No server, no fetch — the page works
    from any static host. States plainly that it is a snapshot."""
    generated_at = generated_at or datetime.now(timezone.utc).isoformat()
    data_json = json.dumps(rows, ensure_ascii=True)
    esc = html.escape
    table_rows = "".join(
        f"<tr><td>{esc(r['name'])}</td><td><code>{esc(r['slug'])}</code></td>"
        f"<td>{esc(r['date'])}</td><td>{r['size_bytes']}</td>"
        f"<td>{esc(r['type'])}</td><td>{esc(r['source'])}</td>"
        f"<td><code>{esc(r['path'])}</code></td></tr>"
        for r in rows
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QwenPaw — Artifacts Library</title>
<style>
body{{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}}
header{{padding:16px 20px;background:#1e293b}}
header h1{{font-size:20px;margin:0}}
header p{{margin:4px 0 0;color:#94a3b8;font-size:13px}}
main{{padding:16px 20px;max-width:1000px}}
input{{width:100%;max-width:480px;padding:8px 10px;font-size:15px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;margin-bottom:12px}}
table{{border-collapse:collapse;font-size:13px;width:100%}}
td,th{{border:1px solid #475569;padding:4px 8px;text-align:left}}
code{{background:#0f172a;padding:1px 4px;border-radius:4px}}
.muted{{color:#94a3b8;font-size:13px}}
</style>
</head>
<body>
<header>
  <h1>QwenPaw — Artifacts Library</h1>
  <p>Snapshot generated {esc(generated_at)} (UTC). Not live: re-run
  <code>python3 artifacts.py index --workspace &lt;dir&gt; --db artifacts.db &amp;&amp; python3 artifacts.py render --db artifacts.db</code>
  to refresh. Open-work list (already exists, snapshot): <a href="../board/open-work.html" style="color:#38bdf8">open-work.html</a></p>
  <p id="count" class="muted">{len(rows)} artifact(s) indexed.</p>
</header>
<main>
  <input id="q" type="search" placeholder="Search name, path, type or source…" aria-label="Search artifacts">
  <table><thead><tr><th>Name</th><th>Slug</th><th>Date</th><th>Size (B)</th><th>Type</th><th>Source</th><th>Path</th></tr></thead>
  <tbody id="rows">{table_rows}</tbody></table>
  <p class="muted">Sources: workspace = found by walking the workspace;
  sent = listed in sent-file metadata; history = path mentioned in
  history.db (read-only, metadata only). history.db is never written to.</p>
</main>
<script>
const DATA = {data_json};
const esc = (s)=>String(s??"").replace(/[&<>"']/g,c=>({{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}}[c]));
document.getElementById("q").addEventListener("input", (e)=>{{
  const q = e.target.value.toLowerCase().trim();
  const toks = q.split(/\\s+/).filter(Boolean);
  const hits = DATA.filter(r=>toks.every(t=>
    (r.name+" "+r.path+" "+r.type+" "+r.source+" "+r.slug).toLowerCase().includes(t)));
  document.getElementById("rows").innerHTML = hits.map(r=>
    "<tr><td>"+esc(r.name)+"</td><td><code>"+esc(r.slug)+"</code></td><td>"+esc(r.date)+"</td><td>"+r.size_bytes+"</td><td>"+esc(r.type)+"</td><td>"+esc(r.source)+"</td><td><code>"+esc(r.path)+"</code></td></tr>").join("");
  document.getElementById("count").textContent = hits.length + " artifact(s) shown of " + DATA.length + ".";
}});
</script>
</body>
</html>
"""


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Artifacts library indexer (T138).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("index", help="walk workspace (+ optional backfill)")
    p.add_argument("--workspace", required=True)
    p.add_argument("--db", required=True)
    p.add_argument("--history")
    p.add_argument("--sent-files")

    p = sub.add_parser("backfill", help="backfill only (sent + history)")
    p.add_argument("--db", required=True)
    p.add_argument("--workspace", required=True)
    p.add_argument("--history")
    p.add_argument("--sent-files")

    p = sub.add_parser("search", help="search the index")
    p.add_argument("--db", required=True)
    p.add_argument("--query", required=True)
    p.add_argument("--limit", type=int, default=50)

    p = sub.add_parser("render", help="render the searchable page")
    p.add_argument("--db", required=True)
    p.add_argument("--out", default=str(HERE / "artifacts.html"))

    args = ap.parse_args(argv)
    try:
        if args.cmd in ("index", "backfill"):
            conn = init_db(Path(args.db))
            ws = Path(args.workspace)
            n = 0
            if args.cmd == "index":
                n += index_workspace(conn, ws)
            if args.sent_files:
                n += backfill_sent(conn, Path(args.sent_files), ws)
            if args.history:
                n += backfill_history(conn, Path(args.history), ws)
            print(json.dumps({"indexed_or_backfilled": n,
                              "total_rows": conn.execute(
                                  "SELECT COUNT(*) FROM artifacts").fetchone()[0]}))
            conn.close()
        elif args.cmd == "search":
            conn = init_db(Path(args.db))
            print(json.dumps(search(conn, args.query, args.limit), indent=2))
            conn.close()
        elif args.cmd == "render":
            conn = init_db(Path(args.db))
            rows = list_all(conn)
            page = render_page(rows)
            Path(args.out).write_text(page)
            conn.close()
            print(json.dumps({"rendered": args.out, "rows": len(rows)}))
    except ArtifactsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
