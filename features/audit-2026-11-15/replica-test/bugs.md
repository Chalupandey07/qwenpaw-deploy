# Bugs — QwenPaw on InstaBox Free (Rakazo build)

Build: 094ba1e66 (Rakazo build 2026-11-15) · Date: 2026-11-15 · Env: live
deployment (own systems only).

Severity scale (replica-test): S1 data loss / security hole / payments wrong /
core flow blocked; S2 a feature broken, no workaround; S3 broken with a
workaround, or visibly wrong; S4 cosmetic. All severities below are the ones
the audit verifier assigned in the verifier records; where the record gave a
range or a caveat, it is quoted in the bug. No PII and no secrets appear in
this file. No live test was run against the board for these bugs — no board key
was available and it must not be guessed or brute-forced; the behaviours below
are source-verified by the verifier (quoted evidence in each bug), and the
live re-test needs a key-holder session (see each bug's Evidence).

## Filed bugs

### BUG-001: follow_up string "false" coerces to true

- Severity: S3
- Flow / case: F09 / F09-E1
- Screen: ticket board API (PATCH /api/tickets/:id and POST /api/tickets)
- Build: 094ba1e66

Steps
1. With the board key, PATCH a ticket with body `{"follow_up": "false"}` (a JSON string, not a boolean).
2. GET the ticket back.

Expected: the request is rejected with 400 (`follow_up must be a boolean`),
or the string is stored as given — never silently stored as `true`.
Actual: `validatePatch` line 127 does `out.follow_up = !!body.follow_up`
with no typeof-boolean check, so the string `"false"` (and any non-empty
string, `1`, `{}`, `[]`) is truthy and stores `true`. The same `validatePatch`
is shared by POST create (line 363), so create is affected too. The UI sends
a real checkbox boolean so the normal UI path is unaffected.
Evidence: verifier record `board-business-logic-quirks` — grep/sed of
`features/board/worker/src/index.js` lines 103–135, 414–433:
`127: if (body.follow_up !== undefined) out.follow_up = !!body.follow_up;`
and `title/description/column/agent/priority each type/enum-checked and return
{error} on bad input; follow_up line 127 is the only field with no type check`.
No live test was run (no board key); live re-test needs a key-holder session.
Suspected cause: missing `typeof body.follow_up !== 'boolean'` check in
`validatePatch`.
Status: FIXED 2026-11-15 (FIX-5 in ../FIXES.md) — strict boolean in validatePatch; local harness PASS; authenticated live re-test needs the board key holder.

Fix (verifier): in `validatePatch`, require a JSON boolean —
`if (body.follow_up !== undefined) { if (typeof body.follow_up !== 'boolean')
return {error: 'follow_up must be a boolean'}; out.follow_up =
body.follow_up; }` — this also fixes POST create, which shares `validatePatch`.

### BUG-002: mark-sent re-stamps sent_to_qwenpaw_at and has no already-sent guard

- Severity: S3 (verifier record gives S3/S4 for this item; filed S3 because
  the original audit timestamp is lost, not merely mis-displayed)
- Flow / case: F09 / F09-E2
- Screen: ticket board API (POST /api/tickets/:id/mark-sent)
- Build: 094ba1e66

Steps
1. With the board key, create a ticket and POST mark-sent. Note
   `sent_to_qwenpaw_at`.
2. POST mark-sent again on the same ticket. GET the ticket back.

Expected: the second call returns the existing record unchanged (200, no
re-stamp) or 409; the original sent timestamp is preserved.
Actual: lines 414–422 unconditionally set `sent_to_qwenpaw_at = now` and
`updated_at = now` with no already-sent check and no done/wont-do guard;
re-marking overwrites the original sent timestamp (audit history lost). The
session value is deterministic (`board-<id8>`, line 417) so only the timestamp
changes, and the UI hides the button once sent (line ~307), so the API guard
is the missing layer.
Evidence: verifier record `board-business-logic-quirks` — sed of lines
414–433: `ticket.qwenpaw_session = \`board-${ticket.id.slice(0, 8)}\`;
ticket.sent_to_qwenpaw_at = now; if (ticket.column === "todo")
ticket.column = "in-progress"; ticket.updated_at = now;`. No live test was run
(no board key); live re-test needs a key-holder session.
Suspected cause: no idempotency check before stamping.
Status: FIXED 2026-11-15 (FIX-5 in ../FIXES.md) — mark-sent is idempotent; local harness PASS (same timestamp on re-mark); authenticated live re-test needs the board key holder.

Fix (verifier): in mark-sent, make it idempotent — if
`ticket.sent_to_qwenpaw_at` is already set, return the existing record
unchanged (200, no re-stamp) or 409; do not overwrite the original timestamp.
Refusing from done/wont-do is an optional policy choice, not required for
correctness — the core fix is never re-stamping; if terminal-column refusal is
adopted, return 409 there too and do not move the column.

### BUG-003: empty PATCH returns 200 no-op (and bumps updated_at)

- Severity: S4
- Flow / case: F09 / F09-E3
- Screen: ticket board API (PATCH /api/tickets/:id)
- Build: 094ba1e66

Steps
1. With the board key, PATCH a ticket with body `{}`.
2. PATCH the same ticket with only unknown fields, e.g.
   `{"not_a_field": 1}`.
3. GET the ticket back and compare `updated_at`.

Expected: 400 `{error: 'no fields to update'}`; nothing is saved.
Actual: lines 427–433, `{}` passes `validatePatch` as `{value:{}}`, then
`Object.assign(ticket, {}, {updated_at: now})` bumps `updated_at`, saves to
KV, and returns 200 with no field changed. A PATCH containing only unknown
fields behaves the same (unknown fields are silently ignored).
Evidence: verifier record `board-business-logic-quirks` — grep/sed of lines
427–433: `const v = validatePatch(body); if (v.error) return json({ error:
v.error }, 400); Object.assign(ticket, v.value, { updated_at: new
Date().toISOString() }); await saveTickets(env, tickets); return
json(cleanTicket(ticket));`. No live test was run (no board key); live re-test
needs a key-holder session.
Suspected cause: no empty-validated-patch check before `Object.assign`/save.
Status: FIXED 2026-11-15 (FIX-5 in ../FIXES.md) — empty / unknown-only PATCH now 400; local harness PASS; authenticated live re-test needs the board key holder.

Fix (verifier): in PATCH, reject an empty validated patch —
`if (Object.keys(v.value).length === 0) return json({error: 'no fields to
update'}, 400)` before `Object.assign`/save — this also covers PATCH with
only unknown fields.

### BUG-004: invalid-UTF-8 ticket id returns 500 instead of 400

- Severity: S4
- Flow / case: F09 / F09-E4
- Screen: ticket board API (GET /api/tickets/:id)
- Build: 094ba1e66

Steps
1. With the board key, `curl --path-as-is
   https://qwenpaw-board.qwenpaw-rohan.workers.dev/api/tickets/%FF -H
   'X-Board-Key: <key>'`.
2. Repeat with `%E0%A4%A`, `%C3%28`, `%80`.

Expected: 400 `{error: 'invalid ticket id'}`.
Actual: `decodeURIComponent(parts[2])` at line 390 throws URIError for these
ids and the outer catch (line 445) returns 500 `{error: 'server error: URI
malformed'}`. The live 500 was not demonstrated (no board key was available),
but reachability is established: these ids pass the Cloudflare edge and reach
the Worker auth gate (live 401 unauthenticated), WHATWG URL preserves them
unchanged, and Node proves `decodeURIComponent` throws on them. Note: `%ZZ`
is NOT a trigger — Cloudflare edge returns 400 before the Worker runs; do not
test with `%ZZ`.
Evidence: verifier record `board-decode-uri-500` — live edge 400 for `%ZZ`,
live 401 for `%FF`/`%E0%A4%A`/`%C3%28`/`%80`/`%ED%A0%80`/`abc%FFdef`, and
Node `decodeURIComponent` throwing URIError for each. Full command/output in
FINDINGS-DETAIL.md. Live 500 confirmation needs a key-holder session.
Suspected cause: unguarded `decodeURIComponent` at line 390 plus an outer
catch that echoes `e.message` into the 500.
Status: FIXED 2026-11-15 (FIX-5 in ../FIXES.md) — invalid-UTF-8 id now 400 with a generic body; local harness PASS; authenticated live re-test needs the board key holder.

Fix (verifier): wrap `decodeURIComponent(parts[2])` in its own try/catch (or
validate the id first) and return 400 `{error: 'invalid ticket id'}` on
URIError; change the outer catch at line 445 to return a generic 'server
error' without appending `e.message` (hygiene only — the echoed string is just
the generic 'URI malformed', not sensitive data).

