# Handoff to AutoClaw — QwenPaw on InstaBox Free

> **For AutoClaw** (working in the user's AutoClaw Web chat, with fine-grained access to `Ratulbaba7/qwenpaw-deploy`).
> **Date:** 2026-11-15. **Written by:** Muse (the user's personal agent), who built and deployed everything below.
> **Your job:** write code for the TODO list in §3, commit it to `Ratulbaba7/qwenpaw-deploy` (branch `main`).
> **Division of labour:** you code + commit to GitHub. **Muse deploys and tests here** (Cloudflare Pages/Workers + the live InstaBox machine + real-browser checks) and reports results back. Do NOT claim anything is live or verified until Muse has tested it here — Muse is the only one with machine/browser access in this setup.
> **Read first:** `PLAN.md` (the full plan + status log), `README.md`, `features/desktop/README.md` (removed 2026-11-15 → features/computer/README.md), `features/test-project/TESTS.md`.

## 1. What this is

QwenPaw (agentscope-ai/QwenPaw, an AI agent with a web console) deployed on **InstaBox Free** (1 machine, 4 vCPU / 8 GiB / 20 GiB, Docker) with:
- Cloudflare Worker keep-alive (pings the public URL every 5 min so the box sleeps as little as possible).
- Cloudflare Pages proxy frontend — the Pages sites **serve the QwenPaw console itself**, not a link to it.
- A Rakazo-style computer layer (live desktop view + take control, per-bot Team/Private displays, terminal, teach-by-showing, needs-you flow, routines, group chat, ticket board, bot-built pages, skills, log-check).

Live URLs (all verified):
- Console: https://qwenpawx.pages.dev/ (backup https://qwenpaw-frontend.pages.dev/)
- Desktop: https://qwenpawx.pages.dev/desktop
- Machine: https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech (InstaBox machine `m_agq5wqqo2fvypym7rjlpvngc2m`, name `qwenpaw`)
- Keep-alive: https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev
- Routines: https://qwenpaw-routines.qwenpaw-rohan.workers.dev
- Group chat: https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev/
- Ticket board: https://qwenpaw-board.qwenpaw-rohan.workers.dev/
- Bot pages: https://qwenpaw-pages.pages.dev/
- Login: username `satwik` (NOT `admin` — see §5). Password is the user's, never in git/memory.

## 2. Current state (verified, not claimed)

- **Phase 0 COMPLETE and browser-verified 2026-11-15 06:58 IST** (all six checks: stream renders, one control pill that clears, terminal shell, Private renders, side panel agrees, idle stays Live).
- **Phase 1 COMPLETE 2026-11-15 07:29 IST:** test project with 61 tests (`features/test-project/`), Round 4: **48 PASS, 0 FAIL** (protocol), 8 need a real browser, 4 need user-held tokens. Log-check option built (`features/test-project/logcheck/`).
- **Browser tests T50–T57 ran 11:27–11:38 IST:** T50 PASS (with a lying screen probe — fixed), T51 PASS, T57 PASS; **T52 FAIL (Take control 500 ×5), T53 FAIL (mode switch), T54 PARTIAL (Recover/Reset silent), T55 BLOCKED, T56 FAIL (no needs-you banner)** — all root-caused (§5, KV incident) and fixed in the Rakazo screen port.
- **Rakazo screen port DEPLOYED 12:00 IST** (qwenpawx `b16c89b5`, frontend `d16b56f6`, both deploy success; `/` 200, `/desktop` gate 200). Machine files synced (watcher + both DriverCards, sha256-verified, watcher restarted, drivers hot-reloaded 12:00:57 IST).
- **Snapshot:** `qwenpaw-phase0-verified` (`sn_agq53pcvh6nfxjbyc4pfuk3vua`), READY 11:15 IST — the current restore point. (Oldest snapshot `qwenpaw-ready` was deleted on the user's delegated choice to make room; snapshots are capped at 5.)
- **QwenPaw version: v2.3.0 — already the latest upstream release** (verified 2026-11-15: `agentscope-ai/QwenPaw` latest release is v2.3.0, published 2026-11-11). There is **no fork of QwenPaw** under `Ratulbaba7` (verified HTTP 404). Our code lives in `qwenpaw-deploy` (deploy configs, Workers, Pages, features) — the QwenPaw app itself runs from the Docker Hub image `agentscope/qwenpaw:v2.3.0`. If a newer stable upstream release appears, upgrade the image tag in `instabox/docker-compose.yml` (snapshot first, test, commit). Do NOT install beta/pre-release builds without the user explicitly approving (2.3.1b1 was proposed, never approved).

## 3. TODO list (in priority order)

### P0 — re-verify after the port (Muse does this here; your code must support it)
- T50–T57 re-run in a real browser after deploy: take/release (one pill, clears), terminal shell, Team→Private distinct render, side-panel agreement, idle ~3 min, first-load boot state ("Booting live desktop…" not a black screen), Recover/Reset arm → honest 501 toast, needs-you banner from a real agent run (Gmail sign-in).
- **Timing gate:** Cloudflare KV write quota (1,000/day) was spent; it resets **midnight UTC = 05:30 IST 16 Nov**. Takeover/mode/needs-you cannot be live-verified until after that reset. The watcher throttle (§5) is what keeps it from recurring.

### P1 — Phase 2: JEV (research DONE, `features/jev/`, `PLAN.md`)
Jev is TypeSafe's System One **DECISION model, NOT a chat model** — typed questions (Choice/Score/Noul/Box) → typed decisions with calibrated probabilities. 70–500 ms/call, $0.042/MTok in, output free, `POST /v1/systemone`, model `jev-latest`. **Early access — needs a TypeSafe API key (console.typesafe.ai) OR the OpenRouter/Vercel Gateway route.** Priority: (1) access layer (typesafe-ai/skills + jev-mcp-server + jevclient), (2) browser/computer-use Jev loop (copy the jev-ultrafast pattern — indexed action table → one Jev Choice per step — do NOT buy the hosted bu-ultrafast model), (3) approval verdicts, (4) context compaction, (5) model routing (Jevonian), (6) wake gating, (7) skill selection + memory rerank, (8) triage + test gates, calibration throughout. **All optional, flag-gated (`JEV_ENABLED=false` default; no key → Jev paths skipped).** Full 1,206-entry tool list: `features/jev/awesome-jev-tools-full-list.md`. **BLOCKED on the key/route decision — do not invent a key.**

### P2 — Phase 3: Drex / NACE (research DONE, `PLAN.md`)
Drex is a **DECISION model, NOT a chat LLM — same kind as Jev. There is NO `/v1/chat/completions` endpoint. Drex can NEVER be a drop-in chat provider and must NEVER go in `active_model`/`fallback_models`.** Base `https://console.nace.ai`, `Authorization: Bearer <key>`, models `drex-max-v1.1` (default, multimodal, 262,144-token packed request), `drex-max-finance`, `drex-v2.0`. Pricing $0.03/M input, output never billed. Ranked integration: (1) `decision_model` slot for JEV approval — QwenPaw already has `src/qwenpaw/providers/typesafe_provider.py` and `src/qwenpaw/security/decision_model.py` (`assess_tool_call`); `decision_model` is currently `null` on both agents. **Do the source check FIRST** (what request shape typesafe_provider.py sends; what assess_tool_call sends/expects; driver registry; MCP remote-HTTP support; skill secret pattern). (2) `decide` skill wrapping `POST /v1/systemone` — most certain, no QwenPaw code changes (recommended first step). (3) Remote MCP at `https://console.nace.ai/mcp`. **BLOCKED on the NACE key** — the user was sent a secure capture link and has not confirmed submitting it. Do NOT invent or store the key; it must never be written to files/memory/repo.

### P3 — Phase 4: memory (research DONE, `~/workspace/tmp-research/deja-vu-memory-report.md`, `PLAN.md`)
- **Ripwire first** (redhat-et/ripwire, C++23 CLI, offline binary, no API key): verify AVX2 on the VM, install binary on host `/data/home/ripwire`, bind-mount into the QwenPaw container, CLI-first. Build under `/data/home`, **NEVER /tmp** (512 MB tmpfs, 100% full).
- **Tier 1 recall bridge** inside the container querying QwenPaw's `history.db` FTS5 index (it already exists and is populated — `conversation_history` table + FTS5, 93/93 rows) — ≤3 capped excerpts, 2,000-token/turn hard cap, never full sessions. **Repair ReMe** (QwenPaw's memory produced ZERO notes in practice — `memory/`/`digest/` empty; find why).
- **Lessons in the EXISTING `## Important Decisions and Lessons` section of MEMORY.md** (NOT a new file; if split later the name is `LESSONS.md`). ≤10 accepted entries, L-001 ids, user confirms durable writes. Real candidates: "never trust the desktop API's `installed: true` — verify the Chromium binary"; "decode stream-token payloads and check for machine id + nonce before trusting a mint"; "report completion only when a live check confirms it".
- deja-vu proper only as a limited pilot IF Tier 1 proves insufficient (QwenPaw is NOT one of deja-vu's 46 harnesses — needs a custom parser).

### P4 — Phase 5: Code Mode pilot (research DONE, `features/research/code-mode.md`, `PLAN.md`)
Code Mode (`@cloudflare/codemode` v0.5.6, **Experimental**) is TypeScript/Workers-only — QwenPaw's Python loop cannot "use" it directly. Small bounded pilot: one Worker-side Code Mode agent (Durable Object, `createCodemodeRuntime`) + McpConnector driving ONE routine end-to-end, measuring turns/tokens/latency vs the classic approach. Publish the MCP SSE as a token-authenticated InstaBox port or via a Pages `/mcp` route first; verify Worker Loader binding availability on the free tier at deploy time. Do NOT use the legacy `createCodeTool` path expecting prompt savings; do NOT rebuild QwenPaw's loop.

### P5 — token tests T58–T61 (need user-held tokens; never invented)
T58 console login as satwik (password via safe env only); T59 group-chat post flow (GROUPCHAT_TOKEN held by the user); T60 board CRUD with the board key (incl. `%FF` id → 400, empty PATCH → 400, strict-boolean `follow_up`; delete the test ticket afterwards); T61 evals live run (`QWENPAW_USER`/`QWENPAW_PASS` via safe env only; 423 lockout ends the run immediately, never retry).

### P6 — open decisions / items needing the user (do not decide these yourself)
- `INSTABOX_API_KEY` as a Worker secret on both Pages projects (unblocks the "…" maintenance menu Stop action AND the `__wake` desktop-start step).
- Telegram bot token + numeric Telegram ID (patch ready, needs a batched restart).
- `CLOUDFLARE_API_TOKEN` + `GITHUB_TOKEN` in QwenPaw env (unblocks build-page + github skills); mailbox MCP `qwenpawmail` configuration.
- Enable heartbeat (`PUT /api/config/heartbeat`, no restart); approvals AUTO → SMART (patch ready — separate from the DriverCard policy, now `allow`); apply the model-fallback patch (mosicn default / Astra fallback); install the group-chat relay or keep manual replies; voice path (LiveKit free tier vs Twilio trial — needs keys); bot email needs a user-owned domain added to Cloudflare (account has zero zones); board DO/D1 migration; fix for `qwenpaw-query-token-leak`; QwenPaw 2.3.1b1 upgrade proposal (needs rebuild + restart + snapshot).
- TypeSafe API key or OpenRouter-route confirmation (Phase 2); NACE key submission confirmation (Phase 3).

## 4. Hard constraints (non-negotiable)

- **FREE only** on InstaBox — never propose or use Pro. Cloud LLM only, user's own API keys; **no local models / Ollama / QwenPaw-Flash**.
- **English only, no China endpoints/data** (no ModelScope, Alibaba Cloud/ACR, DashScope default). The deployed system was scrubbed of Chinese in 2026-11-15 (config zh→en, timezone Asia/Kolkata, SIP Aliyun→Google/Deepgram, China plugins removed, templates rewritten). Do not reintroduce any.
- **GitHub (`Ratulbaba7/qwenpaw-deploy`) is the control plane / source of truth** for Worker, Pages and deploy configs. Commit everything; secret-scan before pushing.
- **NEVER commit secrets/tokens/keys** — no `.env`, no tokens in code, docs, tests or commit messages. Never invent a token/key. Worker tokens (GROUPCHAT_TOKEN, ROUTINE_WEBHOOK_TOKEN, WAKE_TOKEN, board key, DESKTOP_*_TOKEN) live only as Worker secrets / on the machine — never in git.
- **InstaBox account #2 (Rakazo account, `custom.instabox2`) is READ-ONLY. Never call it, never change anything there.**
- **Verify live before claiming.** A protocol check is not a browser check. Report failures honestly and immediately. Never claim browser verification you do not have.
- **No container restart unless proven necessary** (env changes need a recreate — that is the one proven exception). Auth file (`working.secret/auth.json`) and user chats are never touched.
- **Use GPT Astra (api.xingchiapi.com, models gpt-6-astra / gpt-6.1-sol) with BIG context for intelligence/code questions** — but verify Astra's suggested file paths/keys against the real QwenPaw source before applying (Astra sometimes guesses paths). Note: Astra is flaky (429s, timeouts, gpt-6-astra has returned HTTP 400 on all requests at times); gpt-6.1-sol is the more reliable one. Max thinking, max context on every task.
- **QwenPaw browser is headless** — no live screen exists to watch; the visible desktop is the InstaBox desktop (Xvfb/Xfce/Chromium/VNC) + Camoufox Firefox backup.

## 5. Problems faced — incident log (so you don't repeat them)

- **False "admin login 200" claim (2026-11-14):** the deploy-generated admin password does NOT log in. The real account is `satwik` (created by web registration). Fix path (NOT done, needs user OK): delete `auth.json` + restart → admin recreated from `.env`, but wipes the `satwik` account. Lesson: verify live before claiming.
- **Kilo "missing" (2026-11-15):** Kilo files live in `working.secret/providers/`, NOT `working/`. `providers: {}` in config.json is NORMAL.
- **Disk cleanup purged Chromium (2026-11-15):** the desktop API reported `installed: true` from a stale marker while the binary was gone. Lesson: never trust `installed: true` — verify `/usr/lib/chromium/chromium` exists.
- **Desktop stream token (2026-11-15):** a minted token had payload `{u,g,v,e,i}` — missing machine id (`m`) + nonce (`n`). Rule: decode the payload and check for `m` + `n` before trusting a mint; never mint during a takeover. (Also: an IST/UTC mix-up once made a valid 24h token look expired.)
- **`/desktop` gate (2026-11-15):** QwenPaw auth is header-based (`Authorization: Bearer` or `?token=`); there is NO cookie auth. A plain navigation carries no credential — the gate page must read the console's stored token and mint an HMAC cookie.
- **Private-port 303 (fix round 2, 2026-11-15):** the InstaBox private-port proxy answers `?_token=` with `303 + Set-Cookie`. Workers `fetch()` auto-follows redirects WITHOUT a cookie jar, so the follow-up 401'd and `__status` lied ("origin_auth" while the desktop was up). Fix: `redirect: "manual"` + server-side 303 follow. The gate harness mock could never catch this (it returns the 303 directly) — the origin harness (real undici fetch vs mock proxy servers) exists because of this.
- **Cookie contamination (fix round 2):** the Worker forwarded the browser's single `__Host-instabox_port_auth` cookie first — the proxy honors the FIRST such cookie, so a stale per-port cookie 401'd every other origin. Fix: drop the browser Cookie entirely; proxy-auth cookies stay server-side only.
- **KV write quota burn (2026-11-15, the T52/T53/T56 root cause):** Cloudflare KV free tier = 1,000 writes/day/account. The lease-watcher's unconditional preview uploads (2 writes / 15 s ≈ 11,500/day) spent the whole budget → every KV write 500'd while reads worked. Fix: Worker `kvTry` → honest `503 store_unavailable`; watcher change-only (sha256) + 120 s floor; preview TTL 600 s. Quota resets midnight UTC.
- **DriverCard YAML parse (Phase 1, F27):** unquoted `description:` containing `": "` inside JSON broke YAML parsing — the watcher couldn't reload the cards, so needs-you + narration instructions were never live. Fix: block scalars. Always validate card YAML (QwenPaw's `load_card` or in-container `yaml.safe_load`).
- **Bridge token unset (Phase 1, F28):** `$CAMOUFOX_BRIDGE_TOKEN` was unset in the container — the bridge 401s everything except `GET /health` without it. Fix: token into `.env` + container recreate (env is read at start).
- **Chromium 10×10 window (2026-11-15):** the window had a program-specified 10×10 size despite `--start-maximized` — that is why early screenshots showed a bare desktop. Fix: `--window-size=1920,1048 --window-position=0,0`; Chromium is now a service so bridge restarts don't kill it. If a screenshot comes back bare again, check `xwininfo` map state first; the `desktop-window-watch.service` re-maps unmapped windows every 10 s.
- **Agent screenshot phantom desktop (2026-11-15):** the container ran its OWN Xvfb `:1` (1280×800) while the host's real desktop is Xvnc `:1` (1920×1080). Fix: compose mounts `/tmp/.X11-unix` + a custom supervisord template with xvfb/xfce4 autostart off.
- **Astra stalls:** `StreamIdleTimeoutError` (30 s default) on xingchiapi:gpt-6-astra — fixed with `QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT=120` in `.env`. User switched default model to mosicn/nex-n2.6, which works; keep mosicn default, Astra as fallback (or apply the fallback patch).
- **X.com blocked:** QwenPaw's headless browser gets `ERR_HTTP_RESPONSE_CODE_FAILURE` on x.com (bot-block/login wall). Camoufox loads x.com/0xsatwik fine; X search still needs a one-time X login in the persistent Camoufox profile (never paste an X password in chat).
- **Approval bug (2026-11-15):** computer-use DriverCard policy `ask` made EVERY computer-use tool call an approval request despite Auto Mode (QwenPaw's `evaluate_policy` ignores the console approval level). Fix: rule effect `ask` → `allow`, `default_effect: deny` kept.
- **InstaBox Free limits (cannot be beaten):** idle pause 30 min; max run 120 min growing to 480 with use; cooldown after max-run pause (1st 5–20 min, 2nd 60–75, 3rd+ 120–135; wakes refused `409 machine_cooldown`). A PUBLIC-port request wakes an auto-paused machine; a private-port request without its token 401s and does NOT wake. Cloudflare Tunnel is NOT viable on Free. Snapshot create was once refused HTTP 429 (rate limit — do not retry blindly).
- **Publishing ports:** the field is `"access": "private"`, never `"public": false` (the latter publishes PUBLICLY). Publish tokens are only returned at creation — list/get never return them.
- **Snapshot API notes:** DELETE `/v1/snapshots/{id}` requires an `Idempotency-Key` header (400 without it) and returns 204 empty; create is POST `/v1/machines/{id}/snapshots {"name": ...}` (POST `/v1/snapshots` 404s).

## 6. Repo map (where things live)

- `PLAN.md` — the plan, schedule, status log (keep it updated as work completes).
- `README.md` — deploy overview.
- `instabox/` — `docker-compose.yml`, `.env.example`, `supervisord.conf.template`, `qwenpaw.service`, `setup.sh`.
- `worker/` — keep-alive Worker source.
- `pages/public/` — `_worker.js` (Pages proxy + desktop Worker), `desktop-chrome.html` (desktop UI), `status-page.html`, `vendor/` (xterm.js).
- `scripts/` — `deploy-pages-proxy.py` (deploy to a Pages project), `gh-push.py` (push helper), `fleet.py`, `workspace-export.py`.
- `features/` — `routines/`, `groupchat/`, `board/`, `botpages/`, `desktop/` (study, services, harness `harness-desktop-gate.mjs`, `harness-desktop-origin.mjs`, chrome harness), `test-project/` (61 tests, runner `run-tests.py`, `RESULTS.md`, `logcheck/`), `audit-2026-11-15/`, `jev/`, `research/code-mode.md`, `approvals/`, `improvements/PROPOSALS.md`.
- Machine paths (`/data/home/qwenpaw/`): `.env`, `docker-compose.yml`, `working/` (workspaces, config.json, token_usage.json, qwenpaw.log), `working.secret/` (auth.json, providers/), `working.backups/`. Watcher: `/data/home/mcp-proxy/lease-watcher.py`. Bridge: `/data/home/camoufox/bridge/bridge.py`.

## 7. How to work (for AutoClaw)

1. Read `PLAN.md` + this handoff + the relevant feature README before touching code.
2. Research BEFORE implementing each phase (the research notes are linked in PLAN.md).
3. Write code + tests; run the repo harnesses (`features/desktop/harness-*.mjs`, `features/test-project/run-tests.py`) and get them green.
4. Commit to `Ratulbaba7/qwenpaw-deploy` `main` with clear messages; secret-scan before pushing (no tokens/keys anywhere).
5. Do NOT deploy to Cloudflare or touch the live machine — Muse does that here and reports back (protocol checks + real-browser verification). If your change needs a machine-side file sync, say exactly which repo file maps to which live path.
6. Update `PLAN.md` (status) and `features/test-project/RESULTS.md` (test results) in the same commit as the work.
7. If you are blocked on a secret, a user decision, or a live check you cannot run — say so explicitly in your commit/PR message and in chat; do NOT invent, fake, or work around it.
8. English only in all code, docs, comments and UI strings. No China endpoints anywhere.
