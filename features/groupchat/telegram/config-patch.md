# Telegram channel — verified config patch (FILE ONLY, do NOT apply yet)

> Status: **patch written, not applied.** `working/config.json` was NOT
> edited. Apply only in the batched restart (container restart required —
> channel runners read config at boot). No restart has been done for this.

## Verified facts (read live 2026-11-15, do not re-derive)

- Telegram is a **native, built-in channel plugin** — no install needed.
  - Plugin: `/app/plugins/channel/telegram/` (`plugin.json`: id `telegram`,
    "Telegram Bot API **polling** messaging channel", min QwenPaw 2.2.2b4).
  - Schema: `/app/plugins/channel/telegram/channel.json`
    (`channel_key: telegram`, `process_mode: runner_process`).
  - Driver: `qwenpaw_channel_telegram/driver.py` (`TelegramDriver`);
    platform `platform.py` long-polls `getUpdates` with
    `Application.builder().token(bot_token)` (python-telegram-bot 22.8).
  - `channel_plugin_state.legacy_captured` in `working/config.json` already
    lists `telegram`; `uninstalled: []`. Nothing to install or repair.
  - Sessions are `telegram:{chat_id}`; forum topics select reply routing.
- The token lives **only** in `working/config.json` → `channels.telegram`
  → `bot_token` (platform.py line ~566: `self._bot_token =
  config.get("bot_token")`). There is no env-var override and no separate
  credentials file for it.
- Polling = **no webhook, no inbound port, no public URL needed**. The bot
  makes outbound long-poll requests to `api.telegram.org`. This works on
  InstaBox Free as-is. `base_url` is only for a self-hosted Bot API server;
  leave it empty for the default `api.telegram.org`.
- `QWENPAW_DISABLED_CHANNELS` in `instabox/docker-compose.yml` does NOT list
  telegram, so nothing in the container env blocks it.
- Current live state: `channels.telegram.enabled: false`,
  `bot_token: ""`, `dm_policy: "open"`, `group_policy: "open"`,
  `allow_from: []`, `require_mention: false`. Only `console` is enabled.

## Exact patch to `working/config.json` → `channels.telegram`

Change ONLY these keys (all other telegram keys stay exactly as they are):

```json
{
  "enabled": false,
  "bot_token": "",
  "dm_policy": "open",
  "group_policy": "open",
  "allow_from": [],
  "require_mention": false
}
```

becomes:

```json
{
  "enabled": true,
  "bot_token": "<TELEGRAM_BOT_TOKEN_FROM_BOTFATHER>",
  "dm_policy": "allowlist",
  "group_policy": "allowlist",
  "allow_from": ["<YOUR_TELEGRAM_NUMERIC_USER_ID>"],
  "require_mention": true
}
```

Notes on each changed key:

| Key | Why this value |
|-----|----------------|
| `enabled: true` | Starts the Telegram runner process on next boot. |
| `bot_token` | **REQUIRED, supplied by the user.** Create the bot in Telegram via `@BotFather` (`/newbot`), copy the token it returns. The token is a secret: it goes into `working/config.json` on the machine only (file is `600`, root-owned) — never into git, never into a Worker, never into chat. **No token has been invented or stored anywhere in this build.** |
| `dm_policy: "allowlist"` + `allow_from` | Security: the current default `"open"` lets ANY Telegram user DM the bot and drive the agent. Set `"allowlist"` and put YOUR numeric Telegram user ID in `allow_from` (get it from `@userinfobot`). Add further IDs only deliberately. If you genuinely want anyone to use it, keep `"open"` — but that is not recommended. |
| `group_policy: "allowlist"` | Same reason for groups: only groups whose chat ID is in `allow_from` may use the bot. Add a group chat ID after adding the bot to the group (get the ID from the group via `@userinfobot` or the Bot API `getUpdates`). |
| `require_mention: true` | In groups the bot only answers when mentioned (`@YourBot ...`). Prevents the bot replying to every group message and prevents bot-to-bot loops. |

Keys deliberately LEFT unchanged (verified defaults are correct):

| Key | Value | Why |
|-----|-------|-----|
| `base_url` | `""` | Empty = default `api.telegram.org` (platform.py `_telegram_base_urls`). Only set for a self-hosted Bot API server. |
| `http_proxy` / `http_proxy_auth` | `""` | No proxy needed; the machine reaches `api.telegram.org` directly. |
| `show_typing` | `null` | Default typing behaviour. |
| `streaming_enabled` | `false` | Keep off until basic polling is verified working. |
| `show_tool_calls` / `show_tool_results` / `show_thinking` | `true` | Keep visible while testing so you can see what the agent does. |
| `dm_disabled` / `group_disabled` | `false` | Both stay usable. |

