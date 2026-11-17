#!/usr/bin/env python3
"""Provision the sleep/wake secrets in one coordinated pass (2026-11-17).

Generates two secrets (os.urandom(32).hex(), in-memory only, NEVER printed,
logged, or stored locally) and sets them where they are needed:

  REPORTER_TOKEN — keep-alive Worker secret + /data/home/qwenpaw/.env
                   (the machine reporter authenticates POST /report with it).
  SLEEP_TOKEN    — keep-alive Worker secret + BOTH Pages projects
                   (the keep-alive Worker authenticates POST
                   /api/machine/sleep on Pages with it; Pages suspends via
                   INSTABOX_API_KEY, which it already holds).

Why one script: Cloudflare secret values are WRITE-ONLY. If the two sides
of a shared secret are set in separate steps, a typo or a re-run produces
two different values and the auth silently fails. This script generates
each value ONCE and sets every copy from that one value.

Pattern copied from scripts/provision-vault-master-secret.py (same
rotate-secrets discipline).

Usage: python3 scripts/provision-sleepwake-secrets.py
Requires: cf.py (Cloudflare connector), ib.py (InstaBox connector).
Prints only OK/FAIL per step, never a secret value.
"""

import json
import os
import secrets
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CF = os.path.join(os.path.expanduser("~"), "workspace", "custom-connectors", "custom.cloudflare", "bin", "cf.py")
IB = os.path.join(os.path.expanduser("~"), "workspace", "custom-connectors", "custom.instabox", "bin", "ib.py")
ACCOUNT_ID = "ca85fe3692c3f378200950999df9a35e"
MACHINE_ID = "m_agq5wqqo2fvypym7rjlpvngc2m"
KEEPALIVE = "qwenpaw-keepalive"
PAGES_PROJECTS = ["qwenpawx", "qwenpaw-frontend"]


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def cf_put_secret(worker, name, value):
    """Set a secret on a Worker via PUT /workers/scripts/{name}/secrets."""
    payload = json.dumps({"name": name, "text": value, "type": "secret_text"})
    r = run(["python3", CF, "put",
             f"/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/{worker}/secrets",
             payload])
    try:
        d = json.loads(r.stdout)
        return bool(d.get("success"))
    except (ValueError, AttributeError):
        return False


def cf_patch_pages_secret(project, name, value):
    """Set a secret on a Pages project (PATCH merges deployment_configs)."""
    body = {"deployment_configs": {
        "production": {"env_vars": {name: {"type": "secret_text", "value": value}}},
        "preview": {"env_vars": {name: {"type": "secret_text", "value": value}}},
    }}
    r = run(["python3", CF, "patch",
             f"/client/v4/accounts/{ACCOUNT_ID}/pages/projects/{project}",
             json.dumps(body)])
    try:
        d = json.loads(r.stdout)
        return bool(d.get("success"))
    except (ValueError, AttributeError):
        return False


def ib_exec(payload):
    """Run a command on the machine via ib.py exec (payload dict -> JSON file)."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        path = f.name
    try:
        r = run(["python3", IB, "exec", MACHINE_ID, path])
        return r
    finally:
        os.unlink(path)


def main():
    reporter_token = secrets.token_hex(32)
    sleep_token = secrets.token_hex(32)
    ok = True

    def step(label, fn):
        nonlocal ok
        try:
            good = fn()
        except Exception as e:  # noqa: BLE001 - report, do not crash mid-provision
            print(f"FAIL {label}: {e}")
            ok = False
            return
        print(("OK   " if good else "FAIL ") + label)
        if not good:
            ok = False

    # 1. keep-alive Worker secrets.
    step("keepalive REPORTER_TOKEN", lambda: cf_put_secret(KEEPALIVE, "REPORTER_TOKEN", reporter_token))
    step("keepalive SLEEP_TOKEN", lambda: cf_put_secret(KEEPALIVE, "SLEEP_TOKEN", sleep_token))

    # 2. Pages secrets (both projects).
    for proj in PAGES_PROJECTS:
        step(f"pages {proj} SLEEP_TOKEN", lambda p=proj: cf_patch_pages_secret(p, "SLEEP_TOKEN", sleep_token))

    # 3. Machine .env: append REPORTER_TOKEN (only if not already present).
    # The updater runs ON the machine (a local temp file is not visible
    # there), so the token travels inside the updater script, base64-encoded,
    # and is never printed. The .env is mode 600.
    import base64
    updater = (
        "import os\n"
        "p='/data/home/qwenpaw/.env'\n"
        "tok=__TOKEN__\n"
        "lines=open(p).read().splitlines() if os.path.exists(p) else []\n"
        "have=any(l.startswith('REPORTER_TOKEN=') for l in lines)\n"
        "lines=[l for l in lines if not l.startswith('REPORTER_TOKEN=')]\n"
        "lines.append('REPORTER_TOKEN='+tok)\n"
        "open(p,'w').write('\\n'.join(lines)+'\\n')\n"
        "os.chmod(p,0o600)\n"
        "print('REPORTER_TOKEN_UPDATED' if not have else 'REPORTER_TOKEN_REPLACED')\n"
    ).replace("__TOKEN__", repr(reporter_token))
    b64 = base64.b64encode(updater.encode()).decode()
    r = ib_exec({"cmd": f"python3 -c \"import base64; exec(base64.b64decode('{b64}'))\"", "timeoutSeconds": 60})
    out = (r.stdout or "") + (r.stderr or "")
    good = "REPORTER_TOKEN_UPDATED" in out or "REPORTER_TOKEN_REPLACED" in out
    print(("OK   " if good else "FAIL ") + "machine .env REPORTER_TOKEN")
    if not good:
        ok = False
        print("     machine output:", out[:300])

    # 4. Verify presence only (never the values).
    r = ib_exec({"cmd": "grep -c '^REPORTER_TOKEN=' /data/home/qwenpaw/.env; stat -c '%a' /data/home/qwenpaw/.env", "timeoutSeconds": 30})
    print("     machine .env check:", (r.stdout or "").strip().replace("\n", " "))
    print("OK   provision complete" if ok else "FAIL provision had failures (see above)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
