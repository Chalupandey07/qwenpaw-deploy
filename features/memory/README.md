# Memory (Phase 4) — bounded recall, lessons ledger, ReMe doctor

Three stdlib-only Python tools. No new index, no embeddings, no LLM call,
no third-party dependency. Everything here is read-only with respect to
QwenPaw's data.

## Read this first: what already exists upstream

QwenPaw **v2.3.0 already ships full-text history recall.** Verified against
the real source on 2026-11-15:

- `src/qwenpaw/agents/context/scroll/memoryspace.py` → `MemorySpace.search()`
  over an external-content FTS5 table
  `conversation_history_fts` (tokenize `porter unicode61`) on
  `conversation_history`, with SQLite progress-handler timeouts.
- `src/qwenpaw/agents/context/scroll/recall_tool.py` → the agent-facing
  `recall_history` tool (`op="search"|"expand"|"recall_tool"|"days_between"`),
  including the equivalent of `fts_match_query()` and a LIKE fallback for
  builds without FTS5.
- `src/qwenpaw/agents/memory/reme_config.py` deliberately scopes ReMe to
  `daily_dir` + `digest_dir` **markdown only**, with an explicit comment
  that raw conversation lookup belongs to `recall_history(op="search")`.

So the plan's "Tier 1 FTS5 recall bridge" would have **duplicated working
code**. What upstream's tool does *not* do is what this directory adds:

| Gap | Upstream | Here |
|---|---|---|
| Budget unit | rows (1000) / bytes (4 MB) | **tokens (2,000 hard cap)** |
| Result count | `k` default 10 | **3 hard default, 10 absolute max** |
| Credential safety | none | **redaction at read time** |
| Runs outside the agent loop | no (in-process tool) | **yes (host CLI)** |
| Lessons workflow | none | **candidate/accept ledger** |
| "Why is memory empty?" | none | **5-cause doctor** |

Use upstream `recall_history` **inside** a conversation. Use these tools
**outside** it, or when the token budget and redaction matter.

## `recall.py` — bounded recall

```bash
python3 recall.py --db /data/home/qwenpaw/working/workspaces/default/history.db \
  --query "desktop lease" --limit 3

python3 recall.py --db ... --query "KV quota" --agent default \
  --since 2026-11-15 --json

python3 recall.py --db ... --check        # schema + FTS5 probe only
```

Guarantees, all covered by `test_recall.py`:

- **≤ 3 results by default**, ≤ 10 with `--limit`, never a whole session —
  every hit is a window of ≤ 600 chars around the first matching term.
- **≤ 2,000 tokens** per call. `ABSOLUTE_BUDGET_TOKENS = 2000` cannot be
  raised by a flag; asking for more is an error, not a clamp.
- **Empty is a valid answer.** With a tiny budget you get zero hits and
  `truncated_by_budget: true` rather than a maimed excerpt.
- **Redaction** of GitHub PATs, `sk-*`, AWS key ids, Slack, JWTs, bearer
  headers, `*token*/secret/password/api_key = ...` assignments, and long
  hex blobs. Reported as `redactions_applied`.
- **Tool-result rows excluded by default** (~65% of rows are tool noise);
  `--include-tool-results` opts in.
- **Read-only**, enforced twice: `mode=ro` URI plus an SQLite authorizer
  that denies every mutation.
- **Self-pollution guard**: rows whose `name` is `recall_history` /
  `recall_history_python` are skipped, mirroring upstream's FTS exclusion.

### One subtlety worth knowing

An external-content FTS5 table reads its own configuration from
`sqlite_master` through a `SQLITE_UPDATE` code path when the vtab connects.
A naive "deny all UPDATE" authorizer makes every FTS query fail with
`vtable constructor failed`. The authorizer therefore denies mutations for
every object **except** `sqlite_master`; `mode=ro` remains the real
guarantee. `test_recall.py` covers both halves (FTS works *and* writes are
denied).

## `lessons.py` — the lessons ledger

Operates on the **existing** `## Important Decisions and Lessons` section of
`MEMORY.md` (no new file — the plan says so, and MEMORY.md is already read
whole at task start).

