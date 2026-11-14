# Feature #15 — Model fallbacks + per-bot model + thinking level

## Status: PROPOSAL ONLY — nothing applied

This file proposes an exact, verified change. It is **not** applied.
Applying needs the user's OK, and it is applied through QwenPaw's own
API (which validates the slots and reloads the agent) — never by editing
files on the machine, and with no container restart.

## What was verified live (2026-11-15, machine m_agq5wqqo2fvypym7rjlpvngc2m)

### 1. QwenPaw DOES support an ordered fallback chain — per agent

Source (inside container `qwenpaw`, image `agentscope/qwenpaw:v2.3.0`):

- `/app/src/qwenpaw/config/config.py:2564` — `AgentConfig.fallback_models:
  List[ModelSlotConfig]`, described as
  "Ordered chat model fallback chain for transient failures".
- `/app/src/qwenpaw/config/config.py:204` — `ModelSlotConfig` is exactly
  `{provider_id: str, model: str}`. Nothing else.
- `/app/src/qwenpaw/config/config.py:2275` — `FallbackPolicyConfig` is
  `{enabled: bool = True, target_scope: "configured" | "free_only"}`.
- `/app/src/qwenpaw/config/config.py:2550` — `AgentConfig` also carries
  `active_model`, `decision_model`, `subagent_model`, `thinking_level`,
  `thinking_budget`, `llm_routing`.
- `/app/src/qwenpaw/agents/model_factory.py:2357,2409-2488` —
  `_apply_model_fallbacks()` reads `agent_config.fallback_models` and
  builds an ordered `FallbackChatModel([primary, *fallbacks])`. It
  **skips** any slot whose provider is missing/disabled, whose model is
  unknown, or which duplicates the primary; with `target_scope:
  "free_only"` it also skips non-free models. Fallback models get
  `max_retries = 0`. If only the primary survives, no fallback wrapper
  is built.
- `/app/src/qwenpaw/providers/fallback_chat_model.py:39-40` —
  "Try configured models in order before any response becomes visible."
- `/app/src/qwenpaw/app/routers/agents.py:1353` — `PATCH
  /api/agents/{agentId}/model-settings` patches exactly these fields
  (`AgentModelSettingsPatch`: `active_model`, `decision_model`,
  `fallback_models`, `fallback_policy`, `subagent_model`,
  `thinking_level`, `thinking_budget`). It validates every slot with
  `validate_model_slot()` (unknown/disabled model → HTTP 422, nothing
  applied) and then triggers an agent reload. No restart needed.

### 2. Where the settings live (this is the part Astra-style guesses get wrong)

- Fallbacks/thinking level live **per agent** in the workspace file
  `working/workspaces/<agent>/agent.json` (`AgentProfileConfig`).
  They do **NOT** live in `working/config.json`: that file has no
  `providers`, no `fallback` key (grep count 0), and its
  `agents.profiles.<id>` entries only carry `id/workspace_dir/enabled/
  pinned`. The `agents.llm_routing` block in `config.json` is a
  different feature (see §5).
- The **primary model is global**, not per agent:
  `working.secret/providers/active_model.json` currently reads
  `{"provider_id": "xingchiapi", "model": "gpt-6-astra"}`. Both agents'
  `agent.json` files have `active_model: null`, so both use that global
  model today. (Memory said Kilo was active; the user switched to GPT
  Astra in the console on 2026-11-15 — verified live, see cost page.)
- Current per-agent state (read live from both `agent.json` files):
  `fallback_models: []`, `fallback_policy: {"enabled": true,
  "target_scope": "configured"}`, `thinking_level: "inherit"`.

### 3. Providers actually available (read live, keys redacted)

| Provider | Enabled | Base URL | Models usable as fallback | Price |
|---|---|---|---|---|
| `xingchiapi` (GPT Astra, custom) | true | https://api.xingchiapi.com | `gpt-6-astra`, `gpt-6.1-sol` | unknown (catalog pricing `{}`, billing `unknown`) |
| `kilo` (Kilo Code, builtin) | true | https://api.kilo.ai/api/gateway | `kilo-auto/free` (+ 6 other `:free` models) | **$0** (pricing all `"0"`, billing `free`) |
| `openrouter` (builtin) | true | https://openrouter.ai/api/v1 | none yet — `api_key` is empty, `models` list is empty (471 discovered, not configured) | n/a |
| `lmstudio` / `ollama` | false | localhost | local models — excluded by the cloud-only rule | n/a |

### 4. Thinking level — it exists, it is per agent, it is model-specific

- `thinking_level` on the agent: one of `inherit | off | minimal |
  low | medium | high | xhigh | max | budget`. If `budget`, a
  `thinking_budget` integer ≥ 1 is required (Pydantic validator in
  `config.py` — budget mode without a budget is rejected).
- The providers themselves advertise `reasoning_effort_options:
  ["none","minimal","low","medium","high","xhigh"]` and
  `thinking_budget_range: [1, 81920]` (both `kilo.json` and
  `xingchiapi.json`). So the *effect* of a level is model-specific:
  each provider maps the level onto its own reasoning effort/budget.
