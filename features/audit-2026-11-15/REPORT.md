# Security Audit Report — QwenPaw on InstaBox Free

**Run:** audit-2026-11-15 · **Repo:** Ratulbaba7/qwenpaw-deploy ·
**Source ref:** 094ba1e66 (Rakazo build 2026-11-15) + audit scaffolding ·
**Target:** QwenPaw v2.3.0 (Docker `agentscope/qwenpaw:v2.3.0` on InstaBox Free) fronted by
Cloudflare Pages proxy and Workers · **Profile:** standard (adapted — see §1) ·
**Date:** 2026-11-15 · **Prior runs:** none — first audit run for this repo

Companion files: `findings.json` (19 records, schema-validated),
`FINDINGS-DETAIL.md` (full detail for all 19), `NEEDS-VALIDATION.md` (the 6 open
leads), `coverage-ledger.json` (14 units, validator-passing),
`replica-test/test-plan.md` and `replica-test/bugs.md` (functional testing).

## 1. Run profile, scope, and execution policy

**Profile and scope.** Standard profile, scoped to the 12 paths in
`run-metadata.json`: the groupchat, board, and routines Workers; the
activity-feed Worker; the keepalive Worker; the Pages proxy (`_worker.js`);
bot-pages; the GitHub skill; infra scripts/evals; and the InstaBox
Docker/systemd deploy. No budget was set. This is a **partial pass over the
whole deployment, not an exhaustive audit**: QwenPaw's own upstream
application code was reviewed only where the deployed container's source was
read to answer a specific candidate (auth.py, skill scanner, cron executor);
no line-by-line review of the upstream codebase was performed.

**Execution-policy deviation (stated plainly).** The skill's default rule is
"sandboxed source-and-local-only; do not probe deployed endpoints." That rule
was **overridden for this run, for our own systems only, with the user's
explicit authorisation** (`run-metadata.json` execution policy: "live-own-systems-only:
curl probes against the user's own Workers/Pages/InstaBox/QwenPaw endpoints,
own test data only, clean up test data afterwards; no third-party targets, no
brute force, no destructive actions on user data"). Every live observation in
this report comes from the user's own Workers, Pages sites, InstaBox machine,
and QwenPaw console. No third-party target was probed, no token was guessed
or brute-forced, no user chat history, `.env`, or `auth.json` was read, and no
destructive action was taken on user data. Where a verifier deliberately did
not re-run a live step (to avoid re-polluting a reset thread, re-flooding, or
firing extra triggers), that is stated in the finding.

**Method — six phases.** (1) Reconnaissance: architecture map, trust
boundaries, and a 14-unit coverage ledger. (2) Coverage-led hunting waves
against those units, using the BugHunter hunt skills and the triage-validation
7-Question Gate. (3) Candidate validation: every candidate went to a fresh
verifier that re-read the cited source and independently re-ran the decisive
checks it could reproduce safely; the verifier's decision is the record in
`findings.json`. (4) Structured output: `findings.json` per
`report-schema.json`, validated with `validate-findings.cjs`. (5) Independent
record verification: **run by the coordinator after this report was drafted
(see §11 and FIXES.md).** The coordinator independently re-proved all 4
confirmed findings live and from source before fixing them: groupchat
thread readable/writable with no token and with a wrong token (200),
routines `/trigger` ungated in source plus the hunter's junk KV key still
present, keepalive `POST /wake` 200 with no token (`wake: null`), and
groupchat source containing zero rate-limit code. The records below are
the Phase 3 verifier records transcribed into schema shape (see §7 for
the transcription rules). (6) Target-neutral reporting: this file and its
companions, derived from the final records only.

**How to read the verdicts.** `confirmed` = independently demonstrated
boundary violation with a complete trace and observed result; only confirmed
records carry severity. `needs_validation` = source-grounded hypothesis whose
decisive fact is outside source/local observation; it has no severity and is
not a confirmed vulnerability. `rejected` = the candidate was disproved (or
fails the 7-Question Gate as a security finding); rejected records are kept so
future runs do not repeat the unsupported claim without changed evidence.
Rejected records are not findings and are not in the tables below except
where noted.

## 2. Security posture summary

The deployment is a single-user personal agent behind a public proxy, and the
audit's shape reflects that: **one high-severity issue, one medium, two low,
and no critical**. The high issue is the group-chat Worker running with no
token at all — anyone on the internet can read, write, impersonate agents in,
and wipe the shared thread. The medium issue is the routines Worker's
unauthenticated `/trigger`, which lets anyone queue stored prompts and force
origin wake probes. The two lows are the same "token unset" pattern on the
keepalive Worker (probe-forcing only, because the InstaBox API key is also
unset) and the group chat's missing rate limit (message eviction, not data
loss). The recurring root cause is **optional token gates left unset at
deploy time** (GROUPCHAT_TOKEN, ROUTINE_WEBHOOK_TOKEN, WAKE_TOKEN), not a
code defect in the gates themselves — the fail-closed pattern already exists
in the same files and is the fix. The board is the best-defended surface: its
shared key gates every `/api/*` route before routing, which is why all seven
board candidates ended needs-validation or rejected rather than confirmed.
The Pages proxy's redirect-rewrite gap has no producer in the deployed
QwenPaw source, and the two prompt-injection candidates fail because the
relay is not installed, the email router is not deployed, and the console
already ships a prompt-level instruction-vs-data boundary. Six leads remain
open (no severity) and need owner-held facts — above all, whether the board
key is long and random, and whether query-string tokens actually land in any
log.

