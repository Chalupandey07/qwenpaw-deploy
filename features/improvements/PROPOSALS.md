# Improvement proposals — needs a user / coordinator decision

Date: 2026-11-15. These were found during the test-and-improve pass but
NOT done, because each needs a rebuild, a paid key, a secret the agent
must not invent, or a user decision. Nothing here was applied silently.

## P1 — Set the three Worker shared secrets (security, user/coordinator)

- `GROUPCHAT_TOKEN` on `qwenpaw-groupchat` (all endpoints except `GET /`
  then require `X-Groupchat-Token`). **Verified live 2026-11-15:
  `auth_required: false` — anyone who knows the URL can read and write
  the group-chat thread today.** Same for `ROUTINE_WEBHOOK_TOKEN` on
  `qwenpaw-routines` (without it, `POST /api/routines` is fail-closed
  503, which is safe, but no authenticated routine writes are possible)
  and `WAKE_TOKEN` on `qwenpaw-keepalive` (`POST /wake` and the
  unauthenticated `GET /ping` can otherwise trigger probes / API wakes).
  Generate each token yourself (long random string), set with
  `npx wrangler secret put <NAME>` or the Cloudflare API secrets
  endpoint, store it in the password manager, and give it to the relay
  / callers that need it (`GROUPCHAT_TOKEN` env on the relay machine).
  No token was created or stored by any agent build.

## P2 — Set the two QwenPaw env tokens (user, one-time)

- `CLOUDFLARE_API_TOKEN` (Pages: Edit scope) and `GITHUB_TOKEN` in
  QwenPaw's encrypted env store (`qwenpaw env set <NAME> <token>` inside
  the container). **Verified live 2026-11-15: `qwenpaw skills test
  build-page` / `github` both report "Declared dependencies are not
  satisfied: Environment variable not set".** The skills are installed
  and enabled and their security scans pass (0 findings), but
  `build-page` cannot publish and `github` cannot commit until these
  exist. Until then, deploys must be run from this VM (connector
  credential) as the subagent did on 2026-11-15.

## P3 — Telegram: token + user ID, then apply the patch + batched restart

- Still needs the user: a bot token from `@BotFather` (`/newbot`) and
  the numeric Telegram user ID (from `@userinfobot`). Then apply
  `features/groupchat/telegram/config-patch.md` (verified correct
  against live source 2026-11-15: plugin exists, `channels.telegram`
  keys match the patch's "before" state, `QWENPAW_DISABLED_CHANNELS`
  does not block telegram) and restart the container. The patch sets
  `dm_policy`/`group_policy` to `allowlist` — do not leave them `open`.

## P4 — Upgrade QwenPaw to v2.3.1 when it is released (rebuild + restart)

- v2.3.0 (2026-11-11) is still the latest release; main is 15 commits
  ahead (2.3.1b1 bumped 2026-11-12). Fixes worth picking up at the next
  upgrade (verified from the upstream compare `v2.3.0...HEAD`):
  - `fix(console): gate terminal status checks on auth (#8660)` —
    unauthenticated terminal-status info leak, console frontend.
  - `fix(providers): keep boolean additionalProperties in tool schemas
    (#8607)` — OpenAI-compat tool-schema fix; could matter for
    Astra/Kilo tool calls.
  - `fix(cron): track scheduled agent runs (#8634)` — console-only
    cleanup (removes the maxConcurrency field from the cron-job UI).
  - `fix(security): guard inline Office COM automation (#8048)` —
    Windows-only, irrelevant on this Linux container.
  - `feat(transcription): make the Whisper API model name configurable
    (#8052)` — irrelevant; STT here is Deepgram.
- Needs a new image pull + container restart, so it is a user decision
  and a batched-maintenance item, not a silent change. Do not track
  `main` — wait for the v2.3.1 release tag.

## P5 — Pages proxy: buffered-body POST retry on 503 (needs a real wake to test)

- Today the proxy retries only `GET`/`HEAD` after a 503; a `POST`
  (login, chat submit) during a wake gets the waking page immediately
  and the user must resubmit by hand. The fix is to buffer small
  request bodies (e.g. ≤ 1 MB), wait 45 s, and retry once — but ONLY
  when the 503 body is recognisably InstaBox's wake page, so a
  genuinely-processed request is never double-submitted. NOT shipped:
  the retry path can only be live-tested during a real wake, and the
  rule for this pass is no untested changes. Revisit when a wake can
  be observed (or test against a stub origin first, as was done for the
  503/409/502 paths in `/tmp/test-pages-worker.mjs`).

## P6 — Cloudflare Access in front of the proxy: DELIBERATELY NOT DONE

- GPT Astra suggested it (2026-11-15). It is forbidden by the standing
  rule for this deployment (never enable Cloudflare Access
  enforcement), and QwenPaw's own auth is the gate. Recorded here so a
  future suggestion does not re-open it without the user changing the
  rule.

## P7 — Proxy-to-origin shared secret: not feasible without a QwenPaw change

- Also an Astra suggestion. InstaBox's public URL is a plain proxy;
  QwenPaw has no setting to require a header on public requests
  (`allow_no_auth_hosts` only bypasses auth for loopback). Would need
  a QwenPaw source change or an upstream feature. Not pursued.

## P8 — Routines: create the native cron jobs (needs a logged-in session)

- The Worker registry has `daily-summary` (active) and
  `inbox-check-30m` (paused), but no matching native QwenPaw cron jobs
  exist yet (`working/workspaces/default/jobs.json` is `{"jobs": [],
  "version": 2}`). Create them from the console (or `POST
  /api/cron/jobs` while logged in, body in
  `features/routines/native-cron-jobs.example.json` with real
  `user_id`/`session_id` from `GET /api/cron/dispatch-targets`). The
  heartbeat is also still disabled (`agents.defaults.heartbeat.enabled:
  false`); enable via `PUT /api/config/heartbeat` (no restart) or the
  file patch in `features/routines/config-patch.md`.

## P9 — Group-chat relay: install decision

- `features/groupchat/relay/relay.py` is written and syntax-checked but
  NOT installed (new background process on the machine). Until it
  runs, group chat is manual: someone reads the Worker thread and
  carries messages with the native `chat_with_agent` tool. Installing
  it also means the Durable Object gets polled every 20 s (~4,320
  requests/day — far under the 100k/day free allowance — and the
  object hibernates between polls, so duration stays small).

## P10 — Bot email address (Rakazo idea, needs an auth design)

- Give the bot an email address (Cloudflare Email Routing → Worker →
  QwenPaw) so mail starts a routine. Blocked on the same design point
  as routine prompt delivery: the Worker must not hold the `satwik`
  password. Needs a dedicated low-privilege QwenPaw account + short-expiry token, or a Worker-side allowlist that only accepts mail from
  the user. User decision; not built.

## P11 — Per-routine model / thinking level: not possible in QwenPaw

- Rakazo routines have a per-routine model; QwenPaw's `CronJobSpec`
  has no model field (verified in source). The only lever is the
  agent's own active model. No change proposed.

## P12 — Spend limit: monitoring only, no cap exists

- QwenPaw has no spending-limit key (verified — see
  `features/approvals/README.md`). The cost board under
  `features/board/` (owned by another builder) is the monitoring
  approximation. A real cap needs new code; not proposed here.
