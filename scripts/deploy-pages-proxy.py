#!/usr/bin/env python3
"""Deploy a Pages project (direct upload) including a _worker.js proxy.

Flow (wrangler's direct-upload protocol):
  0. bundle _worker.js with esbuild (required: direct-upload treats it as a
     single-file Worker and cannot resolve its relative imports; an
     unbundled _worker.js fails the deploy stage with no error message)
  1. upload-token JWT (account API token via custom.cloudflare surrogate)
  2. blake3 manifest hash per static file (excludes _worker.js)
  3. POST /client/v4/pages/assets/check-missing (JWT)
  4. POST /client/v4/pages/assets/upload (JWT) for missing files
  5. POST /client/v4/pages/assets/upsert-hashes (JWT)
  6. POST /client/v4/accounts/{id}/pages/projects/{name}/deployments
     (account token, multipart: manifest + branch + _worker.js file part)

Usage: deploy-pages-proxy.py <project-name> [public-dir]
Prints only the deployment id / url / subdomain — never any token or JWT.
"""
import base64
import hashlib
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ACCOUNT_ID = "ca85fe3692c3f378200950999df9a35e"
API = "https://api.cloudflare.com/client/v4"
SPECIAL_FILES = {"_worker.js", "_headers", "_redirects", "_routes.json"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def cf_call(path, method="GET", body=None, bearer=None, content_type=None):
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
    if bearer is not None:
        req.add_header("Authorization", f"Bearer {bearer}")
    else:
        add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=120) as resp:
            raw = resp.read()
            return json.loads(raw.decode())
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, "on", method, path, file=sys.stderr)
        print(e.read().decode("utf-8", "replace"), file=sys.stderr)
        raise


def file_hash(data: bytes, ext: str) -> str:
    import blake3

    return blake3.blake3(base64.b64encode(data) + ext.encode()).hexdigest()[:32]


def collect(public_dir):
    files = []  # (url_path, disk_path, hash, content_type)
    for root, _dirs, names in os.walk(public_dir):
        for name in sorted(names):
            disk = os.path.join(root, name)
            rel = os.path.relpath(disk, public_dir).replace(os.sep, "/")
            if name in SPECIAL_FILES:
                continue
            with open(disk, "rb") as f:
                data = f.read()
            ext = os.path.splitext(name)[1].lstrip(".")
            h = file_hash(data, ext)
            ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
            files.append(("/" + rel, disk, h, ctype))
    return files


def bundle_worker(public_dir):
    """Bundle _worker.js + its relative imports into one self-contained file.

    Pages direct-upload treats _worker.js as a single-file Worker: relative
    imports (./computer/router.js etc.) are NOT resolved against the static
    assets, so an unbundled _worker.js deploys but fails the 'deploy' stage
    with no error message (seen 2026-11-16: three consecutive failures on
    both projects; the bundled file deployed first try). esbuild is required.
    Returns the path of the bundled file (a temp file, not the repo source).
    """
    import shutil
    import subprocess
    import tempfile
    src = os.path.join(public_dir, "_worker.js")
    esbuild = shutil.which("esbuild")
    if not esbuild:
        for cand in ("/tmp/node_modules/.bin/esbuild",
                     os.path.expanduser("~/.npm-global/bin/esbuild")):
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                esbuild = cand
                break
    if not esbuild:
        print("esbuild not found: _worker.js must be bundled before deploy "
              "(npm install -g esbuild, or npm install esbuild). Refusing to "
              "deploy an unbundled _worker.js — it fails the deploy stage.",
              file=sys.stderr)
        sys.exit(2)
    out = tempfile.NamedTemporaryFile(prefix="qwenpaw-worker-", suffix=".js", delete=False)
    out.close()
    r = subprocess.run(
        [esbuild, src, "--bundle", "--format=esm", "--platform=browser",
         "--target=es2022", f"--outfile={out.name}"],
        capture_output=True, text=True)
    if r.returncode != 0:
        print("esbuild failed:", r.stdout, r.stderr, file=sys.stderr)
        sys.exit(2)
    with open(out.name, "rb") as f:
        bundled = f.read()
    if b'from "./' in bundled or b"from './" in bundled:
        print("bundled _worker.js still has relative imports — refusing to deploy",
              file=sys.stderr)
        sys.exit(2)
    print(f"_worker.js: bundled ({len(bundled)} bytes, was {os.path.getsize(src)})")
    return out.name


def main():
    project = sys.argv[1]
    public_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "pages", "public"
    )
    files = collect(public_dir)
    print(f"project={project} static_files={len(files)}")
    for p, _d, h, _c in files:
        print(f"  {p} {h}")
    # Bundle _worker.js first: direct-upload cannot resolve its relative
    # imports (see bundle_worker). The bundled file is what gets deployed.
    worker_bundle = bundle_worker(public_dir)

    # 1. upload token JWT
    try:
        tok = cf_call(f"/accounts/{ACCOUNT_ID}/pages/projects/{project}/upload-token", method="POST", body={})
    except Exception:
        tok = cf_call(f"/accounts/{ACCOUNT_ID}/pages/projects/{project}/upload-token", method="GET")
    jwt = tok["result"]["jwt"]
    print("upload token: got JWT (not printed)")

    # 2+3. check missing
    hashes = [h for _p, _d, h, _c in files]
    missing = cf_call("/pages/assets/check-missing", method="POST", body={"hashes": hashes}, bearer=jwt)
    missing_set = set(missing.get("result") or [])
    print(f"missing={len(missing_set)}")

    # 4. upload missing
    for p, disk, h, ctype in files:
        if h not in missing_set:
            continue
        with open(disk, "rb") as f:
            data = f.read()
        payload = [{"key": h, "value": base64.b64encode(data).decode(), "metadata": {"contentType": ctype}, "base64": True}]
        cf_call("/pages/assets/upload", method="POST", body=payload, bearer=jwt)
        print(f"  uploaded {p}")

    # 5. upsert hashes
    cf_call("/pages/assets/upsert-hashes", method="POST", body={"hashes": hashes}, bearer=jwt)
    print("upsert-hashes: ok")

    # 6. create deployment (multipart: manifest + branch + _worker.js file)
    manifest = {p: h for p, _d, h, _c in files}
    boundary = "----cfdeploy" + uuid.uuid4().hex
    parts = []
    for name, value in [("manifest", json.dumps(manifest)), ("branch", "main")]:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )
    worker_path = worker_bundle
    if os.path.exists(worker_path):
        with open(worker_path, "rb") as f:
            wdata = f.read()
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"_worker.js\"; filename=\"_worker.js\"\r\n"
            f"Content-Type: application/javascript\r\n\r\n".encode() + wdata + b"\r\n"
        )
        print(f"_worker.js: included ({len(wdata)} bytes)")
    else:
        print("_worker.js: MISSING from public dir", file=sys.stderr)
        sys.exit(2)
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    dep = cf_call(
        f"/accounts/{ACCOUNT_ID}/pages/projects/{project}/deployments",
        method="POST",
        body=body,
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    if not dep.get("success"):
        print(json.dumps(dep, indent=2), file=sys.stderr)
        sys.exit(1)
    r = dep["result"]
    print(json.dumps({
        "deployment_id": r.get("id"),
        "url": r.get("url"),
        "environment": r.get("environment"),
        "latest_stage": r.get("latest_stage"),
    }, indent=2))


if __name__ == "__main__":
    main()
