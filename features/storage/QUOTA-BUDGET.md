# Quota budget — QwenPaw Cloudflare storage (Free tier)

Written 2026-11-15 after the KV burn of 2026-11-15 (lease-watcher
unconditional preview uploads, ~11,500 writes/day, spent the whole
account's 1,000/day KV budget by mid-morning and broke every write path
at once while reads kept working). All numbers below are computed from
the actual source in this repo, not estimated from dashboards.

## Governing free limits (Cloudflare, verified 2026-11-15)

| Limit | Free value | Scope | Resets |
|---|---|---|---|
| KV writes (put + delete) | 1,000 / day | **per account, all namespaces combined** | 00:00 UTC |
| KV reads | 100,000 / day | per account | 00:00 UTC |
| KV value size | 25 MB | per key | — |
| KV, one write per key | 1 / second | per key | — |
| Workers requests | 100,000 / day | per account (Pages Functions count) | 00:00 UTC |
| Workers CPU | 10 ms / invocation | per invocation | — |
| D1 rows written | 100,000 / day | per account | 00:00 UTC |
| D1 rows read | 5,000,000 / day | per account | 00:00 UTC |
| D1 max row / string / BLOB | 2 MB | per row | — |
| D1 storage | 500 MB / DB, 5 GB / account | per DB / account | — |
| D1 queries / invocation | 50 (Free) | per Worker invocation | — |
| Durable Objects requests | 100,000 / day | per account | 00:00 UTC |
| DO KV-backend value | 128 KiB | per value | — |
| DO SQLite-backend key+value | 8 MB combined | per key | — |

The KV write limit is the binding constraint: it is **shared across
every namespace** (STATUS + DESKTOP_KV + groupchat/board KV use), so a
burn in one worker breaks all of them at once. D1's 100,000 rows/day is
100x larger and is the reason for the migration (see SCHEMA.md).

## KV write paths — worst case per day (hard use)

"Hard use" = one user, control held 24 h, screen changing constantly,
machine waking every 5 min, routines firing on every cron, teach /
needs-you bursts. A dash means the path did not exist or was not the
burn source at that time.

| # | Path | Trigger | Current worst/day | Optimized (KV) worst/day | Notes |
|---|---|---|---|---|---|
| K1 | keep-alive status put | cron */5 min | 288 | **~1–10** | Write only on state change (status / lastUpAt / consecutiveFailures). A steady "up" day writes ~1. |
| K2 | keep-alive /ping, /status?live=1, /wake | manual | unbounded (1/req) | **~10–50** | Same change-only rule; manual use is rare. |
| K3 | keep-alive API-wake marker | offline/waking + key set | 144 (10-min gap) | **144** | Key currently UNSET, so 0 today. Only when a wake actually fires. |
| K4 | routines history put | cron 49/day | 49 | **~1–5** | Append only when the entry differs from the last (kind/status/httpStatus/activeRoutines). Identical ticks collapse. |
| K5 | routines /trigger | manual, 1/min rate limit | 4,320 (3 puts x 1,440) | **300** | 3 puts per trigger; new soft cap 100 triggers/day (approximate — see guard note). |
| K6 | routines /api/routines | manual, token-gated | unbounded (1/req) | **unbounded, rare** | Definition changes only; a human edits a handful/day. |
| K7 | routines prunePending deletes | /trigger, only when >20 pending | <=20 / trigger | **<=20 / trigger** | Deletes count as writes (conservative). Only fires over the 20-entry cap. |
| K8 | desktop __heartbeat | 15 s while control held | **5,760 / computer** | **1,440 / computer** | 60 s interval, renew on each accepted heartbeat, TTL 90 s (30 s margin). Two computers held 24 h = 2,880. |
| K9 | desktop __takeover + __release | user action | 4 / cycle, unbounded | **4 / cycle, unbounded** | 2 writes each (lease + generation). Human-driven; a script looping take/release could still burn — see guard. |
| K10 | desktop __wake marker | manual, 60 s throttle | 1,440 | **1,440** | 1 put per un-throttled wake. Guard-gated as non-essential (the wake itself still proceeds if the marker write is dropped). |
| K11 | desktop __preview-upload | watcher, change-only + 120 s floor | 1,440 (2 computers) | **1,440** | Already optimal-ish; guard-gated as non-essential, so it is the first thing dropped over cap. |
| K12 | desktop __needs-you / resolve | agent raise / user answer | 1 + 1 / event | **1 + 1 / event** | Rare; essential (never dropped by the guard). |
| K13 | desktop __teach | user saves a skill | 1 / skill | **1 / skill** | Rare; essential. |
| K14 | desktop __mode | user switches Team/Private | 1 / switch | **1 / switch** | Rare; essential. |
| K15 | desktop __pending-skills/ack | watcher, per delivered skill | 1 / skill | **1 / skill** | Rare; essential. |
| K16 | budget-counter flush | per isolate, on every 25th local write | — (new) | **<= ~50 / day total** | Flushed only when the isolate's local count hits a multiple of 25, so counter writes are <= total-writes/25 + isolates. Never per write, never on a timer. |
| | **TOTAL, adversarial hard use** | | **~13,000+/day** | **~6,000/day** | Still over 1,000 on KV. See the honest conclusion below. |
| | **TOTAL, realistic hard use** (one user, control held a few hours, screen mostly static) | | ~1,500–3,000/day | **~150–400/day** | Comfortably under the cap with headroom. |

