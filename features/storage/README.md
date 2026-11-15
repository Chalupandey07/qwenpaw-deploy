# Storage — D1 + R2 migration

**Status: schema validated locally. NOT deployed, NOT migrated.** Muse
deploys and verifies.

## Why migrate at all

Not primarily the quota. These six defects are all symptoms of KV's eventual
consistency and single-key model, and all six disappear at once:

| Bug | KV symptom |
|---|---|
| B-1 | generation + lease were separate uncoordinated writes |
| B-3 | all tickets in one value → lost updates, O(n) writes |
| B-7 | whole status blob rewritten every 5 min |
| B-8 | routines history was read-modify-write of one array |
| B-9 | clients papered over stale generation reads |
| B-13 | 200–250 ms sleeps to tolerate replication lag |

D1 is strongly consistent and single-threaded, so takeover becomes a real CAS
in one statement and the generation bump rides in the same `batch()`.

## The claimed write bound was wrong — start here

`features/desktop/README.md` and PLAN.md claimed the throttled watcher bounds
KV writes "well under 1,000/day". Checked against the actual constants:

| Writer | Writes/day |
|---|---|
| Lease heartbeat while control is held (15 s) | 5,760 |
| Previews, 2 computers, screen changing (120 s floor) | 1,440 |
| Keep-alive `saveStatus` (5 m) | 288 |
| Routines tick + daily slot | 49 |
| **Total** | **7,537** |

**7.5× the free budget.** The throttle only made the *idle* case cheap
(337/day). One user holding control for a day still exhausts it. The
write-on-change fix for keep-alive (B-7) and the adaptive poller help, but the
heartbeat alone is 5,760/day and cannot be reduced without weakening takeover.

**D1 does not care:** 5,760 row-writes/day against 100,000 is 5.8%.

## Verified free-tier limits (2026-11-15)

| Service | Free limit |
|---|---|
| D1 rows written | 100,000/day |
| D1 rows read | 5,000,000/day |
| D1 max row / BLOB | **2 MB** |
| D1 queries per Worker invocation | **50** |
| D1 storage | 5 GB total |
| D1 Time Travel | 7 days |
| R2 storage | 10 GB-months |
| R2 Class A (writes) | 1,000,000/month |
| R2 Class B (reads) | 10,000,000/month |
| R2 egress | free |
| Workers requests | 100,000/day |
| KV writes / reads | 1,000 / 100,000 per day |
| Durable Objects requests | 100,000/day |

## Previews go to R2, not D1

The 2 MB row cap is **not** the blocker. Measured previews are 243–707 KB, so
they would fit. The blocker is **volume**:

- 2 computers × (86,400 s / 120 s floor) × ~550 KB ≈ **0.79 GB/day**
- ≈ **24 GB/month** against **5 GB total** → exhausted in **6.3 days**
- R2 at the same cadence: 43,200 Class A ops/month of 1,000,000 (4%)

And R2 can **overwrite one key** (`preview/<computer>.png`), so storage stays
flat at ~1.1 MB forever instead of growing per capture. The `preview` table
holds `r2_key` + `sha256` + `bytes` only.

Serving: `GET /desktop/__preview?computer=X&v=<sha256>` with `ETag: <sha256>`
and `304` on match. The needs-you record carries the current `sha256`, so the
banner's `<img>` only changes when the screen does — which also fixes B-5
(360 requests/hour + ~198 MB/hour of egress for a static screen).

## Schema

`schema.sql`, validated by `test_schema.py` (15 checks) against SQLite — D1's
engine, so DDL compatibility is a real check rather than a proxy. It asserts:

- the schema applies cleanly and is idempotent;
- **one lease per computer is an engine guarantee** (PRIMARY KEY), not a
  convention;
- `follow_up` is a strict 0/1 `CHECK` (the old board coerced the string
  `"false"` to `true`);
- **every hot query is indexed** — `EXPLAIN QUERY PLAN` shows no full-table
  scan. On D1 an unindexed query is a row-read *charge*, so a missing index is
  a billing bug;
- keepalive is a single row;
- `preview` has **no bytes column**.

### Takeover as one atomic batch

```sql
-- batch() counts as ONE query against the 50-per-invocation limit.
INSERT INTO lease (computer, lease_id, holder, granted_at, expires_at, fence)
VALUES (?1, ?2, 'user', ?3, ?4, 1)
ON CONFLICT(computer) DO UPDATE SET
  lease_id   = excluded.lease_id,
  granted_at = excluded.granted_at,
  expires_at = excluded.expires_at,
  fence      = lease.fence + 1
WHERE lease.expires_at < ?3          -- only if the old lease lapsed
RETURNING lease_id, expires_at, fence;

UPDATE computer SET generation = generation + 1, updated_at = ?3
WHERE name = ?1
RETURNING generation;
```

Zero lease rows returned = `409 held`. No read-then-write race, no
"atomic-ish" caveat, and `generation` cannot be silently lost (B-1) because
the bump is in the same transaction.

## Migration procedure (Muse)

Do **not** do this in one deploy. One snapshot, no staging box.

1. **Bookmark** — D1 Time Travel keeps 7 days; take a manual bookmark first.
2. **Create** the database and apply `schema.sql`.
3. **Backfill** only the state that matters: lease, generation, needs_you,
   taught skills, modes. Routines history and keep-alive status may start
   empty — they are reporting, not state.
4. **Dual-write** KV + D1 for one day; compare on every read. This is the
   step that catches a wrong assumption while KV is still authoritative.
5. **Read D1, write D1.**
6. **Remove KV.** Then a spent KV quota can never break the desktop again —
   which is the actual lesson from 2026-11-15.

## Quota-proofing beyond the migration

**Be honest about what is achievable.** "Never hit a quota however hard it is
used" is impossible on metered services — any authenticated endpoint can be
looped. What is achievable:

1. **Cost proportional to user action, never to wall clock.** The KV burn was
   time-proportional (every 15 s regardless of use).
2. **Every write conditional and idempotent**, so a retry storm does not
   multiply writes.
3. **A local budget counter that 429s before the platform quota is gone.**
4. **Graceful degradation** — serve cached reads rather than failing writes.

Concretely, per service:

| Service | Rule |
|---|---|
| Workers 100K/day | fixed pollers under 10K/day (done: 34,560 → 6,480 idle) |
| KV 1K writes/day | target **zero** after migration |
| D1 100K writes/day | fine once previews leave for R2 |
| D1 5M reads/day | index everything; always `LIMIT`; never `SELECT *` on history |
| D1 50 queries/invocation | batch writes (`batch()` = 1 query) |
| DO 100K/day | fine at human pace; never put a heartbeat in a DO |

## Not done yet

- The Worker rewrite to read/write D1 (this directory is schema + validation).
- The backfill script.
- The R2 binding and the `/__preview` ETag path.
- Deleting the KV namespaces (last, deliberately).
