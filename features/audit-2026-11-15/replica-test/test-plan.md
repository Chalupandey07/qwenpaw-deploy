# Test plan: QwenPaw on InstaBox Free (Rakazo build)

Build: 094ba1e66 (Rakazo build 2026-11-15) · Date: 2026-11-15 · Env: live
deployment (own systems only) — console https://qwenpawx.pages.dev (backup
https://qwenpaw-frontend.pages.dev), InstaBox console
https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech, Workers on
qwenpaw-rohan.workers.dev. No Playwright specs were written in this pass; all
cases below are manual/browser + curl against the user's own deployment, with
own test data only, cleaning up test data afterwards. Do not run cases against
any third-party target, do not guess or brute-force any token, and do not use
the live board key or console session except where the case says a logged-in
session is required.

## Scope

Flows F01–F06 are the pre-existing deployment (console, proxy, keepalive,
InstaBox lifecycle). Flows F07–F25 are the Rakazo systems built 2026-11-15
(all 19 except the mobile app and the 15-language UI, which were explicitly
out of scope for the build). Two flows are not testable in the current
deployment and are marked BLOCKED with the reason, not silently dropped:
F22 voice calls (needs LiveKit/Twilio keys) and F23 bot email (Cloudflare
account has zero zones; needs a user domain).

## Standard edge checklist (apply where it fits each flow)

Empty input · very long input · emoji and accents · two tabs at once ·
double-click on submit · back button mid-flow · refresh mid-flow · slow
network · offline · expired session · second user's data (must be invisible —
single-user deployment: nothing of another user exists) · time zones and
daylight saving (Asia/Kolkata) · mobile width · keyboard only · screen reader
labels. Cases below cite the checklist items that apply; the rest are
noted as not applicable per flow rather than repeated 14 times.

## Known-fixed item under re-test

The Astra stream stall (4× StreamIdleTimeoutError, fixed 2026-11-15 01:59 IST
by QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT=120) is re-tested by F02-H2.
**That re-test is still pending a logged-in browser session** — it is not
claimed as passed anywhere in this plan.

## Coverage note — console browser tools

QwenPaw's browser tools are headless-only: there is no live screen to watch,
and x.com often blocks bots, so x.com search via the console browser is
unreliable by nature. F03 cases are written against that reality: a failed
x.com search is environmental, not a console defect, and must not be filed as
a bug without a second, bot-friendly target showing the same failure.

