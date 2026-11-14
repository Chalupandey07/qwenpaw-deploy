# Group chat + Telegram + delegation (Rakazo gaps #6, #2, #3)

Built 2026-11-15. QwenPaw `agentscope/qwenpaw:v2.3.0` on InstaBox Free.
English only, no China endpoints, cloud LLM only. No container restart
was done for this build; no secrets are in this repo.

## What was built

| Gap | Deliverable | Status |
|-----|-------------|--------|
| #6 Telegram | `telegram/config-patch.md` — exact verified patch (file only, not applied) | Done, awaiting user token + batched restart |
| #2 Multi-bot group chat | `worker/` — `qwenpaw-groupchat` Worker + Durable Object thread + turn-taking; `relay/relay.py` — machine-side relay (repo file, not installed) | Worker deployed + verified live (Durable Object fix 2026-11-15, see below); relay install is a coordinator decision |
| #3 Subagents / parallel delegation | `skills/delegate/SKILL.md` → installed as skill `delegate` in `working/workspaces/default/skills/delegate/` and `working/skill_pool/delegate/` | Done, on machine, verified present |

## #2 design — read this before using it

### Verified facts the design rests on

1. **QwenPaw already has native bot-to-bot chat.** The agent tools
   `list_agents()`, `chat_with_agent(...)`, `submit_to_agent(...)`,
   `check_agent_task(...)` and the CLI `qwenpaw agents chat` (see the
   built-in skills `chat_with_agent` and `multi_agent_collaboration`)
   send a message to another agent via `POST /api/console/chat` with
   header `X-Agent-Id: <target>` and body
   `{session_id, user_id, input: [{role: "user", content: [{type: "text",
   text: "..."}]}], request_context: {root_agent_id: <caller>}}`
   (verified in `qwenpaw/agents/tools/agent_management.py`
   `build_agent_chat_request` and `qwenpaw/cli/agents_cmd.py`).
2. **Only loopback can call that endpoint without auth.**
   `security.allow_no_auth_hosts: ["127.0.0.1", "::1"]` in
   `working/config.json`; `qwenpaw/app/auth.py` `AuthMiddleware` returns
   401 without a Bearer token otherwise. Verified live: `GET /api/agents`
   and `qwenpaw agents list` work from inside the container with no
   token; the public URL requires login.
3. **There is no native shared group thread.** Each agent-to-agent call
   is a separate 1:1 session. The Worker below supplies the shared
   thread; the relay supplies delivery.

### How a group discussion flows (automated vs manual)

```
You / user                    Worker (Durable Object thread)              Relay (on machine)
  │ POST /thread/start           │                                 │
  │ POST /thread/message         │                                 │
  │  {role:user, text}           │                                 │
  │ ───────────────────────────► │  stores message, next_agent     │
  │                              │  stays "default"                │
  │                              │ ◄── relay polls GET /thread ─── │
  │                              │     every 20 s                  │
  │                              │      delivers digest to default │
  │                              │      via `qwenpaw agents chat` │
  │                              │      (loopback, no token)       │
  │                              │      posts default's reply ───► │
  │                              │  next_agent = QA agent          │
  │                              │ ◄── relay delivers digest to QA │
  │                              │      posts QA's reply ────────► │
  │                              │  round ends, waits for user     │
  └─ GET /thread to read ────────┘
```

- **Automated once the relay runs:** user message in → both agents
  reply in turn → replies land in the shared thread. Turn order is
  enforced twice (Worker returns 409 `not_your_turn` to a wrong-agent
  post; the relay only delivers to `state.next_agent`).
- **Manual until the relay is installed:** the Worker alone only stores
  the thread. Without the relay, someone (or an agent, using the
  `delegate` skill and the native `chat_with_agent` tool) must read the
  thread and carry messages between agents. The relay file is written
  and syntax-checked; installing/starting it is a coordinator decision
  (it is a new background process on the machine — see `relay/relay.py`
  header for install steps).
- **Turn-taking rule:** participants in order `["default",
  "QwenPaw_QA_Agent_0.2"]`. Only `state.next_agent` may post as
  `role: agent`; user messages never consume a turn. After both agents
  reply in a round, `round++` and it is `default`'s turn again. After
  `max_rounds` (default 6) the thread is `complete` until
  `/thread/start` or `/thread/reset`. The relay additionally stops a
  discussion after `DISCUSS_ROUNDS` (default 1) full rounds per user
  message, so the agents cannot ping-pong forever on their own.
- **Free-tier safe:** the Worker has no cron trigger (the keepalive
  Worker owns the one cron in use), no subrequests to QwenPaw, and the
  thread is capped at 200 messages × 4000 chars in the Durable Object. The relay polls
  from the machine, so InstaBox pauses just pause polling; nothing is
  lost (the thread lives in the Durable Object).

### The KV race — found by live test 2026-11-15, fixed with a Durable Object

The first version stored the thread in one Workers KV key
(`GROUPCHAT`, namespace `014a2c0ec84e4829aa5b420d9ccf441f`) and did
read-modify-write on every POST. A verification pass (5 sequential
posts <1s apart: start → user message → default reply → default again
→ QA reply) proved that design broken:

- The **user message was permanently lost**: the default agent's post
  loaded the pre-user-message thread and overwrote it (settled state
  after 60 s: `seq: 1`, messages = `[default reply only]`).
- **Turn state flapped between KV replicas**: the out-of-turn QA post
  got 409 "it is default's turn" while the very next read said
  `next_agent` was the QA agent. KV is eventually consistent across
  edge locations, so a single-key thread can never enforce turn-taking.

