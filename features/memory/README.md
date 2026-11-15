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

## Tests

```bash
python3 features/memory/test_recall.py     # 44 checks
python3 features/memory/test_lessons.py    # 45 checks
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
| `features/memory/test_*.py` | `/data/home/qwenpaw/working/memory-tools/` |

No container restart, no restart of any service, no write to `auth.json`,
`.env`, or any user chat. These tools only ever read.

`history.db` is **not** bind-mounted anywhere new — it is already inside the
container at `/app/working/workspaces/<agent>/history.db` because
`/data/home/qwenpaw/working` is mounted at `/app/working`.

## Deliberately not done

- **No Ripwire install.** It is a C++23 binary needing AVX2 and a host
  install at `/data/home/ripwire` with a bind mount. That is a machine
  change, it needs AVX2 verified on the VM first, and it buys nothing until
  Tier 1 recall is proven insufficient. It stays a documented next step,
  not a commit.
- **No deja-vu pilot.** Its marginal value is the lifecycle around search
  (promote/remember/handoff), not search itself — and QwenPaw is not one of
  its 46 harnesses, so it needs a custom parser. Revisit only if real
  queries fail on paraphrase.
- **No embeddings.** No embedding model is configured, so the lexical path
  is the only honest one today.
