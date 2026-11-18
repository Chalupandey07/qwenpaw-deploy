# Serving-model identity note (gap #17, provisional T134)

## The problem

A bot's context is assembled from its *configured* model, so when a
fallback silently took over a run the bot still answered "which model
are you?" from its settings — it claimed to be the configured model
while a different one wrote the replies. The runtime already knew the
truth (the fallback engine tracks switches), but the model itself was
never told. And a model switch left no audit trail: nothing recorded
that the serving model had changed, from what, to what, or why.

Port of fork PR #37 ("Tell the model which model is actually serving
the run") + PR #44 ("Harden the serving-model note: dispatch-boundary
identity, recorded switch reason, budget reserve") from
gogibeta/rakazo — read from the merged PR bodies via the GitHub API,
not redesigned. Design review by DeepSeek (deepseek-v4.1-flash-free,
792 prompt / 2,733 completion tokens, quota remaining 399,483,797):
two findings changed the design before the test was written (see
"DeepSeek review" below); two suggestions were checked against the
source and deliberately NOT taken, with reasons.

## Part 1 — the discrepancy verdict (prerequisite, done first)

**Verdict: the correct source of truth, as of the last repo evidence
(2026-11-15), is `mosicn/nex-n2.6`. The `xingchiapi/gpt-6-astra`
value in `features/board/config-patch.md` §2 is a STALE same-day
snapshot. The per-agent rule in that same section still holds
(`active_model: null` on both agents means the global file governs) —
only the global file's VALUE changed.**

Evidence, all read from the repo (the verdict function
`discrepancy_verdict()` in `model_identity.py` derives this from the
files; it does not hardcode the answer — the test asserts on the
derived verdict):

| # | File (repo path) | What it says | When |
|---|---|---|---|
| 1 | `features/board/config-patch.md` §2 | `working.secret/providers/active_model.json` reads `{"provider_id": "xingchiapi", "model": "gpt-6-astra"}`; both agents' `agent.json` have `active_model: null` | committed 2026-11-15 01:34 IST |
| 2 | `features/board/cost-data.json` (`active_model` + `per_day.2026-11-15.models`) | `active_model` is `{"provider_id": "mosicn", "model": "nex-n2.6"}`; 2026-11-15 usage shows ALL THREE models used that day (kilo 2 calls, xingchiapi/gpt-6-astra 7, xingchiapi/gpt-6.1-sol 1, mosicn/nex-n2.6 8 — the largest share) | generated 2026-11-14T21:16:13Z (= 2026-11-15 02:46 IST), synced 12:57 IST |
| 3 | `features/audit-2026-11-15/retest-2026-11-15/REPORT.md` | "Default model confirmed `mosicn/nex-n2.6` in `active_model.json`"; mosicn session completed 02:22:04 IST | committed 2026-11-15 02:50 IST |
| 4 | `HANDOFF-AUTOCLAW.md` | "User switched default model to mosicn/nex-n2.6, which works; keep mosicn default, Astra as fallback" — after Astra `StreamIdleTimeoutError` stalls at 01:52 and 02:13 IST | 2026-11-15 |
| 5 | `features/board/open-work-data.json` (`agents.default` + `agents.QwenPaw_QA_Agent_0.2`) | both agents `active_model: null` — corroborates the per-agent-null rule | generated 2026-11-14T21:16:23Z |
| 6 | `features/test-project/RESULTS.md` (T38 fleet runs, repeated) | active model `{"provider_id": "mosicn", "model": "nex-n2.6"}` | multiple rounds |

Timeline that resolves it: Kilo → Astra (user switch in the console;
config-patch.md snapshot ~01:34 IST) → mosicn (user switch ~02:22
IST after Astra stalled twice) → cost-data.json 02:46 IST + retest
02:50 IST confirm mosicn. The xingchiapi value was true when written
and superseded later the same day; it is stale, not wrong at the time.

