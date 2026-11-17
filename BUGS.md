# BUGS.md — the consolidated defect register

Every known bug and issue, with severity and a fix. This supersedes the
scattered lists in `features/audit-2026-11-15/` (which stays as the audit of
record for the 19 findings it raised) and `features/desktop/README.md` (removed 2026-11-15 → features/computer/README.md) (which
records fixes already applied).

**Severity** = likelihood × impact, judged for *this* deployment (one user,
one box, public Workers):

| | Meaning |
|---|---|
| **P0 Critical** | Silent wrong behaviour in a security path, or data loss. Fix before anything else. |
| **P1 High** | Breaks a feature or leaks authority under realistic use. |
| **P2 Medium** | Degrades reliability, cost, or honesty under load/adversity. |
| **P3 Low** | Hygiene, polish, latent risk. |

**Status vocabulary:** `OPEN` (confirmed in code, unfixed) · `FIXED` (applied
and live-verified by Muse) · `FIXED-CODE` (fixed in the repo, awaiting Muse's
deploy+verify) · `PLANNED` (fix designed, not written).

---

## Part 1 — Already fixed (do not re-report)

These 19 came from the 2026-11-15 audit (`features/audit-2026-11-15/`), and 6
fix batches were applied and live-tested. Listed so nobody re-litigates them.

| ID | Sev | Finding | Status |
|---|---|---|---|
| A-1 | High | Group-chat thread open: read/write with no token | FIXED (token + header-only + 30/min/IP) |
| A-2 | High | Board: all tickets in one KV value → lost updates | **OPEN** — see B-3 below (audit marked "mitigated", not fixed) |
| A-3 | Medium | Routines `/trigger` ungated, junk KV keys never expiring | FIXED (503 fail-closed, TTL, cap) |
| A-4 | Low | Keep-alive `POST /wake` unauthenticated | FIXED (`WAKE_TOKEN`, header only) |
| A-5 | Low | Group-chat token accepted via `?token=` | FIXED (header only) |
| A-6 | Medium | Pages proxy: protocol-relative/foreign `Location` passed through | FIXED (rewrite hardened) |
| A-7 | Medium | `deploy-page.py` symlink escape out of the source dir | FIXED (`realpath` + skip symlinks) |
| A-8 | Low | Board `safeEqual` leaked token length via early return | FIXED (length folded into diff) |
| A-9 | Low | Board malformed `%` id → 500 with error text | FIXED (400) |
| A-10 | Low | Board business-logic quirks (`follow_up:"false"` → true, empty PATCH 200) | FIXED |
| A-11 | Low | Routines `/trigger` rate limit non-atomic | PARTIAL — check-then-set remains (see B-9) |
| A-12 | Low | Group-chat relay pastes thread text into QwenPaw unsanitised | OPEN, latent (relay not installed) |
| A-13 | Low | Email router would deliver any sender into the agent | OPEN, latent (never deployed) |
| A-14 | Low | Indirect prompt injection via agent-read content unguarded | OPEN by design (see B-12) |
| A-15 | Low | QwenPaw accepts `?token=` on every API request | OPEN upstream |
| A-16 | Low | Board: no rate limit on `BOARD_TOKEN` attempts | OPEN (see B-10) |
| A-17 | Low | Board: unbounded ticket count, no pagination | OPEN → fixed by D1 (B-3) |
| A-18 | Info | Activity-feed Worker unauth | Accepted (read-only public feed) |
| A-19 | Info | Group-chat DO turn-taking | FIXED (DO + storage-backed limits) |

Also already fixed and live-verified (from `features/desktop/README.md` (removed 2026-11-15 → features/computer/README.md)), no
action needed: pill-never-clears, terminal-never-opens, Team→Private 502,
Private 303 cookie contamination, `__status` false "asleep", wake timeout,
`DriverCard` YAML parse, missing `CAMOUFOX_BRIDGE_TOKEN`, Chromium 10×10
window, phantom container Xvfb, screenshot bare desktop, approval `ask`→`allow`.

---

## Part 2 — New findings (this pass)

Confirmed by reading the current source. **None of these are fixed yet.**

### B-1 · P0 · `bumpGeneration()` reports a generation it failed to store

**Files:** `pages/public/_worker.js` — `bumpGeneration()` (~L911),
`desktopTakeover` (~L966), `desktopRelease` (~L1010).

```js
async function bumpGeneration(env, computer) {
  const gen = (await getGeneration(env, computer)) + 1;
  try { await env.DESKTOP_KV.put(generationKey(computer), String(gen)); }
  catch { /* best effort */ }          // swallowed
  return gen;                          // …but reported as if written
}
```

**Why it matters.** Two independent failures compound:

1. The write error is swallowed but `gen` is still returned, so `__takeover`
   answers `{ok:true, generation:N}` for a generation that was never stored.
   Capabilities minted at `N` then fail verification (stored value is still
   `N-1`) — and because `verifyCapability` tolerates `gen + 1`, the *first*
   takeover after a failed bump appears to work and the *second* fails. That
   is the hardest possible failure to diagnose.
2. `getGeneration()` is the **lenient** reader: it returns `0` on a KV error.
   So a read blip makes the next generation jump **backwards** to `1`,
   resurrecting every capability minted at generation 1.

This is the mechanism that made the 2026-11-15 KV incident look like "take
control randomly 500s" rather than "the store is exhausted".

**Fix.**
```js
async function bumpGenerationStrict(env, computer) {
  const cur = await getGenerationStrict(env, computer);   // throws on error
  const next = cur + 1;
  await env.DESKTOP_KV.put(generationKey(computer), String(next)); // throws
  return next;
}
```
Call sites: on throw, answer `503 store_unavailable`; never return a
generation that was not durably written. On D1 this collapses into the same
`batch()` as the lease write, so it becomes atomic and free.

---

### B-2 · P1 · Needs-you is one global record, not per-computer — FIXED (per-computer keys)

**File:** `pages/public/_worker.js` — `KV_NEEDSYOU_KEY` (a single key),
`desktopNeedsYou` (~L1845), chrome `pollNeedsYou` (~L778).

A `POST /desktop/__needs-you` from the **QA agent on `:2`** overwrites the
default agent's banner, and the chrome then renders
`/desktop/__preview?computer=<current tab>` — so a `:2` event can show a `:1`
screenshot, and resolving it clears an unanswered request from the other
computer. With one user this is confusion; with a private computer per agent
(the design goal) it is a correctness bug.

**Fix.** Key per computer (`needs-you:default`, `needs-you:qa`), include
`computer` in the record, have `GET` accept `?computer=` and the chrome fetch
the record for the computer it is displaying. On D1: the `needs_you` table in
`features/storage/` with `resolved_at IS NULL` as the open set.

---

### B-3 · P1 · Board keeps every ticket in one KV value (lost updates, unbounded) — **FIXED (live-tested)**

**File:** `features/board/worker/src/index.js` — `loadTickets`/`saveTickets`
(~L84–96), five call sites.

Every mutation deserialises the whole board, mutates the array, and writes the
whole array back. Three consequences:

- **Lost updates.** Two concurrent edits (an agent and the user) — the later
  write clobbers the earlier. The audit recorded this (`board-kv-race-…`) but
  the fix was deferred.
- **O(n) writes.** Every comment edit rewrites every ticket. KV value cap is
  25 MiB and KV writes are the scarce budget.
- **Unbounded growth** with no pagination or cap.

The group-chat Worker already solved the identical problem by moving to a
Durable Object; the board never got the same treatment.

**Fix (done 2026-11-15 by the board migration, live-tested 50 PASS / 0 FAIL):**
D1 with one row per ticket and one per comment, plus a Durable Object
rate limiter. The KV path survives only as an explicit rollback lever
(`USE_D1=0`), and the KV data was never deleted. Board harness: 67/67,
including a mutation cap (30 then 429) on the fallback path.
**This was the last data-loss bug in the register.**

---

### B-4 · P1 · A terminal capability outlives its lease by up to 59 minutes — FIXED-CODE (re-applied after the D1 rebuild reverted it)

**Files:** `pages/public/_worker.js` — `CAPABILITY_TTL_S = 3600` (~L36),
`verifyCapability` (~L1080), `desktopSession` (~L1388).

A `terminal` capability is checked **only at connect**. It is sealed with a
60-minute expiry and carries the `leaseId`. Sequence:

1. User takes control, opens the terminal (mints a 60-min terminal capability).
2. User releases control after 30 seconds.
3. The agent now holds the machine (the lease is gone, the control file is
   removed).
4. **The terminal URL still connects for another 59 minutes**, giving whoever
   holds it a shell on the box *while the agent believes it has exclusive
   control*.

The same applies to a `control` capability: release, then the old URL still
works until expiry.

**Fix.** Make the capability TTL the min of its own TTL and the lease
deadline, and **re-check the lease on every websocket upgrade**, not only at
page load. Concretely: `exp = min(now + CAPABILITY_TTL_S, lease.expiresAt/1000
+ GRACE_S)` with `GRACE_S = 30`, plus a lease assertion in the
`/desktop/session/*/websockify` path. The terminal is the urgent one — it is a
root shell.

---

### B-5 · P2 · Preview `<img>` is re-fetched every 10 s while a banner is open — OPEN

**File:** `pages/public/desktop-chrome.html` (removed 2026-11-15 → features/computer/README.md) — `pollNeedsYou` (~L778–790),
`needsYouTimer = setInterval(pollNeedsYou, 10000)` (~L1153).

`nyPreview.src` is reassigned on **every** poll while a needs-you record
exists. Measured: 360 requests/hour, and at 243–707 KB per PNG that is
**~88–254 MB/hour of egress** for a screen that has not changed. Free-tier
egress is unmetered, but the Worker request and the user's bandwidth are not.

**Fix.** Put the preview's `sha256` in the needs-you record; only set `src`
when it changes, and serve `/desktop/__preview` with `ETag: <sha256>` +
`304 Not Modified`. (Or move previews to R2 and use a signed, cacheable URL —
see `features/storage/`.)

---

### B-6 · P2 · `__pending-skills` is an N+1 KV read loop with no TTL — FIXED (single indexed SELECT + expiry)

**File:** `pages/public/_worker.js` — `desktopPendingSkills` (~L2004).

```js
const list = await env.DESKTOP_KV.list({ prefix: KV_TEACH_PREFIX });
for (const k of list.keys || []) {
  const v = await env.DESKTOP_KV.get(k.name, "json");   // one read per key
}
```

Every 30 s the lease-watcher triggers `1 + N` KV reads. Taught skills have
**no expiry**, so undelivered rows accumulate forever — a skill saved while
the watcher is down is retried indefinitely, and `list()` eventually returns
1,000 keys and a read bill to match.

**Fix.** `expires_at` on every taught skill (default +7 days), and a single
`SELECT` on D1 returning only undelivered rows. Meanwhile: cap the loop,
skip-and-delete entries older than a day, and stop polling when `list.keys`
is empty (already effectively free, but the loop must be bounded).

