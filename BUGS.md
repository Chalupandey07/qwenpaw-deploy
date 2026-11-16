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

### B-29 · P0 · The terminal route never proxies — it returns JSON

**File:** `pages/public/computer/router.js` — the `/computer/terminal/` branch.

The terminal tab mints a capability (`POST /computer/terminal/session` → 200,
a URL, a deadline) and then opens a WebSocket to `<cap>/websockify`. But the
GET/upgrade branch at `path.startsWith("/computer/terminal/")` calls
`authorizeTerminal()` and, when authorised, **returns `json({ok:true, ...})`**.
It never proxies to websockify and never tunnels an upgrade.

So the browser's terminal socket gets a JSON body instead of a 101. The UI's
own `close` handler fires, and at ~15 s it reports "The shell closed" — while
the lease is still held, which is exactly what the browser test saw
(Session "closed", Holder "you", 86–88 s of lease remaining). The 15 s is not a
server timeout: it is the client giving up on a socket that was answered with
the wrong kind of response.

**Fix (not applied):** that branch must, after authorising, proxy to
`COMPUTER_TERMINAL_ORIGIN` and tunnel the 101 exactly as `proxyScreen` now
does for the screen. The authorisation half is already correct and tested
(T92, 39 checks) — it is only the transport that is missing.

**Why T92 did not catch it:** T92 drives the router and asserts the
authorisation *decisions* (403/409/503/200-on-authorised). It asserts that an
authorised request is answered `{ok:true}` — which is the bug, asserted as if
it were the contract. A test can only catch what it is written to question.

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

## Part 3 — Summary

| Severity | Open | Fixed in code | Ids |
|---|---|---|---|
| P0 | **0** | 1 | B-1 fixed and re-applied |
| P1 | **0** | 5 | fixed: B-2, B-3, B-4, B-22, B-23 |
| P2 | **0** | 16 | fixed: B-5, B-6, B-7, B-8, B-9, B-10, B-11, B-12, B-13, B-19, B-20, B-24, B-25, B-26 |
| P3 | **0** | 5 | fixed: B-14, B-15, B-16, B-17, B-27 |
| **Total** | **0 open** | **30 fixed** | of 30 findings |
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
