# PLAN.md — roadmap and status

> **This file is the single source of truth for "what is the state of the
> work".** It is rewritten, not appended to. History lives in git; the
> incident log and root causes live in `features/desktop/README.md` and
> `BUGS.md`.
>
> Status vocabulary: **DONE** (verified live by Muse) · **CODE** (written,
> tested locally, awaiting Muse's deploy+verify) · **WIP** (partially built)
> · **BLOCKED** (needs a key/decision/user action — say which) · **TODO**.

## Goal

A QwenPaw agent on InstaBox **Free** that is *actually usable*: the user can
watch and drive a real desktop from the console, the agent can act on it, and
the whole thing stays inside free quotas no matter how it is used.

Non-negotiables: Free tier only · English only · no China endpoints · no
secrets in git · no invented keys · nothing claimed live without a live check.

---

## Phase 0 — Foundation (DONE)

Console behind a Pages proxy, auth gate, embedded desktop with the
view/control split, per-bot second display, terminal, teach-by-showing,
needs-you, side panel, previews, maintenance menu.

- **DONE**, browser-verified 2026-11-15 06:58 IST (all six checks: stream
  renders, one pill that clears, terminal shell, Private renders, side panel
  agrees, idle stays Live).
- Snapshot `qwenpaw-phase0-verified` (`sn_agq53pcvh6nfxjbyc4pfuk3vua`) is the
  restore point.

## Phase 1 — Prove it works (mostly DONE)

61-test catalogue (`features/test-project/TESTS.md`), runner, log-check tool.

- **DONE**: protocol suite green — Round 4: 48 PASS, 0 FAIL, 1 KNOWN-GAP
  (mailbox never configured), 8 NEEDS-BROWSER, 4 NEEDS-TOKEN.
- **DONE**: log-check option (`features/test-project/logcheck/`) — 8 machine
  logs + 15 service states + 8 remote statuses in ~8 s.
- **BLOCKED (Muse)**: T50–T57 browser rows. **The KV quota resets midnight
  UTC = 05:30 IST.** Run `features/test-project/preflight.py --probe-write`
  first — it exists because the 11:27 round lost three tests to a spent quota
  no protocol test could see.
- **BLOCKED (user)**: T58–T61 need user-held tokens (console password,
  `GROUPCHAT_TOKEN`, board key, eval credentials). Never invented.

## Phase 1.5 — Correctness (in progress, this pass)

The security/correctness defects found by reading the current source. Full
detail, severity and fixes in **`BUGS.md`**.

| Item | Status |
|---|---|
| B-1 `bumpGeneration` reported generations it never persisted (P0) | **CODE** — fixed + 7 new tests; old worker fails 5 of them |
| B-4 terminal capability outlived its lease by ~59 min (P1) | **CODE** — clamped to lease + 30 s grace; 42a/42a2/42b |
| B-9 client could inflate the generation (P2) | **CODE** — "may lag, never lead"; test 43 |
| Idle-adaptive lease-watcher polling (IMPROVEMENTS §9.2) | **CODE** — 34,560 → 6,480 req/day idle (83%); 28 checks (T69) |
| Pricing resolver for custom providers (T71) | **CODE** — never invents a price; optional catalogue; 20 checks |
| Content-aware routing (T72) | **CODE** — fills QwenPaw's empty `RoutingPolicy.decide()`; abstains when unsure; 27 checks |
| Docs: AGENTS/ARCHITECTURE/BUGS/STATUS/IMPROVEMENTS/AGENT-DESIGN + link checker (T70) | **CODE** — 4 stale doc paths found and fixed |
| B-3 board stores all tickets in one KV value (P1) | **TODO** — fixed by the D1 migration |
| B-2 needs-you is one global record (P1) | **TODO** — per-computer keys |
| B-5 preview `<img>` refetched every 10 s (P2) | **TODO** |
| B-6 `__pending-skills` N+1 with no TTL (P2) | **TODO** |
| B-7 keep-alive writes KV every tick (P2) | **CODE** — write-on-change + `lastUpAt` semantics; 19 checks (T68) |
| B-8 routines history read-modify-write (P2) | **TODO** |
| B-10 no rate limit on desktop endpoints (P2) | **TODO** |
| B-11 per-byte base64 in preview upload (P2) | **TODO** — goes away with R2 |
| B-12 group-chat CORS `*` on a token API (P2) | **TODO** |
| B-13 KV-staleness sleeps on the capability path (P2) | **TODO** — goes away with D1 |
| B-14…B-18 (P3 hygiene) | **TODO** |

Gate harness went 116 → 127 checks this pass. Machine-free suite: **472 checks**, all green (T46–T48, T62–T72).

## Phase 2 — D1 migration (next, unblocks 6 bug classes)

Move storage off KV. Token has D1:Edit; zero databases exist.

- **TODO**: schema (`features/storage/`), backfill of live state (lease,
  generation, needs_you, taught skills, modes), dual-write one day, cut over,
  remove KV.
- **Design decision already made:** preview PNGs go to **R2, not D1**. D1's
  2 MB row cap is not the blocker (previews are 243–707 KB); the blocker is
  volume — 2 computers changing every 120 s is ~0.79 GB/day against 5 GB
  *total* free storage, i.e. exhausted in ~6 days. R2 gives 10 GB-months and
  1M Class A ops/month, and one overwritten key keeps storage flat.
- **Why it matters beyond quota:** B-1, B-3, B-7, B-8, B-9 and B-13 are all
  symptoms of KV's eventual consistency and single-key model. Six defect
  classes disappear with the migration.
- **Note:** `features/storage/` was referenced as "work in progress" but
  **was not in the repo** when this was written (no branch, no ref). The plan
  above is designed from the live code; reconcile when it lands.

## Phase 3 — Memory (CODE, needs one live run)

- **CODE**: `features/memory/recall.py` — out-of-loop bounded recall:
  2,000-token hard cap (unraisable by flag), ≤3 results, credential
  redaction, tool-noise exclusion, read-only twice. 44 checks.
- **CODE**: `features/memory/lessons.py` — candidate/accept ledger on the
  EXISTING `## Important Decisions and Lessons` section; ≤10 accepted, ≤3
  candidates, ≤800 words, ids never reused, secrets **rejected not
  scrubbed**. 45 checks.
- **CODE**: `features/memory/reme_doctor.py` — names the five real gates
  behind "memory produced zero notes". 11 checks.
- **CODE**: `features/memory/install-ripwire.sh` + `skills/ripwire/` — pinned
  v0.6.10, sha256-verified, AVX2 preflight (accepts `abm` for lzcnt), 49
  checks.
- **Correction to the original plan:** upstream v2.3.0 **already ships** the
  FTS5 history bridge (`memoryspace.MemorySpace.search()` + `recall_history`).
  Building a second index would have duplicated working code. Only the
  genuine gaps were built.
- **BLOCKED (Muse)**: T65 needs `features/memory/*.py` synced to
  `/data/home/qwenpaw/working/memory-tools/`.
- **TODO**: apply the ReMe cause the doctor reports (a decision, not code).

## Phase 4 — Code Mode (WIP: measurement done, live path gated)

- **CODE**: `features/codemode/` — a Worker that *measures* Code Mode instead
  of asserting it. Measured on a 30-tool/10-step job: 10 turns / 21,960
  prompt tokens classic vs 1 turn / 212 Code Mode (98.1% with one retry),
  reported as an **upper bound** with the honest negatives (a single call is
  *worse*; desktop work cannot batch screenshots). 59 checks.
- **GATED (Muse)**: two deploy-time facts — (1) `worker_loaders` on the free
  tier is undocumented; (2) the computer-use MCP SSE lives on
  `172.18.0.1:8898` inside the VM and needs a token-authenticated published
  port. `POST /api/run` returns 501 naming both rather than faking a run.
- **TODO**: if the loader exists, deploy and run one real routine end-to-end.

## Phase 5 — Optional decision models (BLOCKED)

- **JEV / TypeSafe** — BLOCKED on a TypeSafe API key (or an OpenRouter-route
  decision). Research is in `features/jev/`. Jev is a *decision* model, not a
  chat model; it must never enter `active_model`.
- **Drex / NACE** — BLOCKED on the NACE key being submitted through the secure
  link. Same shape as Jev (wire-compatible `/v1/systemone`), cheaper.
- Neither is started, and neither will be until a key exists. **Do not invent
  one.**

## Phase 6 — Hardening (TODO)

- Rate limits on the desktop endpoints (B-10) and a 429 path.
- A quota budget check in CI (`features/test-project/preflight.py --json`).
- Prompt-injection guard for agent-read content (A-14) — currently "warn".
- Rotate the Worker tokens; record rotation in `features/improvements/`.

---

## What "done" means here

A phase is done when: (1) its code is merged, (2) its harness passes, (3)
Muse has deployed it, and (4) Muse has verified the behaviour in a real
browser or against the live machine. Anything less is **CODE**, and is
labelled that way everywhere.

## Open decisions (need the user, not the agent)

These are recorded, not decided, by the coding agent. Detail in
`features/improvements/PROPOSALS.md`.

1. `INSTABOX_API_KEY` as a Worker secret — unblocks the maintenance Stop
   action and `__wake`'s desktop-start.
2. Telegram bot token + numeric user ID.
3. `CLOUDFLARE_API_TOKEN` + `GITHUB_TOKEN` in QwenPaw's env store — unblocks
   the `build-page` and `github` skills.
4. Enable heartbeat; approvals AUTO → SMART; apply the model-fallback patch.
5. Voice path (LiveKit free vs Twilio trial) — needs keys.
6. Bot email — needs a user-owned domain on Cloudflare (account has zero
   zones).
7. Apply the D1 migration (Phase 2) — needs a deploy window and a snapshot.
