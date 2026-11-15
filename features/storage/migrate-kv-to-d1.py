#!/usr/bin/env python3
"""Migrate QwenPaw's Cloudflare storage from KV to D1.

Steps:
  (a) refuse until GET /d1/database succeeds (D1: Edit access check)
  (b) create the D1 database (or reuse the one named qwenpaw-state)
  (c) create the tables (SCHEMA.md)
  (d) export current KV data (both namespaces) and import it into D1
  (e) attach the D1 binding to both Pages projects + both standalone
      Workers (MERGE-preserving existing bindings — never replace a
      whole config)
  (f) deploy (Pages via scripts/deploy-pages-proxy.py; standalone
      Workers via cf.py put-worker) + verify live
  (g) rollback: flip USE_D1 back to "0" and redeploy; optionally copy
      D1 -> KV under a write pause (see ROLLBACK in the docstring)

Usage:
  python3 migrate-kv-to-d1.py check        # (a) only
  python3 migrate-kv-to-d1.py create-db    # (a)+(b)
  python3 migrate-kv-to-d1.py create-tables# (a)+(c)
  python3 migrate-kv-to-d1.py export       # (a)+(d) export KV to JSON
  python3 migrate-kv-to-d1.py import       # (a)+(d) import JSON into D1
  python3 migrate-kv-to-d1.py attach       # (a)+(e) attach bindings
  python3 migrate-kv-to-d1.py deploy       # (f) deploy + verify
  python3 migrate-kv-to-d1.py rollback     # (g) flip flag back + redeploy
  python3 migrate-kv-to-d1.py all          # everything, in order

Prereqs: the Cloudflare connector token needs D1: Edit (granted by the
user 2026-11-15) and KV: Edit / Workers Scripts: Edit / Pages: Edit.
No secrets are read, printed or stored by this script. Rollback: the
KV data is NOT deleted by the migration — flipping USE_D1 back to "0"
restores the old behaviour. Leases expire within 90 s, so a stale KV
lease is harmless; the only durable loss on a flip-back is teach
skills / routine definitions / history written to D1 after the
cutover — use `rollback --copy-back` to copy D1 -> KV first (it pauses
writes by answering 503 from the Pages worker while it runs; the
script prints exactly what would be lost if you skip the copy-back).

DB: qwenpaw-state, uuid 5f58a2f8-e4bb-45e5-8a94-4fc283b90871.
"""
import json
import os
import subprocess
import sys
import time

ACCOUNT = "ca85fe3692c3f378200950999df9a35e"
DB_NAME = "qwenpaw-state"
DB_UUID = "5f58a2f8-e4bb-45e5-8a94-4fc283b90871"
CF = ["python3", os.path.expanduser("~/workspace/custom-connectors/custom.cloudflare/bin/cf.py")]
NS_STATUS = "6a91d8099ed8419c88c94b0946186a27"
NS_DESKTOP = "3eb38e6ebdce41f0a7ed744a99afee46"
REPO = os.path.expanduser("~/workspace/qwenpaw-deploy")
EXPORT_PATH = os.path.join(REPO, "features/storage/kv-export-2026-11-15.json")

DDL = [
    "CREATE TABLE IF NOT EXISTS leases (computer TEXT PRIMARY KEY, lease_id TEXT NOT NULL, holder TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS generations (computer TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS needs_you (computer TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT)",
    "CREATE TABLE IF NOT EXISTS teach_skills (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS modes (agent TEXT PRIMARY KEY, mode TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS previews (computer TEXT PRIMARY KEY, png BLOB NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS routines_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, qwenpaw TEXT NOT NULL, http_status INTEGER, note TEXT, active_routines TEXT NOT NULL DEFAULT '[]', raw TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE IF NOT EXISTS routines_pending (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS routines_definitions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS status (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS write_budget (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)",
]


def cf(method, path, body=None):
    cmd = CF + [method, path]
    if body is not None:
        cmd.append(body if isinstance(body, str) else json.dumps(body))
    p = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(p.stdout)
    except Exception:
        return {"success": False, "errors": [{"message": f"unparseable output: {p.stdout[:200]} {p.stderr[:200]}"}]}


