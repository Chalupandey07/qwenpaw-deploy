# Telegram — the full console as a bot

A Telegram bot that can do **everything the frontend console can**:
new chat, open and continue any existing console chat, and change
every setting from inline-keyboard buttons. Setup is **one thing
only**: the user adds the Telegram bot token in Settings. No numeric
Telegram ID, no second token, no manual webhook setup.

Test: `features/telegram-full/test_telegram_full.py` — **T131, 66/66**.
Registered in `run-tests.py` and `TESTS.md` as T131.

## Why this is a channel, not a second agent

QwenPaw already ships a Telegram channel plugin
(`/app/plugins/channel/telegram/`, polling, `python-telegram-bot`
22.8, sessions `telegram:<chat_id>`). This feature extends it rather
than building a parallel bot, because a parallel bot would have its
own sessions and its own store — the user asked for the SAME agent,
the same sessions, the same memory, the same history.

The upstream channel could not do the full feature set, so it is
extended with a small derived-image patch
(`qwenpaw-telegram-menu.patch`, verified against the pristine v2.3.0
file, sha256-pinned in the test):

1. **`_handle_callback` routed menu taps to the agent.** Upstream
   handles approval cards only (`tga:`/`tgd:`) and drops every other
   callback **silently**. The patch calls `_handle_menu_callback`
   when the approval parse returns None. A tap whose data matches
   the menu grammar (`ui:`/`act:`) is admitted as a callback event
   with the text `/tgmenu <payload>`; anything else is still
   dropped, exactly as before.
2. **`send_parts`/`_send_text` accept an optional `reply_markup`.**
   The keyboard attaches to the LAST chunk of a multi-chunk reply
   only (one keyboard per reply). Default `None` = byte-identical
   behaviour to upstream. The menu layer today sends menus through
   the Bot API directly (`tg.py`); this threading is what lets the
   agent's own reply path carry a keyboard later.

The menu layer itself is `tg.py` (stdlib only, ~700 lines) plus
`menu.py` (the callback grammar + the menu tree + the per-chat
token cache). The agent handles `/tgmenu <payload>` through the
`telegram` skill (`SKILL.md` in this directory).

## Setup (token only)

1. The user creates a bot with @BotFather and pastes the token into
   **Settings > Telegram** (the token lives in the Settings store —
   `working.secret/providers/telegram.json` — NOT the vault; the
   vault holds only connectors).
2. Deploy writes the full safe config block atomically into
   `working/config.json` → `channels.telegram` (see
   `config-patch.md`) and restarts the container:
   `enabled: true`, `bot_token: <token>`, `dm_policy: "allowlist"`,
   `access_control_dm: true`, `require_mention: true`. The bot is
   **never** enabled with the token alone and an open policy.
3. The owner DMs the bot. The first DM is recorded as **pending**
   (username + first message visible in Settings > Channels >
   Telegram). The owner approves it in the console. That user id
   becomes the whitelist's first entry — **the owner**. Nobody ever
   types a numeric Telegram ID.
4. A second person who DMs the bot is also recorded as pending and
   is a **guest** once approved: they get read-only branches and
   only their own Telegram session's chats. Guests never get
   `act:*` (mutations).

## What the bot can do (menu tree)

- **New chat** — `/new` or the "New chat" button (clears the pinned
  session; the next message starts a fresh console chat).
- **My chats** — lists the console chats (owner: all of them; guest:
  only their own Telegram session). Tapping one **pins** it; the
  next plain message continues that chat in Telegram AND in the
  console (same `history.db`, same session state, via
  `POST /api/console/chat/task`). Preview shows the last 10 messages
  only — a session state file is 9.2 MB and is never read whole.
- **Settings** — Model (one button per provider/model with a key;
  PATCH `/api/agents/default/model-settings`, which reloads the
  agent), Approval (STRICT/SMART/AUTO/OFF/JEV, PUT running-config),
  Skills (tap to enable/disable), Channel toggles.
- **Memory** — search memory, read the latest handoff, save a fact
  (`facts.py` in `memory-tools/`).
- **Board** — list tickets, new ticket (needs the board key from
  Settings; read-only without it).
- **Vault** — list connectors (metadata only). **Reveal is refused
  outright** — console-only, even for the owner.
- **Computer** — status + Rest (sleep the machine via
  `POST /api/machine/sleep` with `X-Sleep-Token`).
- **Cost** — the cost ledger read (`cost_ledger.py`).
- **Jobs** — tap a job to toggle it (run-now is console-only).
- **Plan mode, checkpoints, egress guard** — readable where a CLI
  exists (`plan_mode.py status`, `checkpoints.py list`); the
  mutating verbs stay console-only for now.

## What the bot cannot do (honest limits)

- The **noVNC desktop view cannot be mirrored over Telegram** — it
  is an interactive VNC session, not a message. Computer gives
  status + Rest only.
- **Vault reveal is console-only** (above).
- **Job run-now is console-only** (toggle is available).
- A menu token **expires after 15 minutes** (and on bot restart);
  the user just reopens the menu — never corruption.
- The bot **polls** (the upstream channel is polling-only); there is
  no webhook. On the Free machine that is the right choice — a
  webhook needs a public endpoint that survives the idle pause.

