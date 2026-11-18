# Approvals — QwenPaw on InstaBox Free

Date: 2026-11-15. Updated 2026-11-18: the SMART patch is now an
apply-script (`apply-smart.py`, T124 32/32 machine-free), plus a
per-tool preview builder (`preview.py`) and a per-tool Allow/Block
list (`policy.json` + `policy.py`). **None of it is verified live yet:**
the apply-script has not been run on the machine, and the preview /
policy modules are repo code not yet wired into QwenPaw's approval-card
path — see "What is NOT verified live" below. No machine file was
changed by this work.

## TL;DR

QwenPaw **does** have a real approval system — per-tool approval cards that
block the tool call until the user answers — but it is **not** Rakazo's
Ask/Auto/Never with per-tool/per-site Allow/Block lists and a spend cap.
The honest mapping is below. The one-line recommendation: set
`approval_level` to **`SMART`** (low-risk tools auto-run, medium+ ask),
keep the destructive-command auto-deny on, and add
`execute_shell_command` to `denied_tools` only if shell use should be
impossible rather than approval-gated. There is **no spend limit** in
QwenPaw at all — the token-usage file is read-only telemetry, and a cap
would need new code (see "Spend limit" below).

## What changed 2026-11-18 (gap #4, T124)

The 2026-11-15 proposal is now finished work, not a proposal. Three
new files in this directory, all stdlib-only Python, all machine-free
tested (`python3 features/approvals/test_approvals.py`, **40/40**):

| File | What it is |
|---|---|
| `apply-smart.py` | The SMART patch as a machine-apply script (see below). |
| `preview.py` | The per-tool preview builder: exact command / exact diff + risk + touches, preview only, never executes. |
| `policy.py` + `policy.json` | The per-tool Allow/Block list and its enforcement function. |

