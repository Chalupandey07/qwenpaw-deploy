# AutoClaw session archive — 2026-11-15

**What this is:** the complete record of everything AutoClaw did, said, decided
and learned in its 2026-11-15 session on this repo, saved so the knowledge and
intelligence survive after its credits run out. AutoClaw's own chat is the only
other copy; this file is the durable one.

**Captured:** 2026-11-15 ~15:15 IST, from the AutoClaw web chat
("i want to connect github with you using", 12:34–15:07 IST) read in full, plus
the repo state it committed (verified against GitHub HEAD).

**Caveats:** a few long lines in the chat's page view were truncated
("[truncated]" where the page cut them); the commits and the docs in this repo
are the authoritative record for anything the chat text only summarised. No
credential or token value is in this file — ever.

**Credits:** AutoClaw started the day at 2,956 points (09:10 UTC) and ended at
**462 points** (15:07 IST) — it burned ~2,494 points in one session. Its task
ended idle ("Task ended"). Any new AutoClaw task starts from 462 and will run
out fast. The work continues with Muse's own agents from here.

**Headline state at capture:** 21/21 test groups green, 19 fixed of 27 bugs,
8 open bugs — all cost/hygiene, **zero correctness or data-loss items**.
The big comprehensive request is complete in code (8 commits). The computer
rebuild is complete in code (removal + rebuild + 5 fixes + preview uploader).
**Nothing from the rebuild is live** — deployment, machine sync and browser
verification are Muse's jobs and have not happened.

---

## 1. Session timeline (messages in order)

### 12:34 — User: connect GitHub with a classic token
AutoClaw 12:40: the fine-grained token was not usable for clone (wrong
scope/endpoint); asked for a new classic PAT with `repo` scope, or a
fine-grained token with Contents: Read and write, expiring in 7 days, without
authorising it in the repo. No fork exists. Clone `Ratulbaba7/qwenpaw-deploy`.

### 07:27 UTC — Muse's first handoff
Read HANDOFF-AUTOCLAW.md and PLAN.md, do the TODO tasks, start with Phase 4
memory and Phase 5 Code Mode pilot plus re-verification, say what it was
blocked on (JEV/TypeSafe key, Drex/NACE key, token tests).

### 07:42 UTC — Updated instructions (queued)
Repo verified fully in sync, 195 files hash by hash, 7 files missing/stale
pushed (Rakazo computer study, 1,206-entry JEV tools list, Code Mode research,
Camoufox research). Live sites qwenpawx.pages.dev, deployments b16c89b5 and
d16b56f6 built from these exact files. Read HANDOFF-AUTOCLAW.md, PLAN.md, and
`features/jev/awesome-jev-tools-full-list.md`, `features/research/code-mode.md`,
`features/desktop/rakazo-computer-study.md`, `camoufox-research-2026-11-15.md`.
Start with unblocked Phase 4 memory (Ripwire first, then FTS5 recall bridge +
ReMe repair + lessons) and Phase 5 Code Mode pilot plus re-verification; do NOT
start JEV, Drex, or token tests — list as blocked. QwenPaw v2.3.0, no fork,
code is qwenpaw-deploy, app runs from Docker image. Hard rules: Free only,
English only, no China endpoints, never commit secrets or invent keys, verify
with repo harnesses before committing, update PLAN.md in same commit.

### 07:45 UTC, delivered 13:12 IST — The D1 question
Move all QwenPaw storage off Cloudflare KV (1,000 writes/day free limit —
already burned once by preview uploads) to D1, quota-proof everything; D1
access granted (token has D1: Edit, zero databases exist yet). Give best plan
for (1) D1 schema/storage design for leases, generations, screen previews as
PNGs, needs-you, teach skills, modes, routines history/pending, keep-alive
status, including where preview images should live if D1 cannot hold ~1MB
blobs; (2) quota-proofing for Workers 100K requests/day, D1 100K rows
written/day and 5M rows read/day, KV 1K writes/day, Durable Objects 100K
requests/day; (3) improvements to PLAN.md; (4) every bug in current code with
severity and fix. Read HANDOFF-AUTOCLAW.md, PLAN.md, `features/storage/`.
Do not deploy.

### Before 08:44 UTC — AutoClaw's full D1 reply
See §2 (D1 design + quota) and §5 (bug list B-1..B-18). Persisted as commit
`c610210` (`features/storage/schema.sql`, `test_schema.py`, `README.md`);
BUGS.md summary fixed to 0/2/7/5 = 14 open + 4 fixed = 18. State: 487
machine-free checks, 14/14 groups green on a clean clone. Nothing claimed live.

### 08:44 UTC — The big comprehensive request + sequencing
Finish D1 first, then the big one: complete TODO plan in priority order, full
bug audit of all code/logic with severity/fixes, all improvements in every
area, implemented-vs-new list, best AGENTS.md/README/PLAN.md and other docs,
best QwenPaw-based agent, GitHub trending-repo research for memory/self-learning,
decision models, computer-use/desktop, code execution, routines, evals, cost
tracking, implement the best ones in code and commit.

