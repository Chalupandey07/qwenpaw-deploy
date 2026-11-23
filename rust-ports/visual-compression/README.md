# visual-compression-rs — first Rust port (preserved record)

**Status:** proven port, 46/46 gate pass. **Not pushed anywhere.** Local-only in the
QwenPaw source tree; preserved here as a record so the work is not lost.

| | |
| --- | --- |
| Source commit | `e31ede8` — `rust(port): migrate visual_compression.effort_preset to Rust (first rust-anything port)` |
| Source tree | `/root/work/qwenpaw-source/` (branch `master`, 1 commit, no remote) |
| Unit ported | `src/qwenpaw/agents/context/visual_compression/` (Python) |
| Function | `effort_preset(effort)` — `config.py:71` |
| Tool | rust-anything 3.3.0 (PyO3 / abi3-py39) |
| Gate | **46 / 46 recorded cases matched**, 0 failed, 0 missing |
| Rust size | 24 lines in `src/port.rs` |
| Speed | 0.4x (752 ns Python vs 1.9 µs Rust per call — see "Why slower" below) |
| Fallback | 0.0% (0 of 46 cases fell back to the original) |
| Switched on | off in this record (see "Wiring" — the source tree has it on) |

## What the port does

`effort_preset` is a pure lookup with one error path: `"low"` / `"medium"` / `"high"`
each map to a fixed `EffortPreset` (cell width, line height, readable chars per image),
and anything else raises `ValueError("unknown Visual Compact effort: <value>")`.

The Rust side reproduces that exactly, returning the preset as a mapping
(`serde_json::Value`) that the generated Python wrapper turns back into the *real*
Python `EffortPreset` dataclass. `EffortPreset` itself is NOT ported — it stays in
Python so the public API is byte-identical for callers.

## Gate results (46/46)

`rust-anything gate .` in `rust/visual-compression-rs/` — ALL PASS:

- **behavior** — `diff` replayed 46 recorded cases: 46 passed, 0 failed, 0 missing,
  0 mismatches (`diff.json`). 43 of the cases are raising paths (bad effort values,
  wrong types), 3 are the returning paths.
- **clippy** — no warnings (`-D warnings` clean).
- **cargo fmt** — formatted.
- **cargo test** — passed.
- **unsafe** — 0 (`#![forbid(unsafe_code)]` in `port.rs`).
- **panics** — none where the original raises a normal Python error; error text matches
  the original `ValueError` message verbatim.
- **lockfile** — matches `Cargo.toml`.
- **api** — exports exactly `effort_preset`.

Recording: 46 cases in `cases.jsonl`, recorded from 20 files
(`recorded-from.json`, fingerprint `6223442a3a92241e`). Bench: `report/REPORT.md`
and `report/card.svg`.

## Wiring in the source tree

`src/qwenpaw/agents/context/visual_compression/config.py` carries the generated
`rust-anything` enable block at the bottom (copied verbatim in
`src/qwenpaw/agents/context/visual_compression/config.py` here). It:

- inserts `rust/visual-compression-rs/python` on `sys.path` and imports the compiled
  `visual_compression_rs` module, then rebinds `effort_preset` from it;
- **fails open** — if the native module is absent it silently keeps the Python
  original, unless `RUST_ANYTHING_MODE=new` (then it raises);
- is disabled by `RUST_ANYTHING_MODE=old` or
  `RUST_ANYTHING_UNIT_VISUAL_COMPRESSION=original`;
- is removed entirely by `rust-anything disable ../../../../../rust/visual-compression-rs`.

Verified live in the source tree: `effort_preset.__module__ == "visual_compression_rs"`.

## Why slower (0.4x) — and why it still counts

The recorded function is a three-branch dictionary lookup that costs 752 ns in Python.
Crossing the PyO3 boundary, building a JSON mapping and rebuilding the dataclass costs
~1.9 µs. The port is therefore *behaviorally* proven but not a speed win, and it is
**not** a candidate for switching on in production on performance grounds. It is kept
because it is the proof that the rust-anything loop works end-to-end on this codebase
(record → bridge → port → build → diff → shadow → gate), which is what Part 4 of
TASKS.md needs before any larger unit is attempted.

## Why this lives here, and what happens next

This port belongs in the **QwenPaw source tree**, not in the deploy repo. The deploy
repo (`Chalupandey07/qwenpaw-deploy`) holds deploy automation, Pages/Worker code and
feature docs; it is not a fork of QwenPaw and has no `src/qwenpaw/` or `rust/` tree.

Pushing it properly needs a **fork decision from Rohan**: whether the Rust migration
lands in a fork of `agentscope-ai/QwenPaw` (so it can be pushed and PR'd), or stays a
local patch series. Until that decision, this directory is the record: the crate source,
the recorded cases, the gate output, the report card, and the `config.py` wrapper that
switches it on.

## Layout

```text
rust-ports/visual-compression/
├── README.md                                  # this file
├── rust/visual-compression-rs/                # the crate, source only
│   ├── Cargo.toml, Cargo.lock, build.rs
│   ├── src/{lib,port,js,pyconv,pynum}.rs      # port.rs is the actual port
│   ├── python/visual_compression_rs/__init__.py  # generated wrapper
│   ├── shadow/visual_compression_shadow.py
│   ├── cases.jsonl                            # 46 recorded cases
│   ├── recorded-from.json                     # 20 files, fingerprint
│   ├── rust-anything.json                     # bridge config
│   ├── .rust-anything/                        # diff/bench history, driver
│   └── report/{REPORT.md,card.svg}
└── src/qwenpaw/agents/context/visual_compression/config.py   # wrapper block, verbatim
```

Compiled artifacts (`target/`, `*.so`, `__pycache__`) are deliberately excluded — this
is a source record, rebuilt with `rust-anything build .` in the crate directory.

`.rust-anything/` is ignored by the crate's own `.gitignore` (it is tool scratch), but it
is force-added here **on purpose**: it holds the gate evidence — `diff.json`
(`{"total": 46, "passed": 46, "failed": 0}`), `diff-history.jsonl`, `bench.json` and the
recording progress logs. A record without its proof is not a record.

## Reproducing

```sh
cd rust-ports/visual-compression/rust/visual-compression-rs
rust-anything build .     # builds _native.abi3.so
rust-anything diff .      # expect 46/46
rust-anything gate .      # fmt, clippy, test, unsafe, api, diff
rust-anything report .    # regenerates report/REPORT.md + card.svg
```

Needs `rust-anything` 3.3.0, `cargo`/`rustc` 1.100.0, and a C linker. On this box the
Rust toolchain lives under `$HOME` — **not** `/tmp` (512 MB tmpfs, too small).
