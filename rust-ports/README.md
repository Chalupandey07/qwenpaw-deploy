# Rust ports — path (a), file granularity

One file at a time, each with its own record → bridge → diff → gate cycle. A port
is proven by `rust-anything`'s recorded cases, not by inspection: `diff` replays
every case against the Rust module and `gate` fails the port if anything drifted.

| Port | Source file | Cases matched | Speed | On |
| --- | --- | ---: | ---: | :--: |
| [`visual-compression`](visual-compression/README.md) | `visual_compression/config.py` | 46 / 46 | 0.4x | off |
| [`markdown-cjk`](markdown-cjk/README.md) | `utils/markdown_cjk.py` (387 L) | 267 / 267 | **20x** | on |
| [`eviction-index`](eviction-index/README.md) | `scroll/eviction_index.py` (421 L) | 987 / 987 | 0.7x | on |

Each directory holds the enabled Python source and the whole crate (port, cases,
report), so the port can be rebuilt and re-verified without the source tree.

## Running share

Of 384k lines of Python, three files are ported: 1,222 source lines of the
ported functions' files. The honest denominator is *what could be ported*: an
`analyze` pass over the source tree finds 35 units "ready" (no dynamic
behaviour, no I/O, no framework surface) and 84 "caution" out of 146; everything
in those ready units together is the ceiling. Two of the three ports above are
`caution` units bridged deliberately at **file** granularity.

**Speed is not the point of every port.** `markdown-cjk` is 20x because it runs
per rendered message; `eviction-index` is 0.7x because its functions are
microseconds each and the PyO3 call boundary dominates. It is on for the
behavioural reason — the cascade logic is now pinned by 987 cases — and the
report says so instead of hiding it.