## 3. Confirmed findings

| Severity | Title | Affected boundary | Observed result |
| --- | --- | --- | --- |
| HIGH | Unauthenticated anyone can read, write, impersonate agents in, and reset the shared group-chat thread (`groupchat-open-thread`) | Internet → groupchat Worker `/thread/*` | `GET /` returned `auth_required:false`; `GET /thread` with a wrong token returned HTTP 200 with the full thread JSON |
| MEDIUM | Unauthenticated POST /trigger queues stored prompts, forces origin wake probes, and writes never-expiring KV keys (`workers-routines-unauth-trigger`) | Internet → routines Worker `/trigger` | Hunter trigger stored as pending (id `trig-1794687781812`); `/api/history` showed the forced probe (qwenpaw up, HTTP 200); 0 `expirationTtl` matches in source |
| LOW | Unauthenticated POST /wake can force probes but cannot trigger an InstaBox API wake — INSTABOX_API_KEY is unset (`workers-keepalive-unauth-wake`) | Internet → keepalive Worker `/wake`, `/ping` | Unauthenticated `POST /wake` returned HTTP 200, status up, `wake:null`; Cloudflare secrets list for the Worker is empty |
| LOW | No rate limiting: unauthenticated flooding evicts legitimate messages and burns Worker quota (`groupchat-no-rate-limit-flood`) | Internet → groupchat Worker `/thread/message` | No rate-limit code in source; hunter's 200 posts in ~27s reached seq 213 with seqs 1–13 evicted; verifier confirmed the reset state (seq 0) |

### 3.1 HIGH — Unauthenticated anyone can read, write, impersonate agents in, and reset the shared group-chat thread

- **Fingerprint:** `groupchat-open-thread`
- **Source:** `features/groupchat/worker/src/index.js` — `checkToken()` line 132,
  `GET /` line 162, `GET /thread` line 177, `POST /thread/start` line 185,
  `POST /thread/message` line 200, `POST /thread/reset` line 254.
- **Lower-trust principal:** any unauthenticated internet caller who knows the
  public groupchat Worker URL. **Affected resource:** the single shared
  group-chat thread (Durable Object SQLite store).
- **Reproduction (target-neutral, bounded):** `GET /` on the Worker and confirm
  `auth_required:false`; `GET /thread` with a wrong `X-Groupchat-Token` header
  and confirm HTTP 200 with the full thread JSON. Do not POST/start/message/
  reset during verification: write, impersonation, and reset success rest on
  the source trace plus the hunter's live POST evidence, which the verifier
  did not re-run to avoid re-polluting the reset thread.
- **Conditions:** `GROUPCHAT_TOKEN` is unset on the live Worker, so
  `checkToken()` returns true for every request. The relay is not installed,
  so fake agent turns do not reach QwenPaw — there is no QwenPaw account
  takeover or code execution from this finding.
- **Actual result:** `GET /` returned `auth_required:false`. `GET /thread`
  with a wrong token returned HTTP 200 with the full thread JSON
  (`id groupchat-mwguv0lq`, status open, round 1, `max_rounds` 6, seq 0,
  messages `[]`).
