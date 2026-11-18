# Ask-before-durable-write — the consent gate for memory v2 fact writes

**Status:** code complete, machine-free test T133 green (114/114).
**Wired + live-checked 2026-11-19:** the SKILL.md routing line is in
(the agent routes high-stakes facts through `gated_add()` /
`durable_write.py add-gated` instead of `facts.py add`), the module
is synced to the machine, and a held-fact → accept → searchable
round-trip passed on the machine against a scratch memory.db (see
TESTS.md T133). No browser check: the gate is a CLI/skill path, not
a UI path.

Gap #20 from the 2026-11-18 all-20 evaluation (todo #2). The consent
gate already existed for the lessons ledger (`features/memory/lessons.py`:
the agent may only `propose` unattended; a durable write needs explicit
`accept --id --why "user confirmed"`). It did NOT exist for memory v2
fact writes — `facts.py` auto-adds, no gate. This feature applies the
same gate to fact writes, **high-stakes facts only**. Routine facts
write silently with provenance. It does not ask every time.

## Files

| File | What it is |
|---|---|
| `durable_write.py` | The gate: rule-based high-stakes classifier, pending-facts store, propose / accept / reject / list / check, `add-gated` entry point. Stdlib only. |
| `test_durable_write.py` | Machine-free test (provisional T133, 114 checks) incl. a 47-case classifier golden table, fail-first proven. |
| `README.md` | This file. |

## What was touched, and why

- **New:** `features/memory/durable-write/` (this directory) — the whole
  feature lives here.
- **Not touched: `features/memory/facts.py`.** The task allowed extending
  it only if the gate had to hook into its write path, and preferred a
  wrapper module. The wrapper is enough: the gate calls
  `facts.add_fact` for routine writes and for the accept flush, and
  `facts.py add` stays the raw low-level path. Zero edits means zero
  regression risk to T117/T118 — verified: both still pass unchanged
  (41/41 and 40/40, see below). The agent-facing change is a routing
  one: use `durable_write.py add-gated` instead of `facts.py add` for
  gated writes — **wired 2026-11-19** (SKILL.md routing line added and
  synced to the machine; see "Machine sync").
- **Not touched:** `features/test-project/run-tests.py`, `TESTS.md`,
  `RESULTS.md`, `PLAN.md`, `features/memory/README.md` — the coordinator
  registers all seven gaps sequentially at the end to avoid write-write
  races. T133 is provisional; the coordinator verifies it is free at
  registration and shifts it if the Approval TTL agent took it.

## How it works

```bash
DB=/data/home/qwenpaw/working/workspaces/default/memory.db

# Gated add: the single entry point. High-stakes -> held, routine -> written.
python3 durable_write.py --db $DB add-gated --text "My name is Rohan." --kind fact
# {"held": true, "pending_id": "PF-001", "reasons": ["identity: my name is", ...]}

python3 durable_write.py --db $DB add-gated --text "The build takes 5 minutes." --kind fact
# {"held": false, "fact_id": 12, "source": "gated:routine"}

# Explicit propose / accept / reject — the lessons.py API, pointed at facts:
python3 durable_write.py --db $DB propose --text "I prefer DeepSeek." --kind fact
python3 durable_write.py --db $DB list
python3 durable_write.py --db $DB accept --id PF-001 --why "user confirmed"
python3 durable_write.py --db $DB reject --id PF-002 --why "not confirmed"
python3 durable_write.py --db $DB check
```

**The pending store** is a `pending_facts` table inside the same
`memory.db` (created by the gate with `CREATE TABLE IF NOT EXISTS`;
facts.py never sees it). Same-DB placement makes accept crash-safe:
the fact is written first, then the pending row is marked accepted; a
crash between the two is reconciled by retry because `add_fact`'s
content-hash dedup returns the same fact id. Ids are `PF-001`-style,
allocated from an `AUTOINCREMENT` sequence and never reused. Pending
text is never indexed into `facts_fts`, so a held or rejected fact is
never searchable — the test asserts 0 hits for pending and rejected
text and 1 hit after accept.

**Caps reused from lessons.py:** at most **3** pending facts
(`MAX_PENDING`, == `MAX_CANDIDATES`); **400 chars** per text field
(`MAX_FIELD_CHARS`); `--why` required and non-empty for accept/reject.
**Not reused** (they do not transfer): `MAX_ACCEPTED = 10` (facts are
unbounded add-only), `MAX_BLOCK_WORDS = 800` (a fact is one line),
Evidence / Revisit / Scope fields (facts carry kind, importance,
source — provenance is the evidence analogue).

