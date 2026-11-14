#!/usr/bin/env python3
"""Deploy a directory of bot-built static pages to Cloudflare Pages.

This is the deploy half of the QwenPaw "build-page" skill: the bot writes
self-contained HTML pages into one source directory (one page per folder,
``<slug>/index.html``), and this script publishes the whole directory as a
Cloudflare Pages project. Every deployment is a full snapshot of the
project: deploying one file alone would remove every other page, so always
deploy the complete source directory.

Protocol: the same Wrangler direct-upload flow as
``scripts/deploy-pages-proxy.py`` (verified live 2026-11-14):
  1. upload-token JWT for the project (account API token)
  2. blake3 manifest hash per file (excludes _worker.js and friends)
  3. POST /client/v4/pages/assets/check-missing (JWT)
  4. POST /client/v4/pages/assets/upload (JWT) for missing files
  5. POST /client/v4/pages/assets/upsert-hashes (JWT)
  6. POST /client/v4/accounts/{id}/pages/projects/{name}/deployments
     (account token, multipart: manifest + branch)

Authentication (in order):
  1. ``CLOUDFLARE_API_TOKEN`` environment variable (a real API token with
     the "Cloudflare Pages: Edit" scope). This is how the bot and the user
     run it. Never put a real token in this file or in git.
  2. If the variable is absent and this machine has the Muse Cloudflare
     connector helper available, the registered credential surrogate is
     used instead (same mechanism as scripts/deploy-pages-proxy.py), so
     the script also runs from this VM without any token on disk.

Account id defaults to the QwenPaw account and can be overridden with
``CLOUDFLARE_ACCOUNT_ID``.

Usage:
  deploy-page.py <source-dir> [--project qwenpaw-pages] [--branch main]

  <source-dir>  directory of static files; "index.html" at the root is the
                project homepage, "<slug>/index.html" is served at /<slug>/.
                Only .html/.css/.js/.json/.txt/.svg/.png/.jpg/.webp/.ico
                files are accepted; everything else is skipped.
  --project     Pages project name (default: qwenpaw-pages). The project
                must already exist; create it once with:
                  python3 cf.py post /client/v4/accounts/<id>/pages/projects \\
                      '{"name":"qwenpaw-pages","production_branch":"main"}'
  --branch      production branch recorded on the deployment (default: main)

Prints only the deployment id, url and subdomain -- never any token or JWT.
Exit code 0 on success, 1 on API failure, 2 on bad input.
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

ACCOUNT_ID = os.environ.get(
    "CLOUDFLARE_ACCOUNT_ID", "ca85fe3692c3f378200950999df9a35e"
)
API = "https://api.cloudflare.com/client/v4"
DEFAULT_PROJECT = "qwenpaw-pages"
ALLOWED_EXTS = {
    ".html", ".css", ".js", ".json", ".txt", ".svg",
    ".png", ".jpg", ".jpeg", ".webp", ".ico",
}
# Pages direct-upload per-file limit is 25 MiB; stay well under it.
MAX_FILE_BYTES = 20 * 1024 * 1024
SPECIAL_FILES = {"_worker.js", "_headers", "_redirects", "_routes.json"}

try:
    sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
    from dynamic_credentials import add_surrogate_to_request
except Exception:  # pragma: no cover - helper only exists on this VM
    add_surrogate_to_request = None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def _env_token():
    return os.environ.get("CLOUDFLARE_API_TOKEN", "").strip() or None


def cf_call(path, method="GET", body=None, bearer=None, content_type=None):
    """One Cloudflare API call. Token from env var, else connector surrogate."""
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
    token = bearer if bearer is not None else _env_token()
    if token is not None:
        req.add_header("Authorization", "Bearer " + token)
    elif add_surrogate_to_request is not None:
        add_surrogate_to_request(
            req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"]
        )
    else:
        raise RuntimeError(
            "No Cloudflare credential: set CLOUDFLARE_API_TOKEN "
            "or run on a machine with the Cloudflare connector helper."
        )
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, "on", method, path, file=sys.stderr)
        print(e.read().decode("utf-8", "replace"), file=sys.stderr)
        raise


def file_hash(data: bytes, ext: str) -> str:
    """blake3 hash in the exact form the Pages upload API expects.

    Same formula as scripts/deploy-pages-proxy.py: blake3 of the
    base64-encoded bytes plus the extension, first 32 hex chars.
    """
    import blake3

    return blake3.blake3(base64.b64encode(data) + ext.encode()).hexdigest()[:32]


def collect(source_dir):
    """Walk the source dir; return [(url_path, disk_path, hash, content_type)].

    Symlink-safe (fix 2026-11-15, audit finding
    infra-deploy-page-symlink-escape): a planted symlink (e.g. evil.html
    -> a file outside the source tree) used to be opened and uploaded to
    a public Pages project. Symlinked files and directories are now
    skipped, and every collected file must resolve (realpath) inside the
    source directory. Hardlinks are NOT caught by this check — a hardlink
    to a secret file looks like a regular file — but planting one needs
    local write access to the machine already, and the build-page skill
    only ever writes regular files.
    """
    files = []
    base = os.path.realpath(source_dir)
    for root, dirs, names in os.walk(source_dir):
        # Never descend into symlinked directories (os.walk would not
        # follow them by default, but drop them explicitly).
        dirs[:] = sorted(
            d for d in dirs
            if not d.startswith(".") and not os.path.islink(os.path.join(root, d))
        )
        for name in sorted(names):
            if name in SPECIAL_FILES or name.startswith("."):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in ALLOWED_EXTS:
                print(f"  skip (unsupported type): {name}")
                continue
            disk = os.path.join(root, name)
            if os.path.islink(disk):
                print(f"  skip (symlink, not followed): {name}")
                continue
            real = os.path.realpath(disk)
            if os.path.commonpath([real, base]) != base:
                print(f"  skip (resolves outside source dir): {name}")
                continue
            rel = os.path.relpath(disk, source_dir).replace(os.sep, "/")
            size = os.path.getsize(disk)
            if size > MAX_FILE_BYTES:
                raise ValueError(
                    f"{rel} is {size} bytes, over the {MAX_FILE_BYTES} byte limit"
                )
            with open(disk, "rb") as f:
                data = f.read()
            files.append((
                "/" + rel,
                disk,
                file_hash(data, ext.lstrip(".")),
                mimetypes.guess_type(name)[0] or "application/octet-stream",
            ))
    if not files:
        raise ValueError(f"no deployable files found in {source_dir}")
    return files


def deploy(source_dir, project, branch):
    files = collect(source_dir)
    print(f"project={project} branch={branch} files={len(files)}")
    for p, _d, h, _c in files:
        print(f"  {p} {h}")

    # 1. upload-token JWT (account token; GET fallback if POST is refused)
    try:
        tok = cf_call(
            f"/accounts/{ACCOUNT_ID}/pages/projects/{project}/upload-token",
            method="POST", body={},
        )
    except Exception:
        tok = cf_call(
            f"/accounts/{ACCOUNT_ID}/pages/projects/{project}/upload-token",
            method="GET",
        )
    jwt = tok["result"]["jwt"]
    print("upload token: got JWT (not printed)")

    # 2+3. check which file hashes the platform already has
    hashes = [h for _p, _d, h, _c in files]
    missing = cf_call(
        "/pages/assets/check-missing",
        method="POST", body={"hashes": hashes}, bearer=jwt,
    )
    missing_set = set(missing.get("result") or [])
    print(f"missing={len(missing_set)}")

    # 4. upload the missing files
    for p, disk, h, ctype in files:
        if h not in missing_set:
            continue
        with open(disk, "rb") as f:
            data = f.read()
        payload = [{
            "key": h,
            "value": base64.b64encode(data).decode(),
            "metadata": {"contentType": ctype},
            "base64": True,
        }]
        cf_call("/pages/assets/upload", method="POST", body=payload, bearer=jwt)
        print(f"  uploaded {p}")

    # 5. confirm the hashes
    cf_call(
        "/pages/assets/upsert-hashes",
        method="POST", body={"hashes": hashes}, bearer=jwt,
    )
    print("upsert-hashes: ok")

    # 6. create the deployment (multipart: manifest + branch)
    manifest = {p: h for p, _d, h, _c in files}
    boundary = "----cfpage" + uuid.uuid4().hex
    parts = []
    for name, value in [("manifest", json.dumps(manifest)), ("branch", branch)]:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )
    parts.append(f"--{boundary}--\r\n".encode())
    dep = cf_call(
        f"/accounts/{ACCOUNT_ID}/pages/projects/{project}/deployments",
        method="POST",
        body=b"".join(parts),
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    if not dep.get("success"):
        print(json.dumps(dep, indent=2), file=sys.stderr)
        raise RuntimeError("deployment create failed")
    r = dep["result"]
    print(json.dumps({
        "deployment_id": r.get("id"),
        "url": r.get("url"),
        "environment": r.get("environment"),
        "latest_stage": r.get("latest_stage"),
    }, indent=2))
    return r


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    opts = dict(a.split("=", 1) for a in argv[1:] if a.startswith("--") and "=" in a)
    if len(args) != 1:
        print(
            "usage: deploy-page.py <source-dir> "
            "[--project=qwenpaw-pages] [--branch=main]",
            file=sys.stderr,
        )
        return 2
    source_dir = args[0]
    if not os.path.isdir(source_dir):
        print(f"not a directory: {source_dir}", file=sys.stderr)
        return 2
    project = opts.get("--project", DEFAULT_PROJECT)
    branch = opts.get("--branch", "main")
    try:
        deploy(source_dir, project, branch)
    except (ValueError, RuntimeError, urllib.error.HTTPError, KeyError) as e:
        print(f"deploy failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
