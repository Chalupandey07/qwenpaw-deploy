#!/usr/bin/env python3
"""Deploy the qwenpaw-groupchat Worker via the Cloudflare API (no wrangler login).

Same credential pattern as ../../scripts/deploy-pages-proxy.py: the
registered custom.cloudflare token is attached via the surrogate helper, so
no token ever appears in this file, in argv, or in logs.

Usage (run from this directory, features/groupchat/worker/):
  python3 deploy-groupchat.py deploy
      Upload src/index.js as Worker qwenpaw-groupchat (PUT workers/scripts),
      with the GROUPCHAT_THREAD Durable Object binding (SQLite class
      GroupChatThread, migration tag v1) and no KV binding. The old
      GROUPCHAT KV namespace is retired (see wrangler.toml) and is not
      referenced by the deploy.
  python3 deploy-groupchat.py status
      GET the deployed Worker metadata (name, id, etag) — read-only check.
  python3 deploy-groupchat.py set-secret <token>
      Set the GROUPCHAT_TOKEN secret on the live Worker (PUT .../secrets).
      The token itself is never printed or logged. Run this only with a
      token the user generated; a secret change needs no re-deploy.

After first deploy, set the shared secret so the thread is not public:
  npx wrangler secret put GROUPCHAT_TOKEN
(then re-deploy is not needed for a secret change; wrangler secret put
applies to the live Worker.)
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ACCOUNT_ID = "ca85fe3692c3f378200950999df9a35e"
API = "https://api.cloudflare.com/client/v4"
WORKER_NAME = "qwenpaw-groupchat"
HERE = os.path.dirname(os.path.abspath(__file__))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def cf_call(path, method="GET", body=None, content_type=None):
    url = path if path.startswith("http") else API + path
    data = None
    headers = {}
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            headers["Content-Type"] = content_type or "application/json"
        elif isinstance(body, (bytes, bytearray)):
            data = bytes(body)
            if content_type:
                headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=120) as resp:
            raw = resp.read().decode()
            if not raw.strip():
                # Some endpoints (e.g. subdomain enable) return empty 200.
                return {"success": True, "result": None}
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, "on", method, path, file=sys.stderr)
        print(e.read().decode("utf-8", "replace"), file=sys.stderr)
        raise


def cmd_deploy():
    with open(os.path.join(HERE, "src", "index.js"), "rb") as f:
        script = f.read()
    metadata = {
        "main_module": "index.js",
        "compatibility_date": "2026-11-14",
        "bindings": [
            {
                "type": "durable_object_namespace",
                "name": "GROUPCHAT_THREAD",
                "class_name": "GroupChatThread",
            },
        ],
        # First Durable Object migration for this Worker: creates the
        # SQLite-backed GroupChatThread class. Re-deploying with the same
        # tag and class list is a no-op migration (the class already exists).
        "migrations": {"tag": "v1", "new_sqlite_classes": ["GroupChatThread"]},
    }
    boundary = "----cfgroupchat" + uuid.uuid4().hex
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(metadata)}\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"index.js\"; filename=\"index.js\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode() + script + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    body = b"".join(parts)
    res = cf_call(
        f"/accounts/{ACCOUNT_ID}/workers/scripts/{WORKER_NAME}",
        method="PUT",
        body=body,
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    if not res.get("success"):
        print(json.dumps(res, indent=2), file=sys.stderr)
        sys.exit(1)
    r = res["result"]
    # The raw API does NOT enable the workers.dev route on upload (wrangler
    # does this explicitly). Without this POST, the URL answers 404/1042
    # even though the script exists. Cloudflare returns an empty 200 body.
    try:
        sub = cf_call(
            f"/accounts/{ACCOUNT_ID}/workers/scripts/{WORKER_NAME}/subdomain",
            method="POST",
            body={"enabled": True},
        )
        subdomain_ok = True
    except Exception as e:
        print(f"WARNING: subdomain enable failed ({e}) — Worker URL may 404; retry manually.", file=sys.stderr)
        subdomain_ok = False
    print(json.dumps({
        "worker": WORKER_NAME,
        "id": r.get("id"),
        "etag": r.get("etag"),
        "durable_object": "GroupChatThread (sqlite, migration v1)",
        "workers_dev_enabled": subdomain_ok,
        "url": f"https://{WORKER_NAME}.qwenpaw-rohan.workers.dev/",
    }, indent=2))


def cmd_status():
    # Single-script GET returns an empty body on this token; the list
    # endpoint works — filter it instead.
    res = cf_call(f"/accounts/{ACCOUNT_ID}/workers/scripts")
    found = [s for s in (res.get("result") or []) if s.get("id") == WORKER_NAME]
    print(json.dumps(found, indent=2) if found else json.dumps({"error": "worker not found in list"}, indent=2))


def cmd_set_secret(token):
    # PUT .../secrets with type secret_text. The token value is never
    # printed or logged here.
    res = cf_call(
        f"/accounts/{ACCOUNT_ID}/workers/scripts/{WORKER_NAME}/secrets",
        method="PUT",
        body={"name": "GROUPCHAT_TOKEN", "text": token, "type": "secret_text"},
    )
    if not res.get("success"):
        print(json.dumps(res, indent=2), file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"worker": WORKER_NAME, "secret": "GROUPCHAT_TOKEN", "set": True}, indent=2))
    print("No re-deploy needed. The thread now requires X-Groupchat-Token.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "status":
        cmd_status()
    elif cmd == "deploy":
        cmd_deploy()
    elif cmd == "set-secret":
        if len(sys.argv) < 3 or not sys.argv[2]:
            print("usage: deploy-groupchat.py set-secret <token>", file=sys.stderr)
            sys.exit(2)
        cmd_set_secret(sys.argv[2])
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
