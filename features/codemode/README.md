# Cloudflare Code Mode — Phase 5 pilot (VM runner)

A **small, bounded pilot** that measures whether Code Mode is worth adopting
for predictable jobs. It does not touch QwenPaw's loop, and it does not claim
any saving it has not measured.

Research note: `features/research/code-mode.md`.

---

## The Cloudflare path is dead. Do not retry it.

**`worker_loaders` (Dynamic Workers) requires a PAID Cloudflare plan.**

Verified live on 2026-11-16: the Cloudflare Workers API returns

```
403   code 10195   (worker_loaders is not available on this plan)
```

The account is on the free tier and the user has ruled out paying. So:

- the `[[worker_loaders]]` binding in `worker/wrangler.toml` was enabled in
  commit `8e1bdb9` **precisely to settle this question** — a commented-out
  binding cannot answer it — and the deploy attempt returned 10195;
- **`worker/wrangler.toml` and `worker/src/index.js` are kept as the record of
  what was tried**, not as something to deploy. `worker/` is now a museum
  piece with a README note, and nothing should be pointed at it;
- this will not be retried. Re-running it on a free plan cannot produce a
  different answer, and a paid plan is out of scope.

The honest cost of that: the pilot's original home is gone, and the benchmark
below survives because it never needed a loader in the first place.

---

## The replacement: run it on the VM

Execution now happens on the InstaBox machine that already runs QwenPaw —
where the MCP proxy already lives, and where a real process can actually be
bounded.

```
features/codemode/
  vm/
    codemode-runner.py      the runner: fixed job, HTTP surface, audit trail
    mcp.py                  MCP client: SSE discovery + JSON-RPC over POST
    test_mcp.py             27 checks against a REAL SSE + JSON-RPC server
    test_e2e.py             44 checks: runner -> real MCP -> real HTTP
  qwenpaw-codemode.service  systemd unit (Unix socket, RuntimeDirectory)
  harness-codemode.mjs      68 checks for the retired Worker (kept: it still
                            documents the measurement and its arithmetic)
  worker/                   RETIRED. Cloudflare path, kept as the record.
```

### Why the VM is a better home than the edge

| | Cloudflare Worker Loader | VM runner |
|---|---|---|
| Availability | **paid plan only** (403 / 10195) | already running |
| Bound the work | platform sandbox, opaque limits | real `RLIMIT`, wall clock, per-call timeout |
| Reach the MCP proxy | a hop from the edge into a published port | local (`172.18.0.1:8898`) |
| Cost per run | request-metered | nothing metered |
| Debug a failure | logs you cannot attach to | a process you can strace |

### The safety model, given this runs on the box holding `auth.json`

1. **Fixed job only.** There is no `eval`, no `exec`, no template accepting
   caller text. The only way to change what runs is to edit the file and
   commit it. An AST assertion in the selftest enforces the absence — a
   substring check would have passed the retired Worker's fake MCP shape.
2. **No unbounded network.** The runner talks to exactly one URL, from config,
   never from the job.
3. **Bounded time.** `JOB_DEADLINE_S = 120`, `MCP_TIMEOUT_S = 15` per call.
4. **Bounded size.** Every tool response is truncated to 2,000 chars before it
   is kept.
5. **Failure is reported, never hidden.** Each step carries its own outcome;
   a transport failure stops the job and says the remaining steps were *not
   attempted* rather than reporting them as failures.

**The fixed job is read-only**, and that is a change from the Worker version
worth naming: it used `update_ticket`, `add_comment` and `close_ticket`. A
pilot that mutates the board every time it runs is one nobody runs twice, so
those three became `routine_history`, `read_thread` and `search_history`.

### Interface