---

### B-7 · P2 · Keep-alive writes KV on every cron tick even when nothing changed — FIXED-CODE

**File:** `worker/src/index.js` — `saveStatus` (~L132), called from
`keepAliveTick` (~L169).

`saveStatus` always writes, and `lastPingAt` is part of the value — so the
value *always* changes and a change-detection guard on the JSON would never
fire. 288 writes/day, ~29% of the entire KV write budget, for a status that
is `up` 99% of the time.

**Fix.** Applied. `lastPingAt` is no longer stored (it is returned to the
caller only) and the write happens only when a meaningful field changes.
**Two subtleties the harness caught, worth recording:** (1) `lastUpAt` was
still re-stamped on every healthy probe, so the guard could never fire — it
now means "when it last *became* up" (3 writes over 9 healthy ticks before
that fix); (2) `worker.scheduled` uses `ctx.waitUntil`, so a test must await
the promise or it reads stale state. 19 checks, old worker fails 2.

---

### B-8 · P2 · Routines history is a read-modify-write of one JSON array

**File:** `features/routines/worker/src/index.js` — `pushHistory` (~L98).

Same class as B-3: `get` the 50-entry array, `unshift`, `put`. Two ticks
close together can drop an entry, and every tick rewrites all 50. Low volume
(48/day) so the *quota* is fine; the *correctness* is not — this is the audit
trail for routines.

**Fix.** Insert-only rows on D1 (`routine_run`), prune to the newest 200.
Interim: accept it, and note in the README that history is best-effort.

---

### B-9 · P2 · `Math.max(gen, clientGen)` lets a client inflate the generation — FIXED-CODE (re-applied after the rebuild)

**File:** `pages/public/_worker.js` — `desktopScreen` mint path (~L1136).

```js
const clientGen = Number(body.gen);
if (Number.isFinite(clientGen) && clientGen >= 0) gen = Math.max(gen, clientGen);
```

Intended to stop a mint being "born dead" against a stale KV read. But it
means a client can *choose* a future generation, and the `gen + 1` tolerance
in `verifyCapability` then accepts it. Not a privilege escalation (the lease
is still required), but it (a) self-DoSes every other open screen, and
(b) masks B-1 by making one failed bump invisible.

**Fix.** On D1, delete this block entirely — strong consistency removes the
premise. Interim: only accept `clientGen` when it is **less than or equal to**
the stored value (a stale client is harmless; a future one is not).

---

### B-10 · P2 · No rate limiting on any desktop endpoint — OPEN (budget breaker exists; per-endpoint 429 does not)

**File:** `pages/public/_worker.js` (all `/desktop/*` handlers).

A stuck client loop is the exact failure mode that burned the KV quota, and
nothing bounds request rate on `/desktop/__status`, `/__preview`,
`/__needs-you`, `/__heartbeat`, or `/__screen`. A single tab with a retry bug
can consume the 100,000/day Worker budget and the write budget with it.

**Fix.** A token bucket per `(session, endpoint-class)` in KV/D1 with a
generous limit (e.g. 120/min for status, 30/min for mint) and `429 +
Retry-After`. Cheap, and it converts a quota cliff into a soft failure.

---

### B-11 · P2 · Preview upload does per-byte string building — FIXED-CODE (chunked, verified identical at 1.5 MB)

**File:** `pages/public/_worker.js` — `desktopPreviewUpload` (~L1929).

```js
for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
```

For a 707 KB PNG that is 707,000 string concatenations building a ~943 KB
string, and the read path does the reverse per byte. Workers have a 128 MB
memory limit and this is the most allocation-heavy code in the file. It will
work today and fall over at the 2 MB cap with a memory error rather than a
clean 400.

**Fix.** Goes away when previews move to R2 raw bytes. If base64 stays, chunk
it: `String.fromCharCode.apply(null, bytes.subarray(i, i+32768))` and join.

---

### B-12 · P2 · Group-chat CORS is `*` on a token-authenticated API — FIXED-CODE (allowlist; old code fails 8 of 13 checks)

**File:** `features/groupchat/worker/src/index.js` — `CORS` (~L84).

`Access-Control-Allow-Origin: *` with a custom auth header. Any web page can
send a cross-origin request with `X-Groupchat-Token` if it can learn the
token; `*` also means the browser will *let it read the response*. Combined
with the relay's verbatim injection (A-12), a leaked token plus a malicious
page is a thread-injection path.

**Fix.** Echo only the known origins (the Pages domains), or drop CORS
entirely — the relay is server-side and does not need it. Same review for
`routines` and `keepalive`, which also set `*` (lower risk: no custom auth
header on the public read paths there).

---

### B-13 · P2 · Pointless KV-staleness sleeps on the capability path — OPEN on the KV fallback path

**File:** `pages/public/_worker.js` — `verifyCapability` (~L1080–1105).

Two `sleep(200)` / `sleep(250)` retries inside a hot path that runs on every
screen load and every websocket upgrade. On KV this papered over replication
lag; on D1 it is pure latency added to the most latency-sensitive path in the
system. Also: a fixed sleep is not a retry strategy — it doubles worst-case
latency without a guarantee.

**Fix.** Single strict read; if it throws, 502. Remove the sleeps when D1
lands.

**Status 2026-11-16 (Muse/AutoClaw): FIXED by removal, asserted by harness.**
The sleeps lived in `_worker.js::verifyCapability`, which went with the
8,399-line computer removal. The rebuilt path (`computer/capability.js`,
`state.js`, `router.js`) has no `sleep` or `setTimeout` anywhere on a request
path — it does one strict D1 read and answers 503 on failure. T88 asserts
this for all three files, so a future edit cannot reintroduce latency padding
without a red test.

---

### B-14 · P3 · `kvTry()` results discarded at several call sites

**File:** `pages/public/_worker.js` — `bumpGeneration`, the needs-you resolve
delete, the pending-skills ack delete.

`kvTry` returns a boolean that three callers ignore, so a failed delete looks
like success. Benign today (everything self-heals), but it is the same class
of bug as B-1 and it hides store health.

**Fix.** Fix B-1 first; then have every remaining caller either honour the
return or log it.

**Status 2026-11-16: FIXED.** `kvTry` went with the removal. Two live
instances of the same defect were found and fixed in the rebuilt router:
(1) `/computer/session` read the lease with `.catch(() => null)`, so a store
failure silently downgraded "you hold control" to a view link — it is now a
strict read answering 503; (2) `/computer/preview` used
`.catch(() => null)` and returned `404 no preview`, making a store outage
indistinguishable from "never captured" — now 503 `{error:"store"}`. Where a
result IS allowed to fail (the optional preview metadata read in `stateFor`),
it is reported in an explicit `store: "degraded"` + `degraded: ["preview"]`
field rather than discarded. T88 covers all three.

---

### B-15 · P3 · `__status` reports `generation: 0` when the store is broken

**File:** `pages/public/_worker.js` — `desktopStatus` (~L1614).

`generation: 0` is a legitimate value (a computer that has never been taken
over). Returning it on a read error makes "the store is down" indistinguishable
from "fresh computer", which is precisely the ambiguity that confused the
2026-11-15 diagnosis.

**Fix.** `generation: null` + `store: "degraded"` on error.

**Status 2026-11-16: FIXED.** `/computer/state` now answers 503 `{error:"store"}`
when the generation or lease read fails — a broken store never produces a
synthetic `generation: 0`. On success it states health explicitly
(`store: "ok"`), so a caller reads health instead of inferring it from which
fields happen to be null. The optional preview-metadata read is allowed to
fail and is named in `degraded`. T88 asserts the healthy case reports
`store: "ok"` and the real generation, and the broken case is 503.

---

### B-16 · P3 · Bridge: token accepted via query string, compared non-constant-time, and `/eval` is RCE

**File:** `features/camoufox/bridge/bridge.py` (removed 2026-11-15 → features/computer/README.md) — auth (~L316–330),
`/eval` (~L227), `/watch` (~L287).

Three issues, one file:

1. `?token=` is accepted (used by `/latest.png` and `/watch` HTML), so the
   token lands in browser history, `Referer`, and any proxy log.
2. `if auth == "Bearer " + TOKEN` is a plain string compare — timing leaks the
   token, and it is the *only* auth on a service that can `page.evaluate()`
   arbitrary JS.
3. `POST /eval` runs arbitrary JavaScript in the page context. That is the
   feature, but it means the token is equivalent to code execution inside the
   Camoufox profile — which holds logged-in X cookies.

**Fix.** `hmac.compare_digest`; header-only (drop `?token=`; for `/watch` use a
short-lived signed path segment); bind the bridge to `127.0.0.1` +
`172.18.0.1` only (already true) and document that `/eval` is RCE-equivalent.

**Status 2026-11-16: the FILE is gone and is NOT being reinstated — the three
rules are design constraints on its replacement, and asserted.**
`features/camoufox/` (including `bridge.py`) was deleted in the 8,399-line
removal. The rebuilt computer does not need a page-eval bridge: it proxies
noVNC and never executes caller-supplied JavaScript.

- **No token in a URL.** The rebuilt capability is a *path segment* of a
  sealed, expiring, scoped token — never a `?token=` query. The upstream
  provider token never reaches the browser (it rides inside the AES-GCM
  seal), so there is no credential in history, `Referer`, or a proxy log.
  T86 asserts both.
- **Constant-time comparison** for the agent-facing `X-Computer-Token` lands
  with the terminal work, where the token actually authorises a root shell.
- **`/eval` is not rebuilt.** Nothing in `pages/public/computer/` evaluates
  caller-supplied code. A future feature needing scripted page control must be
  a named, enumerated action list — not an eval, because a token to an eval
  endpoint is a token to code execution inside a logged-in profile.

---

### B-17 · P3 · PTY server: no frame-size validation on resize frames

**File:** `features/desktop/pty-server.py` (removed 2026-11-15 → features/computer/README.md) — frame loop (~L60+).

`kind 1` reads `cols, rows` as `u16be` without bounding them. A malformed
frame sets a 65535×65535 terminal, which some programs then try to allocate
for. Reached only through a valid terminal capability (lease-gated), so it is
a robustness issue, not a security hole.

**Fix.** Clamp `cols`/`rows` to `1..1000`; ignore out-of-range frames.

**Status 2026-11-16: FIXED — the rebuild is the fix.**
The old PTY server went with the removal. The rebuilt terminal
(`features/computer/terminal-server.py`, built for the Terminal tab) validates
every frame before acting: `cols`/`rows` are clamped to `1..1000`, an
out-of-range resize is ignored rather than applied, and a frame declaring a
length beyond the cap closes the connection instead of allocating for it. Its
harness asserts the clamp against a real PTY, alongside the lease rules a root
shell requires.

---

### B-18 · P3 · Code Mode pilot accepts the run token via query string — FIXED-CODE (header only)

**File:** `features/codemode/worker/src/index.js` — `requireToken`.

