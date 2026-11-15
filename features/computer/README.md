# Computer — REMOVED 2026-11-15, awaiting the Rakazo rebuild

**Nothing in here is deployed. The computer is gone from this repo until a
rebuild lands.**

## What was removed, and why

The computer worked but was never smooth, and the implementation — not the
idea — was the problem. Patching it further would have meant carrying a design
that was wrong at several layers:

- a 12-hour HMAC cookie standing in for a scoped, short-lived capability;
- no real view/control split in the URL path (one interactive stream that
  anyone reaching `/desktop` could drive);
- no held frame during view↔control swaps, so taking or releasing control
  blanked the screen;
- the console-side panel injected by string-replacing the SPA's HTML — a
  fragile coupling to a Docker image we do not build;
- previews uploaded unconditionally every 15 s, which burned the KV write
  quota and took the whole desktop down for a day;
- needs-you as a single global record rather than per computer;
- and repeatedly, security fixes that were silently reverted by later
  rewrites.

Rakazo's implementation is the reference. Rather than keep diffing ours toward
it, the computer was deleted and will be re-added following
`rakazo-computer-study.md` — which is preserved in this directory because it
is the specification.

## What was deleted

| Path | What it was |
|---|---|
| `pages/public/_worker.js` `/desktop*` routes | gate page, noVNC proxy, WebSocket relay |
| same file: `desktop()` + 20 `desktop*()` functions | lease, capabilities, previews, needs-you, teach, modes, wake, maintenance |
| same file: `createStore`, `kvTry`, `budgetAllowed`, `bumpGeneration`, seal/verify | the desktop's storage and capability layer |
| same file: console-side panel injection | the 316 px sidebar injected into the QwenPaw SPA |
| `pages/public/desktop-chrome.html` (removed) | the chrome UI (tabs, take/release, terminal, teach) |
| `features/desktop/` | lease-watcher, PTY server, 17 systemd units, 3 harnesses, MCP configs |
| `features/camoufox/` | anti-detect bridge, browser skill, profile setup |

`pages/public/_worker.js` went from 2,572 to 216 lines. What remains is
exactly the console proxy: `/` → QwenPaw, `/status` → static page, the wake and
cooldown handling, the `?token=` → `Authorization` lift, and the header
rewrites. That file's entire job is now proxying, which is what it is good at.

## What was NOT removed

- **The console proxy**, which is the reason the domain exists.
- **`features/storage/`** — D1 schema, store wrapper, migration. The board and
  routines still use it.
- **The MCP proxy and `computer-use.yaml` DriverCard** — machine-side, not in
  this repo's control, and removing the YAML would break the running agent
  before the replacement exists. It is marked stale in its own header.
- **Tests T07–T17, T46–T57, T75** — kept and marked `NEEDS-REBUILD`. They are
  the acceptance criteria for the rebuild; deleting them would delete the
  specification of what "smooth" means.

## Why the tests were kept rather than deleted

A red suite for a deliberately deleted feature teaches people to ignore red. A
deleted test loses the only precise record of what the feature had to do. So
the runner now reports `NEEDS-REBUILD` for those ids with an explanation, and
they flip back to real assertions when the new computer lands.

## The rebuild

Specification: `rakazo-computer-study.md` in this directory — architecture,
the lease, the capability, the shim, the UI, and the gap list. Read it before
writing code; it is more precise than any summary.

Non-negotiables carried over from the failures above, to be asserted in the
new code's own tests:

1. **A capability is scoped and short-lived** — `{computer, generation,
   leaseId}`, minutes not hours, re-checked while a socket is open.
2. **View and control are different URLs**, and the control one requires a
   live lease. The UI gate (`pointer-events: none`) is a convenience, never
   the enforcement.
3. **A held frame during swaps** — the screen must never blank when control is
   taken or released.
4. **No injected HTML into the QwenPaw SPA.** If the panel cannot be a native
   console feature, it is an overlay on our own origin — not a string
   replacement on a page we do not build.
5. **Uploads are change-only with a floor**, and the write budget is checked
   before the upload, not after it fails.
6. **Needs-you is per computer** and carries the preview's hash so the image
   only refetches when the screen changes.
7. **A generation bump that fails means the takeover failed.** Never report
   success for a capability that cannot verify.
8. **No claim is live until it is rendered in a real browser.** Every previous
   round that skipped this shipped a broken screen.