Fix (2026-11-15, same HTTP API, no client changes): the thread now
lives in one SQLite-backed Durable Object (`GroupChatThread`, object
name `"main"`, migration tag `v1`). A Durable Object runs one request
at a time, so load → check → append → save is serialized and no
message can be lost or accepted out of turn. Re-tested rapid-fire
after the fix (same 5-post sequence, `max_rounds: 1`): user message
kept in every later read (`seq: 1` present), in-turn default post 200
(`seq: 2`, `next_agent` QA), out-of-turn default post 409
`not_your_turn`, in-turn QA post 200 (`seq: 3`, thread `complete`,
`next_agent: null`), post-completion post 409 `thread_closed`,
`GET /thread?since=2` returned only `seq: 3`, reset returned an empty
open thread. All pass.
SQLite-backed DOs are the only kind the Workers Free plan can create
(Cloudflare pricing docs, verified 2026-11-14): 100,000 requests/day,
13,000 GB-s/day, 5M rows read/day, 100k rows written/day. This thread
is a few hundred requests/day with no WebSockets/alarms, so the object
hibernates between requests and duration stays tiny. The old KV
namespace is retired (kept in the account, unused).

### Worker endpoints

Base URL: `https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev/`
(Durable Object `GroupChatThread`, object `"main"`).

| Method + path | Body | Result |
|---|---|---|
| `GET /` | — | Service info, endpoints, turn rule |
| `GET /thread[?since=<seq>]` | — | Thread + `next_agent`, `round`, `status` |
| `POST /thread/start` | `{topic?, first_agent?, max_rounds?}` | New open thread |
| `POST /thread/message` | `{author, role: user\|agent, text}` | Appended message, or 409 `not_your_turn` / `thread_closed` |
| `POST /thread/reset` | `{confirm: true}` | Cleared thread |

Auth: if the `GROUPCHAT_TOKEN` secret is set on the Worker, every
endpoint except `GET /` requires header `X-Groupchat-Token`. **Set it
before sharing the URL** (`npx wrangler secret put GROUPCHAT_TOKEN`).
Until then the thread is open to anyone who knows the URL — that is how
it was verified live, and it is flagged as a hardening step, not a
finished state. Never put a QwenPaw user token in the Worker.

### Deploy / redeploy

```bash
cd features/groupchat/worker
python3 deploy-groupchat.py deploy      # upload src/index.js (+ DO binding + migration v1)
python3 deploy-groupchat.py status      # read-only check
curl -s https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev/
# or: npx wrangler deploy   (needs interactive wrangler login)
```

### Relay install (coordinator decision — not done in this build)

See the header of `relay/relay.py`. In short: copy it to the machine,
set `GROUPCHAT_URL` / `GROUPCHAT_TOKEN` / `DISCUSS_ROUNDS`, run it in
the background. Verify with: post a user message to the Worker, watch
both agents reply in the thread within a few minutes.

## #3 delegate skill — how it works

`skills/delegate/SKILL.md` (source of truth in this repo; installed copies
on the machine) teaches the agent to:

1. Split a task into independent sub-tasks (never delegate back to the
   caller, max 2 levels, never the same sub-task twice).
2. Dispatch in parallel with the native `submit_to_agent(...)` background
   tool (or `qwenpaw agents chat --background` CLI), quick questions
   with `chat_with_agent(...)`.
3. Track every dispatch in `<workspace>/delegations.json` (schema in the
   skill; NOT `jobs.json`, which is QwenPaw's own job store).
4. Poll `check_agent_task(...)` on a backoff schedule, then merge all
   results into ONE summary, reporting failures honestly.

The skill file format matches the existing built-in skills exactly
(frontmatter `name` / `description` / `metadata.builtin_skill_version` /
`metadata.qwenpaw.emoji`, then Markdown). The skill_pool manifest
(`working/skill_pool/skill.json`) was NOT hand-edited — it is a generated
manifest. Verified 2026-11-15: the skill was installed but `enabled:
false` in the default workspace (its security scan passes: 0 findings,
`safe=True`); it was enabled with the official CLI (`qwenpaw skills
enable delegate`, no restart), and `qwenpaw skills list` now shows
18 of 18 skills enabled, 0 disabled.

## Files in this directory

```
features/groupchat/
├── README.md                  — this file
├── telegram/
│   └── config-patch.md        — #6 Telegram patch + Slack/Teams/WhatsApp status
├── worker/
│   ├── wrangler.toml          — Worker qwenpaw-groupchat, Durable Object binding GROUPCHAT_THREAD + migration v1
│   ├── package.json
│   ├── src/index.js           — thread store + turn-taking enforcement
│   └── deploy-groupchat.py    — deploy / status via Cloudflare API
├── relay/
│   └── relay.py               — machine-side poller + loopback delivery (not installed)
└── skills/
    └── delegate/
        └── SKILL.md           — #3 delegate skill (source of truth)
```

## Still needed (user / coordinator)

1. **Telegram bot token** from `@BotFather` + your numeric Telegram user
   ID, then apply `telegram/config-patch.md` + container restart.
2. **`GROUPCHAT_TOKEN` secret** on the Worker before sharing its URL.
3. **Relay install decision** — start `relay/relay.py` on the machine
   (background process) or keep group chat manual (Worker thread +
   agents carrying messages with `chat_with_agent`).
4. After the next container restart, confirm the `delegate` skill shows
   up in the console and the Telegram channel (if enabled) connects.
