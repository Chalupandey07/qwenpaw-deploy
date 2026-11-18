# Config patch — Approvals (APPLY-SCRIPT, 2026-11-18)

Date: 2026-11-15 (proposal). Updated 2026-11-18: this patch is no
longer a proposal — it is `apply-smart.py` in this directory, tested
machine-free (T124, 40/40). The parent runs the script on the machine;
it has NOT been run live yet. Machine: m_agq5wqqo2fvypym7rjlpvngc2m.
Sources proving every key (all read live on the machine):
- `approval_level`: `/app/src/qwenpaw/config/config.py:2602`
  (`AgentProfileConfig`), live value `"AUTO"` in
  `working/workspaces/default/agent.json`.
- Levels: `/app/src/qwenpaw/security/tool_guard/execution_level.py`
  (STRICT / SMART / AUTO / OFF / JEV).
- `decision_model`: `config.py:2558` (`AgentProfileConfig`), live `null`.
- `security.tool_guard` / `file_guard` / `skill_scanner`:
  `config.py:3161-3236`, live values in `working/config.json`
  (see README.md for the full live dump).
- Default guarded set: `/app/src/qwenpaw/security/tool_guard/utils.py:19`.
- Proxy behaviour of `agents.running.approval_level` (currently `null`):
  `/app/src/qwenpaw/app/routers/workspace.py:1603,1968-1970,2101`.

## How to apply (the script, not a hand-edit)

```bash
python3 features/approvals/apply-smart.py \
  --working-dir /data/home/qwenpaw/working --agent all
```

Run on the machine, after syncing this directory. The script sets
`approval_level` to `SMART` in
`working/workspaces/default/agent.json` and in the QA agent's
`agent.json` (only if that file exists and already has the field),
keeps every other key, verifies the destructive-command auto-deny is
still on (read-only), writes atomically with a backup
(`agent.json.bak-before-smart`), reads the value back, and is
idempotent (a second run is a no-op). `--dry-run` and `--check` are
supported; see `apply-smart.py --help` and README.md. The old
hand-edit route (console Settings, or `PUT` the running config with
`{"approval_level": "SMART"}` while logged in) still writes the same
field and is the fallback if the container overwrites the file — see
the WARNING in the script header. No restart is needed for this field.

## Change 1 — approval level AUTO → SMART (the patch)

File: `/data/home/qwenpaw/working/workspaces/default/agent.json`

```json
"approval_level": "SMART"
```

Was: `"AUTO"`. Effect (per `execution_level.py`): INFO/LOW-severity
tool calls auto-allow; MEDIUM/HIGH/CRITICAL require an approval card.
This is the source's own "recommended" balanced mode, and it is the
closest QwenPaw equivalent to Rakazo "Auto" without a decision model.
It changes behaviour for interactive console use only: unattended native
cron jobs run with `runtime.tool_safety: false` (approval OFF) unless a
job explicitly sets `tool_safety: true`, so routines are unaffected.

How to apply (no restart needed for this field — it is read per tool
call from the agent profile; the console Settings → approval level writes
the same field, and the running-config API writes it back to the profile):
run `apply-smart.py` (above), or set it in the console, or `PUT` the
running config with `{"approval_level": "SMART"}` while logged in. Do NOT
hand-edit `agent.json` while the container is running without going through
the API — the running process may overwrite the file. (The apply-script
writes the file directly, so it carries the same warning: confirm the live
value with `GET /api/agents/running-config` afterwards.)

## Change 2 — decision model: NOT set yet (deferred, needs a choice)

Proposed later, only together with `approval_level: "JEV"`:

```json
"decision_model": {"provider_id": "kilo", "model": "kilo-auto/free"}
```

Was: `null` ("None disables it by default", `config.py:2558`). This is
QwenPaw's "approval model". It is **not** proposed now because (a) JEV
adds a model call before every effectful tool call, and the JEV path
has not been live-tested on this deployment; (b) Kilo free as the
decision model is the obvious cheap candidate but its risk judgements
are unvalidated. If the user wants Rakazo-style model-checked Auto,
test JEV with this value in a console session first, then adopt it.

## Change 3 — guard lists: NO CHANGE proposed

```json
"security": {
  "tool_guard": {
    "enabled": true,
    "guarded_tools": null,
    "denied_tools": [],
    "auto_denied_rules": ["SAFETY_CHECKS_DESTRUCTIVE_COMMAND"],
    "custom_rules": [],
    "disabled_rules": []
  }
}
```

All values stay as they are. Rationale:
- `guarded_tools: null` keeps the built-in default (8 tools:
  `execute_shell_command`, `read_file`, `write_file`, `edit_file`,
  `append_file`, `send_file_to_user`, `view_text_file`,
  `write_text_file`). In SMART mode this list matters less (severity
  decides), so there is nothing to gain by enumerating it.
- `denied_tools: []` stays empty. Deny is unconditional (no approval
  card is ever offered), so adding a tool here is a hard block, not a
  "ask first" rule. Only add a tool here if it must be *impossible*
  (e.g. `"desktop_screenshot"` if screen capture should never happen).
- `auto_denied_rules` stays at the default (catastrophic wipes / mkfs /
  dd). Adding `SAFETY_CHECKS_SYSTEM_POWER` is available if shutdown /
  reboot commands should also auto-deny, but it is not proposed without
  the user asking for it.
- `custom_rules: []` — a `ToolGuardRuleConfig` (`config.py:3134`) can be
  added later for a specific pattern (e.g. block `rm -rf` outside the
  workspace), but no such rule is proposed now: the destructive-command
  rule already covers the catastrophic cases.

## What this patch does NOT provide (plain statement)

- **Per-tool approval lists in Settings**: QwenPaw cannot do
  Rakazo-style "always ask for tool X, never ask for tool Y" lists in
  the console. What now exists is repo-side: `policy.json` +
  `policy.py` (an Allow/Ask/Block list with an enforcement function,
  tested T124) and `preview.py` (the exact command/diff a card would
  show). Neither is wired into the live guard yet — that needs a
  derived-image change. The closest live behaviour is still: SMART
  for severity-based asking + `denied_tools` for hard blocks +
  approving with scope `"similar"` so repeated similar calls are
  remembered as allowed. There is no UI to review or delete
  remembered approvals.
- **No per-site allow/block lists**: none exist for tools. (`allowlist`
  in config is channel messaging policy only.)
- **No spending limit**: no such key exists in QwenPaw. See README.md
  "Spend limit" for the monitoring-only approximation and why a cap
  needs new code.
- **No "Never ask" equivalent is proposed**: `OFF` exists but disables
  the guard entirely and is not recommended.

## Verification after applying (coordinator, logged in)

1. `GET /api/agents/running-config` → `approval_level: "SMART"`.
2. In the console, ask for a low-risk read (should run) and a shell
   command that writes a file (should raise an approval card).
3. `POST /api/approval/approve` / `/deny` with the card's `request_id`
   resolves it; `GET /api/approval/list` shows pending cards.
