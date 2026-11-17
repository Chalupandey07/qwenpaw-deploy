#!/usr/bin/env python3
"""Settings Reset — machine-side delete broker (stdlib only).

Listens on RESET_BIND (default 172.18.0.1:8895). The Pages Worker forwards
here after authenticating the caller against the console session; this broker
authenticates the Worker with a shared RESET_TOKEN (constant-time compare).

It accepts ONLY a fixed category enum + confirm/ack/plan_id — never
client-supplied paths, never a shell. Every path it touches comes from
reset_categories (the allowlist) and is re-validated by reset_guard
(realpath under root, no symlink, not a mount, not PROTECTED) immediately
before deletion. A violation aborts the WHOLE run.

Endpoints:
  GET  /health   -> {"ok": true, "ready": bool} (ready=false when RESET_TOKEN unset)
  POST /preview  -> {"categories": [...], "totals": {...}, "plan_id": "..."}
  POST /execute  -> {"status": "ok"|"partial"|"failed", "per_category": [...], ...}

Environment:
  RESET_TOKEN   shared token (required; unset -> every request 503)
  RESET_BIND    bind address (default 172.18.0.1)
  RESET_PORT    port (default 8895)
  RESET_ROOT    data root (default /data/home/qwenpaw)
"""

import hashlib
import hmac
import json
import os
import shutil
import sqlite3
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import reset_categories as rc
import reset_guard as rg

RESET_TOKEN = os.environ.get("RESET_TOKEN", "")
RESET_BIND = os.environ.get("RESET_BIND", "172.18.0.1")
RESET_PORT = int(os.environ.get("RESET_PORT", "8895"))
RESET_ROOT = os.environ.get("RESET_ROOT", "/data/home/qwenpaw")

# Last 100 request ids -> cached execute report (idempotency).
_request_cache = {}
_cache_lock = threading.Lock()
# Single-writer lock for execute (flock on a lockfile under working/, so it
# sits inside the systemd ReadWritePaths — the reset root itself is read-only
# under ProtectSystem=strict).
_LOCK_PATH = os.path.join(RESET_ROOT, "working", ".reset.lock")


def _json_response(handler, status, payload):
    body = json.dumps(payload).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json(handler, max_bytes=65536):
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0 or length > max_bytes:
        return None
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode())
    except (ValueError, UnicodeDecodeError):
        return None


def _token_ok(handler):
    """Constant-time token check. Missing token env -> fail closed (503)."""
    if not RESET_TOKEN:
        return False, 503
    supplied = handler.headers.get("X-Reset-Token") or ""
    if not supplied or not hmac.compare_digest(supplied, RESET_TOKEN):
        return False, 401
    return True, 200


def _active_provider_id(root):
    """provider_id from working.secret/providers/active_model.json, or None."""
    path = os.path.join(root, "working.secret", "providers", "active_model.json")
    try:
        with open(path) as f:
            return json.load(f).get("provider_id")
    except (OSError, ValueError):
        return None


