# B4 — "Take over sending" in the console source (not the DOM injector)

2026-11-23. The takeover button used to exist only as a `queue-takeover` rule in
`pages/public/_worker.js`'s DOM-injection shim. It does not survive the shim's
removal, and the shim is not the place for a control that has to cooperate with
a Web Lock. This directory carries the same feature **in `console/src`**, where
the queue and the ownership lock actually live.

## What was missing (measured 2026-11-23, before this change)

The pieces existed but the protocol did not work end to end:

| Piece | State before | Effect |
| --- | --- | --- |
| `TakeOverSendingButton.tsx` | present, rendered in the queue-only banner | the button appeared and posted a message |
| `requestQueueTakeover()` | present | posted `release-ownership` on `qwenpaw:queue` |
| `registerOwnershipRelease()` | present, called by the Chat page | registered the owner's abort |
| `releaseOwnershipLocally()` | present, **never called** | dead code |
| the store's `BroadcastChannel` listener | handled `migrate`, `runState`, queue sync — **no `release-ownership` branch** | the request fell through to a no-op queue sync; **the owner never released, so the takeover never worked** |
| `styles.queueOnlyBanner` | **missing from `index.module.less`** | `className={undefined}` on the banner wrapper: no gap, no `nowrap`, the button could be pushed off the line |
| tests for any of the above | **none** | a green suite proved nothing about this path |

So the button existed and looked plausible while the handoff could not happen.
The missing listener branch is the actual defect; the missing class and tests
are what let it ship unnoticed.

## The change

1. **`src/stores/messageQueueStore.ts` — the listener branch.** On
   `release-ownership` the owner calls `releaseOwnershipLocally(sessionId)`,
   which runs the abort the Chat page registered. Aborting that signal releases
   the `qwenpaw:queue-owner:{sessionId}` Web Lock, so the claimant's
   already-queued `holdOwnershipLock` request is granted next. The owner then
   clears its heartbeat and answers with `takeover-claim` (carrying the
   claimant's `requestId`) so a claimant can tell "handed over" from "owner tab
   frozen". A tab that does not own the conversation has no registered release,
   so the branch is a no-op there — and `BroadcastChannel` never delivers a
   message to its own sender, so the requesting tab is never affected by its
   own request.
2. **`src/pages/Chat/index.module.less` — `.queueOnlyBanner`.** `inline-flex`,
   `nowrap`, the message truncates instead of the button, and the button is
   `flex: none` so its label ("Take over sending") can never be clipped. This
   is the browser-visible half of the takeover1 triplication/clipping failure:
   the label must stay legible in a one-line composer banner.
3. **Tests, written with the code.**
   - `src/stores/messageQueueStore.takeover.test.ts` (new, 41 checks): the
     request id shape, the posted message's exact shape, registration
     replace/unregister semantics, heartbeat publish/read/clear + corrupt and
     quota-failure tolerance, and the idle-release state machine (busy never
     releases, visible never releases, hidden+idle releases exactly once,
     returning to visible restarts the clock, cleanup stops the timer).
   - `src/stores/messageQueueStore.crossTab.test.ts` (+5 checks): drives the
     store's **real** listener from a peer channel — a takeover request runs the
     registered release once, a request for another session does not, a second
     request after re-registration releases again, the queue itself is never
     mutated by a handoff, and an unknown payload type still applies its items
     (forward compatibility).

## The idle timeout (why a backgrounded owner cannot hold the lock forever)

A Web Lock cannot be revoked from another tab, so the only general fix for a
frozen/backgrounded owner is for the owner to give the lock up itself.
`startOwnershipHeartbeat` (called when the lock is acquired, Chat page
`index.tsx:1775`) publishes a heartbeat every `OWNER_HEARTBEAT_MS` (4 s) and
releases when the tab has been **hidden AND idle** (no send, no agent run) for
`OWNER_IDLE_RELEASE_HIDDEN_MS` (30 s). A busy owner never releases mid-turn. The
claimant's button shows "Still waiting…" after `TAKEOVER_GRACE_MS` (15 s) and
re-enables for a retry; it only says the owner looks gone once the heartbeat is
older than `OWNER_HEARTBEAT_STALE_MS` (20 s).

## Verification (this commit)

- `vitest run src/stores/messageQueueStore.takeover.test.ts
  src/stores/messageQueueStore.crossTab.test.ts` → **51/51 pass**.
- **Fail-first proven**: with the listener branch removed and everything else
  identical, the crossTab suite fails 3 checks (the three that assert the
  release actually runs); restored, 51/51.
- `tsc -b --noEmit` → clean. `eslint` on the touched files → 0 errors (16
  pre-existing `react-hooks/exhaustive-deps` warnings in `Chat/index.tsx`, none
  introduced here).
- **NOT verified:** the two-tab browser test. That needs a real browser on the
  live console (Muse): open one chat in two tabs, send from the non-owner tab,
  press "Take over sending", confirm the banner clears, this tab becomes the
  sender, and the queued message drains here. Also unverified live: the idle
  release (background the owner tab with nothing running for 30 s and confirm
  the other tab takes over without a click).

## Files

```text
features/queue-takeover/console-src/
  messageQueueStore.ts                    the store, with the listener branch
  messageQueueStore.takeover.test.ts      new unit suite (41 checks)
  messageQueueStore.crossTab.test.ts      + 5 listener checks
  TakeOverSendingButton.tsx               the button (unchanged in this pass)
  queueOnlyBanner.module.less.txt         the CSS block to append
```

These are copies of the files under `console/src/` for review in this repo; the
live source of truth is the console tree, and the machine image is what ships.
