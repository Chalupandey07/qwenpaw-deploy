#!/usr/bin/env python3
"""Push local repo files to Ratulbaba7/qwenpaw-deploy (main) via the GitHub
Contents API through gh.py (classic token). One commit message for all files.

Usage:
  python3 scripts/gh-push.py "commit message" <repo-path> [<repo-path> ...]

For each file: GET its current sha (404 = new file, no sha needed), then PUT
base64 content. Prints the commit sha per file. Aborts on any non-404 error.
Local paths are resolved from the repo root (parent of scripts/).
"""
import base64
import json
import subprocess
import sys
from pathlib import Path

REPO = "Ratulbaba7/qwenpaw-deploy"
GH = ["python3", str(Path.home() / "workspace/custom-connectors/custom.github/bin/gh.py")]
ROOT = Path(__file__).resolve().parent.parent


def gh(*args):
    p = subprocess.run(GH + list(args), capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout, p.stderr


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    message, files = sys.argv[1], sys.argv[2:]
    for rel in files:
        local = ROOT / rel
        if not local.is_file():
            print(f"SKIP {rel}: no such local file")
            sys.exit(1)
        content = base64.b64encode(local.read_bytes()).decode()
        rc, out, err = gh("get", f"/repos/{REPO}/contents/{rel}")
        sha = None
        if rc == 0:
            try:
                sha = json.loads(out)["sha"]
            except Exception:
                print(f"ABORT {rel}: GET succeeded but no sha: {out[:200]}")
                sys.exit(1)
        elif "404" not in (out + err):
            print(f"ABORT {rel}: GET failed rc={rc}: {(err or out)[:300]}")
            sys.exit(1)
        body = {"message": message, "content": content, "branch": "main"}
        if sha:
            body["sha"] = sha
        put_file = Path("/tmp/gh-push-body.json")
        put_file.write_text(json.dumps(body))
        rc, out, err = gh(
            "put", f"/repos/{REPO}/contents/{rel}", str(put_file)
        )
        if rc != 0:
            print(f"ABORT {rel}: PUT failed rc={rc}: {(err or out)[:500]}")
            sys.exit(1)
        try:
            commit = json.loads(out)["commit"]["sha"]
        except Exception:
            commit = "?"
        print(f"OK {rel} commit={commit[:12] if commit != '?' else '?'}")
    print(f"pushed {len(files)} file(s): {message}")


if __name__ == "__main__":
    main()