| Endpoint | What |
|---|---|
| `GET /health` | `{ ok, runtime:"vm", runner:"available", mcp, token, ready }` — `ready` is false without an MCP URL, and says so |
| `GET /api/bench` | the measured comparison, same arithmetic as before |
| `POST /api/run` | runs the fixed job; per-step outcomes; needs `X-Codemode-Token` |
| `GET /api/runs` | audit trail (in-memory, last 20) |
| `GET /` | HTML status page |

Fail-closed and header-only, same rules as the routines Worker: no token
configured means the run endpoint is **closed** (503), and a correct token in
a query string is still rejected (BUGS.md B-18).

Status codes: `200` ok · `502` ran and failed · `503` nothing was executed
(no MCP URL, or no token) · `401` unauthorized · `405` wrong method.

---

## The measurement (the actual deliverable)

Unchanged, because the point is comparability with the earlier numbers:

```
30 tools, 10-step job          classic      code mode
 turns                         10           1
 prompt tokens / turn          2,196        212
 total prompt tokens           21,960       212
                               with one retry: 424
 prompt token reduction        99.0% best case / 98.1% with one retry
turn reduction                 10 → 1
```

These are what the code computes (`GET /api/bench`), not aspirational ones.
Both columns use the repo's estimator (**chars / 3.6**), so they are
comparable with `features/memory/recall.py`. It is an estimate, not a
tokenizer, and every response says so.

**Read the reduction as an upper bound, not a constant.** And the negative
results are in the output too:

- a **single** simple call is **worse** in Code Mode;
- savings scale with **tool count × step count**, not call count;
- **desktop work cannot batch screenshots** — each visual decision needs a
  model turn, so the computer-use bound from the research note still applies;
- a failed script costs a retry, hence the `with_one_retry` column.

---

## Run the tests (no machine, no account, no deploy)

```bash
python3 features/codemode/vm/codemode-runner.py --selftest   # 64 checks
python3 features/codemode/vm/test_mcp.py                     # 27 checks
python3 features/codemode/vm/test_e2e.py                     # 44 checks
node   features/codemode/harness-codemode.mjs                # 68 checks (retired Worker)
```

135 checks across the three VM suites. `test_mcp.py` runs a **real** SSE +
JSON-RPC server in-process; `test_e2e.py` drives the real job through it over
real HTTP. Neither mocks the wire — the retired version's dead
`POST {url}?tool=<name>` call is exactly what three layers of agreeing mocks
failed to catch.

## Deploy (Muse — machine side, no Cloudflare)

```bash
install -d -m 0755 /data/home/qwenpaw/codemode
cp features/codemode/vm/codemode-runner.py features/codemode/vm/mcp.py \
   /data/home/qwenpaw/codemode/
cp features/codemode/qwenpaw-codemode.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now qwenpaw-codemode

curl --unix-socket /run/qwenpaw-codemode/runner.sock http://localhost/health
```

Requires in `/data/home/qwenpaw/.env`: `CODEMODE_TOKEN` (required for
`/api/run`) and `MCP_SSE_URL` (default `http://172.18.0.1:8898`). Without the
first the run endpoint is closed; without the second `/health` reports
`ready: false` and every run reports the blocker.

One-shot, useful for a cron or a manual check:

```bash
python3 /data/home/qwenpaw/codemode/codemode-runner.py --once
```

`--once` is also the only mode that applies `RLIMIT_CPU`/`RLIMIT_AS`, because
a one-shot process can safely cap itself and a long-lived server cannot — the
first version capped the server and would have started returning MemoryError
hours later. `test_e2e.py` caught it.

## Deliberately not done

- **No model-generated code.** The pilot measures the runtime, not a model.
- **No QwenPaw-side code-execution tool.** That is a QwenPaw feature (research
  note §4), not an integration.
- **No legacy `createCodeTool`.**
- **No TCP listener by default.** The endpoint can drive the desktop; it is a
  Unix socket behind a `RuntimeDirectory`, and exposing it would repeat the
  private-port incident.
- **No production routing.** Nothing in the live system calls this runner.
- **No retry of the Cloudflare path.** See the top of this file.