AutoClaw's reply ("Confirmed — I've started the big one"): started with the
full bug audit, found and fixed three real bugs in commits `19a29f0` and
`7ac3495` — B-19 (D1 budget counter was read-modify-write; now
`count = count + ?` in one statement; KV path advisory-only; test: 20 concurrent
increments must all land), B-20 (bare `env` inside the Durable Object, a
ReferenceError at runtime, caught by harness), B-12 (group-chat CORS still `*`;
now allowlist with `Vary: Origin`, fail-closed when unset; old code failed 8 of
13 new checks). Docs were lying: ARCHITECTURE.md still said "Ticket board |
Worker + KV today, D1 planned" and "KV is the wrong store…"; fixed, with board
still on KV and B-3 still open; new failure-mode rows for the budget circuit
breaker; §7 rewritten to five things actually weak now (board single-KV-value,
previews as D1 BLOBs against 2 MB row cap, lease not yet one atomic unit, two
storage implementations where one can't be atomic). BUGS.md reconciled to
11 open + 10 fixed = 21 findings; B-3 the only remaining data-loss bug, in
progress elsewhere. State: 18/18 test groups PASS, 0 FAIL, all 201 doc links
resolve. Next in order: (1) P2 memory — Ripwire/recall/lessons built
(149 checks), one thing left is `reme_doctor.py` naming ReMe's cause, needs one
run on the box; (2) P2 Code Mode — measurement done (59 checks), live path needs
`worker_loaders` + published MCP port; (3) P2 JEV/Drex — designs and source
checks, no keys; (4) remaining md rewrites (AGENTS/STATUS/IMPROVEMENTS +
agent-design doc) and trending-repo research — verified brief from earlier, two
picks implemented (pricing, routing). Deliberately not touching the board
migration, so a conflict in `features/board/` was possible if the other agent's
work landed mid-edit — it would rebase rather than overwrite.

### 08:44 UTC — TODO-TODAY message
Read TODO-TODAY.md in full, P0 verification today (T52 take/release, T53
Team-to-Private, T56 needs-you banner, T59 group chat, T60 board CRUD, T61
evals), P1 fixes today, P2 builds today (Phase 4 memory, Phase 5 Code Mode
pilot, JEV/Drex designs while keys blocked), P3 user-needed items not to
invent/work around; board-to-D1 migration by separate agent — do not duplicate;
finish D1 first, then work TODO-TODAY.md in order, committing each piece to main.

AutoClaw's reply: confirmed it read TODO-TODAY.md in full, shipped 3 commits
in that turn (`1a08b64` D1 schema, `797dfaa` PLAN.md + BUGS.md + D1 fixes,
`a550687` TODO-TODAY.md + board-to-D1 design), said board migration not
duplicated, state 542 machine-free checks, 16/16 groups green, next P2 memory,
Code Mode, JEV/Drex.

### 09:04 UTC (14:23 IST) — D1 closed, start the big one
User confirmed the D1 request is closed. AutoClaw showed "Thinking...".

### 14:40 IST — Board done, continue the big one
Muse: board migration DONE and live (tickets in D1 with the Durable Object rate
limiter, tested 50 PASS 0 FAIL), so B-3 is closed and there is no conflict in
`features/board/` anymore. Continue the big one in the order listed — P2 memory
next, then P2 Code Mode, then P2 JEV/Drex designs, then the remaining md
rewrites and trending-repo research. Running `reme_doctor.py` on the machine is
Muse's job, not AutoClaw's — do the code and design work, commit it, and say
clearly what needs the machine run. Keep committing to main; do not deploy.

AutoClaw's reply — "Done. The big one is complete — all seven parts,
8 commits, `a52e43a` is HEAD." What it built (5 new test groups, 142 new
checks): memory consolidation — the genuine gap, `features/memory/consolidate.py`,
27 checks (T83); decision models — Jev + Drex, one client,
`features/decisions/decide.py`, 33 checks (T84); skill scanner — third-party
SKILL.md gate, `features/skills/scan.py`, 41 checks (T85); Code Mode live path —
501 → real execution, `features/codemode/`, 68 checks (T76, was 59); atomic
budget + CORS + email hardening, store/groupchat/email-router, 79 checks
(T62/T81/T82). Final: 246 files, 20/20 groups, ~601 checks, 0 failures from a
clean clone. Bugs: 21 findings, 11 fixed, 0 data-loss bugs remain. Closed this
session: B-1, B-2, B-3, B-4, B-6, B-7, B-9, B-11, B-12, B-18, B-19, B-20.
Remaining 10 [truncated in page view — see BUGS.md §5 for the authoritative list].

Three findings worth attention: (1) The D1 rebuild silently reverted four of
AutoClaw's fixes — B-1, B-4 (root shell for 59 min after release), B-9, and the
adaptive poller. (2) `run-tests.py` has been overwritten three times, each time
silently dropping test registrations — a suite that stays green because nothing
runs. Merged rather than replaced: 63 → 79 registrations. AGENTS.md now says
to count the "T##" rows after any edit to that file. (3) Every "cheap" upstream
tool had a backend that violated a constraint (e.g. semantic-router needs a
resident ONNX encoder on an 8 GB box already running Chromium + two Xvfb
displays) — AutoClaw wrote ~200-line interface-shaped stubs instead, with the
interface shaped so the real dependency can replace it later.

Two design decisions AutoClaw would defend: decision models fail closed and
coerce low-confidence allow → ask (a safety gate that fails open on uncertainty
is not a gate); added `brier()`/`calibrate()` because "calibrated
probabilities" is the vendor's claim, not something this repo has verified.
And the skill scanner cannot catch plain-English malice, and the test asserts
it doesn't claim to — run against the repo's own Camoufox skill it returns
7 MEDIUM findings, all legitimate curl. A scanner that said "clean" on real
network code would be the one to distrust.

