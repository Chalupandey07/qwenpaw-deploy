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

**The fixed job drives the real desktop** (B-41). It is no longer read-only —
every step's `mutates` flag says whether it moves the pointer or types. It stays
re-runnable because it leaves no persistent state: no file, no ticket, no agent,
no store write. See "The job drives the real desktop" below.

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

## The measurement (the actual deliverable) — REBUILT 2026-11-17 (B-41)

**The previous numbers were measured against tools that do not exist and are
withdrawn.** The bench modelled **30 tools** and a **10-step job**; the machine's
MCP proxy exposes **nine**, all desktop-interaction, and nine of those ten steps
named tools that are not there. The live run on 2026-11-16 scored **1/10** with
nine `unsupportedTool` errors, while `/api/bench` reported a 99.0% reduction.

Both figures are now computed from `DESKTOP_TOOLS`, the nine real tools
(`list_apps`, `get_app_state`, `click`, `type_text`, `press_key`, `scroll`,
`set_value`, `drag`, `perform_secondary_action` — verified live via
`McpClient.list_tools()` and pinned by T11/T12).

### What the honest result looks like

```
9 real desktop tools, 9-step job     classic      code mode
 turns                                9            9      ← NO collapse
 prompt tokens / turn                 388          128
 total prompt tokens                  3,492        1,152
 prompt-size reduction                67.0%
 turn reduction                       none
```

**The turn count does not collapse, and that is the finding.** Desktop work is
observe → decide → act: each step needs the model to look at the screen before
choosing the next action, and a sandboxed script cannot supply that visual
judgment (`features/research/code-mode.md` §4, the visual-judgment bound). Code
Mode therefore removes **prompt weight** — nine tool schemas become one — and
not turns. Claiming a 9× turn reduction for this surface would be the same
mistake as the withdrawn 99%.

A **batched** workflow of the same size (a routine, a data job) is reported
separately in `/api/bench` as `batched_job_hypothetical`, explicitly labelled
`NOT the desktop job`, with the collapsed-turn arithmetic and its one-retry
column (96.3% / 92.7% prompt-size). Keeping it visible next to the desktop
number is deliberate: it is the shape the old figure was really describing, and
labelling it is more useful than deleting it.

### The estimator is unchanged

Both columns use the repo's estimator (**chars / 3.6**), so they stay comparable
with `features/memory/recall.py`. It is an estimate, not a tokenizer, and every
response says so.

**Schema shapes are the job's real parameters, not invented ones.** The old
`schema_tokens()` gave EVERY tool `id` and `body` fields — wrong for a `click`,
and inflating each schema. Schemas are now built from `TOOL_PARAMS`, the
arguments the job actually passes. They are still not the proxy's real
`inputSchema`; that is only knowable on the machine, which is why every run now
records it (see `describe_surface()` below).

### Every required argument, from the schema (B-42)

A live run of the B-41 job (`run_1a1e8e3d9f9`, 2026-11-17) scored **1/9**:
`list_apps` worked, and all eight interaction steps answered

```
Missing required argument: app
```

The proxy's real `inputSchema` — captured by `describe_surface()` in that same
run — requires `app` on every tool except `list_apps`. B-41's "minimal args"
were minimal for a *wrong guess* at the surface, not for the real one.

The fix is not "add `app` to eight steps":

* `TOOL_REQUIRED` is a table of the arguments each tool **marks as required**,
  taken from the live schema. It is separate from `TOOL_PARAMS` (which shapes
  the schema and the token estimate) because the two answer different
  questions, and a single dict cannot express "in the schema, required at call
  time".
* `app` is never hard-coded. Steps carry `APP_FROM_LIST`, and `preflight_step()`
  substitutes the name resolved from **step 1's own `list_apps` result**
  (`parse_running_apps()` reads the real `Name -- Name [running, pid=…, window=…]`
  format; `pick_app()` prefers an app with a real window over
  `xfce4-panel`/`xfdesktop`/`xfwm4`). Hard-coding "Chromium" would pass today and
  fail the first time the browser is closed.
* `preflight_step()` checks the required table **before** spending a call, so a
  missing argument becomes one named, skipped step instead of eight identical
  tool errors discovered one round trip at a time.
* **No running app is an honest shortfall, not a pass.** The run reports
  `status: partial` with `failed: 0, skipped: 8` and names the missing argument.
  Only `allow_interaction=False` — a deliberate mode — reports `ok` with skips.
* `schema_tokens()` now emits `required` too, so the schema the token estimate
  is built from describes a surface that can actually be called. Before this,
  the schema said `app` was optional while the proxy refused every call without
  it — the estimate was of a surface nobody could call.

**The mock now enforces the contract.** `MockMcpServer(required_args=…)` and
`FakeMcp` both reject a call missing a required argument with the proxy's own
wording. That is the specific gap that let B-41's suites stay green while the
live run scored 1/9: a fake that accepts any argument shape cannot reproduce
the machine's refusal. Verified against an **independent** fake written outside
the runner, which does not read the runner's tables:

```
pre-fix job vs live-faithful proxy : 1/9 ok, 8 failed
fixed job  vs the same proxy       : 9/9 ok, 0 failed
```

### Self-diagnosis on every run

`describe_surface()` asks the live proxy what it offers and diffs it against the
job:

```json
{"offered": [...], "expected": [...], "missing": [...], "unexpected": [...],
 "matches": true, "schemas": {"click": {...inputSchema...}}}
```

A run whose `missing` is non-empty says so in its `note` before any step runs.
This is the check that would have turned the original "9 of 10 steps failed"
into one glance: **the job asked for tools that were not there.**

### The job drives the real desktop — it is not read-only

Every step carries `mutates`:

| Steps | `mutates` | Effect |
|---|---|---|
| `list_apps`, `get_app_state` | `false` | observation only |
| `click`, `type_text`, `press_key`, `scroll`, `set_value`, `drag`, `perform_secondary_action` | `true` | moves the pointer, sends keystrokes |

Nothing here writes a file, creates a ticket, starts an agent or touches the
QwenPaw store — the effect is transient and dies with the window, which is what
makes it re-runnable. It is **not** the same property as "read-only", and the
previous wording said read-only because all ten of its tools were API calls.
`allow_interaction=False` runs only the two observation steps and reports the
rest as `skipped` (never as `failed`), so the pilot has a safe mode.

## Run the tests (no machine, no account, no deploy)

```bash
python3 features/codemode/vm/codemode-runner.py --selftest   # 125 checks
python3 features/codemode/vm/test_mcp.py                     # 31 checks
python3 features/codemode/vm/test_e2e.py                     # 48 checks
node   features/codemode/harness-codemode.mjs                # 68 checks (retired Worker)
```

204 checks across the three VM suites. `test_mcp.py` runs a **real** SSE +
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
