# QwenPaw test project (README.md)

A bigger test suite that exercises every QwenPaw feature built in
Phase 0 — console, desktop (Team :1 + Private :2), bridge + Camoufox,
computer-use MCP, routines, group chat, ticket board, bot pages, skills,
mailbox, heartbeat, approvals, fleet, evals, import/export, teach,
needs-you, terminal, maintenance, keep-alive + Pages proxy.

- **`TESTS.md`** — the full catalogue: 61 tests, each with id, area,
  exact check command(s), expected result, method, and evidence.
- **`run-tests.py`** — runs the 49 protocol tests, skips the rest with
  a clear mark, prints PASS/FAIL/KNOWN-GAP/NEEDS-VERIFICATION/
  NEEDS-BROWSER/NEEDS-TOKEN per test, and appends a round record to
  `RESULTS.md`.
- **`RESULTS.md`** — round records (Round 1 is the coordinator's hand-run protocol sweep; Round 2+ are `run-tests.py` runs).

JEV and Drex are NOT implemented yet — there are no tests for them
(PLAN.md Phase 2/3). The log-check option (PLAN.md Phase 1) is a
separate build, not part of this suite.

## How to run

From the repo root (`~/workspace/qwenpaw-deploy`):

```bash
# Full protocol round (records Round N in RESULTS.md)
python3 features/test-project/run-tests.py

# Part of a round
python3 features/test-project/run-tests.py --only T01,T02,T03
python3 features/test-project/run-tests.py --area desktop
python3 features/test-project/run-tests.py --area desktop --area mcp

# Smoke run — no record appended
python3 features/test-project/run-tests.py --only T03 --no-record

# Catalogue
python3 features/test-project/run-tests.py --list
```

Exit code is 0 when no protocol test FAILs, 1 otherwise (skips and
KNOWN-GAP do not fail the run). A full round takes roughly 3–5 minutes
(Round 2 took 142 s; most of it is on-machine exec calls and the
screenshot compare).

## Runner notes (fixes landed in Round 2)

- **HTTP transport is curl, not urllib.** Python urllib raises
  `IncompleteRead` / `RemoteDisconnected` on these Cloudflare responses
  in this environment (9/9 urllib fetches failed while curl got the full
  body every time on the same URLs). The edge sometimes sends
  `Content-Length` and closes early, sometimes a close-delimited body
  with no length at all; curl tolerates both. `http_get` /
  `http_post_json` shell out to `curl -s -w '\n__HTTP_CODE__:%{http_code}'`
  (3 attempts, 5 s sleep, HTTP error codes never retried). Do not switch
  the runner back to urllib.
- **T07 shell join is `"; "`, not `" "`.** Five `for p in N; do …; done`
  loops joined with a bare space are a syntax error (`done for p in …`).
  Round 2 failed T07 with empty output for exactly this reason.
- **T36 counts fresh errors, not all-time errors.** The check compares
  the last `DriverCardError` line with the last watcher-refresh line;
  historical errors fixed in Round 1 (F27) must not fail later rounds.
  See TESTS.md T36.

## What each method means

| Method | Who runs it | What it does |
|---|---|---|
| `protocol` | `run-tests.py` | Public curls from this VM, on-machine commands via `ib.py exec` (machine `m_agq5wqqo2fvypym7rjlpvngc2m`), Cloudflare reads via `cf.py`, local repo/node checks. No login, no user-held token. |
| `browser` | Parent agent, real logged-in browser | Checks no protocol call can do (`/desktop/__status` with a cookie, overlay chrome, take/release, terminal tab, Team→Private render, teach/needs-you end-to-end, agent screenshot in chat). The runner records them as NEEDS-BROWSER. |
| `needs-token` | Coordinator/parent, user-held secret | Console login (satwik password), group-chat post (`GROUPCHAT_TOKEN`), board CRUD (board key), evals live run (`QWENPAW_USER`/`QWENPAW_PASS`). The runner records them as NEEDS-TOKEN and never invents a value. |

Result vocabulary is defined at the top of `RESULTS.md`. Two results
deserve emphasis: `KNOWN-GAP` (currently only T33 — the mailbox Gmail
MCP was never configured; recording the gap is the pass) and
`NEEDS-VERIFICATION` (a guard T49 reports only if a future KV write call
itself errors — the call is verified since Round 2, see below).

## How rounds work

1. Check the machine first: `curl -s
   https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev/status`. If
   `status` is `waking` / `cooldown` / `conflict`, the Free machine is
   paused or cooling down — machine tests are BLOCKED that round, not
   failed. (Free limits: 30-min idle pause, 480-min max run, then a
   5–20 min cooldown.)
2. Run the protocol suite (it appends the round).
3. Run the browser + needs-token tests and paste their rows into the
   round's table in `RESULTS.md`.
4. Fix failures, re-test. A round passes only when every protocol test
   is PASS (or KNOWN-GAP where the catalogue expects it) and the
   browser/needs-token rows are filled. Never edit an old round.

## Rules the runner follows (same as the project)

- Local files only; nothing is pushed or committed by this suite.
- No instabox2, ever (read-only other account).
- No touching `auth.json`, user chats, or `config.json`. No container
  restarts. Heartbeat state is recorded, never changed (T34).
- No token or key is ever written to a file, a log, or `RESULTS.md`.
  T19/T20 read the bridge token from the machine file inside the shell
  command and record only the JSON response. T49 deletes its KV lease
  in a `finally`.
- The state-changing protocol tests are T19 (Camoufox navigates to
  x.com/0xsatwik), T20 (bridge opens a tab on :1), T41/T42 (scratch
  export/import, cleaned up), and T49 (qa lease held ~1–2 min, then
  deleted). Everything else is read-only.

## Findings from building this suite (2026-11-15, all verified live)

These are not test failures — they are what the first round must
confirm or clear. They are also recorded in `TESTS.md` at the tests
they affect.

1. **Skills count is 19, not 18.** The brief said 18 enabled; the
   live `qwenpaw skills list` on 2026-11-15 07:03 IST shows `19 of 19
   skills, 19 enabled, 0 disabled` (the 19th is builtin
   `QA_source_index`). T31 expects 19.
2. **QA DriverCard may fail to parse.** The live `qwenpaw.log` tail
   (lines ~2546–2577 of 2580) contains `yaml.scanner.ScannerError:
   mapping values are not allowed here` and `DriverCardError: Failed
   to parse DriverCard YAML …/QwenPaw_QA_Agent_0.2/drivers/mcp/
   computer-use.yaml`. The QA *MCP server* works (T12 passes), but
   the QA *card* may not load in QwenPaw. T36 parses both live cards
   and greps the log — Round 1 will confirm whether the live file
   still fails.
3. **Bridge /health showed Camoufox on `about:blank`.** T19
   (re-)navigates to x.com/0xsatwik as its own setup; the test
   asserts the end state.
4. **T49's Cloudflare KV write is VERIFIED (Round 2, 2026-11-15).**
   `cf.py put-raw` / `delete` against the KV values endpoint for namespace
   `3eb38e6ebdce41f0a7ed744a99afee46` (DESKTOP_KV) work with the key
   `lease:qa` as-is — no URL-encoding of the `:` needed. If a future
   write call itself errors, T49 reports NEEDS-VERIFICATION with the
   exact command — it does not fail the system for an unproven
   command.
5. **One transient failure seen while building:** T03 (`/api/
   auth/status` via urllib) once failed with `Remote end closed
   connection without response`, then passed on retry (curl and
   urllib both pass consistently since). The runner retries transport
   errors once; HTTP error codes are never retried.
6. **Machine exec budget:** `ib.py exec` defaults to a 60 s command
   timeout — the runner sets `timeoutSeconds` per call (60–180 s).
   Plain `curl` against an SSE endpoint never ends, so every SSE
   check uses `--max-time`; an early probe without a cap ate a whole
   60 s budget.

## Files

| File | What it is |
|---|---|
| `TESTS.md` | Catalogue (61 tests, exact commands, expected results). |
| `run-tests.py` | Runner (stdlib + curl + `ib.py` + `cf.py` + node harnesses). |
| `RESULTS.md` | Round records. |
| `README.md` | This file. |

Repo files the suite reads (never edits): `pages/public/_worker.js`,
`pages/public/desktop-chrome.html`, `features/desktop/*` (services,
`lease-watcher.py`, `computer-use*.yaml`, harnesses),
`features/routines/worker/*`, `features/groupchat/worker/*`,
`features/board/worker/*`, `features/infra/scripts/fleet.py`,
`features/infra/scripts/workspace-export.py`,
`features/infra/evals/*`, `features/infra/prompts/v1/*`,
`features/botpages/*`, `worker/*`.
