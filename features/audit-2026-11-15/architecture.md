# Architecture — QwenPaw on InstaBox Free (audit 2026-11-15)

## Product, principals, resources
Single-user self-hosted AI agent (QwenPaw v2.3.0, Docker on InstaBox Free) fronted by
Cloudflare Pages proxy (`qwenpawx.pages.dev`, `qwenpaw-frontend.pages.dev`) and kept
alive by a 5-min Worker cron. Principals: (1) the owner Rohan (only trusted user,
console account `satwik`); (2) unauthenticated internet visitors to the public
Pages/Worker URLs; (3) QwenPaw's LLM (GPT Astra gpt-6-astra default, Kilo fallback)
which consumes agent/tool outputs. Protected resources: console session + auth.json,
API keys in `working.secret/`, user chats/history, ticket/group-chat content, Worker
secrets (BOARD_TOKEN, GROUPCHAT_TOKEN unset, ROUTINE_WEBHOOK_TOKEN unset).

## Stack / deployment
- InstaBox Free VM (4 vCPU/8 GiB, 30-min idle pause, 480-min max run, cooldowns),
  Docker `agentscope/qwenpaw:v2.3.0`, `restart: always` + systemd unit, bind mounts
  under `/data/home/qwenpaw/`.
- Cloudflare Workers (Free): keepalive (cron */5), routines (cron */30 + daily),
  groupchat (Durable Object SQLite), board (KV), activity-feed (KV read).
  Pages: qwenpawx + qwenpaw-frontend (Advanced Mode `_worker.js` proxy),
  qwenpaw-pages (bot-built pages).
- GitHub `Ratulbaba7/qwenpaw-deploy` is the control plane; no secrets in git.

## Entry surfaces and sinks
- Pages proxy `/` → InstaBox origin (method/headers/cookies/body forwarded; 503 wake
  retry, 409 cooldown page; Location + Set-Cookie rewritten). `/status` serves static page.
- Keepalive: `GET /`, `/status`, `/ping`, `POST /wake`; probes QWENPAW_URL; optional
  INSTABOX_API_KEY wake fallback.
- Routines: `GET /`, `/api/status`, `/api/history`, `/api/routines`,
  `POST /api/routines` (token-gated, fail-closed 503 if no token), `POST /trigger`
  (1/min rate limit, stores pending prompt in KV, never calls QwenPaw).
- Groupchat: `GET /` (public info), `GET /thread`, `POST /thread/start|message|reset`
  (token-gated ONLY if GROUPCHAT_TOKEN set — currently UNSET, so open); Durable Object
  enforces turn-taking, 200-msg / 4000-char caps, max_rounds 6.
- Board: `GET /` (public HTML), `/api/*` requires BOARD_TOKEN (?key= or X-Board-Key,
  constant-time compare); KV single-key JSON store; UI escapes output; copy-curl
  emits a QwenPaw chat task for manual posting.
- Activity feed: `GET /`, `/api/status`, `/api/live` (probes QWENPAW_URL); KV read-only.
- QwenPaw console itself: auth on, localhost bypass (`allow_no_auth_hosts` 127.0.0.1/::1),
  SSE chat, `/api/console/chat`, cron jobs (APScheduler, jobs.json), skills
  (delegate, github, build-page, mailbox Gmail-only), channels (console only enabled),
  heartbeat (disabled in config), Telegram/Slack patches unapplied.

## Trust boundaries and strongest visible control on each
- Internet → Workers: board key (set), groupchat token (UNSET — open), routines write
  token (UNSET — fail-closed 503), keepalive /wake (check).
- Pages proxy → InstaBox origin: QwenPaw auth (session cookie); proxy forwards cookies.
- Groupchat/board text → QwenPaw agent: relay/manual paste — prompt-injection path.
- Worker → KV/DO: per-worker bindings, key prefixes (`routines:`).
- Machine loopback → QwenPaw API: no-auth bypass for 127.0.0.1 (relay runs on machine).
- Repo → deployment: GitHub token + Cloudflare token in connectors, never in files.

## Starting paths
`features/groupchat/worker/src/index.js`, `features/board/worker/src/index.js`,
`features/routines/worker/src/index.js`, `features/infra/workers/activity-feed/index.js`,
`worker/src/index.js`, `pages/public/_worker.js`, `features/botpages/`,
`features/integrations/github-SKILL.md`, `features/infra/scripts/*`,
`features/infra/evals/*`, `instabox/docker-compose.yml`, `instabox/qwenpaw.service`.

## Companion selection
ATTACK-CLASSES ordinary blocks: Access control, Authentication, Injection (XSS/stored),
SSRF, Resource exhaustion, Business logic / race conditions, Information disclosure.
BugHunter hunt-* skills per surface: hunt-auth-bypass, hunt-xss, hunt-idor,
hunt-race-condition, hunt-business-logic, hunt-ssrf, hunt-cors, hunt-llm-ai,
hunt-cache-poison, hunt-open-redirect, hunt-session, hunt-csrf, hunt-cloud-misconfig,
hunt-api-misconfig, plus triage-validation 7-Question Gate and evidence-hygiene
(redact PII/secrets in all evidence). Replica-test method for functional testing
(happy/edge/negative cases per flow); replica-diff for Rakazo parity scoring.
