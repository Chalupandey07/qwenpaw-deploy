#!/usr/bin/env python3
"""Machine-free tests for the bot-built Pages routine refresh loop (T135).

Exercises features/botpages/routine-loop/routine-refresh.py on TEMPORARY
scratch directories only -- never the real workspace, never the repo
itself, never the live Pages project (deploys go to a fake script that
only records its invocation).

Usage:
    python3 test_routine_loop.py [--code PATH]
    python3 test_routine_loop.py --code /tmp/empty-routine-stub.py
        # fail-first: must FAIL (no render / allowlist / loop exists)

Checks (24):
  render (pure function):
   1. render twice with shuffled key order -> identical bytes
   2. a state change appears in the page, the old value is gone
   3. HTML in a value is escaped, never raw
   4. render never reads the filesystem (a value naming a file with a
      canary string does not leak the canary)
   5. the page states its freshness: the state's updated_at + "not a
      live view"; no live-push wording
   6. a state with only the required keys renders with no data table
      but still has the freshness footer
  allowlist (fail-closed validation):
   7. refuses a state key not on the allowlist
   8. refuses an unknown slug
   9. refuses a missing title
  10. refuses a missing updated_at
  11. refuses a dict (non-scalar) value
  12. refuses a secret-shaped value
  13. refuses a value naming a workspace/vault path
  14. accepts a clean state and returns exactly the allowlisted keys
  loop (CLI against temp dirs + a fake deploy script):
  15. first run renders, and deploys the WHOLE pages directory
  16. second run with unchanged state: byte-identical file, no deploy
  17. state change: page updated, deploy runs again
  18. hand-edited index.html is overwritten by the pure render (no drift)
  19. deploy failure (fake deploy exits 1): nonzero exit, failure
      recorded with slug + exit code, local page complete (never
      truncated), no temp file left behind
  20. allowlist refusal at the CLI: nonzero exit, pre-existing page
      bytes untouched, failure recorded
  21. nothing but pages is published: the REAL deploy-page.py collect()
      over the pages dir lists only index.html files (+ 404.html) --
      state.json, failure log, status and lock are never in the manifest
  22. sibling preservation: refreshing one slug still deploys the other
      slug's page (full-snapshot deploy, never one file alone)
  23. a held lock: nonzero exit, page untouched, failure recorded
  24. --no-deploy renders without invoking the deploy script at all

Plus one design property the test relies on: after a deploy failure the
next run retries the deploy (status "deploy_failed"), verified in
check 19's follow-up run.
"""
from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
BOTPAGE_DIR = HERE.parent

CHECKS: list[tuple[str, bool, str]] = []

FAKE_DEPLOY = '''#!/usr/bin/env python3
"""Fake deploy-page.py: records its invocation, exits as told."""
import json, os, sys
from pathlib import Path
log = Path(os.environ["FAKE_DEPLOY_LOG"])
pages = Path(sys.argv[1])
files = sorted(str(p.relative_to(pages)) for p in pages.rglob("*") if p.is_file())
with open(log, "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "files": files}) + "\\n")
sys.exit(int(os.environ.get("FAKE_DEPLOY_EXIT", "0")))
'''


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def read_bytes_or_none(path):
    """Fail-first safe read: None when the file was never created."""
    try:
        return Path(path).read_bytes()
    except OSError:
        return None


def load_code(path: Path):
    try:
        spec = importlib.util.spec_from_file_location("routine_refresh_under_test", str(path))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except BaseException as e:  # BaseException: a stub may SystemExit at import
        print(f"  (could not load {path}: {e})")
        return None


def fn(mod, name):
    return getattr(mod, name, None) if mod is not None else None


# ---------------------------------------------------------------- helpers