What needs Muse (not code): (1) Memory: run
`python3 features/memory/reme_doctor.py --root /data/home/qwenpaw/working --agent default`
once — it names which of the five gates is blocking notes. Read-only.
(2) Code Mode: uncomment `[[worker_loaders]]`, deploy, check `/health` for
loader: "bound"; plus publish the MCP SSE port with a token. (3) Decision
models: TYPESAFE_API_KEY or NACE_API_KEY into the encrypted env store. Neither
was invented or faked. (4) Test registrations: the restorable ones were
restored, but if `run-tests.py` keeps getting rewritten from a different
branch, consider making the registry a separate file that survives.

The "77 registrations restored" run is this same P2 memory / big-one run:
AutoClaw said "77 registrations restored. Let me verify they all actually
pass." while merging the runner (75 vs 63 registrations); the final merged
count reported was 63 → 79 registrations.

### 14:50 IST — New priority: remove the computer, rebuild it from Rakazo
Muse (from Rohan): the computer is still buggy and not smooth like Rakazo's.
Muse built the computer code and the implementation is the problem, not the
idea. (1) REMOVE all the computer code — every desktop/computer piece:
`/desktop` routes and all computer logic in `pages/public/_worker.js` (keep the
console proxy working), `features/desktop/` (watcher, bridge, driver cards,
study docs), the computer UI files, the Camoufox bridge pieces, any other
computer-only code. Commit the removal on its own. (2) Read `elie222/rakazo`'s
computer implementation — the repo is the source of truth, clone and read it —
and re-add the computer the Rakazo way, same behaviour AND same look: side
panel beside chat, full-window overlay, take/release control, teach-a-task,
terminal tab, Team vs Private computers, live screen, tool-call display in
chat. Match Rakazo's look and feel, not just the function. (3) Fix every
mistake Muse made recorded in the repo and handoff docs — read BUGS.md,
PLAN.md, `features/test-project/RESULTS.md` and TESTS.md (especially T52–T57),
`features/desktop/rakazo-computer-study.md` and HANDOFF-AUTOCLAW.md before
writing a line: the KV quota burn from unconditional preview uploads, the
phantom desktop, the take-control 500s, the mode-switch failure, the agent
working around a sign-in wall instead of raising needs-you, the frame leak,
the D1 rebuild reverting security fixes, the lost test registrations, the false
under-1000-writes claim. Do not repeat any of them. (4) Commit everything to
main. Do not deploy — Muse deploys and tests here, live, and the machine-side
file sync is Muse's job after the rebuild commits. Reply when the removal
commit lands and again when the Rakazo rebuild is committed.

AutoClaw's rebuild, in its own words (process notes + replies):

- "Console proxy is intact; desktop still has leftovers — constants and the
  console-side panel injection… The proxy itself got truncated. Let me restore
  it properly — the proxy() function plus the fetch handler must survive. The
  runner has ~20 tests that reference deleted code. Rather than gut the whole
  runner, let me mark [them] NEEDS-REBUILD — honest, and they'll go green when
  the new computer lands. … Removal commit landed: 0066e84. Now the rebuild.
  First, the source of truth — cloning Rakazo and reading the actual
  implementation… That's the state machine I need to port. Let me read the
  noVNC shim and capability — the two things [that matter]… I have everything
  I need. Building the new [computer]… WebCrypto AES-GCM appends the 16-byte
  tag to the ciphertext, but my code treats the last bytes as ci[phertext]…
  63/63. That IV bug would have shipped a computer where every screen link was
  dead — the harness caug[ht it]. Both commits are on main."
- "`0066e84` — the removal landed: 8,399 lines deleted. `_worker.js` went from
  2,572 → 216 lines — it's a console proxy again, which is what it's good at.
  Removed: all `/desktop*` routes and 20 `desktop*()` functions, the
  storage/capability layer the desktop owned, the console-side panel injection,
  `desktop-chrome.html` (1,216 lines), all of `features/desktop/`
  (lease-watcher, PTY server, 17 systemd units, 3 harnesses), all of
  `features/camoufox/`. One judgement call worth naming: I kept the tests and
  marked them NEEDS-REBUILD. Deleting T07–T17/T46–T57/T75 would delete the only
  precise record of what 'smooth' has to mean; leav[ing them marked is honest].
  I also kept `features/storage/` (the board and routines use it) and the
  machine-side MCP config — removing the latter would break th[e machine]."
- "`d7553b5` — the Rakazo rebuild committed: I cloned `elie222/rakazo` at
  `d343d83` and read the actual implementation — the overlay, the state
  machine, the shim, the seal — rather tha[n the docs]. Four files:
  `capability.js` (AES-256-GCM seal + noVNC shim), `state.js` (lease on D1),
  `router.js` (/computer surface + stream proxy), `ui.html` (panel + overlay).
  Look matches Rakazo: full-viewport overlay not a new tab, 316 px rail beside
  the chat, one 'You have [control…' [truncated in page view]. Three deliberate
  divergences, each with its reason in the README: capability resolved
  in-process (no fake network boundary), 10-[second polling? — truncated in
  page view] every request instead of every 1 s through an API."