### BUG-005: concurrent ticket/comment mutations silently lose data (KV last-writer-wins)

- Severity: S3
- Flow / case: F09 / F09-E5
- Screen: ticket board API (all mutations)
- Build: 094ba1e66

Steps
1. With the board key, open the board in two tabs (or fire two mutations at
   once, e.g. create a ticket in tab A and add a comment in tab B).
2. Reload the board and compare against what each tab sent.

Expected: both mutations survive, or the second one is rejected with 409 so
the user knows to retry.
Actual (source-verified; no live concurrent test was run and none can be run
without the key): every mutation is load-modify-write on one KV key —
`loadTickets` (line 71–72, KV GET 'tickets') → mutate in memory →
`saveTickets` (line 82–83, unconditional KV PUT of the whole board). No
version, ETag/If-Match, CAS, lock, or transaction exists anywhere; the
board-level `updated_at` written at line 83 is write-only metadata, never read
or compared. KV eventual consistency (file header, lines 26–28) makes it worse
than a pure overlap race: a stale GET can lose data even for nominally
sequential mutations from different edges. The only realistic trigger today is
the same trusted user in two tabs or a double-click — silent self-data-loss on
a single-user board.
Evidence: verifier record `board-kv-race-lost-update` — `nl`/`sed` of lines
65–90 and 350–445 (5 mutation sites, all load-modify-write), grep for
version/etag/if-match/lock/cas/atomic/transaction (only the false positive
'blocked' contains 'lock'), and the `authed()` gate (single shared key).
Suspected cause: single-key JSON store with unconditional whole-board PUT and
no serialisation.
Status: open

