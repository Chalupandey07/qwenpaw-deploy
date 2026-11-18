#!/usr/bin/env python3
"""Machine-free tests for per-run workspace snapshots + rollback (T127).

Exercises features/checkpoints/checkpoints.py on TEMPORARY scratch
directories only — never the real workspace, never the repo itself.
Every check runs the real CLI as a subprocess (the same commands an
operator or the agent would run), except the fail-first path, which
runs the same checks against a code file that has no snapshot/restore
implementation at all.

Usage:
    python3 test_checkpoints.py [--code PATH]
    python3 test_checkpoints.py --code /tmp/empty-checkpoints-stub.py
        # fail-first: must FAIL (no snapshot/restore exists)

Checks (a)-(f) from the T127 brief, plus the safety edges:
  (a) a snapshot captures the files before mutation
  (b) after mutation the restore returns the exact original bytes
  (c) restore REFUSES when there is uncommitted user work made after
      the snapshot (without --force), and leaves the workspace untouched
  (d) restore with --force proceeds and prints what was lost
  (e) list shows the snapshot with run ID + timestamp + size
  (f) the exclusion list keeps caches/logs/live DBs out of the snapshot
Plus: same-run-id snapshot is a first-wins no-op; a pre-restore safety
snapshot makes a restore reversible; a corrupt tarball refuses to
restore; a symlink escaping the workspace is skipped, not followed;
an invalid run id is rejected; restoring a missing snapshot fails.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(code: Path, *args: str):
    """Run the checkpoints CLI; returns (exit_code, stdout, stderr)."""
    proc = subprocess.run(
        [sys.executable, str(code), *args],
        capture_output=True, text=True, timeout=120,
    )
    return proc.returncode, proc.stdout, proc.stderr


def build_workspace(root: Path) -> dict[str, bytes]:
    """A small fake agent workspace. Returns {relpath: original bytes}."""
    files = {
        "notes.md": b"# run notes\n- step one\n",
        "src/main.py": b"print('hello')\n",
        "src/util.py": b"def f():\n    return 42\n",
        "config.json": b'{"model": "nex-n2.6"}\n',
        "empty-dir-marker/.keep": b"",
    }
    for rel, data in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    # Excluded bulk: caches, logs, live DB, session state, node_modules.
    bulk = {
        "__pycache__/main.cpython-312.pyc": b"\x00\x01\x02fake bytecode",
        "app.log": b"2026-11-18 log line\n" * 10,
        "history.db": b"FAKE-SQLITE-BYTES",
        "history.db-wal": b"FAKE-WAL-BYTES",
        "sessions/sess-1/state.json": b'{"turn": 9}',
        "node_modules/pkg/index.js": b"// bulk\n",
        "media/photo.png": b"\x89PNG fake bytes",
    }
    for rel, data in bulk.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", default=str(HERE / "checkpoints.py"))
    args = parser.parse_args()
    code = Path(args.code)
    print(f"code: {code}")

    with tempfile.TemporaryDirectory(prefix="ckpt-test-") as tmp:
        tmp_p = Path(tmp)
        ws = tmp_p / "workspace"
        ws.mkdir()
        store = ws / "checkpoints"
        originals = build_workspace(ws)

        # --- (a) snapshot captures the files before mutation -----------
        rc, out, err = run(code, "snapshot", "--workspace", str(ws),
                           "--run-id", "run-001")
        check("A1 snapshot exits 0", rc == 0, err or out)
        check("A2 snapshot names the run id", "run-001" in out, out)
        manifest_p = store / "run-001.json"
        tarball_p = store / "run-001.tgz"
        check("A3 manifest file exists", manifest_p.exists())
        check("A4 tarball file exists", tarball_p.exists())
        manifest = {}
        if manifest_p.exists():
            manifest = json.loads(manifest_p.read_text(encoding="utf-8"))
        else:
            manifest = {"files": {}}
        check("A5 manifest lists every workspace file",
              set(manifest.get("files", {})) == set(originals),
              f"got {sorted(manifest.get('files', {}))}")
        check("A6 manifest sha256 matches the original bytes",
              all(manifest.get("files", {}).get(rel, {}).get("sha256") == sha(ws / rel)
                  for rel in originals))
        check("A7 manifest records run id + timestamp + sizes",
              manifest.get("run_id") == "run-001"
              and bool(manifest.get("created_utc"))
              and manifest.get("file_count") == len(originals)
              and manifest.get("total_bytes", 0) > 0
              and manifest.get("tarball_sha256") == sha(tarball_p))

        # --- (f) exclusion list keeps caches/logs/live DB out ----------
        if manifest_p.exists():
            snap_names = set(manifest.get("files", {}))
            check("F1 __pycache__ excluded", not any("__pycache__" in n for n in snap_names))
            check("F2 *.log excluded", not any(n.endswith(".log") for n in snap_names))
            check("F3 history.db* excluded",
                  not any(n.startswith("history.db") for n in snap_names))
            check("F4 sessions/ excluded", not any(n.startswith("sessions/") for n in snap_names))
            check("F5 node_modules/ excluded", not any(n.startswith("node_modules/") for n in snap_names))
            check("F6 media/ excluded", not any(n.startswith("media/") for n in snap_names))
            check("F7 store dir itself excluded",
                  not any(n.startswith("checkpoints/") for n in snap_names))
        if tarball_p.exists():
            with tarfile.open(tarball_p, "r:gz") as tf:
                members = [m.name for m in tf.getmembers() if m.isfile()]
            check("F8 tarball contains no excluded file",
                  not any("history.db" in m or "__pycache__" in m or m.endswith(".log")
                          for m in members), f"{members}")

        # --- (e) list shows the snapshot -------------------------------
        rc, out, err = run(code, "list", "--store", str(store))
        check("E1 list exits 0", rc == 0, err or out)
        check("E2 list shows run id", "run-001" in out, out)
        check("E3 list shows timestamp", bool(manifest.get("created_utc"))
              and manifest.get("created_utc", "")[:10] in out, out)
        check("E4 list shows size (total bytes)",
              str(manifest.get("total_bytes", "")) in out, out)

        # --- same run id: first wins (no-op, not an overwrite) ---------
        (ws / "notes.md").write_bytes(b"# CHANGED after snapshot\n")
        rc, out, err = run(code, "snapshot", "--workspace", str(ws),
                           "--run-id", "run-001")
        check("N1 second snapshot of same run id exits 0 (no-op)", rc == 0, err or out)
        manifest2 = json.loads(manifest_p.read_text(encoding="utf-8")) \
            if manifest_p.exists() else {"files": {}}
        check("N2 second snapshot keeps the FIRST (pre-mutation) bytes",
              manifest2.get("files", {}).get("notes.md", {}).get("sha256")
              == hashlib.sha256(originals["notes.md"]).hexdigest())

        # --- (c) restore REFUSES on drift without --force --------------
        (ws / "src/main.py").write_bytes(b"print('MUTATED')\n")
        (ws / "new-file.txt").write_bytes(b"user work after snapshot\n")
        (ws / "src/util.py").unlink()
        before = {rel: (ws / rel).read_bytes() for rel in
                  ("notes.md", "src/main.py", "new-file.txt") if (ws / rel).exists()}
        rc, out, err = run(code, "restore", "--workspace", str(ws),
                           "--run-id", "run-001")
        check("C1 restore without --force refuses (nonzero exit)", rc != 0,
              f"exit={rc} out={out}")
        check("C2 refusal names the drift", "new-file.txt" in (out + err)
              and "src/main.py" in (out + err), out + err)
        check("C3 refused restore leaves the workspace untouched",
              (ws / "src/main.py").read_bytes() == before["src/main.py"]
              and (ws / "new-file.txt").read_bytes() == before["new-file.txt"]
              and not (ws / "src/util.py").exists())

        # --- (d) restore with --force proceeds, prints what was lost ---
        rc, out, err = run(code, "restore", "--workspace", str(ws),
                           "--run-id", "run-001", "--force")
        check("D1 restore --force exits 0", rc == 0, err or out)
        check("D2 --force prints what will be lost (added file)",
              "new-file.txt" in out, out)
        check("D3 --force prints what will be lost (modified file)",
              "src/main.py" in out, out)
        check("D4 --force prints what will be lost (deleted file)",
              "src/util.py" in out, out)
        check("D5 --force reports the safety snapshot",
              "safety snapshot" in out and "pre-restore-run-001-" in out, out)

        # --- (b) restore returns the exact original bytes --------------
        def readb(p: Path):
            return p.read_bytes() if p.exists() else None
        check("B1 mutated file is back to the original bytes",
              readb(ws / "notes.md") == originals["notes.md"])
        check("B2 mutated file is back to the original bytes (src)",
              readb(ws / "src/main.py") == originals["src/main.py"])
        check("B3 deleted file is back", readb(ws / "src/util.py")
              == originals["src/util.py"])
        check("B4 post-snapshot file is gone (exact snapshot state)",
              not (ws / "new-file.txt").exists())
        check("B5 every restored file matches its original sha256",
              all((ws / rel).exists()
                  and sha(ws / rel) == hashlib.sha256(data).hexdigest()
                  for rel, data in originals.items()))

        # --- safety snapshot makes the restore reversible --------------
        rc, out, err = run(code, "list", "--store", str(store))
        safety_id = None
        for line in out.splitlines():
            if "pre-restore-run-001-" in line:
                safety_id = line.split()[0]
        check("S1 a pre-restore safety snapshot exists", safety_id is not None, out)
        if safety_id:
            rc, out2, err2 = run(code, "restore", "--workspace", str(ws),
                                 "--run-id", safety_id, "--force")
            check("S2 restoring the safety snapshot exits 0", rc == 0, err2 or out2)
            check("S3 safety restore brings back the post-snapshot file",
                  (ws / "new-file.txt").read_bytes() == b"user work after snapshot\n")
            check("S4 safety restore brings back the mutated bytes",
                  (ws / "src/main.py").read_bytes() == b"print('MUTATED')\n")
            # Put the workspace back to the run-001 state for the
            # remaining checks.
            run(code, "restore", "--workspace", str(ws),
                "--run-id", "run-001", "--force")

        # --- corrupt tarball refuses to restore -------------------------
        rc, out, err = run(code, "snapshot", "--workspace", str(ws),
                           "--run-id", "run-002")
        check("X1 second snapshot exits 0", rc == 0, err or out)
        if (store / "run-002.tgz").exists():
            (store / "run-002.tgz").write_bytes(b"this is not a tarball")
        rc, out, err = run(code, "restore", "--workspace", str(ws),
                           "--run-id", "run-002", "--force")
        check("X2 corrupt tarball refuses to restore (nonzero exit)", rc != 0,
              f"exit={rc}")
        check("X3 corrupt tarball leaves the workspace untouched",
              (ws / "notes.md").exists()
              and (ws / "notes.md").read_bytes() == originals["notes.md"])

        # --- symlink escaping the workspace is skipped, not followed ----
        outside = tmp_p / "outside-secret.txt"
        outside.write_bytes(b"do not follow me\n")
        (ws / "escape-link").symlink_to(outside)
        rc, out, err = run(code, "snapshot", "--workspace", str(ws),
                           "--run-id", "run-003")
        check("L1 snapshot with an escaping symlink exits 0", rc == 0, err or out)
        m3 = json.loads((store / "run-003.json").read_text(encoding="utf-8")) \
            if (store / "run-003.json").exists() else {"files": {}, "skipped": []}
        check("L2 escaping symlink is NOT in the snapshot files",
              "escape-link" not in m3.get("files", {}))
        check("L3 escaping symlink is listed as skipped",
              any(s.get("path") == "escape-link" for s in m3.get("skipped", [])))
        (ws / "escape-link").unlink()

        # --- invalid run id / missing snapshot --------------------------
        rc, out, err = run(code, "snapshot", "--workspace", str(ws),
                           "--run-id", "../evil")
        check("V1 run id with '/' is rejected", rc != 0, f"exit={rc}")
        check("V2 no snapshot was created for the bad run id",
              not (store / ".." / "evil.tgz").exists()
              and not list(store.glob("*evil*")))
        rc, out, err = run(code, "restore", "--workspace", str(ws),
                           "--run-id", "no-such-run", "--force")
        check("V3 restoring a missing snapshot fails", rc != 0, f"exit={rc}")

        # --- list on an empty store --------------------------------------
        empty_store = tmp_p / "empty-store"
        empty_store.mkdir()
        rc, out, err = run(code, "list", "--store", str(empty_store))
        check("V4 list on an empty store exits 0 and says so",
              rc == 0 and "no snapshots" in out, out)

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