```bash
python3 lessons.py --file MEMORY.md list
python3 lessons.py --file MEMORY.md check

# propose is the ONLY thing the agent may do unattended:
python3 lessons.py --file MEMORY.md propose \
  --guidance "Verify the Chromium binary before trusting installed:true." \
  --reason "A stale marker reported it installed after the binary was purged." \
  --evidence "2026-11-15 disk cleanup, session sess-alpha." \
  --revisit "Drop this if the desktop API starts returning a hash." \
  --kind gottcha --scope desktop

# durable write — explicit, separate, requires a reason:
python3 lessons.py --file MEMORY.md accept --id L-004 --why "user confirmed"
python3 lessons.py --file MEMORY.md reject --id L-005 --why "duplicate of L-002"
```

Enforced limits: **≤ 10 accepted**, **≤ 3 candidates**, **≤ 800 words** in
the block, ≤ 400 chars per field. Ids are `L-001`-style, allocated from the
highest existing number and **never reused**. Accepted entries require
`Evidence`.

**Secrets are rejected, not scrubbed.** If any field trips the redactor the
whole proposal fails and the file is left untouched — a lesson containing a
token is a bug upstream, not something to quietly edit away.

Everything outside the section (header, Profile, other headings, prose) is
preserved verbatim across a rewrite; `test_lessons.py` asserts this.

## `consolidate.py` — the missing consolidation step

QwenPaw already ships ReMe (daily/distill markdown) and FTS5 history recall,
and the tools above add bounded recall and a lessons ledger. The one thing
nothing did was **carry experience forward**: daily notes accumulated and
nothing turned them into durable lessons.

```bash
# dry run (default) — shows what WOULD be proposed, changes nothing
python3 consolidate.py --memory MEMORY.md --daily memory/ --digest digest/

# actually write candidates into the ledger
python3 consolidate.py --memory MEMORY.md --daily memory/ --write
```

It proposes into `lessons.py`'s existing candidate→accept ledger and **never
accepts anything**. That separation is the design: an agent that can silently
write its own long-term memory accumulates confident nonsense.

**Why rule-based, not an LLM.** Consolidation is a *selection* problem, not a
generation problem. Doing it with a model costs a call per run and produces
plausible lessons no failure justifies. The rules match the shapes that
actually precede a durable lesson in this repo's history:

| Shape | Example | Why it is a lesson |
|---|---|---|
| correction | "turns out", "actually" | a claim was wrong; the correction is the value |
| retrospective | "should have", "next time", "never again" | an explicit lesson already stated |
| hard limit | "cannot", "only works if", "free tier", "quota" | constraints are the most valuable entries |
| root cause | "the reason was", "caused by", "root cause" | a mechanism rather than a symptom |
| measurement | "verified", "confirmed", "measured" | a measured fact beats a remembered one |

**Zero candidates is the healthy result for a quiet day** and the script says
so — it does not manufacture an entry to look productive.

**Secrets are dropped, not scrubbed.** Every field passes the same redactor as
`recall.py`; a line that trips it is discarded with a warning and the original
text is left untouched, so the bug stays visible instead of being quietly
edited away. (Silently rewriting it would hide that a token reached a log.)

**Idempotent.** A candidate whose guidance already exists — exact, contained,
or ≥60% token overlap — is skipped, so hourly cron runs do not stack
duplicates. Capped at 3 per run to match the ledger's pending limit; extras
defer to the next run.

Cron-friendly: the routines Worker already wakes the box, so this can run
after a routine without any new scheduling.

## `reme_doctor.py` — why did memory produce zero notes?

`memory/` and `digest/` being empty is **not** automatically a bug. Five
independent gates can each silently yield zero notes (all confirmed in the
v2.3.0 source):

| # | Cause code | Real gate |
|---|---|---|
| 1 | `interval_disabled` | `auto_memory_interval <= 0` disables periodic auto-memory (`agents/middlewares.py:222`) |
| 2 | `automation_only` | `_is_automation_request()` returns before any write — cron/webhook turns never write memory (`middlewares.py:317`) |
| 3 | `below_interval` | fewer resolved user turns than the interval (`middlewares.py:233`) |
| 4 | `reme_not_started` / `reme_disabled` | `_initialize_reme` swallows every exception but the contract error (`reme_light_memory_manager.py:299`) |
| 5 | `no_active_model` | auto-memory needs a chat model to summarise (`_prepare_auto_memory_job`) |

```bash
python3 reme_doctor.py --root /data/home/qwenpaw/working --agent default
python3 reme_doctor.py --root ... --json     # machine-readable
python3 reme_doctor.py --selftest            # 11 checks, no machine needed
```