- "The part worth your attention: My own harness caught two bugs that would
  have shipped every screen link dead: (1) The IV was never written into the
  token — `crypto.subtle.encrypt` used it, but the token held only the
  ciphertext. Sealed fine, opened never. (2) WebCrypto returns
  `ciphertext||tag` as one buffer, while `node:crypto` takes the tag as a
  separate argument. Porting Rakazo's split verbatim fails every open. Neither
  is visible by reading the code. Both need the round trip. That's the
  strongest case yet for [testing] the thing before committing."
- "What Muse needs to do: (1) Bind COMPUTER_DB to qwenpaw-state. Schema
  self-creates on first use — no migrate step. (2) Secrets:
  COMPUTER_CAPABILITY_SECRET, the CONTROL / VIEW origin+token pairs (plus QA_),
  COMPUTER_SYNC_TOKEN. (3) Machine side: the view-only + interactive
  x11vnc/websockify pairs, and a preview uploader that is change-only with a
  floor. (4) Verify in a real browser. Every previous round that skipped this
  shipped a broken screen. Not done, deliberately: Terminal — the PTY service
  went with the old computer. A root shell is the highest-risk surface; it
  should la[unch separately / be gated]. Teach recording — the UI records
  start/stop, but there's no input recorder or draft editor yet. Both are
  listed as not-done in the README rather than half-built. Nothing is claimed
  live — I have n[o deployment]."
- Walking the failure record (process notes): "render() is not called to undo
  it. Let me fix. … Found it — T53's exact failure: on error the checkbox
  stays visually flipped while state reverted, and render() is not called to
  undo it. … Now T52's take-control 500 — the recorded cause was unguarded K[V
  calls]. Real gap: ensureSchema throws if the D1 binding is missing or a DDL
  fails — that becomes a 500, the exact symptom T52 recor[ded]. … The
  DriverCards were deleted with features/desktop/. That's a regression I
  introduced — the rule that made T56 pass is gone. Let me restore it. … Two
  false negatives — and those are exactly the T56 case (a password field). My
  threshold is too con[servative]. … 81/81. … The phantom-desktop fix lives in
  instabox/ — let me confirm it survived the removal, since it's machine config
  not desktop code. Phantom-desktop fix survived. Now the frame leak — a leaked
  iframe/WebSocket that never closes. … Good — no dynamically created iframes,
  so no leak possible. But heldUrl is tracked and never rendered. That's dead
  state pretending to do the held-frame job. Let me make it [render]. … 83/83.
  … The write math isn't documented for the new design. Let me compute what the
  new architecture actuall[y costs]. … Now let me verify the remaining two:
  take-control race under concurrency, and that the D1 schema add[resses it].
  … A real problem: I invented computer_lease / computer_preview while
  features/storage/schema.sql already defines lease / preview — and those hold
  live data. Two schemas for one database. … The live schema is the third
  variant (leases, generations, previews with a png column, needs_you(computer
  PK)). My new module invents a fourth. That's a real defect — I must match
  live. … Those failures are the harness checking against table names I just
  corrected. … 84/84. That was a genuinely dangerous catch — a parallel schema
  would have silently orphaned every l[ease and preview]. … There's a real gap:
  the machine has no uploader — it was deleted with features/desktop/. Without
  it, previews and needs-you never populate. Let me write it, with the
  change-only rule buil[t in]. … Continuing. Two remaining items from the brief:
  the PLAN.md / BUGS.md status update, and verifying nothing else referenced the
  deleted computer. … Those runner refs are inside NEEDS-REBUILD-marked tests
  (correct), but the skill-scanner docstring now points at a deleted path. Let
  me fix an[d verify]."
- "Five more fixes (`9d41f92`, `dbe366e`, `8903be8`): Walking the recorded
  failures against my own rebuild found five still unhandled — three were
  defects I had just introduced: B-22 T56 rule deleted — Removing
  features/desktop/ took the DriverCards, which carried 'raise needs-you first,
  never work around a sign-in wall'. I silently reintroduced the 31-step Gmail
  failure. Restored as a policy doc + policy.js. B-23 Parallel D1 schema — My
  state.js invented computer_lease/computer_preview beside the live
  leases/previews. Would have looked like it worked and orphaned every existing
  lease and preview. B-24 Mode switch — T53's exact symptom: checkbox stayed
  flipped while state reverted. B-25 Take-control 500 — T52's exact symptom:
  unguarded store calls → 500 with a stack. B-26 heldUrl never rendered — Dead
  state doing the job's name only — so the screen still went black on swap.
  B-23 is the one that should worry you most. A parallel schema passes every
  test you write against it and silently loses real data. I only caught [it by
  checking] migrate-kv-to-d1.py for the live table names."
- "Also rebuilt: the preview uploader (`dbe366e`): The removal took it too, so
  previews and needs-you had nothing to show. Rewritten change-only with a
  [floor]: Static screen — 1, then zero forever; Screen changing every tick —
  ~720 (floor-capped); Human holding control — 0; Store 429/503 — 0 for 300 s;
  Old uploader — 5,760–11,500. The fix was never a longer interval — that just
  slows the burn. It's making the write conditional on the bytes changing."
- "The pattern worth naming: Three times today the harness caught what reading
  could not: the IV never written into the token, the ciphertext||tag split,
  the parallel schema, and now the needs-you classifier clearing 'Enter your
  password' as not blocked. Every one was invisible in review and instant in a
  round trip."
- "State: 21/21 test groups green. 8 open bugs, all cost/hygiene — zero
  correctness or data-loss items. 19 fixed of 27."
