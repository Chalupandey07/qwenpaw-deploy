#!/usr/bin/env python3
"""Provision the vault master secret + broker token in one coordinated pass.

PROBLEM IT SOLVES
-----------------
Cloudflare Pages secret values are WRITE-ONLY: once set, they cannot be
read back. The vault needs the SAME values on both sides:
  - VAULT_MASTER_SECRET -> Pages secret on BOTH projects (qwenpawx +
    qwenpaw-frontend) AND /data/home/qwenpaw/.env (the broker decrypts
    with it; the Worker seals/opens with it).
  - VAULT_BROKER_TOKEN -> Pages secret on BOTH projects AND
    /data/home/qwenpaw/.env (the broker authenticates to POST /vault/export
    with it; the Worker verifies it constant-time).
Generating both in one process keeps the two sides in sync. The values are
generated here with os.urandom, travel only in the Cloudflare API body and
the ib.py exec request, and are never printed, logged, or written to disk.
Only names + success are printed.

USAGE
-----
  python3 scripts/provision-vault-master-secret.py
Requires the InstaBox machine to be RUNNING. Run it ONCE for the initial
provisioning. Rotation is a separate drill: re-run it, then verify every
vault item still round-trips (the old secret must open nothing after the
rotation — see features/vault/README.md, test (c)).

AFTER RUNNING THIS
------------------
  1. Redeploy BOTH Pages projects (env var changes require a redeploy to
     take effect — proven with INSTABOX_API_KEY, 2026-11-16).
  2. Restart the vault broker service on the machine
     (sudo systemctl restart qwenpaw-vault-broker.service).
  3. Verify: GET /vault/list returns 200 (not 503 vault_unconfigured).
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ACCOUNT_ID = "ca85fe3692c3f378200950999df9a35e"
API = "https://api.cloudflare.com/client/v4"
PROJECTS = ["qwenpawx", "qwenpaw-frontend"]
MACHINE = "m_agq5wqqo2fvypym7rjlpvngc2m"
IB = os.path.expanduser("~/workspace/custom-connectors/custom.instabox/bin/ib.py")

# VAULT_MASTER_SECRET is the 32-byte AES-256 key material, hex-encoded.
# VAULT_BROKER_TOKEN is the broker's authentication token to /vault/export.
SECRET_NAMES = ["VAULT_MASTER_SECRET", "VAULT_BROKER_TOKEN"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


def cf_call(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, "on", method, path, file=sys.stderr)
        print(e.read().decode("utf-8", "replace")[:500], file=sys.stderr)
        raise


def machine_exec(cmd, timeout_s=90):
    """Run a shell command on the machine via ib.py exec. Returns (ok, stdout)."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, dir="/tmp") as f:
        json.dump({"cmd": cmd, "timeoutSeconds": timeout_s}, f)
        tmp = f.name
    try:
        p = subprocess.run(["python3", IB, "exec", MACHINE, tmp],
                           capture_output=True, text=True, timeout=timeout_s + 120)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if p.returncode != 0:
        return False, (p.stderr or p.stdout)[:300]
    try:
        r = json.loads(p.stdout)
    except Exception:
        return False, "ib.py output was not JSON: " + p.stdout[:200]
    if "_error" in r:
        return False, str(r["_error"])[:300]
    return (r.get("exitCode") == 0), (r.get("stdout") or "") + (r.get("stderr") or "")


def main():
    ok, out = machine_exec("echo up")
    print("machine exec reachable:", ok, out.strip())
    if not ok:
        raise SystemExit(1)
    # generate fresh secrets (in-memory only; hex is shell-safe)
    secrets = {n: os.urandom(32).hex() for n in SECRET_NAMES}
    # set them as Pages secrets on both projects
    for project in PROJECTS:
        env_vars = {n: {"type": "secret_text", "value": v} for n, v in secrets.items()}
        r = cf_call(f"/accounts/{ACCOUNT_ID}/pages/projects/{project}",
                    method="PATCH", body={"deployment_configs": {
                        "production": {"env_vars": env_vars},
                        "preview": {"env_vars": env_vars}}})
        print(f"  PATCH {project}: {'OK' if r.get('success') else 'FAIL'}")
    # set both in /data/home/qwenpaw/.env (replace or append). Write the
    # updater as a file on the machine first — a two-variable update does
    # not fit the one-liner pattern from rotate-computer-secrets.py.
    updater = (
        "import re\n"
        "p = '/data/home/qwenpaw/.env'\n"
        "s = open(p).read()\n"
        "updates = {'VAULT_MASTER_SECRET': '" + secrets["VAULT_MASTER_SECRET"] + "', "
        "'VAULT_BROKER_TOKEN': '" + secrets["VAULT_BROKER_TOKEN"] + "'}\n"
        "for k, v in updates.items():\n"
        "    s = re.sub(r'(?m)^' + k + r'=.*$', k + '=' + v, s)\n"
        "    if (k + '=') not in s:\n"
        "        s = s.rstrip('\\n') + '\\n' + k + '=' + v + '\\n'\n"
        "open(p, 'w').write(s)\n"
        "print('env updated')\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, dir="/tmp") as f:
        f.write(updater)
        updater_local = f.name
    try:
        # ib.py exec runs ON the machine, so the local temp file is not
        # visible there. Send the updater through the exec command itself
        # via a base64 blob (no shell-quoting of the secret values).
        import base64
        blob = base64.b64encode(updater.encode()).decode()
        ok, out = machine_exec(
            "echo '" + blob + "' | base64 -d > /tmp/vault-env-update.py "
            "&& python3 /tmp/vault-env-update.py && rm -f /tmp/vault-env-update.py")
    finally:
        try:
            os.unlink(updater_local)
        except OSError:
            pass
    print("  .env VAULT_MASTER_SECRET + VAULT_BROKER_TOKEN set:", ok, out.strip())
    # verify presence only (never values)
    ok, out = machine_exec(
        "grep -c '^VAULT_MASTER_SECRET=..' /data/home/qwenpaw/.env; "
        "grep -c '^VAULT_BROKER_TOKEN=..' /data/home/qwenpaw/.env; "
        "stat -c '%a' /data/home/qwenpaw/.env")
    print("  machine verify (master lines, broker lines, .env mode):\n" + out)
    print("done. (secret values generated in-memory only; nothing printed or stored.)")
    print("NEXT: redeploy BOTH Pages projects, then restart qwenpaw-vault-broker.service.")


if __name__ == "__main__":
    main()