Exit `0` = healthy, `3` = at least one blocking cause. Read-only: it reads
`config.json`, `qwenpaw.log` (tail), `history.db` (`mode=ro`) and counts
markdown files. It never writes, restarts, or prints a credential.

## `facts.py` — compact fact store + session handoff (cross-session recall)

Mem0-style extract-and-retrieve, self-contained on the Free machine.
No new database, no managed service, no embeddings, no new provider.
Stdlib only. The full history stays in `history.db`, untouched; this
adds a SECOND, compact store (`memory.db`) of distilled fact records,
so a turn retrieves a few hundred tokens of relevant facts instead of
the whole history — and a new session reads the previous session's
handoff instead of starting cold.

**v2 (2026-11-18) — trending-architecture upgrade, same constraints.**
The user asked for memory search that costs fewer tokens, is super
fast, and is built on the latest trending GitHub memory architecture
(Mem0 ~68K stars, Zep/Graphiti ~32K, Letta ~25K, Supermemory ~31K,
Hindsight 91.4% LongMemEval). What v2 takes from them, without a new
database, a managed service, embeddings, or a new key:

- **Multi-signal retrieval (Mem0).** v1 was BM25 only. v2 fuses three
  signals by weighted reciprocal rank fusion (RRF, k=10): BM25 over the
  FTS5 index (weight 1), **entity overlap** (weight 2 — a fact sharing
  a person/project/tool with the query ranks up), and **importance**
  (weight 2). Entities are extracted rule-based and stdlib-only
  (quoted names, a known-name lexicon, CamelCase/acronyms, capitalised
  phrases) and auto-populated on `add`; `backfill-entities` fills them
  for older facts. A query with no entities degrades gracefully to
  BM25 + importance. Each result reports `entity_overlap` and
  `fused_score`.
- **Temporal validity windows (Zep/Graphiti).** Facts now carry
  `valid_from` / `valid_to`. Superseding a fact closes its window
  (sets `valid_to`), it never deletes the row. `search --as-of
  YYYY-MM-DD` is time travel: the facts that were valid then, including
  ones superseded since. Schema v1 -> v2 migrates on open (adds the
  columns, backfills `valid_from` from `created_at`); existing rows are
  never rewritten or deleted.
- **Tiered memory (Letta).** Already the shape here: the handoff is
  the always-in-context core (summary + open tasks + where it left
  off, ≤ 300 tokens) and the facts are the archival store retrieved on
  demand. v2 does not change that; it makes the retrieval smarter.

Deliberately NOT added (and why): **semantic/vector search** needs an
embedding model — none is configured, local models are forbidden, and
no cloud embedding key exists, so the lexical path is the only honest
one today. **Sleep-time consolidation** (Letta/Mem0 Dream) needs a
background agent while idle; `consolidate.py` is the manual version and
an idle-time run is a follow-up. **A graph database** (Neo4j/FalkorDB
for Graphiti) is heavy and violates "no heavy new database" — the
validity windows + entity overlap give the temporal + entity benefits
without one.

```bash
DB=/data/home/qwenpaw/working/workspaces/default/memory.db
HIST=/data/home/qwenpaw/working/workspaces/default/history.db

python3 facts.py --db $DB check
python3 facts.py --db $DB add --text "DeepSeek is the coding model." \
    --kind preference --session sess-a --importance 3
python3 facts.py --db $DB search --query "loop gate" --limit 5
python3 facts.py --db $DB search --query "loop gate" --as-of 2026-11-15
python3 facts.py --db $DB backfill-entities
python3 facts.py --db $DB extract --transcript turns.txt --session sess-a
python3 facts.py --db $DB handoff-write --session sess-a \
    --summary "Fixed the gate design." \
    --open-tasks '["Build the derived image"]' \
    --left-off "Waiting on the image build."
python3 facts.py --db $DB handoff-read        # latest handoff
python3 facts.py --db $DB search-history --history $HIST --query "gate"
```

Guarantees, all covered by `test_facts.py` (T117, 41 checks) and
`test_facts_v2.py` (T118, 40 checks):

- **Add-only.** Adding the same fact twice returns the same id (content-hash
  dedup). A fact that changes is SUPERSEDED, never deleted — the old row
  stays, marked, so "what was true then" stays answerable. Search excludes
  superseded rows by default.