- "What's yours: (1) Bind COMPUTER_DB, set COMPUTER_CAPABILITY_SECRET + the
  control/view origin+token pairs + COMPUTER_SYNC_TOKEN. (2) Sync
  preview-uploader.py + computer-preview.service to the machine. (3) Verify in
  a real browser. Every round that skipped that shipped a broken screen — T52's
  '500 on five attempts' is exactly what [happens]. Still deliberately not
  built: terminal (a root shell needs its own lease tests) and teach-recording
  (needs an input recorder). Both listed as not-done rather than half-finished."
  Deliverable this time: 1 file, open `ui.html`. Then "Task ended".

---

## 2. The D1 design (AutoClaw's reply, in full substance)

**The false claim:** the plan's "under 1,000 KV writes/day" was false — actual
total **7,537 writes/day** (lease heartbeat 5,760, previews 1,440, keep-alive
288, routines 49), idle case 337/day.

**Verified free limits:** D1 100K rows written/day, 5M rows read/day, 2 MB max
row, 50 queries/invocation, 5 GB storage, 7 days Time Travel; R2 10 GB-months,
1M Class A/month, 10M Class B/month, free egress; Workers 100K/day; KV 1K
writes / 100K reads per day; Durable Objects 100K/day.

**11-table schema** (computer, lease, needs_you, preview, agent_mode,
taught_skill, routine_run, routine_pending, keepalive, ticket, ticket_comment)
with the stated indexes and design rules: one row per mutable entity,
generation on computer not lease, every WHERE/ORDER BY indexed, no image bytes.

**Previews to R2, not D1:** 243–707 KB each, 0.79 GB/day, ~24 GB/month vs 5 GB
total, exhausted in 6.3 days; R2 43,200 Class A ops/month (4%), storage flat
~1.1 MB, served at `GET /desktop/__preview?computer=X&v=<sha256>` with ETag;
needs-you carries sha256. Takeover as one atomic `batch()`, 409 if held.
Six-step migration: bookmark, create DB/apply schema.sql, backfill only real
state, dual-write KV+D1 for one day, read/write D1, remove KV last. Validated
by `features/storage/test_schema.py` (T73, 15 checks) against SQLite, with
EXPLAIN QUERY PLAN showing no full-table scan on the seven hot queries.

**Quota-proofing:** cost proportional to user action, never wall clock; every
write conditional and idempotent; local budget counter that 429s before
platform quota; graceful degradation with cached reads. Pollers 34,560 → 6,480
idle (−83%); KV writes target zero after migration; D1 writes fine once
previews leave for R2; D1 reads indexed with LIMIT, never SELECT * on history;
batch writes; never put a heartbeat in a Durable Object. Already implemented:
B-7 write-on-change and idle-adaptive polling.

**PLAN.md improvements:** rewritten as six phases with DONE / CODE / WIP /
BLOCKED / TODO and owners — Phase 0 Foundation DONE, Phase 1 Testing DONE
(protocol 48/0/1-gap; blocked on browser rows + user tokens), Phase 1.5
Correctness 4 fixed / 14 open, Phase 2 D1 migration schema DONE / Worker
rewrite TODO, Phase 3 Memory CODE (149 checks; T65 needs machine sync), Phase 4
Code Mode WIP, Phase 5 JEV/Drex BLOCKED on keys, Phase 6 Hardening TODO; seven
open decisions needing the user; a phase is not done until Muse has verified
it; incident log kept in README/BUGS.md, not the plan; the false "under
1,000/day" claim explicitly marked false.

**Design difference, still open:** AutoClaw wants preview bytes in R2 (volume
~0.79 GB/day); the live system stores one BLOB row per computer in D1,
overwritten in place (flat ~1.2 MB). Open question whether D1 Time Travel
history counts overwrites against the 5 GB limit. R2 is not enabled on the
account (error 10042, possibly billing-gated).

---

## 3. The big one — what was built

| Part | Files | Checks |
|---|---|---|
| Memory consolidation (logs → lesson candidates) | `features/memory/consolidate.py` (T83) | 27 |
| Decision models — Jev + Drex, one client | `features/decisions/decide.py` (T84) | 33 |
| Skill scanner — third-party SKILL.md gate | `features/skills/scan.py` (T85) | 41 |
| Code Mode live path — 501 → real execution | `features/codemode/` (T76, was 59) | 68 |
| Atomic budget + CORS + email hardening | store / groupchat / email-router (T62/T81/T82) | 79 |
| **Total** | 246 files | 20/20 groups, ~601 checks, 0 failures from a clean clone |

**Key design facts:**
- Drex and Jev are wire-compatible (`/v1/systemone`), so one client covers
  both. QwenPaw already has a `typesafe_provider.py` with typed questions —
  the right design is a thin decision client that matches its shape, no
  reinvention. Verified against a local mock server (the wire format is the
  part most likely to break).
- Decision models fail closed, low-confidence allow → ask. Added
  `brier()`/`calibrate()` because "calibrated probabilities" is the vendor's
  claim, not something this repo has verified.
- Skill scanner cannot catch plain-English malice, and its test asserts that.
  Against the repo's own Camoufox skill it returns 7 MEDIUM findings, all
  legitimate curl. A scanner that said "clean" on real network code would be
  the one to distrust.