class Env:
    """One scratch workspace: pages dir + state dir + fake deploy."""

    def __init__(self, code: Path):
        self.base = Path(tempfile.mkdtemp(prefix="t135-"))
        self.pages = self.base / "pages"
        self.state = self.base / "state"
        self.pages.mkdir()
        self.state.mkdir()
        self.code = code
        self.allowlist = self.state / "allowlist.json"
        self.allowlist.write_text(json.dumps({"pages": {
            "launch-party": ["title", "updated_at", "summary", "date", "location"],
            "status": ["title", "updated_at", "summary", "items"],
        }}), encoding="utf-8")
        self.fake_deploy = self.base / "fake-deploy.py"
        self.fake_deploy.write_text(FAKE_DEPLOY, encoding="utf-8")
        self.deploy_log = self.base / "deploy-invocations.jsonl"
        self.deploy_log.write_text("", encoding="utf-8")

    def write_state(self, slug, state):
        (self.state / f"{slug}.json").write_text(
            json.dumps(state), encoding="utf-8")

    def run(self, slug, extra=None, deploy_exit="0"):
        env = dict(os.environ)
        env["FAKE_DEPLOY_LOG"] = str(self.deploy_log)
        env["FAKE_DEPLOY_EXIT"] = deploy_exit
        cmd = [sys.executable, str(self.code),
               "--pages-dir", str(self.pages),
               "--state-dir", str(self.state),
               "--allowlist", str(self.allowlist),
               "--slug", slug,
               "--deploy-script", str(self.fake_deploy)]
        if extra:
            cmd += extra
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              env=env, timeout=120)
        return proc.returncode, proc.stdout, proc.stderr

    def deploy_calls(self):
        text = self.deploy_log.read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def failures(self, slug):
        path = self.state / f"{slug}.failures.jsonl"
        if not path.is_file():
            return []
        return [json.loads(line) for line in
                path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def page(self, slug):
        return self.pages / slug / "index.html"

    def cleanup(self):
        shutil.rmtree(self.base, ignore_errors=True)


GOOD_STATE = {
    "title": "Launch Party",
    "updated_at": "2026-11-18T10:00:00Z",
    "summary": "Rooftop launch, all welcome.",
    "date": "2026-11-20",
    "location": "Rooftop",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", default=str(HERE / "routine-refresh.py"))
    args = parser.parse_args()
    code = Path(args.code)
    mod = load_code(code)
    render_page = fn(mod, "render_page")
    validate_state = fn(mod, "validate_state")
    load_allowlist = fn(mod, "load_allowlist")
    Refusal = fn(mod, "Refusal")

    # ---- render ------------------------------------------------------
    try:
        a = render_page("launch-party", dict(GOOD_STATE))
        shuffled = dict(reversed(list(GOOD_STATE.items())))
        b = render_page("launch-party", shuffled)
        check("1 render deterministic (shuffled key order, identical bytes)", a == b)
    except Exception as e:
        check("1 render deterministic (shuffled key order, identical bytes)", False, str(e))

    try:
        changed = dict(GOOD_STATE, summary="Moved indoors, rain expected.")
        out = render_page("launch-party", changed)
        check("2 state change appears in page, old value gone",
              b"Moved indoors" in out and b"Rooftop launch" not in out)
    except Exception as e:
        check("2 state change appears in page, old value gone", False, str(e))

    try:
        out = render_page("launch-party", dict(GOOD_STATE, summary="<script>alert(1)</script>"))
        check("3 HTML in a value is escaped, never raw",
              b"&lt;script&gt;" in out and b"<script>alert" not in out)
    except Exception as e:
        check("3 HTML in a value is escaped, never raw", False, str(e))

    try:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write("CANARY-9f3a7-secret-contents")
            secret_path = f.name
        out = render_page("launch-party", dict(GOOD_STATE, summary=secret_path))
        check("4 render never reads the filesystem (canary not leaked)",
              b"CANARY-9f3a7" not in out)
        os.unlink(secret_path)
    except Exception as e:
        check("4 render never reads the filesystem (canary not leaked)", False, str(e))

    try:
        out = render_page("launch-party", dict(GOOD_STATE))
        check("5 page states freshness (updated_at + not a live view)",
              b"2026-11-18T10:00:00Z" in out and b"not a live view" in out
              and b"real-time" not in out and b"live push" not in out)
    except Exception as e:
        check("5 page states freshness (updated_at + not a live view)", False, str(e))

    try:
        minimal = {"title": "Status", "updated_at": "2026-11-18T10:00:00Z"}
        out = render_page("status", minimal)
        check("6 required-keys-only state renders, freshness footer kept",
              b"<dl>" not in out and b"Last updated: 2026-11-18T10:00:00Z" in out)
    except Exception as e:
        check("6 required-keys-only state renders, freshness footer kept", False, str(e))

    # ---- allowlist ---------------------------------------------------
    allowlist = {"launch-party": ["title", "updated_at", "summary", "date", "location"]}

    def refuses(name, slug, state, allow=None):
        if validate_state is None or Refusal is None:
            check(name, False, "no validate_state/Refusal in code under test")
            return
        try:
            validate_state(slug, state, allow if allow is not None else allowlist)
            check(name, False, "accepted, should have refused")
        except Refusal:
            check(name, True)
        except Exception as e:
            check(name, False, f"wrong error: {e}")

    refuses("7 refuses a state key not on the allowlist",
            "launch-party", dict(GOOD_STATE, vault_token="x"))
    refuses("8 refuses an unknown slug",
            "not-listed", {"title": "T", "updated_at": "2026-11-18T10:00:00Z"})
    refuses("9 refuses a missing title",
            "launch-party", {k: v for k, v in GOOD_STATE.items() if k != "title"})
    refuses("10 refuses a missing updated_at",
            "launch-party", {k: v for k, v in GOOD_STATE.items() if k != "updated_at"})
    refuses("11 refuses a dict (non-scalar) value",
            "launch-party", dict(GOOD_STATE, summary={"nested": "no"}))
    refuses("12 refuses a secret-shaped value",
            # Built dynamically, never as a literal: the repo secret check
            # must stay green, and no real token is ever in this file.
            "launch-party", dict(GOOD_STATE, summary="token " + "ghp_" + "a" * 20))
    refuses("13 refuses a value naming a workspace/vault path",
            "launch-party", dict(GOOD_STATE, summary="see working.secret/auth.json"))

    try:
        filtered = validate_state("launch-party", dict(GOOD_STATE), allowlist)
        check("14 accepts a clean state, returns exactly the allowlisted keys",
              filtered == GOOD_STATE and set(filtered) == set(allowlist["launch-party"]))
    except Exception as e:
        check("14 accepts a clean state, returns exactly the allowlisted keys", False, str(e))

    # ---- loop --------------------------------------------------------
    def expect_render(slug, state):
        # Fail-first safe: a stub with no render_page yields a sentinel
        # that can never equal a real page, so the check fails cleanly.
        return render_page(slug, state) if render_page else b"<no render>"

    env = Env(code)
    try:
        env.write_state("launch-party", GOOD_STATE)
        rc, _out, _err = env.run("launch-party")
        page = env.page("launch-party")
        calls = env.deploy_calls()
        expected = expect_render("launch-party", GOOD_STATE)
        check("15 first run renders and deploys the WHOLE pages directory",
              rc == 0 and page.is_file() and page.read_bytes() == expected
              and len(calls) == 1 and calls[0]["argv"][0] == str(env.pages))

        before = read_bytes_or_none(page)
        rc, _out, _err = env.run("launch-party")
        check("16 unchanged state: byte-identical file, no deploy",
              rc == 0 and read_bytes_or_none(page) == before and len(env.deploy_calls()) == 1)

        env.write_state("launch-party", dict(GOOD_STATE, summary="Moved indoors, rain expected."))
        rc, _out, _err = env.run("launch-party")
        check("17 state change: page updated, deploy runs again",
              rc == 0 and b"Moved indoors" in (read_bytes_or_none(page) or b"")
              and len(env.deploy_calls()) == 2)

        if page.is_file():
            page.write_bytes(b"HAND EDIT - not a render")
        rc, _out, _err = env.run("launch-party")
        check("18 hand-edited page is overwritten by the pure render (no drift)",
              rc == 0 and read_bytes_or_none(page) == expect_render(
                  "launch-party", dict(GOOD_STATE, summary="Moved indoors, rain expected.")))

        # 19: deploy failure. Change state first so a deploy is attempted.
        env.write_state("launch-party", dict(
            GOOD_STATE, summary="Moved indoors, rain expected.", location="Hall B"))
        calls_before = len(env.deploy_calls())
        rc, _out, _err = env.run("launch-party", deploy_exit="1")
        fails = env.failures("launch-party")
        slug_dir = env.pages / "launch-party"
        leftovers = ([p for p in slug_dir.iterdir() if p.name.startswith(".")]
                     if slug_dir.is_dir() else ["<slug dir missing>"])
        check("19 deploy failure: nonzero exit, failure recorded, page complete, no temp left",
              rc != 0 and len(env.deploy_calls()) == calls_before + 1
              and fails and fails[-1].get("slug") == "launch-party"
              and fails[-1].get("deploy_exit") == 1
              and read_bytes_or_none(page) == expect_render(
                  "launch-party", dict(GOOD_STATE, summary="Moved indoors, rain expected.",
                                       location="Hall B"))
              and not leftovers)
        # Follow-up: the next run retries the deploy instead of
        # concluding "unchanged" from the identical file.
        rc, _out, _err = env.run("launch-party")
        check("19b after deploy failure the next run retries the deploy",
              rc == 0 and len(env.deploy_calls()) == calls_before + 2)

        # 20: allowlist refusal at the CLI, with a good page in place.
        good_bytes = read_bytes_or_none(page)
        env.write_state("launch-party", dict(
            GOOD_STATE, summary="Moved indoors, rain expected.", location="Hall B",
            vault_token="should never publish"))
        fails_before = len(env.failures("launch-party"))
        rc, _out, _err = env.run("launch-party")
        check("20 allowlist refusal: nonzero exit, page untouched, failure recorded",
              rc != 0 and read_bytes_or_none(page) == good_bytes
              and len(env.failures("launch-party")) == fails_before + 1)

        # 21: nothing but pages is published -- the REAL collect().
        env.write_state("launch-party", dict(
            GOOD_STATE, summary="Moved indoors, rain expected.", location="Hall B"))
        env.run("launch-party")
        shutil.copy(BOTPAGE_DIR / "404.html", env.pages / "404.html")
        # deploy-page.py has a hyphen in its name, so load it by path.
        spec = importlib.util.spec_from_file_location(
            "deploy_page_real", str(BOTPAGE_DIR / "deploy-page.py"))
        deploy_page = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deploy_page)
        manifest = {p for p, _d, _h, _c in deploy_page.collect(str(env.pages))}
        check("21 real collect() lists only pages (state/log/lock never published)",
              manifest == {"/404.html", "/launch-party/index.html"},
              f"manifest={sorted(manifest)}")

        # 22: sibling preservation.
        env.write_state("status", {"title": "Status", "updated_at": "2026-11-18T11:00:00Z",
                                   "summary": "All systems normal.", "items": ["a", "b"]})
        env.run("status")
        env.write_state("launch-party", dict(
            GOOD_STATE, summary="Final venue confirmed.", location="Hall B"))
        env.run("launch-party")
        calls = env.deploy_calls()
        last = calls[-1] if calls else {"files": []}
        check("22 refreshing one slug still deploys the sibling page",
              "launch-party/index.html" in last["files"]
              and "status/index.html" in last["files"])

        # 23: lock held by another process.
        lock_path = env.state / "refresh.lock"
        with open(lock_path, "a", encoding="utf-8") as lock_f:
            fcntl.flock(lock_f, fcntl.LOCK_EX)
            good_bytes = read_bytes_or_none(page)
            fails_before = len(env.failures("launch-party"))
            env.write_state("launch-party", dict(
                GOOD_STATE, summary="While locked.", location="Hall B"))
            rc, _out, _err = env.run("launch-party")
            held = (rc != 0 and read_bytes_or_none(page) == good_bytes
                    and len(env.failures("launch-party")) == fails_before + 1)
        check("23 held lock: nonzero exit, page untouched, failure recorded", held)

        # 24: --no-deploy renders without invoking the deploy script.
        env.write_state("status", {"title": "Status", "updated_at": "2026-11-18T12:00:00Z",
                                   "summary": "Rendered only.", "items": []})
        calls_before = len(env.deploy_calls())
        rc, _out, _err = env.run("status", extra=["--no-deploy"])
        check("24 --no-deploy renders without invoking the deploy script",
              rc == 0 and len(env.deploy_calls()) == calls_before
              and b"Rendered only." in (read_bytes_or_none(env.page("status")) or b""))
    finally:
        env.cleanup()

    passed = sum(1 for _n, ok, _d in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
