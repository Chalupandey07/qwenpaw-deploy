# markdown-cjk-rs — second Rust port (file granularity, path (a))

**Status:** proven port, gate pass, enabled in the source tree. Local-only.

| | |
| --- | --- |
| Source file | `src/qwenpaw/utils/markdown_cjk.py` (387 lines) |
| Unit bridged | `src/qwenpaw/utils/` (whole package — bridging one file was refused) |
| Crate | `rust/markdown-cjk-rs` |
| Tool | rust-anything 3.3.0 (PyO3 / abi3-py39) |
| Gate | **267 / 267 recorded cases matched**, 0 failed |
| Rust size | 729 lines (vs 314 Python) — 2.3x |
| Speed | **20x** (call included) |
| Switched on | **on** — the original file carries the `rust-anything: markdown-cjk-rs` block |

## What it does

CJK-aware markdown handling: an emphasis/word-boundary scanner that has to know
where a CJK character sits inside a run of text, so `**粗体**文字` and
`**bold**text` are treated identically at their boundaries while the CJK side
does not get a spurious space. The Unicode tables are the interesting part: the
port carries `unitables.rs` generated from Python's own `unicodedata` — 338 P/S
ranges plus 10 whitespace ranges — so the two sides agree on every code point
rather than on whoever's `unicode-width` crate happened to be current.

## Why this one is worth it

Unlike the visual-compression and eviction-index ports, this is a **real**
speedup: 20x. It runs per rendered message on every assistant turn, on text that
grows with conversation length, so the win is proportional to how much text is
on screen rather than to a fixed constant.

## Gate

`rust-anything gate rust/markdown-cjk-rs` — all pass:

- **behavior** — 267/267 recorded cases matched.
- **clippy / fmt / test / unsafe / lockfile / ported / size / panics / api** — pass.
- The only gate failure on the first run was `fmt`; `cargo fmt` fixed it and the
  re-run was clean.

## Files

```text
rust-ports/markdown-cjk/
  src/qwenpaw/utils/markdown_cjk.py          the enabled source (with the port block)
  rust/markdown-cjk-rs/src/port.rs           the port
  rust/markdown-cjk-rs/src/unitables.rs      Unicode tables generated from Python's unicodedata
  rust/markdown-cjk-rs/cases.jsonl           267 recorded cases
  rust/markdown-cjk-rs/report/REPORT.md      the report card and numbers
```
