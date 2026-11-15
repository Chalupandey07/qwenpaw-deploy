# QwenPaw log-check

One place to see **all** QwenPaw logs and find issues constantly: errors and
warnings grouped, **NEW** issues since the last check flagged, every issue
linked to its source log.

## What it checks

Machine logs (read through the InstaBox API — read-only, nothing on the
machine is written, restarted, or changed):

| Source | Where it lives (verified live 2026-11-15) |
|---|---|
| QwenPaw app log | `/data/home/qwenpaw/working/qwenpaw.log` |
| Container log | `docker logs qwenpaw` |
| Camoufox bridge log | `journalctl -u camoufox-bridge.service` — there is **no** `/data/home/camoufox/logs/` directory; the bridge logs only to journald |
| Computer-use MCP log (:1) | `journalctl -u mcp-computer-use.service` |
| Computer-use MCP log (:2 / QA) | `journalctl -u mcp-computer-use-qa.service` |
| Desktop lease watcher log | `journalctl -u desktop-lease-watcher.service` |
| Desktop window watch log | `journalctl -u desktop-window-watch.service` |
| Terminal PTY server log | `journalctl -u desktop-terminal.service` |
| Service states | `systemctl is-active` for the 15 desktop/MCP/bridge units + `docker inspect qwenpaw` health |

Remote statuses (plain HTTPS GET, no tokens needed):

keep-alive Worker `/status`, Pages main console + `/status`, Pages backup
console, routines Worker `/api/status`, group chat Worker `/`, ticket board
Worker `/`, bot Pages `/`.

A source that does not exist is recorded as **MISSING** in the snapshot
instead of failing the run.

## How to run (one command)

From this directory:

```sh
python3 collect.py && python3 report.py
```

Then open `index.html` in a browser — it is a single self-contained file,
no server needed.

- `collect.py` pulls the last 500 lines of each machine log (one InstaBox
  API call for all of them) plus the remote statuses, groups the
  errors/warnings, flags NEW issues, and writes `latest.json`.
  Options: `--lines N` (lines per source), `--out FILE`,
  `--no-update-seen` (dry run — NEW flags computed but `seen.json` left
  alone).
- `report.py` turns the latest snapshot into `index.html`.
  Options: `report.py [snapshot.json] [--out index.html]`.
- `seen.json` holds the normalized issue keys from previous runs.
- `latest.json` is the newest snapshot; `sample-latest.json` is a real
  snapshot from the first live run (2026-11-15), kept as an example.

## How often to run it

- **After every deploy, fix, or restart** — that is when regressions appear.
- **At least once a day** while the test project is running (Phase 1).
- **Whenever something looks wrong** in the console or desktop — run it
  before guessing at a cause; the grouped log is usually faster than
  re-reading raw logs.
- A scheduled run (e.g. a cron job on this VM every morning) is a future
  option; it is not set up yet.

## What NEW means

An issue is **NEW** when its *normalized* text has never been seen in any
previous log-check run. Normalization strips timestamps, PIDs, line
numbers, UUIDs, IPs and other bare numbers, so the same recurring error
groups into one issue with a count and first/last seen — instead of
flooding the report every run.

- NEW does not mean "happened in the last 5 minutes" — it means "first
  time log-check has ever seen this exact problem".
- A fixed issue that comes back is flagged NEW again (its key was never
  recorded as seen while it was absent — actually the opposite: once a key
  is in `seen.json` it stays there, so a returning issue is NOT re-flagged.
  If you fix something and want to know if it returns, delete its key
  from `seen.json` first; the next run will flag it NEW if it is back).
- The first ever run flags **everything** as NEW (seen.json starts empty).
  That is expected — it establishes the baseline.

## What it does NOT do

- No restarts, no writes to the machine, no changes to any service.
- No tokens or keys anywhere: every read is public/status or via the
  machine API. Lines that look like tokens/keys/passwords are redacted
  (`[REDACTED]`) or dropped before the snapshot is written.
- It does not use the second InstaBox account (instabox2) at all.
- It does not touch the live Pages worker (`pages/public/_worker.js`).

## Publishing it as a live page (later — NOT built yet)

Option, documented only — do not build it in this phase:

1. **Scheduled Worker + static report (simplest):** a Cloudflare Worker
   with a cron trigger runs the collector logic (or calls a small endpoint
   on this VM), writes the snapshot JSON + generated HTML into KV/R2, and
   a Pages route (e.g. `/logs`) serves the latest report. Needs: a way for
   the Worker to reach the machine logs — either the collector runs on a
   schedule on this VM and pushes the snapshot to KV via the Cloudflare
   API, or the machine exposes a read-only log endpoint.
2. **Pages route on the existing proxy (closest to the current design):**
   add a `/logs` branch to `pages/public/_worker.js` that serves the
   latest snapshot/report from KV, gated by the same login cookie as
   `/desktop`. This touches the live worker, so it waits until Phase 1
   testing is done.
3. **Keep it local (current):** run the one command and open `index.html`.
   Zero new infrastructure, zero new secrets — the right default while
   the test project is still finding bugs.

Whichever route is chosen later, the collector's output format
(`latest.json`) is already the contract: the live page just renders it.
