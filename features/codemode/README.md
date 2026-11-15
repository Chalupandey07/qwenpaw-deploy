# Cloudflare Code Mode — Phase 5 pilot

A **small, bounded pilot** that measures whether Code Mode is worth adopting.
It does not touch QwenPaw's loop, and it does not claim any saving it has not
measured.

Research note: `features/research/code-mode.md`. Package:
`@cloudflare/codemode` v0.5.6 (**Experimental** — pinned, may break).

## What is actually built

| Piece | State |
|---|---|
| Measured classic-vs-Code-Mode comparison (30 tools, 10-step job) | **done, 68 harness checks green, no deploy needed** |
| HTML status page reporting the measurement + deploy-time state | **done** |
| Token-authenticated `POST /api/run`, fail-closed when unset | **done** |
| Audit trail of run attempts (in-memory) | **done** |
| Live sandbox execution (Worker Loader + MCP connector) | **implemented** — runs a fixed, auditable script; tested against a mock loader (success, MCP-down, sandbox-throw) |

### The live path, and the two facts it still depends on

`POST /api/run` **executes** when both bindings exist. It previously returned
`501` unconditionally, which was right about the deploy-time facts and wrong
about the code: a 501 in the success path is a permanently stubbed feature
wearing a disclaimer.

What it does now:
- builds a Worker Loader sandbox via `LOADER.get(id, factory)` and runs a
  **fixed, auditable script** over the 10 bench steps. Fixed on purpose: this
  pilot measures whether the *runtime* works, and a model-generated script
  would confound "the sandbox failed" with "the model wrote bad code".
- gives the sandbox **`globalOutbound: null`** — no network of its own — and
  an `MCP` binding as the only way to reach a tool.
- reports per-step outcomes. If MCP is down, every step says `ok:false`
  rather than the run pretending to have worked.
- returns **502 + the real error** if the sandbox throws, with a note saying
  it is a failure rather than a missing capability.

The two facts only Muse can establish:
1. **`worker_loaders` on the free tier is undocumented.** `wrangler.toml`
   now DECLARES the binding (enabled 2026-11-16, code change only; the Worker
   is not deployed). Deploy and check `/health` for `loader: "bound"` — a
   rejected binding fails the deploy, which settles the question without
   shipping anything, because `src/index.js` feature-detects `env.LOADER` and
   answers a named 503 when it is absent.
2. **The MCP SSE endpoint is not reachable from Cloudflare's edge.** The
   computer-use MCP proxy listens on `172.18.0.1:8898` *inside* the VM and
   needs a published, token-authenticated InstaBox port.

Until both are true, `/api/run` answers `503` and names them — which is a
statement about the deployment, not about the code.

## The measurement (the actual deliverable)

The repo publishes **no benchmarks**, so this harness measures its own:

```
30 tools, 10-step job          classic      code mode
 turns                         10           1
 prompt tokens / turn          2,196        212
 total prompt tokens           21,960       212
                               with one retry: 424
 prompt token reduction        99.0% best case / 98.1% with one retry
turn reduction                 10 → 1
```

These are the numbers the code produces today (`GET /api/bench`), not
aspirational ones. Both columns use the same conservative estimator as
`features/memory/recall.py` (**chars / 3.6**), so the two subsystems report
comparable numbers. It is an estimate, not a tokenizer, and every response
says so.

**Read the reduction as an upper bound, not a constant.** The Code Mode
prompt models 5 connectors with short hints; each additional connector raises
that side and narrows the gap. The harness also does not measure the tokens
the model spends *writing* the script, nor the final result/logs returned to
the context.

**The honest negative results are in the output too:**

- a **single** simple call is **worse** in Code Mode — the generated code
  plus sandbox overhead exceeds one direct tool call (`single_call_job`);
- savings scale with **tool count × step count**, not with call count;
- **desktop work cannot batch screenshots.** Each visual decision needs a
  model turn, so the computer-use bound from the research note still applies;
- a failed script costs a retry, which is why the comparison carries a
  `with_one_retry` column.

## Layout

```
features/codemode/
  README.md                    this file
  harness-codemode.mjs         68 checks, runs the real Worker in Node
  worker/
    wrangler.toml              no KV, no DO (see the comments for why)
    src/index.js               the Worker
```

## Run the harness (no deploy, no account)

```bash
node features/codemode/harness-codemode.mjs
# -> 68 passed, 0 failed
```

It imports the **real** `worker/src/index.js` — the same bytes that get
deployed — and drives it with mocked `env` objects: routing, benchmark
arithmetic (per-turn × turns must equal the stated total), fail-closed auth
(503 when unset, 401 on a wrong token, 405 on GET), honest 503/501 for the
gated paths, the audit trail, and that no token value ever leaks into HTML.

## Deploy (Muse)

```bash
cd features/codemode/worker
npx wrangler deploy                       # creates qwenpaw-codemode
curl https://qwenpaw-codemode.<subdomain>.workers.dev/api/bench

# only if you want the live sandbox path:
#   1. [[worker_loaders]] is now ENABLED in wrangler.toml (2026-11-16) so the
#      deploy can settle the free-tier question; check /health for loader:"bound"
#   2. publish the MCP SSE port with a token (pattern: 6080/6081)
#   3. wrangler secret put MCP_SSE_URL / MCP_SSE_TOKEN / CODEMODE_TOKEN
```

Free-tier cost: a handful of requests/day. No cron, no KV writes, no
Durable Object. This deliberately does not repeat the KV-quota mistake.

## Wrangler note for this box

`npx --yes wrangler@4` fails here with
`ENOENT … lstat '/app/resources/node/lib'`. Install wrangler into a scratch
prefix instead and call the binary directly:

```bash
cd /tmp/wr && npm i wrangler@4 && ./node_modules/.bin/wrangler deploy --dry-run
```

Verified locally: `wrangler deploy --dry-run` → `Total Upload: 16.62 KiB`,
`No bindings found`.

## Deliberately not done

- **No QwenPaw-side code-execution tool** (research note §4 point 3). That is
  a QwenPaw feature, not a Cloudflare integration, and it is the "big change"
  the note says not to start with.
- **No legacy `createCodeTool`.** Its description carries the full type
  block, so prompt tokens do not shrink — only round trips do. Using it and
  reporting a saving would be wrong.
- **No Durable Object / `CodemodeRuntime` facet** until the loader binding is
  confirmed on the free tier. The facet needs `ctx.exports` and the real
  build step; deploying it blind would be cargo-culting.
- **No production routing.** Nothing in the live system calls this Worker.
