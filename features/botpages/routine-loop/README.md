# Bot-built Pages routine loop (all-20 gap #15, 2nd gen; provisional T135)

The routine-keeps-the-page-up-to-date loop, on top of the shipped
bot-built Pages (`../build-page-SKILL.md`, `../deploy-page.py`,
project `qwenpaw-pages`). The loop:

    routine fires -> re-read state -> re-render <pages>/<slug>/index.html
    -> redeploy the whole pages directory via deploy-page.py

## Files

| File | Purpose |
| --- | --- |
| `routine-refresh.py` | The loop. Pure render + fail-closed allowlist + atomic write + whole-directory deploy. |
| `test_routine_loop.py` | Machine-free test, provisional T135: **25 passed, 0 failed**. Fail-first proven (0/25 against a stub). |
| `allowlist.example.json` | Example publish allowlist. Copy to the state directory and edit there. |

## How a page stays up to date

1. The page's data lives in a state file **outside the pages tree**:
   `<state-dir>/<slug>.json`, e.g. `{"title": "Launch Party",
   "updated_at": "2026-11-18T10:00:00Z", "summary": "...", ...}`.
   It must live outside the pages tree because `deploy-page.py`
   publishes everything under the pages directory, including `.json`
   files -- a `state.json` kept under `pages/<slug>/` would itself be
   served at `/<slug>/state.json`.
2. A native QwenPaw routine (cron job, see below) runs:
   `python3 routine-refresh.py --pages-dir <workspace>/pages
   --state-dir <workspace>/pages-state --allowlist
   <workspace>/pages-state/allowlist.json --slug launch-party`
3. The loop loads the allowlist, loads the state, validates it
   (fail-closed, see below), renders the page, and writes it atomically:
   render fully in memory -> dot-prefixed temp file in the same
   directory (dot-prefixed so `deploy-page.py`'s `collect()` skips it)
   -> verify the bytes -> `os.replace()`. Never a truncate-in-place,
   never a half-written page.
4. If the new render equals the file already on disk **and** the last
   recorded run deployed successfully, the loop stops: no write, no
   deploy. A full-snapshot deploy on every tick would spend Cloudflare
   API calls for nothing; cost must be proportional to change.
5. Otherwise it runs `deploy-page.py` over the **whole** pages
   directory (a single-file deploy would delete every other page) and
   checks its exit code.

## The page is a pure render of state (no drift)

`render_page()` is a pure function of the allowlisted state dict: no
wall clock, no filesystem reads, no randomness, sorted keys, fixed
formatting. A hand edit to `index.html` does not survive a refresh.

## Idempotent -- and what the freshness line means

Re-running with unchanged state produces a byte-identical file. That
forces one design choice: the freshness line uses the state's own
`updated_at` (the time the routine last refreshed the underlying
data), NOT the wall-clock time of this run. A run-time stamp would
change the file on every run and idempotency would be impossible. The
page says so in plain words:

> Last updated: 2026-11-18T10:00:00Z. This page is a snapshot refreshed
> by a routine run, not a live view.

Freshness = last routine run, not a live push. Never promise a live
feed: Pages is static and the machine has no inbound route.

## Deploy failure: the last good page stays live

`deploy-page.py` creates a deployment only as its final step, so a
nonzero exit means no new deployment exists and the live page is the
previous good one. The loop records the failure (slug, time, exit
code) in `<state-dir>/<slug>.failures.jsonl` -- outside the pages
tree, never rendered into the page -- and exits nonzero. The local
file keeps the complete new render, so the next successful run
publishes it. The loop also records a `deploy_failed` status, so the
next run retries the deploy instead of concluding "unchanged" from
the identical file (without that, a deploy failure would be silently
forgotten). A held lock (two overlapping runs) is the same shape:
nonzero exit, page untouched, failure recorded.

## Publish allowlist: workspace/vault data can never leak

`allowlist.json` is `{"pages": {"<slug>": ["key", ...], ...}}`.
Every slug must list `title` and `updated_at`. The gate refuses,
fail-closed (nonzero exit, page untouched, failure recorded):

- a slug not on the allowlist;
- a state key not listed for that slug (refused, never silently
  dropped -- a silent drop would hide a leak attempt);
- a missing or empty required key;
- a non-scalar value (only strings, numbers, booleans and flat lists
  of those may be published -- a dict could smuggle a path or a secret);
- a secret-shaped value (`ghp_…`, `github_pat_…`, `sk-…`, `AKIA…`,
  the same shapes as the repo secret check);
- a value naming a workspace/vault path (`working.secret`,
  `history.db`, `auth.json`).

The render never reads the filesystem, so a state value can never be
a path that gets inlined, and every value is HTML-escaped. One lock
(`<state-dir>/refresh.lock`) serialises render -> deploy for a pages
directory, so two slugs cannot race a full-snapshot deploy and delete
each other's page. `--state-dir` inside `--pages-dir` is refused
outright: state and logs would be published.

## No sharing / private-link model (deliberate)

Pages URLs are already public; a private link would need an auth
layer, which is out of scope. Public is the intended design for pages
the user explicitly asks to share; accidental publication is
controlled by the allowlist above, not by a sharing model.

## Wiring it as a routine (on the machine, when it is back)

Native QwenPaw cron job (`POST /api/cron/jobs`, jobs.json v2 -- see
`features/routines/README.md`), prompt equivalent to:

    Run: python3 <repo>/features/botpages/routine-loop/routine-refresh.py
      --pages-dir <workspace>/pages --state-dir <workspace>/pages-state
      --allowlist <workspace>/pages-state/allowlist.json --slug <slug>
    Report the exit code and any refusal; do not paste state contents.

The state file itself is written by whatever produces the data (the
agent, or another routine); this loop only reads it. `updated_at`
should be set by the state writer when the data changes.

## Test

    python3 test_routine_loop.py            # 25 passed, 0 failed
    python3 test_routine_loop.py --code /tmp/empty-routine-stub.py
        # fail-first: 0 passed, 25 failed

The test uses temporary scratch directories and a fake deploy script
that only records its invocation -- never the real workspace, never
the live Pages project. Check 21 runs the REAL `deploy-page.py`
`collect()` over the pages directory and asserts the manifest holds
only `index.html` files (+ `404.html`): state, failure log, status
and lock are never published.

## Deliberately left alone

- The sharing model (private links): needs an auth layer; out of
  scope per the evaluation. Not built.
- `deploy-page.py`, the build-page skill, the routines Worker: not
  touched. The loop calls the shipped deploy script as a subprocess.
- No live-push / websocket freshness: impossible on static Pages;
  the page says it is a snapshot.
- No change to `features/test-project/run-tests.py`, `TESTS.md`,
  `RESULTS.md` or `PLAN.md`: the coordinator registers T135
  sequentially (provisional number; it shifts if taken).

## NOT verified live

Nothing here has run on the machine or in a browser: the machine is
suspended (cooldown until ~16:36 IST, 2026-11-18). Not verified: a
real routine firing the loop, a real `deploy-page.py` run from the
loop, the refreshed page served at `qwenpaw-pages.pages.dev/<slug>/`,
or the allowlist against real workspace state. Those are the parent's
job when the machine unlocks.
