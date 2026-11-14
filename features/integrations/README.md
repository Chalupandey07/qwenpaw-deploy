# App integrations (#8)

What QwenPaw is connected to today, how each connection works, and what
to add next — one at a time. Verified against the live machine on
2026-11-15 (`working/config.json`, skill pool, container tooling).
There is **no integration catalog** in this setup: nothing here claims
a store of ready-made app integrations exists.

## Files

| File | Purpose |
| --- | --- |
| `github-SKILL.md` | Source copy of the `github` skill installed on the machine. |
| `README.md` | This document. |

## New: GitHub skill (built 2026-11-15)

- Installed: `working/skill_pool/github/SKILL.md` and
  `working/workspaces/default/skills/github/SKILL.md` (identical).
- Mechanism: **skill calling a REST API** (no `gh` CLI in the
  container). `curl`/`python3` against `https://api.github.com` with
  `Authorization: Bearer $GITHUB_TOKEN`.
- Token: `GITHUB_TOKEN` from QwenPaw's encrypted env store
  (`working.secret/envs.json`, encrypted at rest). Set once by the user
  inside the container: `qwenpaw env set GITHUB_TOKEN <token>`
  (classic token with `repo` scope, or a fine-grained token scoped to
  the repos the agent may touch). Never in a file, never in chat.
  The skill declares it as `requires: {env: [GITHUB_TOKEN]}` so QwenPaw
  injects it into the skill's environment at runtime.
- Covers: list repos, read files, list/read issues and PRs, open issues,
  comment, open PRs, small single-file commits. Writes need user
  confirmation first.
- Default repo: `Ratulbaba7/qwenpaw-deploy` (branch `main`).
- **Blocked until the user sets the token.** Without it the skill says
  so plainly instead of pretending to have read a repo.

Design note: GPT Astra recommended a dedicated MCP server first (token
isolation). That is the right long-term upgrade (see "Next" below), but
the skill uses QwenPaw's own sanctioned secret mechanism today —
`require_envs` + encrypted `envs.json` — because no GitHub MCP server
binary is available in the container right now (no Node runtime; it was
removed in the 2026-11-15 cleanup) and the REST skill works with tools
already present (`curl`, `python3`).

## Already exist (verified live)

### Mailbox — Gmail only (skill + MCP)

- Skill `mailbox` (v1.3) is the single entry point for email. It
  orchestrates the `qwenpawmail` MCP server.
- Supported provider: **Gmail only** (`gmail.com`, 16-character app
  password after 2-Step Verification). Chinese mail providers
  (163/126/yeah/qq/foxmail/sina/aliyun) are not supported in this setup.
- Enterprise mailboxes, custom domains and Microsoft mailboxes are not
  supported by the managed workflow.
- Credentials are stored encrypted by QwenPaw and resolved into the MCP
  DriverCard at runtime; never in `agent.json` or chat.

### AnySearch web search (MCP, disabled)

- One MCP client is configured in `config.json` (`mcp.clients`):
  `anysearch` → `https://api.anysearch.com/mcp`, `enabled: false`.
  No other MCP client is configured. Enabling it needs a valid API key
  and a user decision; it is off today.

### Skill hub — ClawHub (skill marketplace, not app integrations)

- QwenPaw can install community skills from a hub (default base URL
  `https://clawhub.ai`, `qwenpaw skills install`). This is a **skill**
  marketplace, not an app-integration catalog: installing a skill does
  not connect an app account. The China plugin hubs (`modelscope-hub`,
  `aliyun-hub`) were removed in the 2026-11-15 English fix.

### Channels (only console is on)

- `config.json` channels: only `console` is enabled. Everything else
  is disabled, including `dingtalk`, `feishu`, `qq`, `wechat`,
  `telegram`, `discord`, `slack`, `imessage`, `matrix`, `mattermost`,
  `mqtt`, `voice`, `sip`. Connecting a channel is a channel-plugin
  setup (credentials + enable), not a skill.
- `plugins` in `config.json` is empty (`{}`): no plugins installed.

## Next integrations (one at a time, in this order)

Do not build more than one before the user picks it. Each entry names
the exact mechanism — skill vs MCP server vs channel plugin.

1. **GitHub via MCP server** (upgrade of the skill above). Mechanism:
   MCP server. Run the official GitHub MCP server as a container
   (e.g. `ghcr.io/github/github-mcp-server`) or a local binary, add an
   `mcp.clients.github` entry to `config.json` (streamable HTTP or
   stdio transport), and keep the token inside the server process only.
   Requires: a server image/binary, a token, and a user decision to
   switch the `github` skill to the MCP tools. Do this only after the
   REST skill has proven useful.
2. **A chat channel** (Telegram or Discord — user's choice). Mechanism:
   channel plugin, not a skill. Enable the channel in QwenPaw settings
   and provide its bot token through the console; verify by sending a
   test message. Pick one channel; do not enable several at once.
3. **Google Calendar** (read/create events). Mechanism: skill calling
   the Google Calendar REST API with an OAuth token in `envs.json`
   (same pattern as the GitHub skill), or a Calendar MCP server if the
   user prefers MCP. Requires: a Google Cloud OAuth client and the
   user's consent; there is no Calendar integration today.
4. **Cloudflare management** (list Pages/Workers, read deploys).
   Mechanism: skill calling `api.cloudflare.com` with a token in
   `envs.json` (same pattern as the GitHub skill). The `build-page`
   skill already covers the Pages deploy half; this would add
   read-only inspection.
5. **Notion / Google Drive / other REST apps.** Mechanism: one skill per
   app calling that app's REST API with a token in `envs.json`, or an
   MCP server where an official one exists. Each needs its own token
   and its own user approval; none is built yet.

## Rules for every integration

- English only; no China endpoints, providers or data (no aliyun,
  dashscope, modelscope, baidu, tencent, wechat, qq, dingtalk, feishu).
- Cloud LLM only; no local models.
- Tokens live in QwenPaw's encrypted env store (`qwenpaw env set`),
  never in a skill file, the repo, logs or chat.
- A skill declares what it needs in frontmatter
  `metadata.qwenpaw.requires` (`bins` / `env` / `mcp`) so QwenPaw can
  check it before running.
- Confirm with the user before any write action (send, post, commit,
  merge, delete).
- Verify live after adding one: run a real read call, confirm the
  container is still healthy, and record the result here.
