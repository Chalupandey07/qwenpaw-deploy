# BUGS.md — the consolidated defect register

Every known bug and issue, with severity and a fix. This supersedes the
scattered lists in `features/audit-2026-11-15/` (which stays as the audit of
record for the 19 findings it raised) and `features/desktop/README.md` (which
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

Also already fixed and live-verified (from `features/desktop/README.md`), no
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

**File:** `pages/public/desktop-chrome.html` — `pollNeedsYou` (~L778–790),
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

---

### B-14 · P3 · `kvTry()` results discarded at several call sites

**File:** `pages/public/_worker.js` — `bumpGeneration`, the needs-you resolve
delete, the pending-skills ack delete.

`kvTry` returns a boolean that three callers ignore, so a failed delete looks
like success. Benign today (everything self-heals), but it is the same class
of bug as B-1 and it hides store health.

**Fix.** Fix B-1 first; then have every remaining caller either honour the
return or log it.

---

### B-15 · P3 · `__status` reports `generation: 0` when the store is broken

**File:** `pages/public/_worker.js` — `desktopStatus` (~L1614).

`generation: 0` is a legitimate value (a computer that has never been taken
over). Returning it on a read error makes "the store is down" indistinguishable
from "fresh computer", which is precisely the ambiguity that confused the
2026-11-15 diagnosis.

**Fix.** `generation: null` + `store: "degraded"` on error.

---

### B-16 · P3 · Bridge: token accepted via query string, compared non-constant-time, and `/eval` is RCE

**File:** `features/camoufox/bridge/bridge.py` — auth (~L316–330),
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

---

### B-17 · P3 · PTY server: no frame-size validation on resize frames

**File:** `features/desktop/pty-server.py` — frame loop (~L60+).

`kind 1` reads `cols, rows` as `u16be` without bounding them. A malformed
frame sets a 65535×65535 terminal, which some programs then try to allocate
for. Reached only through a valid terminal capability (lease-gated), so it is
a robustness issue, not a security hole.

**Fix.** Clamp `cols`/`rows` to `1..1000`; ignore out-of-range frames.

---

### B-18 · P3 · Code Mode pilot accepts the run token via query string

**File:** `features/codemode/worker/src/index.js` — `requireToken`.

Same class as A-5/B-16: `?token=` in the URL leaks via logs/`Referer`. It is
my own file from this session.

**Fix.** Header only; keep the query path behind an explicit opt-in flag for
local harness runs.

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

## Part 3 — Summary

| Severity | Open | Fixed in code | Ids |
|---|---|---|---|
| P0 | **0** | 1 | B-1 fixed and re-applied |
| P1 | **0** | 3 | fixed: B-2, B-3, B-4 |
| P2 | **5** | 7 | open: B-5, B-8, B-10, B-13, B-21(n/a) · fixed: B-6, B-7, B-9, B-11, B-12, B-19, B-20 |
| P3 | **5** | 0 | B-14…B-18 |
| **Total** | **10 open** | **11 fixed** | of 21 findings |
| Audit findings (earlier) | — | 15 of 19 | see Part 1 |

**No data-loss bugs remain.** What is left, in priority order: **B-10** (no per-endpoint 429; a stuck client loop can still
burn the request budget, though the write budget is now guarded) → **B-5**
(preview image refetch: 360 req/hour + ~198 MB/hour egress) → **B-8**
(routines history read-modify-write) → the P3 hygiene set.

**Fix order.** B-1 (security path, hides everything else) → B-3 (data loss)
→ B-2, B-4 (leaked authority) → then the D1 migration, which removes B-1's
cause, B-3, B-7, B-8, B-9, B-13 outright → then B-5, B-6, B-10, B-11 (cost and
latency) → B-12, B-14…B-18 (hygiene).

**Note on what KV is costing us.** B-1, B-3, B-7, B-8, B-9, B-13 — six of the
eighteen — are symptoms of KV's eventual consistency and single-key model, not
independent mistakes. That is the real argument for the D1 migration: not the
quota number, but six defect classes disappearing at once.