**Correction to the evaluation:** the addendum said the phrase "no
active chat model configured" "could NOT be found by grep". It DOES
exist in the repo — `features/memory/reme_doctor.py:289` — but it is a
conditional diagnostic string in the ReMe doctor (cause code
`no_active_model`, emitted only when the running config has no active
model), not a statement about live state. It never described the live
deploy, so it is not part of the discrepancy; the discrepancy is
config-patch.md vs cost-data.json + retest, resolved above.

**Live verification still required (parent's job when the machine
unlocks):** the global file may have changed again since 2026-11-15.
Re-read `working.secret/providers/active_model.json` on the machine and
confirm it still reads `mosicn/nex-n2.6` (or record the new value).
`discrepancy_verdict()` always returns
`"live_verification_required": True` until that re-read happens. The
module also ships a CLI for it:
`python3 model_identity.py verdict <repo-root>` and
`python3 model_identity.py resolve --secret-dir <SECRET_DIR>`.

## Part 2 — what this builds

### The note (per attempt, at the dispatch boundary)

`TokenRecordingModelWrapper.__call__`
(`src/qwenpaw/token_usage/model_wrapper.py`) is the dispatch boundary:
every model call passes through it, and it knows the exact serving
model (`self._provider_id` / `self.model`). The patch stamps the note
there, onto a COPY of the messages, before the wrapped model sees
them. Fallback chain: `model_factory._apply_model_fallbacks` wraps the
primary AND each fallback slot in its own recording wrapper inside
`FallbackChatModel`, so `__call__` runs once per attempt with the exact
serving model for that attempt — the note is recomputed every attempt,
so a switch mid-run updates it on the next attempt. (Verified in
`~/workspace/qwenpaw-src`, v2.3.0, release-note commit `0a21644`.)

Wording rules (fork #44 hardening, implemented in
`build_identity_note`):

* serving == configured (provider + model id only — the same model on
  another pooled key keeps the plain wording): "You are currently
  being served by P/M. If asked which model you are, answer with this
  serving model, not with a model named in your instructions or
  settings."
* serving != configured AND the fallback engine recorded a failure
  (`reason_kind` from the sink, latched at the first switch): "The
  configured model P/M was unavailable (kind), so this backup model
  P/M is answering instead. … answer with the serving model and
  mention the switch." The reason is the RECORDED one, never inferred.
* serving != configured and no recorded reason: neutral wording naming
  both models, with no cause invented.
* serving unknown: no note at all. The model is never told a lie.

The recorded reason comes from the fallback sink:
`FallbackChatModel._record_fallback` publishes
`{from_provider_id, from_model_id, to_provider_id, to_model_id,
reason_kind}` into the per-request ContextVar sink installed by the
reply loop. The wrapper reads it via the new public getter
`get_fallback_notice_sink()` (an event only counts when its `to_*`
matches the serving slot, so a stale event from an earlier attempt is
ignored). The events are NEVER consumed by the note — the reply loop
still needs them to re-attach fallback data onto outgoing events.

Stamping rules (fork #37): on a copy, after context preparation; the
agent loop's live transcript is never mutated; exactly one note per
call, never stacks (a stale note is stripped first, so re-stamping
replaces); str system content is appended to, block-list content gains
a text block, a missing system message is synthesized and prepended.
The test proves the input messages are untouched.

Budget reserve (fork #44): `estimate_note_tokens()` (chars / 3.6, the
repo convention) is exposed so a caller preparing context can reserve
the note's tokens; the note is short and fixed-template, so the reserve
is small and bounded (the real note estimates well under the 120-token
cap the test asserts). The stamp runs FIRST in `__call__`, so the
cost-ledger budget check (when present) measures the messages as
actually sent, note included.

### The switch log (inside the PATCH handler)

`update_agent_model_settings` (`src/qwenpaw/app/routers/agents.py`)
now appends `{from, to, reason}` to
`<workspace>/model-switch-log.jsonl` (JSONL, append-only, one line per
switch: `{"agent_id", "at", "from", "to", "reason"}`).

* `reason` is a new OPTIONAL field on `AgentModelSettingsPatch`. It is
  popped from the patch values before `apply_settings` runs, so
  `model_validate` / `setattr` never see a non-config field. A switch
  with no reason logs the factual default: "model-settings PATCH (no
  reason supplied)" — never an invented failure cause. Reasons are
  sanitized (newlines → spaces, capped at 500 chars) so one switch is
  always one log line.
