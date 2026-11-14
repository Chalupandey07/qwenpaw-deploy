# Audit fixes — applied and live-tested 2026-11-15

All fixes below were applied by the audit coordinator after fresh-verifier
confirmation, one at a time, with a live re-test after each. Backups of
every file before its fix are in `fix-backups/`. No feature was deleted,
no auth was disabled, `working.secret/auth.json` / `.env` secrets / user
chat history were never touched. Container restarts used by this fix pass:
**0** (all fixes are Worker/Pages deploys; the one container restart on
2026-11-15 was the parent agent's Astra stream-timeout fix, recorded in
REPORT.md §6).

New shared secrets (GROUPCHAT_TOKEN, ROUTINE_WEBHOOK_TOKEN, WAKE_TOKEN)
are 64-hex-char random values. The values were delivered to the user only
— never in git, never in memory. Rotate via `npx wrangler secret put
<NAME>` or the Cloudflare API secrets endpoint.

## FIX-1 — groupchat: token set, header-only auth, write rate limit (HIGH + LOW)

Findings: `groupchat-open-thread` (HIGH), `groupchat-no-rate-limit-flood`
(LOW), `groupchat-token-in-query` (needs_validation, fixed with it).

- `features/groupchat/worker/src/index.js`
  - `GROUPCHAT_TOKEN` secret set on the live Worker. Every endpoint
    except `GET /` now requires header `X-Groupchat-Token`.
  - `?token=` query fallback REMOVED from `checkToken()` — header only.
    The relay already sends the header; no in-repo caller used `?token=`.
  - Per-IP write rate limit: 30 mutating writes/min/IP on
    `POST /thread/start|message|reset`, 429 + `Retry-After` beyond that.
    Counters persist in Durable Object **storage**, not memory — the
    first attempt used an in-memory `Map` and live-testing proved it
    never trips: SQLite-backed objects hibernate between requests and a
    fresh instance (empty Map) is constructed per wake-up. Storage-backed
    counters fixed it. Reads (`GET /thread`) are never limited.
  - Thread-cap eviction is now surfaced: a message POST that drops old
    messages returns `evicted_oldest: N` instead of silently slicing.
  - `GET /` advertises `rate_limit` and `auth_required`.
- `features/groupchat/worker/deploy-groupchat.py` — redeploys no longer
  send the `new_sqlite_classes` migration block (the API rejects it with
  error 10074 once the class has live objects; this blocked the first
  redeploy attempt). `deploy --with-migration` keeps it for first-time
  deploys. No token is ever passed via argv by this script's callers.
- Docs: `features/groupchat/README.md` auth + deploy sections,
  `features/improvements/PROPOSALS.md` P1 marked done.

Live re-test (2026-11-15 ~20:36–20:39 UTC):
- `GET /` → `auth_required: true`, rate limit advertised.
- `GET /thread` no token / wrong token / `?token=<real>` → 401, 401, 401.
- Header token → 200; test message POST → 200, `seq: 1`; wrong header → 401.
- Flood: 35 rapid POSTs from separate processes → all 200 (each process
  egressed from a different NAT IP, so each got its own bucket — see note
  below). Same 35 POSTs over ONE keep-alive connection → 30 stored,
  5× 429 with `retry_after_seconds: 54` and a `Retry-After` header.
- Local node harness (fake DO storage): 30× 200 then 5× 429 with
  `retry_after_seconds: 60`; `?token=` GET → 401; eviction at the 200 cap
  reported `evicted_oldest: 1`, first kept `seq: 41` after 240 posts.
- Thread reset clean afterwards: `seq: 0`, 0 messages, still 401
  without a token.

Note: per-IP limiting is a flood brake, not access control — an attacker
who can rotate IPs can get a fresh 30/min bucket per IP. The token gate
is the durable protection; the limit stops one IP from evicting the
thread in seconds, which is what the finding demonstrated.

## FIX-2 — routines: /trigger gated, pending TTL + cap, junk key deleted (MEDIUM)

Finding: `workers-routines-unauth-trigger` (MEDIUM).

- `features/routines/worker/src/index.js`
  - `POST /trigger` now requires header `X-Routine-Token` matching the
    `ROUTINE_WEBHOOK_TOKEN` secret (same token as `POST /api/routines`).
    Fail-closed 503 when the secret is unset; 401 on mismatch. Header
    only, never `?token=`.
  - Pending KV puts now carry `{ expirationTtl: 7 days }`; a
    `prunePending()` step keeps at most the newest 20 pending entries.