- **Token-budgeted retrieval.** Multi-signal (BM25 + entity overlap +
  importance, RRF-fused), default limit 5, default budget 500 tokens,
  hard cap 1000. The test measures the win: the retrieved set costs
  < 10% of the full history text, and the FTS query runs in < 100 ms.
- **Temporal validity.** Superseding closes the old fact's validity
  window (`valid_to`); `search --as-of DATE` returns the facts valid
  then. The v1 -> v2 migration (new columns, backfilled from
  `created_at`) is add-only and covered by a test that builds a real
  v1 database and opens it with the v2 code.
- **Handoff.** A handoff written by session A is read by session B and
  carries the open tasks + where A left off, in ≤ 300 tokens.
- **Secrets are rejected, not scrubbed** (like `lessons.py`): a fact
  containing a credential pattern is refused and no row is written.
- **Universal search.** `search-history` returns the facts AND reaches
  back into `history.db` read-only through `recall.py` — the memory can
  see everything, not just the extracted facts.
- **Extraction is selection, not generation.** `extract` proposes
  candidate facts from a transcript using the same shapes as
  `consolidate.py` (decision, preference, task, measurement, correction,
  lesson). It never writes. The agent's LLM reviews the candidates and
  adds the salient ones — no model call inside this tool, no new key.

The skill (`SKILL.md`, same directory) is what the agent reads: handoff-read
at the start of a session, facts during, handoff-write at the end. Until a
lifecycle hook exists (a follow-up layered on the derived image), the agent
follows it by convention. The skill is installed on the machine at
`working/workspaces/default/skills/memory/SKILL.md` and enabled with
`docker exec qwenpaw qwenpaw skills enable memory`.

## Tests

```bash
python3 features/memory/test_recall.py     # 44 checks
python3 features/memory/test_lessons.py    # 45 checks
python3 features/memory/test_facts.py      # 41 checks
python3 features/memory/test_facts_v2.py   # 40 checks (entity boost, RRF, temporal validity, v1->v2 migration)
python3 features/memory/reme_doctor.py --selftest   # 11 checks
```

Wired into the main suite as **T62/T63/T64** (local) and **T65** (live
machine diagnosis; reports `NEEDS-VERIFICATION` until the files are synced,
never a false PASS).

## Machine sync (Muse does this — see §7 of the handoff)

Repo file → live path:

| Repo | Live path on the machine |
|---|---|
| `features/memory/recall.py` | `/data/home/qwenpaw/working/memory-tools/recall.py` |
| `features/memory/lessons.py` | `/data/home/qwenpaw/working/memory-tools/lessons.py` |
| `features/memory/reme_doctor.py` | `/data/home/qwenpaw/working/memory-tools/reme_doctor.py` |
| `features/memory/facts.py` | `/data/home/qwenpaw/working/memory-tools/facts.py` |
| `features/memory/SKILL.md` | `/data/home/qwenpaw/working/workspaces/default/skills/memory/SKILL.md` |
| `features/memory/test_*.py` | `/data/home/qwenpaw/working/memory-tools/` |

The fact store itself lives at
`/data/home/qwenpaw/working/workspaces/default/memory.db` (created by
`facts.py` on first use; the workspace is root-owned, so seed it with
`sudo`). Sync with `python3 ~/workspace/scripts/sync-memory.py` — it
fetches the three files from GitHub, writes them, enables the skill,
and live-tests the CLI. The skill is enabled with
`docker exec qwenpaw qwenpaw skills enable memory` (scanner: 0 findings).

No container restart, no restart of any service, no write to `auth.json`,
`.env`, or any user chat. These tools only ever read.

`history.db` is **not** bind-mounted anywhere new — it is already inside the
container at `/app/working/workspaces/<agent>/history.db` because
`/data/home/qwenpaw/working` is mounted at `/app/working`.

## `install-ripwire.sh` — the optional code-map tool

Ripwire (`redhat-et/ripwire` v0.6.10, Apache-2.0) is a single offline binary
that streams a ranked symbol map of a codebase. **It is optional**: nothing
else in this directory depends on it.

```bash
# on the InstaBox host, as the user that owns /data/home
bash features/memory/install-ripwire.sh --check   # preflight only, no changes
bash features/memory/install-ripwire.sh           # install / upgrade to the pin
```

Four failure modes are checked **before** anything is written, each of which
has a real cost:

| Check | Why it exists |
|---|---|
| **x86-64-v3 / AVX2** | The `linux-x64` build is compiled for x86-64-v3. On an older vCPU it SIGILLs on the first vector instruction, which looks like a corrupt download. The required set is `avx avx2 bmi1 bmi2 f16c fma lzcnt movbe`. |
| **lzcnt is reported as `abm`** | Linux exposes the LZCNT feature as the `abm` flag. Grepping `/proc/cpuinfo` for the literal string `lzcnt` gives a **false negative** — this script accepts `abm\|lzcnt`. |
| **disk** | Root is a 20 GiB volume and `/tmp` is a 512 MB tmpfs that has been 100% full before. Nothing large goes to `/tmp`; the script refuses a `/tmp` prefix outright and requires a 200 MB floor free. |
| **integrity** | The release ships a `.sha256` sidecar; it is verified before unpacking, and the extracted binary is **probed** (`--version`) before it is installed, so a CPU mismatch fails cleanly instead of half-installing. |

The install is idempotent: re-running at the same version is a no-op, and an
upgrade writes beside the target then renames, so there is never a partially
written binary. It copies the 17 upstream agent skills that ship in the
tarball. It does **not** edit `docker-compose.yml`, restart the container, or
touch `.env` / `auth.json` / chats — it prints the one volume line Muse needs
to add, and stops.

Measured on a real install (this VM): tarball 10,970,224 bytes, sha256
verified, binary 57,896,960 bytes, `ripwire 0.6.10` runs, 17 skills copied,
re-run a clean no-op.

### The token trap this encodes

The plan's research note quotes `--for="<change>"` at "~2.1K tokens". That
number only holds **with `--token-budget`**. Measured on this repo:

| command | measured |
|---|---|
| `--handoff` | ~350–530 tokens |
| map `--max-tokens=2000` | ~840 tokens |
| map (default, top-200) | ~5,500 tokens |
| `--affected=path` | ~450 tokens |
| `--impact=SYM` | ~1,200 tokens |
| `--callers=SYM` | ~1,700 tokens |
| `--for="..." --token-budget=2000` | ~2,100 tokens |
| **`--for="..."` unbudgeted** | **~9,700 tokens** |
| reading the source directly | ~261,000 tokens |

So unbudgeted `--for` costs about **twice the plain map** — the opposite of
what an agent would assume from the note. `skills/ripwire/SKILL.md` states
this in the skill itself, where the agent will actually read it.

Two more behaviours found by running the binary rather than trusting the note:

- **`--help-task` abstained on every input tried** in v0.6.10, including exact
  identifier shapes (`` `dir_is_ours` ``, `recall()`) on repos where those
  symbols *are* indexed — `resolved_symbols="0"` every time. The skill
  therefore does not route through it and says why.
- **`--verify` takes a closed claim grammar**, not free text:
  `calls(A,B)`, `uses(SYM)`, `unused(SYM)`, `contains(FILE,"LITERAL")`,
  `defines(FILE,SYM)`, `reaches(SYM,"FILE"|LAYER)`. Free text exits 1 with the
  list. Verified against this very code: `calls(recall, redact)` → confirmed,
  `contains(features/memory/recall.py, "ABSOLUTE_BUDGET_TOKENS")` → confirmed.

### Skill install

`features/memory/skills/ripwire/SKILL.md` is the QwenPaw-format skill (same
frontmatter shape as `camoufox-browser`). It declares `RIPWIRE_BIN` and the
`ripwire` binary as requirements, and tells the agent to fall back to reading
files when either is missing — never to silently skip the step.

Install it where QwenPaw reads skills (the same place `camoufox-browser` and
`build-page` live), and set `RIPWIRE_BIN=/data/home/ripwire/ripwire` in the
container environment.

## Deliberately not done

- **No deja-vu pilot.** Its marginal value is the lifecycle around search
  (promote/remember/handoff), not search itself — and QwenPaw is not one of
  its 46 harnesses, so it needs a custom parser. Revisit only if real queries
  fail on paraphrase.
- **No bind mount written by this repo's tooling.** `install-ripwire.sh`
  prints the exact `volumes:` line but deliberately does not apply it: adding
  a volume requires recreating the container, which drops in-flight agent
  work, so that stays Muse's call.
- **No embeddings.** No embedding model is configured, so the lexical path is
  the only honest one today.