Fix (verifier, reliability fix, not a security fix): the proposed
version/`updated_at` check with 409 is INSUFFICIENT on KV — Cloudflare KV PUT
has no conditional/CAS operation, so check-then-PUT still has a TOCTOU window;
it only narrows the race. A true fix requires serialisation: migrate board
state to a Durable Object (single instance, in-memory lock + transactional
storage, all mutations via the DO stub) or to D1 with a transaction. Cheap
mitigations for the current single-user board: client-side double-submit
guard/debounce on create/comment buttons and accepting the residual risk; do
not spend DO-migration effort for one trusted user.

### BUG-006: no ticket-count cap or list pagination — board can grow past the KV value limit

- Severity: S4
- Flow / case: F09 (capacity)
- Screen: ticket board API (POST /api/tickets, GET /api/tickets)
- Build: 094ba1e66

Steps
1. (Do not run this against the live board — it would take hundreds of
   tickets.) From source: POST /api/tickets pushes without any count check and
   `saveTickets()` rewrites the entire board as one KV value; GET /api/tickets
   returns the whole board with no limit/offset.

Expected: a count cap and/or a serialized-size check before save, plus
`?limit` (default 100) / `?offset` pagination on list.
Actual: no `MAX_TICKETS`, no limit/offset, no `tickets.length` check anywhere
in the file. Per-field caps exist (title 200, description 5000, MAX_COMMENTS
50 × MAX_COMMENT_LEN 1000). Maths (verifier): worst-case ticket ~57,000 B, so
~460 worst-case tickets reach Cloudflare KV's 25 MB single-value limit;
typical ticket ~800 B needs ~32,768 tickets; minimal ticket ~260 B needs
~100,825 tickets. The board is reported empty, so present impact is nil.
Evidence: verifier record `board-unbounded-board-growth` — grep for
MAX_TICKETS/MAX_COMMENTS/limit/offset/tickets.length (no matches) and the
worst/typical/minimal size maths vs the 25 MiB limit. Board-empty status is
the hunter's claim, not independently verified.
Suspected cause: no capacity guard on the single-key store.
Status: open