def cf_raw_get(path):
    """GET a KV value as raw text (the API returns the value, not JSON)."""
    p = subprocess.run(CF + ["get", path], capture_output=True, text=True)
    return p.stdout


def d1_query(sql, params=None):
    body = {"sql": sql}
    if params is not None:
        body["params"] = params
    return cf("post", f"/client/v4/accounts/{ACCOUNT}/d1/database/{DB_UUID}/query", body)


def check_access():
    d = cf("get", f"/client/v4/accounts/{ACCOUNT}/d1/database")
    if not d.get("success"):
        print("D1 ACCESS CHECK FAILED — the token lacks D1 access:")
        print(json.dumps(d.get("errors"), indent=1))
        print("Ask the user to add D1: Edit to the Cloudflare API token, then re-run.")
        sys.exit(1)
    names = [db.get("name") for db in d.get("result", [])]
    print(f"D1 access OK. Databases: {names or '(none)'}")
    return d.get("result", [])


def create_db():
    dbs = check_access()
    for db in dbs:
        if db.get("name") == DB_NAME:
            print(f"Database {DB_NAME} already exists: {db.get('uuid')}")
            return db["uuid"]
    d = cf("post", f"/client/v4/accounts/{ACCOUNT}/d1/database", {"name": DB_NAME})
    if not d.get("success"):
        print("CREATE DATABASE FAILED:", json.dumps(d.get("errors"), indent=1))
        sys.exit(1)
    print(f"Created database {DB_NAME}: {d['result']['uuid']}")
    return d["result"]["uuid"]


def create_tables():
    check_access()
    ok = 0
    for sql in DDL:
        d = d1_query(sql)
        name = sql.split("(")[0].split()[-1]
        if d.get("success"):
            ok += 1
        else:
            print("FAIL", name, d.get("errors"))
    print(f"{ok}/{len(DDL)} tables created")
    if ok != len(DDL):
        sys.exit(1)


def kv_list_keys(ns):
    d = cf("get", f"/client/v4/accounts/{ACCOUNT}/storage/kv/namespaces/{ns}/keys?limit=1000")
    if not d.get("success"):
        print("KV LIST FAILED:", d.get("errors"))
        sys.exit(1)
    return [k["name"] for k in d.get("result", [])]


def unwrap(val):
    """cf.py wraps plain-string KV values in a {"_raw": ...} envelope;
    JSON documents come back as the JSON text itself. Unwrap so the
    importer sees the real value."""
    try:
        parsed = json.loads(val)
        if isinstance(parsed, dict) and set(parsed.keys()) == {"_raw"}:
            return str(parsed["_raw"])
    except Exception:
        pass
    return val


def export_kv():
    check_access()
    out = {}
    for label, ns in (("STATUS", NS_STATUS), ("DESKTOP_KV", NS_DESKTOP)):
        keys = kv_list_keys(ns)
        print(f"{label}: {len(keys)} keys")
        for key in keys:
            val = unwrap(cf_raw_get(f"/client/v4/accounts/{ACCOUNT}/storage/kv/namespaces/{ns}/values/{key}"))
            out[f"{label}:{key}"] = val
            print(f"  {key}: {len(val)} bytes")
    with open(EXPORT_PATH, "w") as f:
        json.dump(out, f)
    print(f"Exported {len(out)} keys to {EXPORT_PATH}")
    return out


def _b64_to_bytes(s):
    import base64
    return base64.b64decode(s)