- The hunter's junk key `routines:pending:trig-1794687781812` (confirmed
  still present in Phase 5) was deleted via the KV API.
- Docs: `features/routines/README.md` hardening section marked done.

Live re-test (2026-11-15 ~20:41–20:42 UTC):
- Deploy → `POST /trigger` no token → 503 fail-closed (secret unset).
- Secret set → no token 401, wrong token 401, correct token → 202 with
  a pending entry.
- KV list showed the new pending key with `expiration` exactly
  now + 7.0 days. Test entry deleted afterwards; pending count 0.
- Cron schedules intact (`*/30 * * * *`, `30 1 * * *`); `GET /api/status` 200.

## FIX-3 — keepalive: /wake gated, Wake button moved to /ping (LOW)

Finding: `workers-keepalive-unauth-wake` (LOW).

- `worker/src/index.js` (`qwenpaw-keepalive`)
  - `POST /wake` now requires header `X-Wake-Token` matching the
    `WAKE_TOKEN` secret. Fail-closed 503 when unset; 401 on mismatch.
    The `?token=` fallback was removed (header only).
  - `GET /ping` stays the public wake path by design: it probes the
    public console URL, which wakes a paused box on request. This is
    the documented decision, not an oversight — gating `/ping` would
    break the status page's wake path, and any public request wakes the
    box anyway.
  - `INSTABOX_API_KEY` was NOT set (and must never be set without
    `WAKE_TOKEN`): the API-wake arm stays unreachable.
- `features/infra/workers/activity-feed/index.js` — the Wake button now
  calls keepalive `GET /ping` instead of `POST /wake`, so it keeps
  working with no token in client-side JS.

Live re-test (2026-11-15 ~20:43 UTC):
- Deploy → `POST /wake` no token → 503 fail-closed; `GET /ping` → 200.
- Secret set → no token 401, wrong token 401, `?token=<real>` 401,
  header token → 200 (`wake: null`, status up).
- One no-token request returned 503 ~2s after the secret was set
  (secret propagation lag to that edge); re-test seconds later → 401.
- Cron `*/5 * * * *` intact; `/status` 200; activity page 200 with the
  Wake button calling `/ping`.

## FIX-4 — Pages proxy: Location rewrite hardened + framing headers

Finding: `proxy-open-redirect-rewrite-gap` (rejected as a vulnerability —
QwenPaw emits no Location headers — but the code gap was real).

- `pages/public/_worker.js`
  - Protocol-relative Locations (`//host/path`) pointing at the origin
    host are rewritten to Pages; foreign protocol-relative or absolute
    Locations are dropped instead of passed through. Relative Locations
    pass through unchanged. Origin-absolute rewrites unchanged.
  - Proxied HTML responses now carry `X-Frame-Options: SAMEORIGIN` and
    `Content-Security-Policy: frame-ancestors 'self'`; same headers added
    to the waking/cooldown pages. JSON/API responses are untouched.
- Deployed to both Pages projects (`qwenpawx`, `qwenpaw-frontend`).

Verification:
- Local node harness with stubbed origin fetch (8 cases): origin-absolute
  → rewritten; origin protocol-relative → rewritten; foreign
  protocol-relative / https / http → dropped; relative → kept; no
  Location → untouched; JSON gets no framing headers. All pass.
- Live: both `https://qwenpawx.pages.dev/` and
  `https://qwenpaw-frontend.pages.dev/` → 200, QwenPaw Console,
  `X-Frame-Options: SAMEORIGIN`, `CSP: frame-ancestors 'self'`;
  `/api/auth/status` 200, `/status` 200.
- No live redirect test exists (QwenPaw emits no Location headers) —
  the harness is the verification for the rewrite itself.

## FIX-5 — board: constant-time compare, decode 400, logic quirks, headers

Findings: `board-timing-length-leak`, `board-decode-uri-500`,
`board-business-logic-quirks` (all rejected as security findings, filed
as functional bugs BUG-001–BUG-004; all fixed here).