Fix (verifier, reliability hardening only): enforce a count cap AND/OR a
serialized-size check before `saveTickets` (a 500-ticket cap alone is
insufficient — 500 worst-case tickets total ~27.2 MB > 25 MB; a ~400 cap or a
pre-PUT byte-size check against 25 MB is needed), plus `?limit` (default 100)
/ `?offset` pagination on GET /api/tickets.

### BUG-007: corrupt KV value silently returns an empty board; the next create overwrites it

- Severity: S4 (defensive-coding hardening — the verifier judged this "at
  most a defensive-coding / reliability hardening note, not a security finding
  or a reportable reliability bug"; filed here as S4 because the behaviour was
  reproduced, with that caveat stated)
- Flow / case: F09 (defensive coding)
- Screen: ticket board API (loadTickets / POST /api/tickets)
- Build: 094ba1e66

Steps
1. (Local reproduction only — never corrupt the live KV.) With a mock KV
   holding a corrupt value (invalid JSON) or a wrong-shape value (`{"foo":1}`),
   call `loadTickets()`, then do a POST-style load+push+save.

Expected: `loadTickets` throws or returns a corrupt sentinel; handlers return
a distinct 500 and refuse all writes until repaired.
Actual: `loadTickets()` at lines 71–80 returns `[]` on JSON parse failure or
a non-array object without `.tickets`, and POST /api/tickets then
load-push-saves that `[]` plus one new ticket, overwriting the corrupt KV
value. A local mock-KV simulation of the verbatim functions confirmed this:
corrupt fixture loaded as `[]`, wrong-shape `{"foo":1}` loaded as `[]`, and a
POST-style load+push+save left KV as `{"tickets":[new ticket]}` with the
original ticket gone. Only POST /api/tickets is destructive after corruption;
PATCH/DELETE/comments/mark-sent first do `findIndex` on the `[]` load, get -1,
and return 404 before any save.
Evidence: verifier record `board-corrupt-kv-silent-empty` — grep showing the
only `TICKETS.put` in the repo is line 83, and the mock-KV simulation output
(`load corrupt: []`, `load wrong-shape: []`, `original ticket survives?
false`). No live proof was attempted against live KV (correctly).
Caveat (verifier): there is no realistic trigger — the sole writer always
writes valid JSON via a single atomic KV put, so corruption requires a manual
operator edit or an unevidenced second writer, and the board is currently
empty so there is no data at risk today.
Suspected cause: fail-open `loadTickets` (returns `[]` on corrupt data).
Status: open

Fix (verifier, optional hardening only): make `loadTickets` throw (or return a
corrupt sentinel) instead of `[]`; handlers return a distinct 500 (e.g.
`board_corrupt`) and refuse all writes, especially POST create, until repaired;
optionally write a backup KV key on each successful save (copy of the last good
value, only when the load parsed cleanly) with a documented restore step. The
guard must cover POST create specifically, since the other mutating routes
already 404 before saving.

### BUG-008: routines /trigger rate limit is a non-atomic check-then-set (parallel requests bypass 1/min)

- Severity: S4 (real mechanism, no independent impact — the verifier rejected
  it as a standalone record and folded it under the confirmed
  unauthenticated-trigger finding; filed here as S4 so the mechanism is
  tracked, not double-counted)
- Flow / case: F07 / F07-E1
- Screen: routines Worker (POST /trigger)
- Build: 094ba1e66

Steps
1. Send two POST /trigger requests in parallel (do not do this live without
   owner approval — each accepted trigger forces a probe and queues a pending
   prompt; the verifier's evidence is a local simulation, not a live burst).

Expected: the second parallel trigger returns 429.
Actual (source-verified + local simulation): the check-then-set is real (L209
get, L211 60s check, L214 probe await widening the window, L223 put; no lock,
CAS, transaction, or Durable Object anywhere in the file, and KV has no atomic
CAS). A local simulation of that exact interleaving returns `[202,202]` for
two parallel triggers vs `[202,429]` sequentially. Cloudflare KV eventual
consistency across edge locations widens rather than narrows the race.
Evidence: verifier record `workers-trigger-rate-limit-race` — grep of the
rate-limit lines and the `/tmp/race-sim.js` output (`sequential: [202,429];
parallel 2: [202,202]`). No parallel production requests were fired.
Suspected cause: separate KV read, check, probe await, and KV write with no
atomic primitive.
Status: CLOSED 2026-11-15 — mooted by FIX-2: POST /trigger now requires ROUTINE_WEBHOOK_TOKEN, so the unauthenticated parallel-trigger race cannot be reached.
finding — token-gating /trigger moots this for unauthenticated callers)

