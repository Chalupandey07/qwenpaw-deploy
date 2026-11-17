#!/usr/bin/env python3
"""Provision the Settings Reset token in one coordinated pass (2026-11-18).

Generates one token (secrets.token_hex(32), in-memory only, NEVER printed,
logged, or stored locally) and sets it where it is needed:

  RESET_TOKEN — BOTH Pages projects (qwenpawx, qwenpaw-frontend) as a secret
                (the /reset router authenticates the broker with it) AND
                /data/home/qwenpaw/.env (the reset broker reads it via the
                systemd EnvironmentFile) AND
                /data/home/qwenpaw/working.secret/reset-broker.token (0600,
                parity with vault-broker.token).
  RESET_BROKER_URL — BOTH Pages projects as a plain env var
                (http://172.18.0.1:8895; the router defaults to this when
                unset, but being explicit avoids a silent wrong default).

Why one script: Cloudflare secret values are WRITE-ONLY. If the two sides
of a shared secret are set in separate steps, a typo or a re-run produces
two different values and the auth silently fails. This script generates
the value ONCE and sets every copy from that one value.

Pattern copied from scripts/provision-sleepwake-secrets.py (same
rotate-secrets discipline).

Usage: python3 scripts/provision-reset-token.py
Requires: cf.py (Cloudflare connector), ib.py (InstaBox connector).
Prints only OK/FAIL per step, never a secret value.
"""

import base64
import json
import os
import secrets
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CF = os.path.join(os.path.expanduser("~"), "workspace", "custom-connectors", "custom.cloudflare", "bin", "cf.py")
IB = os.path.join(os.path.expanduser("~"), "workspace", "custom-connectors", "custom.instabox", "bin", "ib.py")
ACCOUNT_ID = "ca85fe3692c3f378200950999df9a35e"
MACHINE_ID = "m_agq5wqqo2fvypym7rjlpvngc2m"
PAGES_PROJECTS = ["qwenpawx", "qwenpaw-frontend"]
BROKER_URL = "http://172.18.0.1:8895"


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def cf_patch_pages(project, name, value, var_type):
    """Set an env var on a Pages project (PATCH merges deployment_configs)."""
    body = {"deployment_configs": {
        "production": {"env_vars": {name: {"type": var_type, "value": value}}},
        "preview": {"env_vars": {name: {"type": var_type, "value": value}}},
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
    token = secrets.token_hex(32)
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

    # 1. Pages secrets + plain var (both projects).
    for proj in PAGES_PROJECTS:
        step(f"pages {proj} RESET_TOKEN", lambda p=proj: cf_patch_pages(p, "RESET_TOKEN", token, "secret_text"))
        step(f"pages {proj} RESET_BROKER_URL", lambda p=proj: cf_patch_pages(p, "RESET_BROKER_URL", BROKER_URL, "plain_text"))

    # 2. Machine .env: set RESET_TOKEN (replace if present, else append).
    # The updater runs ON the machine, so the token travels inside the
    # updater script, base64-encoded, and is never printed. .env is 600.
    updater = (
        "import os\n"
        "p='/data/home/qwenpaw/.env'\n"
        "tok=__TOKEN__\n"
        "lines=open(p).read().splitlines() if os.path.exists(p) else []\n"
        "have=any(l.startswith('RESET_TOKEN=') for l in lines)\n"
        "lines=[l for l in lines if not l.startswith('RESET_TOKEN=')]\n"
        "lines.append('RESET_TOKEN='+tok)\n"
        "open(p,'w').write('\\n'.join(lines)+'\\n')\n"
        "os.chmod(p,0o600)\n"
        "print('RESET_TOKEN_UPDATED' if not have else 'RESET_TOKEN_REPLACED')\n"
    ).replace("__TOKEN__", repr(token))
    b64 = base64.b64encode(updater.encode()).decode()
    r = ib_exec({"cmd": f"python3 -c \"import base64; exec(base64.b64decode('{b64}'))\"", "timeoutSeconds": 60})
    out = (r.stdout or "") + (r.stderr or "")
    good = "RESET_TOKEN_UPDATED" in out or "RESET_TOKEN_REPLACED" in out
    print(("OK   " if good else "FAIL ") + "machine .env RESET_TOKEN")
    if not good:
        ok = False
        print("     machine output:", out[:300])

    # 3. working.secret/reset-broker.token (0600), same value, for parity
    # with vault-broker.token. Mounted into the container as
    # /app/working.secret/reset-broker.token.
    updater2 = (
        "import os\n"
        "p='/data/home/qwenpaw/working.secret/reset-broker.token'\n"
        "tok=__TOKEN__\n"
        "os.makedirs(os.path.dirname(p), exist_ok=True)\n"
        "open(p,'w').write(tok+'\\n')\n"
        "os.chmod(p,0o600)\n"
        "print('RESET_BROKER_TOKEN_WRITTEN')\n"
    ).replace("__TOKEN__", repr(token))
    b64 = base64.b64encode(updater2.encode()).decode()
    r = ib_exec({"cmd": f"python3 -c \"import base64; exec(base64.b64decode('{b64}'))\"", "timeoutSeconds": 60})
    out = (r.stdout or "") + (r.stderr or "")
    good = "RESET_BROKER_TOKEN_WRITTEN" in out
    print(("OK   " if good else "FAIL ") + "machine working.secret/reset-broker.token")
    if not good:
        ok = False
        print("     machine output:", out[:300])

    # 4. Verify presence only (never the values).
    r = ib_exec({"cmd": "grep -c '^RESET_TOKEN=' /data/home/qwenpaw/.env; stat -c '%a' /data/home/qwenpaw/.env /data/home/qwenpaw/working.secret/reset-broker.token", "timeoutSeconds": 30})
    print("     machine check:", (r.stdout or "").strip().replace("\n", " "))
    print("OK   provision complete" if ok else "FAIL provision had failures (see above)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
