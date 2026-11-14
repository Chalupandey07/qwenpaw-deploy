# #11 — Fleet manager

Status: **Done (read + dry-run only).** `scripts/fleet.py` lists the real
fleet from the live config. Enable/schedule are **dry-run only by design**.

## Verified config keys (read live 2026-11-15, QwenPaw v2.3.0)

`working/config.json`, section `agents`:

| Key | Value observed | Meaning |
|-----|---------------|---------|
| `agents.active_agent` | `"default"` | Agent the console opens on |
| `agents.agent_order` | `["default"]` | Display order (note: QA agent is **not** in this list even though its profile exists) |
| `agents.profiles.<id>` | `{id, workspace_dir, enabled, pinned}` | Per-agent registration |
| `agents.profiles.default.enabled` | `true` | |
| `agents.profiles.QwenPaw_QA_Agent_0.2.enabled` | `true` | |
| `agents.defaults.heartbeat` | `{enabled: false, every: "6h", target: "main", timeoutSeconds: 300}` | **Global**, not per-agent |
| `agents.running.max_iters` | `100` | Loop guard |

Per workspace, `workspaces/<id>/agent.json`:

| Key | Example |
|-----|---------|
| `id` / `name` / `description` | `default` / `Default` / `default agent`; QA: `QwenPaw_QA_Agent_0.2` / `QA Agent` / `Builtin Q&A helper…` |
| `workspace_dir` | `/app/working/workspaces/default` (container path) |
| `backend` / `backend_settings` | `qwenpaw` / `{}` |
| `template_id` | only on QA (`"qa"`) |
| `channels.<name>.enabled` | per-channel flags; only `console` is `true` on both agents |

Global model (not per-agent): `working.secret/providers/active_model.json`
→ `xingchiapi/gpt-6-astra` (verified live by `fleet.py` 2026-11-15; the
user switched the default chat model from Kilo to GPT Astra during this
build). Fleet shows it as the shared model; per-agent
models do not exist in this version (the Rakazo gap note about
"per-agent models" being partial refers to session-level overrides, not
fleet config — not verified here, not claimed).

## What the script does

```
# on the machine (config.json is root-owned, so sudo):
sudo python3 scripts/fleet.py list
sudo python3 scripts/fleet.py show QwenPaw_QA_Agent_0.2
sudo python3 scripts/fleet.py enable --dry-run <agent-id>
sudo python3 scripts/fleet.py schedule --dry-run <agent-id> [--every 6h]
```

- `list`: active agent, agent order, active model, heartbeat defaults,
  and one row per agent (enabled, active, name, channels on).
- `show`: full JSON for one agent.
- `enable --dry-run`: prints the exact `config.json` change that *would*
  be made (`agents.profiles.<id>.enabled: true`) and stops. It never
  writes.
- `schedule --dry-run`: prints the heartbeat change that *would* be made
  and warns that heartbeat is global in v2.3.0 — per-agent targeting via
  `target` is **not verified** (`target` defaults to `"main"`).

## Why dry-run only

1. `config.json` must never be edited by a script without approval (task
   hard rule).
2. Enabling an agent almost certainly needs a container restart: the
   multi-agent manager preloads agents at startup (log: `Agent startup
   complete: 2/2 agents started successfully`). The restart requirement
   is **unverified** — the script says so instead of assuming.
3. A bad edit to `config.json` breaks the whole console. The script
   refuses to be the thing that does that.

## What still needs the coordinator/user

- To actually enable/disable an agent or change the heartbeat: approve
  the exact JSON diff, edit `config.json`, restart the container, and
  verify both agents still preload (`docker logs` / log tail).
- To add a new agent to the fleet: import a template (see
  `19-import-export.md`), register it in `agents.profiles` (+
  `agent_order`), restart, verify.