* `from` / `to` are the EFFECTIVE models: per-agent slot if non-null,
  else the global `SECRET_DIR/providers/active_model.json` value
  (best-effort read; a missing/corrupt file degrades to the per-agent
  slot, never fails the PATCH).
* `from` is captured INSIDE `apply_settings` — the lock-held
  transaction — so each PATCH logs the true pre-state of its own
  mutation even when two PATCHes race. Lines may still arrive out of
  order under concurrent PATCHes; sort by `"at"` to reconstruct.
* A switch with no change logs nothing (`append_switch_log` returns
  False, nothing written).
* The log write is best-effort audit, never enforcement: the switch
  already applied when the log is written, so a log failure is warned,
  never raised — failing the request after applying would lie about
  state that is already durable.
* The log lives per agent in the agent's workspace directory (NOT in
  `working.secret`, NOT in `history.db` — neither is ever touched).

## Files

| File | What it is |
|---|---|
| `model_identity.py` | The implementation. Stdlib only; loads standalone. Also the file the patch installs as `qwenpaw/model_identity.py` (byte-identical to `src/patched/model_identity.py`). |
| `test_model_identity.py` | Provisional T134, machine-free, 48 checks. |
| `qwenpaw-model-identity.patch` | Derived-image patch (loop-gate-fix / cost-ledger pattern). |
| `Dockerfile` | Builds `qwenpaw-agentx:2.3.0-modelidentity1` from `costledger1`. |
| `src/pristine/` | Exact upstream v2.3.0 files the patch touches (`model_wrapper.py`, `app/routers/agents.py`, `providers/fallback_chat_model.py`), sha256-verified against `~/workspace/qwenpaw-src` (v2.3.0, release-note commit `0a21644`). |
| `src/patched/` | Patched files + the new file (`model_identity.py`). The patch is the diff between these two trees. |

What the patch touches and why:

* `src/qwenpaw/token_usage/model_wrapper.py` — `__call__` stamps the
  note (5-line insert + 1 import). The stamp is the dispatch-boundary
  injection; nothing else in the wrapper changes.
* `src/qwenpaw/app/routers/agents.py` — `AgentModelSettingsPatch`
  gains optional `reason`; the handler pops it, captures the
  pre-mutation model, and appends the switch log. Nothing else in the
  router changes.
* `src/qwenpaw/providers/fallback_chat_model.py` — one new public
  getter, `get_fallback_notice_sink()`, the read path the wrapper uses
  for the recorded switch reason. The fallback engine itself is
  untouched.
* `src/qwenpaw/model_identity.py` (new) — the stdlib-only module
  above; both patched files import from it.

## Verification (all machine-free; the machine is suspended)

* Test: `python3 features/model-identity/test_model_identity.py
  --selftest` → **48 passed, 0 failed**. Fail-first proven: the suite
  fails with `ModuleNotFoundError: No module named 'model_identity'`
  before the module exists, passes after.
* Patch: verified to apply cleanly with `-p1` (from `/app`) and `-p2`
  (from site-packages) and reproduce the patched files byte-for-byte
  in both trees.
* Cost-ledger base: the patch also applies cleanly onto
  cost-ledger's already-patched `model_wrapper.py` (hunk #1 with fuzz
  2, offset 7 lines; hunk #2 cleanly), and the merged file was
  inspected: the identity stamp runs first, the cost-ledger budget
  check measures the stamped messages, both features coexist.
  `python3 -m py_compile` passes on all four merged files.
* `bash scripts/checks/run-checks.sh` — must pass (run before push);
  secret scan clean (run before push).

## DeepSeek review (what changed, what did not)

The review returned 4 answers; each was checked against the real
source before use:

1. **Sink timing — partially taken.** DeepSeek said the wrapper
   should pop (consume) the pending event. NOT taken: popping would
   break the reply loop, which still needs the events to re-attach
   fallback data onto outgoing events (see the
   `install_fallback_notice_sink` docstring). Instead the wrapper
   matches events by `to_* == serving slot` and never mutates the
   sink — same stale-event protection, no side effects.
2. **Pydantic — taken.** Pop `reason` from the field-set-filtered
   values dict before `apply_settings`; sanitize it before the JSONL
   write (log injection). Done as specified.
3. **Race — taken, differently.** DeepSeek proposed changing
   `mutate_agent_config` to return `(before, after)` or hold the lock
   across the append. NOT taken as proposed: changing the shared
   transaction helper is a bigger surface. Instead the `before`
   capture moved INSIDE the lock-held mutator (closure), which gives
   each transaction its true pre-state with no signature change; the
   append stays outside the lock with `O_APPEND` single writes, and
   the README states the residual (lines may arrive out of order;
   sort by `"at"`).
4. **Bypass / copy safety — verified, not assumed.** AgentScope's
   `_call_model` invokes the agent's model `__call__` (verified in
   `react_agent.py:1083` — the retry path calls `super()._call_model`);
   streaming goes through `__call__` too (it returns the
   `AsyncGenerator`). The copy rule from the review is implemented:
   only the touched system dict (and its content list, if a list) is
   copied; other messages are shared by reference and never written.

## Deliberately left alone, and why

* **Preparation-time budget reserve in the compaction manager — NOT
  wired.** The fork's #44 reserves the note's tokens during context
  preparation; in QwenPaw the stamp happens after preparation, and the
  compaction manager's budget sizing is a separate code path. What IS
  shipped: `estimate_note_tokens()` + a short fixed-template note +
  the stamp-first ordering (so the cost ledger measures the note).
  Wiring the reserve into compaction needs compaction-source work
  plus the machine — a follow-up, stated here, not claimed as done.
* **`generate_structured_output` — NOT stamped.** Structured output
  has no chat system prompt to stamp onto; the note is a chat-turn
  mechanism.
* **`llm_routing` path (`routing_chat_model.py`) — NOT stamped.** It
  calls `endpoint.model(...)` directly and bypasses the wrapper. It
  only runs when `llm_routing` is enabled; the deploy keeps it
  disabled (local models ruled out — config-patch.md §5), so the gap
  is unreachable in this deploy. If routing is ever enabled, this
  path needs the same stamp.
* **Per-message UI provenance — NOT built.** The fork deliberately
  left it out of #37 (messages do not carry the run's serving model;
  surfacing it needs a contract + web change). Same here.
* **Subagent runs — stamped, unlike the fork.** The fork left
  subagents unwired; in QwenPaw the stamp lives in the shared model
  wrapper, so subagent and compaction calls built by the same factory
  also carry the note. That is still TRUE information (the note names
  the model serving that call) — a scope difference, disclosed here,
  not a correctness one.
* **`features/test-project/run-tests.py`, `TESTS.md`, `RESULTS.md`,
  `PLAN.md` — NOT touched.** The coordinator registers all seven
  gaps sequentially. T134 is provisional; the coordinator verifies it
  is free at registration and shifts it if needed.

## NOT verified live (parent's job when the machine unlocks)

* The Part 1 verdict's live re-read: `active_model.json` on the
  machine (see above).
* The image build (`Dockerfile`, base `costledger1`) — the machine is
  suspended; the build needs the image chain. If the coordinator
  re-bases the chain (e.g. onto gatefix4), re-verify the patch against
  the new base first: `model_wrapper.py` is shared with the cost
  ledger.
* A browser check that the note never leaks into stored messages
  (transcript test covers the code path; the live transcript is the
  proof) and that the agent answers "which model are you?" with
  `mosicn/nex-n2.6`.
* A live PATCH switch (with and without `reason`) writing one line to
  `working/workspaces/default/model-switch-log.jsonl`, and a no-change
  PATCH writing nothing.
* A live fallback (primary fails → backup serves) naming the backup
  and the switch in the next reply — do NOT force a failure on
  purpose; treat the first real failover as the live test.