### The honest conclusion (Astra review 2026-11-15, verified against source)

KV optimization alone **cannot guarantee** < 1,000 writes/day under
adversarial hard use: a 24 h control hold is 1,440 heartbeat writes
per computer on its own, and previews add up to 1,440 more. The
optimization buys a large margin for realistic use (typical day drops
from ~1,500–3,000 to ~150–400) and stops the casual burn, but the
guarantee only comes from D1 (100,000 rows/day — the same hard-use
day is ~4,600 rows, 4.6% of the limit). That is why the migration is
the priority, not an optional follow-up.

### The write-budget guard (KV phase)

- Soft cap **700 writes/day total**, split per namespace so the sum
  stays under the 1,000 account cap with headroom: **STATUS 250**
  (keep-alive + routines share one counter key in STATUS) +
  **DESKTOP_KV 450** = 700, leaving 300 for counter flushes (~50),
  estimation error, and any other account user.
  (Earlier draft said 350 + 650 = 1,000 — arithmetic error caught in
  review: that left zero headroom.)
- Counting: one counter key `budget:<YYYY-MM-DD>` per namespace.
  Each isolate keeps an in-memory count, seeded from the KV counter
  at isolate start (cached 5 min). The counter is flushed to KV only
  when the isolate's local count hits a multiple of 25 — never per
  write and never on a timer (a per-minute flush from many isolates
  would itself burn up to 1,440 writes/day and still would not be a
  global bound: KV has no CAS and isolates are per-edge, so the
  stored value is a lower bound, not an exact total).
- Enforcement: non-essential writes (preview upload, keep-alive
  status, routines history, wake-throttle marker) are dropped with an
  honest 503 (`store_unavailable`) once the cap is hit. Essential
  writes (takeover, heartbeat, release, needs-you, teach, mode, ack)
  are always allowed — they are user-initiated control actions whose
  loss would be worse than the quota, and they are rare except the
  heartbeat, which is why the heartbeat interval is throttled.
- The guard is a circuit breaker for pathological bursts, not an
  exact accountant. The static throttles (60 s heartbeat, 120 s
  preview floor, change-only status/history) are what keep a normal
  day under budget; the guard stops a bug from burning the rest.

### Heartbeat timing (corrected in review)

The first draft (45 s interval + server skips the write when >30 s
remain) has an expiry-boundary bug: at t=45 s, 45 s remain so the
server skips; at t=90 s the lease expires exactly as the next
heartbeat arrives, and renewing an expired lease must be rejected
(410) or ownership races appear. Shipped scheme: **client 60 s,
server renews on every accepted heartbeat, TTL 90 s** — 1,440
writes/day per held computer, ~30 s of margin, and a single failed
request is absorbed by an immediate one-time retry. The chrome also
stops heartbeating while the tab is hidden (`visibilitychange`) so a
hidden tab loses control in ~90 s, as designed.

## Workers requests — worst case per day (hard use)

| Path | Current / day | Optimized / day | Notes |
|---|---|---|---|
| lease-watcher __lease polls (2 computers) | 34,560 (5 s) | **17,280 (10 s)** | Control-file staleness bound is 30 s, so 10 s still renews safely. |
| chrome __heartbeat | 5,760 (15 s) | **1,440 (60 s)** | Per open /desktop tab. Side-panel iframe is a second instance when open. |
| chrome __needs-you poll | 8,640 (10 s) | **8,640** | Read-only; only while /desktop open. |
| chrome __status during boot | ~36 / boot (5 s x 3 min) | **~36** | Capped at 3 min by WAKE_TIMEOUT_MS. |
| keep-alive cron | 288 | **288** | 1 invocation per tick. |
| routines cron | 49 | **49** | 1 invocation per tick. |
| console proxy (all console traffic) | ~2,000–5,000 | **~2,000–5,000** | Every page load / API call / SSE stream through Pages. Cannot be reduced without breaking the console. |
| groupchat / board DO requests | small | small | A handful per user action. |
| **TOTAL, realistic hard use** | ~52,000 | **~30,000** | Under the 100,000/day limit with ~3x headroom. Two /desktop tabs open 24 h add ~10,000 more — still under. |

## KV reads — worst case per day

| Path | Reads / day | Notes |
|---|---|---|
| watcher __lease (2 reads: lease + generation) | 34,560 | 17,280 polls x 2. |
| chrome __needs-you poll (1 read) | 8,640 | Only while /desktop open. |
| chrome __status / __lease (2 reads) | small | Boot + mode switches only. |
| keep-alive / routines status reads | ~1,000 | Cron + manual reads. |
| **TOTAL** | **~45,000** | Under the 100,000/day KV read limit. |

## D1 — worst case per day after migration (same hard use)