- Every "cheap" upstream tool had a backend violating a constraint, so AutoClaw
  wrote ~200-line interface-shaped stubs with the interface shaped so the real
  dependency can replace it later.
- Trending-repo picks 1 and 2 implemented (pricing, routing); #3 built (skill
  scanner); #4 (Langfuse) needs only a free account + 3 env vars; #5
  [truncated in page view].

---

## 4. The computer rebuild (code complete, NOT live)

Source of truth: `elie222/rakazo` @ `d343d83`, read directly —
`apps/web/src/pages/shell/computer-overlay.tsx` (the look),
`apps/web/src/lib/computer-screen.ts` (the state machine),
`apps/web/src/novnc-html.ts` (the shim),
`packages/core/src/node/screen-capability.ts` (the seal),
`packages/core/src/screen-reconnect.ts` (the lease constants).

**Shape** (`pages/public/computer/`):
- `capability.js` — AES-256-GCM seal + noVNC shim
- `state.js` — lease, generations, needs-you, previews (on D1)
- `router.js` — the `/computer` surface + stream proxy
- `ui.html` — panel + overlay, one self-contained page
- `pages/public/_worker.js` delegates `/computer*` to the router and is
  otherwise untouched — it is a console proxy again (216 lines, was 2,572).

**Look matches Rakazo:** full-viewport overlay not a new tab, 316 px rail
beside the chat, one "You have control" pill.

**Three deliberate divergences** (each with its reason in
`features/computer/README.md`): capability resolved in-process (no fake network
boundary); capability TTL 10 min (Rakazo 60 — a link here is minted immediately
before a frame loads it); recheck the live lease on every request instead of
every 1 s through an API (same isolate, same D1 call).

**Preserved because each prevents a recorded failure:** policy + expiry in the
AAD (a view link replayed as control); scope = `{computer, generation,
leaseId}` (a link surviving a takeover or screen replace); the provider token
inside the seal (a token in a cookie, in a redirect, or in the browser at all);
deterministic IV per identical seal (two tabs invalidating each other's
handshake); `redirect: "manual"` upstream (auto-follow without a cookie jar
reporting a healthy desktop as down); drop the browser `Cookie` header (a stale
per-port cookie 401ing every other port); a held predecessor frame (the screen
blanking on take/release); the shim's state reports (a silent frame showing
black with no diagnosis); `pointer-events: none` until control (driving a
screen you do not hold); heartbeat only while visible (a forgotten tab holding
control forever); release names the lease (a late release from an old page
ending newer control).

**Quota math for the new design:** worst case 7,290 D1 rows/day (7.3% of D1)
— lease heartbeat 5,760 (15 s, control held 24 h), takeover+release 40,
needs-you 40, preview uploads 1,440 (2 computers, 120 s floor, screen always
changing), unchanged-screen preview writes **0**, mode switches 10. A static
screen with control held all day costs 5,850 writes, because the preview
upsert is conditional on `sha256 IS NOT excluded.sha256`. The heartbeat is the
dominant cost and cannot be reduced without weakening takeover — which is why
D1 (100k) rather than KV (1k) is the right store. On KV this design would still
be 5.9× over quota while idle. The previous implementation's worst case was
17,280 writes/day against a 1,000/day KV budget — 17× over — while the docs
claimed it was "bounded well under 1,000". That false claim is the single most
expensive documentation error in this repo: the migration was sized on it.

**Preview uploader (machine side):** `features/computer/preview-uploader.py` +
`computer-preview.service`. Change-only with a floor: static screen 1 then
zero forever; screen changing every tick ~720 (floor-capped); human holding
control 0 (the guard runs before the capture); store 429/503 → 0 for 300 s
(backoff, not a retry storm); old uploader 5,760–11,500. Capture with `scrot`,
not AT-SPI (the AT-SPI path returned a bare desktop while the window was
unmapped — the recorded "phantom desktop" symptom). The token is a header
(`X-Computer-Token`), never in a URL; a browser User-Agent is set because
Cloudflare answers 403 to python-urllib's default.