**Provenance:** a routine write records
`source = "gated:routine[;<caller source>]"`; an accepted flush
records `source = "pending:PF-001; accepted: <why>"`. A fact already
stored (content-hash dedup) is returned as a duplicate and never held
— asking about something already durable is noise.

**Secrets are rejected, not scrubbed — and never held either.** The
secret check runs before any pending insert, so no secret bytes persist
in the pending store; accept re-checks the stored text before flushing.

**When the pending store is full**, the 4th high-stakes fact is refused
loudly (non-zero exit, "pending full: ... accept or reject one first").
It NEVER falls back to a routine write — that would defeat the gate.

## What counts as high-stakes (the classifier)

Rule-based, stdlib only — `classify_high_stakes(text, kind, conn)` in
`durable_write.py`. The full golden table (47 cases, both directions)
is in `test_durable_write.py`:

| Held | Examples |
|---|---|
| kind == `preference` | any fact with kind preference |
| Preference phrasing | "I prefer DeepSeek", "Prefers dark mode", "User likes terse answers", "Respond in metric units", "Don't use emojis", "Use DeepSeek at maximum context" |
| Identity | "My name is Rohan", "Call me Sam", "I go by Sam", "I'm based in Berlin", "I work at Acme", "My timezone is CET", "My birthday is March 3", "I'm allergic to peanuts", "Contact me at sam@example.com", "GitHub: @sam" |
| Personal data | "My salary is on file", "My social security number is on file", "I take 10mg of allergy medicine daily" |
| Credentials-adjacent (no secret value) | "My API key is stored in the vault", "Staging DB password is in Vault", "We rotate tokens monthly", "I use 1Password", "My keys live in ~/.ssh" |
| Durable language | "From now on, use DeepSeek", "Going forward, respond in English", "Default to metric units", "Always use DeepSeek", "Never mention the old project", "I always use DeepSeek for coding" |
| Identity-field contradiction | "My name is Sam" when memory says "My name is Rohan" (reason names the existing fact) |

| Routine (deliberately NOT held) | Why |
|---|---|
| "The loop gate stopped at 100 calls", "The gate is 30", "The build takes 5 minutes", "The version is 1.2" | measurements and plain observations |
| "The gate is 30" → "The gate is 20"; "The loop gate is broken" | ordinary updates of the same subject — see "Contradiction" below |
| "I am running the migration", "I am seeing a flaky test" | "I am" + verb-ing is not identity |
| "The linter says never use var", "Tests always use a temp dir" | quoted rule / third-party subject |
| "Alice prefers dark mode" | third-party preference |
| "The API key rotation job runs nightly" | "rotation" as a noun, not a verb |
| "The token bucket is 100" | token as a metric noun |
| "The TinyFish key has to be entered by the user in the vault" | ops fact about key entry, not credential ownership/location |
| "DeepSeek is the coding model" with kind=`fact` | a bare "X is the Y" statement is routine; kind=`preference` (or preference phrasing) is the signal — the agent must use it |

## Design review

DeepSeek (deepseek-v4.1-flash-free) reviewed the design before it was
built (11,007 tokens: 2,320 in, 8,687 out). Its findings, and what
happened to each:

1. **Classify on phrasing, not only on kind** — adopted. A `kind=fact`
   "Prefers dark mode" is held; a `kind=preference` is held by kind.
2. **Pending table inside memory.db, with conditions** — adopted: never
   touch `meta.schema_version`, `CREATE TABLE IF NOT EXISTS` lazily, no
   FTS indexing of pending text, no foreign key. Verified by test
   (schema version stays 2; a v1 database still migrates to v2 after a
   gate propose; the pending row survives the migration).