def _section_freed_bytes(path, heading):
    """Bytes a section rewrite would free (before - after), without writing.

    Mirrors _do_section's replacement exactly: the section body (from after
    the heading line to the next '## ' heading, or EOF) is replaced by a
    blank line plus the placeholder comment. No such section -> 0.
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return 0
    lines = text.splitlines(keepends=True)
    start = None
    end = None
    for i, line in enumerate(lines):
        if line.strip() == heading:
            start = i
            continue
        if start is not None and line.startswith("## "):
            end = i
            break
    if start is None:
        return 0
    if end is None:
        end = len(lines)
    before = len(text.encode())
    new_lines = lines[:start + 1] + [
        "\n",
        "<!-- Record important decisions, constraints, and lessons that need to survive across sessions. -->\n",
    ] + lines[end:]
    after = len("".join(new_lines).encode())
    return max(0, before - after)


def _target_size(root, target):
    """(bytes, files) for one target, without deleting anything."""
    kind, path = target[0], target[1]
    try:
        if kind == "section":
            return _section_freed_bytes(path, target[2]), 1
        if kind in ("truncate", "db_clear"):
            st = os.stat(path)
            return st.st_size, 1
        if os.path.isfile(path) or os.path.islink(path):
            return os.path.getsize(path), 1
        if os.path.isdir(path):
            total = 0
            count = 0
            for dirpath, _dirs, files in os.walk(path):
                for name in files:
                    try:
                        total += os.path.getsize(os.path.join(dirpath, name))
                        count += 1
                    except OSError:
                        pass
            return total, count
    except OSError:
        pass
    return 0, 0


def _compute_plan(root, category_ids):
    """Preview data for categories. Returns (plan, error).

    plan = {"categories": [{id,label,warning,paths,bytes,files,targets}],
            "totals": {"bytes": N, "files": N},
            "plan_id": sha256}
    """
    for cid in category_ids:
        if cid not in rc.CATEGORIES:
            return None, "unknown_category: %s" % cid
    active = _active_provider_id(root)
    plan_cats = []
    total_bytes = 0
    total_files = 0
    plan_hasher = hashlib.sha256()
    # Lessons is superseded by Memories (the file delete wins over the
    # section rewrite). Skip it here so the preview does not double-count
    # MEMORY.md — the execute path reports it as superseded_by_memories.
    superseded = rc.lessons_superseded(category_ids)
    effective = [cid for cid in category_ids
                 if not (cid == "lessons" and superseded)]
    for cid in effective:
        targets = rc.targets_for(root, cid, active)
        # Guard-validate every target now (preview must not promise what the
        # executor will refuse).
        try:
            rg.validate_targets(root, targets)
        except ValueError as e:
            return None, str(e)
        cat_bytes = 0
        cat_files = 0
        paths = []
        for t in targets:
            b, n = _target_size(root, t)
            cat_bytes += b
            cat_files += n
            paths.append(t[1])
            try:
                st = os.stat(t[1])
                plan_hasher.update(("%s|%d|%d|" % (t[1], st.st_size, int(st.st_mtime))).encode())
            except OSError:
                plan_hasher.update(("%s|missing|" % t[1]).encode())
        total_bytes += cat_bytes
        total_files += cat_files
        plan_cats.append({
            "id": cid,
            "label": rc.CATEGORIES[cid]["label"],
            "warning": rc.CATEGORIES[cid]["warning"],
            "paths": sorted(set(paths)),
            "bytes": cat_bytes,
            "files": cat_files,
        })
    return {
        "categories": plan_cats,
        "totals": {"bytes": total_bytes, "files": total_files},
        "plan_id": plan_hasher.hexdigest(),
        "lessons_superseded": rc.lessons_superseded(category_ids),
    }, None


# --- Executors (one per target kind). Each returns (ok, bytes_freed, files_deleted, error) ---

def _do_delete(root, path):
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            b, n = _target_size(root, ("delete", path))
            shutil.rmtree(path)
            return True, b, n, None
        b, n = _target_size(root, ("delete", path))
        os.remove(path)
        return True, b, n, None
    except OSError as e:
        return False, 0, 0, str(e)


def _do_truncate(root, path):
    """Truncate chats.json in place (same inode), write {}."""
    try:
        before = os.path.getsize(path)
        with open(path, "w") as f:
            f.write("{}")
        return True, before, 1, None
    except OSError as e:
        return False, 0, 0, str(e)


def _do_db_clear(root, path):
    """Logical clear of history.db: DELETE FROM each table, keep the inode.

    Never unlinks the file (the live agent holds it open). VACUUM is
    best-effort: SQLITE_BUSY -> skip, report logical clear only.
    Returns (ok, bytes_freed, files_deleted, error, rows_cleared).
    """
    try:
        before = os.path.getsize(path)
    except OSError as e:
        return False, 0, 0, str(e), 0
    try:
        con = sqlite3.connect(path, timeout=15)
    except sqlite3.Error as e:
        return False, 0, 0, str(e), 0
    rows = 0
    try:
        con.execute("PRAGMA foreign_keys=OFF")
        con.execute("BEGIN IMMEDIATE")
        tables = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        for table in tables:
            cur = con.execute('DELETE FROM "%s"' % table.replace('"', '""'))
            rows += cur.rowcount or 0
        con.execute("DELETE FROM sqlite_sequence")
        con.commit()
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        # Best-effort reclaim; the live agent may hold the lock.
        try:
            con.execute("VACUUM")
        except sqlite3.OperationalError:
            pass
        con.close()
    except sqlite3.Error as e:
        try:
            con.rollback()
        except sqlite3.Error:
            pass
        try:
            con.close()
        except sqlite3.Error:
            pass
        return False, 0, 0, str(e), 0
    try:
        after = os.path.getsize(path)
    except OSError:
        after = before
    return True, max(0, before - after), 1, None, rows


def _do_section(root, path, heading):
    """Rewrite one markdown section in place (heading … next heading).

    Replaces the section body with the placeholder comment. Keeps the file
    (same inode). Returns (ok, bytes_freed, files_deleted, error).
    """
    try:
        with open(path) as f:
            text = f.read()
    except OSError as e:
        return False, 0, 0, str(e)
    lines = text.splitlines(keepends=True)
    start = None
    end = None
    for i, line in enumerate(lines):
        if line.strip() == heading:
            start = i
            continue
        if start is not None and line.startswith("## "):
            end = i
            break
    if start is None:
        return True, 0, 0, None  # no such section: nothing to do
    if end is None:
        end = len(lines)
    before = len(text.encode())
    new_lines = lines[:start + 1] + [
        "\n",
        "<!-- Record important decisions, constraints, and lessons that need to survive across sessions. -->\n",
    ] + lines[end:]
    new_text = "".join(new_lines)
    try:
        with open(path, "w") as f:
            f.write(new_text)
    except OSError as e:
        return False, 0, 0, str(e)
    return True, max(0, before - len(new_text.encode())), 1, None


def _chats_idle_gate(root):
    """Refuse Chats when the agent is actively writing (wal growing).

    Checks history.db-wal size+mtime twice over 5 s. Growing -> busy.
    Returns (idle, reason).
    """
    for w in rc.workspace_dirs(root):
        wal = os.path.join(w, "history.db-wal")
        try:
            s1 = os.stat(wal)
        except OSError:
            continue  # no wal: nothing being written
        time.sleep(5)
        try:
            s2 = os.stat(wal)
        except OSError:
            continue
        if (s2.st_mtime != s1.st_mtime) or (s2.st_size != s1.st_size):
            return False, "agent active (history.db-wal growing), retry"
    return True, ""


def _execute_category(root, cid, active):
    """Execute one category. Returns a per-category report dict."""
    targets = rc.targets_for(root, cid, active)
    try:
        rg.validate_targets(root, targets)
    except ValueError as e:
        return {"id": cid, "status": "failed", "bytes_freed": 0,
                "files_deleted": 0, "errors": [{"path": "", "error": str(e)}],
                "skipped": []}
    # Lessons is superseded by Memories (file delete wins).
    if cid == "lessons" and not targets:
        return {"id": cid, "status": "ok", "bytes_freed": 0, "files_deleted": 0,
                "errors": [], "skipped": [{"path": "", "reason": "nothing_to_delete"}]}
    status = "ok"
    freed = 0
    deleted = 0
    errors = []
    skipped = []
    for t in targets:
        kind, path = t[0], t[1]
        if kind == "delete":
            ok, b, n, err = _do_delete(root, path)
        elif kind == "truncate":
            ok, b, n, err = _do_truncate(root, path)
        elif kind == "db_clear":
            ok, b, n, err, _rows = _do_db_clear(root, path)
        elif kind == "section":
            ok, b, n, err = _do_section(root, path, t[2])
        else:
            ok, b, n, err = False, 0, 0, "unknown target kind: %s" % kind
        if ok:
            freed += b
            deleted += n
        else:
            status = "partial"
            errors.append({"path": path, "error": err or "failed"})
    if not targets:
        return {"id": cid, "status": "ok", "bytes_freed": 0, "files_deleted": 0,
                "errors": [], "skipped": [{"path": "", "reason": "nothing_to_delete"}]}
    return {"id": cid, "status": status, "bytes_freed": freed,
            "files_deleted": deleted, "errors": errors, "skipped": skipped}


def _audit_log(root, report):
    """Append one JSONL line to working/logs/reset.log (never deleted)."""
    try:
        logdir = os.path.join(root, "working", "logs")
        os.makedirs(logdir, exist_ok=True)
        with open(os.path.join(logdir, "reset.log"), "a") as f:
            f.write(json.dumps(report) + "\n")
    except OSError:
        pass  # audit failure must not fail the reset itself


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep stdout clean
        pass

    def _auth(self):
        ok, code = _token_ok(self)
        return ok, code

    def do_GET(self):
        if self.path == "/health":
            _json_response(self, 200, {"ok": True, "ready": bool(RESET_TOKEN)})
            return
        _json_response(self, 404, {"error": "not_found"})

    def do_POST(self):
        # Consume the request body FIRST, before any auth decision. The
        # handler is HTTP/1.1 with keep-alive: if a 401 returns without
        # reading the body, the leftover bytes corrupt the next request on
        # the same connection (the parser reads the body as a request line
        # and answers 501). Reading here keeps the connection clean.
        body = _read_json(self)
        ok, code = self._auth()
        if not ok:
            _json_response(self, code, {"error": "unauthorized" if code == 401 else "reset_token_unset"})
            return
        if body is None:
            _json_response(self, 400, {"error": "bad_json"})
            return

        if self.path == "/preview":
            cats = body.get("categories")
            if not isinstance(cats, list) or not all(isinstance(c, str) for c in cats):
                _json_response(self, 400, {"error": "bad_categories"})
                return
            plan, err = _compute_plan(RESET_ROOT, cats)
            if err:
                _json_response(self, 400 if "unknown_category" in err else 409, {"error": err})
                return
            _json_response(self, 200, plan)
            return

        if self.path == "/execute":
            self._execute(body)
            return

        _json_response(self, 404, {"error": "not_found"})

    def _execute(self, body):
        cats = body.get("categories")
        confirm = body.get("confirm")
        ack = body.get("ack")
        plan_id = body.get("plan_id")
        request_id = self.headers.get("X-Request-Id") or str(uuid.uuid4())

        # Idempotency: replay returns the cached report, deletes nothing.
        with _cache_lock:
            if request_id in _request_cache:
                _json_response(self, 200, _request_cache[request_id])
                return

        if not isinstance(cats, list) or not all(isinstance(c, str) for c in cats):
            _json_response(self, 400, {"error": "bad_categories"})
            return
        # Confirmation is mandatory: type DELETE + checkbox + matching plan.
        if confirm != "DELETE" or ack is not True:
            _json_response(self, 400, {"error": "confirmation_required"})
            return
        if not isinstance(plan_id, str) or not plan_id:
            _json_response(self, 400, {"error": "confirmation_required"})
            return

        # Single-writer: flock, else 409 busy. The flock IS the gate — it is
        # held across threads and processes. There is deliberately no
        # threading.Lock around it: a lock would serialize the two threads,
        # so the second would wait and then succeed instead of getting 409.
        try:
            lock_fd = os.open(_LOCK_PATH, os.O_CREAT | os.O_WRONLY, 0o600)
        except OSError as e:
            _json_response(self, 503, {"error": "lock_unavailable", "detail": str(e)})
            return
        try:
            import fcntl
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                _json_response(self, 409, {"error": "busy"})
                return
            try:
                report = self._run_execute(cats, plan_id, request_id)
            finally:
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                except OSError:
                    pass
        finally:
            os.close(lock_fd)

        if report is None:
            return  # _run_execute already responded (plan_changed etc.)
        with _cache_lock:
            if len(_request_cache) >= 100:
                _request_cache.pop(next(iter(_request_cache)))
            _request_cache[request_id] = report
        _audit_log(RESET_ROOT, report)
        status = 200 if report["status"] == "ok" else 207
        _json_response(self, status, report)

    def _run_execute(self, cats, plan_id, request_id):
        # Re-preview internally; a changed plan aborts everything.
        plan, err = _compute_plan(RESET_ROOT, cats)
        if err:
            _json_response(self, 409 if "path_not_allowed" in err else 400, {"error": err})
            return None
        if plan["plan_id"] != plan_id:
            _json_response(self, 409, {"error": "plan_changed"})
            return None

        active = _active_provider_id(RESET_ROOT)

        # Chats idle gate: refuse while the agent is actively writing.
        if "chats" in cats:
            idle, reason = _chats_idle_gate(RESET_ROOT)
            if not idle:
                _json_response(self, 409, {"error": "agent_active", "detail": reason})
                return None

        per_category = []
        overall = "ok"
        total_freed = 0
        total_deleted = 0
        for cid in cats:
            rep = _execute_category(RESET_ROOT, cid, active)
            per_category.append(rep)
            total_freed += rep["bytes_freed"]
            total_deleted += rep["files_deleted"]
            if rep["status"] != "ok":
                overall = "partial"
        # Lessons superseded by Memories: report it, don't silently drop it.
        if rc.lessons_superseded(cats):
            per_category.append({"id": "lessons", "status": "ok", "bytes_freed": 0,
                                 "files_deleted": 0, "errors": [],
                                 "skipped": [{"path": "", "reason": "superseded_by_memories"}]})

        # Reconcile marker for Chats: record the chats.json hash so a later
        # preview can detect the live process re-persisting its in-memory list.
        if "chats" in cats:
            try:
                marker = os.path.join(RESET_ROOT, "working", ".reset_pending_reconcile")
                hashes = {}
                for w in rc.workspace_dirs(RESET_ROOT):
                    cj = os.path.join(w, "chats.json")
                    try:
                        with open(cj, "rb") as f:
                            hashes[cj] = hashlib.sha256(f.read()).hexdigest()
                    except OSError:
                        pass
                with open(marker, "w") as f:
                    json.dump({"request_id": request_id, "chats": hashes}, f)
            except OSError:
                pass

        return {
            "status": overall,
            "plan_id": plan_id,
            "request_id": request_id,
            "per_category": per_category,
            "totals": {"bytes_freed": total_freed, "files_deleted": total_deleted},
        }


def _selftest():
    """Machine-free selftest of reset_guard + reset_categories.

    Builds a fake tree in a tmpdir and asserts: the guard rejects auth.json,
    .env, kilo.json, ../../etc/passwd and an escaping symlink (and the tree
    is byte-identical after the attempts); a normal deletable path passes;
    the categories table excludes the active provider, excludes MEMORY.md
    from Workspaces, and maps Lessons to a section rewrite. Prints
    "reset-broker selftest: N passed, 0 failed" and returns an exit code.
    """
    import tempfile
    passed = 0
    failed = 0

    def check(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
        else:
            failed += 1
            print("  FAIL: %s %s" % (name, detail))

    root = tempfile.mkdtemp(prefix="reset-selftest-")
    try:
        W = os.path.join(root, "working", "workspaces", "default")
        secret = os.path.join(root, "working.secret")
        for d in [W, os.path.join(secret, "providers", "builtin"),
                  os.path.join(secret, "providers", "custom"),
                  os.path.join(root, "working", "skill_pool")]:
            os.makedirs(d, exist_ok=True)
        for rel, content in [
            ("working.secret/auth.json", "{}"),
            ("working.secret/providers/builtin/kilo.json", "{}"),
            ("working.secret/providers/active_model.json",
             json.dumps({"provider_id": "mosicn", "model": "nex-n2.6"})),
            ("working.secret/providers/custom/mosicn.json", "{}"),
            ("working.secret/providers/custom/xingchiapi.json", "{}"),
            (".env", "RESET_TOKEN=x\n"),
            ("working/qwenpaw.log", "log\n"),
            ("working/governance/audit.db", "audit"),
            ("working/workspaces/default/MEMORY.md", "# M\n\n## Important decisions and lessons\n\n- l\n"),
            ("working/workspaces/default/skill.json", "{}"),
        ]:
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as f:
                f.write(content)
        # Escaping symlink.
        evil = os.path.join(W, "evil-link")
        try:
            os.symlink("/etc", evil)
        except OSError:
            evil = None

        def tree_hash():
            out = []
            for dirpath, _dirs, files in os.walk(root):
                for name in sorted(files):
                    p = os.path.join(dirpath, name)
                    try:
                        out.append("%s:%d" % (p, os.path.getsize(p)))
                    except OSError:
                        pass
            return "|".join(out)

        before = tree_hash()

        # Guard rejects protected paths.
        for rel in ["working.secret/auth.json", ".env",
                    "working.secret/providers/builtin/kilo.json",
                    "working.secret/providers/active_model.json",
                    "working/governance/audit.db"]:
            p = os.path.join(root, rel)
            ok, _reason = rg.check_target(root, ("delete", p))
            check("guard rejects %s" % rel, not ok)
        # Escape attempts.
        ok, _ = rg.check_target(root, ("delete", "/etc/passwd"))
        check("guard rejects /etc/passwd", not ok)
        ok, _ = rg.check_target(root, ("delete", os.path.join(root, "..", "..", "etc", "passwd")))
        check("guard rejects ../../etc/passwd", not ok)
        if evil:
            ok, _ = rg.check_target(root, ("delete", evil))
            check("guard rejects escaping symlink", not ok)
            ok, _ = rg.check_target(root, ("delete", os.path.join(evil, "hostname")))
            check("guard rejects path through symlink", not ok)
        # A normal deletable path passes.
        ok, reason = rg.check_target(root, ("delete", os.path.join(root, "working", "qwenpaw.log")))
        check("guard allows working/qwenpaw.log", ok, reason)
        # Tree unchanged by all the rejections.
        check("tree identical after guard rejections", tree_hash() == before)

        # Categories: models excludes the active provider.
        models = rc.targets_for(root, "models", "mosicn")
        model_paths = [t[1] for t in models]
        check("models excludes active mosicn", all("mosicn" not in p for p in model_paths))
        check("models includes non-active xingchiapi", any("xingchiapi" in p for p in model_paths))
        check("models never lists active_model.json", all("active_model" not in p for p in model_paths))
        # Workspaces excludes MEMORY.md / skill.json / chats.json / history.db.
        ws = rc.targets_for(root, "workspaces")
        ws_paths = [t[1] for t in ws]
        check("workspaces excludes MEMORY.md", all("MEMORY.md" not in p for p in ws_paths))
        check("workspaces excludes skill.json", all("skill.json" not in p for p in ws_paths))
        # Lessons is a section rewrite, not a delete.
        les = rc.targets_for(root, "lessons")
        check("lessons is a section rewrite", len(les) == 1 and les[0][0] == "section"
              and les[0][2] == rc.LESSONS_HEADING)
        # Unknown category raises.
        try:
            rc.targets_for(root, "nope")
            check("unknown category raises", False)
        except ValueError:
            check("unknown category raises", True)
        # Lessons superseded by Memories.
        check("lessons superseded by memories", rc.lessons_superseded(["memories", "lessons"]))
        check("lessons not superseded alone", not rc.lessons_superseded(["lessons"]))
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print("reset-broker selftest: %d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


def main():
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    if not RESET_TOKEN:
        print("reset-broker: RESET_TOKEN unset — starting in fail-closed mode (all requests 503/401)", file=sys.stderr)
    server = ThreadingHTTPServer((RESET_BIND, RESET_PORT), Handler)
    print("reset-broker: listening on %s:%d root=%s" % (RESET_BIND, RESET_PORT, RESET_ROOT), file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
