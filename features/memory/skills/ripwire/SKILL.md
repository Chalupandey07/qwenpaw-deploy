---
name: ripwire
description: "Map a codebase before reading it: ranked symbol map, callers/impact, task lens, test gate, handoff brief. Use when you need to understand unfamiliar code, find what a change will break, choose which tests to run, or brief the next session — instead of reading whole files. Requires the ripwire binary (features/memory/install-ripwire.sh) and RIPWIRE_BIN."
version: "1.0"
metadata:
  qwenpaw:
    emoji: "🧭"
    requires:
      bins: ["ripwire"]
      env: ["RIPWIRE_BIN"]
---

# Ripwire

`ripwire` parses a codebase and streams a **deterministic ranked symbol map**
instead of making you read files. It answers "what matters here", "what breaks
if I change this", "which tests reach it", and "brief the next session".

**Cheap orientation, expensive detail.** Every command below costs tokens;
the numbers in this file were measured on this project's own repo with
`chars / 3.6` (the same estimator as `features/memory/recall.py`).

## The one rule that matters

**Always budget the output.** The task lens is the expensive one:

| command | measured cost |
|---|---|
| `--handoff` | ~350–530 tokens (the tool prints its own `est_tokens`) |
| map, `--max-tokens=2000` | ~840 tokens |
| map (default, top-200) | ~5,500 tokens |
| `--for="..." --token-budget=2000` | ~2,100 tokens |
| `--affected=path` | ~450 tokens |
| `--impact=SYM` | ~1,200 tokens (unbudgeted) |
| `--callers=SYM` | ~1,700 tokens (unbudgeted) |
| `--for="..."` **unbudgeted** | **~9,700 tokens** |
| reading the source directly | ~261,000 tokens |

`--for` without `--token-budget` is **not** a cheap command — on this repo it
is roughly twice the cost of the plain map. If you pass `--for`, pass
`--token-budget` with it. (The plan's research note quoted "~2.1K tokens" for
`--for`; that figure only holds *with* the budget flag.)

Where a command prints `est_tokens=`, trust that over this table — it is the
tool pricing its own output.

## Start here, in this order

```bash
# 1. Cold start / briefing: cheapest useful output.
"$RIPWIRE_BIN" "$RIPWIRE_DIR" --handoff

# 2. Orient: ranked map, budgeted.
"$RIPWIRE_BIN" "$RIPWIRE_DIR" --max-tokens=2000

# 3. About to change something: what does it touch?
"$RIPWIRE_BIN" "$RIPWIRE_DIR" --impact=SYMBOL          # transitive blast radius
"$RIPWIRE_BIN" "$RIPWIRE_DIR" --callers=SYMBOL         # direct callers
"$RIPWIRE_BIN" "$RIPWIRE_DIR" --affected=path/to/file  # tests that reach it

# 4. Before a pull request: which tests, and what is untested?
"$RIPWIRE_BIN" "$RIPWIRE_DIR" --test-gate     # exit 4 if either list is non-empty

# 5. Verify a claim about the code instead of guessing.
#    The claim language is CLOSED (a bad claim exits 1 and lists the shapes):
#      calls(A, B) · uses(SYM) · unused(SYM) · contains(FILE, "LITERAL")
#      defines(FILE, SYM) · reaches(SYM, "FILE"|"LAYER")
"$RIPWIRE_BIN" "$RIPWIRE_DIR" --verify='calls(recall, redact)'
"$RIPWIRE_BIN" "$RIPWIRE_DIR" --verify='contains(features/memory/recall.py, "ABSOLUTE_BUDGET_TOKENS")'
```

`RIPWIRE_DIR` should be the **repo root** of whatever you are working in. For
this project inside the QwenPaw container that is `/app/working/<workspace>`
or a checkout under it — not `/app` (that would index the whole image).

## What each verb is for

- **`--handoff`** — brief the next session: verified disk truth first,
  labelled guesses second. Best first command after a cold start.
- **`--help-task="TASK"`** — *intended* to return ONE recommended command,
  honouring an abstention when evidence is thin. **In v0.6.10 it abstained on
  every task we tried**, including exact identifier shapes (`recall()`,
  `` `dir_is_ours` ``) on a repo where those symbols are indexed
  (`resolved_symbols="0"` every time). Treat it as unreliable: do not depend
  on it, and route by this file instead. If a future release fixes it, this
  note is the thing to re-test.
- **`--impact=SYM`** — everything that reaches SYM. Run before editing a
  shared function.
- **`--affected=F1,F2`** — the test files that reach those changed files.
- **`--test-gate`** — the tests to run plus the untested blast radius;
  exits 4 when either is non-empty, so it works in CI.
- **`--verify="CLAIM"`** — confirmed / refuted / unknown, for a claim in the
  **closed grammar**: `calls(A, B)`, `uses(SYM)`, `unused(SYM)`,
  `contains(FILE, "LITERAL")`, `defines(FILE, SYM)`, `reaches(SYM, "FILE"|"LAYER")`.
  Free text is rejected with exit 1 and the list of valid shapes. Useful as a
  self-check before claiming what the code does.
- **`--recall=TASK`** — search the project's **docs** (plans, designs) rather
  than the code.
- **`--exemplar=TASK`** — the repo's best existing example of the kind of
  code you are about to write. Cheap way to match house style.
- **`--grep=STR`** — every hit comes back with its enclosing symbol, which is
  usually what you actually wanted from grep.

## Rules

- **English only** in anything you write with this.
- **Never** pipe `--for` output anywhere that feeds a prompt without
  `--token-budget`.
- `counts_floor="1"` in output means counts are a **floor, never a total**;
  `0` means none found. Do not report a floor as a count.
- If `$RIPWIRE_BIN` is unset or the binary is missing, **say so and fall back
  to reading files** — do not silently skip the step and pretend you mapped
  the code.
- Ripwire is read-only. It never modifies the tree (except `--quality-baseline`
  / `--arch --baseline`, which write a baseline file — do not run those
  without being asked).

## If it is not installed

`features/memory/install-ripwire.sh` on the host installs the pinned release
with a checksum check and an x86-64-v3 (AVX2) preflight. It is **optional**:
`features/memory/recall.py` and the rest of the memory layer work without it.
