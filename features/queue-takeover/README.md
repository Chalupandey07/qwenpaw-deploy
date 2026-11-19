# Multi-tab takeover (Step 10, 2026-11-19)

A non-owner tab of the same chat used to queue forever: the console's
single-sender ownership lock (`Web Lock qwenpaw:queue-owner:{chatUUID}`)
has no focus handoff, no timeout, and the "Interrupt & send" button is a
dead no-op in a non-owner tab (it returns early when the tab is not the
owner). The fix adds an explicit "Take over sending" action on the
queue-only banner.

## Mechanism (verified in the live bundle, image qwenpaw-agentx:2.3.0-approvalttl1)

Shared chunk `index-DZrIuh3B.js`: `$y()` is the singleton
`BroadcastChannel("qwenpaw:queue")`; `ar()` is `navigator.locks`;
`_q(e,t,n)` holds ownership with an exclusive lock request WITHOUT
`ifAvailable` (so it queues behind the owner) + `signal:n`; on grant it
calls become-owner, then waits until the signal aborts. The channel
listener handles `migrate`, `runState`, and generic item/runState sync;
a `release-ownership` message previously fell through to a no-op.

Chat chunk `index-opcB8AGu.js`: the hold effect creates a local
`AbortController o`, recovers the queue, then calls `Va(p, becomeOwner,
o.signal)`; cleanup aborts `o`. `pt` is the owner flag; `on = Xi && !pt`
renders the banner "This tab queues only; sending is handled by another
tab" (`chat.queue.otherTabOwner`).

## The patch (this image)

`apply-queue-takeover.py` does exact string surgery (the bundles are
minified, so unified diff cannot address a fragment mid-line), failing
closed unless every anchor occurs exactly once:

1. Shared chunk: the listener gains, before the `migrate` branch,
   `if (n.type === "release-ownership") { abort the controller in
   window.__agentxOwnerControllers for n.sessionId; return; }`.
2. Chat chunk hold effect: after `const o = new AbortController`,
   register `o` in `window.__agentxOwnerControllers` under `p` (the
   chat id); the effect cleanup deletes `p` (it already aborts `o`).

Aborting the owner's signal releases the lock, so the requester's
already-waiting hold is granted, `Zs(true)` hides the banner, and the
drain loop (`wq` = try-owner-then-send) drains the queue. Normal
single-tab behaviour is untouched: the registry is only read when a
`release-ownership` message arrives, which only the takeover button
posts.

## The injection (Pages `_worker.js`, rule `queue-takeover`)

When the "This tab queues only" banner is present on `/chat/<id>`, the
rule appends a "Take over sending" button to it (our element, recreated
on every rule run if React drops it); clicking posts
`{type: "release-ownership", sessionId}` on a fresh
`BroadcastChannel("qwenpaw:queue")` and disables itself as "Takeover
requested…". While the banner is up it hides the dead "Interrupt &
send" button (marked `data-agentx-interrupt-hidden`, restored when the
tab becomes owner). Until the patched image is deployed the button posts
a message the old bundle ignores — harmless.

## Takeover1 live failure + takeover2 (2026-11-19 ~09:1x IST)

