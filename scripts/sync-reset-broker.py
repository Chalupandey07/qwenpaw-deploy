#!/usr/bin/env python3
"""Sync the Settings Reset broker to the InstaBox machine and verify.

Reads the broker files from GitHub (API contents -> base64, the reliable
path; raw.githubusercontent.com can serve a stale cached copy right after
a push), writes them to the machine via ib.py exec, installs + enables the
systemd service, and verifies /health live.

Usage: python3 sync-reset-broker.py
"""
import base64
import json
import os
import subprocess
import sys

GH = os.path.expanduser("~/workspace/custom-connectors/custom.github/bin/gh.py")
IB = os.path.expanduser("~/workspace/custom-connectors/custom.instabox/bin/ib.py")
MACHINE = "m_agq5wqqo2fvypym7rjlpvngc2m"


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"FAILED: {' '.join(cmd)}\n{r.stdout}\n{r.stderr}", file=sys.stderr)
        sys.exit(1)
    return r.stdout


def gh_content(repo_path):
    r = run(["python3", GH, "get", f"/repos/Ratulbaba7/qwenpaw-deploy/contents/{repo_path}"])
    d = json.loads(r)
    return base64.b64decode(d["content"].replace("\n", ""))


def ib_exec_json(cmd, timeout=120):
    """ib.py exec takes a JSON file; write it to /tmp and pass the path."""
    path = "/tmp/sync-reset-exec.json"
    with open(path, "w") as f:
        json.dump({"cmd": cmd, "timeoutSeconds": timeout}, f)
    out = run(["python3", IB, "exec", MACHINE, path])
    return json.loads(out)


def put_file(data, dest, sudo=True, mode="644"):
    b64 = base64.b64encode(data).decode()
    prefix = "sudo " if sudo else ""
    cmd = (
        f"echo {b64} | base64 -d | {prefix}tee {dest} > /dev/null && "
        f"{prefix}chmod {mode} {dest} && wc -c {dest}"
    )
    r = ib_exec_json(cmd)
    print(f"  wrote {dest}: {r.get('stdout', '').strip()} (exit {r.get('exitCode')})")
    if r.get("exitCode") != 0:
        print(r.get("stderr", ""), file=sys.stderr)
        sys.exit(1)


def main():
    print("Fetching reset broker files from GitHub...")
    broker = gh_content("features/reset/reset-broker.py")
    categories = gh_content("features/reset/reset_categories.py")
    guard = gh_content("features/reset/reset_guard.py")
    service = gh_content("features/reset/qwenpaw-reset-broker.service")
    print(f"  broker {len(broker)} bytes, categories {len(categories)}, guard {len(guard)}, service {len(service)}")

    print("Writing broker to the machine...")
    r = ib_exec_json("sudo install -d -m 0755 /data/home/qwenpaw/reset")
    if r.get("exitCode") != 0:
        print(r.get("stderr", ""), file=sys.stderr)
        sys.exit(1)
    put_file(broker, "/data/home/qwenpaw/reset/reset-broker.py")
    put_file(categories, "/data/home/qwenpaw/reset/reset_categories.py")
    put_file(guard, "/data/home/qwenpaw/reset/reset_guard.py")
    put_file(service, "/etc/systemd/system/qwenpaw-reset-broker.service")

    print("Broker selftest on the machine...")
    r = ib_exec_json("cd /data/home/qwenpaw/reset && python3 reset-broker.py --selftest 2>&1 | tail -2")
    print(" ", r.get("stdout", "").strip())
    if r.get("exitCode") != 0:
        print(r.get("stderr", ""), file=sys.stderr)
        sys.exit(1)

    print("Enabling + starting qwenpaw-reset-broker.service...")
    r = ib_exec_json("sudo systemctl daemon-reload && sudo systemctl enable --now qwenpaw-reset-broker.service && sleep 2 && sudo systemctl is-active qwenpaw-reset-broker.service")
    print(" ", r.get("stdout", "").strip())
    if r.get("exitCode") != 0:
        print(r.get("stderr", ""), file=sys.stderr)
        sys.exit(1)

    print("Verifying broker /health live (anon, no token needed for /health)...")
    r = ib_exec_json("curl -s --max-time 10 http://172.18.0.1:8895/health; echo; curl -s -o /dev/null -w 'anon preview: %{http_code}\\n' --max-time 10 -X POST http://172.18.0.1:8895/preview -H 'Content-Type: application/json' -d '{\"categories\":[]}'; curl -s -o /dev/null -w 'anon execute: %{http_code}\\n' --max-time 10 -X POST http://172.18.0.1:8895/execute -H 'Content-Type: application/json' -d '{\"categories\":[],\"confirm\":\"DELETE\",\"ack\":true,\"plan_id\":\"x\"}'")
    print(" ", r.get("stdout", "").strip())
    if r.get("exitCode") != 0:
        print(r.get("stderr", ""), file=sys.stderr)
        sys.exit(1)

    print("OK: reset broker live on the machine (port 8895).")


if __name__ == "__main__":
    main()
