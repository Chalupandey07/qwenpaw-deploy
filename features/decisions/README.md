# Decision models — Jev (TypeSafe) and Drex (NACE)

**Status: Drex wired and ready, blocked on the NACE key.** Neither provider
has been called with a real key. Everything below is verified against a
local mock that implements the documented wire format, plus QwenPaw's own
provider source. T130 (21/21) covers the Drex wiring; T84 (33/33) still
covers the fail-closed client and the four integrations.

## What these are (and are not)

Both are **decision models**, not chat models. You send unstructured state plus
*typed questions* and get typed answers with probabilities, in 70–500 ms. There
is **no `/v1/chat/completions`**. Putting one in `active_model` or
`fallback_models` would 404 on every call — which is exactly the mistake the
NACE research warns about three separate ways.

| | Jev | Drex |
|---|---|---|
| Vendor | TypeSafe | NACE |
| Base | `https://api.typesafe.ai` | `https://console.nace.ai` |
| Model | `jev-latest` | `drex-max-v1.1` |
| Input | $0.042/MTok | **$0.03/MTok** |
| Output | never billed | never billed |
| Access | early access, key from console.typesafe.ai | key from console.nace.ai; 120 RPM free |
| Wire format | `POST /v1/systemone` | `POST /v1/systemone` (compatible) |

Because they share the wire format, **one client covers both**. That is not a
convenience: fallback logic, calibration and the audit trail are then written
once and cannot diverge between providers.

## The rule that matters

**No key, no call.** Every entry point fails closed:

- `decide()` raises `DecisionUnavailable` — it never returns a fabricated answer
- `decide_or_none()` returns `None` so a caller can fall back deliberately
- `is_enabled()` is `False`, so a feature can switch itself off
- `verdict_for_tool()`, `triage()`, `route_for_prompt()`, `should_wake()` all
  return `None` when unavailable

There is no simulated mode in a production path. A decision model that answers
without being asked is worse than one that is not installed.

## Safety default: low confidence never means "allow"

`verdict_for_tool()` sends the tool **name and arguments only** — never the
conversation. Sending a chat log to a third party to decide whether a shell
command is safe would leak more than it protects.

If the model answers `allow` with confidence below `0.7`, the verdict is
**coerced to `ask`**. A safety gate that fails open on uncertainty is not a
gate. Verified in the selftest.

## The four integrations

| Function | Question | Gate |
|---|---|---|
| `verdict_for_tool(name, args)` | allow / ask / deny | JEV approval level; overrides the DriverCard's blanket `allow` |
| `triage(message)` | urgent / routine / ignore | mailbox and group-chat routing |
| `route_for_prompt(prompt, routes)` | which of *our* route names | only when the lexical router in `features/routing/` abstained |
| `should_wake(reason)` | true / false | saves Free-tier run-minutes; a wrong `True` burns the day's allowance |

`route_for_prompt` is deliberately second in line: `features/routing/policy.py`
is free and lexical, this costs a call but understands paraphrase. Pay only
when the cheap one abstains.

## Calibration is not optional

"Calibrated probabilities" is the vendor's claim, not something this repo has
verified. `brier()` computes the Brier score (mean squared error of the
predicted probability) and `calibrate()` reports a verdict:

| Brier | Verdict |
|---|---|
| ≤ 0.10 | well calibrated on this sample |
| ≤ 0.20 | usable; keep the conservative threshold |
| ≤ 0.25 | barely better than guessing — prefer `ask` on safety paths |
| > 0.25 | **worse than guessing** — do not gate anything on this yet |

Collect `(predicted_probability, actual_outcome)` pairs from real verdicts and
run `calibrate()` before trusting any threshold. The default `0.7` is a
starting point, not a fact.

## Drex wiring (T130) — ready, blocked on the NACE key

What is wired, all in this directory:

- **`decide.py` — endpoint is configurable, not hardcoded.** Precedence:
  explicit `base=` argument > per-provider env var > provider default.
  Drex reads `NACE_BASE_URL` (default `https://console.nace.ai`), Jev reads
  `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`). Each var is
  scoped to its own provider — `NACE_BASE_URL` can never retarget Jev, so
  a stray var cannot ship the TypeSafe key to NACE. A base must be `https`,
  except `http` on loopback (`127.0.0.1` / `localhost` / `::1`, for the
  local mock); anything else disables the client with a clear reason
  instead of sending a bearer key in cleartext. `status()` reports
  `base_source` (`arg` / `env` / `default`) so a typo'd var name cannot
  silently look like the default. The selftest is unchanged (33 checks);
  the new behaviour is covered by `test_drex.py` (T130).
- **`decision_model_drex.json` — the slot fragment.** The exact fragment
  the apply script writes into both agents' `agent.json`:
  `"decision_model": {"provider_id": "nace", "model": "drex-max-v1.1"}`.
  QwenPaw's `ModelSlotConfig` (`config.py:2558`) has **no endpoint field**,
  so the endpoint does not go in `agent.json`: it lives in the environment
  (`NACE_BASE_URL` + `NACE_API_KEY`). No key lives in the fragment.