Fix (verifier): token-gate POST /trigger exactly like POST /api/routines
(require X-Routine-Token matching ROUTINE_WEBHOOK_TOKEN, fail closed 503 when
unset). Token-gating alone does not make the check atomic; if strict 1/min
atomicity is ever required, move the check-and-set into a Durable Object
(single-threaded, sequential execution), since KV offers no CAS. A Durable
Object solely for this soft 1/min limit is disproportionate — the limit guards
wake/probe volume, not a security boundary.

## Summary

| bug | severity | flow | status |
| --- | --- | --- | --- |
| BUG-001 follow_up "false" coerces to true | S3 | F09 | FIXED 2026-11-15 |
| BUG-002 mark-sent re-stamps, no already-sent guard | S3 | F09 | FIXED 2026-11-15 |
| BUG-003 empty PATCH returns 200 no-op | S4 | F09 | FIXED 2026-11-15 |
| BUG-004 invalid-UTF-8 ticket id returns 500 | S4 | F09 | FIXED 2026-11-15 |
| BUG-005 KV race loses concurrent mutations | S3 | F09 | open |
| BUG-006 no ticket-count cap or pagination | S4 | F09 | open |
| BUG-007 corrupt KV silently empties, next create overwrites | S4 | F09 | open |
| BUG-008 /trigger rate limit non-atomic | S4 | F07 | CLOSED 2026-11-15 (mooted by token gate) |

Bugs by severity: S1 0, S2 0, S3 3, S4 5. Fixed so far: 4 (BUG-001–BUG-004) + BUG-008 closed as mooted. Nothing ships with
an open S1.

## Not filed (from the verifier records — recorded here so they are not re-filed as bugs)

- **board-timing-length-leak** — `safeEqual` length early-return. Optional
  hardening note only (identical 401 either way; sub-microsecond signal vs
  millisecond edge jitter; no measurement). FIXED 2026-11-15 (FIX-5):
  the loop now runs over the longer string with the length difference
  folded into the diff.
- **proxy-open-redirect-rewrite-gap** — Location rewrite gap with no producer
  (deployed QwenPaw emits no Location header). FIXED 2026-11-15 (FIX-4):
  foreign/protocol-relative Locations are dropped, origin ones rewritten,
  plus framing headers on proxied HTML.
- **groupchat-injection-relay-latent** — no sink (relay not installed);
  verbatim delivery is documented intended behaviour.
- **qwenpaw-indirect-prompt-injection** — no attacker, no entry point, no
  demonstrated effect; prompt-level boundary already ships.
- **groupchat-no-rate-limit-flood** — not duplicated here: it is the confirmed
  LOW security finding `groupchat-no-rate-limit-flood` (silent eviction past
  200 messages). The functional symptom is tracked in test-plan case F08-E1.
- **board-no-rate-limit-auth** — not a functional bug: needs-validation
  security lead, decided by BOARD_TOKEN entropy (see NEEDS-VALIDATION.md §1).
- **qwenpaw-query-token-leak / groupchat-token-in-query** — needs-validation
  security leads, not functional bugs (see NEEDS-VALIDATION.md §2–3).

## To check (not reproduced — needs a key-holder or logged-in session)

- Board empty-board status (hunter's claim, not independently verified).
- The earlier routines manual triggers `trig-1794684729498` and
  `trig-1794684977739` appear in history but not in the live pending table —
  unexplained, possibly manual cleanup by the hunter.
- Whether Cloudflare/InstaBox edge logs record query strings (decides the
  qwenpaw-query-token-leak lead).
- The Astra stream-timeout fix re-test (test-plan F02-H2) — pending a
  logged-in browser session.