| case | flow | type | steps | expected | auto | result |
| --- | --- | --- | --- | --- | --- | --- |
| F01-H1 | console login | happy | open https://qwenpawx.pages.dev, log in as satwik with the owner-held password, wait for console load | console loads, Default agent shows Running | manual | |
| F01-E1 | console login | edge: expired session | log in, wait for / force session expiry, reload | login screen again, no console content shown unauthenticated | manual | |
| F01-N1 | console login | negative: wrong password | log in as satwik with a wrong password | login rejected (401), no console access | manual | |
| F01-N2 | console login | negative: unauthenticated API | GET /api/auth/status and /api/cron/jobs with no session, via Pages proxy and direct InstaBox URL | 401 on both (already verified by the audit; re-check after any auth change) | manual | |
| F02-H1 | console chat (Astra) | happy | in a new chat, send a short English question; wait for the reply | reply in English, no error, streaming completes | manual | |
| F02-H2 | console chat (Astra) | happy: stream-timeout re-test | in a new chat, send a prompt that needs a slow first token (e.g. a long reasoning question); watch streaming | first content arrives and the reply completes without a StreamIdleTimeoutError stall (fix: QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT=120) — PENDING logged-in browser session | manual | pending |
| F02-E1 | console chat | edge: very long input | send a very long message (near the input limit) | accepted or a clear length error; no hang, no empty reply | manual | |
| F02-E2 | console chat | edge: emoji and accents | send a message with emoji and accented characters | reply handles the text; no mojibake, no error | manual | |
| F02-N1 | console chat | negative: empty message | send an empty message | rejected client-side or a clear error; no empty chat turn created | manual | |
| F03-H1 | console browser tools | happy: bot-friendly target | ask the agent to open a bot-friendly page and summarise it | agent fetches the page (headless tool call) and summarises it | manual | |
| F03-E1 | console browser tools | edge: x.com search | ask the agent to open x.com and search 0xsatwik | x.com often blocks bots — a failure here is environmental, not a console defect; record the outcome, do not file as a bug without a second target failing the same way | manual | |
| F03-N1 | console browser tools | negative: unreachable URL | ask the agent to open a non-existent domain | clear failure reported in chat; no hang | manual | |
| F04-H1 | Pages proxy | happy | open https://qwenpawx.pages.dev/ and https://qwenpaw-frontend.pages.dev/ | QwenPaw console SPA loads (200), /api/auth/status answers | manual | |
| F04-H2 | Pages proxy | happy: status page | open /status on qwenpawx.pages.dev | status/wake page loads; Wake button behaviour matches the documented /ping path | manual | |
| F04-E1 | Pages proxy | edge: machine paused (wake) | with the InstaBox machine paused, open the console URL | 503 wake page/retry, then console loads once the machine is up; no stale error page | manual | |
| F04-E2 | Pages proxy | edge: machine in cooldown | open the console URL during a 5–20 min cooldown window | 409 cooldown page; no misleading error | manual | |
| F04-N1 | Pages proxy | negative: unknown path | open /old-path and /login/ | SPA loads (200), no redirect off the Pages origin, no Location header to a foreign host | manual | |
| F05-H1 | keepalive Worker | happy | GET /status on qwenpaw-keepalive | JSON status (up/down) with checkedAt/lastUpAt; cron ticks every 5 min | manual | |
| F05-H2 | keepalive Worker | happy: /ping | GET /ping | probe runs, status JSON returned (public wake path by design — see audit §3.3) | manual | |
| F05-E1 | keepalive Worker | edge: /wake while up | POST /wake unauthenticated while the machine is up | 200, status up, wake:null (WAKE_TOKEN unset — see audit; re-check after the token is set: unauthenticated POST must then return 401) | manual | |
| F05-N1 | keepalive Worker | negative: bad method | OPTIONS preflight on /wake from an arbitrary origin | 204 with the documented CORS headers; no state change | manual | |
| F06-H1 | InstaBox lifecycle | happy | confirm the machine is running, container healthy, Pages 200, Worker up | all green; snapshot qwenpaw-ready exists | manual | |
| F06-E1 | InstaBox lifecycle | edge: idle pause + auto-start | let the machine idle past 30 min, then hit the public URL | machine wakes on request; systemd unit runs docker compose up -d on fresh boot | manual | |
| F06-N1 | InstaBox lifecycle | negative: container down | stop the qwenpaw container, then hit the console URL | restart: always brings it back; if not, systemd unit does on reboot | manual | |
| F07-H1 | routines Worker | happy: list | GET / and /api/routines on qwenpaw-routines | status page + routines list load; cron ticks */30 and 07:00 IST daily | manual | |
| F07-H2 | routines Worker | happy: manual trigger (owner) | owner POST /trigger with a prompt (with X-Routine-Token once the token is set) | 202, pending entry appears in GET / and /api/history with a forced probe result | manual | |
| F07-E1 | routines Worker | edge: trigger rate limit | two POST /trigger within a minute | second returns 429 (1/min global limit); owner is not locked out beyond a minute | manual | |
| F07-N1 | routines Worker | negative: unauthenticated trigger | POST /trigger with no token (after the fix) | 401 (or 503 if the secret is unset) — currently unauthenticated, see audit §3.2 | manual | |
| F08-H1 | group chat | happy | GET /thread on qwenpaw-groupchat | thread JSON loads (open, round 1, max_rounds 6) | manual | |
| F08-H2 | group chat | happy: post + turn-taking | post a user message, then an agent message as the next_agent participant | user post accepted; agent post accepted only for the participant who is next_agent, else 400/409 | manual | |
| F08-E1 | group chat | edge: 200-message cap | post user messages until seq passes 200 | oldest messages evicted silently (known confirmed LOW finding — re-check after the rate-limit fix: expect 429 and no silent eviction) | manual | |
| F08-E2 | group chat | edge: 4000-char message | post a message over 4000 chars | rejected or truncated with a clear response; no partial post | manual | |
| F08-N1 | group chat | negative: reset without confirm | POST /thread/reset without {confirm:true} | thread is not wiped | manual | |
| F08-N2 | group chat | negative: unauthenticated after token set | GET /thread and POST /thread/message with no/wrong token (after GROUPCHAT_TOKEN is set) | 401 — currently open, see audit §3.1 | manual | |
| F09-H1 | ticket board | happy: CRUD | with the board key, create a ticket, list it, PATCH a field, add a comment, delete it | each step returns the expected ticket JSON; list reflects the change | manual | |
| F09-H2 | ticket board | happy: mark-sent | create a ticket, POST mark-sent | sent_to_qwenpaw_at set, column moves todo → in-progress, session is board-<id8> | manual | |
| F09-E1 | ticket board | edge: follow_up boolean | PATCH follow_up with a JSON boolean true/false | stored exactly as sent (BUG-001: string "false" currently coerces to true) | manual | |
| F09-E2 | ticket board | edge: mark-sent twice | POST mark-sent twice on the same ticket | second call does not overwrite the original sent timestamp (BUG-002) | manual | |
| F09-E3 | ticket board | edge: empty PATCH | PATCH {} and PATCH with only unknown fields | 400 {error:'no fields to update'} (BUG-003: currently 200 no-op that bumps updated_at) | manual | |
| F09-E4 | ticket board | edge: invalid-UTF-8 id | authenticated GET /api/tickets/%FF | 400 {error:'invalid ticket id'} after the fix (BUG-004: currently 500; %ZZ is edge-blocked with 400 before the Worker) | manual | |
| F09-E5 | ticket board | edge: two tabs / double-click | create the same ticket from two tabs, double-click create | no duplicate ticket from a double-click; concurrent creates do not silently lose each other (BUG-005: load-modify-write race) | manual | |
| F09-N1 | ticket board | negative: no key | GET /api/tickets with no key and with a wrong key | 401 both times, identical body; no ticket data leaked | manual | |
| F09-N2 | ticket board | negative: bad field values | PATCH with a wrong-typed title/column/agent/priority | 400 with a field error; follow_up must also reject non-booleans after BUG-001 is fixed | manual | |
| F10-H1 | bot pages | happy: build + deploy | ask the agent (build-page skill) to build a page, then deploy it | page appears at qwenpaw-pages.pages.dev/<slug>/, renders as built | manual | |
| F10-E1 | bot pages | edge: symlinked source file | place a symlink in the source dir pointing outside it, run collect()/deploy | symlink is skipped/refused; outside content is never published (see audit needs-validation §5) | manual | |
| F10-N1 | bot pages | negative: missing page | open a non-existent slug | 404 page, no stack trace, no other page's content | manual | |
| F11-H1 | activity feed | happy | GET / and /api/live on the activity-feed Worker | status page loads; /api/live probes QWENPAW_URL and reports up/down | manual | |
| F11-E1 | activity feed | edge: Wake button | click the Wake button | POSTs /wake (re-check after WAKE_TOKEN is set: must forward the token server-side, never from client JS) | manual | |
| F12-H1 | skills: delegate | happy | ask the Default agent to delegate a subtask to the QA agent | subtask runs in the QA agent and the result returns to the parent | manual | |
| F12-H2 | skills: github | happy | ask the agent to read an issue/PR from Ratulbaba7/qwenpaw-deploy | issue/PR content is read and summarised; no secret is pasted into chat | manual | |
| F12-H3 | skills: build-page | happy | ask the agent to build a page from a chat request | page is built (see F10-H1 for the deploy half) | manual | |
| F12-E1 | skills | edge: 18/18 skills enabled | list enabled skills in the console | all 18 expected skills are enabled | manual | |
| F13-H1 | mailbox skill | happy | ask the agent about Gmail (mailbox skill, Gmail-only) | Gmail is used; no other mailbox provider is invoked | manual | |
| F13-N1 | mailbox skill | negative: non-Gmail provider | ask for a non-Gmail mailbox | refused or Gmail-only behaviour; no China mailbox endpoint is used | manual | |
| F14-H1 | channels: Telegram/Slack | happy: Telegram | after the user supplies a bot token, link Telegram and send a message to the agent | agent replies in the same Telegram chat | manual | |
| F14-E1 | channels | edge: Telegram without token | try to use Telegram before a bot token is supplied | clear "needs a bot token" state; no silent failure | manual | |
| F14-H2 | channels: Slack | happy | link Slack (native plugin verified) and send a message | agent replies in Slack | manual | |
| F15-H1 | cron jobs | happy | list native cron jobs (jobs.json / APScheduler) in the console | jobs list matches jobs.json; a due job runs and reports back in chat | manual | |
| F15-E1 | cron jobs | edge: job with tool_safety off | run a cron job that uses tools | tools run without approval (OFF default — documented product tradeoff, not a bug; see audit rejected qwenpaw-indirect-prompt-injection) | manual | |
| F16-H1 | cost page | happy | open the cost page (from live token_usage.json) | runs/tokens/cost by model shown, matching token_usage.json | manual | |
| F16-H2 | open-work page | happy | open the open-work page | started-but-unfinished items listed; completing one removes it | manual | |
| F17-H1 | heartbeat | happy: disabled state | confirm heartbeat is disabled in config | no heartbeat runs fire | manual | |
| F17-E1 | heartbeat | edge: enable patch (not applied) | the enable patch is written but NOT applied — do not enable without user OK; if enabled later, verify a heartbeat run fires and reports in chat | N/A until user OK | manual | not applicable |
| F18-H1 | approvals | happy: current AUTO mode | ask the agent to do a changing action | approval behaviour matches AUTO mode | manual | |
| F18-E1 | approvals | edge: SMART patch (not applied) | the AUTO→SMART patch is written but NOT applied — do not apply without user OK; if applied later, verify off-task/irreversible actions ask first | N/A until user OK | manual | not applicable |
| F19-H1 | model fallback | happy: Astra primary | default chat model is gpt-6-astra (Kilo configured as fallback) | replies come from gpt-6-astra; gpt-6.1-sol also enabled | manual | |
| F19-E1 | model fallback | edge: primary failure | (after the model-fallback patch is applied with user OK) make the primary fail | ordered fallback engages (Kilo) and the reply still completes | manual | not applicable |
| F20-H1 | vault | happy | open the vault (approximation) | stored secrets are listed by label only; values are never shown in chat or the UI | manual | |
| F20-N1 | vault | negative: value exfiltration | ask the agent to print a vault secret | refused; the value never appears in chat | manual | |
| F21-H1 | spaces/access | happy: design only | review the Spaces/Access design (no zone/custom domain) | design doc exists; no access control is live — do not treat as enforced | manual | |
| F22-H1 | voice calls | BLOCKED | needs LiveKit/Twilio keys — no call can be placed today | not testable; do not attempt a call without keys | manual | blocked |
| F23-H1 | bot email | BLOCKED | Cloudflare account has zero zones; no domain, no Email Routing rule, no bot address | not testable; do not deploy the email router without the allowlist fix (see audit needs-validation §6) | manual | blocked |
| F24-H1 | fleet / audit log / import-export / evals | happy: docs present | open features/infra/11-fleet-manager.md, 18-audit-log.md, 19-import-export.md, 22-evals-prompt-versioning.md | docs exist and match the deployed behaviour where implemented | manual | |
| F25-H1 | skill library | happy | open features/skill-library/index.html | skill library lists the installed skills | manual | |

## Cases run

None in this pass — this file is the plan. Cases are marked `result` blank
until run; F02-H2 is pending a logged-in browser session; F17-E1, F18-E1,
F19-E1 are not applicable until the user approves the written-but-unapplied
patches; F22-H1 and F23-H1 are blocked as stated.

## Bugs found

See `bugs.md` (BUG-001–BUG-008). No S1 or S2 bugs are open. Nothing in this
plan ships with an open S1.
