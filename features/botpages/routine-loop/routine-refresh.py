#!/usr/bin/env python3
"""Routine refresh loop for bot-built Pages (all-20 gap #15, 2nd gen; T135).

The loop the evaluation asked for, on top of the shipped bot-built Pages
(build-page skill, qwenpaw-pages, features/botpages/deploy-page.py):

    routine fires -> re-read state -> re-render <pages>/<slug>/index.html
    -> redeploy the whole pages directory via deploy-page.py

Design rules (each is tested in test_routine_loop.py):

* The page is a pure render of state. ``render_page()`` is a pure function
  of the (allowlisted) state dict: no wall clock, no filesystem reads, no
  randomness, sorted keys, fixed formatting. A hand edit to index.html
  does not survive a refresh; there is no drift.
* Idempotent. Re-running with unchanged state produces a byte-identical
  file. The freshness line therefore uses the state's own ``updated_at``
  (the time the routine last refreshed the underlying data), NOT the
  wall-clock time of this run: a run-time stamp would change the file on
  every run and idempotency would be impossible. The page says so in
  plain words: it is a snapshot from the last routine run, not a live
  view. If the new render equals the file already on disk, the loop
  skips the write AND the deploy (a full-snapshot deploy on every tick
  would spend Cloudflare API calls for nothing; cost must be
  proportional to change, AGENTS.md section 6).
* Deploy-failure handling. The new page is rendered fully in memory,
  written to a dot-prefixed temp file in the same directory (dot-prefixed
  so deploy-page.py's collect() skips it), verified byte-for-byte, then
  moved into place with os.replace() -- never a truncate-in-place, never
  a half-written page. Only then is deploy-page.py run, over the WHOLE
  pages directory (a single-file deploy would delete every other page).
  Its exit code is checked: on failure no new deployment is created
  (deploy-page.py creates the deployment only as its final step), so the
  live page stays the last good one, and the failure is recorded in a
  JSONL log. The local file keeps the complete new render, so the next
  successful run publishes it.
* Publish allowlist. An explicit declared list of what may be published
  (allowlist JSON: slug -> allowed state keys). Anything not on the list
  is refused, never published: unknown slug, a state key not listed for
  that slug, a missing required key (``title``, ``updated_at``), a
  non-scalar value, a secret-shaped value, or a value naming a workspace
  / vault path. Refusal is fail-closed: nonzero exit, page untouched,
  failure recorded. The render never reads the filesystem, so a state
  value can never be a path that gets inlined.
* State and logs live OUTSIDE the pages tree. This matters: deploy-page.py
  publishes everything under the pages directory, including ``.json``
  files -- a ``state.json`` kept under ``pages/<slug>/`` would itself be
  served at ``/<slug>/state.json``. So the state file, the failure log,
  the status file and the lock all live in a separate state directory
  (``<state-dir>/<slug>.json`` etc.), never under the pages directory.
  The test proves it by running the real deploy-page.py collect() over
  the pages directory and checking the manifest.
* No sharing / private-link model. Pages URLs are already public; a
  private link would need an auth layer, out of scope. Public is the
  intended design for pages the user explicitly asks to share; accidental
  publication is controlled by this allowlist, not by a sharing model.
* One lock serialises render -> deploy for a pages directory, so two
  overlapping routine runs cannot interleave a temp file / replace, and
  two slugs cannot race a full-snapshot deploy and delete each other's
  page.

Usage (what a native QwenPaw routine job runs; see README.md):

    python3 routine-refresh.py --pages-dir <workspace>/pages \\
        --state-dir <workspace>/pages-state \\
        --allowlist <workspace>/pages-state/allowlist.json \\
        --slug launch-party [--no-deploy]

Exit code 0 on success (including "unchanged, nothing to do"), 1 on any
refusal or failure, 2 on bad input. No secrets are read, printed or
logged by this script. English only. No China endpoints.
"""
import argparse
import fcntl
import html
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Default deploy script: the shipped one, next to this feature's parent.
DEFAULT_DEPLOY_SCRIPT = HERE.parent / "deploy-page.py"
DEFAULT_PROJECT = "qwenpaw-pages"