## Apply + restart steps (coordinator / user, after the token exists)

```bash
# 1. On the machine, back up config first (backup dir already exists):
sudo cp /data/home/qwenpaw/working/config.json \
  /data/home/qwenpaw/working.backups/2026-11-15-rakazo-build/config.json.pre-telegram

# 2. Edit ONLY channels.telegram in /data/home/qwenpaw/working/config.json
#    with the patch above (python json edit or careful text edit — the file
#    is 32 KB, root-owned 600; do NOT rewrite it by hand wholesale).

# 3. Restart the container so the channel runner picks up the config:
docker restart qwenpaw
# (restart: always in docker-compose.yml; the systemd unit also brings it
# back on boot. Do NOT use `docker compose down` — that stops the box.)

# 4. Verify (wait ~60 s for boot, then):
docker ps --filter name=qwenpaw --format '{{.Status}}'   # must be healthy
docker logs qwenpaw --tail 50 | grep -i telegram         # runner connecting/connected
# In Telegram: DM the bot "hello" -> it answers in English.
# In Console: Settings > Channels shows Telegram connected.
```

## What still needs the user

1. **Telegram bot token** from `@BotFather` (`/newbot`). Nothing works
   without it, and it cannot be created by an agent.
2. **Your numeric Telegram user ID** for `allow_from` (from `@userinfobot`).
3. A **container restart** (batched with any other pending config changes).

## Other channels — honest status (verified 2026-11-15)

### Slack — NATIVE, works the same way (not built in this task)

- Plugin exists: `/app/plugins/channel/slack/` ("Slack Socket Mode
  messaging channel; standalone integration preview").
- Config section already exists in `working/config.json`
  (`channels.slack`, `enabled: false`).
- Verified keys (`channel.json` config_schema): `bot_token` (xoxb-),
  `app_token` (xapp-, Socket Mode), `proxy`, `streaming_enabled`, plus
  the common channel keys. `require_mention` defaults to `true` here.
- To enable later: create a Slack app at api.slack.com (Socket Mode on,
  `app-level token` with `connections:write`, bot token with chat scopes),
  set `channels.slack.enabled: true`, `bot_token`, `app_token`, restart.
  No new plugin needed. Not enabled now — out of scope for this build.

### Microsoft Teams — PLUGIN EXISTS, needs Azure registration + new config

- Plugin exists: `/app/plugins/channel/azure_bot/` (v2.0.0, "Azure Bot
  Service channel (Bot Framework) integration for QwenPaw. Supports
  Teams, Slack, Web Chat and other Azure Bot channels").
- **But** `working/config.json` has NO `channels.azure_bot` section, and
  `channel_plugin_state.legacy_captured` lists `azure_bot` only as a
  captured legacy plugin. The verified config keys (from
  `channel.json` config_schema) are: `app_id`, `app_password`,
  `tenant_id`, `http_host`, `http_port`, `media_dir`,
  `share_session_in_group`, plus the common channel keys.
- To enable later: register a bot in Azure Bot Service (Microsoft Entra
  app → Application (client) ID = `app_id`, client secret =
  `app_password`, Directory (tenant) ID = `tenant_id`), add a NEW
  `channels.azure_bot` section with those values, restart. The Azure-side
  registration cannot be done by an agent and was NOT done here.
  **Not verified end-to-end** — treat as "plugin present, setup pending".

### WhatsApp — NOT AVAILABLE, needs a new plugin or a bridge

- Verified: **no WhatsApp channel plugin exists** in QwenPaw v2.3.0.
  `ls /app/plugins/channel/` shows: azure_bot, dingtalk, discord,
  feishu, imessage, matrix, mattermost, mqtt, onebot, qq, sip, slack,
  telegram, voice, wechat, wecom, xiaoyi, yuanbao. No `whatsapp`.
  `grep -rli whatsapp /app/plugins/channel/` returns nothing, and
  `working/config.json` has no `channels.whatsapp` key.
- WhatsApp therefore **cannot be enabled by a config change**. It needs
  either a new QwenPaw channel plugin (WhatsApp Business Cloud API) or
  a bridge (for example via the existing Matrix channel plugin and a
  Matrix–WhatsApp bridge). Neither was built in this task. Do not claim
  WhatsApp works until one of those exists and is verified live.