- **Impact and priority rationale:** HIGH, not critical — an unauthenticated
  caller fully defeats the only access control on the thread (read the full
  thread, post as a user or as either agent subject only to turn-taking,
  start new rounds, wipe the thread with `{confirm:true}`), but the blast
  radius stops at the auxiliary thread because the relay is not installed.
  Fix first: it is the only confirmed finding with a fully open write path.
- **Smallest source fix:** set the token with `wrangler secret put
  GROUPCHAT_TOKEN` on the qwenpaw-groupchat Worker, then verify `GET /`
  reports `auth_required:true` and unauthenticated/wrong-token `GET /thread`
  and `POST /thread/message` return 401. Side effect: the owner and the relay
  (when installed) must send `X-Groupchat-Token` on every thread request;
  setting the secret is a user/parent action via wrangler or the Cloudflare API.

### 3.2 MEDIUM — Unauthenticated POST /trigger queues stored prompts, forces origin wake probes, and writes never-expiring KV keys

- **Fingerprint:** `workers-routines-unauth-trigger`
- **Source:** `features/routines/worker/src/index.js` — `/trigger` handler
  lines 206–226, rate-limit read line 209, probe line 214, pending put
  line 222, last-trigger put line 223. Contrast `POST /api/routines`
  lines 186–190 (fail-closes 503 when the token is unset, 401 on mismatch).
- **Lower-trust principal:** any unauthenticated internet caller.
  **Affected resources:** the routines KV store (pending prompts, history) and
  the InstaBox machine's wake/idle budget.