3. **Drop broad contradiction detection as a blocker** — adopted, with
   a narrower replacement. A general same-subject/different-value rule
   false-positives on normal updates ("the gate is 30" → "the gate is
   20"), which would violate "do NOT ask every time". The gate holds
   only **identity-field** contradictions (my name / email / username /
   timezone / address / phone), where a change is unambiguous and worth
   confirming. General contradiction detection stays with the agent, and
   `supersede_fact` is the explicit correction path.
4. **Prefer a wrapper CLI; leave facts.py untouched** — adopted (see
   "What was touched"). The lazy-import fallback the original plan
   considered is fragile (circular import, hyphenated directory,
   machine-sync coupling) and buys nothing the wrapper does not.
5. **Data-loss risks** — adopted: accept writes the fact first, then
   marks the row (retry-safe via dedup); secret check runs before any
   pending insert and again at accept; cap refusal is loud and never
   falls back; ids come from `AUTOINCREMENT` (no SELECT MAX race);
   accept-twice yields one fact row. All covered by tests.
6. **Lessons caps that do not transfer** — adopted (see "Caps reused").
7. **kind=`lesson` in facts vs the lessons ledger** — decided: NOT
   routed. `kind="lesson"` in facts.py is a fact-store kind (a
   lesson-shaped fact record), distinct from the lessons ledger in
   MEMORY.md, which keeps its own gate. The gate classifies a
   kind=`lesson` fact by content like any other kind; there is no
   second consent surface for the same write, because the two stores
   hold different things.

Two real bugs the test caught while building (both fixed, both covered
by tests that now pass): the credential-noun list missed plurals
("We rotate tokens monthly" slipped through as routine), and the
contradiction check used dict-style row access on connections without a
row factory (a hand-built v1 DB), which raised instead of classifying.

## Tests

```bash
python3 features/memory/durable-write/test_durable_write.py   # T133, 114 checks
python3 features/memory/test_facts.py                          # T117, 41 checks
python3 features/memory/test_facts_v2.py                       # T118, 40 checks
python3 features/memory/test_lessons.py                        # 45 checks
bash scripts/checks/run-checks.sh                             # ALL CHECKS PASS
```

Measured 2026-11-18: T133 **114/114**, T117 41/41, T118 40/40,
lessons 45/45, `run-checks.sh` ALL PASS (incl. secret scan).

The test is fail-first proven: on the pristine code (no
`durable_write.py`) it fails at import with `ModuleNotFoundError`.
Coverage includes: the 47-case classifier golden table; a high-stakes
fact held (no facts row, not searchable); accept flushing into memory
v2 with provenance; a routine fact writing silently with provenance;
direct `facts.add_fact` unaffected (incl. the duplicate shortcut);
a rejected fact never landing and accept-after-reject refused; the cap
of 3 (4th refused loudly, no fallback write, slot frees on accept);
`--why` required (empty/whitespace refused); secrets rejected with no
secret bytes at rest; accept idempotency (one fact row); 400/401-char
boundaries; search isolation; identity contradiction held vs numeric
and status updates routine; schema safety (version untouched, v1→v2
migration after a propose); no auto-supersede; the CLI end to end;
and the flat machine layout (facts.py + recall.py + durable_write.py
side by side) importing and working.

## Machine sync

Repo file → live path (synced 2026-11-19, live-checked on the machine):

| Repo | Live path on the machine |
|---|---|
| `features/memory/durable-write/durable_write.py` | `/data/home/qwenpaw/working/memory-tools/durable_write.py` |
| `features/memory/durable-write/test_durable_write.py` | `/data/home/qwenpaw/working/memory-tools/` |
| `features/memory/SKILL.md` | `/data/home/qwenpaw/working/workspaces/default/skills/memory/SKILL.md` |
| `features/memory/facts.py` | unchanged by this gap, already synced (T137 fix synced separately) |
| `features/memory/recall.py` | unchanged, already synced |

The pending store lives in the existing
`/data/home/qwenpaw/working/workspaces/default/memory.db` — no new
database, no new file to sync. No container restart, no write to
`auth.json`, `.env`, or any user chat. `durable_write.py` must travel
with `facts.py` + `recall.py`: in the repo layout it imports `facts`
from the parent directory; in the flat machine layout it imports the
sibling. Both layouts are covered by the test.

## Deliberately left alone (and why)

- **`facts.py` untouched by this gap** — the wrapper is enough; see above.
  (facts.py itself was fixed separately for T137, 2026-11-19.)
- **SKILL.md routing line — DONE 2026-11-19, no longer left alone.**
  The routing line ("route EVERY add through `durable_write.py
  add-gated`, never `facts.py add`") is in `features/memory/SKILL.md`
  and synced to the machine skill path, so the gate is now wired
  into the agent loop. Live-checked on the machine the same day
  (held-fact → accept → searchable round-trip on a scratch DB).
- **No general contradiction detector** — see design review #3. The
  narrow identity-field version is what shipped.
- **No semantic/vector judgement of "high-stakes"** — no embedding
  model is configured and local models are forbidden; the lexical
  rule table is the only honest path today. New shapes found in real
  logs can be added to the table with a golden-table row each.
- **No cap on accepted facts** — facts are unbounded add-only by
  design; only the pending queue is capped (3), like the lessons
  ledger.
- **No auto-supersede in the gated path** — a supersede is a
  deliberate act; the gate never calls it, and `supersede_fact`
  never creates a pending row (both asserted by tests).
