# Telegram enablement patch (token-only setup)

Apply **only after** the user has entered the bot token in Settings.
The token lives in the Settings store
(`working.secret/providers/telegram.json`), **not** the vault — the
vault holds only connectors. The token is never written to a log,
never committed, never pasted into a chat.

## 1. Store the token (Settings)

The Settings page writes the token to:

```
working.secret/providers/telegram.json
{"provider_id": "telegram", "api_key": "<the bot token>", "enabled": true}
```

`tg.py setup-check` reads the token from here. If the file is
missing or the key is empty, the bot is not set up and `setup-check`
fails with a plain message — never a stack trace with the value.

## 2. Write the safe config block (atomic)

Edit `working/config.json` → `channels.telegram` **atomically**
(write a temp file, `os.replace` into place) with the full block —
never enable the bot by setting the token alone, because the
defaults are open (`dm_policy: "open"`, `access_control_dm: false`):

```json
"telegram": {
  "enabled": true,
  "bot_token": "<the token from the Settings store>",
  "dm_policy": "allowlist",
  "group_policy": "allowlist",
  "allow_from": [],
  "require_mention": true,
  "access_control_dm": true,
  "access_control_group": true,
  "show_typing": true,
  "streaming_enabled": false,
  "show_tool_calls": true,
  "show_tool_results": true,
  "show_thinking": false
}
```

Notes:

- `allow_from` stays **empty on purpose**. The whitelist lives in
  `access_control.json` (the pending/approved list), not in this
  config — `import_allow_from` migrates `allow_from` into the
  whitelist at startup, and a stale id there would silently admit
  someone. The owner is bound by approving a pending DM, never by
  typing a numeric id.
- `require_mention: true` means the bot only answers in groups
  when mentioned; DMs are unaffected.
- `deny_message` is **not** set — the gate does not use it (verified
  2026-11-18: the pending reply is the fixed `_ACL_I18N`
  template). Setting it would be dead config.
- `streaming_enabled: false` — streaming over Telegram edits
  messages in place and costs one edit per chunk; off until the
  owner asks for it.

## 3. Restart the container (Muse's call)

A config change needs a container recreate (`docker compose up -d`
on the machine). That drops in-flight agent work, so it is done
once, with the token already in place — not before.

## 4. The pending flow (owner binding)

1. The owner DMs the bot. The first DM is **not** answered by the
   agent — the access-control gate records it as pending
   (`access_control.json`: user id + username + first message +
   timestamp) and sends the fixed deny text.
2. The owner opens **Settings > Channels > Telegram** in the
   console, sees the pending entry, and approves it.
3. That user id becomes the whitelist's **first entry = the owner**.
   Every later approval is a guest (read-only branches, only their
   own Telegram session's chats).
4. If the wrong person was approved first, the owner removes them
   in the console; the next whitelist entry becomes owner. No
   sidecar file, no manual id.

## 5. Verify (live — parent's job)

- `tg.py setup-check` → `SETUP_OK`.
- Owner DM → pending → approved → `/menu` shows the root menu.
- A model tap → `PATCH /api/agents/default/model-settings` and
  the agent reloads (no restart).
- Open a console chat from My chats, send a message, see the same
  reply in the console.
- A guest tap on an `act:*` button → "Owner only", nothing called.
- A stranger's DM → pending, no agent reply.
- The token never appears in any log or chat (redaction check).

## Rollback

Set `enabled: false` in the same config block and restart, or
remove the token from Settings. The channel is polling-only, so
disabling it stops all traffic immediately; no webhook to tear
down.
