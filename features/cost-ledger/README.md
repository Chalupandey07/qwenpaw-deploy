# Cost ledger with a hard kill switch (gap #5, research §2 gap 10)

## The problem

`token_usage.json` exists and is read — but it is read-only telemetry with
no spend limit at all (verified in `features/approvals/README.md`: grep for
`spend|budget|cap` over `token_usage/*.py` and `config.py` returns nothing;
there is no hook that reads usage before a call and refuses it). Own keys +
cloud-only + fallback chains = a runaway loop can burn real money overnight.
Tool-call caps do not bound tokens: one giant context per call is unbounded
(the loop-gate bounds calls, not tokens).

## What this builds

A real ledger plus a cap, in `features/cost-ledger/`:

| File | What it is |
|---|---|
| `cost_ledger.py` | The implementation. Stdlib only; loads standalone. Also the file the patch installs as `qwenpaw/token_usage/cost_ledger.py` (byte-identical to `src/patched/cost_ledger.py`). |
| `cost_server.py` | Reference `/cost` server (stdlib `http.server`). Runnable spec, not the deployed endpoint. |
| `cost-prices.json` | Static price table (USD per 1M tokens). Sync to the machine as `working/cost-prices.json`. |
| `cost-budget.json` | Default budget. Sync to the machine as `working/cost-budget.json`. |
| `qwenpaw-cost-ledger.patch` | Derived-image patch (loop-gate-fix pattern). |
| `Dockerfile` | Builds `qwenpaw-agentx:2.3.0-costledger1` from `bloatwinwin1`. |
| `test_cost_ledger.py` | T125, machine-free, 55 checks. |
| `src/pristine/` | Exact upstream v2.3.0 files the patch touches (`model_wrapper.py`, `app/routers/__init__.py`), sha256-verified against `~/workspace/qwenpaw-src` (v2.3.0, release-note commit `0a21644`). |
| `src/patched/` | Patched files + the two new files (`cost_ledger.py`, `cost.py`). The patch is the diff between these two trees and was verified to apply cleanly (`-p1` and `-p2`) and reproduce the patched files byte-for-byte. |

## The ledger format

The ledger reads the EXISTING `token_usage.json` format and never changes
it — the file is the source of truth. Top-level keys are dates; each maps
an `"agent\x1fprovider\x1fmodel"` key (`\x1f` = unit separator) to
`{provider_id, model_name, prompt_tokens, completion_tokens,
cache_read_tokens, cache_write_tokens, call_count, agent_id}`.

Billing rules (stated, not hidden):

- Billable input = `prompt_tokens` ONLY. `cache_read_tokens` /
  `cache_write_tokens` are a SUBSET of `prompt_tokens` (see
  `token_usage/manager.py` `_cache_usage_metrics`: the cache-eligible
  denominator IS `prompt_tokens` for non-Anthropic providers), so adding
  them would double-count. They are reported, never billed. (T125 A13:
  10,000 prompt with 8,000 cache-read bills $0.01, not $0.018.)
- Billable output = `completion_tokens`.
- Cost = input/1M × input price + output/1M × output price, priced by
  `provider:model` first, then by model name alone.
- A model with no price has cost `None` (unpriced) — its TOKENS still
  count, and the token budget still binds it. The TOTAL cost figures are
  the sum over PRICED models (a lower bound when unpriced models exist);
  `*_cost_known: false` means the total is partial, not unknown. (This
  was a real bug the post-implementation DeepSeek review caught: the
  first version returned `None` for the whole day's USD whenever ANY
  model was unpriced, which disabled the USD cap entirely.)
- "Per-run" in the ledger = the current process run, tracked in memory
  by the gate (`run_prompt_tokens`, `run_completion_tokens`, `run_cost_usd`,
  `run_calls`, reported as `current_run` by `/cost`). The file itself has
  no run id — it aggregates by (date, agent, provider, model) — so
  per-day and cumulative are what the file can prove; per-run is what the
  live gate counted since process start.

## The price table

`cost-prices.json`, USD per 1,000,000 tokens. Static only — no price is
ever fetched from the network (T125 E1/E2: no `httpx`/`requests`/
`urllib.request`/`urlopen` anywhere in the ledger, server, or router, and
no URL in the price file).

