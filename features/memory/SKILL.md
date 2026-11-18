---
name: memory
description: "Compact fact memory + session handoff for cross-session recall. At the start of a session, read the latest handoff and retrieve only the relevant facts (a few hundred tokens) instead of the whole history. Retrieval is multi-signal (BM25 + entity overlap + importance, fused by reciprocal rank fusion) so a fact about the same project or person ranks up even when the keywords are thin. During a session, distill salient facts, decisions, and preferences into the fact store. At the end of a session, write a handoff so the next session continues where this one left off. History is never modified — facts are additive, superseded facts stay readable, and universal search reaches back into the full history when needed."
version: "2.0"
metadata:
  qwenpaw:
    emoji: "🧠"
    requires:
      bins: ["python3"]
---

# Memory — compact facts + session handoff

You have a memory that costs few tokens and is fast to search. It is
**not** the whole conversation history. The full history stays in
`history.db` (never modified, never deleted) and is searchable on demand.
This skill is the compact layer on top of it: distilled facts plus a
session handoff, so a new session can continue where the last one left
off instead of starting cold.

## The tools (all read `memory.db`, a NEW file — never history.db)

All commands run on the machine (you are inside the QwenPaw container).
The store lives at `/app/working/workspaces/default/memory.db`
and the CLI at `/app/working/memory-tools/facts.py`.
(These are the in-container paths: the host directory
`/data/home/qwenpaw/working` is mounted at `/app/working`.)

```bash
DB=/app/working/workspaces/default/memory.db
CLI=/app/working/memory-tools/facts.py
HIST=/app/working/workspaces/default/history.db

# start of a session: what did the last session leave?
python3 $CLI --db $DB handoff-read
# retrieve only the facts relevant to the current topic (a few hundred tokens)
python3 $CLI --db $DB search --query "<topic>" --limit 5
# search everything (facts + the full history, read-only)
python3 $CLI --db $DB search-history --history $HIST --query "<topic>" --limit 3
# propose candidate facts from a transcript (proposes only, never writes)
python3 $CLI --db $DB extract --transcript /tmp/turns.txt --session <id>
# add a fact you judged salient (entities are auto-extracted from the
# text when you do not supply them — people, projects, quoted names).
# Route EVERY add through the durable-write gate, NOT `facts.py add`:
# high-stakes facts (preferences, identity, credentials-adjacent
# mentions, "from now on" language) are HELD for explicit accept and
# never land unattended; routine facts write silently with provenance.
# `facts.py add` is the raw low-level path — do not call it directly.
python3 /app/working/memory-tools/durable_write.py --db $DB add-gated \
    --text "<one sentence>" --kind decision --session <id> --importance 3
# a held fact waits in the pending store until it is confirmed:
python3 /app/working/memory-tools/durable_write.py --db $DB list
python3 /app/working/memory-tools/durable_write.py --db $DB accept \
    --id PF-001 --why "user confirmed"
# what was true on a past date? (time travel: facts valid then)
python3 $CLI --db $DB search --query "<topic>" --as-of 2026-11-15 --limit 5
# end of a session: write the handoff for the next session
python3 $CLI --db $DB handoff-write --session <id> --summary "<one or two sentences>" \
    --open-tasks '["First open task", "Second open task"]' \
    --left-off "<where this session stopped, in one sentence>"
```

If a command fails because a file is missing, say so and stop — do not
invent a path. Do not write to `history.db`, `working.secret/auth.json`,
or any user chat.

## Session start — always do this first (it is the recall)

When a session starts — and whenever the user says "continue", "where
were we", or "what were we doing" — run `handoff-read` first, then
`search` for the topic at hand. That is the whole context you need to
continue. Do **not** dump the whole history into context; the handoff
plus the retrieved facts is the context (a few hundred tokens). If there
is no handoff yet (`found: false`), say so plainly and start fresh.

## During a session — distill, do not hoard

When a decision is made, a preference is stated, a commitment is taken,
or a measurement is verified, it is a fact worth keeping. Use `extract`
on the recent turns to get candidates, review them, and `add-gated`
only the salient ones — through `durable_write.py add-gated`, never
through `facts.py add`. The gate holds high-stakes facts (any
`preference`, identity such as "My name is…", credentials-adjacent
mentions, durable language such as "from now on") in a pending store
until they are explicitly accepted (`accept --id PF-001 --why "user
confirmed"`); routine facts write silently. A held fact is not
searchable and not durable until accepted — never work around a hold
by writing the fact directly. One sentence per fact. Kinds:

- `decision` — a choice that was made ("We decided to fix the gate, then build the derived image.")
- `preference` — a standing user preference ("DeepSeek is the coding model; use it at maximum context.")
- `task` — a commitment or open item ("Build the derived image from the pinned digest.")
- `fact` — a verified measurement or rule ("The gate stopped at 100 calls in the live test, not 30.")
- `lesson` — something learned the hard way ("Lowering max_iters does not stop a tool-call loop.")

Do **not** add trivia, tool output, or anything containing a credential.
A fact containing a token is rejected by the tool — that is correct, do
not work around it. If a fact later turns out wrong, do not delete it:
use the replacement path (add the corrected fact; the old one is marked
superseded and stays readable). The store is add-only.

## Session end — write the handoff

Before finishing a session, write the handoff: a one-or-two-sentence
summary, the open tasks as a JSON list, and one sentence saying where
this session stopped. The next session reads it first. If you do not
write a handoff, the next session starts cold — that is the failure
this skill exists to prevent.

## Universal search — facts first, history when needed

`search` covers the compact facts (fast, few tokens). It ranks by three
signals at once — BM25 keywords, entity overlap (a fact about the same
project, person, or tool as your query ranks up), and importance — so
you get the most relevant facts, not just the ones with the most
matching words. Each result reports its `entity_overlap` and
`fused_score`. If the answer is not in the facts, use `search-history`:
it returns the same facts plus windows from the full history (read-only,
token-budgeted, redacted). Always say which one you used and how many
tokens the retrieved set cost — the user cares about the token count.

To ask what was true at an earlier time ("what did we believe about X
last week?"), add `--as-of YYYY-MM-DD` to `search`: it returns the facts
that were valid then, including ones that have since been superseded.
A superseded fact is never deleted — its validity window just closes,
so the past stays answerable.

## What this skill does NOT do

- It does not summarise or rewrite history. The raw history stays intact.
- It does not run automatically. Until a lifecycle hook exists (a
  follow-up, layered on the derived image), the agent follows this skill
  by convention: handoff-read at the start, facts during, handoff-write
  at the end.
- It does not use embeddings or any external service. Retrieval is
  multi-signal lexical (FTS5 + BM25, entity overlap, importance, fused
  by reciprocal rank fusion) over a single-user store, which is fast
  enough at this size. Semantic (vector) search would need an embedding
  model; none is configured, and local models are forbidden here, so
  the lexical path is the only honest one today.
