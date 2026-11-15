# Storage — off KV, onto D1

The Cloudflare KV free tier allows **1,000 writes/day per account**
(shared across all namespaces). The lease-watcher's unconditional
preview uploads burned that budget by mid-morning on 2026-11-15,
which broke every write path at once (takeover, mode, needs-you all
answered 500 while reads kept working). This directory is the fix.

## Files

- `QUOTA-BUDGET.md` — the audit: every write path, worst-case
  writes/day under hard use, the governing free limit, and headroom
  (KV phase and D1 phase, both verified live).
- `SCHEMA.md` — the D1 schema (`qwenpaw-state`,
  `5f58a2f8-e4bb-45e5-8a94-4fc283b90871`), the key -> table routing,
  and the decisions (previews as raw BLOBs, R2 rejected, board
  follow-up, atomic lease ops follow-up).
- `store.js` — the KV-shaped store over D1. `createStore(env, kv)`
  returns `{ get, put, delete, list }` with the same signatures the
  Workers already use, so call sites change only the binding source.
  D1 when `USE_D1 === "1"` and `env.QWENPAW_DB` is bound, otherwise
  the KV namespace (fallback). Inlined into each worker (Pages
  `_worker.js` and the API-uploaded standalone Workers are single
  files with no bundler — keep the copies in sync with this file).
- `harness-store.mjs` — 38 tests for the store against a mock D1
  backed by real SQLite (`node:sqlite`). Run:
  `node features/storage/harness-store.mjs` (38/38).
- `migrate-kv-to-d1.py` — the migration: access check, create/reuse
  the DB, create the tables, export KV -> import D1, attach the D1
  binding + `USE_D1=1` to both Pages projects, deploy, verify,
  rollback (flip the flag back; KV data is never deleted).
- `kv-export-2026-11-15.json` — the KV snapshot exported at migration
  time (8 keys; no secrets in it — status, definitions, history,
  generations, mode, last-wake timestamps only).

## Live state (2026-11-15)

- D1 database `qwenpaw-state` created, 12 tables, data imported
  (generations 19/2, mode private, status, 29 history rows,
  2 definitions, 0 leases, 0 previews at import time).
- All three Workers deployed with the D1 store + `USE_D1=1`:
  Pages qwenpawx `50600362` + frontend `572c5932`; keep-alive and
  routines via `cf.py put-worker` with the D1 metadata.
- Verified: Pages reads generations from D1; previews land in D1 as
  raw BLOBs (500,429 B / 707,640 B); routines reads definitions from
  D1; keep-alive returns fresh probes and skips the write on a steady
  "up" day (change-only working as designed).
- KV budget is spent for 2026-11-15 UTC (error 10048) — nothing
  writes to KV now. D1 restores write functionality immediately.

## Rollback

Set `USE_D1=0` (Pages: PATCH the env var on both projects;
Workers: redeploy with the metadata without the `USE_D1` var) and
redeploy. KV data was never deleted. Leases expire within 90 s, so
a stale KV lease is harmless; the only durable loss on a flip-back
is teach skills / routine definitions / history written to D1 after
the cutover — see `migrate-kv-to-d1.py rollback`.