- **Reproduction (bounded):** send an unauthenticated `POST /trigger` with a
  prompt body (the hunter's trigger used id `trig-1794687781812`); observe
  `GET /` and `/api/history` for the pending entry and the forced probe
  result. No additional `POST /trigger` was fired during verification.
- **Conditions:** `ROUTINE_WEBHOOK_TOKEN` is unset and `/trigger` has no token
  check. Pending KV entries have no `expirationTtl` and there is no
  cleanup/pruning code; history is capped at 50 but pending keys are not.
  The only throttle is a single global 1 trigger/minute timestamp shared by
  all callers, so one caller can also 429-block the legitimate owner for a
  minute after each trigger.
- **Actual result:** the live pending table showed the hunter's trigger
  (2026-11-14T20:23:02.325Z, id `trig-1794687781812`, prompt stored as
  pending) and `/api/history` showed the forced probe (qwenpaw up, HTTP 200,
  note "manual trigger trig-1794687781812 recorded as pending", deliveredBy
  "none — pending, needs console / native cron job"). Source grep confirms 0
  `expirationTtl` matches. The stored prompt is not executed in QwenPaw
  (pending only, by design) and is HTML-escaped when rendered, so no
  stored-XSS or code execution was demonstrated.
- **Impact and priority rationale:** MEDIUM, not high — public and
  unauthenticated, each accepted trigger forces an origin wake probe (pushing
  the InstaBox Free machine toward its max-run/cooldown) and pending keys
  accumulate forever, but prompts are never executed and abuse is capped at
  1 trigger/minute. Fix second, together with §3.1: same "set the token"
  pattern.
- **Smallest source fix:** gate `POST /trigger` behind
  `ROUTINE_WEBHOOK_TOKEN` using the exact pattern already used by
  `POST /api/routines` in the same file (503 fail-closed when the secret is
  unset, 401 on `X-Routine-Token` mismatch). Add `expirationTtl` (e.g. 7 days
  / 604800s) to the pending KV put at line 222, and cap/prune stale pending
  keys. Note: the old junk key `trig-1794687781812` should be deleted from KV
  manually, since the TTL fix is not retroactive. TTL alone does not stop
  wake abuse — the token gate is the required fix. Until the secret is set
  the endpoint fail-closes (503), so set the secret before or with the deploy.

### 3.3 LOW — Unauthenticated POST /wake can force probes but cannot trigger an InstaBox API wake

- **Fingerprint:** `workers-keepalive-unauth-wake`
- **Source:** `worker/src/index.js` — `/wake` handler line 204, optional gate
  lines 205–208, probe line 209, API-wake condition line 211, gap check
  line 214, `callInstaBoxWake` lines 147–160 (fetch lines 150–153), cron gate
  line 166, `GET /ping` lines 198–202 (no token check at all).
- **Lower-trust principal:** any unauthenticated internet caller.
  **Affected resources:** Worker/KV status state and the InstaBox machine's
  wake/idle budget.
- **Reproduction (bounded):** unauthenticated `POST /wake` with an empty JSON
  body; `GET /status` and confirm the manual-wake source and `wake:null`.
  Do not force downtime to test the API-wake arm.
- **Conditions:** `WAKE_TOKEN` is unset, so the optional gate is skipped;
  `INSTABOX_API_KEY` is also unset (Cloudflare secrets list for
  qwenpaw-keepalive is empty), so the API-wake condition can never be true.
  A probe GET to the public QwenPaw URL wakes a paused InstaBox box on
  request by InstaBox design, so forced probes indirectly wake the machine.
- **Actual result:** unauthenticated `POST /wake` returned HTTP 200 with
  status up, HTTP 200, source `manual-wake`, `wake:null`. The high-impact arm
  (calling the InstaBox wake API with the stored key) is unreachable in the
  deployed configuration. **Warning:** the condition flips if the owner ever
  sets `INSTABOX_API_KEY` without also setting `WAKE_TOKEN` — then an
  unauthenticated `POST /wake` during an offline/waking window, more than
  10 min after the last API wake, would call the InstaBox wake API.
- **Impact and priority rationale:** LOW — probe-forcing and KV status writes
  only, no API wake possible today. Fix with the other token gates, before
  ever setting `INSTABOX_API_KEY`.
- **Smallest source fix:** set `WAKE_TOKEN` as a Worker secret and, if the
  API-wake fallback is ever wanted, set `INSTABOX_API_KEY` only together with
  `WAKE_TOKEN`. Side effects, from the verifier: (1) the activity-feed
  Worker's Wake button (`features/infra/workers/activity-feed/index.js:85`)
  POSTs `/wake` with no token and will start returning 401 — fix it
  server-side by storing `WAKE_TOKEN` as that Worker's own secret and
  forwarding it as `X-Wake-Token`, never embedding the token in client-side
  JS. (2) The Pages status page Wake button calls `/ping`, not `/wake`, so it
  is unaffected by gating `/wake` — but `/ping` has no auth check at all, so
  gating only `/wake` leaves unauthenticated probe-forcing open; either gate
  `/ping` the same way (breaking the public status-page Wake button unless it
  is proxied server-side) or explicitly accept `/ping` as the intended public
  wake path and document it. (3) Do not put `WAKE_TOKEN` in `wrangler.toml`
  `[vars]` or any static Pages asset — it would be public.

### 3.4 LOW — No rate limiting: unauthenticated flooding evicts legitimate messages and burns Worker quota

- **Fingerprint:** `groupchat-no-rate-limit-flood`
- **Source:** `features/groupchat/worker/src/index.js` — `POST /thread/message`
  line 199, `seq += 1` and push line 225, eviction lines 233–234,
  `MAX_MESSAGES=200` line 65.
- **Lower-trust principal:** any unauthenticated caller (while
  `GROUPCHAT_TOKEN` is unset) or any token holder. **Affected resource:** the
  shared thread's message history.
- **Reproduction (bounded):** confirm from source that the handler has no
  rate, count, window, or per-IP check; observe the live thread state with an
  unauthenticated `GET /thread` (seq 0, messages `[]` after reset). Do not
  re-flood: the flood was demonstrated by the hunter and was not re-run by the
  verifier.
- **Conditions:** `GROUPCHAT_TOKEN` is unset live, so the flood path is
  currently unauthenticated; setting the token fixes unauthenticated posting
  but **not** flooding by a token holder. This is an independent finding — do
  not fold it into `groupchat-open-thread`.
- **Actual result:** source shows no rate-limit code (only a comment about the
  100,000 requests/day free quota) and `MAX_MESSAGES=200` with
  `slice(-MAX_MESSAGES)` eviction. The hunter's 200 posts in ~27s reached
  seq 213 with seqs 1–13 evicted. The verifier confirmed the reset live state
  (seq 0, 0 messages) and that the token is still unset live.
- **Impact and priority rationale:** LOW (downgraded from medium by the
  verifier) — 200 posts is trivial against the 100,000 requests/day Free
  quota (about 100,000 requests would take about 3.7 hours of sustained
  flooding at the hunter's ~7.4 req/s); eviction affects only this one
  auxiliary thread, agent posts are already turn/round-limited, user posts do
  not inject into QwenPaw directly, and no data beyond thread history is lost.
- **Smallest source fix:** add an in-Worker per-IP (and per-author) counter in
  the Durable Object — e.g. N posts per minute per IP/author, stored in DO
  storage, returning 429 with `Retry-After` — and on cap overflow either
  reject with 429 or return an explicit eviction notice/count instead of
  silently slicing. The candidate's alternative claim that Cloudflare Rate
  Limiting rules may need a paid plan for the needed granularity could not be
  verified from any comment in `features/groupchat/` — do not rely on it;
  prefer the in-DO counter.

## 4. Needs validation (no severity — open leads, not confirmed vulnerabilities)

| Title | Blocker (one line) |
| --- | --- |
| No rate limiting or lockout on BOARD_TOKEN authentication attempts (`board-no-rate-limit-auth`) | BOARD_TOKEN length/entropy is unknown — the sole deciding fact |
| Malformed percent-encoded ticket id throws decodeURIComponent and returns 500 (`board-decode-uri-500`) | Live authenticated test needs the board key (not available to the verifier) |
| GROUPCHAT_TOKEN is accepted via ?token= query parameter (`groupchat-token-in-query`) | GROUPCHAT_TOKEN is currently unset, so ?token= authentication cannot be demonstrated live without first setting a token |
| deploy-page.py follows symlinks out of the source dir (`infra-deploy-page-symlink-escape`) | The planting step is unproven; target-file readability from the deploy context is unverified |
| Email router would deliver any sender's email verbatim into the agent if ever deployed (`infra-email-prompt-injection`) | Worker is undeployed: no domain/zone, no Email Routing rule, no secrets, no wrangler.toml |
| Bearer token accepted via ?token= query parameter on every API request (`qwenpaw-query-token-leak`) | No demonstrated leak sink; SPA dependency on ?token= not fully scoped; fix needs a rebuild |

Full trace, evidence, blockers, and exact local/deployment validation plans:
`NEEDS-VALIDATION.md`.

## 5. What was tested and passed

These are positive results from the verifier records — boundaries that held
when tested. They are not findings, and they do not imply the rest is fine.

- **Board auth gate holds.** Every `/api/*` route returns 401 without the
  board key, before any routing or decoding (verified live for well-formed,
  invalid-UTF-8, and nonexistent ids). `safeEqual` is a constant-time compare;
  the only flaw found in it is the unproven length branch (rejected).
- **Routines write path fail-closes.** `POST /api/routines` returns 503 when
  `ROUTINE_WEBHOOK_TOKEN` is unset and 401 on mismatch — the pattern the
  `/trigger` fix should copy.
- **Groupchat turn-taking holds.** Agent posts require a participant who is
  `next_agent` (lines 217–221); an attacker can only plant `role=user` text,
  and agent posts are capped by the 6-round limit.
- **No Location producer in QwenPaw.** Exhaustive source inspection of the
  deployed QwenPaw v2.3.0 found zero code that emits a `Location` header
  (no `RedirectResponse`, no `redirect()` response, no `Location` set; OAuth
  flows return JSON `authorize_url` / `HTMLResponse` instead), and 7 live
  unauthenticated Pages probes by the verifier returned no `Location` (the
  hunter had run 3 earlier probes with the same result, per the verifier's
  reason).
- **Cron API is not reachable unauthenticated.** `GET /api/cron/jobs`
  returns 401 on both the Pages proxy and the direct InstaBox URL.
- **Routines prompts are escaped.** Pending prompts render through `esc()`
  (lines 50–55), which escapes `< > & " '`; no stored-XSS was demonstrated.
- **Board `esc()` and per-field caps.** The board UI escapes output and
  per-field caps exist (title 200, description 5000, max 50 comments × 1000
  chars); no XSS candidate survived on the board.
- **Email router is not live.** The worker is undeployed, the Cloudflare
  account has zero zones, no Email Routing rule can target it, no
  `wrangler.toml` exists for it, and no real bot email address exists in the
  repo (only the placeholder `bot@<domain>`).
- **Keepalive API-wake arm is unreachable today.** The Cloudflare secrets
  list for qwenpaw-keepalive is empty, so `INSTABOX_API_KEY` is unset and the
  API-wake condition can never be true — confirmed via the Cloudflare API,
  not assumed.

## 6. Known-fixed finding (fixed before this report — not re-tested)

**QwenPaw Astra stream stalls — FIXED 2026-11-15 01:59 IST by the parent
agent, before this report was written.** When the user asked the console to
open x.com and search 0xsatwik, the QwenPaw log showed 4×
`StreamIdleTimeoutError` (xingchiapi `gpt-6-astra` produced no content for
30s) and the reply stuck loading. Astra itself was alive (models list and
chat test both worked, just slow at ~28s). Fix applied:
`QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT=120` added to
`/data/home/qwenpaw/.env`, container recreated via `docker compose up -d`,
verified healthy with env 120 inside the container, Pages 200, Worker up;
`.env.example` updated and pushed to GitHub. **Re-test of the console + Astra
reply path with the new timeout is still pending a logged-in browser session —
it is marked as such here and is not claimed as tested.** (See
`replica-test/test-plan.md` flow F01/F02.)

## 7. Honest limits, transcription notes, and coverage

**Coverage.** 14 ledger units: 6 `candidate`, 5 `covered`, 3 `planned`
(`validate-coverage-ledger.cjs` PASS). The 3 `planned` units had no verifier
record linked to them and no coverage is claimed for them: board ticket text
into HTML UI / QwenPaw task text (`esc()` output encoding), the activity-feed
`/api/live` probe, and the InstaBox Docker/systemd + deploy-repo secrets
handling. The `candidate` units carry the 4 confirmed + 6 needs-validation
fingerprints; the `covered` units were reviewed and every linked candidate
was rejected. A `quick`/scoped/partial characterisation applies: this run
covers the Rakazo-built Workers, the Pages proxy, the keepalive Worker, and
the deploy scaffolding — not a line-by-line review of upstream QwenPaw.

**Console browser-tools coverage note.** QwenPaw's browser tools are
headless-only — there is no live screen to watch — and x.com often blocks
bots, so x.com search via the console browser is unreliable by nature. That
unreliability is environmental, not a defect in the console, and it bounds
what any re-test of the Astra stream fix via x.com can prove (see §6 and
`replica-test/test-plan.md` flow F03).

**Phase 5 — run by the coordinator (correction to the note below as first
drafted).** After this report was drafted, the coordinator independently
re-verified all 4 confirmed findings live and from source before fixing
them (see §11 / FIXES.md for the evidence). The "not run" statement in the
first draft is superseded.

**Record-integrity notes (read before relying on two records).** Two verifier
records (`workers-keepalive-unauth-wake`, `qwenpaw-query-token-leak`) carry a
`_recovery_note`: the verifier's session transcript truncated its final
message and the record was repaired by appending one closing brace. Their
decision, title, description, verdict, trace, and evidence are intact as the
verifier wrote them; a trailing field (e.g. `reason`) may have been cut off.
In addition, one evidence command in `qwenpaw-query-token-leak` is itself
truncated mid-command in the record as received; it is quoted verbatim in
`FINDINGS-DETAIL.md` and flagged there.

**How the verifier records were transcribed into `findings.json`.** The
records do not use the schema's shapes, so the following faithful mappings
were applied and nothing was silently dropped:

- Trace items `{step, path, line, what}` became `{kind, file, line, scope,
  description}` with `step → kind`, `path → file`, `what → description`,
  and `scope` derived from the "what" text (text before the first em dash,
  truncated at ~80 chars). The schema allows exactly one sink as the last
  trace entry and only `propagation` in the middle, so intermediate "sink"
  steps were relabelled `propagation` with their content unchanged.
- Three records had parallel or out-of-order mini-traces and were linearised
  without dropping any entry: `proxy-open-redirect-rewrite-gap` (definition
  → call site → gap line), `qwenpaw-indirect-prompt-injection` (cron executor
  moved to the final sink), `board-business-logic-quirks` (auth gate →
  follow_up coercion → mark-sent → PATCH → re-stamp → persist). The original
  order and wording are preserved in `FINDINGS-DETAIL.md`.
- Paths were mapped to safe repo-relative form: `~/workspace/qwenpaw-deploy/`
  prefixes stripped; container-absolute paths under `/app/src/qwenpaw/...`
  and `/app/working/...` mapped to `qwenpaw/...` and `working/...` (container
  root stripped, full container path preserved in the trace description).
- Evidence items `{command, output}` became `{file, line, description}` with
  file = the record's primary source file, line = the sink trace line, and
  description = the verifier's command and output quoted verbatim. The
  command/output text itself names the exact files and lines the verifier
  used.
- Fields the schema forbids per verdict were stripped from `findings.json`
  (e.g. `remediation`, `validation_plan`, `conditions`, `confidence` on
  needs_validation/rejected records; bare-string `severity`/`confidence` on
  confirmed records). Their content is preserved in the prose reports.
- Fields the schema requires but the records lack were built from the
  record's own words: `root_cause`, `intended_behavior`, and `execution` for
  confirmed records (from description / conditions / remediation / evidence),
  and `claimed_root_cause` for needs_validation/rejected records (from title
  and description). `severity` objects for confirmed records use the
  record's overall severity string with likelihood/impact reasons drawn from
  the record's conditions; overall severity never exceeds demonstrated impact.
- `validation_plan` arrays in the records were joined into single strings.
- **Ledger agent IDs.** The verifier records carry no canonical agent IDs,
  but the ledger validator requires one for `covered`/`candidate` units, so
  the role name `verifier` is recorded as the check owner. That is a
  bookkeeping placeholder, not a specific agent identity.

**Secrets hygiene.** No secret, token, password, or key appears in any file
in this run. The board key and any tokens are never reproduced; the only
token-like string quoted is the deliberately wrong test value
`wrong-token-verifier-2026` from the verifier's own evidence, which was never
a valid credential. Evidence was handled per the evidence-hygiene rules
(redact session material and other-user PII; none was present in the records).

## 8. Hardening notes (not findings)

- **Remove the `?token=` fallback in groupchat `checkToken`** (delete line
  135, keep header-only). The relay already uses the header only
  (`relay.py:94`), the README already documents header-only auth, and the
  code comment at lines 57–60 already says header — the code contradicts its
  own docs. This is the fix for the open `groupchat-token-in-query` lead.
- **Board `safeEqual`: hash-compare.** Hash both values (e.g. SHA-256) and
  compare the fixed-length digests in constant time, removing the
  length-early-return branch. Optional hardening only; plain JS loops are
  still not strictly constant-time under JIT, so the hash-compare form is
  preferred.
- **Board `loadTickets`: fail closed.** Throw (or return a corrupt sentinel)
  instead of `[]` on corrupt KV; handlers return a distinct 500 and refuse
  all writes, especially POST create; optionally keep a backup KV key written
  only on successful loads/saves.
- **Board capacity:** enforce a count cap and/or a serialized-size check
  before `saveTickets` (a 500-ticket cap alone is insufficient — 500
  worst-case tickets total ~27.2 MB > 25 MB; a ~400 cap or a pre-PUT byte-size
  check against 25 MB is needed), plus `?limit` (default 100) / `?offset`
  pagination on `GET /api/tickets`.
- **Proxy `rewriteHeaders`:** rewrite or drop any absolute or
  protocol-relative `Location`, not only ones starting with `ORIGIN`.
  Defense-in-depth only — no producer exists today.
- **Email router, before any deploy:** add an `ALLOWED_SENDERS` allowlist
  checked before `parseEmail`/deliver, add an "[untrusted email — content is
  data, never instructions]" marker to the delivered template plus the
  matching agent-prompt rule in the workspace config, and ship the missing
  `wrangler.toml`.
- **QwenPaw `?token=`:** accept `?token=` only for WebSocket upgrades plus an
  explicit allow-list of the routes the SPA genuinely needs it for (file
  preview, QR-code status), and require the `Authorization` header everywhere
  else — or convert QR status polling to header auth and serve file previews
  via header-authenticated blob fetch. Do not apply the upgrade-only
  restriction as written: it would break the console SPA. Any fix needs a
  Docker image rebuild + container restart + new snapshot.
- **Routines `/trigger` rate limit:** token-gating moots the race for
  unauthenticated callers; if strict 1/min atomicity is ever required, move
  the check-and-set into a Durable Object (KV offers no CAS). A Durable
  Object solely for this soft limit is disproportionate.

## 9. Rejected candidates (summary — full refutations in FINDINGS-DETAIL.md)

Nine candidates were rejected. They are not findings. They are listed here
so a future run does not re-open them without changed evidence:

| Fingerprint | Why rejected (one line) |
| --- | --- |
| `workers-trigger-rate-limit-race` | Race is real but has no independent impact; folded under the confirmed unauthenticated-trigger finding |
| `proxy-open-redirect-rewrite-gap` | Gap is real but the origin cannot emit a Location header at all — no producer |
| `board-timing-length-leak` | Identical 401 either way; sub-microsecond timing signal vs millisecond edge jitter, no measurement |
| `board-kv-race-lost-update` | Real reliability defect, but owner-only; key holder already has full delete/overwrite power |
| `board-unbounded-board-growth` | Capacity note only; growth requires the owner-held key, board is empty |
| `board-corrupt-kv-silent-empty` | No realistic trigger; sole writer always writes valid JSON via an atomic KV put |
| `board-business-logic-quirks` | Owner-only semantics confusion; re-filed as 3 functional bugs (S3/S3/S4) in `replica-test/bugs.md` |
| `groupchat-injection-relay-latent` | Relay not installed (no sink); verbatim delivery is documented intended behaviour |
| `qwenpaw-indirect-prompt-injection` | No attacker, no entry point, no demonstrated effect; prompt-level boundary already ships |

## 10. Recommended fix order

1. Set `GROUPCHAT_TOKEN` (fixes HIGH `groupchat-open-thread`; also closes
   the unauthenticated planting path for the latent relay finding).
2. Gate routines `POST /trigger` behind `ROUTINE_WEBHOOK_TOKEN` + add the
   pending-entry TTL and delete the old junk key `trig-1794687781812` (fixes
   MEDIUM; moots the rate-limit race).
3. Set `WAKE_TOKEN` (and fix the activity-feed Wake button server-side);
   decide and document the `/ping` public-wake question (fixes LOW keepalive;
   do this before ever setting `INSTABOX_API_KEY`).
4. Add the in-DO rate limit + explicit eviction behaviour to groupchat
   (fixes LOW flood; survives a token holder).
5. Work the `NEEDS-VALIDATION.md` leads in order: board-key entropy check,
   groupchat `?token=` removal, board decode-uri 400 fix, deploy-page
   symlink guard, qwenpaw `?token=` scoping, email-router allowlist before
   any deploy.
6. Re-test the Astra stream fix (§6) in a logged-in browser session.

## 11. Fix pass (after verification — 2026-11-15, full log in FIXES.md)

All 4 confirmed findings were fixed one at a time and live re-tested by
the coordinator; 0 container restarts were used (all Worker/Pages
deploys). Three needs-validation leads and four functional bugs were fixed
in the same pass. The verdicts in §§3–4 and `findings.json` are the
audit-time verdicts and are left as recorded; this section states what
changed afterwards.

- **HIGH `groupchat-open-thread`** — FIXED. `GROUPCHAT_TOKEN` set;
  401s without/wrong token, header-only auth (`?token=` removed),
  live-verified. Token value delivered to the user only.
- **MEDIUM `workers-routines-unauth-trigger`** — FIXED. `/trigger`
  gated behind `ROUTINE_WEBHOOK_TOKEN` (503 fail-closed → 401/401/202),
  pending entries expire after 7 days (verified: expiration exactly
  now + 7.0 days), capped at newest 20; hunter junk KV key deleted.
- **LOW `workers-keepalive-unauth-wake`** — FIXED. `/wake` gated behind
  `WAKE_TOKEN` (503 fail-closed → 401/401/200); `GET /ping` documented
  as the public wake path; activity-feed Wake button now calls `/ping`.
  `INSTABOX_API_KEY` was not set.
- **LOW `groupchat-no-rate-limit-flood`** — FIXED. 30 writes/min/IP in
  Durable Object storage (an in-memory counter was tried first and
  live-proved useless — hibernating DOs reset it); single-connection
  flood: 30 stored, 5× 429 with `Retry-After`; eviction now surfaced as
  `evicted_oldest`.
- **Needs-validation, resolved by fix:** `groupchat-token-in-query`
  (`?token=` removed, 401 live-verified),
  `board-decode-uri-500` (400 + generic 500, harness-verified),
  `infra-deploy-page-symlink-escape` (symlinks skipped + realpath check,
  regression-tested with dummy data).
- **Functional bugs fixed:** BUG-001–BUG-004 (board `follow_up` strict
  boolean, idempotent mark-sent, empty PATCH 400, decode 400), plus the
  `safeEqual` length branch and the proxy Location rewrite (see FIXES.md).
- **Still open:** `board-no-rate-limit-auth` (needs the key holder to
  confirm BOARD_TOKEN entropy), `qwenpaw-query-token-leak` (needs a
  QwenPaw auth-code change + logged-in regression test),
  `infra-email-prompt-injection` (allowlist before any deploy; router
  still undeployed), board KV-race / growth-cap (needs a Durable
  Object / D1 migration decision). Board authenticated CRUD re-test
  needs the board key holder. Astra stream-fix re-test needs a logged-in
  browser session.