- **`apply_decision_model_drex.py` — the machine-apply script.**
  Dry-run by default (changes nothing); `--apply` writes the slot into
  `working/workspaces/default/agent.json` and
  `working/workspaces/QwenPaw_QA_Agent_0.2/agent.json`, backs each file up
  first (`agent.json.bak-<timestamp>`), verifies after writing, never
  touches `approval_level` or any other key, and ensures
  `NACE_BASE_URL=https://console.nace.ai` exists in the machine `.env`
  (appended only if absent; an existing value is left alone). It never
  writes a key. `--apply` fails closed (exit 2, "blocked on NACE key",
  nothing changed) unless the key is in the process environment or the
  `.env` file, or the operator passes `--key-in-settings` to confirm the
  key is already in QwenPaw's encrypted env store.
- **`test_drex_live.py` — the live test the parent runs when the key
  arrives.** Key from the environment only (`NACE_API_KEY`); without one
  it prints "blocked on NACE key" and exits 2 — no fake pass. One
  `POST /v1/systemone` typed choice question; asserts the answer is one
  of the offered options and a probability comes back (0.0 counts as a
  probability; only `None` fails). Prints the resolved base/provider/model
  before the call and never prints the key. A pass means **transport OK
  only** — it proves nothing about calibration.

### What the parent must do when the NACE key arrives (exact commands)

On the machine, as the qwenpaw user (scripts are invoked with `python3`,
never executed directly — the exec bit does not survive a GitHub API
push, so `./script.py` will not work after push):

```bash
# 1. Dry-run first: shows exactly what would change, changes nothing.
python3 features/decisions/apply_decision_model_drex.py

# 2. Put the key where QwenPaw keeps secrets (Settings / encrypted env
#    store, or the machine .env -- never in the repo, never in chat).
#    Then apply (re-run the dry-run command with --apply; add
#    --key-in-settings if the key is in the encrypted store, not .env):
python3 features/decisions/apply_decision_model_drex.py --apply

# 3. Live test (key from the environment only):
NACE_API_KEY='<key from Rohan>' python3 features/decisions/test_drex_live.py
#    Expect: "transport OK: answer='urgent' probability=... latency_ms=..."
#    A 401 means the key is wrong; a 404 means the endpoint/path is wrong.

# 4. Confirm the 'nace' provider resolves on the machine BEFORE touching
#    approval_level (see the caveat below), then re-run the machine-free
#    test to confirm nothing regressed:
python3 features/decisions/test_drex.py   # expect 21 passed, 0 failed
```

Do NOT flip `approval_level` to `JEV` as part of this wiring. That is the
SMART approval patch builder's call, and only after step 4 passes and the
provider resolves.

### Caveat: the `nace` provider registration is NOT verified

`provider_id: "nace"` must resolve in QwenPaw's provider registry for the
slot to do anything. The fork (gogibeta/rakazo PR #8, "Nace Drex as
decision provider + `decide` tool") added Drex as a decision provider in
the fork codebase — that fork is Anand Bose's (gogibeta's); it holds
Rohan's work but lives on the gogibeta account. Whether the deployed
QwenPaw image carries a `nace` provider registration is **not verified**.
If it does not resolve, the slot is inert: `decide.py` in this directory
is the adapter that still needs a registry entry or a
`security/decision_model.py` call path. The parent must check this on the
machine (provider list / `resolve_decision_model`) before calling the
wiring live.

### What is NOT verified live

- No real call to `console.nace.ai` has ever been made (no key yet).
- The `nace` provider registration in the deployed image (see caveat).
- Calibration: the vendor's "calibrated probabilities" claim is
  unverified. Collect `(predicted probability, actual outcome)` pairs
  from real verdicts and run `decide.py`'s `calibrate()` before trusting
  the 0.7 threshold.
- The full Pages-UI → broker path and any browser behaviour (no live
  browser work was done for this gap).

## Wiring it in (when a key exists)

1. **Key** — `TYPESAFE_API_KEY` or `NACE_API_KEY` in QwenPaw's encrypted env
   store, same as `GITHUB_TOKEN`. Never in a file, never in chat, never in git.
   `DECISION_PROVIDER` picks one when both are set (default: drex, it is
   cheaper).
2. **Approval** — QwenPaw already has a `decision_model` slot
   (`config.py:2558`, currently `null` on both agents) and
   `security/decision_model.py::assess_tool_call`, plus
   `typesafe_provider.py::evaluate(state, questions, model="jev-latest")`
   which sends exactly this shape. **Check first** whether
   `assess_tool_call` expects chat-shaped input or `/v1/systemone`-shaped; if
   chat-shaped it needs a small adapter, and this client is that adapter.
3. **Ship it disabled**, log every verdict with its confidence, and compare
   against what a human would have said for a week. Then calibrate.

## Deliberately not done

- **No chat integration.** These models cannot answer a prompt; wiring one into
  a chat slot is a guaranteed 404.
- **No vendored SDK.** `typesafe-ai/skills` and the Jev MCP servers exist, but
  a 200-line stdlib client is auditable and this repo has been burned by
  dependency chains (`genai-prices` needed Python ≥3.11 plus five packages).
- **No JEV MCP server as a second MCP.** QwenPaw's `decision_model` slot is the
  native path; a second MCP adds tool schemas to every prompt for one call.
- **No claim that it works.** It has never run against the real API.