- `features/board/worker/src/index.js`
  - `safeEqual()` no longer early-returns on length mismatch: the loop
    runs over the longer string and the length difference is folded into
    the diff.
  - Malformed percent-encoded ticket ids (`%FF`) → 400 `invalid ticket
    id` instead of a 500; the outer catch now returns a generic
    `server error` (no more echoed exception text).
  - `follow_up` is strictly boolean now: the string `"false"` (or any
    non-boolean) → 400 instead of coercing to `true`. Applies to create
    and PATCH.
  - `POST /api/tickets/:id/mark-sent` is idempotent: re-marking returns
    the unchanged ticket instead of re-stamping the timestamp.
  - Empty PATCH (or patch with only unknown fields) → 400
    `empty patch: nothing to update` instead of 200 no-op.
  - `POST /api/tickets` now honors a valid client-supplied `column`
    instead of silently forcing `todo`.
  - `POST /health` → 405 (was 200 for any method); JSON responses carry
    `nosniff` + `no-store`; the board HTML carries framing headers.
  - `?key=` was deliberately KEPT (header `X-Board-Key` also works):
    the user may rely on bookmarked `?key=` URLs, and the key is theirs
    to manage. The groupchat `?token=` removal does not apply here.

Verification:
- Local node harness with fake KV (20 checks, all pass): auth matrix,
  `follow_up: "false"` → 400, column honored, empty/unknown-only PATCH
  → 400, mark-sent idempotent timestamp, `%FF` id → 400 with a generic
  body, `/health` GET 200 / POST 405, security headers present, test
  ticket created and deleted.
- Live (no board key held by the audit): `/health` 200, `POST /health`
  405, `/` 200, `/api/tickets` no key 401, wrong key 401, `nosniff` +
  `no-store` headers present.
- Authenticated CRUD re-test still needs the board key holder (user) —
  see NEEDS-VALIDATION.md.

## FIX-6 — deploy-page.py: symlink escape closed

Finding: `infra-deploy-page-symlink-escape` (needs_validation — primitive
confirmed, planting step speculative).

- `features/botpages/deploy-page.py` `collect()` now skips symlinked
  files and directories and requires every collected file to resolve
  (realpath) inside the source directory. Hardlinks are not caught by
  this check (documented in the code) — planting one needs local write
  access already, and the build-page skill only writes regular files.

Verification (local, dummy data, no deploy): source tree with a real
page plus `evil.html` → outside file, `secret.html` → outside secret,
and a symlinked directory → outside. `collect()` returned only the real
page; both symlinks were skipped with a log line; the secret bytes were
never read.

## Not fixed in this pass (deliberate)

- `board-no-rate-limit-auth` (needs_validation): no per-IP throttling on
  board auth attempts. Impact depends entirely on BOARD_TOKEN entropy,
  which only the key holder can check. A Workers Free account has no WAF
  rate-limit on workers.dev; the fix must be in-Worker per-IP counting
  (same pattern as the groupchat limiter). Deferred: needs the key
  holder to confirm the token is a ≥32-char CSPRNG value first.
- `board-kv-race-lost-update` + `board-unbounded-board-growth`
  (rejected as security, real reliability notes): a version-check 409
  fix is insufficient on KV (check-then-PUT still has a TOCTOU window);
  the true fix is migrating the board to a Durable Object or D1. That is
  a storage migration, not a patch — needs a user decision.
- `board-corrupt-kv-silent-empty` (rejected): no realistic trigger; left
  as a defensive-coding note.
- `workers-trigger-rate-limit-race` (rejected): mooted by the /trigger
  token gate (FIX-2); folded as a note under that finding.
- `qwenpaw-query-token-leak` (needs_validation): `?token=` accepted by
  QwenPaw's own auth middleware on every API request, with the console
  SPA itself generating `?token=` URLs (file previews, QR polling). No
  leak sink was demonstrated. Fixing it means changing QwenPaw upstream
  auth code (a rebuild/redeploy of the container image path) and
  regression-testing file preview, QR-code status, WebSocket console and
  fetch-based chat streaming. Needs a user decision + a logged-in session.
- `infra-email-prompt-injection` (needs_validation): pre-deployment
  design finding on the undeployed email router. The fix (sender
  allowlist before parsing, untrusted-email marker) must land before any
  deploy; the router is still undeployed.
- `groupchat-injection-relay-latent` and `qwenpaw-indirect-prompt-injection`
  (rejected): no sink exists (relay not installed; single-user agent
  acting on owner-directed content is intended behaviour; a
  prompt-level instruction-vs-data boundary already ships in the default
  system prompt). No fix.
