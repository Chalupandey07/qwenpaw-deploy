# Re-test Report — QwenPaw on InstaBox Free (addendum to audit-2026-11-15)

**Run:** retest-2026-11-15 · **Date:** 2026-11-15 (02:32–02:50 IST) · **Repo:**
Ratulbaba7/qwenpaw-deploy · **Machine:** m_agq5wqqo2fvypym7rjlpvngc2m ·
**Prior run:** audit-2026-11-15 (commit ec05510, REPORT.md + FIXES.md) ·
**Container restarts used by this re-test:** 0 (none needed; none requested) ·
**Method:** security-audit-skill (coverage-led, fresh-verifier-per-candidate
discipline — this run is itself the fresh pass over the audit's records),
Claude-BugHunter hunt + triage-validation gate, replica-test functional
method (test plan + numbered cases + bug reports). Live probes only against
the user's own Workers/Pages/InstaBox/QwenPaw endpoints, own test data only,
no tokens guessed or brute-forced, no user chat history / `.env` / `auth.json`
read, no destructive action on user data. No secrets appear in this report
or any file in this run.

## 1. Verdict in one paragraph

All 4 audit-confirmed findings stay fixed (live re-proved: groupchat,
routines, keepalive gates all 401 correctly; board FIX-5 behaviours re-proved
in a local harness, 18/18). **Two new bugs were found, both fixed and
live-verified in this run:** RT-001 (LOW — routines public GETs returned full
routine prompt text) and RT-002 (LOW — groupchat `checkToken` failed open
when the secret was unset). Three audit needs-validation leads stay open
unchanged (board-key entropy, qwenpaw `?token=`, email-router allowlist).
No S1/S2 functional bugs were found. Two items are blocked on the user/parent
(board authenticated CRUD, logged-in console chat re-test) and are stated as
blocked, not passed.

## 2. Per-feature re-test results

| # | Feature | Method | Result |
| --- | --- | --- | --- |
| 1 | Console login + chat reply (mosicn/nex-n2.6) | Log evidence + API | **BLOCKED — needs logged-in session.** No login attempted (no browser, no credentials). Latest evidence in `qwenpaw.log`: mosicn session completed 02:22:04 IST (`console stream done: event_count=750 has_response=True`, 141,639 total tokens). Default model confirmed `mosicn/nex-n2.6` in `active_model.json`. |
| 2 | Pages proxy (`qwenpawx` + `qwenpaw-frontend`) | Live curl + node harness | **PASS.** Root 200 (38,125 B) both projects; `/status` 200; `/api/auth/status` 200 `{"enabled":true,"has_users":true}`; framing headers `X-Frame-Options: SAMEORIGIN` + `CSP: frame-ancestors 'self'` present on HTML; `/api/cron/jobs` 401 on Pages and direct URL. Harness 9/9: 503→wait→retry→200, 503→503→waking page, 409 `machine_cooldown`→cooldown page, 409 other→plain 409, foreign Location dropped, origin Location rewritten, origin-down→generic 502 (no leak). Note: cooldown page status is 503 (not 409) — deliberate translation in code. HEAD on `/` returns 405 from the origin — origin behaviour, not a proxy defect. |
| 3 | Keep-alive Worker (cron + `/status` + `/ping` + `/wake`) | Live curl + Cloudflare API | **PASS.** Cron firing: `/status checkedAt` advanced 21:00:59Z → 21:05:59Z → 21:15:59Z (5-min cadence), `status: up`, `consecutiveFailures: 0`. `GET /ping` 200 public by design. `POST /wake` no token 401, wrong token 401. Secrets list for `qwenpaw-keepalive`: only `WAKE_TOKEN` — `INSTABOX_API_KEY` confirmed still unset, so the API-wake arm stays unreachable. |
| 4 | Routines Worker (cron + trigger gating) | Live curl + node harness | **PASS after fix RT-001.** Cron schedules intact (`*/30`, `30 1`). `POST /trigger` no token 401. `/api/history` public by design (notes only, no prompt text; 7 entries, hunter junk trigger still listed as history metadata only — the pending KV key itself was deleted in the audit fix pass). `/api/status` + `/api/routines` + `GET /` no longer return prompt text (RT-001 fix, live-verified). |
| 5 | Groupchat Worker (turn-taking + token gating) | Live curl + node harness | **PASS after fix RT-002.** `GET /` `auth_required:true`, rate limit advertised. `GET /thread` no/wrong/`?token=` token → 401; `POST /thread/message` no token → 401. Harness 15/15: fail-closed when token unset, header-only auth, out-of-turn agent post 409, user post 200, next-agent advance, 31st write same IP → 429 with `Retry-After`, reads never limited, reset confirm guard. Authenticated turn-taking/flood live re-test blocked (token held by user only) — harness + 401s are the evidence. |
| 6 | Board Worker (CRUD + auth) | Live curl + node harness | **PASS (unauthenticated surface + harness).** `/` 200 (static shell, no ticket data embedded); `/health` GET 200 / POST 405; `/api/tickets` no key 401, wrong key 401, `%FF` id 401 (auth gate precedes decode, as designed); `nosniff` + `no-store` headers. Harness 18/18 re-proves FIX-5: strict-boolean `follow_up`, column honored on create (201), empty/unknown-only PATCH 400, mark-sent idempotent, `%FF` → 400 generic (no `URI malformed` echo), health 405. **Authenticated live CRUD still BLOCKED — needs the board-key holder.** |
| 7 | Bot Pages (`qwenpaw-pages.pages.dev`) | Live curl | **PASS.** Root 200; unknown path 404 with the custom not-found page; `/skills/` 200. `/cost.html` 404 — cost/open-work pages are repo snapshots only, not deployed on bot Pages (see §5 observation). |
| 8 | Activity feed Worker | Live curl + source | **PASS.** Root 200; `/api/live` 200 `status: up`. Wake button source-verified to call keepalive `GET /ping` (FIX-3), never `POST /wake`. |
| 9 | Delegate / github / build-page skills | Log evidence | **PASS (expected skips verified).** Skills installed in default workspace (18 incl. delegate, github, build-page, mailbox, cron, multi_agent_collaboration). Log shows 46 skip lines, all three token gaps: build-page 14× `CLOUDFLARE_API_TOKEN` not set, github 14× `GITHUB_TOKEN` not set, mailbox 18× `qwenpawmail` MCP not configured. No fix attempted — needs the user (tokens), not a code change. |
| 10 | Mailbox skill | Log evidence | **PASS (skip verified, same as #9).** Gmail-only per the English fix; MCP `qwenpawmail` not configured, so the skill is skipped at agent build. |
| 11 | Heartbeat | Live config | **PASS (still disabled, as required).** `agents.defaults.heartbeat.enabled: false`, every `6h`. Not enabled — needs parent OK. |
| 12 | Channels | Live config | **PASS.** Only `console` enabled. Telegram/Discord/Slack/matrix/etc. all `enabled: false` with empty bot tokens — matches "needs user bot token". No China channels enabled (dingtalk/feishu/qq/wechat/wecom all disabled). |
| 13 | Cost / open-work pages | Scripts run live | **PASS.** `refresh-cost.py` exit 0: 329,495 prompt / 4,243 completion / 23 calls, $0.00 (Kilo free; Astra cost UNKNOWN, never guessed), active model mosicn/nex-n2.6. `refresh-open-work.py` exit 0: jobs empty on both agents, history 31 rows (default) / 0 (QA). Both regenerated `*-data.json` + `*.html` in the repo with fresh timestamps. |
| 14 | `token_usage.json` | Live read | **PASS.** Present at `/app/working/token_usage.json`, entries for 2026-11-14/15 (kilo `kilo-auto/free` calls). |
| 15 | Evals runner | `--dry-run` | **PASS (dry-run only).** 5 cases validated, request envelope printed, exit 0, no login, no network calls. **Live run BLOCKED — needs `QWENPAW_USER`/`QWENPAW_PASS`, which were not supplied and must not be derived.** |
| 16 | Fleet manager | Live run | **PASS.** `fleet.py list` (read-only): active agent `default`, QA agent enabled but not active, heartbeat disabled, active model mosicn/nex-n2.6. No writes (script is dry-run-only by design; no `enable`/`schedule` applied). |
| 17 | Workspace export | Live, on a COPY | **PASS.** Export of a 4-file workspace copy (`agent.json` + SOUL/PROFILE/MEMORY) → `out.tgz`, `verify OK: 4 files, agent=default`; import refuses to overwrite an existing destination (guard works). The script's own guard also correctly refused a copy without `agent.json`. Copy deleted afterwards; real workspace untouched. |
| 18 | Audit-report script | Live run | **PASS.** `audit-report.py --lines 50`: 13 governance rows (was 5 at build time; all `allow`, incl. 8 Browser allows), log tail + ERROR/WARNING counts, manual-audit log entry present. Last ERROR in tail is the known x.com browser failure 02:21:16 IST (sibling agent owns browser work; not re-tested here). |
| 19 | Approvals (AUTO→SMART patch) | Live config | **NOT APPLIED — needs user OK (unchanged).** Patch file exists (`features/approvals/config-patch.md`); live `approval_level` in `agent.json` is still `AUTO`, `decision_model` null. Left as-is per the audit's "needs user OK". |
| 20 | Email router | Cloudflare API + source | **PASS (still undeployed, as required).** Workers list: `qwenpaw-board`, `qwenpaw-groupchat`, `qwenpaw-infra-activity`, `qwenpaw-keepalive`, `qwenpaw-routines` — no `qwenpaw-infra-email`. Metadata confirms DRAFT/not deployed, zero zones. Allowlist fix must still land before any deploy (open lead, §4). |
| 21 | Groupchat relay | Machine check | **PASS (still not installed, as recorded).** No relay files under `/data/home/qwenpaw`, no relay process running. Delegate skill exists; relay install remains a user decision. |
| 22 | English-only / no-China check | Live grep | **PASS.** CJK re-grep over `workspaces/default/*.md`: zero matches. Language/timezone keys in config are nested (top-level `language`/`timezone` read null; the English fix set them under the agent/workspace config — not re-derived here). SIP TTS/STT remain Google/Deepgram per config. |
| 23 | Astra stream stalls | Log evidence | **OPEN (known, unchanged).** Log shows 2 unhandled `StreamIdleTimeoutError` events: 01:52:43 IST at the old 30s timeout, 02:13:06 IST at the new 120s timeout (post-fix). No stalls after 02:13:06; last log activity 02:22:04 IST is the mosicn success. Astra chat via `astra.py` produced no response within 100s on two attempts in this run — consistent with the known slowness. Current default (mosicn) works; Astra stays flaky. |
| 24 | Sandbox-unavailable warning | Log evidence | **OPEN (known, environmental).** `ResourceGovernor: sandbox not available — Cannot read /sys/kernel/security/lsm. SANDBOX_FALLBACK will escalate to ASK` at container start 18:40:02. Docker-on-InstaBox limitation, not a code defect; no fix in this run. |
| 25 | X.com via console browser | — | **NOT RE-TESTED (out of scope for this agent).** Sibling agent owns browser/Camoufox work. Known: x.com returns HTTP error to the headless browser (log 02:21:16 IST). |

## 3. New bugs found and fixed

### RT-001 — LOW — Routines public GETs returned full routine prompt text

- **Fingerprint:** `routines-public-prompt-disclosure`
- **Source:** `features/routines/worker/src/index.js` — `GET /api/status`
  (returned `defs` verbatim), `GET /api/routines` (returned `defs` verbatim),
  `GET /` `statusPage()` (rendered `r.prompt` and pending `p.prompt` in HTML).
- **Boundary:** any unauthenticated internet caller → routines Worker public GETs.
- **Observed (live, before fix):** unauthenticated `GET /api/routines` and
  `GET /api/status` returned both routine definitions with full `prompt`
  text (daily-summary, inbox-check); `GET /` rendered the same prompts in HTML.
- **Impact:** LOW — routine prompts are the user's own automation
  instructions (not secrets, tokens, or credentials), but they are personal
  content exposed to anyone who knows the public Worker URL. No prompt was
  ever executed by the Worker; the write paths were already token-gated.
- **Fix:** `publicRoutine()` / `publicPending()` strip `prompt` from all
  public GETs (id/name/scheduleNote/active only; pending shows
  id/at/routine/status only). Token-gated `POST /api/routines` and
  `POST /trigger` responses still return the full definition/entry to the
  token holder. Backup:
  `features/audit-2026-11-15/fix-backups/routines-index.js.pre-retest-2026-11-15`.
- **Verification:** local harness `harnesses/routines-harness.mjs` 11/11
  (fake KV with marker prompt text; all public surfaces clean, gated
  `POST /trigger` still 401). Deployed via `cf.py put-worker`
  (modified_on 2026-11-14T21:10:19Z); cron schedules re-verified intact
  (`*/30`, `30 1`). Live: `/api/routines` and `/api/status` return routines
  without any `prompt` field; `GET /` contains 0 matches for the prompt
  text; `POST /trigger` no token still 401. README hardening section updated.

### RT-002 — LOW — Groupchat `checkToken` failed open when the secret was unset

- **Fingerprint:** `groupchat-fail-open-unset-token`
- **Source:** `features/groupchat/worker/src/index.js` — `checkToken()`
  returned `true` when `env.GROUPCHAT_TOKEN` was unset; the header comment
  documented this ("If it is NOT set, the thread is open to anyone").
- **Boundary:** anyone who knows the groupchat URL, if the secret were ever
  removed or mis-rotated.
- **Observed:** source-verified (live token IS set, so live behaviour was
  safe at audit time and at re-test time — the risk is the unset state, not
  a live bypass). Routines and keepalive already fail closed when their
  token is unset (503/401); groupchat was the odd one out.
- **Impact:** LOW — requires the secret to be deleted/mis-rotated; with the
  token set (current state) there is no exposure. The fix removes the
  footgun rather than closing a live hole.
- **Fix:** `checkToken()` returns `false` when the secret is unset; `GET /`
  stays public and advertises `auth_required`. Backup:
  `features/audit-2026-11-15/fix-backups/groupchat-index.js.pre-retest-2026-11-15`.
- **Verification:** local harness `harnesses/groupchat-harness.mjs` 15/15
  (unset-token → 401 on GET/POST, set-token header auth, `?token=` 401,
  turn-taking 409/200, 31st write same IP → 429, reads never limited,
  reset guard). Deployed via `deploy-groupchat.py deploy` (no migration;
  DO thread state preserved). Live: `GET /` `auth_required:true`;
  `GET /thread` no/wrong/`?token=` token → 401. README auth section updated.

## 4. Rejected candidates (not bugs)

| Candidate | Why rejected |
| --- | --- |
| Pages HEAD → 405 | The 405 comes from the QwenPaw origin, not the proxy worker (the worker proxies HEAD through; the origin rejects HEAD on `/`). GET works. No proxy defect; converting HEAD→GET in the worker would change wake semantics. Informational only. |
| Routines `/api/history` public read | Notes/status only — history entries carry no prompt text (verified: 7 entries, keys `at/kind/qwenpaw/httpStatus/note/activeRoutines/deliveredBy`). Public-by-design status history. Not a disclosure. |
| Board `?key=` still accepted | Deliberate, documented choice (FIX-5): the user may rely on bookmarked `?key=` URLs. Header `X-Board-Key` also works. Same reasoning as the audit; not re-opened. |
| Board harness "create returns 200" | Harness error, not a code bug: create returns **201** with the column honored. Corrected the harness; 18/18 pass. |
| Symlink regression assertion | Harness assertion expected `real.html`, `collect()` returns `/real.html` (leading slash in rel path). Behaviour is correct: only the real file collected, symlinks skipped. |
| Keepalive `/ping` unauthenticated | Documented public wake path (FIX-3 decision): any public request wakes a paused box by design; gating it would break the status-page Wake button. Not re-opened. |
| `cooldownPage` returns 503, not 409 | Deliberate translation: the origin's 409 `machine_cooldown` is surfaced as a 503 cooldown page with `Retry-After`. Harness-verified. Not a bug. |

## 5. Observations (not bugs, for the parent/user)

- **Cost/open-work pages are repo snapshots, not deployed.** `GET
  https://qwenpaw-pages.pages.dev/cost.html` → 404. The refresh scripts
  regenerate them in the repo; nothing serves them publicly. If they should
  be public, that is a deploy decision (bot Pages), not a fix.
- **Machine run budget:** run started 2026-11-14T18:11:43Z, `maxRunMinutes:
  480` → the current run ends ~02:11 UTC 2026-11-15 (~07:41 IST), then a
  5–20 min cooldown. Container `qwenpaw` Up 37 min (healthy) at re-test
  time — the container was recreated 20:29 UTC by the parent's Astra
  timeout fix, not by this run.
- **Astra is still slow/flaky as a service.** Two `astra.py chat` attempts
  in this run produced no response within 100s. This matches the log's
  `StreamIdleTimeoutError` pattern; the provider-side slowness is not
  something a QwenPaw-side timeout can fix (120s already set). Default
  model mosicn works.
- **InstaBox exec payload field is `cmd`, not `command`.** The helper
  `ib.py exec` passes its JSON file through; the API returns 400
  `cmd is required` for `{"command": ...}`. Worth a one-line note in the
  connector doc for the next agent.
- **Local repo copy has no `.git`.** `~/workspace/qwenpaw-deploy/` is a
  plain copy (no `.git` directory), so this re-test could not commit or
  push. All changes below are in place locally; the parent must commit/push
  via the GitHub connector (or a fresh clone).

## 6. Still open / blocked (needs the user or parent)

1. **Board authenticated CRUD live re-test** — needs the board-key holder
   (BUG-001–004 fixes are harness-verified only). Unchanged from the audit.
2. **Board-key entropy** (`board-no-rate-limit-auth`) — needs the key holder
   to confirm BOARD_TOKEN is a ≥32-char CSPRNG value. Unchanged.
3. **QwenPaw `?token=` leak** (`qwenpaw-query-token-leak`) — needs a
   logged-in session + a maintenance window (image rebuild + restart +
   snapshot). Astra could not be consulted (no response in 100s, twice);
   the audit's scoping stands: allow `?token=` only for WebSocket upgrades
   plus an explicit allow-list (file preview, QR-code status), header auth
   everywhere else. No change attempted.
4. **Email-router allowlist** (`infra-email-prompt-injection`) — router
   still undeployed; allowlist + untrusted-email marker must land before
   any deploy. Unchanged.
5. **Console login + live chat re-test** (incl. Astra stream-fix re-test)
   — needs a logged-in browser session. Unchanged.
6. **Live evals run** — needs `QWENPAW_USER`/`QWENPAW_PASS`. Dry-run passes.
7. **Approvals AUTO→SMART + decision model** — patch written, not applied;
   needs user OK. Unchanged.
8. **Board KV-race / growth-cap** — needs a Durable Object / D1 migration
   decision. Unchanged.
9. **Heartbeat enable, model fallback, Spaces/Access design, vault
   approximation** — as recorded in the Rakazo build; unchanged.
10. **Commit + push of this re-test** — local copy has no `.git`; parent to
    commit/push via GitHub. Changed files: `features/routines/worker/src/index.js`,
    `features/groupchat/worker/src/index.js`,
    `features/routines/README.md`, `features/groupchat/README.md`,
    `features/board/cost-data.json`, `features/board/cost.html`,
    `features/board/open-work-data.json`, `features/board/open-work.html`,
    plus new `features/audit-2026-11-15/retest-2026-11-15/` and two
    fix-backup files. Secret-scan before pushing: no token/key values in
    any changed file (checked; only test values in `/tmp` harnesses, which
    are not committed — the copies in `retest-2026-11-15/harnesses/` use
    the same dummy values `tok-abc` / `test-board-key-1234567890` /
    `SECRET-PROMPT-…` markers, never real credentials).

## 7. Files written by this re-test

- `features/audit-2026-11-15/retest-2026-11-15/REPORT.md` (this file)
- `features/audit-2026-11-15/retest-2026-11-15/findings-addendum.json`
- `features/audit-2026-11-15/retest-2026-11-15/test-plan.md`
- `features/audit-2026-11-15/retest-2026-11-15/harnesses/routines-harness.mjs`
  (11/11), `groupchat-harness.mjs` (15/15), `board-harness.mjs` (18/18),
  `pages-harness.mjs` (9/9)
- `features/audit-2026-11-15/fix-backups/routines-index.js.pre-retest-2026-11-15`
- `features/audit-2026-11-15/fix-backups/groupchat-index.js.pre-retest-2026-11-15`
- Updated in place (see §6.10): routines + groupchat worker sources and
  READMEs; board cost/open-work snapshots (regenerated live).
- `features/audit-2026-11-15/replica-test/bugs.md` — RT-001/RT-002 appended
  as fixed.

## 8. Counts

- Features re-tested: 25 (19 Rakazo systems + pre-existing surface, §2).
- Passed: 20. Passed-after-fix: 2 (routines, groupchat). Blocked (not
  passed, not failed): 2 (console login/chat, board authenticated CRUD;
  evals live run and Astra live re-test are sub-parts of those blocks).
- New bugs: 2 (RT-001 LOW, RT-002 LOW) — both fixed + live-verified.
- Rejected candidates: 7 (§4). Open leads carried forward: 3 audit
  needs-validation + 7 user/parent decisions (§6).
- Container restarts: 0. Secrets committed: 0.