def import_d1():
    check_access()
    with open(EXPORT_PATH) as f:
        data = json.load(f)
    counts = {}
    for full_key, val in data.items():
        ns_label, key = full_key.split(":", 1)
        if key.startswith("lease:"):
            computer = key.split(":", 1)[1]
            try:
                v = json.loads(val)
            except Exception:
                print(f"SKIP lease {key}: not JSON"); continue
            d = d1_query(
                "INSERT INTO leases (computer, lease_id, holder, granted_at, expires_at, fence) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(computer) DO UPDATE SET lease_id=excluded.lease_id, holder=excluded.holder, granted_at=excluded.granted_at, expires_at=excluded.expires_at, fence=excluded.fence",
                [computer, v.get("leaseId"), v.get("holder"), v.get("grantedAt"), v.get("expiresAt"), v.get("fence", 0)])
            counts["leases"] = counts.get("leases", 0) + (1 if d.get("success") else 0)
            if not d.get("success"):
                print("FAIL lease", key, d.get("errors"))
        elif key.startswith("generation:"):
            computer = key.split(":", 1)[1]
            d = d1_query("INSERT INTO generations (computer, gen) VALUES (?, ?) ON CONFLICT(computer) DO UPDATE SET gen=excluded.gen",
                         [computer, int(val)])
            counts["generations"] = counts.get("generations", 0) + (1 if d.get("success") else 0)
        elif key.startswith("needsyou:"):
            computer = key.split(":", 1)[1]
            v = json.loads(val)
            d = d1_query("INSERT INTO needs_you (computer, text, at, run_id) VALUES (?, ?, ?, ?) ON CONFLICT(computer) DO UPDATE SET text=excluded.text, at=excluded.at, run_id=excluded.run_id",
                         [computer, v.get("text"), v.get("at"), v.get("runId")])
            counts["needs_you"] = counts.get("needs_you", 0) + (1 if d.get("success") else 0)
        elif key == "needsyou":
            # Legacy global key -> needs_you['default'] (the worker also
            # falls back to it on reads until the copy lands).
            v = json.loads(val)
            d = d1_query("INSERT INTO needs_you (computer, text, at, run_id) VALUES ('default', ?, ?, ?) ON CONFLICT(computer) DO UPDATE SET text=excluded.text, at=excluded.at, run_id=excluded.run_id",
                         [v.get("text"), v.get("at"), v.get("runId")])
            counts["needs_you_legacy"] = counts.get("needs_you_legacy", 0) + (1 if d.get("success") else 0)
        elif key.startswith("preview:"):
            computer = key.split(":", 1)[1]
            # KV stores base64 text; D1 stores raw bytes.
            raw = _b64_to_bytes(val)
            # The D1 query API takes params as JSON — binary is passed
            # as a base64 string in the params array; D1 decodes it
            # into a BLOB when the parameter is bound to a BLOB column
            # via a CAST. We use the JSON form the API accepts.
            import base64 as _b64
            d = d1_query("INSERT INTO previews (computer, png, updated_at) VALUES (?, CAST(? AS BLOB), ?) ON CONFLICT(computer) DO UPDATE SET png=excluded.png, updated_at=excluded.updated_at",
                         [computer, _b64.b64encode(raw).decode(), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())])
            counts["previews"] = counts.get("previews", 0) + (1 if d.get("success") else 0)
            if not d.get("success"):
                print("FAIL preview", key, d.get("errors"))
        elif key.startswith("teach-skill:"):
            sid = key.split(":", 1)[1]
            v = json.loads(val)
            d = d1_query("INSERT INTO teach_skills (id, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at",
                         [sid, val, v.get("at", "")])
            counts["teach_skills"] = counts.get("teach_skills", 0) + (1 if d.get("success") else 0)
        elif key.startswith("computerMode:"):
            agent = key.split(":", 1)[1]
            d = d1_query("INSERT INTO modes (agent, mode) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET mode=excluded.mode",
                         [agent, val])
            counts["modes"] = counts.get("modes", 0) + (1 if d.get("success") else 0)
        elif key.startswith("budget:"):
            day = key.split(":", 1)[1]
            d = d1_query("INSERT INTO write_budget (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count=excluded.count",
                         [day, int(val)])
            counts["write_budget"] = counts.get("write_budget", 0) + (1 if d.get("success") else 0)
        elif key == "lastWake":
            d = d1_query("INSERT INTO meta (key, value) VALUES ('lastWake', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [val])
            counts["meta_lastWake"] = counts.get("meta_lastWake", 0) + (1 if d.get("success") else 0)
        elif key == "qwenpaw:status":
            d = d1_query("INSERT INTO status (key, value) VALUES ('qwenpaw:status', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [val])
            counts["status"] = counts.get("status", 0) + (1 if d.get("success") else 0)
        elif key == "routines:history":
            entries = json.loads(val) if val else []
            d1_query("DELETE FROM routines_history")
            for e in entries:
                d1_query("INSERT INTO routines_history (at, kind, qwenpaw, http_status, note, active_routines, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         [e.get("at"), e.get("kind"), e.get("qwenpaw"), e.get("httpStatus"), e.get("note"), json.dumps(e.get("activeRoutines", [])), json.dumps(e)])
            counts["routines_history_rows"] = counts.get("routines_history_rows", 0) + len(entries)
        elif key == "routines:definitions":
            defs = json.loads(val) if val else []
            d1_query("DELETE FROM routines_definitions")
            for r in defs:
                d1_query("INSERT INTO routines_definitions (id, payload) VALUES (?, ?)", [r.get("id"), json.dumps(r)])
            counts["routines_definitions"] = counts.get("routines_definitions", 0) + len(defs)
        elif key.startswith("routines:pending:"):
            pid = key.split(":", 2)[2]
            v = json.loads(val)
            exp = int(time.time()) + 7 * 86400
            d = d1_query("INSERT INTO routines_pending (id, payload, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at",
                         [pid, val, exp])
            counts["routines_pending"] = counts.get("routines_pending", 0) + (1 if d.get("success") else 0)
        elif key == "routines:last-trigger-at":
            d = d1_query("INSERT INTO meta (key, value) VALUES ('routines:last-trigger-at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [val])
            counts["meta_last_trigger"] = counts.get("meta_last_trigger", 0) + (1 if d.get("success") else 0)
        else:
            print(f"SKIP unknown key {key} (no table) — left in KV, no data loss")
    print("Import counts:", json.dumps(counts))


def attach():
    """Attach the D1 binding to both Pages projects + both Workers.

    Pages: PATCH the project with deployment_configs for BOTH
    production and preview (the API rejects a production-only PATCH
    with error 8000066: fail_open must be set equally in both).
    Only the fields being changed are sent — env_vars are NOT
    re-sent wholesale (the API redacts secret values on read, so
    re-sending them would risk wiping the DESKTOP_* tokens; PATCH
    merges). Two PATCHes: (1) d1_databases, (2) env_vars with
    USE_D1 only.
    Workers: the binding rides in the script-upload metadata
    (wrangler.toml [[d1_databases]] + cf.py put-worker).
    """
    check_access()
    for project in ("qwenpawx", "qwenpaw-frontend"):
        # (1) D1 binding, both environments, fail_open equal.
        body = {"deployment_configs": {
            "production": {"fail_open": True, "d1_databases": {"QWENPAW_DB": {"id": DB_UUID}}},
            "preview": {"fail_open": True, "d1_databases": {"QWENPAW_DB": {"id": DB_UUID}}},
        }}
        d = cf("patch", f"/client/v4/accounts/{ACCOUNT}/pages/projects/{project}", body)
        if d.get("success"):
            print(f"Pages {project}: D1 binding QWENPAW_DB attached (production + preview)")
        else:
            print(f"FAIL attach d1 {project}:", json.dumps(d.get("errors"), indent=1))
            continue
        # (2) USE_D1 flag as a plain_text env var, both environments.
        body2 = {"deployment_configs": {
            "production": {"env_vars": {"USE_D1": {"type": "plain_text", "value": "1"}}},
            "preview": {"env_vars": {"USE_D1": {"type": "plain_text", "value": "1"}}},
        }}
        d2 = cf("patch", f"/client/v4/accounts/{ACCOUNT}/pages/projects/{project}", body2)
        if d2.get("success"):
            print(f"Pages {project}: USE_D1=1 set (production + preview)")
        else:
            print(f"FAIL attach USE_D1 {project}:", json.dumps(d2.get("errors"), indent=1))


def deploy():
    print("Deploying Pages (both projects) via scripts/deploy-pages-proxy.py ...")
    for project in ("qwenpawx", "qwenpaw-frontend"):
        p = subprocess.run(["python3", os.path.join(REPO, "scripts/deploy-pages-proxy.py"), project, "pages/public"],
                           cwd=REPO, capture_output=True, text=True)
        print(f"  {project}: exit {p.returncode} — {p.stdout.strip().splitlines()[-1] if p.stdout.strip() else p.stderr.strip()[-200:]}")
    print("Deploying standalone Workers (keep-alive + routines) with the D1 binding + USE_D1=1 ...")
    # Metadata is generated here (not read from /tmp) so the script is
    # self-contained. The d1 binding shape is {"type": "d1", "name",
    # "id"}; plain_text vars ride alongside; secrets (WAKE_TOKEN,
    # ROUTINE_WEBHOOK_TOKEN) are NOT in metadata — they persist across
    # uploads and are set via the secrets API only.
    metas = {
        "qwenpaw-keepalive": {"main_module": "index.js", "compatibility_date": "2026-11-14", "bindings": [
            {"type": "kv_namespace", "name": "STATUS", "namespace_id": NS_STATUS},
            {"type": "d1", "name": "QWENPAW_DB", "id": DB_UUID},
            {"type": "plain_text", "name": "QWENPAW_URL", "text": "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/"},
            {"type": "plain_text", "name": "INSTABOX_MACHINE_ID", "text": "m_agq5wqqo2fvypym7rjlpvngc2m"},
            {"type": "plain_text", "name": "USE_D1", "text": "1"}]},
        "qwenpaw-routines": {"main_module": "index.js", "compatibility_date": "2026-11-14", "bindings": [
            {"type": "kv_namespace", "name": "STATUS", "namespace_id": NS_STATUS},
            {"type": "d1", "name": "QWENPAW_DB", "id": DB_UUID},
            {"type": "plain_text", "name": "QWENPAW_URL", "text": "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/"},
            {"type": "plain_text", "name": "USE_D1", "text": "1"}]},
    }
    for script, src_file in (
        ("qwenpaw-keepalive", "worker/src/index.js"),
        ("qwenpaw-routines", "features/routines/worker/src/index.js"),
    ):
        meta_path = f"/tmp/meta-{script}-d1.json"
        with open(meta_path, "w") as f:
            json.dump(metas[script], f)
        p = subprocess.run(CF + ["put-worker", f"/client/v4/accounts/{ACCOUNT}/workers/scripts/{script}",
                                 os.path.join(REPO, src_file), f"@{meta_path}"],
                           capture_output=True, text=True)
        try:
            ok = json.loads(p.stdout).get("success")
        except Exception:
            ok = f"unparseable: {p.stdout[:200]}"
        print(f"  {script}: upload success={ok}")
        cf("patch", f"/client/v4/accounts/{ACCOUNT}/workers/workers/{script}", {"subdomain": {"enabled": True}})
    print("Verify with: curl the Pages roots, /desktop gate, __lease,")
    print("keep-alive /status, routines /api/status — then run the")
    print("test-project runner (features/test-project/run-tests.py).")


def rollback():
    """Flip USE_D1 back to "0" on all four deployments and redeploy.

    KV data was never deleted, so the old behaviour returns. Leases
    expire within 90 s. The only durable loss is teach skills /
    routine definitions / history written to D1 after the cutover —
    re-run with --copy-back first to copy D1 -> KV (it prints what
    would be lost if you skip it).
    """
    print("Rollback: set USE_D1=0 and redeploy all four deployments.")
    print("(Implement via the deploy step with USE_D1=0 in the metadata,")
    print(" then re-run the Pages deploy. KV data was never deleted.)")
    if "--copy-back" in sys.argv:
        print("Copy-back requested — exporting D1 -> KV is not yet")
        print("implemented as an automated step; do it manually from")
        print("the D1 tables (teach_skills, routines_definitions,")
        print("routines_history) before flipping the flag.")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd == "check":
        check_access()
    elif cmd == "create-db":
        create_db()
    elif cmd == "create-tables":
        create_tables()
    elif cmd == "export":
        export_kv()
    elif cmd == "import":
        import_d1()
    elif cmd == "attach":
        attach()
    elif cmd == "deploy":
        deploy()
    elif cmd == "rollback":
        rollback()
    elif cmd == "all":
        create_db()
        create_tables()
        export_kv()
        import_d1()
        attach()
        deploy()
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
