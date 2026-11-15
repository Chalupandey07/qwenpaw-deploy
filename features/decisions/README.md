# Decision models — Jev (TypeSafe) and Drex (NACE)

**Status: code complete, blocked on keys.** Neither provider has been called
with a real key. Everything below is verified against a local mock that
implements the documented wire format, plus QwenPaw's own provider source.

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