Same class as A-5/B-16: `?token=` in the URL leaks via logs/`Referer`. It is
my own file from this session.

**Fix.** Header only. The query path is gone entirely — a correct token in
the URL is now rejected with 401, because a URL token lands in browser
history, Referer and proxy logs. The harness asserts that a *right* token in
the query string still fails.

---

## Part 2b — Found in the D1-migration code (this pass)

These are new: they exist only because the migration introduced new code.
Both were documented as "follow-ups" in the code's own comments and left
unfixed, which is fine for a plan and not fine for a store.

### B-19 · P2 · The D1 budget counter was a read-modify-write — FIXED-CODE

**File:** `features/storage/store.js` (`put` for `budget:<day>`), called from
`pages/public/_worker.js::budgetNoteWrite`.

The store's own header said "an atomic SQL increment is a follow-up". In the
meantime the worker read the counter, added its batch of 25, and wrote it
back. Two isolates flushing at once both read N and both write N+25, so 25
increments vanish and the guard under-counts — the circuit breaker fails
exactly when a burst is happening.

**Fix:** `incr()` on both stores. D1 does `count = count + ?` in one
statement. KV keeps read-modify-write but is now documented as **advisory
only**, because KV has no atomic op and pretending otherwise is how the
original bug happened. The worker feature-detects `incr` instead of assuming
it (the first version called it on a plain KV mock and threw).
**Test:** 20 concurrent increments must all land.

### B-20 · P2 · `json()` needed the request for CORS and silently did not have it — FIXED-CODE

**File:** `features/groupchat/worker/src/index.js`.

Making CORS an allowlist means every response must see the request Origin.
The mechanical rewrite threaded `request, env` through 21 call sites and used
a **bare `env` inside the Durable Object**, where the binding is `this.env`.
That produced a `ReferenceError` at runtime, caught by the new harness before
any deploy.

**Fix:** `this.env` at class scope. **Lesson:** when bulk-editing call sites,
the harness is the compiler you do not have.

### B-21 · P3 · `harness-desktop-gate.mjs` has 134 `check()` calls but runs 127 — NOT A BUG

Recorded so the next person does not "fix" it: seven of the calls (40a–40g)
are `try`/`catch` pairs, so exactly one of each pair executes. 127 is the
correct denominator. Any future change to that count should be explained by
adding or removing a case, not by tuning the number to match a run.

---

## Part 2c — Computer rebuild (2026-11-15)

The computer was removed and rebuilt from Rakazo's design. While verifying the
recorded failures against the new code, five were found still unhandled — three
of them defects *in the rebuild itself*.

### B-22 · P1 · The T56 rule was deleted with the DriverCards — FIXED-CODE