| Operation | Rows / day | Notes |
|---|---|---|
| heartbeat upserts (2 computers, 60 s) | 2,880 | Lease row + generation row per beat, or 1 row if combined — counted as 2 to be safe. |
| preview upserts | 1,440 | One row per computer, upsert replaces the image. |
| keep-alive status upserts | ~10 | Change-only. |
| routines history inserts | ~5 | Change-only, bounded to 50 rows (oldest pruned). |
| triggers / teaches / modes / needs-you | ~350 | Capped trigger volume + rare user actions. |
| board ticket ops (create/update/comment/mark-sent/delete) | <= 1,000 / IP / day | Hard cap from the DO rate limiter (30/min/IP + 1,000/day/IP on mutations). One D1 row per op; a single user can never exceed 1,000 rows/day no matter how hard they click. |
| board rate-limit checks | 0 D1 rows | Counted by the Durable Object (BoardRateLimiter), not D1 — each check is one DO subrequest against the 100k/day Workers/DO allowance, not a D1 row. |
| budget counter (atomic SQL increment) | ~0 | Counter becomes one exact row, updated with the write itself (no separate flush). |
| **TOTAL writes** | **~5,700** | **5.7% of the 100,000/day D1 limit** (4,700 + up to 1,000 board ops). |
| watcher polls (2 rows per poll) | 34,560 rows read | 17,280 polls x 2 rows. |
| chrome polls | ~10,000 rows read | Needs-you + status. |
| **TOTAL reads** | **~45,000** | **0.9% of the 5,000,000/day D1 limit.** |

D1 storage: 2 preview BLOBs (<=1.5 MB each) + small rows = < 10 MB
of the 500 MB per-database limit. History is bounded (50 rows);
pending triggers expire (7-day TTL enforced in SQL, D1 has no
automatic TTL — see SCHEMA.md).

## What the audit found beyond quota (bugs fixed in this pass)

See the report for the full list. Headlines: the heartbeat
expiry-boundary bug above (would have dropped healthy holders), the
budget-counter flush burn, the 350+650 arithmetic error, and the
wake-throttle marker being written even when the wake was already
throttled (it was not — verified: the write sits after the throttle
check; kept as-is and guard-gated instead).

## D1 phase — LIVE 2026-11-15 (verified)

The migration is done (see SCHEMA.md + migrate-kv-to-d1.py). All three
Workers now write to the `qwenpaw-state` D1 database (USE_D1=1); KV is
the fallback only. **Board migrated the same day** (features/board/):
tickets moved from one KV value to the `tickets` table (one row per
ticket, 0 rows imported — the board was empty), rate limiting added
via the `BoardRateLimiter` Durable Object; live proof 30×401 + 5×429
from the machine, test T63. Verified live 2026-11-15 ~08:12 UTC:

- Pages worker (qwenpawx `50600362`, frontend `572c5932`): `/` 200,
  `/desktop` gate 200, `__lease` default gen 19 / qa gen 2 (read from
  D1). **Previews land in D1 as raw BLOBs**: `previews` has both rows
  (default 500,429 B, qa 707,640 B, updated 08:12:10/11 UTC) — the
  watcher -> Pages worker -> D1 write path is proven end-to-end.
- Keep-alive (D1 binding + USE_D1=1 confirmed in the worker settings):
  `/ping` returns fresh "up". The stored D1 row is a clean steady
  "up" (checkedAt 07:55:59, errorCode null) — the change-only logic
  correctly SKIPS the write, so the row does not advance on a steady
  day. That is the design working, not a missed write. The keep-alive
  D1 write fires on the next state change (machine pause/wake); it
  shares the exact store code the Pages worker just proved live.
- Routines: `/api/status` 200, qwenpaw "up", 2 routines (definitions
  read from D1); `/api/history` returns the 29 rows from D1 (newest
  first, first entry 07:30 wake-tick). History write (29 -> 30 rows)
  did NOT happen on the 08:30 UTC tick — correctly: pushHistory is
  change-only and the 08:30 wake-tick is identical to the 07:30 one
  (only `at` differs, and `at` is excluded), so the write is skipped
  by design. The routines D1 write fires on the next DIFFERING tick
  (the 01:30 UTC daily-summary slot is the next guaranteed one — a
  different kind, so it writes). Same for keep-alive: its D1 write
  fires on the next state change (machine pause/wake). The shared
  store code is proven by the harness (38/38) and by the Pages
  worker's live D1 writes (previews); the keep-alive/routines
  write paths differ only in their (correct) change-only gates.
- KV budget status: SPENT for 2026-11-15 UTC (error 10048 verified on
  both namespaces at ~07:57 UTC). Nothing writes to KV now; the D1
  cutover is what restored write functionality today instead of
  waiting for the 00:00 UTC reset (05:30 IST 2026-11-16).

Post-D1 worst case (hard use, same scenario as above): ~4,700 D1
rows written/day (4.7% of the 100,000 limit), ~45,000 rows read/day
(0.9% of 5,000,000), < 10 MB stored. KV writes: 0 (fallback only).
The 1,000/day KV cap can no longer break the system.