## Security

- **Owner = first entry of the telegram whitelist** in
  `access_control.json`, computed fresh on every call. No sidecar
  file. If the wrong person was approved first, the owner removes
  them in the console and the next entry becomes owner.
- **`act:*` (any mutation) is owner only.** Guests get read-only
  branches. A stranger (not allowlisted) is refused and nothing is
  called. Every `act:*` writes one audit line to
  `working/telegram-audit.log`.
- **No secret ever leaves in a chat.** `redact_out` strips known
  provider keys, bot-token shapes (`\d{8,10}:[A-Za-z0-9_-]{35}`),
  `sk-`/`xox-`/hex shapes, and the egress guard's
  `redact_text`. The bot token is never written to a log.
- **Untrusted content is data, not instructions.** Forwarded text,
  file contents, pasted URLs, captions, callback payloads are wrapped
  with the egress guard (`wrap_untrusted`, source `telegram`)
  before they enter model context or a tool call. `tg.py`'s
  `wrap_inbound` breaks a forged `END_EXTERNAL_UNTRUSTED_CONTENT`
  marker inside the content first (verified: `wrap_untrusted`
  alone does not neutralise an embedded END marker — flagged to
  the egress-guard owner, do not edit `egress_guard.py` here).
- **Callback grammar** (`menu.py`): `ui:`/`act:` + 1–60 chars from
  `[A-Za-z0-9:_./-]` (dots and slashes included — model names like
  `nex-n2.6` and `kilo-auto/free` contain them), ≤64 bytes total.
  `tga:`/`tgd:` stay reserved for the approval cards. Long or
  unstable values (provider+model pairs, skill names) go through
  the per-chat token cache (4-char base36 tokens, 15 min TTL,
  200 entries, JSON-file backed).

## Files in this feature

| File | What it is |
| --- | --- |
| `tg.py` | The menu/CLI layer (stdlib only). |
| `menu.py` | Callback grammar, menu tree, token cache. |
| `src/pristine/platform.py` | Exact upstream v2.3.0 driver file (sha256-pinned in the test). |
| `src/patched/platform.py` | The patched driver (built by `/tmp/build-patched-platform.py`). |
| `src/patched/cards/menu.py` | Byte-identical copy of `menu.py` for the plugin's `cards/` dir. |
| `qwenpaw-telegram-menu.patch` | Unified diff, pristine → patched (7 hunks). |
| `Dockerfile` | Builds `qwenpaw-agentx:2.3.0-telegram1` from `bloatwinwin1`. |
| `SKILL.md` | The `telegram` skill (the agent's procedure for `/tgmenu`). |
| `config-patch.md` | The enablement patch (token-only setup + pending flow). |
| `test_telegram_full.py` | T131 — 66 checks, stdlib, mocked Telegram API. |

## Deploy (parent's job — not done by this feature)

1. Build the image **on the machine** (no Docker daemon on this
   VM): `docker build -f features/telegram-full/Dockerfile -t
   qwenpaw-agentx:2.3.0-telegram1 features/telegram-full/`.
   **Docker images are 5 of 5 — delete an old image first** or the
   build fails.
2. Sync `tg.py` + `menu.py` to `/app/working/telegram-full/` and
   install the skill (`qwenpaw skills enable telegram` — new skills
   default to DISABLED; the skill is also copied into the default
   workspace's `skills/` dir).
3. Apply `config-patch.md` **only after** the user has entered the
   token in Settings, then restart the container.
4. Live-verify (browser + a real Telegram DM): the pending flow,
   owner approval, a model tap, a chat open + continue, a guest
   refusal, and a redaction check. None of that is verified yet —
   the test proves the logic, not the live path.

## Verified facts (checked against the real source, 2026-11-18)

- `send_parts` signature is `(self, route, parts, source=None)` —
  first arg is `route`, not `chat_id` (an early DeepSeek draft got
  this wrong). `reply_markup` threads through `_send_text` as an
  extra kwarg to `bot.send_message`.
- `on_callback` takes a **dict** value (same shape as the approval
  path), not `(update, query)`.
- The access-control gate's deny text is the fixed `_ACL_I18N`
  template, NOT the `deny_message` config field (which is stored
  but unused by the gate).
- Model-switch reload is resolved: PATCH model-settings triggers an
  agent reload, no restart.
- The fenced `` ```ui `` block idea (agent embeds a keyboard in a
  fenced block, the driver converts it) is invented — no such
  formatter exists in the driver. Dropped; menus are sent by the
  helper CLI via the Bot API directly.
- `redact_text()` does **not** redact a Telegram bot-token-shaped
  string — `tg.py` adds the bot-token regex itself.
- `QWENPAW_DISABLED_CHANNELS` does not list telegram. Current live
  state: `enabled: false`, `bot_token: ""`, `dm_policy: "open"`,
  `group_policy: "open"`, `allow_from: []`, `require_mention: false`.

## Cost

No new service, no new key, no new dependency. The bot polls
`getUpdates` (the upstream channel's existing behaviour) and talks
to the loopback console API for actions. The only runtime cost is
the polling itself, which is the channel's normal operation.
