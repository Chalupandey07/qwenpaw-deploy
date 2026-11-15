# QwenPaw infra features — Rakazo gap list

Built 2026-11-15 for QwenPaw `agentscope/qwenpaw:v2.3.0` on InstaBox Free
(machine `m_agq5wqqo2fvypym7rjlpvngc2m`, container `qwenpaw`).
English only. No China endpoints. Cloud LLM only. Free tier only.

Every item below was verified live against the running machine / Cloudflare
account where a check was possible. Nothing here fakes a working feature:
**done** means verified working, **partial** means code exists but a live
step is blocked, **blocked** means an external requirement stands in the way.

## Status

| # | Item | Status | What is true |
|---|------|--------|--------------|
| 17 | Bot email | **Partial** | Email Worker code ready; receive path **unverified** — account has **zero Cloudflare zones**, so no Email Routing / Email Worker route can exist until the user adds a domain. Gmail MCP path also unconfigured (`qwenpawmail` missing). |
| 19 | Import/export/templates | **Done** | `features/infra/scripts/workspace-export.py` tested on a copy of the live QA workspace (export + import + hash check). 3 starter templates in `templates/`. |
| 11 | Fleet manager | **Done (read + dry-run only)** | `fleet.py` lists real agents from live `config.json` / `agent.json`. Enable/schedule are **dry-run only** — it prints the exact change, never writes `config.json`. |
| 22 | Evals / prompt versioning | **Done (runner built, live run pending creds)** | Current English prompts versioned in `prompts/v1/`. `evals/run-evals.py` uses the verified `POST /api/console/chat/task` endpoint; it needs `QWENPAW_USER`/`QWENPAW_PASS` at run time and has never been run live (no creds were read or stored here). |
| 18 | Audit log | **Done (report) / Partial (coverage)** | QwenPaw already has `governance/audit.db` (`audit_events`, 5 rows, tool-guard decisions only). `features/infra/scripts/audit-report.py` reads it read-only + tails `qwenpaw.log` + includes the manual-append log. No RLS/encryption — SQLite file on disk, honestly documented. |
| 14 | Credentials vault | **Partial (approximation)** | No protected-card flow exists in QwenPaw. Built: names-only inventory + server-side-only read convention. Secrets stay in `working.secret`. |
| 9 | Spaces / Access | **Partial (design only, NOT enforced)** | Access policy draft + per-space workspace mapping. Cannot be enforced: no Cloudflare zone/custom domain, and QwenPaw has single-user auth, no per-user RBAC. |
| 5 | Voice calls | **Blocked (needs keys)** | No zero-paid-key path for real phone calls. Twilio fields and LiveKit fields in `channels.voice` / `channels.sip` are all empty. Cheapest real path is LiveKit Cloud Build (free tier, verified pricing). Readiness script built. |
| 1 | Live computer alternative | **Blocked (no remote desktop) / Done (activity feed)** | XFCE desktop runs on the machine (`Xvfb :1`) but **no VNC server is running, no VNC/noVNC port listens, no browser is installed**. No self-hosted live-desktop path exists. Activity feed Worker `qwenpaw-infra-activity` deployed and verified live instead. |

## Layout

```
features/infra/
  README.md                  this file
  17-bot-email.md            email design, blockers, what the user must supply
  19-import-export.md        export/import design + test evidence
  11-fleet-manager.md        fleet design + verified config keys
  22-evals-prompt-versioning.md
  18-audit-log.md
  14-credentials-vault.md
  vault-inventory.md         secret NAMES only — never values
  09-spaces-access.md
  access-policy-draft.json   DESIGN ONLY — not applied anywhere
  05-voice-calls.md
  01-live-computer.md
  scripts/
    workspace-export.py      export/import a workspace folder (tested on a copy)
    fleet.py                 list/show agents; enable/schedule = dry-run only
    audit-report.py          audit.db + log tail + manual-append report (read-only)
    voice-readiness.py       which voice keys are configured (names only)
  templates/                 3 starter agent templates (English)
    research-assistant/  household-manager/  code-helper/
  prompts/v1/                current live English prompts, versioned
    SOUL.md  PROFILE.md  AGENTS.md  HEARTBEAT.md  README.md
  evals/
    cases.json               fixed eval prompts + expected substrings
    run-evals.py             login-once eval runner (needs creds at run time)
  workers/
    email-router/            Email Worker source (NOT deployed — needs a zone)
      index.js  metadata.json
    activity-feed/           live activity feed Worker (DEPLOYED)
      index.js  metadata.json
```

## Verified facts the builds rest on (all checked live 2026-11-15)

- Container `qwenpaw` healthy; API listens on `127.0.0.1:8088` only.
- Auth: `POST /api/auth/login` `{username, password}` → `{token, username}`;
  API calls use `Authorization: Bearer <token>` (verified in installed source).
  Login is rate-limited with lockout (423) and throttling (429).
- Programmatic prompt endpoint (verified in installed source):
  `POST /api/console/chat/task` with Agent API envelope
  `{channel, user_id, session_id, input:[{content:[{type:"text",text}]}], timeout}`,
  returns `{task_id}`; poll `GET /api/console/chat/task/{task_id}`.
- `config.json` agents section: `active_agent: "default"`,
  `agent_order: ["default"]`, `profiles.default` + `profiles.QwenPaw_QA_Agent_0.2`
  (both `enabled: true`), heartbeat defaults `enabled: false, every: "6h"`.
- `agent.json` per workspace: `id, name, description, workspace_dir, backend,
  backend_settings, channels{...enabled flags}, template_id` (QA only).
- Channels: only `console` enabled. `voice` and `sip` disabled.
- Cloudflare account `ca85fe3692c3f378200950999df9a35e`: **0 zones**,
  1 KV namespace (`STATUS`, `6a91d8099ed8419c88c94b0946186a27`),
  1 Worker (`qwenpaw-keepalive`).
- `working.secret` (names only): `auth.json`, `chatgpt/`, `.master_key`,
  `providers/active_model.json`, `providers/builtin/{kilo,lmstudio,ollama,openrouter}.json`,
  `providers/custom/xingchiapi.json`, `providers/plugin/` (empty).
- Active model: `xingchiapi/gpt-6-astra` — verified live by `fleet.py`
  at 01:0x IST 2026-11-15. It changed during this build: the user added
  GPT Astra as the default chat model (login test 01:04 IST); Kilo
  (`kilo/kilo-auto/free`) was the active model earlier in the day and is
  still configured as a provider.
- `governance/audit.db`: one table `audit_events`
  (`ts, workspace_dir, agent_id, session_id, tool_name, target, decision,
  reason, extra`), 5 rows, all `Read … allow` from one console session.
- `qwenpaw.log`: 1,080 lines at check time; live console sessions recorded.
- Mailbox skill: Gmail-only via `qwenpawmail` MCP — **not configured**
  (log: `Skipping skill 'mailbox' … MCP server not configured: qwenpawmail`;
  `config.json` `mcp.clients` contains only disabled `anysearch`).
- Desktop: `Xvfb :1` (1280x800) + full XFCE session running since boot;
  **no VNC process, no listening VNC/noVNC port, no browser installed**
  (chromium was removed in the 2026-11-15 cleanup).
- No ElevenLabs integration anywhere in the installed QwenPaw source.

## Rules these builds follow

- Never touch `working.secret/auth.json`, `.env`, chats/`history.db`, MEMORY content.
- Never restart the container. Never edit `working/config.json`.
- Never enable Cloudflare Access enforcement. Never commit secrets.
- No git push from this work; files stay in the local repo copy.
- `pages/public/_worker.js` untouched.
