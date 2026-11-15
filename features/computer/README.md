# Computer — rebuilt from Rakazo's design

**Status: code complete, NOT deployed.** Muse deploys and is the only one who
can call it live. Nothing in here claims to render until Muse has seen it.

## What this is

A rebuild, not a patch. The previous implementation (8,399 lines) was removed
because its *design* was wrong at several layers, and patching it is how it got
to 8,399 lines. This is Rakazo's architecture, ported to this deployment's
constraints.

Source of truth: `elie222/rakazo` @ `d343d83`, read directly —
`apps/web/src/pages/shell/computer-overlay.tsx` (the look),
`apps/web/src/lib/computer-screen.ts` (the state machine),
`apps/web/src/novnc-html.ts` (the shim),
`packages/core/src/node/screen-capability.ts` (the seal),
`packages/core/src/screen-reconnect.ts` (the lease constants).
`rakazo-computer-study.md` beside this file is the analysis.

## The shape

```
pages/public/computer/
  capability.js   AES-256-GCM seal + noVNC shim        (port of screen-capability.ts + novnc-html.ts)
  state.js        lease, generations, needs-you, previews (port of computer-control.ts, on D1)
  router.js       the /computer surface + stream proxy  (port of routes/computer.ts + screen-proxy.ts)
  ui.html         panel + overlay, one self-contained page (port of computer-panel/overlay.tsx)
```

`pages/public/_worker.js` delegates `/computer*` to the router and is otherwise
untouched — it is a console proxy again.

## Three deliberate divergences from Rakazo

| Rakazo | Here | Why |
|---|---|---|
| noVNC proxied by the web server, capability resolved by a **separate API** over a bearer secret | both in one Worker, capability opened in-process | Rakazo splits them because they are different services. We are one Worker; a network hop would exist only to reproduce a boundary we do not have. |
| capability TTL **60 min** | **10 min** | A link here is minted immediately before a frame loads it. Ten minutes survives a slow wake and dies long before a leaked link is useful. |
| recheck every **1 s** through the API | recheck the live lease on **every request** | Same isolate, same D1 call, so the check is free. Rakazo's 1 s recheck exists because its authority is across a network; ours is a local query. |

Everything else is preserved, because each part prevents a specific failure
recorded in `BUGS.md`:

| Preserved | Prevents |
|---|---|
| policy + expiry in the **AAD** | a view link replayed as control |
| scope = `{computer, generation, leaseId}` | a link surviving a takeover or a screen replace |
| the provider token **inside** the seal | a token in a cookie, in a redirect, or in the browser at all (the stale per-port cookie bug) |
| deterministic IV per identical seal | two tabs invalidating each other's handshake |
| `redirect: "manual"` upstream | auto-follow without a cookie jar reporting a healthy desktop as down |
| drop the browser `Cookie` header | a stale per-port cookie 401ing every other port |
| a **held predecessor frame** | the screen blanking on take/release |
| the shim's state reports | a silent frame showing black with no diagnosis |
| `pointer-events: none` until control | driving a screen you do not hold (UI gate; the lease is enforcement) |
| heartbeat only while **visible** | a forgotten tab holding control forever |
| release **names the lease** | a late release from an old page ending newer control |

## Two bugs this rebuild's own harness caught

Both would have shipped broken, and both are why the harness runs before the
commit rather than after the deploy:

1. **The IV was never written into the token.** `crypto.subtle.encrypt` used it
   but the token held only the ciphertext, so every screen link was
   well-formed and dead on arrival. The harness opened a freshly sealed
   capability and got `null`.
2. **The AES-GCM tag split.** `node:crypto` takes the auth tag as a separate
   argument; WebCrypto returns `ciphertext || tag` as one buffer. Porting the
   split verbatim fails every open.

Neither is visible by reading the code — both need the round trip.

## The quota math for this design (measured, not claimed)

The previous implementation's worst case was **17,280 writes/day against a
1,000/day KV budget — 17× over**, and the docs meanwhile claimed it was
"bounded well under 1,000". That false claim is the single most expensive
documentation error in this repo: the migration was sized on it.

The new computer writes to D1 (100,000 rows/day), and the numbers are:

| Component | Rows/day (worst case) |
|---|---|
| Lease heartbeat while control is held 24 h (15 s) | 5,760 |
| Takeover + release (~20/day × 2) | 40 |
| Needs-you raise + resolve (~20/day × 2) | 40 |
| Preview uploads, 2 computers, 120 s floor, screen always changing | 1,440 |
| Preview write when the hash is unchanged | **0** |
| Mode switches (~10/day) | 10 |
| **Total** | **7,290 (7.3% of D1)** |

A static screen with control held all day costs **5,850 writes**, because the
preview upsert is conditional on `sha256 IS NOT excluded.sha256` — an unchanged
screen writes nothing. That is the actual fix for the burn: not a longer
interval, but making the write conditional on a change.

**The heartbeat is the dominant cost and cannot be reduced** without weakening
takeover, which is why D1 (100k) rather than KV (1k) is the right store. On KV
this design would still be 5.9× over quota while idle.

## Deployment (Muse)

1. **D1 binding.** The router expects `COMPUTER_DB` bound to the
   `qwenpaw-state` database. The schema is created idempotently on first use
   (`state.js::ensureSchema`), so no separate migrate step is needed.
2. **Secrets** (never in git, never in chat):
   `COMPUTER_CAPABILITY_SECRET` (32+ random bytes), `COMPUTER_CONTROL_ORIGIN` +
   `COMPUTER_CONTROL_TOKEN`, `COMPUTER_VIEW_ORIGIN` + `COMPUTER_VIEW_TOKEN`,
   the same four with `QA_` for the second display, and `COMPUTER_SYNC_TOKEN`
   for the agent-facing endpoints.
3. **Machine side** (Muse's job, per the brief): the view-only and interactive
   x11vnc/websockify pairs on published ports, and the preview uploader. The
   uploader must be **change-only with a floor** — that is what burned the KV
   quota, and the D1 write budget is now the thing to protect.
4. **Verify in a real browser.** Not with a protocol check. The previous rounds
   that skipped this shipped a broken screen every time.

## Not done

- **Terminal tab**: the UI has the tab and the workspace, but the PTY service
  was removed with the old computer and has not been rebuilt. It needs the
  `pty-server.py` equivalent back on the machine — deferred deliberately
  because a root shell is the highest-risk surface and it should land with its
  own lease tests, not folded into this.
- **Teach recording**: the UI records start/stop and says a draft was saved;
  there is no input recorder or draft editor yet. Same reasoning.
- **Per-bot computers**: the schema has a `computer` row per name and the
  router takes `?computer=`, so the model supports it, but only `default` and
  `qa` are wired.
- **Live verification of any of it.** That is Muse's, and it has not happened.
