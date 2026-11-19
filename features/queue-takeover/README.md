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

## Deploy

- New image tag `qwenpaw-agentx:2.3.0-takeover1`, built FROM the live
  image (`Dockerfile.takeover1`); 5-image cap — delete
  `qwenpaw-agentx:2.3.0-deploy1` first.
- The `_worker.js` rule ships with the Pages deploy (both projects).
- Do NOT rebuild/redeploy the container while a browser task is using
  the console, and do NOT restart it while the T136 judge is running
  (a restart kills its in-flight agent turns).

## Tests

T144 (`test_queue_takeover.mjs`, machine-free): the apply script is run
for real against the verbatim live excerpts (captured from the machine
2026-11-19) — the patched output contains the new code and parses
(`node --check`); a second run on patched output FAILS (fail-closed);
the rule exists, posts `release-ownership` with the chat id from the
URL, creates exactly one button, hides/restores the Interrupt button
with the banner, and never removes React nodes or polls. Live two-tab
browser test (same chat in two tabs, send from the non-owner tab,
confirm takeover works and the queue drains) runs after the container
redeploy.