- `config.json` has **no** thinking-level setting at all: its 19
  `thinking` matches are all `show_thinking` (a display toggle per
  channel) plus `auto_collapse_thinking`. There is no global
  thinking-level knob.
- Recommendation: keep `thinking_level: "inherit"` (the current value)
  — it preserves the primary model's normal reasoning behaviour and
  does not force an unsupported or expensive level onto the fallbacks.
  (GPT Astra independently agreed with this.)

### 5. `llm_routing` is NOT a fallback chain — leave it disabled

`agents.llm_routing` is currently `{"enabled": false, "mode":
"local_first", "local": {"provider_id": "", "model": ""}, "cloud":
null}` in both `agent.json` files. It routes between a *local* slot and
a *cloud* slot. Enabling it would route toward local models, which the
user has ruled out (cloud LLM only). It is not a fallback mechanism and
must stay disabled.

## Proposed change (default agent)

Apply with the API from a logged-in console session (cookie required —
the console API is auth-gated; public unauthenticated calls return 401,
verified 2026-11-15):

```bash
curl -X PATCH https://qwenpawx.pages.dev/api/agents/default/model-settings \
  -H 'Content-Type: application/json' \
  -b '<your logged-in console session cookie>' \
  -d '{
    "active_model":   {"provider_id": "xingchiapi", "model": "gpt-6-astra"},
    "fallback_models": [{"provider_id": "kilo", "model": "kilo-auto/free"}],
    "fallback_policy": {"enabled": true, "target_scope": "configured"},
    "thinking_level": "inherit"
  }'
```

What each part does:

- `active_model` pins the per-bot primary explicitly to GPT Astra
  `gpt-6-astra` (today it is only the global default; pinning it makes
  the default agent independent of later global switches).
- `fallback_models` adds one ordered fallback: Kilo `kilo-auto/free`.
  Chain is therefore: `xingchiapi/gpt-6-astra` → `kilo/kilo-auto/free`.
  Kilo is free, enabled, and already used by this deployment, so the
  fallback costs $0.
- `fallback_policy` stays as it is (`enabled: true`, `target_scope:
  "configured"`) — included so the patch is explicit and complete.
- `thinking_level: "inherit"` — unchanged, stated explicitly.

Equivalent `agent.json` diff (for reference only — do NOT hand-edit;
the API writes this file and reloads the agent):

```diff
 working/workspaces/default/agent.json
-  "fallback_models": [],
+  "active_model": {"provider_id": "xingchiapi", "model": "gpt-6-astra"},
+  "fallback_models": [{"provider_id": "kilo", "model": "kilo-auto/free"}],
   "fallback_policy": {"enabled": true, "target_scope": "configured"},
   "thinking_level": "inherit",
```

### Phase 2 (only after the user adds an OpenRouter key)

Once an OpenRouter API key is set in Console → Settings → Models,
append a second fallback slot **last**:

```json
{"provider_id": "openrouter", "model": "<a configured OpenRouter model id>"}
```

Do **not** add it now: with an empty `api_key` the PATCH validator
would reject the slot (HTTP 422) and the whole patch would fail.
OpenRouter goes last because it is currently unusable.

### QA agent (needs a decision)

The same chain can be applied to `QwenPaw_QA_Agent_0.2` with the same
call, replacing `default` in the URL. It was left out of this proposal
on purpose: the QA agent has no history yet (0 rows) and the user has
not said whether it should share the default agent's model. Apply to
`default` first, decide QA separately.

### NOT included, and why

- `decision_model`: not set anywhere today; no requirement for it was
  given. Leave unset.
- `subagent_model`: a cheaper model for spawned subagents exists as a
  field, but its runtime path was not verified in this task, so no
  value is proposed here. Candidate (unverified): Kilo
  `kilo-auto/free`.
- `llm_routing`: stays disabled (§5).

## Limits of fallback (say plainly)

Fallback triggers only on **transient provider failures** — timeouts,
rate limits, unavailable service. It does **not** retry because an
answer was poor, wrong, or low quality, and it does not detect bad
output. A bad answer from the primary stays a bad answer.

## Verify after applying

1. `GET https://qwenpawx.pages.dev/api/agents/default` (logged-in
   session) shows `fallback_models: [{"provider_id":"kilo","model":
   "kilo-auto/free"}]` and `active_model` pinned to
   `xingchiapi/gpt-6-astra`; or read `agent.json` on the machine.
2. Agent reloads automatically (the PATCH endpoint schedules it); no
   restart.
3. A live failover test (forcing the primary to fail) is **not**
   recommended on InstaBox Free — it would mean breaking the working
   primary on purpose. The chain is verified at the code level
   (`model_factory.py`, `fallback_chat_model.py`); treat first real
   failover as the live test and check `token_usage.json` afterwards
   for Kilo calls on a day Astra failed.