The live two-tab browser test FAILED: the "Take over sending" button
rendered THREE times with independent state (truncated "Take over
sendi…"; clicking one set only that copy to "Takeover requested…") and
the owner never released — the banner never cleared, Tab 1 stayed owner
after 2+ min, and the queued message was sent by Tab 1, not Tab 2.
Single-tab sending still works. Two causes, both diagnosed in code:

1. **Triplication (the rule).** The old guard was anchor-scoped
   (`banner.querySelector("[data-agentx-takeover]")`): the rule runs on
   every MutationObserver tick, and appending the button lengthens the
   winning div, so the next run picks a different nested banner div
   while earlier buttons survive on theirs. The button also landed
   inside the narrow text div, which clipped its label. Fix (the rule,
   same file): a DOCUMENT-WIDE guard (`document.querySelector`), an
   existing button is MOVED onto the current banner instead of creating
   a new one, the button goes on the BANNER ROOT (climbed from the text
   div while the parent holds only the banner text), `white-space:nowrap`,
   a stranded button is removed when the banner is gone, and a one-shot
   15s timer in the click handler re-enables the button if the owner
   still has not released (stale owner tab) so the user can retry.
   The bundle renders NO takeover button (grep 0 in both chunks), so
   the rule does not duplicate the bundle fix.
2. **Owner never releases (stale cached bundles).** Takeover1 patched
   the content-hashed bundles IN PLACE without changing their
   filenames, while Pages serves `/assets/*` as `public,
   max-age=31536000, immutable` — a tab that had loaded the console
   before kept running the OLD bundle, whose listener has no
   release-ownership branch, so the message fell through to a no-op.
   The alternatives were ruled out in code: the registry key matches
   the posted sessionId (`Sn` is `yq`, which returns the chat id
   unchanged for real chats), the listener branch is intact in the
   served files, and fresh curls return the patched bundle from both
   Pages and the direct origin. Fix (takeover2 image): the two patched
   chunks get fresh URLs — the entry script in `index.html` gains
   `?v=takeover2` (verified 200 + patched on origin and Pages) and the
   chat chunk is RENAMED `index-opcB8AGu.js` →
   `index-opcB8AGu-tk2.js` with its 3 references updated (shared-chunk
   manifest + dynamic import, TerminalView static import); its static
   import of the shared chunk gains the same `?v=takeover2` so the Chat
   page and the entry share one fresh store instance. The shared chunk
   is NOT renamed: 287 asset files reference it, and every other chunk
   is byte-identical, so serving them from cache is harmless.
   `rename-chunks-tk2.py` does the surgery (exact anchors, fail-closed);
   `Dockerfile.takeover2` builds FROM takeover1 and never re-applies
   the patch.

## Known issues (recorded, not fixed here)

- **Tab 2's transcript does not live-sync a message the owner sends.**
  The queue BroadcastChannel syncs queue items + runState, never
  session messages; the open chat refreshes its transcript on
  mount/reload or its own sends. After a working takeover Tab 2 drains
  the queue itself, so its transcript updates via its own drain — the
  lag only bites when the OWNER sends your queued message. A real fix
  needs a new channel message type + a session-refresh post, i.e. a
  session-layer bundle patch; out of scope for this round.
- **Brand-new /chat (no id):** the button would post `sessionId: null`
  (the URL has no chat id) while the queue key is `draft:<session>`
  (`Sn` returns `draft:` for "new"). The banner only appears on an
  existing chat, so this is a corner case.

## Deploy

- New image tag `qwenpaw-agentx:2.3.0-takeover1`, built FROM the live
  image (`Dockerfile.takeover1`); 5-image cap — delete
  `qwenpaw-agentx:2.3.0-deploy1` first.
- The `_worker.js` rule ships with the Pages deploy (both projects).
- Do NOT rebuild/redeploy the container while a browser task is using
  the console, and do NOT restart it while the T136 judge is running
  (a restart kills its in-flight agent turns).

## Takeover2 deploy

- New image tag `qwenpaw-agentx:2.3.0-takeover2`, built FROM
  `qwenpaw-agentx:2.3.0-takeover1` (`Dockerfile.takeover2`); 5-image
  cap — delete `qwenpaw-agentx:2.3.0-gatefix6` first (NEVER
  `approvalttl1`, the rollback). The T136 judge finished 12/12 TRUSTED
  ~09:04 IST, so no judge blocks the redeploy; still re-check
  `pgrep -af judge.py` immediately before recreating the container.
- The `_worker.js` rule fix ships with the Pages deploy (both
  projects); verify the served HTML carries the new rule AND the
  settings-white-area round-4 code (a sibling just landed that file —
  fetch origin/main fresh before pushing).
- Live two-tab browser test runs after the redeploy (parent's job):
  one button, full label, click transfers ownership, banner clears,
  queue drains in Tab 2.

## Tests

T145 (`test_queue_takeover.mjs`, machine-free, 60 checks): (a) the
apply script is run for real against the verbatim live excerpts — the
patched output contains the new code and parses (`node --check`); a
second run on patched output FAILS (fail-closed); (b) static checks on
the "queue-takeover" rule — document-wide guard, move-not-create,
banner-root placement with white-space:nowrap, stranded-button
removal, exactly one setTimeout in the click handler, no setInterval;
(c) dynamic, with a DOM mock that models the real banner DOM (live
textContent) and React re-renders — the takeover1 failure is replayed
(three re-renders, still exactly one button, the same node, on the
banner root), click posts once and re-enables after 15s if still
queued, Interrupt hidden/restored with the banner; (d) the rename
script is run for real on fixture console dirs — entry gains
`?v=takeover2`, chat chunk renamed, old name 0x, all three files parse,
second run FAILS. The rename script was dry-run on the REAL downloaded
bundles before the test was written (exit 0, all three files parse,
old name 0x, versioned entry 2x, second run fails). Fail-first proven:
42/60 against the takeover1 rule. Live two-tab browser test (same chat
in two tabs, send from the non-owner tab, confirm takeover works and
the queue drains) runs after the container redeploy.
