# eviction-index-rs — third Rust port (file granularity, path (a))

**Status:** proven port, gate pass, enabled in the source tree. Local-only.

| | |
| --- | --- |
| Source file | `src/qwenpaw/agents/context/scroll/eviction_index.py` (421 lines) |
| Unit bridged | `src/qwenpaw/agents/context/scroll/` (whole package — see "Bridging one file" below) |
| Crate | `rust/eviction-index-rs` |
| Tool | rust-anything 3.3.0 (PyO3 / abi3-py39) |
| Gate | **987 / 987 recorded cases matched**, 0 failed |
| Rust size | 419 lines |
| Speed | **0.7x** — slower; see "Why it is not a speedup" |
| Switched on | **on** — the original file carries the port block |

## What it does

The eviction index is the in-prompt "odometer" of turns evicted from the live
context window: a stack of tiers where tier 0 keeps recent evictions in full and
each higher tier squeezes older history into span endpoints. Six functions are
pure over a plain-JSON tier stack:

| Function | What it does |
| --- | --- |
| `collapse_blocks` | fold a run of blocks into one, each input becoming one line with its full span and endpoint headlines |
| `apply_eviction` | add one evicted span to tier 0, then run the carry cascade |
| `render_index` | the whole `[context compressed]` placeholder, with three detail-budget fallbacks |
| `describe_index` | the tier lines only (no envelope, no preamble) |
| `bounded_headline` | truncate one headline to a character limit |
| `bounded_line_text` | truncate one line, splitting the budget between two endpoints |

The carry cascade is the reason this is worth doing carefully rather than
quickly: when a tier fills, the oldest `cap-1` blocks collapse into one block a
tier up, and that can cascade arbitrarily far. The port keeps the cascade
self-similar (a turn, a span, and a span-of-spans all reduce the same way), so
it is lossless at any depth. 987 recorded cases include 120 randomized stacks
that drive the cascade 3-4 tiers deep.

## Why it is not a speedup

`0.7x` on the call-included benchmark, and the tool says so plainly: *"Do not
ship this unit for speed: calling across costs more than the work these
functions do."* These are microsecond-scale functions, so the PyO3 boundary
dominates. It ships **on** for the behavioural reason: the Python that
implements the cascade is now the Rust that 987 cases pin down, and a
whole-unit port (the compiler plus its callers) is the next step if speed is
wanted.

Recorded honestly instead of hidden — the same call the visual-compression port
made at 0.4x.

## Bridging one file

`rust-anything bridge` refuses a single file inside a package: it wants a unit
id, and the unit here is the whole `scroll/` package (11 files, 9,068 lines).
Bridging the unit and then keeping 22 of its exports in Python is how a
**single-file** port stays a single-file port — every export from
`continuation_summary.py`, `history.py`, `manager.py`, `memoryspace.py`,
`prompt.py`, `recall_tool.py`, `repl.py`, `serialize.py` and `sync.py` was
`--keep`-ed with a reason, so the crate contains exactly the six functions of
`eviction_index.py`.

Two exports had to stay in Python for a second reason:
`tiers_to_json` / `tiers_from_json` are the **seam** between the dataclasses and
JSON. Rebinding them to Rust does not work — `refresh` generated a binding that
takes `PyAny`, and the class calls `tiers_to_json(self._tiers)` with real
`Block` objects, so the call fails with `unsupported argument type Block`. The
first `enable` therefore broke the class; the fix is in `rust-anything.json`'s
`js_only` list, where both seam functions are recorded as Python-only with that
reason. With them back in Python, old and new produce **identical behaviour**:

```text
MODE=old digest: 93e4364f7a76dcdd1cdf8648d616bb7b
MODE=new digest: 93e4364f7a76dcdd1cdf8648d616bb7b
```

(25 randomized sessions, hashing `describe()`, `render(budget)` and `to_dict()`.)

## Gate

`rust-anything gate rust/eviction-index-rs` — all pass:

- **behavior** — 987/987 recorded cases matched.
- **clippy / fmt / test / unsafe / lockfile / ported / size / panics / api** — pass.
- **api** — exports `collapse_blocks`, `apply_eviction`, `render_index`,
  `describe_index`, `bounded_headline`, `bounded_line_text`; the two seam
  functions stay in Python by design.

Two first-run failures were mine, not the port's: `fmt` (fixed with `cargo fmt`)
and an invalid generator that fed a 3-level nested tiers shape and `dict` where
`Block` objects were required. Both are the generator's fault and are fixed in
`/tmp/eviction-inputs.jsonl`'s script; the recorded set now contains only
well-formed cases plus one deliberate raising path.

`rust-anything fuzz` also reports mismatches, but they are all the same
artifact: the fuzzer generates `Block` objects with `null` lines, both sides
raise, and only the **error text** differs (Python's `AttributeError` naming vs
the port's `ValueError`). No case produces a different *value*.

## Files

```text
rust-ports/eviction-index/
  src/qwenpaw/agents/context/scroll/eviction_index.py    the enabled source
  rust/eviction-index-rs/src/port.rs                     the port
  rust/eviction-index-rs/cases.jsonl                     987 recorded cases
  rust/eviction-index-rs/rust-anything.json              exports + the two js_only seam reasons
  rust/eviction-index-rs/report/REPORT.md                the report card
```