`decision_model` was NOT set (another builder owns Drex wiring).
No spend limit was added (gap #5 owns it).

### SMART behaviour (what the patch changes)

`approval_level` `AUTO` → `SMART` in the agent profile. Per
`execution_level.py`: INFO/LOW-severity tool calls auto-allow;
MEDIUM/HIGH/CRITICAL require an approval card. That is the source's
own "recommended" mode and the closest QwenPaw equivalent to Rakazo
"Auto" without a decision model. It changes interactive console use
only: unattended native cron jobs run with `tool_safety: false`
(approval OFF) unless a job explicitly sets `tool_safety: true`, so
routines are unaffected. The destructive-command auto-deny
(`SAFETY_CHECKS_DESTRUCTIVE_COMMAND`) stays on — the apply-script
verifies it read-only and refuses to be the thing that turns it off.

### Preview format (what the approval card shows)

`preview.build_preview(tool_name, arguments)` returns a plain
JSON-serialisable dict:

```json
{"tool": "execute_shell_command", "kind": "shell",
 "command": "ls -la", "diff": null, "risk": "MEDIUM",
 "touches": [], "summary": "Shell command; it can write, delete, or reach the network, so it needs approval before it runs.",
 "will_execute": false}
```

- `kind`: `shell` / `file_edit` / `file_read` / `network` / `other`.
- `command`: the exact shell string that would run (or `null`).
- `diff`: a unified diff for file edits, built from the exact old/new
  text in the call arguments (or `null`). If the old content was not
  supplied, the diff is against empty input and says so — the builder
  does NOT read the live file from disk to fill the gap.
- `risk`: `INFO` / `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`, mirroring
  SMART's severity model. `rm -rf /`, `mkfs`, `dd` to a device,
  shutdown/reboot, `curl|sh`, redirect onto a raw device, and fork
  bombs are `CRITICAL`. Plain read-only shell (`ls`, `echo`, `cat`…)
  is `LOW`; other shell is `MEDIUM`; writes are `MEDIUM`; deletes are
  `HIGH`.
- `touches`: best-effort paths/URLs visible in the arguments
  (redirect targets, `rm`/`cp`/`mv` path arguments, the edited file).
  It is a preview aid, not a sandbox — a command can touch paths it
  cannot see (variables, globs, pipes), and the summary says so.
- `will_execute`: always `false`. The builder contains no subprocess,
  no `os.system`, no file I/O, no network — the test proves a
  `echo pwned > marker` preview leaves no marker file behind.
- `preview_for_approval_card()` wraps the same data as a card:
  `title`, `what` (one-line summary), `exact` (the command or diff
  the user reads before answering).

### Allow/Block list (what it is, how to edit it)

`policy.json` (default): **auto** — `read_file`, `view_text_file`,
`get_token_usage`, `list_files`, `list_directory`, `search_files`;
**ask** — `execute_shell_command`, `write_file`, `write_text_file`,
`edit_file`, `append_file`, `send_file_to_user`, `run_tool_batch`;
**deny** — empty by default (see below). `policy.decide(tool,
preview, policy, approval_level)` returns `allow` / `ask` / `deny`
with a reason. Precedence: **deny beats everything, including OFF**
(a deliberate divergence from upstream, where OFF disables the guard
entirely — a tool on the Block list must stay impossible); then
STRICT asks for everything; then OFF allows; then AUTO asks only for
the guarded default set; then under SMART/JEV the explicit list wins
and unlisted tools fall back to severity. Unknown tools, unknown
risks, unknown levels, and calls with no preview all fail closed to
`ask`. A malformed policy (missing `auto`/`ask`/`deny` key, or a
non-list value) raises `ValueError` instead of defaulting the deny
list to empty.

To edit: move a tool name between the three lists in `policy.json`,
keep the JSON valid, re-run the test. Example deny entry, NOT enabled
by default: adding `"execute_shell_command"` to `deny` makes shell
use impossible rather than approval-gated (the same trade-off as
adding it to QwenPaw's `denied_tools`). **This list is repo-side, not
live:** nothing in QwenPaw's `runtime/tool_guard.py` calls
`policy.py` yet, and `policy.json` is not QwenPaw's `denied_tools`.
To make a deny live in QwenPaw today, add the same tool to
`denied_tools` in `working/config.json` (or
`QWENPAW_TOOL_GUARD_DENIED_TOOLS`).

### DeepSeek design review (2026-11-18, required)

Three calls via `seek.py` (deepseek-v4.1-flash-free): the first two
returned empty output (no assistant text, only the usage block) and
were not followed; the third (positional prompt form) returned a real
review with 5 findings. All 5 checked out and were fixed in
`policy.py`, with 8 new regression checks (F1–F8): (1) a missing
preview could silently downgrade deny → fixed by "no preview, no
auto-allow"; (2) a malformed/missing deny section defaulted to empty
→ `load_policy`/`decide` now raise `ValueError`; (3) risk matched by
exact case-sensitive string → normalized (strip + upper), unknown
risk asks; (4) tool names matched exactly, so a trailing space or
`mcp__` namespace defeated deny and the guarded set → names are
stripped and deny/guarded also match the namespaced suffix, while
auto/ask stay exact; (5) an unknown approval level fell through to
AUTO → now asks. A fourth call (re-review of the fixed design) was
refused by the provider with HTTP 429 `session_limit_reached` (5/5
sessions in use); per the rate-limit rule that call was not retried.
The fixed code is verified by the 40/40 test instead.

### Machine-apply command (the parent runs this on the machine)

This repo work changes nothing live. The parent applies the patch on
the machine (after syncing this directory to the machine):

```bash
python3 features/approvals/apply-smart.py \
  --working-dir /data/home/qwenpaw/working --agent all
```

What it does: sets `approval_level` to `SMART` in
`working/workspaces/default/agent.json` and in
`working/workspaces/QwenPaw_QA_Agent_0.2/agent.json` (only if the QA
file exists and already has the field); leaves every other key alone
(`decision_model` stays `null`); verifies the destructive-command
auto-deny is still on in `working/config.json` (read-only, never
modified); writes atomically (temp file + `os.replace`, backup at
`agent.json.bak-before-smart`); reads the value back and exits 1 if
it is not SMART. Idempotent: a second run changes nothing and says
so. `--dry-run` prints what would change; `--check` verifies only
(exit 0 = SMART everywhere + auto-deny on). **Warning, from the
original proposal:** if the container is running it may overwrite
`agent.json` — after applying, confirm the live value with `GET
/api/agents/running-config` (`approval_level` must read `SMART`); if
it does not, set it in the console Settings or `PUT` the running
config while logged in. No restart is needed for this field.

### What is NOT verified live

- The apply-script has never been run on the machine (parent's job);
  `approval_level` is still `AUTO` live as far as this work knows.
- `preview.py` / `policy.py` are NOT wired into QwenPaw's
  approval-card path (`runtime/tool_guard.py`,
  `app/routers/approval.py`). Wiring them in needs a derived-image
  change and a live browser check (a low-risk read auto-runs, a shell
  write raises a card showing the exact command, a deny-listed tool
  is refused). Until then the live guard still decides by
  `approval_level` and `denied_tools` alone.
- No spend limit, no decision model — other builders' gaps.

## Verified facts (live, 2026-11-15)

### Where approval lives

- `approval_level` is an **agent-profile** setting, not a top-level
  config key. Live: `working/workspaces/default/agent.json` →
  `"approval_level": "AUTO"`. Model:
  `AgentProfileConfig.approval_level` in
  `/app/src/qwenpaw/config/config.py:2602`, default `"AUTO"`.
- `working/config.json` also carries `agents.running.approval_level`,
  currently `null`. That field is a **proxy**: `GET /agents/running-config`
  fills it from the agent profile (`routers/workspace.py:1603`), and
  `PUT`ting a running config with a non-null `approval_level` writes it
  back to the agent profile and then clears the proxy field
  (`workspace.py:1968-1970, 2101`). So the console UI edits the same
  value; there is only one source of truth (`agent.json`).
- Resolution order per tool call (`runtime/tool_guard.py:89`,
  `governance/tool_adapter.py:62`): (1) session-level
  `request_context["approval_level"]` from the frontend, (2) `agent.json`
  `approval_level`, (3) `"bypass"` (allow) if no agent is attached.
  An active F1 session forces STRICT.

### The levels (verbatim from source)

`/app/src/qwenpaw/security/tool_guard/execution_level.py`:

| Level | Behaviour |
|---|---|
| `STRICT` | **All** tools require approval (even INFO-level findings). |
| `SMART` | INFO/LOW severity auto-allowed; MEDIUM/HIGH/CRITICAL require approval. Described in source as "recommended". |
| `AUTO` | Only tools in `guarded_tools` require approval (backward compatible). **Current live value.** |
| `OFF` | Tool guard completely disabled; all tools execute immediately. |
| `JEV` | SMART baseline **plus a decision-model pre-execution approval check** (`security/decision_model.py`, `assess_tool_call`; only tool targets / complete scripts are sent as decision metadata, not conversation contents). |

Invalid/empty values fall back to AUTO (`from_config`).

### The guard itself

`security.tool_guard` in `working/config.json` (model
`ToolGuardConfig`, `config.py:3161`), live values:

```json
"tool_guard": {
  "enabled": true,
  "guarded_tools": null,
  "denied_tools": [],
  "auto_denied_rules": ["SAFETY_CHECKS_DESTRUCTIVE_COMMAND"],
  "custom_rules": [],
  "disabled_rules": [],
  "shell_evasion_checks": {
    "command_substitution": false, "obfuscated_flags": false,
    "backslash_escaped_whitespace": false, "backslash_escaped_operators": false,
    "newlines": false, "comment_quote_desync": false, "quoted_newline": false
  }
}
```

- `guarded_tools: null` → built-in default set (`utils.py:19`):
  `execute_shell_command`, `read_file`, `write_file`, `edit_file`,
  `append_file`, `send_file_to_user`, `view_text_file`, `write_text_file`.
  A list replaces the set; `"*"`/`"all"` = guard **all** tools; `[]` =
  guard nothing. Env override exists: `QWENPAW_TOOL_GUARD_TOOLS`.
- `denied_tools: []` → tools that are **unconditionally denied**, no
  approval card offered. Env override: `QWENPAW_TOOL_GUARD_DENIED_TOOLS`.
- `auto_denied_rules`: `SAFETY_CHECKS_DESTRUCTIVE_COMMAND` = catastrophic
  wipes / `mkfs` / `dd` only (default; an empty list keeps the default —
  disable only via env `QWENPAW_TOOL_GUARD_AUTO_DENIED_RULES=none`).
  A second rule id exists, `SAFETY_CHECKS_SYSTEM_POWER`, but it is **not**
  enabled by default.
- `custom_rules`: user-defined rules, shape `ToolGuardRuleConfig`
  (`config.py:3134`): `{id, tools[], params[], category
  (default "command_injection"), severity (default "HIGH"), patterns[],
  exclude_patterns[], description, remediation}`.
- `file_guard`: `{enabled: true, sensitive_files: [], allow_preview_outside_workspace: true}`.
- `skill_scanner`: `{mode: "warn", timeout: 30, whitelist: []}`
  (`"block"` / `"warn"` / `"off"`).
- `sandbox_enabled: false` (governance sandbox off; Phase 0–2 secret-file
  / dangerous-command blocking is unaffected by this flag).

### Approval cards (they exist, and they don't block the chat)

- Endpoints (`/app/src/qwenpaw/app/routers/approval.py`, mounted at
  `/api/approval`): `POST /approve`, `POST /deny`, `GET /list`
  (optional `session_id` filter). Body: `{request_id, session_id,
  user_id?, reason?, scope?}`.
- How it works: an ASK decision blocks on `PendingApproval.future`,
  resolved by those endpoints; the console polls
  `/console/push-messages` for cards (`runtime/tool_guard.py` docstring).
  A denied call gets a "do not retry" instruction so the model doesn't
  immediately re-issue it with tweaked parameters.
- `scope` on approve: `"exact"` (record the literal target) or
  `"similar"` (record the generalised pattern); omitted/unknown →
  `exact` (least privilege). **This is the closest thing QwenPaw has to
  an allow-list**: approving with `similar` remembers a pattern, so the
  same kind of call later is auto-allowed. There is no UI list to view,
  edit or delete these remembered approvals, and no per-site list.
- **What does NOT exist:** per-tool/per-site Allow/Block lists in
  Settings (Rakazo's "Always allow tool or site" / "Allow and Block
  lists"). The word `allowlist` in QwenPaw config refers only to
  channel `dm_policy`/`group_policy: "open"|"allowlist"` — i.e. **who**
  may message the bot on a channel, not which tools may run. The
  nearest equivalents are `guarded_tools` (which tools get checked in
  AUTO mode), `denied_tools` (always deny), and approve-with-scope
  (remembered patterns). Saying QwenPaw has Rakazo-style allow/block
  lists would be false.

### The "approval model" (JEV decision model) — it exists, but is off

- `AgentProfileConfig.decision_model: Optional[ModelSlotConfig]`
  (`config.py:2558`): "Decision model for this agent; None disables it
  by default". `ModelSlotConfig` = `{provider_id, model}`.
- Live: `"decision_model": null` in `agent.json`. Setting
  `approval_level: "JEV"` without a `decision_model` falls back to the
  provider-resolved decision model (`resolve_decision_model` in
  `providers/typesafe_provider.py`); setting an explicit cheap model
  (e.g. the Kilo free model) is the predictable form. This is the only
  "approval model" QwenPaw has — there is no separate approval-model
  picker in the console settings beyond this field.
- Bonus finding (not approvals, but adjacent): the same profile also has
  `fallback_models: []` (ordered fallback chain, policy enabled) and
  `thinking_level: "inherit"` (off/minimal/low/medium/high/xhigh/max/
  budget + `thinking_budget`). Rakazo's fallback/thinking features have
  partial equivalents here; they are out of scope for this patch.

## Rakazo mapping (honest version)

| Rakazo | QwenPaw equivalent | Gap |
|---|---|---|
| Ask (ask before any changing action) | `approval_level: "STRICT"` | None for tools; no per-action-type distinction (read vs write) beyond severity. |
| Auto (approval model passes on-task actions) | `approval_level: "JEV"` + `decision_model` set | No "on-task vs off-task" judgement exposed as a setting; the decision model assesses tool-call risk only. `SMART` is the severity-based approximation without a model. |
| Never ask | `approval_level: "OFF"` | **Do not use** outside a fully trusted test: it disables the guard entirely, including the destructive-command auto-deny path. |
| Approval cards that don't block chat | `POST /api/approval/approve|deny`, `GET /api/approval/list` | Cards exist; no "Allow once / Always allow tool or site" buttons — scope `exact`/`similar` is the API-level equivalent. |
| Allow / Block lists | `guarded_tools` / `denied_tools` (+ remembered `similar` approvals) | No editable per-tool/per-site lists, no UI to review remembered approvals. |
| Spending limit | **Nothing** | See below. |

## Spend limit — approximation only, no enforcement exists

How `token_usage.json` is actually read (verified):

- File: `working/token_usage.json` (path `WORKING_DIR / TOKEN_USAGE_FILE`,
  `token_usage/manager.py:97`, `constant.py:207`). In-memory buffer flushes
  every 10 s. Shape (live sample, 2026-11-14/15): top-level keys are dates
  (`"2026-11-14"`), each maps `"default\u001fkilo\u001fkilo-auto/free"` →
  `{provider_id, model_name, prompt_tokens, completion_tokens,
  cache_read_tokens, cache_write_tokens, cache_eligible_input_tokens,
  cache_observed_calls, call_count, agent_id}`. The `\u001f` separator
  joins agent / provider / model.
- Read API: `GET /api/token-usage` (summary; `start_date`, `end_date`,
  `model`, `provider` filters, default last 30 days) and
  `GET /api/token-usage/details` (`routers/token_usage.py`). The agent
  also has a `get_token_usage` builtin tool.
- **No cap field exists anywhere**: grep for `spend|budget|cap` over
  `token_usage/*.py` and `config.py` returns nothing. There is no hook
  that reads usage before a call and refuses it. A token/$ cap cannot be
  expressed in config — it needs new QwenPaw code (a pre-call check in
  the token-recording wrapper or the guard engine).
- **And right now a $ cap would be meaningless anyway:** the active model
  is Kilo `kilo-auto/free` — a free model with no per-token price. A
  token cap is the only meaningful unit until a paid provider is added.
  Suggested approximation (monitoring, not enforcement), for the
  coordinator to implement as a separate small job:
  1. Daily read of `GET /api/token-usage` (logged-in) or the file.
  2. Alert (not block) when today's `prompt_tokens +
     completion_tokens` for `kilo/kilo-auto/free` exceeds a chosen
     threshold (e.g. 200,000 tokens/day — ~2.5× the 2026-11-14 total of
     ~73,000). The `qwenpaw-routines` Worker cannot do this: it has no
     QwenPaw login, and `/api/token-usage` needs auth.
  3. If a hard cap is ever required, it must be a code change in
     QwenPaw (or a proxy in front of the Kilo provider that counts and
     refuses) — not a config patch. Do not present the monitoring
     threshold as a limit; QwenPaw will keep spending past it.

## Recommended patch

See `config-patch.md` (file only, not applied). In short: agent
`approval_level` `AUTO` → `SMART`; `decision_model` left `null` for now
(JEV deferred until a cheap decision model is chosen — Kilo free is the
obvious candidate, but setting it without testing the JEV path risks
breaking unattended cron jobs, which run with `tool_safety: false` =
approval OFF anyway); `guarded_tools` left `null` (built-in default);
`denied_tools` left `[]`; destructive-command auto-deny untouched.
