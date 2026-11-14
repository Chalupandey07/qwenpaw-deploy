# QwenPaw board features — #12 tickets, #20 open work, #15 fallbacks + cost

Built 2026-11-15. English only, no China endpoints, cloud LLM only,
InstaBox Free only. Nothing on the machine was modified; no container
restart; no secrets in git.

## #12 — Ticket board (LIVE)

- **URL:** https://qwenpaw-board.qwenpaw-rohan.workers.dev
- **Worker:** `qwenpaw-board` (Cloudflare account
  `ca85fe3692c3f378200950999df9a35e`, subdomain `qwenpaw-rohan`)
- **KV namespace:** `qwenpaw-board-tickets`
  (`90508a020d27455b83d137f8c0323774`) — one key, `tickets`, holds the
  whole board as JSON.
- **Source:** `worker/src/index.js` (no build step),
  `worker/wrangler.toml` (reference; deploys were done via the
  Cloudflare API, see below).
- **Auth:** shared board key in the Worker secret `BOARD_TOKEN`. Every
  `/api/*` call needs it as `?key=` or `X-Board-Key` header. The HTML
  page asks for it once and stores it in `localStorage`. The key value
  is **not** in this repo — ask the coordinator for it.
- **Columns:** To do / In progress / In review / Blocked / Done / Won't do
  (6 columns, matching Rakazo's board exactly).
- **API:** `GET /api/tickets`, `POST /api/tickets`, `GET|PATCH|DELETE
  /api/tickets/:id`, `POST /api/tickets/:id/comments`,
  `POST /api/tickets/:id/mark-sent`,
  `GET /api/tickets/:id/qwenpaw-task`, `GET /health`.
- **Comments:** tickets carry a `comments` list (max 50, 1000 chars each);
  comments are included in the QwenPaw task text. (Rakazo parity:
  tickets have comments.)
- **Mark as sent:** after posting a ticket to QwenPaw, `POST
  /api/tickets/:id/mark-sent` (or the board's "Mark as sent" button)
  records `qwenpaw_session: board-<id8>` + `sent_to_qwenpaw_at`, and
  moves a To-do ticket to In progress. The board shows "Sent to
  QwenPaw … · session …" on the card, and `qwenpaw-task` reports
  `sent: true`.
- **Verified live 2026-11-15 (two full runs, see "Live tests" below):**
  unauthenticated call → 401; create → 201; comment → stored with
  timestamp (empty comment → 400); mark-sent → in-progress +
  session + timestamp; `qwenpaw-task` returns the task text + curl
  with `sent: true`; move to Won't do; delete → `{"deleted": true}`;
  board empty afterwards; invalid column → 400.

### Posting a ticket to QwenPaw (documented path — no fake automation)

QwenPaw has a real endpoint for this: `POST /api/console/chat`
(streaming, Agent API Request Format — source:
`/app/src/qwenpaw/app/routers/console.py`, `post_console_chat`).
It requires a **logged-in console session**, so the board Worker
cannot post on your behalf. Each ticket maps to one console session
(`session_id: board-<first 8 chars of ticket id>`).

From a ticket, click **Post to QwenPaw** in the board UI: it shows the
formatted task text and a curl template. Either paste the text into the
console chat at https://qwenpawx.pages.dev, or run the curl from a
browser session that is already logged in. The run continues in the
background after disconnect; stop it with `POST
/api/console/chat/stop?chat_id=<chat id>`.

Request shape (verified from `_extract_session_and_payload`):

```json
{"channel": "console", "user_id": "default",
 "session_id": "board-<ticket id>",
 "input": [{"content": [{"type": "text", "text": "<ticket title + description>"}]}]}
```

(The `POST /api/messages/send` endpoint is **not** suitable: it sends
an outbound message to a channel user/session, it does not ask the
agent to do work.)

### KV eventual-consistency caveat (observed, not hidden)

Cloudflare KV is eventually consistent. During live tests, rapid
create → move → move → delete → list cycles showed stale reads: a
deleted ticket briefly reappeared in a list read from another edge
replica, while the authoritative KV value (read via the API) showed the
delete had already persisted. Worst observed lag was ~60 seconds; the
board converged to the correct state on its own every time. Mitigation
shipped in the board UI: mutations update the screen immediately from
the mutation response (which already carries the authoritative ticket)
and only re-fetch in the background 4 seconds later — so a user never
sees their own action "undone" by a stale read. In normal single-user
use (one click at a time) this is barely noticeable, but do not
rapid-fire moves and expect every reload in the next minute to agree.

### Deploy / redeploy

```bash
# 1. Upload the Worker (multipart via cf.py)
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py put-worker \
  /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/scripts/qwenpaw-board \
  worker/src/index.js \
  '{"main_module":"index.js","compatibility_date":"2026-11-14","bindings":[{"type":"kv_namespace","name":"TICKETS","namespace_id":"90508a020d27455b83d137f8c0323774"}]}'
# 2. Enable the workers.dev route (fresh API-uploaded scripts have it OFF —
#    without this the URL returns Cloudflare error 1042 / 404)
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py post \
  /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/scripts/qwenpaw-board/subdomain \
  '{"enabled":true}'
# 3. Rotate the board key (value never goes in git)
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py put \
  /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/scripts/qwenpaw-board/secrets \
  '{"name":"BOARD_TOKEN","text":"<new random key>","type":"secret_text"}'
```

Free-tier notes: no cron, no Durable Objects, one small KV key, a
handful of requests per board visit — far inside the 100k req/day
Free allowance.

## #20 — Open work / artifacts / follow-ups

- **Page:** `open-work.html` (+ `open-work-data.json`) — static,
  snapshot-based, data embedded in the page. **Not live**: re-run
  `python3 refresh-open-work.py` to regenerate from the machine.
- **Refresh script:** `refresh-open-work.py` — pulls live data read-only
  via `ib exec`: `jobs.json` (both agents), `agent.json` (model fields),
  `chats.json` (counts only), `history.db` (SQLite `mode=ro`,
  metadata only: row counts, kinds, sessions, date range — **no
  message content**), recent workspace files, `state/last_dispatch.json`.
- **Follow-ups:** `follow-ups.md` (manual checklist, picked up by the
  refresh script) + open board tickets + open jobs. Follow-ups are
  **per agent** (`## default`, `## QwenPaw_QA_Agent_0.2`, `## shared`
  sections) — like Rakazo's per-bot open-work list in bot settings.
- **Jobs:** `jobs.json` is QwenPaw's **scheduled-jobs (cron) store**
  (`CronJobSpec`: id, name, enabled, schedule, task_type text|agent,
  dispatch). The page renders each job as a row (name, enabled, type,
  schedule, dispatch) plus its **last run** from
  `jobs_history/<job-id>.json` (run_at, status, error, trigger) when
  one exists. No `jobs_history` exists yet — no job has ever run.
- **Snapshot age:** both snapshot pages show a computed "Snapshot age"
  line in the header, so a stale page is obvious; re-run the refresh
  script when it is hours old.
- **Live findings (snapshot 2026-11-15 01:04 IST):** both `jobs.json`
  files are empty (`{"jobs": [], "version": 2}`) — no open jobs;
  `resource/`, `media/`, `digest/` are empty — no agent-produced
  artifacts yet, so the page lists recent workspace files instead;
  history: default agent 13 rows / 3 sessions (latest activity
  2026-11-15T01:03:56), QA agent 0 rows; default has 4 chats, QA 0.
- **Honest limit:** there is no push/live feed from the machine to a
  static page on InstaBox Free — the snapshot + refresh script is the
  achievable version. (The console itself has a live token-usage API,
  but it is auth-gated: public unauthenticated `GET /api/token-usage`
  returns 401, verified 2026-11-15.)

## #15 — Model fallbacks + per-bot model + cost page

- **Proposal:** `config-patch.md` — **not applied**, needs user OK.
  Verified against QwenPaw source: an ordered per-agent fallback chain
  exists (`fallback_models: list[ModelSlotConfig]`,
  `fallback_policy`, `thinking_level` in `agent.json`; runtime in
  `model_factory.py` / `fallback_chat_model.py`; apply via `PATCH
  /api/agents/{agentId}/model-settings`, which validates slots and
  reloads the agent — no restart, no file edit).
  Proposed chain for the default agent: `xingchiapi/gpt-6-astra` →
  `kilo/kilo-auto/free` (free), `thinking_level: "inherit"`.
  OpenRouter is deliberately **not** included yet (no API key — the
  PATCH validator would reject the whole patch with 422).
- **Cost page:** `cost.html` (+ `cost-data.json`), regenerated by
  `refresh-cost.py` from live `working/token_usage.json` (read-only).
  Shape matches Rakazo's usage page (totals + per-model breakdown).
  Both snapshot pages show a computed "Snapshot age" line.
- **Live usage (snapshot 2026-11-15):** 120,874 prompt / 1,477
  completion tokens, 10 calls. Kilo `kilo-auto/free`: 85,503 prompt /
  1,294 completion, 7 calls, **$0.00** (catalog pricing all `"0"`,
  billing `free`). GPT Astra `gpt-6-astra`: 35,371 prompt / 183
  completion, 3 calls, cost **UNKNOWN** — the provider catalog reports
  no pricing (`{}`, billing `unknown`), so the page shows UNKNOWN
  rather than guessing a price.
- **Thinking level:** per-agent `thinking_level` exists
  (`inherit/off/minimal/low/medium/high/xhigh/max/budget`, budget
  needs `thinking_budget` ≥ 1). Providers advertise
  `reasoning_effort_options: none/minimal/low/medium/high/xhigh` and
  `thinking_budget_range: [1, 81920]`, so the effect is model-specific.
  `config.json` has no thinking-level knob (its `thinking` matches are
  only `show_thinking` display toggles).
- **Fallback limits:** fallback fires only on transient provider
  failures (timeout/rate-limit/unavailable), never on poor-quality
  output.

## Live tests (2026-11-15, all re-run after every change)

- **Pages:** `qwenpawx.pages.dev/` → 200 (38,125 B, same as baseline);
  `/status` → 200; `/api/auth/status` → 200
  `{"enabled":true,"has_users":true}`; `/api/token-usage` public →
  401 (auth-gated, as designed). Keep-alive Worker → 200.
- **Container:** `docker ps` → `qwenpaw Up (healthy)
  agentscope/qwenpaw:v2.3.0`. CJK grep over working text files → 0.
- **QwenPaw routes (runtime, read-only, no state changed):** OpenAPI/
  docs are disabled in this build (all 404), so routes were proven by
  method/body probes from inside the container: `POST
  /api/console/chat` with malformed JSON → 422; `PATCH
  /api/agents/default/model-settings` with malformed JSON → 422;
  `POST /api/messages/send` with `{}` → 422; control POST to a
  nonexistent route → 405. The 422s prove the routes exist and
  validate input before any handler runs — no chat, run, or config
  change was made.
- **Board v1 full flow:** unauth → 401; create → 201; move
  todo → in-progress → done (each confirmed by a later list read);
  `qwenpaw-task` → correct session id, API URL and curl; delete →
  `{"deleted": true}`; list → `[]`; get deleted → 404.
- **Board v2 full flow:** root HTML contains "Won't do", "Mark as
  sent", "Add a comment", "Copy curl"; create → 201; comment → stored
  with timestamp (empty comment → 400); mark-sent → in-progress +
  `session: board-<id8>` + timestamp; `qwenpaw-task` → `sent: true`
  and comments included in the task text; move to Won't do; delete →
  `{"deleted": true}`; list + authoritative KV read → `[]` after
  convergence (see KV caveat — worst observed stale-read lag ~60 s).
- **Refresh scripts:** both re-run clean; outputs re-generated with
  fresh timestamps; HTML parses; `open-work-data.json` shows per-agent
  follow-ups parsed correctly and `job_history: {}` (none exist yet);
  `cost-data.json` totals match the live `token_usage.json`.
- **Bugs found by testing (all fixed, then re-tested):**
  1. Fresh API-uploaded Worker had its workers.dev route OFF → URL
     returned Cloudflare error 1042 / 404. Fixed with `POST
     .../workers/scripts/qwenpaw-board/subdomain {"enabled":true}`
     (deploy step 2 above).
  2. Board UI re-fetched immediately after every mutation and showed
     stale KV reads. Fixed with optimistic updates from the mutation
     response + background re-fetch after 4 s.
  3. Test-harness bugs (not product bugs): `/tmp` filled to 100% by
     the two repo clones, which broke a test script's temp file and
     left a test ticket behind with an empty id; fixed by moving the
     clones out of `/tmp` and re-running the flow with the real id —
     the board itself behaved correctly throughout.
- **NOT tested (needs a logged-in browser session — for the user /
  coordinator):** an actual successful `POST /api/console/chat` that
  makes QwenPaw answer a ticket, and applying the fallback patch in
  `config-patch.md`. Both are documented with exact steps; neither was
  faked. The board's "Post to QwenPaw" path is verified up to the
  endpoint (route exists, request shape verified from source); the
  last step — the agent actually answering — still needs a human
  login, because the console API is auth-gated and the board holds no
  QwenPaw credentials by design.

## Audit notes (QwenPaw + Rakazo repos, read 2026-11-15)

- Deployed QwenPaw `v2.3.0` **is the latest stable release**
  (GitHub API). Upstream `main` is `2.3.1b1` (pre-release) — see
  Proposals; no upgrade was made.
- Upstream `agents.py` fallback structure matches the deployed image,
  so `config-patch.md` stands as written.
- Rakazo board columns are exactly To do / In progress / In review /
  Blocked / Done / Won't do; tickets have an assignee bot + comments.
  Our board now matches (6 columns, per-ticket agent, comments).
- Rakazo open work is a per-bot checklist in bot settings; our
  `follow-ups.md` is now per-agent for the same reason.
- Rakazo's usage page is totals + per-model breakdown; our cost page
  matches that shape.
- `jobs.json` is QwenPaw's cron/scheduled-jobs store, not a generic
  task list; the open-work page now renders it as such, with last-run
  state from `jobs_history/`.

## Proposals (NOT done — need a user decision, a rebuild, or a paid key)

These came out of the audit. They are recorded here, not built
silently, because each needs something this task cannot assume.

- **QwenPaw 2.3.1b1 upgrade:** upstream `main` is one beta ahead of
  deployed `v2.3.0`. Upgrading means a new image + container
  recreate/restart + snapshot — needs user OK and a maintenance
  window. No stable release is newer than `v2.3.0` today.
- **Routines (Rakazo #4, adjacent to #20):** scheduled work via a
  Cloudflare Worker cron that posts to QwenPaw. The pattern exists
  (our keep-alive Worker), but schedules + prompts are user decisions,
  and each run creates a real agent run. Not built here.
- **Telegram channel (Rakazo #6, adjacent):** QwenPaw has a Telegram
  channel preset; re-enabling a non-China channel is a config change
  needing a bot token from the user. Not done here.
- **Bot-built shareable Pages (Rakazo #7, adjacent to #20):** a QwenPaw
  skill that writes HTML and deploys it to a Pages project via the
  Cloudflare API. Feasible on Free, but it is a new skill + deploy
  glue, not part of the board brief. Not built here.
- **OpenRouter as a fallback slot:** already specified as phase 2 in
  `config-patch.md` — needs the user to add an OpenRouter API key in
  the console first.
- **Live computer with watchable screen (Rakazo #1):** not feasible on
  InstaBox Free (needs a second desktop machine; QwenPaw's browser is
  headless). No action taken.

## Files in this directory

| File | What it is |
|---|---|
| `worker/src/index.js` | Ticket board Worker (deployed) |
| `worker/wrangler.toml` | Worker config reference |
| `open-work.html` / `open-work-data.json` | Open-work snapshot page + data |
| `refresh-open-work.py` | Regenerates the open-work snapshot (read-only) |
| `cost.html` / `cost-data.json` | Cost/usage snapshot page + data |
| `refresh-cost.py` | Regenerates the cost snapshot (read-only) |
| `config-patch.md` | Verified fallback-chain proposal (not applied) |
| `follow-ups.md` | Manual follow-up checklist |
| `README.md` | This file |