**Deployment (Muse's job, not done):**
1. D1 binding — router expects `COMPUTER_DB` bound to `qwenpaw-state`. Schema
   self-creates on first use (`state.js::ensureSchema`), no separate migrate step.
2. Secrets (never in git, never in chat): `COMPUTER_CAPABILITY_SECRET` (32+
   random bytes), `COMPUTER_CONTROL_ORIGIN` + `COMPUTER_CONTROL_TOKEN`,
   `COMPUTER_VIEW_ORIGIN` + `COMPUTER_VIEW_TOKEN`, the same four with `QA_` for
   the second display, and `COMPUTER_SYNC_TOKEN` for the agent-facing endpoints.
3. Machine side: the view-only and interactive x11vnc/websockify pairs on
   published ports, and the preview uploader (change-only with a floor).
4. Verify in a real browser. Not with a protocol check. Every previous round
   that skipped this shipped a broken screen.

**Deliberately NOT built:** terminal tab (UI has the tab and workspace, but the
PTY service was removed with the old computer; a root shell is the highest-risk
surface and should land with its own lease tests); teach recording (UI records
start/stop and says a draft was saved; no input recorder or draft editor yet);
per-bot computers (schema has a `computer` row per name and the router takes
`?computer=`, but only `default` and `qa` are wired); live verification of any
of it.

---

## 5. Bug register (B-1..B-27, from BUGS.md as of commit 8903be8d)

**Summary: 8 open, 19 fixed, of 27. No data-loss bugs remain.** Priority of
what is left: B-10 → B-5 → B-8 → the P3 hygiene set.

| ID | Sev | Finding | Status |
|---|---|---|---|
| B-1 | P0 | `bumpGeneration()` reported generations it failed to store | FIXED |
| B-2 | P1 | needs-you is one global record, not per-computer | FIXED |
| B-3 | P1 | board kept every ticket in one KV value | FIXED (board→D1) |
| B-4 | P1 | terminal capability outlives its lease up to 59 min (TTL 3600) | FIXED |
| B-5 | P2 | preview `<img>` re-fetched every 10 s | OPEN |
| B-6 | P2 | `__pending-skills` N+1 KV loop with no TTL | FIXED |
| B-7 | P2 | keep-alive wrote KV on every cron tick (288/day) | FIXED |
| B-8 | P2 | routines history read-modify-write of one JSON array | OPEN |
| B-9 | P2 | `Math.max(gen, clientGen)` lets a client inflate generation | FIXED |
| B-10 | P2 | no rate limiting on any desktop endpoint | OPEN |
| B-11 | P2 | preview upload per-byte string building over 707 KB | FIXED |
| B-12 | P2 | group-chat CORS is `*` on a token-authenticated API | FIXED |
| B-13 | P2 | pointless KV-staleness sleeps (200/250 ms) on capability path | OPEN |
| B-14 | P3 | `kvTry()` results discarded | OPEN |
| B-15 | P3 | `__status` reports generation: 0 when store broken | OPEN |
| B-16 | P3 | Camoufox bridge token in query string, non-constant-time compare, `/eval` is RCE | OPEN |
| B-17 | P3 | PTY server no frame-size validation on resize | OPEN |
| B-18 | P3 | Code Mode pilot accepts run token via query string | FIXED |
| B-19 | P1 | D1 budget counter was read-modify-write | FIXED |
| B-20 | P1 | bare `env` inside the Durable Object (ReferenceError at runtime) | FIXED |
| B-21 | P3 | `harness-desktop-gate.mjs` has 134 `check()` calls but runs 127 | NOT A BUG (try/catch pairs — recorded so nobody "fixes" it) |
| B-22 | P1 | T56 rule deleted with the DriverCards | FIXED-CODE |
| B-23 | P1 | rebuild used a PARALLEL D1 schema (`computer_lease`/`computer_preview` beside live `leases`/`previews`) | FIXED-CODE |
| B-24 | P2 | mode switch left the UI disagreeing with the server | FIXED-CODE |
| B-25 | P2 | store failures surfaced as 500 | FIXED-CODE (now 503 `{error:"store"}`) |
| B-26 | P2 | `heldUrl` tracked but never rendered | FIXED-CODE |
| B-27 | P3 | skill scanner's usage example pointed at a deleted path | FIXED |

**Fix order AutoClaw gave:** B-3 → B-2 → D1 (removes B-1, B-3, B-7, B-8, B-9,
B-13) → B-5, B-6, B-10, B-11 → B-12, B-14–B-18. Recurring insight: six of the
first eighteen are symptoms of KV eventual consistency / single-key model.

**The D1 rebuild silently reverted four fixes** — B-1, B-4 (root shell for 59
min after release), B-9, and the adaptive poller. That is the incident to
remember: a rewrite that re-applies old code re-introduces fixed bugs, and only
the harness caught it.

---

## 6. Decisions and lessons (the durable intelligence)

1. **Harness over reading, four times in one day.** The IV never written into
   the token, the AES-GCM ciphertext||tag split, the parallel D1 schema, and
   the needs-you classifier clearing "Enter your password" as not blocked —
   every one was invisible in review and instant in a round trip. Test the
   thing before committing, always.
2. **Cost must be proportional to user action, never to wall clock.** The KV
   incident happened because a preview upload ran every 15 s whether or not
   anything changed (~11,500 writes/day against a 1,000 budget). The fix was
   never a longer interval — it is making the write conditional on the bytes
   changing.
3. **A false doc claim is a real bug.** "Bounded well under 1,000 writes/day"
   was wrong by 7.5× and the migration was sized on it. Docs that state numbers
   must state how they were measured.
4. **Rewrites re-introduce fixed bugs.** The D1 rebuild silently reverted
   B-1, B-4, B-9 and the adaptive poller. A rewrite must be diffed against the
   bug register, not just compiled.
5. **A suite that stays green because nothing runs is worse than a red suite.**
   `run-tests.py` was overwritten three times, each time silently dropping test
   registrations (75 → 63). Merge, never replace; count the "T##" rows after
   any edit to that file. Consider making the registry a separate file.
6. **Decision models fail closed.** Low-confidence allow → ask. A safety gate
   that fails open on uncertainty is not a gate. Vendor claims ("calibrated
   probabilities") are not verified until this repo verifies them (`brier()` /
   `calibrate()` exist for that).
7. **A scanner that says "clean" on real network code is the one to distrust.**
   The skill scanner cannot catch plain-English malice and its test asserts
   that; against the repo's own Camoufox skill it returns 7 MEDIUM findings,
   all legitimate curl.
8. **A parallel schema passes every test written against it and silently loses
   real data.** B-23 was caught only by checking `migrate-kv-to-d1.py` for the
   live table names. New storage code must be checked against the LIVE schema,
   not a fresh one.
9. **Keep the precise record of what "smooth" means.** When the computer was
   removed, the tests (T07–T17/T46–T57/T75) were kept and marked NEEDS-REBUILD
   rather than deleted — deleting them would delete the only precise record of
   the requirement.
10. **Nothing is live until Muse has seen it in a real browser.** Every round
    that skipped browser verification shipped a broken screen. Protocol checks
    and harnesses are evidence, never proof.
11. **Do not repeat the old mistakes** (the full list AutoClaw was given before
    the rebuild): KV quota burn from unconditional preview uploads, phantom
    desktop, take-control 500s, mode-switch failure, agent working around a
    sign-in wall instead of raising needs-you, frame leak, D1 rebuild reverting
    security fixes, lost test registrations, false under-1000-writes claim.

---

## 7. Open work for Muse (not AutoClaw — it has no deployment)

1. **Deploy the rebuilt computer:** bind `COMPUTER_DB` to `qwenpaw-state` on
   both Pages projects; set `COMPUTER_CAPABILITY_SECRET` (32+ random bytes),
   `COMPUTER_CONTROL_ORIGIN`/`COMPUTER_CONTROL_TOKEN`,
   `COMPUTER_VIEW_ORIGIN`/`COMPUTER_VIEW_TOKEN`, the same four with `QA_`, and
   `COMPUTER_SYNC_TOKEN` (Worker secrets, never in git/chat); deploy both
   Pages projects from current HEAD; verify in a real browser (T52/T53/T56).
2. **Machine side:** sync `features/computer/preview-uploader.py` +
   `computer-preview.service`; the view-only + interactive x11vnc/websockify
   pairs on published ports. The phantom-desktop fix lives in `instabox/` and
   survived the removal (machine config, not desktop code) — confirm it is
   still in place.
3. **Memory:** run `python3 features/memory/reme_doctor.py --root
   /data/home/qwenpaw/working --agent default` once (read-only; names which of
   the five gates is blocking notes).
4. **Code Mode:** uncomment `[[worker_loaders]]`, deploy, check `/health` for
   loader: "bound"; publish the MCP SSE port with a token.
5. **Decision models:** TYPESAFE_API_KEY or NACE_API_KEY into the encrypted
   env store (neither was invented or faked).
6. **Token tests (need user-held keys):** T59 group-chat post
   (GROUPCHAT_TOKEN), T60 board CRUD (board key), T61 evals live run.
7. **Browser re-verification:** T52 take/release, T53 Team-to-Private, T56
   needs-you banner — now against the rebuilt computer.
8. **GitHub Actions:** the account is locked due to a billing issue — no job
   can start until the user clears it in Settings → Billing. The fix is ready
   (3 secrets set, workflow rewritten, commit `cf1c267d`); re-dispatch and
   verify green after the lock clears.
9. **Not built, deliberately:** terminal (needs its own lease tests) and
   teach-recording (needs an input recorder). Both listed as not-done in the
   computer README rather than half-built.

---

## 8. Commit index (AutoClaw's session, main branch)

| Commit | What |
|---|---|
| `c610210` | D1 schema + validation (T73), bug-count reconciliation |
| `1a08b641` | P1: re-apply the security fixes the D1 rebuild reverted + token-leak + D1 row cap |
| `797dfaa9` | P1 email router + restore the 12 test registrations lost in the runner rewrite |
| `a550687` | RESULTS.md: Round 7 records the restored local suite (542 checks, 0 failures) |
| `19a29f09` | P1: atomic budget increment + group-chat CORS allowlist (B-19, B-12) |
| `7ac3495c` | Docs truth pass: ARCHITECTURE no longer says KV, BUGS reconciled to 21 findings |
| `42c939b8` | P2 memory: consolidation (logs → lesson candidates) + runner merge + doc fixes |
| `ff78b03f` | P2 Code Mode: implement the live sandbox path (200 not 501) + B-18 header-only |
| `87257e56` | P2 Jev/Drex: one decision client for both providers (33 checks), blocked on keys |
| `4727d8e0` | Docs: AGENTS/STATUS/IMPROVEMENTS/AGENT-DESIGN told the truth again |
| `a52e43aa` | Trending repos #3: offline skill scanner (41 checks) + status for all 5 picks |
| `0066e843` | REMOVE the computer (8,399 lines) — the implementation was the problem |
| `d7553b57` | Re-add the computer the Rakazo way (T86, 63 checks) |
| `9d41f92e` | Computer: fix every recorded failure + match the LIVE schema (T86 63 → 84) |
| `dbe366e7` | Rebuild the machine-side preview uploader (T87, 12 checks) |
| `8903be8d` | Docs: record the rebuild's five findings (BUGS B-22..B-27) and PLAN status |

(Also in this period, by Muse: `cf1c267d` — fix Deploy Worker + Pages
workflow; `1f6eb11d` and the 10 commits before it — board KV→D1 migration +
DO rate limiter.)

---

## 9. What is NOT in this file

- The exact verbatim text of every chat reply — the chat page truncates some
  long lines, and the commits/docs above are the authoritative record.
- Any credential, token, password or key. The secret *names* are listed in §4
  and §7 because a future agent needs to know what to set; the values live
  only in the Worker secrets / the user's hands.
- The live state after 15:15 IST — the rebuild is not deployed, and anything
  Muse does next (deploy, machine sync, browser verification) belongs in
  `features/test-project/RESULTS.md` and `PLAN.md`, not here.