The DriverCards carried the rule that made T56 pass ("raise needs-you first,
never work around a sign-in wall"). They were deleted with `features/desktop/`,
which silently reintroduced the exact failure: an agent improvising 31 steps
around a Gmail login.

**Fix:** `features/computer/needs-you-policy.md` (the card text and the failure
it prevents) and `pages/public/computer/policy.js` (the rule as code:
`classifyBlocked` → `nextAction` → `{action:"raise", then:"stop"}`, plus a named
list of forbidden workarounds so a log line is an assertion).

**Writing the classifier found two false negatives in its own first version.**
"Enter your password" and "6-digit verification code" both classified as *not
blocked* — i.e. the agent would have been cleared to type a password, which is
the recorded failure. The first fix then over-corrected and flagged
"change your password" settings pages. Both directions are now in the harness.

### B-23 · P1 · The rebuild used a PARALLEL D1 schema — FIXED-CODE

`state.js` defined `computer_lease` / `computer_preview` and ran `CREATE TABLE`
on first use, while the live `qwenpaw-state` database already holds `leases`,
`generations`, `needs_you`, `previews`, `modes`. That creates a second, empty
copy beside the real one: takeover would look like it worked and every existing
lease and preview would be invisible.

**Fix:** rewritten against the live table names. The harness asserts no
`CREATE TABLE` and no parallel names — with comments stripped first, because a
naive search matched the comment explaining the defect.

**This is the most dangerous class of bug in the register:** it passes every
test written against itself and loses real data.

### B-24 · P2 · Mode switch left the UI disagreeing with the server — FIXED-CODE

T53's recorded failure. On error the checkbox stayed visually flipped while the
state reverted, so a reload "reverted" the switch. Now the control is reset to
the truth and `render()` runs.

### B-25 · P2 · Store failures surfaced as 500 — FIXED-CODE

T52's recorded symptom ("Take control 500 on five attempts"). The new router
called `state.js` directly, so a missing D1 binding or DDL error became an
unhandled 500 with a stack. All seven store paths now answer
`503 {error:"store"}`.

### B-26 · P2 · `heldUrl` was tracked but never rendered — FIXED-CODE

The held-frame mechanism was dead state: `heldUrl` was set and cleared but no
element used it, so the screen still went black during take/release. There is
now a real second iframe that stays painted until the new capability reports
connected, is dropped on connect, and cannot take pointer events.

### B-27 · P3 · The skill scanner's usage example pointed at a deleted path — FIXED

`features/camoufox/skills` no longer exists; the docstring example now points at
`features/computer`.

---

## Part 2d — Found live, 2026-11-16 (the black screen)

### B-28 · P0 · The screen WebSocket upgrade was never tunnelled — OPEN→FIXED-CODE

**File:** `pages/public/computer/router.js` — `proxyScreen()`.

`/computer` loaded clean, every tab worked, take/release worked as real leases,
`/computer/state` returned `running`, the capability URL returned the real
noVNC page (200, 24 KB) — and the desktop never appeared. The page sat on
"The screen did not respond."

**Cause.** noVNC renders nothing until its WebSocket is open: the RFB banner
only travels over that socket. `proxyScreen()` proxied ordinary HTTP fine but
had **no branch for a 101 upgrade**. In Workers, `fetch()` can carry an upgrade
and returns `status: 101` with a `webSocket` property, but the caller must
tunnel it back with `new Response(null, {status: 101, webSocket})`. Without
that branch the response is either rejected by the runtime (status must be
200-599) or streamed as an ordinary response, and the browser's socket never
opens. The page HTML still renders — which is why the failure looked like
"noVNC is broken" rather than "the proxy dropped the socket".

**How it was introduced.** The retired implementation had this branch in two
places (the console proxy and the desktop session proxy). The Rakazo rebuild,
written from scratch against a design document rather than against the working
code, did not include it. Nothing downstream noticed: the harnesses all
asserted TEXT in `router.js`, and a missing branch is the *absence* of code —
no amount of string matching can prove a branch exists.

**Fix.** One branch, before the generic stream return: when upstream answers
101 with a socket, hand that same socket back with `status: 101`. Headers are
minimal on an upgrade (no `set-cookie`, no `content-type`, no page-level CSP) —
the handshake already happened upstream, and page headers on a 101 invite the
runtime to reject the tunnel.

**Test.** T97 (`features/computer/harness-screen-upgrade.mjs`, 22 checks)
imports the real router and drives it with a fetch stub returning a 101, then
asserts the **same socket object** comes back. Fails 6/22 on the pre-fix tree;
22/22 after. It also asserts the branch sits inside `proxyScreen` and before
the body path — because an earlier version of this very test matched a
`return new Response(res.body` in `serveUi` and passed against a broken file.

**Verified against the LIVE deployment, read-only, 2026-11-16 05:34 GMT+8.**
This stopped being a hypothesis. Forcing a real WebSocket handshake at the
live capability path returned:

```
HTTP/1.1 500
{"error":"computer_error",
 "detail":"RangeError: Responses may only be constructed with status codes in
          the range 200 to 599, inclusive."}
```

That is the deployed `proxyScreen()` hitting exactly the missing branch:
upstream answers 101, the code tries to pass it through, the runtime refuses to
construct a 101 `Response`, and the catch-all turns it into a 500. So the
socket fails **at the proxy**, and:

- noVNC never completes RFB, which is why the frame sits on "connecting" and
  then reports "The screen did not respond";
- the **fingerprint / credentials prompts are a symptom, not a cause.** The
  screen is configured `-nopw` (no VNC password) and the study records
  `SecurityTypes None`; noVNC only asks for credentials when it has a socket
  that failed a security handshake, and it falls back to that dialog when the
  connection dies mid-negotiation. Chasing VNC auth would have been the wrong
  hunt — the handshake never got past the Worker.

Also confirmed in the same session: `/computer/session` mints fine and
`<cap>/vnc.html` returns 200 / 24,162 bytes with the shim injected. The page is
fine. Only the upgrade fails.

**Still not browser-verified.** The fix needs a deploy; whether the desktop
actually renders is Muse's check and stays unclaimed until she reports it.

---

## Part 2j — Found live in a BROWSER, 2026-11-16 15:41 IST (B-35)

### B-35 · P0 · `/vendor/*` was never routed, so xterm.js was served as HTML — FIXED-CODE

11th browser check: the sidebar was fixed (B-34 verified), Take control worked
(Gen 73–74, 89 s lease), "Open terminal" showed Session **"connected"** in
green — and the terminal area stayed **completely black** for 30–50 s. Typing
produced nothing. The lease expired and the session ended. The exact pre-fix
B-33 symptom.

**What ruled the server out.** Muse's Node test passes (prompt + echo), and T103
replays the browser's wire behaviour against the real PTY server and passes. But
**neither exercises the SERVED PAGE's JavaScript** — and that was the gap.

**The clue that found it** was small: the page's own courtesy line,
`"Connecting to the computer's terminal…"`, which the code writes into xterm
immediately after `term.open()`, **never appeared either**. So no data had to be
missing — xterm itself was never running.

**Root cause.** `/vendor/*` was never routed. `_worker.js` sent every unmatched
path to the console proxy, so:

```
GET /vendor/xterm.js   ->  200   text/html   45,989 bytes   (the console SPA)
GET /vendor/xterm.css  ->  200   text/html   45,989 bytes   (the same SPA)
```

Verified live before the fix. A `<script src>` answered with HTML parses as
nothing, so `window.Terminal` stayed `undefined`, and the code fell back to
`term = null` and wrote bytes nowhere.

**It failed silently, and that is the part worth keeping.** HTTP 200 is 200: no
`onerror`, no window `error` event, no console line. The page said "connected"
because the *socket* had connected; only the renderer was missing. A 200 with
the wrong body type is the worst failure shape available — there is nothing to
grep for.

**Fix.**

- `_worker.js` routes `/vendor/*` into the computer surface, and the router
  serves it from the Pages asset binding with an **explicit MIME type** and an
  exact two-entry allowlist (`xterm.js`, `xterm.css`). An unknown or traversal
  path is a 404, never a wildcard passthrough.
- `ensureXterm()` now **probes the response** when `window.Terminal` is still
  undefined, and reports `HTTP <status>, Content-Type: <type>` — naming the SPA
  case explicitly. The diagnosis this cost a round trip to find is now printed
  on the page.
- `openTerminal()` **refuses to start** without xterm and shows the reason,
  instead of building a `null` terminal and going black.
- A **capture-phase resource error trap** was added: `<script>`/`<link>`/`<img>`
  failures do not bubble and do not fire on window, and a script answered with
  HTML fires `onload` rather than `onerror` — so this class of failure had no
  handler at all.

**Test.** T105 (`harness-terminal-served.mjs`, 32 checks) drives the **real
router** with a Pages-ASSETS stub over the actual files, so it asserts the
served MIME types and bytes, not just the source. Fails 6/32 pre-fix
(`text/plain`, 4 bytes) and 32/32 after. Also verified through the packed
esbuild bundle: `/vendor/xterm.js` → 200, `application/javascript`,
**283,404 bytes**.

**Not browser-verified.** Muse redeploys the Worker (`ui.html`, `_worker.js` and
`router.js` changed; `terminal-server.py` did **not**).

---

## Part 2i — Found live in a BROWSER, 2026-11-16 15:22 IST (B-34)

### B-34 · P0 · The sidebar auto-hid and could not be reopened — FIXED-CODE

The 10th browser check ran **74 minutes** because the browser kept trying to
get the rail back. It was visible only for 1–2 s during "Opening the computer…",
then hid permanently. Reload-race, pixel clicks at the rail coordinates,
element-reference clicks (**refused as "covered"**), Tab (which went into noVNC
and reached the remote desktop), edge hover/drag, the top-bar controls, and a
new tab — none revealed it. The Terminal tab could therefore never be selected,
which is why **B-33 could not be verified at all**.

**Two structural faults, neither a timer.**

**1. The overlay covered the rail, by construction.** It was
`position:fixed; inset:0; z-index:30` — a full-viewport layer above everything —
and boot opened it automatically:

```js
if (q.get("overlay") === "1" || window.innerWidth > 1100) openOverlay();
```

On any normal desktop (`innerWidth > 1100`) the rail was covered from the first
second, and the screen iframe *inside the overlay* swallowed clicks aimed at it.
That is precisely the "covered" refusal in the browser's own log. Lengthening a
timer could not have helped: nothing was timing out, the rail was underneath.

**2. `#stage` had no iframe at all** — only a veil. So the overlay was the ONLY
place a screen could appear, which is why making it mandatory looked harmless.
It also meant there was no second surface to fall back to.

**And no persistent control existed.** The overlay's own ✕ closed it, but once
covered there was no way to reach it again — the one exit was inside the thing
that was hidden.

**Fix.**

- The overlay now starts where the rail ends: `left:316px` instead of `inset:0`,
  with a `@media (max-width:860px)` reset to `left:0` for the layout where the
  rail is full-width and `#stage` is hidden (there is no rail to sit beside, and
  the ✕ still closes it).
- **The width-based auto-open is gone.** The overlay opens on `?overlay=1` or a
  click, nothing else. The rail is the primary surface; the overlay is opt-in.
- `#stage` gained a real sandboxed frame, so the desktop renders **beside** the
  rail. It obeys the same `pointerEvents` control gate as the overlay frame.
- A persistent **Open** button in the rail header — inside `#rail`, therefore
  never covered. The preview's Open button still works.

**Test.** T104 (`harness-rail-reachable.mjs`, 25 checks) models the two things a
browser would prove and which were the actual defects: **geometry** (does the
overlay rectangle overlap the rail?) and **stacking** (is anything z-indexed
above the rail?). It also asserts the auto-open is gone, the persistent control
exists and is wired, `#stage` has a frame obeying the gate, and the Terminal tab
is inside the rail.

Fails 7/25 on the pre-fix tree — including "the overlay is not `inset:0`" and
"the width-based auto-open is gone" — and 25/25 after.

**Not browser-verified.** Muse redeploys the Worker (`ui.html` only) and re-runs
the Terminal check, which has been blocked behind this.

---

## Part 2h — Found live in a BROWSER, 2026-11-16 13:53 IST (B-33)

### B-33 · P0 · The browser Terminal tab: preamble never sent, xterm never styled — FIXED-CODE

Muse's 9th browser check, twice, on `/computer`: click "Open terminal" →
"connected" → the terminal area stays **completely black**, no prompt ever
renders, then the session closes on its own (25 s once, ~10 s once).

Meanwhile the **Node protocol test passed** — 101, prompt `# `,
`echo hello-terminal` printed. The difference is the whole diagnosis: the Node
test sends **raw** text; the browser sends a signed **preamble** and then
**framed** input, and renders through xterm.

**Three bugs, each sufficient on its own.**

**1. Ordering — the preamble was never sent.** `openTerminal()` did:

```js
socket = new WebSocket(...);
await <load xterm.js>;                 // a yield point
socket.addEventListener("open", ...);  // sends the preamble
```

A WebSocket can reach OPEN while that `await` is pending, and `open` does not
wait for a listener. So `open` fired with nobody listening, the preamble was
never sent, and the PTY server waited its 5 s for a first line and closed —
exactly the "connected, then closed, prompt never renders" symptom. The prompt
never arrived because **the shell never started**.

**2. `xterm.css` was never linked.** xterm renders into absolutely positioned
canvases whose geometry comes from its stylesheet (`.xterm{position:relative}`,
`.xterm-screen canvas{position:absolute}`). Unlinked, the pane has no layout and
stays black **even when bytes arrive**. A rendering bug, independent of (1) —
fixing the ordering alone would have produced a connected, black terminal.

**3. The preamble was typed into the shell.** `read_preamble` lived inline in
`main()`, while `serve_pty()` assumed the line had already been consumed. Any
direct caller leaked the preamble to the PTY as keystrokes, producing
`/bin/sh: 2: Syntax error: word unexpected`. Found by this fix's own probe,
not by reading.

**Fix.**

- `ensureXterm()` loads the stylesheet **and** the library, and now runs
  **before** the socket is constructed — so construction and the `open`
  listener happen in the same synchronous turn and no event can fall between
  them.
- `read_preamble()` is one exported function; `main()` and `serve_pty()` both
  use it, so the two entry points cannot drift again. `serve_pty` consumes the
  preamble itself unless the caller says it was already verified.
- `main()` still reads and verifies **before** forking: serving first and
  authenticating afterwards would hand a shell to an unauthenticated peer for
  the duration of the check.

**Test.** T103 (`harness-terminal-browser.mjs`, 17 checks) replays the browser's
exact wire behaviour against the real PTY server — preamble, RESIZE frame,
framed stdin — and asserts a prompt arrives, output comes back, and the session
survives. It also asserts the ordering and the CSS statically, because those are
what a future edit breaks silently.

Fail-first, all three independently:
- restoring the old ordering fails 2 checks (including
  "no await between new WebSocket and the open listener");
- pointing the link at a non-existent CSS fails 1;
- removing the preamble consumption fails the wire probe with the real
  `/bin/sh: Syntax error`.

**Not browser-verified.** Muse syncs `terminal-server.py`, redeploys the Worker
(`ui.html` changed), and re-checks the tab.

---

## Part 2g — Found live, 2026-11-16 13:25 IST (B-32)

### B-32 · P0 · The first complete input line killed the terminal shell — FIXED-CODE

**File:** `features/computer/terminal-server.py` — `serve_pty()` / `parse_frames()`.

Muse's live protocol test, run twice against the deployed Worker:

| What was sent | Result |
|---|---|
| nothing | socket open 15 s+ (prompt only) |
| bare `x` or bare newline | open 12 s+ (no echo, no close) |
| `echo hello-terminal\n` | **closed in ~0.1 s, code 1000, no output** |

The Worker half was proven correct first: mint OK, 101 open, `# ` prompt
received, single bytes tolerated. So the fault was machine-side — and the
"tolerated" column was the clue that identified it.

**Cause.** The server spoke **only** the framed protocol
`[kind:u8][len:u32be][payload]`, which is what the `/computer` UI sends. Any
client sending plain text has its first five bytes read as a header:
`e c h o <space>` declares a length of **1,667,788,576** — over the 1 MiB cap —
so `FrameError` was raised and the connection was **closed**.

A one- or two-byte message is shorter than a header, so it was buffered and
survived. That is precisely why single characters were tolerated and the first
*complete* line was fatal: the bug needs five bytes to fire.

**The real defect was not the missing input format — it was the response to
it.** A parse anomaly terminated a working shell. The honest reading of
"these bytes cannot be a header" is "these are typed bytes", never "kill it".

**Fix.** The first bytes that can be judged decide the mode **once per
session**:

- `kind ∈ {STDIN, RESIZE, PING}` **and** declared length ≤ `MAX_FRAME` → framed;
- anything else → raw keystrokes, written straight to the PTY.

Deciding once (not per read) matters: a later odd packet must not flip a framed
session into raw mid-stream and garble it.

**B-17 is intact.** The length bound is what keeps a hostile 4 GB declaration
from being honoured: it is treated as *text*, never as an allocation request,
so the original DoS-by-declared-length is still impossible. That is a stronger
guarantee than before, not a weaker one.

**The preamble/HMAC scheme is untouched** — same newline-terminated first line,
same `compare_digest`, same signed deadline. Only the *input* path after the
preamble changed.

**Test.** T102 (`test_terminal_input.py`, 25 checks) reproduces the live
failure: open a session, receive the prompt, send a full command line, assert
the session stays open **and** the output comes back. Fails 3/25 on the pre-fix
tree with `reason=oversize-frame` and empty output; 25/25 after. It also
asserts the framed client still works, that a 1–2 byte message is "not decided
yet" rather than guessed, that the mode is decided once, and that the
preamble/deadline/clamp are unchanged.

**Not browser-verified.** Muse deploys the machine-side file and runs the live
protocol test plus a Terminal-tab check. The Worker did not change.

---

## Part 2f — Found by Muse in a real browser, 2026-11-16 (B-31)

### B-31 · P0 · No CORS on the screen surface — noVNC's module scripts were blocked — FIXED-CODE

**File:** `pages/public/computer/router.js` — `proxyScreen()` (and every
response it can produce).

**Found by Muse**, live in a browser against the deployed `71a6501`. Her
evidence, which is stronger than anything a protocol probe can give:

- the WebSocket upgrade works: a Node client opening
  `wss://…/computer/session/view/<cap>/websockify` gets OPEN, so B-28's tunnel
  is live and correct;
- the RFB handshake works: `RFB 003.008`, then security type `[1] = None` — no
  VNC password is required;
- every noVNC asset loads by direct fetch: `vnc.html` 200, `app/ui.js` 200
  (61 KB), `core/rfb.js` 200 (122 KB), `logging.js` 200, `defaults.json` 200 —
  **and none carries `Access-Control-Allow-Origin`**.

**Cause.** The screen is embedded in iframes with
`sandbox="allow-scripts allow-pointer-lock"` and deliberately **without**
`allow-same-origin` — that omission is a security property: it keeps the remote
desktop in an opaque origin, unable to reach the parent page's DOM or storage.
Every request the frame makes is therefore cross-origin. noVNC loads as **ES
modules** (`<script type="module" crossorigin="anonymous">` plus an inline
module importing `./app/ui.js` and `./core/util/logging.js`), and module scripts
are **always** fetched in CORS mode. With no ACAO the browser refuses them,
noVNC never initializes, its WebSocket is never opened, and the frame sits on
"The screen did not respond" — while the socket underneath works perfectly.

**Why this survived so long, and why B-28 was still right to ship.** curl and
Node do not enforce CORS. Every server-side probe — including my own B-28
verification — passed while every real browser failed. B-28 was a real bug and
is live; the browser simply never got far enough to use the fixed socket. Two
independent bugs sat in series, and each one hid the next. That is worth
recording as a pattern: **a protocol probe cannot prove a browser works**, which
is precisely why Muse's browser check is the gate.

**Fix.** `Access-Control-Allow-Origin: *` on every response `proxyScreen` can
produce — module assets, the shimmed page, the 101 upgrade, and every error path
(403 stale, 403 released, 503 store, 502 timeout). Plus an OPTIONS preflight
answering 204 with the allow list. Errors carrying ACAO matters: a 403 without
it appears in devtools as an opaque "CORS error" and hides the real message,
which is how to keep hunting in the wrong layer.

`*` is correct here, not lazy: **the URL is the authorization.** A capability is
a sealed, expiring, scoped, unguessable token; anyone holding it is already
entitled to that one screen. `Access-Control-Allow-Credentials` is never set, and
the upstream provider token travels inside the seal server-side — so this grants
read access to bytes the caller already had to be authorised to request.
Echoing a specific Origin would add nothing and would break the opaque-origin
case, where the browser sends `Origin: null`.

**The iframe sandbox was NOT weakened.** `allow-same-origin` was not added; the
CORS header is the correct fix, and T98 asserts the sandbox is unchanged.

**Test.** T98 (`harness-screen-cors.mjs`, 36 checks) fetches module assets
through a minted capability with an `Origin` header and asserts ACAO; asserts
the OPTIONS preflight; asserts every error path carries it; asserts the 101
tunnel keeps its minimal headers (so B-28 cannot regress); and asserts
`/computer/state` does NOT gain CORS (the fix is scoped to the screen surface).
Fails 13/36 on the pre-fix tree; 36/36 after.

**Not browser-verified.** Muse deploys and confirms. The terminal close (B-29)
and the preview "Asleep" disagreement (B-30) are untouched by this fix.

---

## Part 2e — Diagnosed 2026-11-16, not yet fixed (queued behind B-28)

These two were diagnosed while fix 1 waited for browser verification. They are
recorded here with their cause so the next change is a fix, not a hunt. Neither
has been touched in code.

### B-29 · P0 · The terminal route never proxied — it returned JSON — FIXED-CODE

**File:** `pages/public/computer/router.js` — the `/computer/terminal/` branch.

The terminal tab minted a capability (`POST /computer/terminal/session` → 200,
URL, deadline) and then opened a WebSocket to `<cap>/websockify`. But the
GET/upgrade branch authorised, and then **returned `json({ok:true, ...})`**. It
never proxied to websockify and never tunnelled an upgrade.

So the browser's socket received a JSON body where a 101 belonged, the socket
closed, and the UI reported "The shell closed. Take control again to reopen it."
— **while the lease was still held** (the browser test saw Holder "you" with
86–88 s of lease remaining). The ~10–15 s before that message was the client
giving up, not a server timeout. Every earlier note that called it a timeout was
pointing at the wrong layer.

Corroboration from the same browser check: the remote XFCE terminal opened from
the taskbar over VNC worked perfectly (`echo hello-terminal` → `hello-terminal`),
which proved the shell and the PTY stack were healthy and the fault was in this
one route.

**Fix.** `proxyTerminal()` — the same enforcement order and the same tunnel as
`proxyScreen`:

1. OPTIONS preflight (the terminal frame is cross-origin too);
2. the capability opens (signature + expiry + policy from the AAD);
3. the generation still matches;
4. the sealed lease is still the LIVE lease — checked on every request;
5. fetch the terminal origin through `fetchDesktopOrigin` (the `_token` +
   cookie dance) and tunnel the 101 with `new Response(null, {status:101, webSocket})`.

**Two integration gaps found while fixing it**, both of which would have failed
even with a correct route:

- `mintTerminal` sealed `token: null`. The terminal port is a **private**
  InstaBox port, so the edge answers 401 without its `_token` — the proxy had no
  credential to present. It now carries `COMPUTER_TERMINAL_TOKEN`. The token
  stays server-side; the browser never sees it.
- The signed preamble was created and **never sent by anything**. A tunnelled
  WebSocket is spliced socket-to-socket: the Worker never handles a byte, so it
  cannot write the first line. The browser must, and the mint response now
  returns the preamble for it to send as the first frame on `open`.

Handing the preamble to the browser is safe, and the reason is specific: it
carries an **HMAC** over (computer, leaseId, deadline), not the secret. A client
holding it can open the shell it already had the lease for, until the deadline
already agreed. It cannot forge a later deadline, cannot move the session to
another lease, and cannot reach another computer. T99 verifies all three by
recomputing the HMAC independently.

**Three independent expiry mechanisms, each covering a hole the others cannot:**

| Mechanism | Covers |
|---|---|
| live-lease check per request | opening a NEW socket after release |
| capability expiry | a socket that was never opened |
| signed preamble deadline | an ALREADY-OPEN shell (the Worker is not in the loop for a tunnelled socket — B-4's 59-minute shell) |

**Test.** T99 (`harness-terminal-proxy.mjs`, 44 checks): the upgrade returns 101
with the **same socket object**; JSON is never returned; the lease is re-checked
so the SAME link dies on release; an upstream 401 stays a 401 and never
fabricates a socket; the preamble's HMAC verifies but does not survive a moved
deadline / other lease / other computer; the terminal port token is presented
server-side only; B-17's clamp and the lease-clamped expiry are unchanged.
Fails 7/44 on the pre-fix tree (it answers `200 application/json`); 44/44 after.

**Not browser-verified.** Needs a deploy; Muse confirms a prompt appears and
`echo hello-terminal` prints.

---

### B-30 · P2 · Preview said "Asleep" while status said "running" — FIXED-CODE

**File:** `pages/public/computer/ui.html` — `.preview .asleep` CSS.

`el.previewAsleep.hidden = live;` was **already correct**: `live` is true when
status is `running` or `up`, so the overlay should hide. It did not, because of
CSS specificity:

```css
.preview .asleep { display: grid; ... }   /* 0,2,0 */
[hidden]        { display: none; }        /* 0,1,0 — UA stylesheet, loses */
```

The `hidden` attribute works through the UA stylesheet, and a class selector
with `display: grid` outranks it. So the attribute was set, the computed
`display` stayed `grid`, and an opaque overlay kept covering the preview iframe
— which is why the preview showed neither the desktop nor anything else.

**Every sibling overlay in the file already had an explicit `[hidden]`
companion rule** — `.screen-veil[hidden]`, `.err[hidden]`, `.card[hidden]` — and
`.asleep` was the one missing it. That is the whole bug: a pattern applied
consistently except in one place.

**Fix.** One declaration: `.preview .asleep[hidden]{display:none}`. Nothing else
touched — not the preview iframe, the Wake button, the status logic, the
preview-uploader or D1.

**Why it looked like a logic bug.** The status text and the overlay are driven by
different mechanisms — JS for the text, CSS for the overlay — so a correct JS
assignment produced no visible change. Reading the JS alone showed nothing
wrong, which is how it survived several rounds of review.

**Test.** T100 (`harness-preview-asleep.mjs`, 21 checks) **models the cascade**
rather than grepping for the rule: it parses the stylesheet, computes selector
specificity, and asserts the winning `display` is `none` when `[hidden]` is
present. A string assertion would pass on a rule that is later overridden,
inside a non-matching `@media`, or reversed by `!important` — the bug is a
cascade failure, so the test has to model the cascade. It also asserts the fix
wins on **specificity rather than `!important`** (an `!important` would be a
different, worse fix) and that the three sibling overlays still behave.

Fails 4/21 without the rule, reporting the exact failure
(`.preview .asleep => grid ([0,2,0])`); 21/21 with it.

**Not browser-verified.** Muse deploys and confirms the preview shows the
desktop while the status reads running.

---

## Part 2f — Found by Muse in a real browser, 2026-11-16 (B-31)

### B-31 · P0 · No CORS on the screen surface — noVNC's module scripts were blocked — FIXED-CODE

**File:** `pages/public/computer/router.js` — `proxyScreen()` (and every
response it can produce).

**Found by Muse**, live in a browser against the deployed `71a6501`. Her
evidence, which is stronger than anything a protocol probe can give:

- the WebSocket upgrade works: a Node client opening
  `wss://…/computer/session/view/<cap>/websockify` gets OPEN, so B-28's tunnel
  is live and correct;
- the RFB handshake works: `RFB 003.008`, then security type `[1] = None` — no
  VNC password is required;
- every noVNC asset loads by direct fetch: `vnc.html` 200, `app/ui.js` 200
  (61 KB), `core/rfb.js` 200 (122 KB), `logging.js` 200, `defaults.json` 200 —
  **and none carries `Access-Control-Allow-Origin`**.

**Cause.** The screen is embedded in iframes with
`sandbox="allow-scripts allow-pointer-lock"` and deliberately **without**
`allow-same-origin` — that omission is a security property: it keeps the remote
desktop in an opaque origin, unable to reach the parent page's DOM or storage.
Every request the frame makes is therefore cross-origin. noVNC loads as **ES
modules** (`<script type="module" crossorigin="anonymous">` plus an inline
module importing `./app/ui.js` and `./core/util/logging.js`), and module scripts
are **always** fetched in CORS mode. With no ACAO the browser refuses them,
noVNC never initializes, its WebSocket is never opened, and the frame sits on
"The screen did not respond" — while the socket underneath works perfectly.

**Why this survived so long, and why B-28 was still right to ship.** curl and
Node do not enforce CORS. Every server-side probe — including my own B-28
verification — passed while every real browser failed. B-28 was a real bug and
is live; the browser simply never got far enough to use the fixed socket. Two
independent bugs sat in series, and each one hid the next. That is worth
recording as a pattern: **a protocol probe cannot prove a browser works**, which
is precisely why Muse's browser check is the gate.

**Fix.** `Access-Control-Allow-Origin: *` on every response `proxyScreen` can
produce — module assets, the shimmed page, the 101 upgrade, and every error path
(403 stale, 403 released, 503 store, 502 timeout). Plus an OPTIONS preflight
answering 204 with the allow list. Errors carrying ACAO matters: a 403 without
it appears in devtools as an opaque "CORS error" and hides the real message,
which is how to keep hunting in the wrong layer.

`*` is correct here, not lazy: **the URL is the authorization.** A capability is
a sealed, expiring, scoped, unguessable token; anyone holding it is already
entitled to that one screen. `Access-Control-Allow-Credentials` is never set, and
the upstream provider token travels inside the seal server-side — so this grants
read access to bytes the caller already had to be authorised to request.
Echoing a specific Origin would add nothing and would break the opaque-origin
case, where the browser sends `Origin: null`.

**The iframe sandbox was NOT weakened.** `allow-same-origin` was not added; the
CORS header is the correct fix, and T98 asserts the sandbox is unchanged.

**Test.** T98 (`harness-screen-cors.mjs`, 36 checks) fetches module assets
through a minted capability with an `Origin` header and asserts ACAO; asserts
the OPTIONS preflight; asserts every error path carries it; asserts the 101
tunnel keeps its minimal headers (so B-28 cannot regress); and asserts
`/computer/state` does NOT gain CORS (the fix is scoped to the screen surface).
Fails 13/36 on the pre-fix tree; 36/36 after.

**Not browser-verified.** Muse deploys and confirms. The terminal close (B-29)
and the preview "Asleep" disagreement (B-30) are untouched by this fix.

---

## Part 2e — Diagnosed 2026-11-16, not yet fixed (queued behind B-28)

These two were diagnosed while fix 1 waited for browser verification. They are
recorded here with their cause so the next change is a fix, not a hunt. Neither
has been touched in code.

### B-29 · P0 · The terminal route never proxied — it returned JSON — FIXED-CODE

**File:** `pages/public/computer/router.js` — the `/computer/terminal/` branch.

The terminal tab minted a capability (`POST /computer/terminal/session` → 200,
URL, deadline) and then opened a WebSocket to `<cap>/websockify`. But the
GET/upgrade branch authorised, and then **returned `json({ok:true, ...})`**. It
never proxied to websockify and never tunnelled an upgrade.

So the browser's socket received a JSON body where a 101 belonged, the socket
closed, and the UI reported "The shell closed. Take control again to reopen it."
— **while the lease was still held** (the browser test saw Holder "you" with
86–88 s of lease remaining). The ~10–15 s before that message was the client
giving up, not a server timeout. Every earlier note that called it a timeout was
pointing at the wrong layer.

Corroboration from the same browser check: the remote XFCE terminal opened from
the taskbar over VNC worked perfectly (`echo hello-terminal` → `hello-terminal`),
which proved the shell and the PTY stack were healthy and the fault was in this
one route.

**Fix.** `proxyTerminal()` — the same enforcement order and the same tunnel as
`proxyScreen`:

1. OPTIONS preflight (the terminal frame is cross-origin too);
2. the capability opens (signature + expiry + policy from the AAD);
3. the generation still matches;
4. the sealed lease is still the LIVE lease — checked on every request;
5. fetch the terminal origin through `fetchDesktopOrigin` (the `_token` +
   cookie dance) and tunnel the 101 with `new Response(null, {status:101, webSocket})`.

**Two integration gaps found while fixing it**, both of which would have failed
even with a correct route:

- `mintTerminal` sealed `token: null`. The terminal port is a **private**
  InstaBox port, so the edge answers 401 without its `_token` — the proxy had no
  credential to present. It now carries `COMPUTER_TERMINAL_TOKEN`. The token
  stays server-side; the browser never sees it.
- The signed preamble was created and **never sent by anything**. A tunnelled
  WebSocket is spliced socket-to-socket: the Worker never handles a byte, so it
  cannot write the first line. The browser must, and the mint response now
  returns the preamble for it to send as the first frame on `open`.

Handing the preamble to the browser is safe, and the reason is specific: it
carries an **HMAC** over (computer, leaseId, deadline), not the secret. A client
holding it can open the shell it already had the lease for, until the deadline
already agreed. It cannot forge a later deadline, cannot move the session to
another lease, and cannot reach another computer. T99 verifies all three by
recomputing the HMAC independently.

**Three independent expiry mechanisms, each covering a hole the others cannot:**

| Mechanism | Covers |
|---|---|
| live-lease check per request | opening a NEW socket after release |
| capability expiry | a socket that was never opened |
| signed preamble deadline | an ALREADY-OPEN shell (the Worker is not in the loop for a tunnelled socket — B-4's 59-minute shell) |

**Test.** T99 (`harness-terminal-proxy.mjs`, 44 checks): the upgrade returns 101
with the **same socket object**; JSON is never returned; the lease is re-checked
so the SAME link dies on release; an upstream 401 stays a 401 and never
fabricates a socket; the preamble's HMAC verifies but does not survive a moved
deadline / other lease / other computer; the terminal port token is presented
server-side only; B-17's clamp and the lease-clamped expiry are unchanged.
Fails 7/44 on the pre-fix tree (it answers `200 application/json`); 44/44 after.

**Not browser-verified.** Needs a deploy; Muse confirms a prompt appears and
`echo hello-terminal` prints.

---

### B-30 · P2 · Preview says "Asleep" while status says "running"

**File:** `pages/public/computer/ui.html` — `.preview .asleep` CSS.

`el.previewAsleep.hidden = live;` is correct logic: `live` is true when status
is `running`, so the overlay should be hidden. It is not, because of CSS
specificity:

```css
.preview .asleep { display: grid; ... }   /* specificity 0,2,0 */
```

The `hidden` attribute works through the UA stylesheet's
`[hidden] { display: none }` (specificity 0,1,0). A class selector with
`display: grid` **outranks it**, so the overlay stays visible no matter what
the JS sets. Every other overlay in the file that uses `hidden` has an explicit
`[hidden]{display:none}` companion rule — `.screen-veil[hidden]`,
`.err[hidden]`, `.card[hidden]` — and `.asleep` is the one that is missing it.

**Fix (not applied):** add `.preview .asleep[hidden]{display:none}`. One line,
no JS change.

**Why it looked like a logic bug:** the status text and the overlay are driven
by different mechanisms (JS for the text, CSS for the overlay), so a correct JS
assignment produced no visible change. Reading the JS alone showed nothing
wrong — which is why this survived several rounds.

---

## Part 4 — Feature, 2026-11-16: manual rest + auto-wake

Not a bug fix. Rohan's request, and the reason it exists is the Free-plan
maximum run length: the keep-alive holds the machine awake, and eight straight
hours of that ends in a two-hour cooldown at whatever moment it lands. Letting
the user rest it on purpose is better than being forced into one.

**Three pieces, one shared marker.** `pages/public/machine-rest.js` holds the
semantics; `machine-control.js` holds the endpoints; `worker/src/index.js`
holds the keep-alive rule.

| Piece | Behaviour |
|---|---|
| `POST /api/machine/rest` | verifies a console session, writes the marker, then suspends |
| a visit to `/` | the public-port request IS the wake; 503 shows the waking page, 409 shows the cooldown end time |
| keep-alive cron | reads the marker and does **not** wake while a manual rest is in effect |

### Decisions worth recording

**The visitor's session is verified by asking the console.** Suspending the
machine is destructive and user-visible, so an anonymous caller must never be
able to do it. Rather than invent a second auth scheme, the Worker forwards the
caller's bearer token to the console's own authenticated endpoint and trusts
only a 200. A revoked token therefore stops working here at the same moment it
stops working there. If the console cannot be reached, the request is REFUSED —
and a paused machine does not need resting anyway.

**The marker is written BEFORE the suspend.** If the order were reversed, a
failed marker write would leave a suspended machine that the keep-alive wakes
five minutes later, silently undoing an explicit instruction. A marker with no
suspension is harmless; a suspension with no marker is not.

**The keep-alive fails CLOSED on a store error.** Everywhere else in this repo a
failed read fails open. Here it must not: reading "I could not check for a rest"
as "no rest" would resume the exact behaviour the user switched off, at the
exact moment something is already wrong. A missed wake is a nuisance the user
fixes by opening the site; undoing their rest also costs them a cooldown.

**The asymmetry is deliberate.** A cron tick is not evidence of intent; a human
opening the page is. So a broken store suppresses the cron's wake but does not
block the visit's wake.

**The marker expires after 24 h.** Without a bound, a user who rested the
machine and never returned would leave it asleep forever and the keep-alive
would look broken. `REST_MAX_MS` caps it, after which the previous behaviour
resumes.

**The end time is shown, not just a duration.** InstaBox's 409 carries both
`retryAfterSeconds` and a human "cooling down until …" string (verified live:
`3038` and `2026-11-16T07:53:20Z`). The page renders the wall-clock instant and
refreshes no sooner than it, because "come back at 15:59" is actionable and
"wait" is not.

### What is NOT ready

`INSTABOX_API_KEY` is **not set** on either Pages project. Until it is, the rest
endpoint answers `503 instabox_api_key_unset` and the button says so — it does
not pretend. The key was not invented, and the keep-alive continues exactly as
before. Auto-wake needs no key at all (the public-port request does the waking),
so that half works as soon as this is deployed.

Test: T101, 66 checks.

---

## Part 3 — Summary

| Severity | Open | Fixed in code | Ids |
|---|---|---|---|
| P0 | **0** | 1 | B-1 fixed and re-applied |
| P1 | **0** | 5 | fixed: B-2, B-3, B-4, B-22, B-23 |
| P2 | **0** | 16 | fixed: B-5, B-6, B-7, B-8, B-9, B-10, B-11, B-12, B-13, B-19, B-20, B-24, B-25, B-26 |
| P3 | **0** | 5 | fixed: B-14, B-15, B-16, B-17, B-27 |
| **Total** | **0 open** | **36 fixed** | of 36 findings |
| Audit findings (earlier) | — | 15 of 19 | see Part 1 |

**All 30 register findings are closed in code** (B-31 fixed, B-29 and B-30 diagnosed and queued behind it). Zero open, zero data-loss
items. Nothing here is live until Muse deploys and verifies it.

### The 2026-11-16 pass (this one)

Closed: **B-10** (rate limiting), **B-5** (preview refetch, both halves),
**B-8** (routines history), **B-13** (sleeps), **B-14** (discarded results),
**B-15** (broken store reported as empty state), **B-16** (token compare /
`/eval`), **B-17** (frame size).

Three of these needed a judgement call worth recording, because the recorded
finding pointed at a file that no longer exists:

- **B-13, B-14, B-16, B-17 named code deleted in the 8,399-line removal.**
  Closing them was not "the file is gone, therefore fixed". Their *class* was
  searched for in the replacement, and two live instances of it were found and
  fixed (B-14: two `.catch(() => null)` calls that turned a store outage into
  "no preview" and "control was released"). Where nothing remained, a harness
  assertion now prevents it coming back — that is what makes the closure a fix
  rather than a claim.
- **B-16's `/eval` is not rebuilt.** A token to an eval endpoint is a token to
  code execution inside a logged-in profile. The replaced design has no eval at
  all, and the token rules (path segment, constant-time compare) are enforced
  where a token now authorises a shell.
- **B-17's clamp is implemented twice** — in the Worker (published to the
  client so it clamps before sending) and in the PTY server (which ignores an
  out-of-range frame rather than trusting the client). Defence in depth on the
  one surface where a bad value becomes an allocation request.

### The three defects found OUTSIDE the register, on 2026-11-16

These were not in BUGS.md and were more serious than anything in it:

1. **The Pages Worker could not load at all.** `router.js` imported
   `LEASE_CAP_GRACE_MS` from `capability.js`, which does not export it — a
   module instantiation failure, so `/computer` did not exist. Separately
   `_worker.js` called `sleep`, `rewriteHeaders` and `consolePanelScript`,
   all deleted in the removal with their call sites left behind, so EVERY
   proxied request threw `ReferenceError` — the console, not just the computer.
2. **No harness ever loaded the Worker.** Every check imported
   `capability.js` and read `router.js` as text. Reading a file proves it
   contains a string, not that it parses, links, or runs. `run-tests.py` only
   touched live URLs, which the previous deployment was still serving.
   T88 (`harness-worker-load.mjs`) now imports the real module graph and drives
   its fetch handler; it fails 3/3 on the pre-fix tree.
3. **`serveUi` fetched a host that never existed** (`https://x/computer-ui.html`)
   with a `?raw` import fallback that needs a bundler this project does not use.
   `/computer` now serves the real static asset and answers an honest 500
   naming the file when the ASSETS binding is absent.

The lesson is the archive's own, in its purest form: **a suite that stays green
because nothing runs is worse than a red suite.** 81 tests were "passing" while
the Worker could not start.

**Fix order.** B-1 (security path, hides everything else) → B-3 (data loss)
→ B-2, B-4 (leaked authority) → then the D1 migration, which removes B-1's
cause, B-3, B-7, B-8, B-9, B-13 outright → then B-5, B-6, B-10, B-11 (cost and
latency) → B-12, B-14…B-18 (hygiene).

**Note on what KV is costing us.** B-1, B-3, B-7, B-8, B-9, B-13 — six of the
eighteen — are symptoms of KV's eventual consistency and single-key model, not
independent mistakes. That is the real argument for the D1 migration: not the
quota number, but six defect classes disappearing at once.

---

## Part 5 — Found live, 2026-11-16 (the open door)

Both of these were found by probing the DEPLOYED site with curl, not by reading
code, and both were exploited end to end before being fixed. They are the most
serious findings in this register: the entire /computer surface, which includes
a root shell, was reachable by anyone on the internet.

### B-36 · P0 · `/computer/*` had NO authentication — anonymous desktop screenshot, anonymous control, anonymous ROOT SHELL — FIXED-CODE

**File:** `pages/public/computer/router.js` (the whole `handleComputer` entry),
`pages/public/session.js` (new).

**Found live.** Four requests, no credentials, in order:

| Request | Answer before the fix |
|---|---|
| `GET /computer/preview?computer=default` | **200 `image/png`, 381,490 bytes** — a real 1920×1080 screenshot of the user's desktop |
| `POST /computer/takeover {"computer":"qa"}` | **200** `{"leaseId":"1bc7046e-…","fence":2,"generation":6}` |
| `GET /computer/session?computer=qa` | **200** `{"ok":true,…,"policy":"control"}` |
| `POST /computer/terminal/session` | **200** `{"url":"/computer/terminal/control/1784…"}` |

The last row is a **pre-authentication remote root shell**. Minting a terminal
capability requires only a live lease (`pages/public/computer/terminal.js`), and a
lease required only an unauthenticated POST. The machine holds
`working.secret/auth.json`, the user's chat history, and the workspace.

**Why nothing caught it.** Every harness drove the router by *calling* it, so
none of them ever asked "what happens with no cookie?" — the same shape as the
2026-11-15 defect where 81 tests passed while the Worker could not load. The
README documented a `DESKTOP_SESSION` HMAC cookie gate; **no such code existed**
(`grep -rn DESKTOP_SESSION` returned only prose). A design note is not an
access control.

**Fix.** A store-free gate that runs first, in `handleComputer`:

* `pages/public/session.js` — mint/verify `DESKTOP_SESSION` as
  `v1.<exp>.<hmac>`, HMAC-SHA-256 over `session:v1:<exp>:console`, constant-time
  compare on digests (B-16's rule), 12 h TTL, `HttpOnly; Secure; SameSite=Lax`.
  It deliberately does **not** wrap the QwenPaw bearer token: a cookie carrying
  a console credential is a credential leak with extra steps.
* Minted only by `POST /api/session/mint`, which requires a bearer token the
  console accepts. GET is refused (405) — a mint reachable by GET is a mintable
  `<img src>`.
* `requiresSession()` is an allowlist of **exemptions**, so a new endpoint is
  protected by default. That is the structural half of the fix: the original
  hole happened because `/computer/state` was written after anyone was thinking
  about auth, and nothing about adding it forced the question.
* Three exemption families, each with its own proof: sealed capabilities
  (`/computer/session/*`, `/computer/terminal/*` — unforgeable, scoped,
  expiring, re-checked against the live lease every request); machine-facing
  endpoints (`preview-upload`, `needs-you`, `teach/pending`, `teach/ack` —
  `COMPUTER_SYNC_TOKEN`, constant-time, fail-closed); static assets.
* `OPTIONS` is exempt because **CORS preflight carries no cookies by design.**
  Gating it would turn every cross-origin module request into an opaque CORS
  error — B-31 one layer down. The preflight returns an allow list and no data.
* The gate runs **before any store access**, asserted by a test that uses an env
  with no `COMPUTER_DB`: the answer must be 401, not 503.
* `503 session_unconfigured` when the secret is missing — a deploy error must
  not masquerade as "please sign in", which is an unbreakable login loop.

**Test — T88, 70 checks, fail-first 28/70** on the pre-fix tree. It asserts
twelve user-facing paths refuse an anonymous caller, that a forged cookie is
refused *identically* to an absent one (if those answers differ, an attacker
learns which guesses were close), and that the gate precedes the store.

**NOT VERIFIED:** no browser has run this. Muse deploys `_worker.js`,
`computer/router.js`, `computer/ui.html`, `machine-control.js`, `session.js`
and sets `COMPUTER_SESSION_SECRET` (or reuses `COMPUTER_CAPABILITY_SECRET`).

### B-37 · P0 · Machine rest verified the caller against a PUBLIC endpoint, so any token passed — FIXED-CODE

**File:** `pages/public/machine-control.js` — `authenticate()`.

`POST /api/machine/rest` forwarded the caller's bearer token to
`{ORIGIN}/api/auth/status` and treated a 200 as proof of a session.
`/api/auth/status` is **public by design** — it answers
`{"enabled":true,"has_users":true}` to everyone, because the login screen must
read it before anyone has signed in. Verifying a credential against an endpoint
that answers everyone verifies nothing: any string of 8+ characters passed.

**Verified live:** `Authorization: Bearer totally-invalid-token-1234567890`
reached the suspend path. The only reason the request then failed was that the
machine happened to be in max-run cooldown (`409 machine_not_running`) — on a
running machine that is an anonymous caller suspending the user's box.

**Fix.** Verify against `/api/cron/jobs` instead: read-only, and the endpoint
the 2026-11-15 audit used for exactly this check ("`/api/cron/jobs` 401 on Pages
and direct URL" in `features/audit-2026-11-15/retest-2026-11-15/REPORT.md`).
The response body is now required to parse as an object, so a captive portal
answering 200 HTML still refuses.

**Test:** T101 (66 checks) — the harness stub now models the console honestly
(the buggy target was baked into the STUB as well as the code, which is why it
stayed green; a stub that agrees with the bug proves nothing).

### B-38 · P2 · Three live tests asserted on the DELETED `/desktop` surface — FIXED-CODE

T04, T05 and T06 had been red since the 2026-11-15 computer rebuild, because
they fetched `/desktop`, `/desktop/__lease` and `/desktop/vendor/xterm.js` —
pages deleted with the 8,399 lines. A permanently red row nobody can act on is
its own hazard: it teaches people that red is normal, which is the failure mode
`AGENTS.md` §1 exists to prevent.

Rewritten against the live surface, and made to assert the properties that
matter rather than page copy:

* **T04** — anonymous `/computer/state` must be 401 and must not contain
  `leaseId`/`generation`/`preview`.
* **T05** — anonymous takeover must not return a `leaseId`; anonymous
  `/computer/session` must not return a `policy`.
* **T06** — asserts Content-Type is `javascript` and the body is not the
  console SPA. A 200 with the wrong body type is how B-35 shipped silently.

T04 and T05 fail against the deployed site today, which is exactly what a
regression test for a live vulnerability should do **before** the fix ships.

---

## Part 6 — Found live in a BROWSER, 2026-11-16 16:04 IST (B-36)

### B-36 · P1 · The terminal closed itself after ~60 s while control was still held — FIXED-CODE

**Files:** `pages/public/computer/terminal.js`, `pages/public/computer/router.js`,
`pages/public/computer/ui.html`, `pages/public/computer/rate-limit.js`,
`features/computer/terminal-server.py`.

**Found live**, 12th browser round, reproduced three times: the Terminal tab
worked — prompt appeared, `echo hello-terminal` printed back, Take control and
Release both fine — and then the session closed on its own after about a
minute, with control still held. A short command was fine; real work was not.

**Not the lease.** The 90 s lease renews while the page is open; a probe left
the lease reading 89 s minutes after takeover. The lease was healthy the whole
time.

**Two causes, and both had to be fixed:**

1. `TERMINAL_TTL_MS = 60_000`, and `mintTerminal` set
   `deadlineMs = min(now + 60_000, leaseDeadline)`. The PTY server enforces
   that absolute deadline itself
   (`features/computer/terminal-server.py`, `deadline_passed`), so it killed a
   perfectly healthy shell at 60 s.
2. The BROWSER also armed a local `setTimeout` for the same deadline
   ("close a few seconds early so the user sees `closed`"). So even a shell
   kept alive server-side would have been closed by its own page.

**⚠️ The TTL is not a typo and was NOT raised.** It is a deliberate boundary:
B-4 recorded a terminal outliving its lease by 59 minutes, and the short TTL is
what makes a leaked URL worthless within a minute. Raising it to an hour would
reinstate B-4 exactly.

**Fix — the deadline now tracks the LIVE lease.**

* `renewTerminal()` (Worker) returns a later deadline `min(now + TTL,
  lease.expiresAt + grace)`, signed with the SAME HMAC over
  `(computer, leaseId, deadline)` that the mint-time preamble uses, so one
  verifier covers both and a captured renewal cannot be replayed onto another
  lease. It re-checks the LIVE lease on every call — that is what keeps B-4
  fixed: release control and the next renewal is refused, so the shell dies at
  its last signed deadline.
* `POST /computer/terminal/renew` (rate-limit class `renew`, 40/min — ~2/min
  real, in its own bucket so renewals can never starve the attach that opens a
  shell).
* `KIND_EXTEND = 3` frame: the PTY server accepts a new deadline only if
  (a) the signature verifies for THIS computer and lease, (b) it is strictly
  LATER (`backwards` refused, so a renewal can never shorten or freeze a
  session), and (c) it is inside `EXTEND_HORIZON_MS`. A refused extension is
  NOT fatal — the session keeps its old deadline and runs on, because killing a
  working shell over a malformed renewal is the same class of mistake as B-32.
* The browser re-arms BOTH timers on success and renews at half the remaining
  time; two consecutive failures surface an honest note instead of a scare.
* The renewal endpoint sits under `/computer/terminal/`, which is exempt from
  the session cookie by design (a sealed capability outranks a cookie). What
  actually protects it is the LEASE: no `leaseId` means no deadline. That is
  asserted by test, not assumed.

**Test — 3 layers, all fail-first.**

| Layer | Checks | Fails on the pre-fix tree |
|---|---|---|
| `terminal-server.py --selftest` | 43 (was 26) | the renewed shell dies at its original deadline |
| `harness-terminal-proxy.mjs` | 68 (was 54) | no deadline, no signature, no `unchanged` |
| `harness-terminal.mjs` | 39 | expected the 26-check selftest |

The end-to-end proof is a real shell on a real PTY with a 2 s deadline: it
executes a command, receives a signed extension, is still alive 5 s later
(past the deadline + the 1 s slop), and reports exactly one accepted extension.
A first version of that test used a 2.5 s deadline and **passed with extensions
disabled entirely** — it was measuring the deadline slop, not the fix. Widened
to 2 s deadline / 5 s wait; it now fails without the extension.

**NOT VERIFIED:** no browser has run this. Muse deploys the four Pages files
**and must also sync `features/computer/terminal-server.py` to the machine**
and restart the terminal service — without the new server the extension frames
are ignored and the session still dies at 60 s (the browser would keep renewing
and the shell would still close, which is a confusing half-state worth avoiding).

---

## Part 7 — Found live, 2026-11-17 (the lockout)

### B-39 · P0 · A logged-in user could not open `/computer` at all — the page was gated behind the cookie the page itself mints — FIXED-CODE

**Files:** `pages/public/computer/router.js` (`requiresSession`),
`pages/public/computer/ui.html` (`consoleToken`).

**Found live** 2026-11-17 ~01:20 IST, after a successful console login as
`satwik`: opening `https://qwenpawx.pages.dev/computer` returned **only raw
JSON**, HTTP 401:

```json
{"error":"auth_required","reason":"absent","detail":"Open the QwenPaw console and sign in, then reload this page."}
```

No UI, no Terminal tab, no screen, no rail. A signed-in user could not reach the
computer at all. Re-verified with curl while writing this:

```
GET /computer          -> 401 application/json
GET /computer/         -> 401 application/json
GET /computer/teach.js -> 200            (asset: already exempt)
```

**Cause 1 — the chicken and egg.** `requiresSession()` read:

```js
// Static UI assets: no data, no secret.
if (path === "/computer" || path === "/computer/") return true;
```

The comment and the code disagree, and the comment was right: every other entry
in that block returns `false`. `ui.html` itself was exempt (`*.html`), but the
clean `/computer` URL was not — so the 401 fired **before `serveUi()` ran**.

And that is fatal in a way a normal 401 is not, because the only caller of
`POST /api/session/mint` in the entire tree is `ui.html`'s `ensureSession()`,
which runs **after the page loads**. Nothing else mints: `computerPanelScript`
just links to `/computer`, and `machine-control.js` never mints. So the page
that would have obtained the cookie was locked behind the cookie. A gate on the
door you must open to ask for a key is not a security boundary — it is a
lockout, and it locked out the owner.

**Cause 2 — the wrong storage key (found while fixing cause 1, and it would
have re-created the same lockout with a different error).**
`ui.html`'s `consoleToken()` searched:

```js
["token", "qwenpaw_token", "qwenpaw-token", "access_token"]
```

None of those is the key the console uses. The deployed bundle declares
`Id = "qwenpaw_auth_token"`, reads it in `It()`, writes it in `Z$()` (exported
to the lazy login chunk as `bd`), and sends `Authorization: Bearer <value>`.
So even a reachable page would have found no token, `ensureSession()` would
have returned `false`, and the user would have been told "Sign in to the
QwenPaw console first" **while already signed in**. Both halves had to be
fixed or the bug just changed its error message.

**Fix.**

* `/computer` and `/computer/` return `false`. This is safe for a specific
  reason rather than a hand-wave: `ui.html` is static bytes — no store access,
  no lease, no preview, no shell — and **every endpoint it calls is still
  gated**. An anonymous visitor who loads it sees the honest "sign in first"
  state and obtains nothing. That is also the rule the rest of the block
  already followed: assets exempt, data gated.
* `qwenpaw_auth_token` added **first** in the key list, with the old guesses
  kept as harmless fallbacks for a console rebuild that renames it.

**Why the existing tests missed it — and this is the part worth keeping.**
T88 already had a check for exactly this:

```js
check("/computer itself answers (it is the way in)", ui.status === 200 || ui.status === 401, ...);
```

`200 || 401` accepts the broken answer. It was written during the B-36 work as a
soft sanity check and it stayed green through a total lockout. **A test that
accepts the failure mode it exists to prevent is not a test** — the same lesson
as the 2026-11-15 suite that stayed green while the Worker could not load.

**Test — T88 70 → 88 checks, fail-first 8/88** on the pre-fix tree:

| Assertion | Pre-fix |
|---|---|
| ANON `GET /computer` → 200 | 401 |
| …and it is `text/html`, not JSON | `application/json` |
| …carrying `<!doctype html>` and `/api/session/mint` | the JSON error body |
| …still `frame-ancestors 'self'` | header absent (error path) |
| ANON `GET /computer/` → 200 | 401 |
| `ui.html` reads `qwenpaw_auth_token` | absent |
| …and tries it first | absent |
| serving the page needs no `COMPUTER_DB` | 401 |

Plus the **full user journey, in order**, because the order was the bug:
1. anonymous `GET /computer` → 200;
2. `POST /api/session/mint` with a console token → 200 + `Set-Cookie`
   (`HttpOnly; Secure; SameSite=Lax`);
3. `GET /computer` with that cookie → 200;
4. `GET /computer/state` with that cookie → 200 (the DATA opens only now);
5. and a **rejected** console token mints nothing and sets no cookie, so the
   journey cannot pass against a mint that accepts anyone.

The gate on data is re-asserted immediately after (`/computer/state` and
`/computer/computers` are still 401 anonymously), so exempting the page cannot
silently exempt its children.

**NOT VERIFIED:** no browser has run this. Muse deploys
`pages/public/computer/router.js` and `pages/public/computer/ui.html` to both
Pages projects. No machine sync and no secret change is needed — the session
secret and every data-endpoint rule are untouched.

---

## Part 8 — Found live in a BROWSER, 2026-11-17 ~12:07 IST (B-40)

### B-40 · P2 · A red diagnostics panel permanently covered ~26% of `/computer`, because a SUCCESSFUL probe was written into it as an error — FIXED-CODE

**File:** `pages/public/computer/ui.html` (`#jsErrorBar`, the three window
error listeners, and the `loadScreen()` probe).

**Found live** by the user at 2026-11-17 ~12:07 IST, on a page that was
otherwise working (T106 had just passed). A large red panel sat on the left
~26% of the viewport, white monospace, three lines:

```
Screen probe: fetch vnc.html -> HTTP 200 : <!DOCTYPE html>
<html lang="en" class="noVNC_loading">
<head><style>#noVNC_status{display:none!important}</style><script
```

**It was not reporting an error — it was reporting HTTP 200.** That is the
whole defect, and it is the second time this class has appeared in this
register: *a healthy result rendered as an alarm*. The first was B-35, where a
`<script src>` answered with HTML parsed as nothing and nothing anywhere said
so. The fix for B-35 added a probe; the probe then leaked its success payload
into the error panel.

**Cause.** `loadScreen()` fetched the vnc.html screen page, took
`.text().slice(0, 120)`, and wrote it into the visible bar *unconditionally* —
before checking `probe.ok`. So every successful load painted 120 characters of
markup into a red box, and then mounted the frames. Two further problems in the
same block:

* It **gated mounting on that fetch**. A same-origin `fetch` of a capability
  URL can fail for reasons that never affect an iframe, and it doubled the
  capability's request count on every take/release — while the iframe's own
  load/`postMessage` state already drives `setPhase` with a
  `FRAME_LOAD_TIMEOUT_MS` timer.
* The panel was a **body child above `#rail`**, so it consumed layout width
  rather than overlaying.

**Fix.**

* The bar element is gone, and so is every write to it — the three window
  listeners now only *collect*.
* The probe is gone: `loadScreen()` sets `state.screenUrl` and calls
  `mountFrames()` directly. Failures are reported by the mechanism that can
  actually observe them (`setPhase` + the stage/overlay veil + the iframe's
  `postMessage` states).
* **Every user-facing message is kept**, and the test asserts each one:
  "Sign in to the QwenPaw console first", "Your console session expired",
  "The shell closed. Take control again to reopen it.", "The screen did not
  respond", "Take control to connect.", and the veil text. Only the raw-markup
  dump went.
* `window.__computerErrors` is **kept**. It is the devtools-accessible record
  that made the B-33/B-35 classes diagnosable and it costs nothing when nothing
  fails. It is simply no longer rendered.

**Test — T105 32 → 50 checks, fail-first 6/50** on the pre-fix tree. Asserted
through the REAL router (`GET /computer`), because the defect is about what a
browser receives:

| Assertion | Pre-fix |
|---|---|
| no `jsErrorBar` element in the served page | present |
| no inline red bar styling (`background:#7f1d1d`) | present |
| no probe result assigned to visible text | present |
| the screen page is not fetched just to print its body | `fetch(screenPage` |
| nothing renders `__computerErrors` | rendered |
| "nothing is written into a visible error bar" (source check) | written |

The five must-keep message checks and the four structural checks (rail, tabs,
`termHost`, `previewFrame`) were verified to pass on **both** the old and the
new file — so this test cannot be satisfied by deleting the page.

Two notes from writing it, both worth keeping:

* The first version of "no probe result is rendered" matched the phrase
  `Screen probe` anywhere in the document and **failed on the fixed file**,
  because the fix's own comment quotes it. A comment cannot put anything on
  screen. It now matches `textContent = "Screen probe...`, i.e. the rendering.
* For the record, since it looks like a contradiction: a direct
  `GET /computer/ui.html` answers **404 by design** (verified). `ui.html` is an
  asset that `serveUi` reads from the ASSETS binding and returns at `/computer`;
  it is not a route. B-39's statement that "`ui.html` itself was exempt
  (`*.html`)" refers to the gate's exemption list, not to a working URL — the
  page was only ever reachable at `/computer`, which is what was locked.

**NOT VERIFIED:** no browser has run this. Muse deploys
`pages/public/computer/ui.html` to both Pages projects. No machine sync, no
secret change, and no change to the session gate or any data endpoint.