REQUIRED_KEYS = ("title", "updated_at")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
# Same shapes as the repo secret check (scripts/checks/check-no-secrets.sh):
# a secret-shaped value in page state must never reach a public page.
SECRET_SHAPES = (
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
)
# Workspace / vault paths that must never appear in published content.
FORBIDDEN_VALUE_SUBSTRINGS = ("working.secret", "working_secret", "history.db", "auth.json")

# A value may only be a plain scalar or a flat list of scalars. A dict (or
# a nested structure) could smuggle a path or a secret-shaped blob past a
# reader, and a page has no use for one.
Scalar = (str, int, float, bool)


def _value_ok(value):
    """A value is publishable if it is a scalar or a flat list of scalars."""
    if isinstance(value, Scalar):
        return True
    if isinstance(value, list):
        return all(isinstance(v, Scalar) for v in value)
    return False


class Refusal(Exception):
    """Fail-closed refusal: the refresh must not publish anything."""


def load_allowlist(path):
    """Load the allowlist JSON: {"pages": {"<slug>": ["key", ...], ...}}."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise Refusal(f"cannot load allowlist {path}: {e}")
    pages = data.get("pages") if isinstance(data, dict) else None
    if not isinstance(pages, dict) or not pages:
        raise Refusal(f"allowlist {path} has no non-empty 'pages' mapping")
    out = {}
    for slug, keys in pages.items():
        if not SLUG_RE.match(slug):
            raise Refusal(f"allowlist has invalid slug {slug!r}")
        if not isinstance(keys, list) or not keys or not all(isinstance(k, str) for k in keys):
            raise Refusal(f"allowlist entry for {slug!r} is not a non-empty list of keys")
        if set(REQUIRED_KEYS) - set(keys):
            raise Refusal(
                f"allowlist entry for {slug!r} must include required keys {list(REQUIRED_KEYS)}"
            )
        out[slug] = list(keys)
    return out


def load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise Refusal(f"cannot load state {path}: {e}")
    if not isinstance(data, dict):
        raise Refusal(f"state {path} is not a JSON object")
    return data


def validate_state(slug, state, allowlist):
    """Fail-closed allowlist gate. Returns the filtered state dict.

    Only keys listed for this slug pass, in allowlist order; anything else
    is refused, never silently dropped (a silent drop would hide a leak
    attempt from the operator). Values are checked for type, secret
    shapes and workspace/vault path substrings.
    """
    if slug not in allowlist:
        raise Refusal(f"slug {slug!r} is not on the publish allowlist")
    allowed = allowlist[slug]
    for key in state:
        if key not in allowed:
            raise Refusal(f"state key {key!r} for slug {slug!r} is not on the publish allowlist")
    for key in REQUIRED_KEYS:
        if key not in state or not isinstance(state[key], str) or not state[key].strip():
            raise Refusal(f"state for slug {slug!r} is missing required string key {key!r}")
    for key, value in state.items():
        if not _value_ok(value):
            raise Refusal(
                f"state key {key!r} for slug {slug!r} has a non-scalar value "
                "(only strings, numbers, booleans and flat lists of those may be published)"
            )
        texts = value if isinstance(value, list) else [value]
        for text in texts:
            if not isinstance(text, str):
                continue
            for shape in SECRET_SHAPES:
                if shape.search(text):
                    raise Refusal(
                        f"state key {key!r} for slug {slug!r} contains a secret-shaped value"
                    )
            for bad in FORBIDDEN_VALUE_SUBSTRINGS:
                if bad in text:
                    raise Refusal(
                        f"state key {key!r} for slug {slug!r} names a workspace/vault path ({bad})"
                    )
    return {key: state[key] for key in allowed if key in state}


def _fmt(value):
    """One scalar value as escaped page text (lists joined with ', ')."""
    if isinstance(value, list):
        return ", ".join(html.escape(str(v)) for v in value)
    return html.escape(str(value))


def render_page(slug, state):
    """Pure render: state dict -> complete HTML bytes. Deterministic.

    No wall clock, no filesystem reads, no randomness. The freshness line
    uses the state's own ``updated_at`` (see module docstring for why a
    run-time stamp would break idempotency). All values are HTML-escaped.
    """
    title = html.escape(str(state["title"]))
    updated_at = html.escape(str(state["updated_at"]))
    rows = []
    for key in sorted(state):
        if key in REQUIRED_KEYS:
            continue
        rows.append(
            f"      <dt>{html.escape(key)}</dt><dd>{_fmt(state[key])}</dd>\n"
        )
    body_rows = "".join(rows)
    page = (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '  <meta charset="utf-8">\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"  <title>{title}</title>\n"
        "  <style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;"
        "padding:0 1rem;line-height:1.5}dt{font-weight:700}dd{margin:0 0 0.75rem 0}"
        "footer{margin-top:2rem;font-size:0.9rem;color:#555}</style>\n"
        "</head>\n"
        "<body>\n"
        f"  <h1>{title}</h1>\n"
        + (f"  <dl>\n{body_rows}  </dl>\n" if body_rows else "")
        + "  <footer>\n"
        f"    <p>Last updated: {updated_at}. This page is a snapshot refreshed by a "
        "routine run, not a live view.</p>\n"
        "  </footer>\n"
        "</body>\n"
        "</html>\n"
    )
    return page.encode("utf-8")


def _utcnow_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def record_failure(state_dir, slug, reason, deploy_exit=None):
    """Append one JSONL failure record (state dir, never the pages tree)."""
    record = {"slug": slug, "at": _utcnow_iso(), "reason": str(reason)}
    if deploy_exit is not None:
        record["deploy_exit"] = deploy_exit
    path = Path(state_dir) / f"{slug}.failures.jsonl"
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError:
        pass  # a logging failure must not mask the refusal itself


def write_status(state_dir, slug, result, detail=""):
    path = Path(state_dir) / f"{slug}.status.json"
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {"slug": slug, "at": _utcnow_iso(), "result": result, "detail": detail},
                f, sort_keys=True,
            )
            f.write("\n")
    except OSError:
        pass


def atomic_write(target, data):
    """Write data to target atomically: dot-prefixed temp in the same dir
    (deploy-page.py skips dot-prefixed names), verify, os.replace()."""
    target = Path(target)
    tmp = target.parent / f".{target.name}.tmp-{os.getpid()}"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        if tmp.read_bytes() != data:
            raise OSError(f"temp file verification failed for {target}")
        os.replace(tmp, target)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def run_deploy(deploy_script, pages_dir, project, branch):
    """Run deploy-page.py over the whole pages directory. Returns exit code."""
    proc = subprocess.run(
        [sys.executable, str(deploy_script), str(pages_dir),
         f"--project={project}", f"--branch={branch}"],
        capture_output=True, text=True, timeout=600,
    )
    if proc.stdout:
        print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="", file=sys.stderr)
    return proc.returncode


def read_status(state_dir, slug):
    """Last recorded run result for a slug, or None if never recorded."""
    path = Path(state_dir) / f"{slug}.status.json"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data.get("result") if isinstance(data, dict) else None


def refresh(pages_dir, state_dir, allowlist_path, slug, deploy_script=None,
            project=DEFAULT_PROJECT, branch="main", no_deploy=False):
    """One routine refresh. Returns ("deployed"|"unchanged", detail).

    Raises Refusal (fail-closed) or RuntimeError (deploy failure) on any
    problem; the caller records the failure and exits nonzero.
    """
    pages_dir = Path(pages_dir)
    state_dir = Path(state_dir)
    if not SLUG_RE.match(slug):
        raise Refusal(f"invalid slug {slug!r} (lowercase letters, digits and hyphens only)")
    if not pages_dir.is_dir():
        raise Refusal(f"pages directory not found: {pages_dir}")
    state_dir.mkdir(parents=True, exist_ok=True)

    # One lock serialises render -> deploy for this pages directory.
    lock_path = state_dir / "refresh.lock"
    lock_f = open(lock_path, "a", encoding="utf-8")
    try:
        fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock_f.close()
        raise Refusal("another refresh is already running (lock held)")
    try:
        allowlist = load_allowlist(allowlist_path)
        state = load_state(state_dir / f"{slug}.json")
        filtered = validate_state(slug, state, allowlist)
        rendered = render_page(slug, filtered)

        slug_dir = pages_dir / slug
        slug_dir.mkdir(parents=True, exist_ok=True)
        target = slug_dir / "index.html"
        changed = not (target.is_file() and target.read_bytes() == rendered)
        if changed:
            atomic_write(target, rendered)

        if no_deploy:
            write_status(state_dir, slug, "rendered", "rendered without deploy (--no-deploy)")
            return "deployed", "rendered (--no-deploy, no deploy attempted)"

        # Unchanged file + a previous successful deploy means there is
        # genuinely nothing to do. But if the last run rendered without
        # deploying, or the last deploy FAILED, the live page is stale
        # even though the local file is current -- so deploy anyway.
        # Without this, a deploy failure would be silently forgotten the
        # moment the next run saw an identical file.
        if not changed and read_status(state_dir, slug) == "deployed":
            write_status(state_dir, slug, "unchanged", "render identical to existing page")
            return "unchanged", "page already matches state; no write, no deploy"

        script = Path(deploy_script) if deploy_script else DEFAULT_DEPLOY_SCRIPT
        if not script.is_file():
            raise Refusal(f"deploy script not found: {script}")
        code = run_deploy(script, pages_dir, project, branch)
        if code != 0:
            # Record here, with the real exit code: the caller must not
            # record it a second time. The live page is untouched --
            # deploy-page.py creates a deployment only as its final step,
            # so a nonzero exit means no new deployment exists. The
            # status is set to deploy_failed so the next run retries the
            # deploy instead of concluding "unchanged".
            record_failure(state_dir, slug, f"deploy-page.py exited {code}",
                           deploy_exit=code)
            write_status(state_dir, slug, "deploy_failed", f"deploy-page.py exited {code}")
            raise RuntimeError(f"deploy-page.py exited {code}")
        write_status(state_dir, slug, "deployed", "rendered and deployed")
        return "deployed", "rendered and deployed"
    finally:
        try:
            fcntl.flock(lock_f, fcntl.LOCK_UN)
        except OSError:
            pass
        lock_f.close()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Routine refresh loop for one bot-built Page (T135)."
    )
    parser.add_argument("--pages-dir", required=True, help="pages directory (deployed tree)")
    parser.add_argument("--state-dir", required=True, help="state directory (NOT under pages-dir)")
    parser.add_argument("--allowlist", required=True, help="publish allowlist JSON file")
    parser.add_argument("--slug", required=True, help="page slug to refresh")
    parser.add_argument("--deploy-script", default=None,
                        help="deploy-page.py path (default: features/botpages/deploy-page.py)")
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--branch", default="main")
    parser.add_argument("--no-deploy", action="store_true",
                        help="render only, do not deploy")
    args = parser.parse_args(argv)

    if Path(args.state_dir).resolve() == Path(args.pages_dir).resolve() or \
            str(Path(args.state_dir).resolve()).startswith(str(Path(args.pages_dir).resolve()) + os.sep):
        print("refused: --state-dir must not be inside --pages-dir "
              "(state and logs would be published)", file=sys.stderr)
        return 2
    try:
        _result, detail = refresh(
            args.pages_dir, args.state_dir, args.allowlist, args.slug,
            deploy_script=args.deploy_script, project=args.project,
            branch=args.branch, no_deploy=args.no_deploy,
        )
    except Refusal as e:
        record_failure(args.state_dir, args.slug, f"refused: {e}")
        print(f"refused: {e}", file=sys.stderr)
        return 1
    except RuntimeError as e:
        # Already recorded (with the deploy exit code) inside refresh().
        print(f"failed: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        record_failure(args.state_dir, args.slug, f"io error: {e}")
        print(f"failed: {e}", file=sys.stderr)
        return 1
    print(detail)
    return 0


if __name__ == "__main__":
    sys.exit(main())