| Model | In | Out | Note |
|---|---|---|---|
| `kilo:kilo-auto/free` | $0.00 | $0.00 | Free tier, $0 by definition |
| `deepseek:deepseek-v4.1-flash-free` | $0.00 | $0.00 | Free tier, $0 by definition |
| `jev:jev-1.13-free` | $0.00 | $0.00 | Free tier, $0 by definition |
| `mosicn:nex-n2.6` | $1.00 | $3.00 | **REPO DEFAULT PLACEHOLDER — NOT a vendor quote.** The real price was not verified against any vendor page. Edit these two numbers to the real price before trusting the USD totals; until then the TOKEN budget is the binding cap. |

The user edits the table (in `working/cost-prices.json` on the machine, or
in the repo file before sync); the code falls back to its baked-in copy
when the file is absent or corrupt (and logs a warning — silently dropping
the user's prices would understate cost).

## The /cost endpoint

Spec (deployed: FastAPI router `src/patched/cost.py`, mounted at
`/api/cost` beside `/api/token-usage`; reference: `cost_server.py`):

- `GET /api/cost` — today + cumulative tokens and USD cost, per-model and
  per-day breakdown, budget remaining (tokens + USD), `status`
  (`allow`/`alert`/`deny`), `fraction_of_budget`, `current_run`,
  `denied_calls`. Figures come from the live `TokenUsageManager` summary
  (which includes the in-memory buffer, not just the flushed file).
- `GET /api/cost/prices` (reference server only) — the price table in use.
- `POST /api/cost/budget?daily_token_budget=N&daily_usd_budget=M` — set
  the daily budgets. Validated (> 0 or null), atomically persisted to
  `working/cost-budget.json`, applied to the process-wide gate in place.
  **This is the command that raises the budget and unblocks denied
  calls — no restart needed.**
- `POST /api/cost/reset` — clears today's alerted/denied counters. It
  does NOT reset spend: if spend is still over budget, calls stay denied
  until the budget is raised.

Reference server:

```bash
python3 cost_server.py --usage token_usage.json --prices cost-prices.json \
    --budget cost-budget.json --state cost-ledger-state.json --port 8896
curl http://127.0.0.1:8896/cost
```

CLI (same summary as JSON, no server):

```bash
python3 cost_ledger.py --usage token_usage.json --prices cost-prices.json \
    --budget cost-budget.json --today 2026-11-18
python3 cost_ledger.py --budget working/cost-budget.json \
    --set-budget-tokens 500000 --set-budget-usd 10
```

## The 80% / 100% behaviour

Budgets are DAILY (local date). Either cap binds: the day stops when the
token cap OR the USD cap is reached. A cap set to `null` disables it
(not recommended for both at once).

- **Below 80%** — calls proceed normally.
- **At 80%** — alert: one JSONL record is appended to
  `working/cost-alerts.jsonl` and the date is recorded in
  `working/cost-ledger-state.json`, once per day. Calls still proceed.
  The alert names the spend, the fraction, and the binding cap.
- **At 100%** — HARD STOP: `enforce_before_model_call` raises
  `CostBudgetExhaustedError` BEFORE the wrapped model is awaited, so no
  tokens are spent. The message always starts `Budget exhausted` and
  names the cap, the spend, and the remedy (raise or reset the budget).
  No further model calls until the budget is raised (`POST
  /api/cost/budget`) or reset (`POST /api/cost/reset` + raise — a reset
  alone does not unblock an over-budget day).

Concurrency: parallel calls reserve estimated input tokens BEFORE the
model call, and the projection (spent + already reserved + this estimate)
is what is checked — N calls issued at 99% cannot all slip through on
the same stale reading (T125 R1–R3). The reservation is released once
the real usage is recorded; the next check reads real totals, because
the buffer's merged data includes queued-but-unflushed events and the
5 s summary cache is invalidated when a call completes (a real
spend-through window the post-implementation DeepSeek review caught).

Estimation: input tokens for a not-yet-made call are estimated as
`chars / 3.6` (the repo-wide convention). Output tokens are NOT
estimated: a call admitted at 99% can still emit output past the cap,
and the NEXT call is denied — the cap bounds the day, not a single
call's output.

Fail-open, bounded: if the usage summary cannot be read (transient
file/buffer error), the call is allowed using the last-known-good
snapshot for TODAY plus the reservations — a failed read must not take
down every chat. The exposure is a handful of calls. Two bounds: a
snapshot from a previous day never decides today's calls, and if the
snapshot itself is already at/over 100% the call is denied. A manager
import failure is logged as a warning (it is a packaging bug, not a
transient error) and falls back the same way.

## How the user sets the budget

Defaults (repo defaults, NOT amounts the user agreed to):

- Daily token budget: **200,000 tokens/day** — about 2.5× the observed
  2026-11-14 day (~73,000 tokens, see `features/approvals/README.md`).
  Agentic loops resend full context every turn, so a busy day can reach
  this honestly — the 80% alert is the warning to raise it, not proof
  of a runaway.
- Daily USD budget: **$5.00/day** — a conservative round number. The
  active model is free, so USD spend is $0 until a paid provider is
  used; $5/day bounds the first paid-model surprise.
- Alert at 80% of either cap.

Three ways to change them (all equivalent; the file is the persisted
one, the endpoint and CLI write it):

```bash
# 1. The endpoint (live, no restart):
curl -X POST "https://<console>/api/cost/budget?daily_token_budget=500000&daily_usd_budget=10"
# 2. The CLI (on the machine, in the working directory):
python3 cost_ledger.py --budget working/cost-budget.json --set-budget-tokens 500000
# 3. Edit working/cost-budget.json directly, then restart the container
#    (only this way needs a restart — the gate reads the file at startup).
```

## The derived-image patch

`qwenpaw-cost-ledger.patch` (against pinned upstream
`agentscope/qwenpaw:v2.3.0`, the same base the live image uses) changes
four files:

- `src/qwenpaw/token_usage/cost_ledger.py` (NEW) — the ledger, gate,
  budget/prices/state handling, and the async pre-call enforcement.
- `src/qwenpaw/token_usage/model_wrapper.py` — `__call__` and
  `generate_structured_output` await the pre-call check before delegating
  to the wrapped model; the reservation is released in a `finally` after
  the real usage is recorded (streaming releases in `_wrap_stream`'s
  `finally`). Run totals for `/cost` are noted in `_record_usage`.
- `src/qwenpaw/app/routers/cost.py` (NEW) — the `/cost` router.
- `src/qwenpaw/app/routers/__init__.py` — registers the router after
  `token_usage_router`.

Build (on the InstaBox machine; the parent builds/deploys, not this
feature):

```bash
cd /data/home/qwenpaw/cost-ledger   # or wherever the files were synced
docker build -t qwenpaw-agentx:2.3.0-costledger1 .
```

Base is the live `bloatwinwin1` image, so the loop-gate fix and the
telemetry removal survive. The Dockerfile applies the patch to BOTH
copies (`/app/src` and site-packages — the package is imported from
site-packages, patching `/app/src` alone leaves the running code
unpatched; that exact failure happened with gatefix1) and fails the
build if the patch does not apply cleanly. The patch touches only files
neither gatefix3 nor bloatwinwin1 changed, plus two new files.

Machine-side files to sync (parent's job): `cost-prices.json` and
`cost-budget.json` → `/data/home/qwenpaw/working/` (the patch reads
them from the working directory at runtime; the baked-in defaults apply
when they are absent). Nothing in this feature touches
`working.secret/auth.json`, user chats, or `history.db`, and the patch
never deletes usage history.

Verify the image (before switching the live container):

```bash
docker run --rm qwenpaw-agentx:2.3.0-costledger1 python3 -c "
from qwenpaw.token_usage.cost_ledger import CostGate, Budget
g = CostGate(budget=Budget(daily_token_budget=100000, daily_usd_budget=None))
print(g.check(80000, None).status)   # expect alert
print(g.check(100000, None).status)  # expect deny
"
docker run --rm qwenpaw-agentx:2.3.0-costledger1 python3 -c "
from qwenpaw.app.routers.cost import router
print([r.path for r in router.routes])  # expect /cost, /cost/budget, /cost/reset
"
```

Deploy: snapshot first (record the id; at the 5-snapshot Free limit
delete the worst superseded snapshot first per standing delegation;
never delete `qwenpaw-phase0-verified`), change only the image line in
`docker-compose.yml` to `qwenpaw-agentx:2.3.0-costledger1`, restart,
confirm the console comes back. Rollback: revert the image line to the
previous image (or restore the snapshot if the container will not start).

## What the patch does not cover (honest limits)

- **Calls that bypass `TokenRecordingModelWrapper`** (raw provider SDK
  calls, embedding calls) are not gated. The wrapper is the funnel for
  every agent model call (verified: `model_factory.py` wraps all three
  construction paths), but a caller that reaches a provider directly
  spends ungated.
- **Abandoned streams under-count**: usage is recorded when a stream
  completes; a stream abandoned mid-way records nothing (its reservation
  is also never released — the same `finally` that records usage
  releases it). The next check then under-counts that call.
- **Output tokens are not reserved**: a call admitted at 99% can emit
  output past the cap; the cap bounds the day, not one call's output.
- **Compaction/summarisation calls are not exempt**: if the budget is
  exhausted, the call that would summarise the context back under
  budget is denied too. The remedy is the same as for any other call:
  raise the budget.
- **Single process**: the gate is in-process (reservations, run totals,
  the 5 s cache). A second worker or the ACP server process holds its
  own gate; the file-based daily totals are the shared truth, but
  reservations do not cross processes.
- **Structured-output estimates are best-effort**: the message list is
  `args[0]` when present, else 0 — the spent check still applies, only
  the reservation is empty.

## DeepSeek design reviews

Two calls, `deepseek-v4.1-flash-free` via
`custom.100milionseek/bin/seek.py --max-tokens 65536 --context`.

1. **Pre-implementation** (2026-11-18, 981 prompt / 2,774 completion
   tokens): flagged the parallel-call race (fixed with reservations),
   streaming under-count (documented as a limit), the fail-open question
   (adopted: fail-open, bounded, with the at/over-100% exception),
   cache-token double-counting (avoided: prompt_tokens only), price keys
   by model name alone (fixed: `provider:model` first), and the 200k
   default being low for agentic loops (kept, with the rationale
   documented — it is 2.5× the observed day and the 80% alert is the
   warning to raise it).
2. **Post-implementation, against the finished code** (2026-11-18,
   10,436 prompt / 7,016 completion tokens): caught four real bugs, all
   fixed and covered by new T125 checks — (a) the 5 s summary cache hid
   real spend after a call completed (fixed: cache invalidated in
   `note_completed_call`, R4); (b) the whole day's USD became `None`
   when any model was unpriced, disabling the USD cap (fixed: priced
   partial sums everywhere, A15b/A15c); (c) the last-known-good snapshot
   was never date-checked and only persisted on alert (fixed: date
   check + persist on every successful read); (d) state-save failures
   other than `OSError` propagated before the reservation was returned
   (fixed: `except Exception`, best-effort). Two findings checked out as
   non-issues against the real patched wrapper: no double release on
   the streaming path (the stream branch returns before the
   non-stream `try/finally`), and every `get_process_gate` caller passes
   `WORKING_DIR` (no bare call can lock in defaults).

## Test (T125)

```bash
python3 features/cost-ledger/test_cost_ledger.py            # 55/55
python3 features/cost-ledger/test_cost_ledger.py --no-cap    # 28 passed, 6 failed (fail-first)
```

Fail-first: `--no-cap` runs the same denial scenarios against a stub
gate that always allows (the pre-change behaviour: no cap exists). The
6 failures are exactly B2/B3/C1/C2/C3/C4 — the alert at 80% and the
denials at 100%/150% — proving the test fails without the ledger and
passes with it.

Coverage: (a) ledger math on a hand-computed sample (350,000 prompt /
110,000 completion / 460,000 total / 23 calls / $0.57; today 210,000
tokens / $0.22 / 15 calls); (b) 80% alert at exactly 80,000/100,000 and
not at 79,999; (c) 100% hard stop refuses a simulated model call with
the `Budget exhausted` denial (0 executions at 150%); (d) raising the
budget unblocks calls; (e) no network fetch (static checks on all three
code files + no URL in the price table); plus reservation race,
alert-once-per-day, denial counter, cache invalidation, USD partial
sums, budget validation/atomic save, patch dry-run + byte-for-byte
reproduction, CLI, and the reference server (GET /cost, POST
/budget, POST /cost/reset).

Bugs the test itself caught while being written: the test loader did
not register the module in `sys.modules`, which Python 3.12
`dataclasses` requires (first run: 0/1, `AttributeError: 'NoneType'
object has no attribute '__dict__'`); the estimator counted the
message `role` as content (3,600 chars estimated 1,002 tokens instead
of 1,000). Both fixed in the test / implementation respectively.

## What is NOT verified live

- No Docker image built (parent's job — `Dockerfile` above).
- No machine deploy, no browser check: the live `/api/cost` response,
  the real deny in a chat at 100% (what the agent loop does with
  `CostBudgetExhaustedError` — it surfaces as a visible error, not
  silent spend, but the exact loop behaviour is unverified), and the
  budget-raise unblock in a real session are all for the parent to
  verify after deploy.
- The patch was verified against the `qwenpaw-src` v2.3.0 checkout
  (byte-identical pristine files), not against the container's
  site-packages copy — the Dockerfile's `patch` step is the check that
  catches a drift there.
