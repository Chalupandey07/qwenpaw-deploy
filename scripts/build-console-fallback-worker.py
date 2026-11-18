#!/usr/bin/env python3
"""Build the standalone fallback console Worker from pages/public/_worker.js.

Why this exists (2026-11-18): Cloudflare Pages stopped executing _worker.js
on this account — deployments report success and `uses_functions: True`, but
every worker-only route (/, /chat, /api/session/state, /status) returns the
Pages static-asset 404, on both projects and on a brand-new test project with
a trivial 468-byte worker. Static files still serve. The console itself (the
InstaBox origin) is fine. Until Pages Functions come back, the console needs
a front door that actually runs: a standalone Worker, which the Workers API
still deploys and runs fine (qwenpaw-keepalive etc. are live).

What it does: bundles pages/public/_worker.js with esbuild (same as the
Pages deploy), then replaces every `env.ASSETS` reference with a shim
`__assets(env)`. On Pages, env.ASSETS is the real asset binding and is used
as-is. In the standalone Worker there is no ASSETS binding, so the shim
fetches the same file from the Pages static server
(https://qwenpawx.pages.dev/...) — which still serves static files. That
keeps /status, /search-settings-ui.js, /computer/*, /vault/* and /reset/*
page loads working without touching the bundle logic.

What is DEGRADED in the fallback (honest, not hidden): the standalone
Worker cannot have the Pages secrets (DESKTOP_*_TOKEN, VAULT_MASTER_SECRET,
VAULT_BROKER_TOKEN, RESET_TOKEN, INSTABOX_API_KEY, COMPUTER_SESSION_SECRET)
— secret values are not readable via the API and must never be invented.
So /computer session mint + desktop proxying, /vault reveal, /reset
execution and the Rest button fail in the fallback (their routers return
500s). The console proxy itself — chat, rebrand injection, /status, the
Your Keys section, session-state read — needs no secret and works fully.
Use the Pages URL again once Pages Functions recover; this worker is a
temporary front door, not a replacement.

Usage: build-console-fallback-worker.py [out-file]
Prints the output path and byte size. Exits nonzero if esbuild fails, if a
relative import survives bundling, or if any `env.ASSETS` remains.
"""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "pages", "public", "_worker.js")
PAGES_ORIGIN = "https://qwenpawx.pages.dev"

SHIM = """// ---- fallback ASSETS shim (standalone-Worker build only) ----
// On Pages, env.ASSETS is the real static-asset binding. In the standalone
// fallback Worker there is no such binding, so fetch the same file from the
// Pages static server (which still serves static files while Functions are
// down). fetch() follows the 308 clean-URL redirects Pages sends for .html.
function __assets(env) {
  if (env && env.ASSETS) return env.ASSETS;
  return {
    fetch: function (req) {
      const u = new URL(req.url);
      u.protocol = "https:";
      u.hostname = "qwenpawx.pages.dev";
      return fetch(new Request(u.toString(), { method: req.method, headers: req.headers }));
    },
  };
}
"""


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/qwenpaw-console-fallback.mjs"
    esbuild = shutil.which("esbuild")
    if not esbuild:
        for cand in ("/tmp/node_modules/.bin/esbuild",
                     os.path.expanduser("~/.npm-global/bin/esbuild")):
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                esbuild = cand
                break
    if not esbuild:
        print("esbuild not found", file=sys.stderr)
        sys.exit(2)
    tmp = tempfile.NamedTemporaryFile(prefix="qwenpaw-console-", suffix=".mjs", delete=False)
    tmp.close()
    r = subprocess.run(
        [esbuild, SRC, "--bundle", "--format=esm", "--platform=browser",
         "--target=es2022", f"--outfile={tmp.name}"],
        capture_output=True, text=True)
    if r.returncode != 0:
        print("esbuild failed:", r.stdout, r.stderr, file=sys.stderr)
        sys.exit(2)
    with open(tmp.name, "rb") as f:
        bundled = f.read().decode()
    if 'from "./' in bundled or "from './" in bundled:
        print("bundled _worker.js still has relative imports — refusing", file=sys.stderr)
        sys.exit(2)
    if "__assets" in bundled:
        print("bundle already contains __assets — refusing (name clash)", file=sys.stderr)
        sys.exit(2)
    n = bundled.count("env.ASSETS")
    bundled = bundled.replace("env.ASSETS", "__assets(env)")
    if "env.ASSETS" in bundled:
        print("env.ASSETS replacement incomplete", file=sys.stderr)
        sys.exit(2)
    out = SHIM + bundled
    with open(out_path, "w") as f:
        f.write(out)
    print(f"fallback worker: {out_path} ({len(out)} bytes, {n} env.ASSETS -> __assets(env))")
    r = subprocess.run(["node", "--check", out_path], capture_output=True, text=True)
    if r.returncode != 0:
        print("node --check failed:", r.stdout, r.stderr, file=sys.stderr)
        sys.exit(2)
    print("node --check: OK")


if __name__ == "__main__":
    main()
